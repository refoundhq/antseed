// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IAntseedDeposits } from "../interfaces/IAntseedDeposits.sol";
import { IAntseedEmissionsGate } from "../interfaces/IAntseedEmissionsGate.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";
import { IERC8004Registry } from "../interfaces/IERC8004Registry.sol";

/**
 * @title AntseedUsageRewards
 * @notice Controller for direct seller/operator and buyer recognized usage
 *         rewards.
 *
 *         AntseedEmissionsGate owns one 10% usage budget. This controller
 *         reads weighted usage points from AntseedUsageAccounting, splits the
 *         usage budget 50/50 between seller/operator and buyer rewards, and
 *         mints through that explicit usage bucket.
 *
 *         Important behavior:
 *           - Seller/operator rewards pay the current ERC-8004 agent owner.
 *           - Buyer rewards pay the buyer's Deposits operator; the buyer hot
 *             wallet itself never receives rewards.
 *           - Both sides are capped per account/agent at 5% of that side's
 *             epoch budget; overflow routes to protocol reserve.
 */
contract AntseedUsageRewards is Ownable2Step, Pausable, ReentrancyGuard {
    // ─── Constants ───────────────────────────────────────────────────
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_REWARD_SHARE_BPS = 500;

    // ─── External Contracts ──────────────────────────────────────────
    IAntseedEmissionsGate public immutable emissionsGate;
    IAntseedRegistry public immutable registry;
    IAntseedUsageAccounting public immutable usageAccounting;

    // ─── Claim State ─────────────────────────────────────────────────
    mapping(uint256 => mapping(uint256 => bool)) public agentEpochClaimed;
    mapping(address => mapping(uint256 => bool)) public buyerEpochClaimed;

    // ─── Events ──────────────────────────────────────────────────────
    event SellerOperatorRewardClaimed(
        address indexed seller,
        uint256 indexed agentId,
        uint256 indexed epoch,
        uint256 weightedPoints,
        uint256 totalWeightedPoints,
        uint256 grossAmount,
        uint256 claimableAmount,
        uint256 reserveAmount
    );
    event BuyerUsageRewardClaimed(
        address indexed buyer,
        address indexed recipient,
        uint256 indexed epoch,
        uint256 weightedPoints,
        uint256 totalWeightedPoints,
        uint256 grossAmount,
        uint256 claimableAmount,
        uint256 reserveAmount
    );

    // ─── Custom Errors ───────────────────────────────────────────────
    error InvalidAddress();
    error AlreadyClaimed();
    error NothingToClaim();
    error RewardRecipientUnavailable();

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _emissionsGate, address _registry, address _usageAccounting) Ownable(msg.sender) {
        if (_emissionsGate == address(0) || _registry == address(0) || _usageAccounting == address(0)) {
            revert InvalidAddress();
        }

        emissionsGate = IAntseedEmissionsGate(_emissionsGate);
        registry = IAntseedRegistry(_registry);
        usageAccounting = IAntseedUsageAccounting(_usageAccounting);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — CLAIM SELLER REWARDS
    // ═══════════════════════════════════════════════════════════════════

    function claimSellerReward(address seller, uint256 epoch) external nonReentrant whenNotPaused {
        _claimAgentReward(_agentIdForSellerAtEpoch(seller, epoch), epoch);
    }

    function claimAgentReward(uint256 agentId, uint256 epoch) external nonReentrant whenNotPaused {
        _claimAgentReward(agentId, epoch);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — CLAIM BUYER REWARDS
    // ═══════════════════════════════════════════════════════════════════

    function claimBuyerReward(address buyer, uint256 epoch) external nonReentrant whenNotPaused {
        _claimBuyerReward(buyer, epoch);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function pendingSellerReward(address seller, uint256 epoch) external view returns (uint256 amount) {
        return _pendingAgentReward(_agentIdForSellerAtEpoch(seller, epoch), epoch);
    }

    function pendingAgentReward(uint256 agentId, uint256 epoch) external view returns (uint256 amount) {
        return _pendingAgentReward(agentId, epoch);
    }

    function pendingBuyerReward(address buyer, uint256 epoch) external view returns (uint256 amount) {
        (uint256 weightedPoints, uint256 totalWeightedPoints) = _buyerShare(buyer, epoch);
        return _pendingReward(epoch, weightedPoints, totalWeightedPoints);
    }

    function rewardRecipient(uint256 agentId) external view returns (address) {
        return _agentOwner(agentId);
    }

    function _pendingAgentReward(uint256 agentId, uint256 epoch) internal view returns (uint256 amount) {
        (uint256 weightedPoints, uint256 totalWeightedPoints) = _agentShare(agentId, epoch);
        return _pendingReward(epoch, weightedPoints, totalWeightedPoints);
    }

    function _pendingReward(uint256 epoch, uint256 weightedPoints, uint256 totalWeightedPoints)
        internal
        view
        returns (uint256)
    {
        if (weightedPoints == 0 || totalWeightedPoints == 0) return 0;
        uint256 epochBudget = usageSideEpochBudget(epoch);
        uint256 grossAmount = (epochBudget * weightedPoints) / totalWeightedPoints;
        uint256 cap = (epochBudget * MAX_REWARD_SHARE_BPS) / BPS_DENOMINATOR;
        return grossAmount < cap ? grossAmount : cap;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _claimAgentReward(uint256 agentId, uint256 epoch) internal {
        if (agentId == 0) revert InvalidAddress();
        if (agentEpochClaimed[agentId][epoch]) revert AlreadyClaimed();

        (uint256 weightedPoints, uint256 totalWeightedPoints) = _agentShare(agentId, epoch);
        (uint256 grossAmount, uint256 claimableAmount, uint256 reserveAmount) =
            _rewardAmounts(epoch, weightedPoints, totalWeightedPoints);

        agentEpochClaimed[agentId][epoch] = true;
        address seller = _agentOwner(agentId);
        _mintReward(epoch, seller, claimableAmount, reserveAmount);

        emit SellerOperatorRewardClaimed(
            seller, agentId, epoch, weightedPoints, totalWeightedPoints, grossAmount, claimableAmount, reserveAmount
        );
    }

    function _claimBuyerReward(address buyer, uint256 epoch) internal {
        if (buyer == address(0)) revert InvalidAddress();
        if (buyerEpochClaimed[buyer][epoch]) revert AlreadyClaimed();

        (uint256 weightedPoints, uint256 totalWeightedPoints) = _buyerShare(buyer, epoch);
        (uint256 grossAmount, uint256 claimableAmount, uint256 reserveAmount) =
            _rewardAmounts(epoch, weightedPoints, totalWeightedPoints);

        buyerEpochClaimed[buyer][epoch] = true;
        address recipient = _buyerRewardRecipient(buyer);
        _mintReward(epoch, recipient, claimableAmount, reserveAmount);

        emit BuyerUsageRewardClaimed(
            buyer, recipient, epoch, weightedPoints, totalWeightedPoints, grossAmount, claimableAmount, reserveAmount
        );
    }

    function usageSideEpochBudget(uint256 epoch) public view returns (uint256) {
        return emissionsGate.controllerEpochBudget(address(this), epoch) / 2;
    }

    function _rewardAmounts(uint256 epoch, uint256 weightedPoints, uint256 totalWeightedPoints)
        internal
        view
        returns (uint256 grossAmount, uint256 claimableAmount, uint256 reserveAmount)
    {
        if (weightedPoints == 0 || totalWeightedPoints == 0) revert NothingToClaim();

        uint256 epochBudget = usageSideEpochBudget(epoch);
        grossAmount = (epochBudget * weightedPoints) / totalWeightedPoints;
        if (grossAmount == 0) revert NothingToClaim();

        uint256 cap = (epochBudget * MAX_REWARD_SHARE_BPS) / BPS_DENOMINATOR;
        claimableAmount = grossAmount < cap ? grossAmount : cap;
        reserveAmount = grossAmount - claimableAmount;
        if (claimableAmount == 0 && reserveAmount == 0) revert NothingToClaim();
    }

    function _mintReward(uint256 epoch, address recipient, uint256 claimableAmount, uint256 reserveAmount) internal {
        if (claimableAmount != 0) {
            emissionsGate.claim(epoch, recipient, claimableAmount);
        }
        if (reserveAmount != 0) {
            address reserve = registry.protocolReserve();
            if (reserve == address(0)) revert InvalidAddress();
            emissionsGate.claim(epoch, reserve, reserveAmount);
        }
    }

    function _buyerShare(address buyer, uint256 epoch)
        internal
        view
        returns (uint256 weightedPoints, uint256 totalWeightedPoints)
    {
        IAntseedUsageAccounting accounting = usageAccounting;
        if (address(accounting) == address(0)) revert InvalidAddress();
        weightedPoints = accounting.weightedBuyerPointsByEpoch(epoch, buyer);
        totalWeightedPoints = accounting.totalWeightedBuyerPointsByEpoch(epoch);
    }

    function _agentShare(uint256 agentId, uint256 epoch)
        internal
        view
        returns (uint256 weightedPoints, uint256 totalWeightedPoints)
    {
        IAntseedUsageAccounting accounting = usageAccounting;
        if (address(accounting) == address(0)) revert InvalidAddress();
        weightedPoints = accounting.weightedAgentSellerPointsByEpoch(epoch, agentId);
        totalWeightedPoints = accounting.totalWeightedSellerPointsByEpoch(epoch);
    }

    function _agentIdForSellerAtEpoch(address seller, uint256 epoch) internal view returns (uint256 agentId) {
        if (seller == address(0)) revert InvalidAddress();
        agentId = usageAccounting.sellerAgentIdByEpoch(epoch, seller);
        if (agentId == 0) revert NothingToClaim();
    }

    function _agentOwner(uint256 agentId) internal view returns (address owner) {
        address identityRegistry = registry.identityRegistry();
        if (identityRegistry == address(0)) revert InvalidAddress();
        owner = IERC8004Registry(identityRegistry).ownerOf(agentId);
        if (owner == address(0)) revert InvalidAddress();
    }

    function _buyerRewardRecipient(address buyer) internal view returns (address) {
        // Iron rule: the buyer hot wallet never receives funds. If the
        // operator cannot be resolved, revert (rolling back the claimed flag)
        // so the claim can be retried once an operator is available.
        address depositsAddress = registry.deposits();
        if (depositsAddress == address(0)) revert RewardRecipientUnavailable();

        address operator;
        try IAntseedDeposits(depositsAddress).getOperator(buyer) returns (address resolvedOperator) {
            operator = resolvedOperator;
        } catch {
            revert RewardRecipientUnavailable();
        }
        if (operator == address(0)) revert RewardRecipientUnavailable();
        return operator;
    }
}
