// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IANTSToken } from "../interfaces/IANTSToken.sol";
import { IAntseedSellerPools } from "../interfaces/IAntseedSellerPools.sol";
import { IAntseedSellerRewardsPool } from "../interfaces/IAntseedSellerRewardsPool.sol";
import { IAntseedStaking } from "../interfaces/IAntseedStaking.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";
import { IERC8004Registry } from "../interfaces/IERC8004Registry.sol";

/**
 * @title AntseedSellerPools
 * @notice ANTS stake pools keyed by ERC-8004 agent id.
 *
 *         Sellers are not special stakers in this contract. Every position has
 *         an owner, an agent id, an amount, and a lock window. Pool rewards are
 *         routed to the agent pool and claimed pro-rata by position weight.
 *
 *         Important behavior:
 *           - There is no explicit "create pool" action. A pool exists when an
 *             agent id has active stake or bootstrap power for an epoch.
 *           - Pools are keyed by agent id, not seller address. If an agent is
 *             sold, historical stake remains attached to that agent pool.
 *           - This contract only tracks stake, pool power, bootstrap power,
 *             position weights, slashing, and APY caps. Usage verification,
 *             wash-trading policy, and reward-program shares live outside it.
 *           - Pool power is precomputed at stake time into per-epoch totals.
 *             High-frequency settlement should read O(1) epoch power and never
 *             loop over positions.
 *           - New stake, matched bootstrap stake, and restaked rewards activate
 *             after `stakeActivationDelay`. Moves and early withdrawals take
 *             effect at the next epoch so current-epoch power stays frozen.
 *           - Moving stake keeps principal but may reduce `weightAmount` via
 *             `moveWeightPenaltyBps`; early withdrawal may slash principal.
 *           - Bootstrap commitments are only available before ANTS transfers
 *             are enabled, are capped, count at discounted weight, and can be
 *             replaced by matching real 12-month stake.
 */
