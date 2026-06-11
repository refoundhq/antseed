// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IAntseedDeposits } from "../interfaces/IAntseedDeposits.sol";
import { IAntseedEmissionsAuthority } from "../interfaces/IAntseedEmissionsAuthority.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";

/**
 * @title AntseedBuyerUsageRewards
 * @notice Program controller for buyer recognized-usage rewards.
 *
 *         AntseedEmissionPrograms owns the buyer program budget. This controller
 *         calculates each buyer's reward from seller-pool-weighted usage points
 *         recorded in AntseedUsageAccounting, then asks the program authority to
 *         mint inside that program budget.
 *
 *         Important behavior:
 *           - Buyer rewards are volume-based but not raw-volume-only: usage is
 *             weighted by the seller pool used by the buyer.
 *           - The program share is configured on AntseedEmissionPrograms, so this
 *             same controller can start at 5% and later run at another share.
 *           - Rewards are minted lazily on claim for finalized epochs only.
 *           - Rewards are always minted to the buyer's Deposits operator. The
 *             buyer hot wallet itself never receives funds (protocol-wide
 *             rule); claims for buyers without a resolvable operator revert
 *             and can be retried once an operator exists.
 */
contract AntseedBuyerUsageRewards is Ownable2Step, Pausable, ReentrancyGuard {
    // ─── Constants ───────────────────────────────────────────────────
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_REWARD_SHARE_BPS = 500;

    // ─── External Contracts ──────────────────────────────────────────
    IAntseedEmissionsAuthority public emissionsAuthority;
    IAntseedRegistry public registry;
    IAntseedUsageAccounting public usageAccounting;
    bytes32 public immutable programId;

    // ─── Claim State ─────────────────────────────────────────────────
    mapping(address => mapping(uint256 => bool)) public buyerEpochClaimed;

    // ─── Events ──────────────────────────────────────────────────────
    event EmissionsAuthoritySet(address indexed emissionsAuthority);
    event RegistrySet(address indexed registry);
    event UsageAccountingSet(address indexed usageAccounting);
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
    constructor(address _emissionsAuthority, address _registry, bytes32 _programId) Ownable(msg.sender) {
        if (_emissionsAuthority == address(0) || _registry == address(0) || _programId == bytes32(0)) {
            revert InvalidAddress();
        }

        emissionsAuthority = IAntseedEmissionsAuthority(_emissionsAuthority);
        registry = IAntseedRegistry(_registry);
        programId = _programId;
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

    function pendingBuyerReward(address buyer, uint256 epoch) external view returns (uint256 amount) {
        (uint256 weightedPoints, uint256 totalWeightedPoints) = _buyerShare(buyer, epoch);
        if (weightedPoints == 0 || totalWeightedPoints == 0) return 0;
        uint256 epochBudget = _programBudget(epoch);
        uint256 grossAmount = (epochBudget * weightedPoints) / totalWeightedPoints;
        uint256 cap = (epochBudget * MAX_REWARD_SHARE_BPS) / BPS_DENOMINATOR;
        return grossAmount < cap ? grossAmount : cap;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setEmissionsAuthority(address _emissionsAuthority) external onlyOwner {
        if (_emissionsAuthority == address(0)) revert InvalidAddress();
        emissionsAuthority = IAntseedEmissionsAuthority(_emissionsAuthority);
        emit EmissionsAuthoritySet(_emissionsAuthority);
    }

    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
        emit RegistrySet(_registry);
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

    function _claimBuyerReward(address buyer, uint256 epoch) internal {
        if (buyer == address(0)) revert InvalidAddress();
        if (buyerEpochClaimed[buyer][epoch]) revert AlreadyClaimed();

        (uint256 weightedPoints, uint256 totalWeightedPoints) = _buyerShare(buyer, epoch);
        if (weightedPoints == 0 || totalWeightedPoints == 0) revert NothingToClaim();

        uint256 epochBudget = _programBudget(epoch);
        uint256 grossAmount = (epochBudget * weightedPoints) / totalWeightedPoints;
        if (grossAmount == 0) revert NothingToClaim();

        uint256 cap = (epochBudget * MAX_REWARD_SHARE_BPS) / BPS_DENOMINATOR;
        uint256 claimableAmount = grossAmount < cap ? grossAmount : cap;
        uint256 reserveAmount = grossAmount - claimableAmount;
        if (claimableAmount == 0 && reserveAmount == 0) revert NothingToClaim();

        buyerEpochClaimed[buyer][epoch] = true;
        address recipient = _rewardRecipient(buyer);
        if (claimableAmount != 0) {
            emissionsAuthority.mintProgramEmission(programId, epoch, recipient, claimableAmount);
        }
        if (reserveAmount != 0) {
            address reserve = registry.protocolReserve();
            if (reserve == address(0)) revert InvalidAddress();
            emissionsAuthority.mintProgramEmission(programId, epoch, reserve, reserveAmount);
        }

        emit BuyerUsageRewardClaimed(
            buyer, recipient, epoch, weightedPoints, totalWeightedPoints, grossAmount, claimableAmount, reserveAmount
        );
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

    function _programBudget(uint256 epoch) internal view returns (uint256) {
        return emissionsAuthority.programEpochBudget(programId, epoch);
    }

    function _rewardRecipient(address buyer) internal view returns (address) {
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
