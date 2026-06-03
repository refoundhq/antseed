// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

import { IAntseedSellerClaimPolicy } from "../interfaces/IAntseedSellerClaimPolicy.sol";

/**
 * @title AntseedSellerVettedClaimPolicy
 * @notice Conservative release policy for seller rewards already locked in
 *         AntseedSellerRewardsPool. It is intentionally simple: sellers are
 *         blocked by default, can be frozen, and can be approved with an
 *         optional minimum locked balance that remains unreleasable.
 *
 *         Important behavior:
 *           - This is an administrative release policy, not a reward calculator.
 *           - Unapproved sellers claim zero by default.
 *           - Frozen sellers claim zero even if previously approved.
 *           - `minimumLockedBalance` keeps a floor in the rewards pool while
 *             allowing only the excess to be claimed.
 */
contract AntseedSellerVettedClaimPolicy is IAntseedSellerClaimPolicy, Ownable2Step {
    // ─── Policy State ────────────────────────────────────────────────
    mapping(address => bool) public approvedSeller;
    mapping(address => bool) public frozenSeller;
    mapping(address => uint256) public minimumLockedBalance;

    // ─── Events ──────────────────────────────────────────────────────
    event SellerApprovalSet(address indexed seller, bool approved);
    event SellerFrozenSet(address indexed seller, bool frozen);
    event MinimumLockedBalanceSet(address indexed seller, uint256 amount);

    // ─── Custom Errors ───────────────────────────────────────────────
    error InvalidAddress();
    error ArrayLengthMismatch();

    // ─── Constructor ─────────────────────────────────────────────────
    constructor() Ownable(msg.sender) { }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function claimableSellerRewards(address seller, uint256 lockedAmount) external view returns (uint256 amount) {
        if (seller == address(0)) return 0;
        if (frozenSeller[seller]) return 0;
        if (!approvedSeller[seller]) return 0;

        uint256 minimumLocked = minimumLockedBalance[seller];
        if (lockedAmount <= minimumLocked) return 0;
        return lockedAmount - minimumLocked;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setSellerApproval(address seller, bool approved) external onlyOwner {
        if (seller == address(0)) revert InvalidAddress();
        approvedSeller[seller] = approved;
        emit SellerApprovalSet(seller, approved);
    }

    function setSellerFrozen(address seller, bool frozen) external onlyOwner {
        if (seller == address(0)) revert InvalidAddress();
        frozenSeller[seller] = frozen;
        emit SellerFrozenSet(seller, frozen);
    }

    function setMinimumLockedBalance(address seller, uint256 amount) external onlyOwner {
        if (seller == address(0)) revert InvalidAddress();
        minimumLockedBalance[seller] = amount;
        emit MinimumLockedBalanceSet(seller, amount);
    }

    function setSellerReview(address seller, bool approved, bool frozen, uint256 minimumLocked) external onlyOwner {
        if (seller == address(0)) revert InvalidAddress();
        approvedSeller[seller] = approved;
        frozenSeller[seller] = frozen;
        minimumLockedBalance[seller] = minimumLocked;
        emit SellerApprovalSet(seller, approved);
        emit SellerFrozenSet(seller, frozen);
        emit MinimumLockedBalanceSet(seller, minimumLocked);
    }

    function setSellerReviews(
        address[] calldata sellers,
        bool[] calldata approvals,
        bool[] calldata freezes,
        uint256[] calldata minimumLockedBalances
    ) external onlyOwner {
        uint256 length = sellers.length;
        if (approvals.length != length || freezes.length != length || minimumLockedBalances.length != length) {
            revert ArrayLengthMismatch();
        }

        for (uint256 i = 0; i < length; i++) {
            address seller = sellers[i];
            if (seller == address(0)) revert InvalidAddress();
            approvedSeller[seller] = approvals[i];
            frozenSeller[seller] = freezes[i];
            minimumLockedBalance[seller] = minimumLockedBalances[i];
            emit SellerApprovalSet(seller, approvals[i]);
            emit SellerFrozenSet(seller, freezes[i]);
            emit MinimumLockedBalanceSet(seller, minimumLockedBalances[i]);
        }
    }
}
