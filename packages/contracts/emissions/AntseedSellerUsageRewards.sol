// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/structs/Checkpoints.sol";

import { IAntseedEmissionsAuthority } from "../interfaces/IAntseedEmissionsAuthority.sol";
import { IAntseedSellerPools } from "../interfaces/IAntseedSellerPools.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";

/**
 * @title AntseedSellerUsageRewards
 * @notice Lazy seller-pool reward controller for recognized usage.
 *
 *         Usage accounting records raw seller usage and weighted pool points
 *         during each epoch. The pool epoch is settled once, APY cap and
 *         burn/reserve routing are applied at the pool budget level, and
 *         stakers/bootstrap commitments split the settled claimable budget:
 *
 *         poolReward = programBudget(epoch) * poolWeightedPoints / totalWeightedPoints
 *         poolClaimable = min(poolReward, poolApyCap)
 *         positionReward = poolClaimable * positionWeight / poolWeight
 *
 *         Per epoch, burn routing is capped at 30% of the full weekly
 *         emissions; excess over that cap is routed to the protocol reserve.
 *
 *         Important behavior:
 *           - This is the staker pool-reward program, not the direct seller
 *             operator reward program.
 *           - Pool epochs are indexed before staker claim/restake. Settlement
 *             mints pool-level claimable ANTS to this contract, mints capped
 *             pool over-cap amounts to the dead address, and routes the
 *             remaining over-cap amount to the protocol reserve.
 *           - Restaking rewards creates a new locked position in the source
 *             agent pool and may receive a configured weight bonus based on lock
 *             length.
 *           - Bootstrap rewards are accounted separately from normal positions
 *             because bootstrap power is discounted security weight, not real
 *             transferable ANTS held by this contract.
 */
