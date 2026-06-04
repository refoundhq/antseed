// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import { IAntseedEmissionsAuthority } from "../interfaces/IAntseedEmissionsAuthority.sol";
import { IAntseedSellerPools } from "../interfaces/IAntseedSellerPools.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";

/**
 * @title AntseedSellerUsageRewards
 * @notice Lazy seller-pool reward controller for recognized usage.
 *
 *         Usage accounting records raw seller usage and weighted pool points
 *         during each epoch. When a staker claims or restakes, this contract
 *         calculates that position's share of its pool's program budget:
 *
 *         poolReward = programBudget(epoch) * poolWeightedPoints / totalWeightedPoints
 *         positionReward = poolReward * positionWeight / poolWeight
 *
 *         APY caps are applied at the position level. Claimable rewards and
 *         over-cap burns are minted lazily for each claimed epoch.
 *
 *         Important behavior:
 *           - This is the staker pool-reward program, not the direct seller
 *             operator reward program.
 *           - Rewards are not pre-minted into this contract. Claim/restake
 *             computes the position's epoch share, mints claimable ANTS to the
 *             recipient or seller-pools contract, and mints over-cap amounts to
 *             the dead address.
 *           - APY caps are position-specific. A large pool reward can still
 *             burn at claim time if an individual position exceeds its cap.
 *           - Restaking rewards creates a new locked position in the source
 *             agent pool and may receive a configured weight bonus based on lock
 *             length.
 *           - Bootstrap rewards are accounted separately from normal positions
 *             because bootstrap power is discounted security weight, not real
 *             transferable ANTS held by this contract.
 */
