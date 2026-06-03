// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IANTSToken } from "../interfaces/IANTSToken.sol";

/**
 * @title AntseedEmissionsGate
 * @notice Canonical ANTS mint authority and immutable emission schedule.
 *
 *         ANTSToken should point its registry reference at this contract, not
 *         the global AntseedRegistry. This contract exposes `emissions()` as
 *         address(this), so ANTSToken's existing mint authorization resolves to
 *         the gate itself.
 *
 *         Important behavior:
 *           - The weekly emission amount, epoch duration, halving interval,
 *             genesis, and effective epoch are immutable.
 *           - Program shares, program controllers, and program budgets are not
 *             stored here. They live in a separate program controller contract.
 *           - The program controller can be bound once through
 *             `setEmissionController`; after that it cannot be changed.
 *           - Epochs before `effectiveEpoch` are legacy-claim epochs. They can
 *             mint through programs until legacy epoch minting is disabled.
 */
contract AntseedEmissionsGate is Ownable2Step, ReentrancyGuard {
    // ─── Fixed Mainnet Configuration ────────────────────────────────
    address public constant ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    uint256 public constant GENESIS = 1_775_728_461;
    uint256 public constant EPOCH_DURATION = 7 days;
    uint256 public constant HALVING_INTERVAL = 104;
    uint256 public constant INITIAL_EMISSION = 5_000_000e18;

    // ─── External Contracts ──────────────────────────────────────────
    IANTSToken public immutable antsToken;

    // ─── Emission Schedule ───────────────────────────────────────────
    address public emissionController;
    uint256 public immutable effectiveEpoch;
    bool public legacyEpochMintsDisabled;
    mapping(uint256 => uint256) public epochScheduleMinted;

    // ─── Events ──────────────────────────────────────────────────────
    event EmissionControllerSet(address indexed controller);
    event LegacyEpochMintsDisabled();
    event ScheduleEmissionMinted(
        address indexed controller, address indexed recipient, uint256 indexed epoch, uint256 amount
    );

    // ─── Custom Errors ───────────────────────────────────────────────
    error InvalidAddress();
    error InvalidValue();
    error EpochNotFinalized();
    error NotEmissionController();
    error EmissionControllerAlreadySet();
    error EpochEmissionExceeded();
    error LegacyEpochMintingDisabled();

    // ─── Constructor ─────────────────────────────────────────────────
    constructor() Ownable(msg.sender) {
        antsToken = IANTSToken(ANTS_TOKEN);
        uint256 epoch = block.timestamp <= GENESIS ? 0 : (block.timestamp - GENESIS) / EPOCH_DURATION;
        effectiveEpoch = epoch + 1;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        TOKEN AUTH COMPATIBILITY
    // ═══════════════════════════════════════════════════════════════════

    function emissions() external view returns (address) {
        return address(this);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — MINTING
    // ═══════════════════════════════════════════════════════════════════

    function mintScheduleEmission(uint256 epoch, address recipient, uint256 amount) external nonReentrant {
        if (msg.sender != emissionController) revert NotEmissionController();
        if (epoch >= currentEpoch()) revert EpochNotFinalized();
        if (epoch < effectiveEpoch && legacyEpochMintsDisabled) revert LegacyEpochMintingDisabled();
        uint256 minted = epochScheduleMinted[epoch] + amount;
        if (minted > getEpochEmission(epoch)) revert EpochEmissionExceeded();
        epochScheduleMinted[epoch] = minted;
        _mint(recipient, amount);
        emit ScheduleEmissionMinted(msg.sender, recipient, epoch, amount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function currentEpoch() public view returns (uint256) {
        if (block.timestamp <= GENESIS) return 0;
        return (block.timestamp - GENESIS) / EPOCH_DURATION;
    }

    function getEpochEmission(uint256 epoch) public pure returns (uint256) {
        return INITIAL_EMISSION >> (epoch / HALVING_INTERVAL);
    }

    function currentEmissionRate() external view returns (uint256) {
        return getEpochEmission(currentEpoch()) / EPOCH_DURATION;
    }

    function genesis() external pure returns (uint256) {
        return GENESIS;
    }

    function epochDuration() external pure returns (uint256) {
        return EPOCH_DURATION;
    }

    function halvingInterval() external pure returns (uint256) {
        return HALVING_INTERVAL;
    }

    function initialEmission() external pure returns (uint256) {
        return INITIAL_EMISSION;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ONE-TIME WIRING
    // ═══════════════════════════════════════════════════════════════════

    function setEmissionController(address controller) external onlyOwner {
        if (controller == address(0)) revert InvalidAddress();
        if (emissionController != address(0)) revert EmissionControllerAlreadySet();
        emissionController = controller;
        emit EmissionControllerSet(controller);
    }

    function disableLegacyEpochMints() external onlyOwner {
        if (legacyEpochMintsDisabled) revert LegacyEpochMintingDisabled();
        legacyEpochMintsDisabled = true;
        emit LegacyEpochMintsDisabled();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _mint(address to, uint256 amount) internal {
        if (to == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidValue();
        antsToken.mint(to, amount);
    }
}