contract AntseedSellerPools is IAntseedSellerPools, ERC721, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Constants ───────────────────────────────────────────────────
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_APY_BPS_CAP = 10_000;
    uint256 public constant MAX_STAKE_EPOCHS_CAP = 52;
    uint256 public constant MAX_RESTAKED_REWARD_WEIGHT_BONUS_BPS = 2_000;
    uint256 public constant BOOTSTRAP_COMMITMENT_STAKE_EPOCHS = 52;
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // ─── External Contracts ──────────────────────────────────────────
    IAntseedRegistry public registry;
    IAntseedSellerRewardsPool public sellerRewardsPool;
    IERC20 public immutable antsToken;

    // ─── Deterministic Bootstrap APY Cap (fixed at deployment) ───────
    // During the bootstrap period the reward APY cap is a pure function of
    // the epoch:
    //   cap(e) = apyStartBps                      while decay has not started
    //   cap(e) = max(apyFloorBps,
    //                apyStartBps - apyDecayPerEpochBps * (e - apyDecayStartEpoch))
    // The parameters are immutable; the only owner action during bootstrap is
    // the one-time, future-epoch-only `startApyDecay`. After the decay has
    // fully landed on the floor, the cap becomes adjustable via
    // `setApyCapBps` — but only for future epochs, so the bootstrap curve and
    // every already-earned epoch are immutable on-chain.
    uint256 public constant EPOCHS_PER_YEAR = 52;
    uint256 public immutable apyStartBps; // 0 = uncapped
    uint256 public immutable apyFloorBps;
    uint256 public immutable apyDecayPerEpochBps;
    uint256 public apyDecayStartEpoch; // 0 = decay not started

    struct ApyCapOverride {
        uint64 fromEpoch;
        uint16 capBps; // 0 = uncapped
    }

    // Post-bootstrap cap overrides, append-only, future epochs only.
    ApyCapOverride[] public apyCapOverrides;

    // ─── Configurable Parameters ─────────────────────────────────────
    uint256 public minStakeEpochs = 1;
    uint256 public maxStakeEpochs = 52;
    uint256 public stakeActivationDelay = 1;
    uint256 public maxSlashBps = 5_000;
    uint256 public minEarlyExitSlashBps = 500;
    uint256 public bootstrapCommitmentCap = 1_000_000e18;
    uint256 public bootstrapWeightBps = 5_000;
    uint256 public restakedRewardWeightBonusBps = 500;
    uint256 public moveWeightPenaltyBps = 0;
    uint256 public nextPositionId = 1;

    // ─── Structs ─────────────────────────────────────────────────────
    struct Position {
        address owner;
        uint256 agentId;
        uint256 amount;
        uint256 weightAmount;
        uint64 stakeStartEpoch;
        uint64 stakeEndEpoch;
        uint64 closedAtEpoch;
        bool withdrawn;
    }

    struct BootstrapCommitment {
        uint256 agentId;
        uint256 amount;
        uint256 matchedAmount;
        uint64 startEpoch;
        uint64 stakeEndEpoch;
        // bootstrapWeightBps snapshot taken at activation; matching must remove
        // power at the same discount it was added with, even if the global
        // config changes in between.
        uint64 weightBps;
    }

    // ─── Position And Epoch Accounting ───────────────────────────────
    mapping(uint256 => Position) public positions;

    mapping(uint256 => mapping(uint256 => uint256)) public poolPowerByEpoch;
    mapping(uint256 => mapping(uint256 => uint256)) public poolActiveStakeByEpoch;
    mapping(uint256 => mapping(uint256 => uint256)) public bootstrapPowerByEpoch;
    mapping(uint256 => uint256) public totalPowerByEpoch;

    // ─── Bootstrap And Reward-Staker Permissions ─────────────────────
    mapping(address => bool) public rewardStakers;
    mapping(address => BootstrapCommitment) public bootstrapCommitments;
    mapping(uint256 => address) public bootstrapSellerByAgentId;

    mapping(address => uint256[]) private _stakerPositionIds;
    mapping(uint256 => uint256) private _stakerPositionIndex;

    // ─── Staker Portfolio Totals ─────────────────────────────────────
    mapping(address => uint256) public stakerTotalActiveStake;
    mapping(address => mapping(uint256 => uint256)) public stakerAgentActiveStake;

    // ─── Modifiers ───────────────────────────────────────────────────
    modifier onlyRewardStaker() {
        if (!rewardStakers[msg.sender]) revert NotRewardStaker();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _registry, uint256 _apyStartBps, uint256 _apyFloorBps, uint256 _apyDecayPerEpochBps)
        ERC721("Locked Antseed Stake", "lANTS")
        Ownable(msg.sender)
    {
        if (_registry == address(0)) revert InvalidAddress();
        if (_apyStartBps > MAX_APY_BPS_CAP || _apyFloorBps > _apyStartBps) revert InvalidValue();
        if (_apyStartBps != _apyFloorBps && _apyDecayPerEpochBps == 0) revert InvalidValue();
        registry = IAntseedRegistry(_registry);
        address token = registry.antsToken();
        if (token == address(0)) revert InvalidAddress();
        antsToken = IERC20(token);
        apyStartBps = _apyStartBps;
        apyFloorBps = _apyFloorBps;
        apyDecayPerEpochBps = _apyDecayPerEpochBps;
    }

    // ─── Epoch Helpers ────────────────────────────────────────────────
    function currentEpoch() public view returns (uint256) {
        address emissions = registry.emissions();
        if (emissions == address(0)) revert InvalidAddress();
        return IAntseedUsageAccounting(emissions).currentEpoch();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — STAKE
    // ═══════════════════════════════════════════════════════════════════

    function stake(uint256 agentId, uint256 amount, uint256 stakeEpochs) external returns (uint256 positionId) {
        return stakeFor(msg.sender, agentId, amount, stakeEpochs);
    }

    /**
     * @notice Stake ANTS for `staker` into an agent pool.
     *         Tokens are pulled from msg.sender, but the created position
     *         belongs to `staker`. This supports wallets, contracts, and
     *         delegated funding flows without changing position ownership.
     */
    function stakeFor(address staker, uint256 agentId, uint256 amount, uint256 stakeEpochs)
        public
        nonReentrant
        returns (uint256 positionId)
    {
        if (staker == address(0)) revert InvalidAddress();
        if (agentId == 0) revert InvalidValue();
        if (amount == 0) revert InvalidValue();
        if (stakeEpochs < minStakeEpochs || stakeEpochs > maxStakeEpochs) revert StakeDurationOutOfBounds();

        antsToken.safeTransferFrom(msg.sender, address(this), amount);

        uint256 startEpoch = currentEpoch() + stakeActivationDelay;
        uint256 stakeEndEpoch = startEpoch + stakeEpochs;
        positionId = _createWeightedPosition(staker, agentId, amount, amount, startEpoch, stakeEndEpoch);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — BOOTSTRAP
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Convert a seller's locked pre-transfer rewards into discounted
     *         bootstrap pool power for the seller's own agent id.
     *         This does not move ANTS from the rewards pool. It records security
     *         power only, capped and discounted by configuration.
     */
    function activateBootstrapCommitment(uint256 agentId) external nonReentrant returns (uint256) {
        if (agentId == 0) revert InvalidValue();
        if (IANTSToken(address(antsToken)).transfersEnabled()) revert BootstrapClosed();
        address seller = msg.sender;
        if (bootstrapCommitments[seller].amount != 0 || bootstrapSellerByAgentId[agentId] != address(0)) {
            revert BootstrapAlreadyActive();
        }

        address identityRegistry = registry.identityRegistry();
        if (identityRegistry == address(0)) revert NotAgentOwner();
        try IERC8004Registry(identityRegistry).ownerOf(agentId) returns (address owner) {
            if (owner != seller) revert NotAgentOwner();
        } catch {
            revert NotAgentOwner();
        }

        IAntseedSellerRewardsPool rewardsPool = sellerRewardsPool;
        if (address(rewardsPool) == address(0) || bootstrapCommitmentCap == 0) revert BootstrapUnavailable();
        uint256 lockedRewards = rewardsPool.lockedRewards(seller);
        uint256 bootstrapAmount = lockedRewards > bootstrapCommitmentCap ? bootstrapCommitmentCap : lockedRewards;
        if (bootstrapAmount == 0) revert BootstrapUnavailable();

        uint256 startEpoch = currentEpoch() + stakeActivationDelay;
        uint256 stakeEndEpoch = startEpoch + BOOTSTRAP_COMMITMENT_STAKE_EPOCHS;
        bootstrapCommitments[seller] = BootstrapCommitment({
            agentId: agentId,
            amount: bootstrapAmount,
            matchedAmount: 0,
            startEpoch: uint64(startEpoch),
            stakeEndEpoch: uint64(stakeEndEpoch),
            weightBps: uint64(bootstrapWeightBps)
        });
        bootstrapSellerByAgentId[agentId] = seller;

        uint256 effectiveAmount = (bootstrapAmount * bootstrapWeightBps) / BPS_DENOMINATOR;
        _addPowerRange(agentId, startEpoch, stakeEndEpoch, effectiveAmount);
        _addBootstrapPowerRange(agentId, startEpoch, stakeEndEpoch, effectiveAmount);
        emit BootstrapCommitmentRecorded(seller, agentId, bootstrapAmount, startEpoch, stakeEndEpoch);
        return agentId;
    }

    /**
     * @notice Replace part of an active bootstrap commitment with real ANTS
     *         stake. The discounted bootstrap power is removed for the matched
     *         amount, and a normal 12-month position is created.
     */
    function matchBootstrapCommitment(uint256 amount) external nonReentrant returns (uint256 positionId) {
        if (amount == 0) revert InvalidValue();
        if (!IANTSToken(address(antsToken)).transfersEnabled()) revert BootstrapClosed();
        address seller = msg.sender;

        BootstrapCommitment storage commitment = bootstrapCommitments[seller];
        if (commitment.amount == 0) revert BootstrapNotFound();
        if (commitment.matchedAmount + amount > commitment.amount) revert BootstrapMatchExceeded();

        uint256 startEpoch = currentEpoch() + stakeActivationDelay;
        if (startEpoch >= commitment.stakeEndEpoch) revert StakeDurationOutOfBounds();

        // Remove power at the activation-time discount (telescoping over
        // matchedAmount so partial matches never remove more than was added),
        // and never before the epoch the bootstrap power started at.
        uint256 effectiveBefore = (commitment.matchedAmount * commitment.weightBps) / BPS_DENOMINATOR;
        commitment.matchedAmount += amount;
        uint256 effectiveBootstrapAmount =
            (commitment.matchedAmount * commitment.weightBps) / BPS_DENOMINATOR - effectiveBefore;
        uint256 removalStartEpoch = startEpoch < commitment.startEpoch ? commitment.startEpoch : startEpoch;
        if (effectiveBootstrapAmount != 0 && removalStartEpoch < commitment.stakeEndEpoch) {
            _removePowerRange(commitment.agentId, removalStartEpoch, commitment.stakeEndEpoch, effectiveBootstrapAmount);
            _removeBootstrapPowerRange(
                commitment.agentId, removalStartEpoch, commitment.stakeEndEpoch, effectiveBootstrapAmount
            );
        }
        antsToken.safeTransferFrom(msg.sender, address(this), amount);
        positionId = _createWeightedPosition(
            seller, commitment.agentId, amount, amount, startEpoch, startEpoch + BOOTSTRAP_COMMITMENT_STAKE_EPOCHS
        );

        emit BootstrapCommitmentMatched(seller, commitment.agentId, amount, commitment.matchedAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — MOVE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Move one position's remaining lock window to another agent pool.
     *         This closes the old pool exposure next epoch and opens a new
     *         position with the same principal and end epoch. Any configured
     *         move penalty reduces only future weight, not withdrawable
     *         principal.
     */
    function moveStake(uint256 positionId, uint256 toAgentId) external nonReentrant returns (uint256 newPositionId) {
        if (toAgentId == 0) revert InvalidValue();
        newPositionId = _movePosition(positionId, toAgentId, msg.sender, currentEpoch() + 1);
    }

    function moveStakes(uint256[] calldata positionIds, uint256 toAgentId)
        external
        nonReentrant
        returns (uint256[] memory newPositionIds)
    {
        if (toAgentId == 0 || positionIds.length == 0) revert InvalidValue();
        uint256 effectiveEpoch = currentEpoch() + 1;
        newPositionIds = new uint256[](positionIds.length);
        for (uint256 i = 0; i < positionIds.length; i++) {
            newPositionIds[i] = _movePosition(positionIds[i], toAgentId, msg.sender, effectiveEpoch);
        }
    }

    // ─── Internal Move Helper ─────────────────────────────────────────
    function _movePosition(uint256 positionId, uint256 toAgentId, address staker, uint256 effectiveEpoch)
        internal
        returns (uint256 newPositionId)
    {
        Position storage position = positions[positionId];
        if (position.owner == address(0)) revert InvalidPosition();
        if (ownerOf(positionId) != staker) revert NotPositionOwner();
        if (position.withdrawn) revert AlreadyWithdrawn();
        if (position.closedAtEpoch != 0) revert PositionClosed();

        // A position that has not activated yet (stakeActivationDelay > 1) added
        // power only from stakeStartEpoch onward; never remove before that, and
        // keep the original activation epoch instead of activating earlier.
        if (effectiveEpoch < position.stakeStartEpoch) effectiveEpoch = position.stakeStartEpoch;
        if (effectiveEpoch >= position.stakeEndEpoch) revert StakeDurationOutOfBounds();

        position.closedAtEpoch = uint64(effectiveEpoch);
        _removePowerRange(position.agentId, effectiveEpoch, position.stakeEndEpoch, position.weightAmount);
        _decreaseActiveStake(staker, position.agentId, position.amount);

        uint256 movedWeightAmount = position.weightAmount;
        uint256 penaltyBps = moveWeightPenaltyBps;
        if (penaltyBps != 0) {
            movedWeightAmount = (movedWeightAmount * (BPS_DENOMINATOR - penaltyBps)) / BPS_DENOMINATOR;
        }

        newPositionId = _createWeightedPosition(
            staker, toAgentId, position.amount, movedWeightAmount, effectiveEpoch, position.stakeEndEpoch
        );
        _burn(positionId);
        emit StakeMoved(positionId, newPositionId, staker, position.agentId, toAgentId);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — RESTAKE REWARDS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Called by approved reward controllers after they mint earned ANTS
     *         to this contract. The minted amount is staked into the source
     *         position's agent pool with a lock-length-based weight bonus.
     */
    function stakeMintedReward(address staker, uint256 sourcePositionId, uint256 amount, uint256 stakeEpochs)
        external
        nonReentrant
        onlyRewardStaker
        returns (uint256 newPositionId)
    {
        if (staker == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidValue();
        if (stakeEpochs < minStakeEpochs || stakeEpochs > maxStakeEpochs) revert StakeDurationOutOfBounds();

        Position memory sourcePosition = positions[sourcePositionId];
        if (sourcePosition.owner == address(0)) revert InvalidPosition();
        if (sourcePosition.owner != staker) revert NotPositionOwner();

        uint256 startEpoch = currentEpoch() + stakeActivationDelay;
        uint256 stakeEndEpoch = startEpoch + stakeEpochs;
        uint256 bonusBps = (restakedRewardWeightBonusBps * stakeEpochs) / maxStakeEpochs;
        uint256 weightAmount = (amount * (BPS_DENOMINATOR + bonusBps)) / BPS_DENOMINATOR;
        newPositionId =
            _createWeightedPosition(staker, sourcePosition.agentId, amount, weightAmount, startEpoch, stakeEndEpoch);
        emit StakerRewardsRestaked(
            staker, sourcePositionId, newPositionId, amount, weightAmount, startEpoch, stakeEndEpoch
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — WITHDRAW
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Withdraw one position. If the position has not reached its end
     *         epoch, the close takes effect next epoch and the slash is sent to
     *         the dead address.
     */
    function withdrawStake(uint256 positionId) external nonReentrant {
        (uint256 returnedAmount, uint256 slashedAmount) = _withdrawPosition(positionId, msg.sender, currentEpoch());
        if (returnedAmount > 0) antsToken.safeTransfer(msg.sender, returnedAmount);
        if (slashedAmount > 0) antsToken.safeTransfer(DEAD_ADDRESS, slashedAmount);
    }

    function withdrawStakes(uint256[] calldata positionIds)
        external
        nonReentrant
        returns (uint256 returnedAmount, uint256 slashedAmount)
    {
        if (positionIds.length == 0) revert InvalidValue();
        uint256 epoch = currentEpoch();
        for (uint256 i = 0; i < positionIds.length; i++) {
            (uint256 positionReturned, uint256 positionSlashed) = _withdrawPosition(positionIds[i], msg.sender, epoch);
            returnedAmount += positionReturned;
            slashedAmount += positionSlashed;
        }

        if (returnedAmount > 0) antsToken.safeTransfer(msg.sender, returnedAmount);
        if (slashedAmount > 0) antsToken.safeTransfer(DEAD_ADDRESS, slashedAmount);
    }

    function _withdrawPosition(uint256 positionId, address staker, uint256 epoch)
        internal
        returns (uint256 returnedAmount, uint256 slashedAmount)
    {
        Position storage position = positions[positionId];
        if (position.owner == address(0)) revert InvalidPosition();
        if (ownerOf(positionId) != staker) revert NotPositionOwner();
        if (position.withdrawn) revert AlreadyWithdrawn();
        if (position.closedAtEpoch != 0) revert PositionClosed();

        uint256 effectiveCloseEpoch = epoch < position.stakeEndEpoch ? epoch + 1 : epoch;
        // A position that has not activated yet (stakeActivationDelay > 1) added
        // power only from stakeStartEpoch onward; never remove before that.
        if (effectiveCloseEpoch < position.stakeStartEpoch) effectiveCloseEpoch = position.stakeStartEpoch;
        returnedAmount = position.amount;

        position.withdrawn = true;
        position.closedAtEpoch = uint64(effectiveCloseEpoch);
        if (effectiveCloseEpoch < position.stakeEndEpoch) {
            _removePowerRange(position.agentId, effectiveCloseEpoch, position.stakeEndEpoch, position.weightAmount);
        }
        _decreaseActiveStake(staker, position.agentId, position.amount);

        if (effectiveCloseEpoch < position.stakeEndEpoch) {
            uint256 slashBps = _earlyExitSlashBps(position, effectiveCloseEpoch);
            slashedAmount = (position.amount * slashBps) / BPS_DENOMINATOR;
            returnedAmount = position.amount - slashedAmount;
        }

        _burn(positionId);
        emit StakeWithdrawn(positionId, staker, returnedAmount, slashedAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function earlyExitSlashBps(uint256 positionId) public view returns (uint256) {
        Position memory position = positions[positionId];
        if (position.owner == address(0)) revert InvalidPosition();
        uint256 epoch = currentEpoch();
        uint256 effectiveCloseEpoch = epoch < position.stakeEndEpoch ? epoch + 1 : epoch;
        if (effectiveCloseEpoch >= position.stakeEndEpoch) return 0;
        return _earlyExitSlashBps(position, effectiveCloseEpoch);
    }

    function ownerOf(uint256 positionId) public view override(ERC721, IAntseedSellerPools) returns (address) {
        return super.ownerOf(positionId);
    }

    function agentIdForSeller(address seller) public view returns (uint256) {
        if (seller == address(0)) return 0;
        address staking = registry.staking();
        if (staking == address(0)) return 0;

        try IAntseedStaking(staking).getAgentId(seller) returns (uint256 agentId) {
            return agentId;
        } catch {
            return 0;
        }
    }

    function hasPoolAtEpoch(uint256 agentId, uint256 epoch) public view returns (bool) {
        return poolWeightAtEpoch(agentId, epoch) != 0;
    }

    function hasPoolAtEpoch(address seller, uint256 epoch) public view returns (bool) {
        uint256 agentId = agentIdForSeller(seller);
        return agentId != 0 && hasPoolAtEpoch(agentId, epoch);
    }

    function poolWeightAtEpoch(uint256 agentId, uint256 epoch) public view returns (uint256 weight) {
        weight = poolPowerByEpoch[agentId][epoch];
    }

    function poolWeightAtEpoch(address seller, uint256 epoch) public view returns (uint256 weight) {
        uint256 agentId = agentIdForSeller(seller);
        if (agentId == 0) return 0;
        return poolWeightAtEpoch(agentId, epoch);
    }

    function positionWeightAtEpoch(uint256 positionId, uint256 epoch) public view returns (uint256) {
        Position memory position = positions[positionId];
        if (position.owner == address(0)) revert InvalidPosition();
        if (epoch < position.stakeStartEpoch || epoch >= position.stakeEndEpoch) return 0;
        if (position.closedAtEpoch != 0 && epoch >= position.closedAtEpoch) return 0;
        return position.weightAmount * (position.stakeEndEpoch - epoch);
    }

    function positionRewardCapAtEpoch(uint256 positionId, uint256 epoch) public view returns (uint256) {
        Position memory position = positions[positionId];
        if (position.owner == address(0)) revert InvalidPosition();
        if (positionWeightAtEpoch(positionId, epoch) == 0) return 0;
        uint256 capBps = apyCapBpsAtEpoch(epoch);
        if (capBps == 0) return type(uint256).max;
        return (position.weightAmount * capBps) / (BPS_DENOMINATOR * EPOCHS_PER_YEAR);
    }

    /**
     * @notice APY cap in bps for a given epoch. A post-bootstrap override
     *         covering the epoch wins; otherwise the cap is a pure function of
     *         the immutable deployment parameters and the one-time decay
     *         anchor: flat `apyStartBps` until `apyDecayStartEpoch`, then
     *         linear decay of `apyDecayPerEpochBps` per epoch down to
     *         `apyFloorBps`. Returns 0 for uncapped.
     */
    function apyCapBpsAtEpoch(uint256 epoch) public view returns (uint256) {
        uint256 overrideCount = apyCapOverrides.length;
        for (uint256 i = overrideCount; i > 0; i--) {
            ApyCapOverride memory capOverride = apyCapOverrides[i - 1];
            if (capOverride.fromEpoch <= epoch) return capOverride.capBps;
        }

        uint256 startBps = apyStartBps;
        if (startBps == 0) return 0;

        uint256 decayStartEpoch = apyDecayStartEpoch;
        if (decayStartEpoch == 0 || epoch < decayStartEpoch) return startBps;

        uint256 reduction = apyDecayPerEpochBps * (epoch - decayStartEpoch);
        uint256 maxReduction = startBps - apyFloorBps;
        if (reduction >= maxReduction) return apyFloorBps;
        return startBps - reduction;
    }

    /// @notice First epoch at which the bootstrap decay has fully landed on
    ///         the floor. 0 while the decay has not been anchored yet.
    function apyDecayEndEpoch() public view returns (uint256) {
        uint256 decayStartEpoch = apyDecayStartEpoch;
        if (decayStartEpoch == 0) return 0;
        uint256 span = apyStartBps - apyFloorBps;
        return decayStartEpoch + (span + apyDecayPerEpochBps - 1) / apyDecayPerEpochBps;
    }

    function apyCapOverrideCount() external view returns (uint256) {
        return apyCapOverrides.length;
    }

    function poolActiveStakeAtEpoch(uint256 agentId, uint256 epoch) public view returns (uint256 activeStake) {
        activeStake = poolActiveStakeByEpoch[agentId][epoch];
    }

    function poolActiveStakeAtEpoch(address seller, uint256 epoch) public view returns (uint256 activeStake) {
        uint256 agentId = agentIdForSeller(seller);
        if (agentId == 0) return 0;
        return poolActiveStakeAtEpoch(agentId, epoch);
    }

    function poolPowerWeightAtEpoch(uint256 agentId, uint256 epoch) public view returns (uint256) {
        return poolWeightAtEpoch(agentId, epoch);
    }

    function poolPowerWeightAtEpoch(address seller, uint256 epoch) public view returns (uint256) {
        return poolWeightAtEpoch(seller, epoch);
    }

    function totalPowerWeightAtEpoch(uint256 epoch) external view returns (uint256) {
        return totalPowerByEpoch[epoch];
    }

    function currentPoolSecurityWeight(uint256 agentId) external view returns (uint256) {
        return poolPowerWeightAtEpoch(agentId, currentEpoch());
    }

    function currentPoolSecurityWeight(address seller) external view returns (uint256) {
        return poolPowerWeightAtEpoch(seller, currentEpoch());
    }

    function currentTotalSecurityWeight() external view returns (uint256) {
        return totalPowerByEpoch[currentEpoch()];
    }

    function currentPoolSecurityShareBps(uint256 agentId) external view returns (uint256 shareBps) {
        uint256 epoch = currentEpoch();
        uint256 poolWeight = poolPowerWeightAtEpoch(agentId, epoch);
        uint256 totalWeight = totalPowerByEpoch[epoch];
        if (poolWeight == 0 || totalWeight == 0) return 0;
        return (poolWeight * BPS_DENOMINATOR) / totalWeight;
    }

    function currentPoolSecurityShareBps(address seller) external view returns (uint256 shareBps) {
        uint256 agentId = agentIdForSeller(seller);
        if (agentId == 0) return 0;
        uint256 epoch = currentEpoch();
        uint256 poolWeight = poolPowerWeightAtEpoch(agentId, epoch);
        uint256 totalWeight = totalPowerByEpoch[epoch];
        if (poolWeight == 0 || totalWeight == 0) return 0;
        return (poolWeight * BPS_DENOMINATOR) / totalWeight;
    }

    function bootstrapWeightAtEpoch(uint256 agentId, uint256 epoch) public view returns (uint256 weight) {
        weight = bootstrapPowerByEpoch[agentId][epoch];
    }

    function bootstrapWeightAtEpoch(address seller, uint256 epoch) public view returns (uint256 weight) {
        BootstrapCommitment memory commitment = bootstrapCommitments[seller];
        if (commitment.agentId == 0) return 0;
        return bootstrapWeightAtEpoch(commitment.agentId, epoch);
    }

    function bootstrapRewardCapAtEpoch(address seller, uint256 epoch) public view returns (uint256 cap) {
        BootstrapCommitment memory commitment = bootstrapCommitments[seller];
        if (commitment.agentId == 0 || epoch < commitment.startEpoch || epoch >= commitment.stakeEndEpoch) return 0;
        uint256 weight = bootstrapWeightAtEpoch(commitment.agentId, epoch);
        if (weight == 0) return 0;
        uint256 remainingEpochs = commitment.stakeEndEpoch - epoch;
        uint256 capBps = apyCapBpsAtEpoch(epoch);
        if (capBps == 0) return type(uint256).max;
        return ((weight / remainingEpochs) * capBps) / (BPS_DENOMINATOR * EPOCHS_PER_YEAR);
    }

    function sellerBootstrapCommitment(address seller) public view returns (uint256) {
        return bootstrapCommitments[seller].amount;
    }

    function sellerBootstrapMatchedCommitment(address seller) public view returns (uint256) {
        return bootstrapCommitments[seller].matchedAmount;
    }

    function stakerPositionCount(address staker) public view returns (uint256) {
        return _stakerPositionIds[staker].length;
    }

    function stakerPositionIdAt(address staker, uint256 index) public view returns (uint256) {
        return _stakerPositionIds[staker][index];
    }

    function stakerPositionIds(address staker, uint256 offset, uint256 limit)
        public
        view
        returns (uint256[] memory ids)
    {
        uint256 count = _stakerPositionIds[staker].length;
        if (offset >= count || limit == 0) return new uint256[](0);

        uint256 end = offset + limit;
        if (end > count) end = count;
        ids = new uint256[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            ids[i - offset] = _stakerPositionIds[staker][i];
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
        emit RegistrySet(_registry);
    }

    function setSellerRewardsPool(address _sellerRewardsPool) external onlyOwner {
        sellerRewardsPool = IAntseedSellerRewardsPool(_sellerRewardsPool);
        emit SellerRewardsPoolSet(_sellerRewardsPool);
    }

    function setPoolConfig(
        uint256 _minStakeEpochs,
        uint256 _maxStakeEpochs,
        uint256 _stakeActivationDelay,
        uint256 _maxSlashBps,
        uint256 _minEarlyExitSlashBps
    ) external onlyOwner {
        if (
            _minStakeEpochs == 0 || _maxStakeEpochs < _minStakeEpochs || _maxStakeEpochs > MAX_STAKE_EPOCHS_CAP
                || _stakeActivationDelay == 0 || _stakeActivationDelay > MAX_STAKE_EPOCHS_CAP
        ) revert InvalidValue();
        if (_maxSlashBps > BPS_DENOMINATOR || _minEarlyExitSlashBps > _maxSlashBps) revert InvalidValue();
        minStakeEpochs = _minStakeEpochs;
        maxStakeEpochs = _maxStakeEpochs;
        stakeActivationDelay = _stakeActivationDelay;
        maxSlashBps = _maxSlashBps;
        minEarlyExitSlashBps = _minEarlyExitSlashBps;
        emit PoolConfigSet(_minStakeEpochs, _maxStakeEpochs, _stakeActivationDelay, _maxSlashBps, _minEarlyExitSlashBps);
    }

    function setRewardStaker(address rewardStaker, bool allowed) external onlyOwner {
        if (rewardStaker == address(0)) revert InvalidAddress();
        rewardStakers[rewardStaker] = allowed;
        emit RewardStakerSet(rewardStaker, allowed);
    }

    /**
     * @notice One-time, one-way switch that anchors the APY cap decay at a
     *         FUTURE epoch. The decay parameters are immutable, so calling
     *         this fixes the entire APY trajectory forever:
     *         apyStartBps until `startEpoch`, then -apyDecayPerEpochBps per
     *         epoch down to apyFloorBps. It cannot be re-aimed or undone.
     */
    function startApyDecay(uint256 startEpoch) external onlyOwner {
        if (apyDecayStartEpoch != 0) revert InvalidValue();
        if (apyStartBps == apyFloorBps) revert InvalidValue();
        if (startEpoch <= currentEpoch()) revert InvalidValue();
        apyDecayStartEpoch = startEpoch;
        emit ApyDecayScheduled(startEpoch);
    }

    /**
     * @notice Schedule a post-bootstrap APY cap (0 = uncapped). Overrides are
     *         append-only and constrained so the immutable bootstrap curve and
     *         all earned epochs can never be changed:
     *           - an override only takes effect at a FUTURE epoch, and
     *           - never before the bootstrap decay has fully landed on the
     *             floor (when the deployment has a decay).
     *         Re-scheduling the same pending fromEpoch overwrites it before it
     *         activates.
     */
    function setApyCapBps(uint256 capBps, uint256 fromEpoch) external onlyOwner {
        if (capBps > MAX_APY_BPS_CAP) revert InvalidValue();
        // Bound before the uint64 narrowing below: a wrapped fromEpoch would
        // pass the future-only/ordering checks yet store a past epoch.
        if (fromEpoch > type(uint64).max) revert InvalidValue();
        if (fromEpoch <= currentEpoch()) revert InvalidValue();
        if (apyStartBps != apyFloorBps) {
            uint256 decayEndEpoch = apyDecayEndEpoch();
            if (decayEndEpoch == 0 || fromEpoch < decayEndEpoch) revert InvalidValue();
        }

        ApyCapOverride memory capOverride =
            ApyCapOverride({ fromEpoch: uint64(fromEpoch), capBps: uint16(capBps) });

        uint256 count = apyCapOverrides.length;
        if (count != 0) {
            uint64 lastFromEpoch = apyCapOverrides[count - 1].fromEpoch;
            if (fromEpoch < lastFromEpoch) revert InvalidValue();
            if (fromEpoch == lastFromEpoch) {
                apyCapOverrides[count - 1] = capOverride;
                emit ApyCapOverrideScheduled(fromEpoch, capBps);
                return;
            }
        }
        apyCapOverrides.push(capOverride);
        emit ApyCapOverrideScheduled(fromEpoch, capBps);
    }

    function setBootstrapConfig(uint256 cap, uint256 weightBps) external onlyOwner {
        if (weightBps > BPS_DENOMINATOR) revert InvalidValue();
        bootstrapCommitmentCap = cap;
        bootstrapWeightBps = weightBps;
        emit BootstrapConfigSet(cap, weightBps);
    }

    function setRestakedRewardWeightBonus(uint256 bonusBps) external onlyOwner {
        if (bonusBps > MAX_RESTAKED_REWARD_WEIGHT_BONUS_BPS) revert InvalidValue();
        restakedRewardWeightBonusBps = bonusBps;
        emit RestakedRewardWeightBonusSet(bonusBps);
    }

    function setMoveWeightPenalty(uint256 penaltyBps) external onlyOwner {
        if (penaltyBps > BPS_DENOMINATOR) revert InvalidValue();
        moveWeightPenaltyBps = penaltyBps;
        emit MoveWeightPenaltySet(penaltyBps);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _createWeightedPosition(
        address owner,
        uint256 agentId,
        uint256 amount,
        uint256 weightAmount,
        uint256 startEpoch,
        uint256 stakeEndEpoch
    ) internal returns (uint256 positionId) {
        positionId = nextPositionId++;
        positions[positionId] = Position({
            owner: owner,
            agentId: agentId,
            amount: amount,
            weightAmount: weightAmount,
            stakeStartEpoch: uint64(startEpoch),
            stakeEndEpoch: uint64(stakeEndEpoch),
            closedAtEpoch: 0,
            withdrawn: false
        });

        _addPowerRange(agentId, startEpoch, stakeEndEpoch, weightAmount);
        _increaseActiveStake(owner, agentId, amount);
        _mint(owner, positionId);
        emit StakeCreated(positionId, owner, agentId, amount, weightAmount, startEpoch, stakeEndEpoch);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);

        if (from == address(0)) {
            _addStakerPosition(to, tokenId);
        } else if (to == address(0)) {
            _removeStakerPosition(from, tokenId);
        } else {
            Position storage position = positions[tokenId];
            _removeStakerPosition(from, tokenId);
            _addStakerPosition(to, tokenId);
            _decreaseActiveStake(from, position.agentId, position.amount);
            _increaseActiveStake(to, position.agentId, position.amount);
            position.owner = to;
        }
    }

    function _addStakerPosition(address staker, uint256 positionId) internal {
        _stakerPositionIds[staker].push(positionId);
        _stakerPositionIndex[positionId] = _stakerPositionIds[staker].length;
    }

    function _removeStakerPosition(address staker, uint256 positionId) internal {
        uint256 index = _stakerPositionIndex[positionId];
        if (index == 0) return;

        uint256[] storage ids = _stakerPositionIds[staker];
        uint256 removeIndex = index - 1;
        uint256 lastIndex = ids.length - 1;
        if (removeIndex != lastIndex) {
            uint256 lastPositionId = ids[lastIndex];
            ids[removeIndex] = lastPositionId;
            _stakerPositionIndex[lastPositionId] = index;
        }
        ids.pop();
        delete _stakerPositionIndex[positionId];
    }

    function _increaseActiveStake(address staker, uint256 agentId, uint256 amount) internal {
        stakerTotalActiveStake[staker] += amount;
        stakerAgentActiveStake[staker][agentId] += amount;
        emit StakerActiveStakeUpdated(
            staker, agentId, stakerTotalActiveStake[staker], stakerAgentActiveStake[staker][agentId]
        );
    }

    function _decreaseActiveStake(address staker, uint256 agentId, uint256 amount) internal {
        stakerTotalActiveStake[staker] -= amount;
        stakerAgentActiveStake[staker][agentId] -= amount;
        emit StakerActiveStakeUpdated(
            staker, agentId, stakerTotalActiveStake[staker], stakerAgentActiveStake[staker][agentId]
        );
    }

    function _earlyExitSlashBps(Position memory position, uint256 effectiveCloseEpoch)
        internal
        view
        returns (uint256)
    {
        uint256 originalStakeEpochs = position.stakeEndEpoch - position.stakeStartEpoch;
        if (originalStakeEpochs == 0) return 0;
        uint256 remainingEpochs = position.stakeEndEpoch - effectiveCloseEpoch;
        uint256 slashBps = (maxSlashBps * remainingEpochs) / originalStakeEpochs;
        if (slashBps < minEarlyExitSlashBps) return minEarlyExitSlashBps;
        if (slashBps > maxSlashBps) return maxSlashBps;
        return slashBps;
    }

    function _addPowerRange(uint256 agentId, uint256 startEpoch, uint256 stakeEndEpoch, uint256 amount) internal {
        for (uint256 epoch = startEpoch; epoch < stakeEndEpoch; epoch++) {
            uint256 weight = amount * (stakeEndEpoch - epoch);
            poolPowerByEpoch[agentId][epoch] += weight;
            totalPowerByEpoch[epoch] += weight;
            poolActiveStakeByEpoch[agentId][epoch] += amount;
        }
    }

    function _removePowerRange(uint256 agentId, uint256 startEpoch, uint256 stakeEndEpoch, uint256 amount) internal {
        for (uint256 epoch = startEpoch; epoch < stakeEndEpoch; epoch++) {
            uint256 weight = amount * (stakeEndEpoch - epoch);
            poolPowerByEpoch[agentId][epoch] -= weight;
            totalPowerByEpoch[epoch] -= weight;
            poolActiveStakeByEpoch[agentId][epoch] -= amount;
        }
    }

    function _addBootstrapPowerRange(uint256 agentId, uint256 startEpoch, uint256 stakeEndEpoch, uint256 amount)
        internal
    {
        for (uint256 epoch = startEpoch; epoch < stakeEndEpoch; epoch++) {
            bootstrapPowerByEpoch[agentId][epoch] += amount * (stakeEndEpoch - epoch);
        }
    }

    function _removeBootstrapPowerRange(uint256 agentId, uint256 startEpoch, uint256 stakeEndEpoch, uint256 amount)
        internal
    {
        for (uint256 epoch = startEpoch; epoch < stakeEndEpoch; epoch++) {
            bootstrapPowerByEpoch[agentId][epoch] -= amount * (stakeEndEpoch - epoch);
        }
    }
}