contract AntseedSellerUsageRewards is Ownable2Step, Pausable, ReentrancyGuard {
    using Math for uint256;
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace256;

    // ─── Constants ───────────────────────────────────────────────────
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant BURN_CAP_BPS = 3_000;
    uint256 public constant INDEX_SCALE = 1e30;

    // ─── External Contracts ──────────────────────────────────────────
    IAntseedEmissionsAuthority public emissionsAuthority;
    IAntseedSellerPools public sellerPools;
    IAntseedUsageAccounting public usageAccounting;
    bytes32 public immutable programId;

    // ─── Claim State ─────────────────────────────────────────────────
    mapping(address => mapping(uint256 => bool)) public bootstrapEpochClaimed;
    mapping(uint256 => uint256) public epochBurnedAmount;
    mapping(uint256 => mapping(uint256 => PoolEpochEmission)) public poolEpochEmissions;
    mapping(uint256 => uint256) public poolRewardIndexNextEpoch;
    mapping(uint256 => uint256) public positionClaimCursor;
    mapping(uint256 => Checkpoints.Trace256) private _poolCumulativeRewardPerWeight;
    mapping(uint256 => Checkpoints.Trace256) private _poolCumulativeEpochRewardPerWeight;
    uint256 public immutable initialIndexEpoch;

    struct ClaimRoute {
        address recipient;
        address staker;
        bool emitClaimEvents;
    }

    struct PoolEpochEmission {
        bool settled;
        uint256 grossAmount;
        uint256 claimableAmount;
        uint256 burnedAmount;
        uint256 reserveAmount;
    }

    // ─── Events ──────────────────────────────────────────────────────
    event EmissionsAuthoritySet(address indexed emissionsAuthority);
    event SellerPoolsSet(address indexed sellerPools);
    event UsageAccountingSet(address indexed usageAccounting);
    event StakerUsageRewardRestaked(
        uint256 indexed sourcePositionId,
        uint256 indexed newPositionId,
        address indexed staker,
        uint256 amount,
        uint256 burnedAmount,
        uint256 reserveAmount
    );
    event BootstrapUsageRewardClaimed(
        address indexed seller,
        uint256 indexed agentId,
        uint256 indexed epoch,
        address recipient,
        uint256 grossAmount,
        uint256 claimableAmount,
        uint256 burnedAmount,
        uint256 reserveAmount
    );
    event PoolUsageRewardSettled(
        uint256 indexed agentId,
        uint256 indexed epoch,
        uint256 grossAmount,
        uint256 claimableAmount,
        uint256 burnedAmount,
        uint256 reserveAmount
    );
    event PoolUsageRewardIndexed(
        uint256 indexed agentId,
        uint256 indexed epoch,
        uint256 rewardPerWeight,
        uint256 cumulativeRewardPerWeight,
        uint256 cumulativeEpochRewardPerWeight
    );
    event StakerUsageRewardsClaimed(
        uint256 indexed positionId,
        address indexed staker,
        address indexed recipient,
        uint256 fromEpoch,
        uint256 toEpoch,
        uint256 claimableAmount
    );

    // ─── Custom Errors ───────────────────────────────────────────────
    error InvalidAddress();
    error InvalidValue();
    error NothingToClaim();
    error NotPositionOwner();

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _emissionsAuthority, address _sellerPools, address _usageAccounting, bytes32 _programId)
        Ownable(msg.sender)
    {
        if (_emissionsAuthority == address(0) || _sellerPools == address(0) || _usageAccounting == address(0)) {
            revert InvalidAddress();
        }
        if (_programId == bytes32(0)) revert InvalidAddress();
        emissionsAuthority = IAntseedEmissionsAuthority(_emissionsAuthority);
        sellerPools = IAntseedSellerPools(_sellerPools);
        usageAccounting = IAntseedUsageAccounting(_usageAccounting);
        programId = _programId;
        initialIndexEpoch = IAntseedUsageAccounting(_usageAccounting).currentEpoch();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — CLAIM STAKER REWARDS
    // ═══════════════════════════════════════════════════════════════════

    function indexPoolRewards(uint256 agentId, uint256 maxEpochs)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 nextEpoch)
    {
        if (agentId == 0 || maxEpochs == 0) revert InvalidValue();

        nextEpoch = poolRewardIndexNextEpoch[agentId];
        if (nextEpoch == 0) nextEpoch = initialIndexEpoch;

        uint256 currentEpoch_ = sellerPools.currentEpoch();
        uint256 limit = nextEpoch + maxEpochs;
        if (limit > currentEpoch_) limit = currentEpoch_;

        while (nextEpoch < limit) {
            _indexPoolRewardEpoch(agentId, nextEpoch);
            nextEpoch++;
        }
        poolRewardIndexNextEpoch[agentId] = nextEpoch;
    }

    function claimStakerRewards(uint256 positionId, address recipient) external nonReentrant whenNotPaused {
        if (recipient == address(0)) revert InvalidAddress();
        uint256 claimedAmount = _claimIndexedStakerRewards(positionId, ClaimRoute(recipient, msg.sender, true));
        if (claimedAmount == 0) revert NothingToClaim();
    }

    function claimStakerRewardsBatch(uint256[] calldata positionIds, address recipient)
        external
        nonReentrant
        whenNotPaused
    {
        if (recipient == address(0)) revert InvalidAddress();
        if (positionIds.length == 0) revert InvalidValue();

        uint256 totalClaimed;
        for (uint256 p = 0; p < positionIds.length; p++) {
            totalClaimed += _claimIndexedStakerRewards(positionIds[p], ClaimRoute(recipient, msg.sender, true));
        }
        if (totalClaimed == 0) revert NothingToClaim();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — RESTAKE STAKER REWARDS
    // ═══════════════════════════════════════════════════════════════════

    function restakeStakerRewards(uint256 positionId, uint256 stakeEpochs)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 newPositionId)
    {
        uint256 totalRestaked =
            _claimIndexedStakerRewards(positionId, ClaimRoute(address(sellerPools), msg.sender, false));
        if (totalRestaked == 0) revert NothingToClaim();
        newPositionId = sellerPools.stakeMintedReward(msg.sender, positionId, totalRestaked, stakeEpochs);
        emit StakerUsageRewardRestaked(positionId, newPositionId, msg.sender, totalRestaked, 0, 0);
    }

    function restakeStakerRewardsBatch(uint256[] calldata positionIds, uint256 stakeEpochs)
        external
        nonReentrant
        whenNotPaused
        returns (uint256[] memory newPositionIds)
    {
        if (positionIds.length == 0) revert InvalidValue();

        newPositionIds = new uint256[](positionIds.length);
        uint256 totalRestakedAll;
        for (uint256 p = 0; p < positionIds.length; p++) {
            uint256 totalRestaked =
                _claimIndexedStakerRewards(positionIds[p], ClaimRoute(address(sellerPools), msg.sender, false));
            if (totalRestaked == 0) continue;

            totalRestakedAll += totalRestaked;
            newPositionIds[p] = sellerPools.stakeMintedReward(msg.sender, positionIds[p], totalRestaked, stakeEpochs);
            emit StakerUsageRewardRestaked(positionIds[p], newPositionIds[p], msg.sender, totalRestaked, 0, 0);
        }
        if (totalRestakedAll == 0) revert NothingToClaim();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — CLAIM BOOTSTRAP REWARDS
    // ═══════════════════════════════════════════════════════════════════

    function claimBootstrapRewards(uint256[] calldata epochs, address recipient) external nonReentrant whenNotPaused {
        if (recipient == address(0)) revert InvalidAddress();

        (uint256 agentId,,,,,) = sellerPools.bootstrapCommitments(msg.sender);
        if (agentId == 0) revert InvalidValue();

        uint256 totalClaimed;
        uint256 totalBurned;
        uint256 totalReserved;
        for (uint256 i = 0; i < epochs.length; i++) {
            uint256 epoch = epochs[i];
            (uint256 grossAmount, uint256 claimableAmount,) = _bootstrapReward(msg.sender, agentId, epoch);
            if (grossAmount == 0) continue;

            bootstrapEpochClaimed[msg.sender][epoch] = true;
            (, uint256 burnedAmount, uint256 reserveAmount) = _settlePoolEpoch(agentId, epoch);
            _transferReward(recipient, claimableAmount);
            totalClaimed += claimableAmount;
            totalBurned += burnedAmount;
            totalReserved += reserveAmount;
            emit BootstrapUsageRewardClaimed(
                msg.sender, agentId, epoch, recipient, grossAmount, claimableAmount, burnedAmount, reserveAmount
            );
        }

        if (totalClaimed == 0 && totalBurned == 0 && totalReserved == 0) revert NothingToClaim();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function pendingStakerReward(uint256 positionId, uint256 epoch)
        external
        view
        returns (uint256 grossAmount, uint256 claimableAmount, uint256 burnedAmount)
    {
        (address owner, uint256 agentId,,,,,,) = sellerPools.positions(positionId);
        if (owner == address(0)) revert InvalidValue();
        (grossAmount, claimableAmount, burnedAmount) = _positionReward(positionId, agentId, epoch);
        burnedAmount = _previewBurnedAmount(epoch, burnedAmount);
    }

    function pendingBootstrapReward(address seller, uint256 epoch)
        external
        view
        returns (uint256 grossAmount, uint256 claimableAmount, uint256 burnedAmount)
    {
        (uint256 agentId,,,,,) = sellerPools.bootstrapCommitments(seller);
        (grossAmount, claimableAmount, burnedAmount) = _bootstrapReward(seller, agentId, epoch);
        burnedAmount = _previewBurnedAmount(epoch, burnedAmount);
    }

    function pendingIndexedStakerReward(uint256 positionId) external view returns (uint256 claimableAmount) {
        (address owner, uint256 agentId,, uint256 weightAmount, uint64 stakeStartEpoch,, uint64 closedAtEpoch,) =
            sellerPools.positions(positionId);
        if (owner == address(0)) revert InvalidValue();

        uint256 fromEpoch = positionClaimCursor[positionId];
        if (fromEpoch < stakeStartEpoch) fromEpoch = stakeStartEpoch;

        uint256 toEpoch = poolRewardIndexNextEpoch[agentId];
        if (toEpoch == 0 || toEpoch <= fromEpoch) return 0;
        if (closedAtEpoch != 0 && toEpoch > closedAtEpoch) toEpoch = closedAtEpoch;
        if (toEpoch <= fromEpoch) return 0;

        claimableAmount = _positionIndexedReward(positionId, weightAmount, fromEpoch, toEpoch);
    }

    function poolCumulativeRewardPerWeightAt(uint256 agentId, uint256 epoch) external view returns (uint256) {
        return _poolCumulativeRewardPerWeight[agentId].upperLookupRecent(epoch);
    }

    function poolCumulativeEpochRewardPerWeightAt(uint256 agentId, uint256 epoch) external view returns (uint256) {
        return _poolCumulativeEpochRewardPerWeight[agentId].upperLookupRecent(epoch);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setEmissionsAuthority(address _emissionsAuthority) external onlyOwner {
        if (_emissionsAuthority == address(0)) revert InvalidAddress();
        emissionsAuthority = IAntseedEmissionsAuthority(_emissionsAuthority);
        emit EmissionsAuthoritySet(_emissionsAuthority);
    }

    function setSellerPools(address _sellerPools) external onlyOwner {
        if (_sellerPools == address(0)) revert InvalidAddress();
        sellerPools = IAntseedSellerPools(_sellerPools);
        emit SellerPoolsSet(_sellerPools);
    }

    function setUsageAccounting(address _usageAccounting) external onlyOwner {
        if (_usageAccounting == address(0)) revert InvalidAddress();
        usageAccounting = IAntseedUsageAccounting(_usageAccounting);
        emit UsageAccountingSet(_usageAccounting);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _claimIndexedStakerRewards(uint256 positionId, ClaimRoute memory route)
        internal
        returns (uint256 claimableAmount)
    {
        (address owner, uint256 agentId,, uint256 weightAmount, uint64 stakeStartEpoch,, uint64 closedAtEpoch,) =
            sellerPools.positions(positionId);
        if (owner == address(0)) revert InvalidValue();
        if (owner != route.staker) revert NotPositionOwner();

        uint256 fromEpoch = positionClaimCursor[positionId];
        if (fromEpoch < stakeStartEpoch) fromEpoch = stakeStartEpoch;

        uint256 toEpoch = poolRewardIndexNextEpoch[agentId];
        if (toEpoch == 0 || toEpoch <= fromEpoch) return 0;
        if (closedAtEpoch != 0 && toEpoch > closedAtEpoch) toEpoch = closedAtEpoch;
        if (toEpoch <= fromEpoch) return 0;

        claimableAmount = _positionIndexedReward(positionId, weightAmount, fromEpoch, toEpoch);
        if (claimableAmount == 0) return 0;

        positionClaimCursor[positionId] = toEpoch;
        _transferReward(route.recipient, claimableAmount);
        if (route.emitClaimEvents) {
            emit StakerUsageRewardsClaimed(
                positionId, route.staker, route.recipient, fromEpoch, toEpoch, claimableAmount
            );
        }
    }

    function _positionIndexedReward(uint256 positionId, uint256 weightAmount, uint256 fromEpoch, uint256 toEpoch)
        internal
        view
        returns (uint256 rewardAmount)
    {
        uint256 cursor = fromEpoch;
        while (cursor < toEpoch) {
            (uint256 normalEndEpoch, uint256 maxLockPower, uint256 nextChangeEpoch) =
                sellerPools.positionPowerSegmentAt(positionId, cursor);
            uint256 segmentEnd = nextChangeEpoch < toEpoch ? nextChangeEpoch : toEpoch;
            if (segmentEnd <= cursor) break;

            if (maxLockPower != 0) {
                uint256 rewardDelta = _cumulativeRewardDelta(positionId, cursor, segmentEnd);
                rewardAmount += Math.mulDiv(maxLockPower, rewardDelta, INDEX_SCALE);
            } else if (normalEndEpoch != 0 && cursor < normalEndEpoch) {
                if (segmentEnd > normalEndEpoch) segmentEnd = normalEndEpoch;
                uint256 rewardDelta = _cumulativeRewardDelta(positionId, cursor, segmentEnd);
                uint256 epochRewardDelta = _cumulativeEpochRewardDelta(positionId, cursor, segmentEnd);
                rewardAmount += Math.mulDiv(weightAmount, normalEndEpoch * rewardDelta - epochRewardDelta, INDEX_SCALE);
            }

            cursor = segmentEnd;
        }
    }

    function _indexPoolRewardEpoch(uint256 agentId, uint256 epoch) internal {
        (PoolEpochEmission storage emission,,) = _settlePoolEpoch(agentId, epoch);

        uint256 rewardPerWeight;
        uint256 poolWeight = sellerPools.poolWeightAtEpoch(agentId, epoch);
        if (poolWeight != 0 && emission.claimableAmount != 0) {
            rewardPerWeight = Math.mulDiv(emission.claimableAmount, INDEX_SCALE, poolWeight);
        }

        uint256 cumulativeReward = _poolCumulativeRewardPerWeight[agentId].latest() + rewardPerWeight;
        uint256 cumulativeEpochReward = _poolCumulativeEpochRewardPerWeight[agentId].latest() + rewardPerWeight * epoch;
        if (rewardPerWeight != 0) {
            _poolCumulativeRewardPerWeight[agentId].push(epoch + 1, cumulativeReward);
            _poolCumulativeEpochRewardPerWeight[agentId].push(epoch + 1, cumulativeEpochReward);
        }

        emit PoolUsageRewardIndexed(agentId, epoch, rewardPerWeight, cumulativeReward, cumulativeEpochReward);
    }

    function _cumulativeRewardDelta(uint256 positionId, uint256 fromEpoch, uint256 toEpoch)
        internal
        view
        returns (uint256)
    {
        (, uint256 agentId,,,,,,) = sellerPools.positions(positionId);
        return _poolCumulativeRewardPerWeight[agentId].upperLookupRecent(toEpoch)
            - _poolCumulativeRewardPerWeight[agentId].upperLookupRecent(fromEpoch);
    }

    function _cumulativeEpochRewardDelta(uint256 positionId, uint256 fromEpoch, uint256 toEpoch)
        internal
        view
        returns (uint256)
    {
        (, uint256 agentId,,,,,,) = sellerPools.positions(positionId);
        return _poolCumulativeEpochRewardPerWeight[agentId].upperLookupRecent(toEpoch)
            - _poolCumulativeEpochRewardPerWeight[agentId].upperLookupRecent(fromEpoch);
    }

    function _positionReward(uint256 positionId, uint256 agentId, uint256 epoch)
        internal
        view
        returns (uint256 grossAmount, uint256 claimableAmount, uint256 burnedAmount)
    {
        if (agentId == 0 || epoch < positionClaimCursor[positionId]) return (0, 0, 0);

        IAntseedSellerPools pools = sellerPools;
        uint256 positionWeight = pools.positionWeightAtEpoch(positionId, epoch);
        if (positionWeight == 0) return (0, 0, 0);

        uint256 poolWeight = pools.poolWeightAtEpoch(agentId, epoch);
        if (poolWeight == 0) return (0, 0, 0);

        (uint256 poolGrossReward, uint256 poolClaimableReward) = _poolRewardPreview(agentId, epoch);
        if (poolGrossReward == 0) return (0, 0, 0);

        grossAmount = Math.mulDiv(poolGrossReward, positionWeight, poolWeight);
        claimableAmount = Math.mulDiv(poolClaimableReward, positionWeight, poolWeight);
        burnedAmount = grossAmount - claimableAmount;
    }

    function _bootstrapReward(address seller, uint256 agentId, uint256 epoch)
        internal
        view
        returns (uint256 grossAmount, uint256 claimableAmount, uint256 burnedAmount)
    {
        if (bootstrapEpochClaimed[seller][epoch] || agentId == 0) return (0, 0, 0);

        IAntseedSellerPools pools = sellerPools;
        uint256 bootstrapWeight = pools.bootstrapWeightAtEpoch(agentId, epoch);
        if (bootstrapWeight == 0) return (0, 0, 0);

        uint256 poolWeight = pools.poolWeightAtEpoch(agentId, epoch);
        if (poolWeight == 0) return (0, 0, 0);

        (uint256 poolGrossReward, uint256 poolClaimableReward) = _poolRewardPreview(agentId, epoch);
        if (poolGrossReward == 0) return (0, 0, 0);

        grossAmount = Math.mulDiv(poolGrossReward, bootstrapWeight, poolWeight);
        claimableAmount = Math.mulDiv(poolClaimableReward, bootstrapWeight, poolWeight);
        burnedAmount = grossAmount - claimableAmount;
    }

    function _settlePoolEpoch(uint256 agentId, uint256 epoch)
        internal
        returns (PoolEpochEmission storage emission, uint256 burnedAmount, uint256 reserveAmount)
    {
        emission = poolEpochEmissions[epoch][agentId];
        if (emission.settled) return (emission, 0, 0);

        (uint256 grossAmount, uint256 claimableAmount) = _poolRewardPreview(agentId, epoch);
        uint256 excessAmount = grossAmount - claimableAmount;
        (burnedAmount, reserveAmount) = _allocateExcessForEpoch(epoch, excessAmount);

        emission.settled = true;
        emission.grossAmount = grossAmount;
        emission.claimableAmount = claimableAmount;
        emission.burnedAmount = burnedAmount;
        emission.reserveAmount = reserveAmount;

        _mint(epoch, address(this), claimableAmount);
        _mint(epoch, DEAD_ADDRESS, burnedAmount);
        if (reserveAmount != 0) {
            _mint(epoch, _protocolReserve(), reserveAmount);
        }
        emit PoolUsageRewardSettled(agentId, epoch, grossAmount, claimableAmount, burnedAmount, reserveAmount);
    }

    function _poolRewardPreview(uint256 agentId, uint256 epoch)
        internal
        view
        returns (uint256 grossAmount, uint256 claimableAmount)
    {
        PoolEpochEmission memory settledEmission = poolEpochEmissions[epoch][agentId];
        if (settledEmission.settled) {
            return (settledEmission.grossAmount, settledEmission.claimableAmount);
        }

        grossAmount = _poolGrossReward(agentId, epoch);
        if (grossAmount == 0) return (0, 0);

        IAntseedSellerPools pools = sellerPools;
        uint256 activeWeight = pools.poolActiveStakeAtEpoch(agentId, epoch);
        if (activeWeight == 0) return (grossAmount, 0);

        uint256 capBps = pools.apyCapBpsAtEpoch(epoch);
        if (capBps == 0) return (grossAmount, grossAmount);

        uint256 poolCap = Math.mulDiv(activeWeight, capBps, BPS_DENOMINATOR * 52);
        claimableAmount = grossAmount < poolCap ? grossAmount : poolCap;
    }

    function _poolGrossReward(uint256 agentId, uint256 epoch) internal view returns (uint256) {
        IAntseedUsageAccounting accounting = usageAccounting;
        uint256 poolPoints = accounting.weightedPoolPointsByEpoch(epoch, agentId);
        uint256 totalPoints = accounting.totalWeightedPoolPointsByEpoch(epoch);
        if (poolPoints == 0 || totalPoints == 0) return 0;

        uint256 budget = emissionsAuthority.programEpochBudget(programId, epoch);
        if (budget == 0) return 0;
        return Math.mulDiv(budget, poolPoints, totalPoints);
    }

    function _mint(uint256 epoch, address recipient, uint256 amount) internal {
        if (amount == 0) return;
        emissionsAuthority.mintProgramEmission(programId, epoch, recipient, amount);
    }

    function _transferReward(address recipient, uint256 amount) internal {
        if (amount == 0) return;
        IERC20(_antsToken()).safeTransfer(recipient, amount);
    }

    function burnCapForEpoch(uint256 epoch) public view returns (uint256) {
        return Math.mulDiv(emissionsAuthority.schedule().getEpochEmission(epoch), BURN_CAP_BPS, BPS_DENOMINATOR);
    }

    function _previewBurnedAmount(uint256 epoch, uint256 excessAmount) internal view returns (uint256) {
        if (excessAmount == 0) return 0;
        uint256 cap = burnCapForEpoch(epoch);
        uint256 alreadyBurned = epochBurnedAmount[epoch];
        if (alreadyBurned >= cap) return 0;
        uint256 remainingBurn = cap - alreadyBurned;
        return excessAmount < remainingBurn ? excessAmount : remainingBurn;
    }

    function _allocateExcessForEpoch(uint256 epoch, uint256 excessAmount)
        internal
        returns (uint256 burnedAmount, uint256 reserveAmount)
    {
        burnedAmount = _previewBurnedAmount(epoch, excessAmount);
        if (burnedAmount != 0) {
            epochBurnedAmount[epoch] += burnedAmount;
        }
        reserveAmount = excessAmount - burnedAmount;
    }

    function _protocolReserve() internal view returns (address reserve) {
        reserve = sellerPools.registry().protocolReserve();
        if (reserve == address(0)) revert InvalidAddress();
    }

    function _antsToken() internal view returns (address token) {
        token = sellerPools.registry().antsToken();
        if (token == address(0)) revert InvalidAddress();
    }
}
