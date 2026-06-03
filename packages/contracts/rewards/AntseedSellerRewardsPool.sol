// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedSellerClaimPolicy } from "../interfaces/IAntseedSellerClaimPolicy.sol";

/**
 * @title AntseedSellerRewardsPool
 * @notice Custody pool for seller ANTS emissions that are earned but not yet
 *         immediately claimable. Emissions mints ANTS to this pool and records
 *         the per-seller locked balance here.
 *
 *         Sellers claim from their own locked balance subject to an optional
 *         seller claim policy. If no policy is configured, claims are blocked
 *         until a policy is introduced.
 *
 *         Important behavior:
 *           - This is custody for locked seller rewards only. It does not
 *             calculate usage points, pool rewards, APY caps, or bootstrap
 *             security weight.
 *           - `recordLockedReward` is accounting-only and can only be called by
 *             the configured emissions contract. The corresponding ANTS must
 *             already have been minted/transferred to this pool.
 *           - Claim eligibility is intentionally delegated to a policy contract
 *             so launch/bootstrap rules can change without changing custody.
 */
contract AntseedSellerRewardsPool is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── External Contracts ──────────────────────────────────────────
    IAntseedRegistry public registry;
    IAntseedSellerClaimPolicy public sellerClaimPolicy;

    // ─── Locked Reward Accounting ────────────────────────────────────
    mapping(address => uint256) public lockedRewards;
    uint256 public totalLockedRewards;

    // ─── Events ──────────────────────────────────────────────────────
    event LockedRewardRecorded(address indexed seller, uint256 amount);
    event SellerRewardsClaimed(address indexed seller, address indexed recipient, uint256 amount);
    event RegistrySet(address indexed registry);
    event SellerClaimPolicySet(address indexed policy);

    // ─── Custom Errors ───────────────────────────────────────────────
    error InvalidAddress();
    error InvalidAmount();
    error NotEmissionsContract();
    error NoSellerClaimPolicy();
    error NothingToClaim();

    // ─── Modifiers ───────────────────────────────────────────────────
    modifier onlyEmissions() {
        if (msg.sender != registry.emissions()) revert NotEmissionsContract();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _registry) Ownable(msg.sender) {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — RECORD LOCKED REWARDS
    // ═══════════════════════════════════════════════════════════════════

    function recordLockedReward(address seller, uint256 amount) external onlyEmissions {
        if (seller == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        lockedRewards[seller] += amount;
        totalLockedRewards += amount;

        emit LockedRewardRecorded(seller, amount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — CLAIM LOCKED REWARDS
    // ═══════════════════════════════════════════════════════════════════

    function claim(address recipient) external nonReentrant {
        if (recipient == address(0)) revert InvalidAddress();

        IAntseedSellerClaimPolicy policy = sellerClaimPolicy;
        if (address(policy) == address(0)) revert NoSellerClaimPolicy();

        uint256 locked = lockedRewards[msg.sender];
        uint256 amount = policy.claimableSellerRewards(msg.sender, locked);
        if (amount > locked) amount = locked;
        if (amount == 0) revert NothingToClaim();

        lockedRewards[msg.sender] = locked - amount;
        totalLockedRewards -= amount;

        IERC20(registry.antsToken()).safeTransfer(recipient, amount);

        emit SellerRewardsClaimed(msg.sender, recipient, amount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setSellerClaimPolicy(address policy) external onlyOwner {
        sellerClaimPolicy = IAntseedSellerClaimPolicy(policy);
        emit SellerClaimPolicySet(policy);
    }

    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
        emit RegistrySet(_registry);
    }
}
