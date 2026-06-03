// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import { IAntseedPointsPolicy } from "../interfaces/IAntseedPointsPolicy.sol";
import { IAntseedEmissionSchedule } from "../interfaces/IAntseedEmissionSchedule.sol";
import { IAntseedSellerPools } from "../interfaces/IAntseedSellerPools.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";

/**
 * @title AntseedUsageAccounting
 * @notice Facts-only recognized-usage ledger.
 *
 *         Existing AntseedChannels still emits the legacy two-call sequence
 *         (`accrueSellerPoints`, then `accrueBuyerPoints`) to whatever the
 *         global registry exposes as `emissions()`. This contract is that
 *         settlement-facing endpoint. It records settled usage facts by buyer,
 *         seller, buyer/seller pair, and seller pool. For seller
 *         pools it also records weighted points as raw usage multiplied by the
 *         pool's frozen epoch power, so reward distribution is fully on-chain.
 *
 *         Important behavior:
 *           - This is the intermediate points layer. Seller-pool stake math does
 *             not contain usage verification or wash-trading rules.
 *           - A points policy may scale buyer/seller points for verification
 *             outcomes such as announcement-shard checks. If no policy is set,
 *             raw points pass through unchanged.
 *           - Pool-weighted points are based on the pool power for the current
 *             epoch. Because pool power is precomputed and frozen per epoch,
 *             settlement can record usage without touching stake positions.
 *           - Seller-pool rewardable volume is capped by pool security share
 *             via `maxRewardableVolumeLeverageBps`, preventing tiny pools with
 *             huge volume from dominating seller-pool emissions.
 *           - Buyer rewards are weighted by the seller pool the buyer used, so
 *             buyer points from stronger pools carry more reward weight. Buyer
 *             points are not capped by that seller pool's total epoch volume.
 *           - Seller operator rewards use the same direct points model as
 *             buyers: verified seller points multiplied by the pool power used
 *             in that settlement.
 *           - The legacy two-call path stores one pending seller accrual and
 *             pairs it with the next buyer accrual. Newer callers should prefer
 *             `accruePoints` with buyer, seller, and channel id in one call.
 */
