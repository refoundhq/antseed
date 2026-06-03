// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IAntseedEmissionsAuthority } from "../interfaces/IAntseedEmissionsAuthority.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";

/**
 * @title AntseedSellerOperatorUsageRewards
 * @notice Program controller for direct seller operator rewards.
 *
 *         This pays sellers directly for verified usage backed by their seller
 *         pool power. Staker rewards remain in AntseedSellerUsageRewards.
 *
 *         Important behavior:
 *           - This is the direct seller/operator program, intended for the
 *             separate seller share such as the extra 5% usage program.
 *           - It does not split with stakers and does not inspect positions.
 *             It reads direct seller weighted points from AntseedUsageAccounting
 *             and mints through the configured emission program.
 *           - The program share is configured on AntseedEmissionPrograms, so the
 *             same controller can be reused if the share changes by epoch.
 *           - Rewards are minted lazily on claim for finalized epochs only.
 */
contract AntseedSellerOperatorUsageRewards is Ownable2Step, Pausable, ReentrancyGuard {
    // ─── Constants ───────────────────────────────────────────────────
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_REWARD_SHARE_BPS = 500;

    // ─── External Contracts ──────────────────────────────────────────
    IAntseedEmissionsAuthority public emissionsAuthority;
    IAntseedRegistry public registry;
    IAntseedUsageAccounting public usageAccounting;
    bytes32 public immutable programId;

    // ─── Claim State ─────────────────────────────────────────────────
    mapping(address => mapping(uint256 => bool)) public sellerEpochClaimed;

    // ─── Events ──────────────────────────────────────────────────────
    event EmissionsAuthoritySet(address indexed emissionsAuthority);
    event UsageAccountingSet(address indexed usageAccounting);
    event SellerOperatorRewardClaimed(
        address indexed seller,
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

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _emissionsAuthority, address _registry, address _usageAccounting, bytes32 _programId)
        Ownable(msg.sender)
    {
        if (
            _emissionsAuthority == address(0) || _registry == address(0) || _usageAccounting == address(0)
                || _programId == bytes32(0)
        ) revert InvalidAddress();
        emissionsAuthority = IAntseedEmissionsAuthority(_emissionsAuthority);
        registry = IAntseedRegistry(_registry);
        usageAccounting = IAntseedUsageAccounting(_usageAccounting);
        programId = _programId;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — CLAIM SELLER REWARDS
    // ═══════════════════════════════════════════════════════════════════

    function claimSellerReward(address seller, uint256 epoch) external nonReentrant whenNotPaused {
        _claimSellerReward(seller, epoch);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function pendingSellerReward(address seller, uint256 epoch) external view returns (uint256 amount) {
        (uint256 weightedPoints, uint256 totalWeightedPoints) = _sellerShare(seller, epoch);
        if (weightedPoints == 0 || totalWeightedPoints == 0) return 0;
        uint256 epochBudget = emissionsAuthority.programEpochBudget(programId, epoch);
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

    function _claimSellerReward(address seller, uint256 epoch) internal {
        if (seller == address(0)) revert InvalidAddress();
        if (sellerEpochClaimed[seller][epoch]) revert AlreadyClaimed();

        (uint256 weightedPoints, uint256 totalWeightedPoints) = _sellerShare(seller, epoch);
        if (weightedPoints == 0 || totalWeightedPoints == 0) revert NothingToClaim();

        uint256 epochBudget = emissionsAuthority.programEpochBudget(programId, epoch);
        uint256 grossAmount = (epochBudget * weightedPoints) / totalWeightedPoints;
        if (grossAmount == 0) revert NothingToClaim();

        uint256 cap = (epochBudget * MAX_REWARD_SHARE_BPS) / BPS_DENOMINATOR;
        uint256 claimableAmount = grossAmount < cap ? grossAmount : cap;
        uint256 reserveAmount = grossAmount - claimableAmount;
        if (claimableAmount == 0 && reserveAmount == 0) revert NothingToClaim();

        sellerEpochClaimed[seller][epoch] = true;
        if (claimableAmount != 0) {
            emissionsAuthority.mintProgramEmission(programId, epoch, seller, claimableAmount);
        }
        if (reserveAmount != 0) {
            address reserve = registry.protocolReserve();
            if (reserve == address(0)) revert InvalidAddress();
            emissionsAuthority.mintProgramEmission(programId, epoch, reserve, reserveAmount);
        }

        emit SellerOperatorRewardClaimed(
            seller, epoch, weightedPoints, totalWeightedPoints, grossAmount, claimableAmount, reserveAmount
        );
    }

    function _sellerShare(address seller, uint256 epoch)
        internal
        view
        returns (uint256 weightedPoints, uint256 totalWeightedPoints)
    {
        IAntseedUsageAccounting accounting = usageAccounting;
        if (address(accounting) == address(0)) revert InvalidAddress();
        weightedPoints = accounting.weightedSellerPointsByEpoch(epoch, seller);
        totalWeightedPoints = accounting.totalWeightedSellerPointsByEpoch(epoch);
    }
}