contract AntseedSellerUsageRewards is Ownable2Step, Pausable, ReentrancyGuard {
    using Math for uint256;

    // ─── Constants ───────────────────────────────────────────────────
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // ─── External Contracts ──────────────────────────────────────────
    IAntseedEmissionsAuthority public emissionsAuthority;
    IAntseedSellerPools public sellerPools;
    IAntseedUsageAccounting public usageAccounting;
    bytes32 public immutable programId;

    // ─── Claim State ─────────────────────────────────────────────────
    mapping(uint256 => mapping(uint256 => bool)) public positionEpochClaimed;
    mapping(address => mapping(uint256 => bool)) public bootstrapEpochClaimed;

    struct RewardCollection {
        address rewardRecipient;
        address staker;
        bool emitClaimEvents;
        uint256[] claimableByEpoch;
        uint256[] burnedByEpoch;
    }

    // ─── Events ──────────────────────────────────────────────────────
    event EmissionsAuthoritySet(address indexed emissionsAuthority);
    event SellerPoolsSet(address indexed sellerPools);
    event UsageAccountingSet(address indexed usageAccounting);
    event StakerUsageRewardClaimed(
        uint256 indexed positionId,
        address indexed staker,
        address indexed recipient,
        uint256 epoch,
        uint256 grossAmount,
        uint256 claimableAmount,
        uint256 burnedAmount
    );
    event StakerUsageRewardRestaked(
        uint256 indexed sourcePositionId,
        uint256 indexed newPositionId,
        address indexed staker,
        uint256 amount,
        uint256 burnedAmount
    );
    event BootstrapUsageRewardClaimed(
        address indexed seller,
        uint256 indexed agentId,
        uint256 indexed epoch,
        address recipient,
        uint256 grossAmount,
        uint256 claimableAmount,
        uint256 burnedAmount
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
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — CLAIM STAKER REWARDS
    // ═══════════════════════════════════════════════════════════════════

    function claimStakerRewards(uint256 positionId, uint256[] calldata epochs, address recipient)
        external
        nonReentrant
        whenNotPaused
    {
        if (recipient == address(0)) revert InvalidAddress();
        uint256[] memory claimableByEpoch = new uint256[](epochs.length);
        uint256[] memory burnedByEpoch = new uint256[](epochs.length);
        (uint256 totalClaimed, uint256 totalBurned) = _collectStakerRewards(
            positionId, epochs, RewardCollection(recipient, msg.sender, true, claimableByEpoch, burnedByEpoch)
        );
        if (totalClaimed == 0 && totalBurned == 0) revert NothingToClaim();
        _mintCollected(epochs, recipient, claimableByEpoch);
        _mintCollected(epochs, DEAD_ADDRESS, burnedByEpoch);
    }

    function claimStakerRewardsBatch(uint256[] calldata positionIds, uint256[] calldata epochs, address recipient)
        external
        nonReentrant
        whenNotPaused
    {
        if (recipient == address(0)) revert InvalidAddress();
        if (positionIds.length == 0) revert InvalidValue();

        uint256[] memory claimableByEpoch = new uint256[](epochs.length);
        uint256[] memory burnedByEpoch = new uint256[](epochs.length);
        uint256 totalClaimedAll;
        uint256 totalBurnedAll;
        for (uint256 p = 0; p < positionIds.length; p++) {
            (uint256 totalClaimed, uint256 totalBurned) = _collectStakerRewards(
                positionIds[p], epochs, RewardCollection(recipient, msg.sender, true, claimableByEpoch, burnedByEpoch)
            );
            totalClaimedAll += totalClaimed;
            totalBurnedAll += totalBurned;
        }
        if (totalClaimedAll == 0 && totalBurnedAll == 0) revert NothingToClaim();
        _mintCollected(epochs, recipient, claimableByEpoch);
        _mintCollected(epochs, DEAD_ADDRESS, burnedByEpoch);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — RESTAKE STAKER REWARDS
    // ═══════════════════════════════════════════════════════════════════

    function restakeStakerRewards(uint256 positionId, uint256[] calldata epochs, uint256 stakeEpochs)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 newPositionId)
    {
        uint256[] memory restakedByEpoch = new uint256[](epochs.length);
        uint256[] memory burnedByEpoch = new uint256[](epochs.length);
        (uint256 totalRestaked, uint256 totalBurned) = _collectStakerRewards(
            positionId,
            epochs,
            RewardCollection(address(sellerPools), msg.sender, false, restakedByEpoch, burnedByEpoch)
        );
        if (totalRestaked == 0) revert NothingToClaim();
        _mintCollected(epochs, address(sellerPools), restakedByEpoch);
        _mintCollected(epochs, DEAD_ADDRESS, burnedByEpoch);
        newPositionId = sellerPools.stakeMintedReward(msg.sender, positionId, totalRestaked, stakeEpochs);
        emit StakerUsageRewardRestaked(positionId, newPositionId, msg.sender, totalRestaked, totalBurned);
    }

    function restakeStakerRewardsBatch(uint256[] calldata positionIds, uint256[] calldata epochs, uint256 stakeEpochs)
        external
        nonReentrant
        whenNotPaused
        returns (uint256[] memory newPositionIds)
    {
        if (positionIds.length == 0) revert InvalidValue();

        newPositionIds = new uint256[](positionIds.length);
        uint256[] memory restakedAmounts = new uint256[](positionIds.length);
        uint256[] memory burnedAmounts = new uint256[](positionIds.length);
        uint256[] memory restakedByEpoch = new uint256[](epochs.length);
        uint256[] memory burnedByEpoch = new uint256[](epochs.length);
        uint256 totalRestakedAll;
        uint256 totalBurnedAll;
        for (uint256 p = 0; p < positionIds.length; p++) {
            (restakedAmounts[p], burnedAmounts[p]) = _collectStakerRewards(
                positionIds[p],
                epochs,
                RewardCollection(address(sellerPools), msg.sender, false, restakedByEpoch, burnedByEpoch)
            );
            totalRestakedAll += restakedAmounts[p];
            totalBurnedAll += burnedAmounts[p];
        }
        if (totalRestakedAll == 0 && totalBurnedAll == 0) revert NothingToClaim();
        if (totalRestakedAll == 0) revert NothingToClaim();

        _mintCollected(epochs, address(sellerPools), restakedByEpoch);
        _mintCollected(epochs, DEAD_ADDRESS, burnedByEpoch);
        for (uint256 p = 0; p < positionIds.length; p++) {
            if (restakedAmounts[p] == 0) continue;
            newPositionIds[p] =
                sellerPools.stakeMintedReward(msg.sender, positionIds[p], restakedAmounts[p], stakeEpochs);
            emit StakerUsageRewardRestaked(
                positionIds[p], newPositionIds[p], msg.sender, restakedAmounts[p], burnedAmounts[p]
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — CLAIM BOOTSTRAP REWARDS
    // ═══════════════════════════════════════════════════════════════════

    function claimBootstrapRewards(uint256[] calldata epochs, address recipient) external nonReentrant whenNotPaused {
        if (recipient == address(0)) revert InvalidAddress();

        (uint256 agentId,,,,) = sellerPools.bootstrapCommitments(msg.sender);
        if (agentId == 0) revert InvalidValue();

        uint256 totalClaimed;
        uint256 totalBurned;
        for (uint256 i = 0; i < epochs.length; i++) {
            uint256 epoch = epochs[i];
            (uint256 grossAmount, uint256 claimableAmount, uint256 burnedAmount) =
                _bootstrapReward(msg.sender, agentId, epoch);
            if (grossAmount == 0) continue;

            bootstrapEpochClaimed[msg.sender][epoch] = true;
            _mint(epoch, recipient, claimableAmount);
            _mint(epoch, DEAD_ADDRESS, burnedAmount);
            totalClaimed += claimableAmount;
            totalBurned += burnedAmount;
            emit BootstrapUsageRewardClaimed(
                msg.sender, agentId, epoch, recipient, grossAmount, claimableAmount, burnedAmount
            );
        }

        if (totalClaimed == 0 && totalBurned == 0) revert NothingToClaim();
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
        return _positionReward(positionId, agentId, epoch);
    }

    function pendingBootstrapReward(address seller, uint256 epoch)
        external
        view
        returns (uint256 grossAmount, uint256 claimableAmount, uint256 burnedAmount)
    {
        (uint256 agentId,,,,) = sellerPools.bootstrapCommitments(seller);
        return _bootstrapReward(seller, agentId, epoch);
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

    function _collectStakerRewards(uint256 positionId, uint256[] calldata epochs, RewardCollection memory collection)
        internal
        returns (uint256 totalClaimed, uint256 totalBurned)
    {
        (address owner, uint256 agentId,,,,,,) = sellerPools.positions(positionId);
        if (owner == address(0)) revert InvalidValue();
        if (owner != collection.staker) revert NotPositionOwner();

        for (uint256 i = 0; i < epochs.length; i++) {
            uint256 epoch = epochs[i];
            (uint256 grossAmount, uint256 claimableAmount, uint256 burnedAmount) =
                _positionReward(positionId, agentId, epoch);
            if (grossAmount == 0) continue;

            positionEpochClaimed[positionId][epoch] = true;
            collection.claimableByEpoch[i] += claimableAmount;
            collection.burnedByEpoch[i] += burnedAmount;
            totalClaimed += claimableAmount;
            totalBurned += burnedAmount;
            if (collection.emitClaimEvents) {
                emit StakerUsageRewardClaimed(
                    positionId,
                    collection.staker,
                    collection.rewardRecipient,
                    epoch,
                    grossAmount,
                    claimableAmount,
                    burnedAmount
                );
            }
        }
    }

    function _mintCollected(uint256[] calldata epochs, address recipient, uint256[] memory amounts) internal {
        for (uint256 i = 0; i < epochs.length; i++) {
            _mint(epochs[i], recipient, amounts[i]);
        }
    }

    function _positionReward(uint256 positionId, uint256 agentId, uint256 epoch)
        internal
        view
        returns (uint256 grossAmount, uint256 claimableAmount, uint256 burnedAmount)
    {
        if (positionEpochClaimed[positionId][epoch] || agentId == 0) return (0, 0, 0);

        IAntseedSellerPools pools = sellerPools;
        uint256 positionWeight = pools.positionWeightAtEpoch(positionId, epoch);
        if (positionWeight == 0) return (0, 0, 0);

        uint256 poolWeight = pools.poolWeightAtEpoch(agentId, epoch);
        uint256 poolGrossReward = _poolGrossReward(agentId, epoch);
        if (poolWeight == 0 || poolGrossReward == 0) return (0, 0, 0);

        grossAmount = Math.mulDiv(poolGrossReward, positionWeight, poolWeight);
        uint256 cap = pools.positionRewardCapAtEpoch(positionId, epoch);
        claimableAmount = grossAmount < cap ? grossAmount : cap;
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
        uint256 poolGrossReward = _poolGrossReward(agentId, epoch);
        if (poolWeight == 0 || poolGrossReward == 0) return (0, 0, 0);

        grossAmount = Math.mulDiv(poolGrossReward, bootstrapWeight, poolWeight);
        uint256 cap = pools.bootstrapRewardCapAtEpoch(seller, epoch);
        claimableAmount = grossAmount < cap ? grossAmount : cap;
        burnedAmount = grossAmount - claimableAmount;
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
}