contract AntseedUsageAccounting is IAntseedUsageAccounting, Ownable2Step, Pausable {
    // ─── Constants ───────────────────────────────────────────────────
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_REWARDABLE_VOLUME_LEVERAGE_BPS_CAP = 1_000_000;

    // ─── External Contracts ──────────────────────────────────────────
    IAntseedEmissionSchedule public immutable schedule;
    IAntseedSellerPools public sellerPools;
    IAntseedPointsPolicy public pointsPolicy;

    // ─── Policy Config ───────────────────────────────────────────────
    uint256 public maxRewardableVolumeLeverageBps = 100_000;

    // ─── Legacy Two-Call Settlement Pairing ──────────────────────────
    struct PendingSellerAccrual {
        address seller;
        uint256 pointsDelta;
    }

    PendingSellerAccrual public pendingSellerAccrual;

    // ─── Usage Recorder Permissions ─────────────────────────────────
    mapping(address => bool) public usageRecorders;

    // ─── Raw And Weighted Usage Accounting ───────────────────────────
    mapping(uint256 => uint256) public totalRawBuyerPointsByEpoch;
    mapping(uint256 => uint256) public totalRawSellerPointsByEpoch;
    mapping(uint256 => uint256) public totalRawPairPointsByEpoch;
    mapping(uint256 => uint256) public totalRawPoolPointsByEpoch;
    mapping(uint256 => uint256) public totalBuyerPoolPointsByEpoch;
    mapping(uint256 => mapping(address => uint256)) public rawBuyerPointsByEpoch;
    mapping(uint256 => mapping(address => uint256)) public rawSellerPointsByEpoch;
    mapping(uint256 => mapping(address => mapping(address => uint256))) public rawBuyerSellerPointsByEpoch;
    mapping(uint256 => mapping(uint256 => uint256)) public rawAgentPoolPointsByEpoch;
    mapping(uint256 => mapping(address => mapping(uint256 => uint256))) public buyerAgentPoolPointsByEpoch;
    mapping(uint256 => mapping(address => uint256)) public weightedBuyerPointsByEpoch;
    mapping(uint256 => uint256) public totalWeightedBuyerPointsByEpoch;
    mapping(uint256 => mapping(address => uint256)) public weightedSellerPointsByEpoch;
    mapping(uint256 => uint256) public totalWeightedSellerPointsByEpoch;
    mapping(uint256 => mapping(address => uint256)) public rawSellerPoolPointsByEpoch;
    mapping(uint256 => mapping(address => uint256)) public sellerAgentIdByEpoch;
    mapping(uint256 => mapping(uint256 => uint256)) public uncappedWeightedAgentPoolPointsByEpoch;
    mapping(uint256 => mapping(uint256 => bool)) public epochAgentPoolSeen;
    mapping(uint256 => uint256[]) public epochPoolAgentIds;

    // ─── Events ──────────────────────────────────────────────────────
    event SellerPoolsSet(address indexed sellerPools);
    event PointsPolicySet(address indexed policy);
    event MaxRewardableVolumeLeverageBpsSet(uint256 leverageBps);
    event UsageRecorderSet(address indexed recorder, bool allowed);
    event LegacySellerAccrualPending(address indexed seller, uint256 indexed epoch, uint256 pointsDelta);
    event UsagePointsAccrued(
        uint256 indexed epoch,
        address indexed buyer,
        address indexed seller,
        uint256 poolAgentId,
        uint256 rawPoints,
        uint256 poolPower,
        uint256 weightedPoints
    );
    event PendingSellerAccrualCleared(address indexed seller, uint256 pointsDelta);

    // ─── Custom Errors ───────────────────────────────────────────────
    error InvalidAddress();
    error InvalidValue();
    error NotUsageRecorder();
    error PendingSellerAccrualExists();
    error NoPendingSellerAccrual();
    error AccrualDeltaMismatch();

    // ─── Modifiers ───────────────────────────────────────────────────
    modifier onlyUsageRecorder() {
        if (!usageRecorders[msg.sender]) revert NotUsageRecorder();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _sellerPools, address _initialRecorder, address _schedule) Ownable(msg.sender) {
        if (_initialRecorder == address(0) || _schedule == address(0)) revert InvalidAddress();

        schedule = IAntseedEmissionSchedule(_schedule);
        sellerPools = IAntseedSellerPools(_sellerPools);
        usageRecorders[_initialRecorder] = true;

        emit UsageRecorderSet(_initialRecorder, true);
    }

    // ─── Epoch Helpers ────────────────────────────────────────────────
    function currentEpoch() public view returns (uint256) {
        return schedule.currentEpoch();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — RECORD USAGE
    // ═══════════════════════════════════════════════════════════════════

    function accrueSellerPoints(address seller, uint256 pointsDelta) external whenNotPaused onlyUsageRecorder {
        if (seller == address(0)) revert InvalidAddress();
        if (pointsDelta == 0) revert InvalidValue();
        if (pendingSellerAccrual.seller != address(0)) revert PendingSellerAccrualExists();

        pendingSellerAccrual = PendingSellerAccrual({ seller: seller, pointsDelta: pointsDelta });
        emit LegacySellerAccrualPending(seller, currentEpoch(), pointsDelta);
    }

    function accrueBuyerPoints(address buyer, uint256 pointsDelta) external whenNotPaused onlyUsageRecorder {
        if (buyer == address(0)) revert InvalidAddress();
        if (pointsDelta == 0) revert InvalidValue();

        PendingSellerAccrual memory pending = pendingSellerAccrual;
        if (pending.seller == address(0)) revert NoPendingSellerAccrual();
        if (pending.pointsDelta != pointsDelta) revert AccrualDeltaMismatch();

        delete pendingSellerAccrual;
        _recordUsage(buyer, pending.seller, pointsDelta);
    }

    function accruePoints(bytes32 channelId, address buyer, address seller, uint256 pointsDelta)
        external
        whenNotPaused
        onlyUsageRecorder
    {
        _recordUsage(channelId, buyer, seller, pointsDelta);
    }

    function clearPendingSellerAccrual() external onlyUsageRecorder {
        PendingSellerAccrual memory pending = pendingSellerAccrual;
        delete pendingSellerAccrual;
        emit PendingSellerAccrualCleared(pending.seller, pending.pointsDelta);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setSellerPools(address _sellerPools) external onlyOwner {
        sellerPools = IAntseedSellerPools(_sellerPools);
        emit SellerPoolsSet(_sellerPools);
    }

    function setPointsPolicy(address policy) external onlyOwner {
        pointsPolicy = IAntseedPointsPolicy(policy);
        emit PointsPolicySet(policy);
    }

    function setMaxRewardableVolumeLeverageBps(uint256 leverageBps) external onlyOwner {
        if (leverageBps > MAX_REWARDABLE_VOLUME_LEVERAGE_BPS_CAP) revert InvalidValue();
        maxRewardableVolumeLeverageBps = leverageBps;
        emit MaxRewardableVolumeLeverageBpsSet(leverageBps);
    }

    function setUsageRecorder(address recorder, bool allowed) external onlyOwner {
        if (recorder == address(0)) revert InvalidAddress();
        usageRecorders[recorder] = allowed;
        emit UsageRecorderSet(recorder, allowed);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── Internal Recording ───────────────────────────────────────────
    function _recordUsage(address buyer, address seller, uint256 rawPoints) internal {
        _recordUsage(bytes32(0), buyer, seller, rawPoints);
    }

    function _recordUsage(bytes32 channelId, address buyer, address seller, uint256 rawPoints) internal {
        if (buyer == address(0) || seller == address(0)) revert InvalidAddress();
        if (rawPoints == 0) revert InvalidValue();

        uint256 epoch = currentEpoch();
        IAntseedSellerPools pools = sellerPools;
        uint256 agentId = address(pools) == address(0) ? 0 : pools.agentIdForSeller(seller);
        uint256 poolPower = agentId == 0 ? 0 : pools.poolPowerWeightAtEpoch(agentId, epoch);
        uint256 poolAgentId = poolPower == 0 ? 0 : agentId;
        (uint256 sellerPoints, uint256 buyerPoints) = _policyPoints(channelId, buyer, seller, rawPoints);
        uint256 sellerWeightedPoints = sellerPoints * poolPower;
        uint256 buyerWeightedPoints = buyerPoints * poolPower;

        totalRawBuyerPointsByEpoch[epoch] += rawPoints;
        totalRawSellerPointsByEpoch[epoch] += sellerPoints;
        totalRawPairPointsByEpoch[epoch] += rawPoints;
        rawBuyerPointsByEpoch[epoch][buyer] += rawPoints;
        rawSellerPointsByEpoch[epoch][seller] += sellerPoints;
        rawBuyerSellerPointsByEpoch[epoch][buyer][seller] += rawPoints;
        if (poolAgentId != 0) {
            if (!epochAgentPoolSeen[epoch][poolAgentId]) {
                epochAgentPoolSeen[epoch][poolAgentId] = true;
                epochPoolAgentIds[epoch].push(poolAgentId);
            }
            rawAgentPoolPointsByEpoch[epoch][poolAgentId] += sellerPoints;
            rawSellerPoolPointsByEpoch[epoch][seller] += sellerPoints;
            if (sellerAgentIdByEpoch[epoch][seller] == 0) sellerAgentIdByEpoch[epoch][seller] = poolAgentId;
            totalRawPoolPointsByEpoch[epoch] += sellerPoints;
            uncappedWeightedAgentPoolPointsByEpoch[epoch][poolAgentId] += sellerWeightedPoints;
            weightedSellerPointsByEpoch[epoch][seller] += sellerWeightedPoints;
            totalWeightedSellerPointsByEpoch[epoch] += sellerWeightedPoints;
            buyerAgentPoolPointsByEpoch[epoch][buyer][poolAgentId] += buyerPoints;
            totalBuyerPoolPointsByEpoch[epoch] += buyerPoints;
            weightedBuyerPointsByEpoch[epoch][buyer] += buyerWeightedPoints;
            totalWeightedBuyerPointsByEpoch[epoch] += buyerWeightedPoints;
        }

        emit UsagePointsAccrued(epoch, buyer, seller, poolAgentId, rawPoints, poolPower, sellerWeightedPoints);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function rawPoolPointsByEpoch(uint256 epoch, address seller) public view returns (uint256) {
        uint256 agentId = sellerAgentIdByEpoch[epoch][seller];
        if (agentId == 0) return 0;
        return rawAgentPoolPointsByEpoch[epoch][agentId];
    }

    function buyerPoolPointsByEpoch(uint256 epoch, address buyer, address seller) public view returns (uint256) {
        uint256 agentId = sellerAgentIdByEpoch[epoch][seller];
        if (agentId == 0) return 0;
        return buyerAgentPoolPointsByEpoch[epoch][buyer][agentId];
    }

    function uncappedWeightedPoolPointsByEpoch(uint256 epoch, address seller) public view returns (uint256) {
        uint256 agentId = sellerAgentIdByEpoch[epoch][seller];
        if (agentId == 0) return 0;
        return uncappedWeightedAgentPoolPointsByEpoch[epoch][agentId];
    }

    function weightedPoolPointsByEpoch(uint256 epoch, uint256 agentId) public view returns (uint256 weightedPoints) {
        IAntseedSellerPools pools = sellerPools;
        if (address(pools) == address(0)) return 0;

        uint256 rewardablePoints = _rewardablePoolPoints(
            epoch, agentId, rawAgentPoolPointsByEpoch[epoch][agentId], totalRawPoolPointsByEpoch[epoch]
        );
        uint256 poolPower = pools.poolPowerWeightAtEpoch(agentId, epoch);
        weightedPoints = rewardablePoints * poolPower;
    }

    function weightedPoolPointsByEpoch(uint256 epoch, address seller) public view returns (uint256 weightedPoints) {
        uint256 agentId = sellerAgentIdByEpoch[epoch][seller];
        if (agentId == 0) return 0;

        uint256 rewardablePoints = _rewardablePoolPoints(
            epoch, agentId, rawSellerPoolPointsByEpoch[epoch][seller], totalRawPoolPointsByEpoch[epoch]
        );
        IAntseedSellerPools pools = sellerPools;
        if (address(pools) == address(0)) return 0;
        uint256 poolPower = pools.poolPowerWeightAtEpoch(agentId, epoch);
        weightedPoints = rewardablePoints * poolPower;
    }

    function totalWeightedPoolPointsByEpoch(uint256 epoch) public view returns (uint256 totalWeightedPoints) {
        uint256[] memory agentIds = epochPoolAgentIds[epoch];
        for (uint256 i = 0; i < agentIds.length; i++) {
            totalWeightedPoints += weightedPoolPointsByEpoch(epoch, agentIds[i]);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _rewardablePoolPoints(uint256 epoch, uint256 agentId, uint256 rawPoints, uint256 totalRawPoints)
        internal
        view
        returns (uint256)
    {
        IAntseedSellerPools pools = sellerPools;
        if (address(pools) == address(0) || rawPoints == 0) return 0;

        uint256 poolPower = pools.poolPowerWeightAtEpoch(agentId, epoch);
        if (poolPower == 0) return 0;

        uint256 totalPower = pools.totalPowerWeightAtEpoch(epoch);
        uint256 leverageBps = maxRewardableVolumeLeverageBps;
        if (totalPower == 0 || totalRawPoints == 0 || leverageBps == 0) return 0;

        uint256 securityShareVolume = Math.mulDiv(totalRawPoints, poolPower, totalPower);
        uint256 maxRewardablePoints = Math.mulDiv(securityShareVolume, leverageBps, BPS_DENOMINATOR);
        return rawPoints < maxRewardablePoints ? rawPoints : maxRewardablePoints;
    }

    function _policyPoints(bytes32 channelId, address buyer, address seller, uint256 rawPoints)
        internal
        view
        returns (uint256 sellerPoints, uint256 buyerPoints)
    {
        IAntseedPointsPolicy policy = pointsPolicy;
        if (address(policy) == address(0)) return (rawPoints, rawPoints);
        (sellerPoints, buyerPoints) = policy.points(channelId, buyer, seller, rawPoints);
    }
}
