// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

import { IAntseedSellerUnlockPolicy } from "../interfaces/IAntseedSellerUnlockPolicy.sol";

/**
 * @title AntseedSellerUnlockPolicy
 * @notice Transparent policy used by AntseedEmissionsV2 to decide whether a
 *         seller's ANTS emissions may be claimed immediately instead of being
 *         routed into the locked seller rewards pool.
 *
 *         Eligibility is explicit per seller/proxy address. Any seller not
 *         explicitly marked eligible by the owner remains locked by default.
 *
 *         Important behavior:
 *           - This policy is for legacy emissions unlock routing only.
 *           - It does not inspect seller-pool stake or usage state.
 *           - A false value means legacy seller emissions should remain locked
 *             in AntseedSellerRewardsPool.
 */
contract AntseedSellerUnlockPolicy is IAntseedSellerUnlockPolicy, Ownable {
    // ─── Policy State ────────────────────────────────────────────────
    mapping(address => bool) public eligibleSeller;

    // ─── Events ──────────────────────────────────────────────────────
    event SellerEligibilitySet(address indexed seller, bool eligible);

    // ─── Custom Errors ───────────────────────────────────────────────
    error InvalidAddress();

    // ─── Constructor ─────────────────────────────────────────────────
    constructor() Ownable(msg.sender) { }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function canClaimSellerUnlocked(address seller) external view returns (bool) {
        return eligibleSeller[seller];
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setSellerEligibility(address seller, bool eligible) external onlyOwner {
        if (seller == address(0)) revert InvalidAddress();
        eligibleSeller[seller] = eligible;
        emit SellerEligibilitySet(seller, eligible);
    }
}
