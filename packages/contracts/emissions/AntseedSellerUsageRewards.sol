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
 *           - Rewards are not pre-minted into this contract. Claim/restake
 *             settles the pool epoch if needed, mints claimable ANTS to the
 *             recipient or seller-pools contract, mints capped pool over-cap
 *             amounts to the dead address, and routes the remaining over-cap
 *             amount to the protocol reserve.
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
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant BURN_CAP_BPS = 3_000;

    // ─── External Contracts ──────────────────────────────────────────
    IAntseedEmissionsAuthority public emissionsAuthority;
    IAntseedSellerPools public sellerPools;
    IAntseedUsageAccounting public usageAccounting;
    bytes32 public immutable programId;

    // ─── Claim State ─────────────────────────────────────────────────
    mapping(uint256 => mapping(uint256 => bool)) public positionEpochClaimed;
    mapping(address => mapping(uint256 => bool)) public bootstrapEpochClaimed;
    mapping(uint256 => uint256) public epochBurnedAmount;
    mapping(uint256 => mapping(uint256 => PoolEpochEmission)) public poolEpochEmissions;

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
    event StakerUsageRewardClaimed(
        uint256 indexed positionId,
        address indexed staker,
        address indexed recipient,
        uint256 epoch,
        uint256 grossAmount,
        uint256 claimableAmount,
        uint256 burnedAmount,
        uint256 reserveAmount
    );
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
        (uint256 totalClaimed, uint256 totalBurned, uint256 totalReserved) =
            _claimStakerRewards(positionId, epochs, ClaimRoute(recipient, msg.sender, true));
        if (totalClaimed == 0 && totalBurned == 0 && totalReserved == 0) revert NothingToClaim();
    }

    function claimStakerRewardsBatch(uint256[] calldata positionIds, uint256[] calldata epochs, address recipient)
        external
        nonReentrant
        whenNotPaused
    {
        if (recipient == address(0)) revert InvalidAddress();
        if (positionIds.length == 0) revert InvalidValue();

        uint256 totalClaimedAll;
        uint256 totalBurnedAll;
        uint256 totalReservedAll;
        for (uint256 p = 0; p < positionIds.length; p++) {
            (uint256 totalClaimed, uint256 totalBurned, uint256 totalReserved) =
                _claimStakerRewards(positionIds[p], epochs, ClaimRoute(recipient, msg.sender, true));
            totalClaimedAll += totalClaimed;
            totalBurnedAll += totalBurned;
            totalReservedAll += totalReserved;
        }
        if (totalClaimedAll == 0 && totalBurnedAll == 0 && totalReservedAll == 0) revert NothingToClaim();
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
        (uint256 totalRestaked, uint256 totalBurned, uint256 totalReserved) =
            _claimStakerRewards(positionId, epochs, ClaimRoute(address(sellerPools), msg.sender, false));
        if (totalRestaked == 0) revert NothingToClaim();
        newPositionId = sellerPools.stakeMintedReward(msg.sender, positionId, totalRestaked, stakeEpochs);
        emit StakerUsageRewardRestaked(positionId, newPositionId, msg.sender, totalRestaked, totalBurned, totalReserved);
    }

    function restakeStakerRewardsBatch(uint256[] calldata positionIds, uint256[] calldata epochs, uint256 stakeEpochs)
        external
        nonReentrant
        whenNotPaused
        returns (uint256[] memory newPositionIds)
    {
        if (positionIds.length == 0) revert InvalidValue();

        newPositionIds = new uint256[](positionIds.length);
        uint256 totalRestakedAll;
        uint256 totalBurnedAll;
        uint256 totalReservedAll;
        for (uint256 p = 0; p < positionIds.length; p++) {
            (uint256 totalRestaked, uint256 totalBurned, uint256 totalReserved) =
                _claimStakerRewards(positionIds[p], epochs, ClaimRoute(address(sellerPools), msg.sender, false));
            totalRestakedAll += totalRestaked;
            totalBurnedAll += totalBurned;
            totalReservedAll += totalReserved;
            if (totalRestaked == 0) continue;

            newPositionIds[p] = sellerPools.stakeMintedReward(msg.sender, positionIds[p], totalRestaked, stakeEpochs);
            emit StakerUsageRewardRestaked(
                positionIds[p], newPositionIds[p], msg.sender, totalRestaked, totalBurned, totalReserved
            );
        }
        if (totalRestakedAll == 0 && totalBurnedAll == 0 && totalReservedAll == 0) revert NothingToClaim();
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
            _mint(epoch, recipient, claimableAmount);
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

    function _claimStakerRewards(uint256 positionId, uint256[] calldata epochs, ClaimRoute memory route)
        internal
        returns (uint256 totalClaimed, uint256 totalBurned, uint256 totalReserved)
    {
        (address owner, uint256 agentId,,,,,,) = sellerPools.positions(positionId);
        if (owner == address(0)) revert InvalidValue();
        if (owner != route.staker) revert NotPositionOwner();

        for (uint256 i = 0; i < epochs.length; i++) {
            (uint256 claimedAmount, uint256 burnedAmount, uint256 reserveAmount) =
                _claimStakerRewardEpoch(positionId, agentId, epochs[i], route);
            totalClaimed += claimedAmount;
            totalBurned += burnedAmount;
            totalReserved += reserveAmount;
        }
    }

    function _claimStakerRewardEpoch(uint256 positionId, uint256 agentId, uint256 epoch, ClaimRoute memory route)
        internal
        returns (uint256 claimableAmount, uint256 burnedAmount, uint256 reserveAmount)
    {
        uint256 grossAmount;
        (grossAmount, claimableAmount,) = _positionReward(positionId, agentId, epoch);
        if (grossAmount == 0) return (0, 0, 0);

        positionEpochClaimed[positionId][epoch] = true;
        (, burnedAmount, reserveAmount) = _settlePoolEpoch(agentId, epoch);
        _mint(epoch, route.recipient, claimableAmount);
        if (route.emitClaimEvents) {
            emit StakerUsageRewardClaimed(
                positionId,
                route.staker,
                route.recipient,
                epoch,
                grossAmount,
                claimableAmount,
                burnedAmount,
                reserveAmount
            );
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
}
