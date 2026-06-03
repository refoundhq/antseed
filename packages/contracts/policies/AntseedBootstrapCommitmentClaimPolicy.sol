// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

import { IAntseedSellerClaimPolicy } from "../interfaces/IAntseedSellerClaimPolicy.sol";

interface IAntseedSellerBootstrapCommitments {
    function sellerBootstrapCommitment(address seller) external view returns (uint256);
    function sellerBootstrapMatchedCommitment(address seller) external view returns (uint256);
}

/**
 * @title AntseedBootstrapCommitmentClaimPolicy
 * @notice Claim policy for pre-transfer locked seller rewards that bootstrap seller pools.
 *
 *         Existing locked rewards remain unreleasable unless the seller matches
 *         them by staking the same amount of real ANTS in AntseedSellerPools for
 *         the same bootstrap horizon. The policy is intentionally view-only so it
 *         fits the existing AntseedSellerRewardsPool claim interface:
 *
 *         claimable = lockedAmount - unmatchedBootstrapCommitment
 *
 *         Important behavior:
 *           - This policy does not create bootstrap commitments and does not
 *             transfer stake. It only reads AntseedSellerPools state.
 *           - Amounts above the active bootstrap commitment are claimable as
 *             soon as the policy is installed, unless the seller is frozen.
 *           - Matching real ANTS stake reduces the unmatched commitment and
 *             unlocks the corresponding locked reward balance.
 */
contract AntseedBootstrapCommitmentClaimPolicy is IAntseedSellerClaimPolicy, Ownable2Step {
    // ─── External Contracts ──────────────────────────────────────────
    IAntseedSellerBootstrapCommitments public sellerPools;

    // ─── Policy State ────────────────────────────────────────────────
    mapping(address => bool) public frozenSeller;

    // ─── Events ──────────────────────────────────────────────────────
    event SellerPoolsSet(address indexed sellerPools);
    event SellerFrozenSet(address indexed seller, bool frozen);

    // ─── Custom Errors ───────────────────────────────────────────────
    error InvalidAddress();

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _sellerPools) Ownable(msg.sender) {
        if (_sellerPools == address(0)) revert InvalidAddress();
        sellerPools = IAntseedSellerBootstrapCommitments(_sellerPools);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function claimableSellerRewards(address seller, uint256 lockedAmount) external view returns (uint256 amount) {
        if (seller == address(0) || frozenSeller[seller]) return 0;

        IAntseedSellerBootstrapCommitments pools = sellerPools;
        uint256 bootstrapAmount = pools.sellerBootstrapCommitment(seller);
        if (bootstrapAmount == 0) return 0;

        uint256 matchedAmount = pools.sellerBootstrapMatchedCommitment(seller);
        if (matchedAmount > bootstrapAmount) matchedAmount = bootstrapAmount;

        uint256 unmatchedAmount = bootstrapAmount - matchedAmount;
        if (lockedAmount <= unmatchedAmount) return 0;
        return lockedAmount - unmatchedAmount;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setSellerPools(address _sellerPools) external onlyOwner {
        if (_sellerPools == address(0)) revert InvalidAddress();
        sellerPools = IAntseedSellerBootstrapCommitments(_sellerPools);
        emit SellerPoolsSet(_sellerPools);
    }

    function setSellerFrozen(address seller, bool frozen) external onlyOwner {
        if (seller == address(0)) revert InvalidAddress();
        frozenSeller[seller] = frozen;
        emit SellerFrozenSet(seller, frozen);
    }
}
