// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IAntseedEmissionsAuthority } from "../interfaces/IAntseedEmissionsAuthority.sol";
import { IAntseedEmissionSchedule } from "../interfaces/IAntseedEmissionSchedule.sol";

/**
 * @title AntseedEmissionPrograms
 * @notice Program allocation layer for the immutable emissions schedule.
 *
 *         AntseedEmissionsGate owns the schedule and is the ANTS mint
 *         authority. This contract only assigns shares of each finalized epoch
 *         emission to explicit reward programs and asks the gate to mint within
 *         those per-program budgets.
 *
 *         Important behavior:
 *           - Program shares are separate from the emission schedule.
 *           - Share changes are epoch-versioned, so a program can start at 5%
 *             and later move to 10% while reusing the same reward controller.
 *           - Program shares cannot exceed 100% for any covered epoch.
 *           - A fixed-recipient program, such as team or reserve, can only mint
 *             to that fixed recipient.
 *           - There is no pause or emission kill switch here. Ownership can be
 *             renounced after the desired program configuration is installed.
 */
contract AntseedEmissionPrograms is IAntseedEmissionsAuthority, Ownable2Step, ReentrancyGuard {
    // ─── Constants ───────────────────────────────────────────────────
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // ─── External Contracts ──────────────────────────────────────────
    IAntseedEmissionSchedule public immutable schedule;

    // ─── Program Configuration ───────────────────────────────────────
    struct RewardProgram {
        address controller;
        address fixedRecipient;
        uint16 shareBps;
        uint64 startEpoch;
        uint64 endEpoch;
        bool active;
    }

    struct RewardProgramConfig {
        uint16 shareBps;
        uint64 endEpoch;
        bool active;
        bool exists;
    }

    mapping(bytes32 => RewardProgram) public rewardPrograms;
    bytes32[] public rewardProgramIds;
    mapping(bytes32 => bool) public rewardProgramExists;
    mapping(bytes32 => uint64[]) public rewardProgramConfigStartEpochs;
    mapping(bytes32 => mapping(uint64 => RewardProgramConfig)) private _rewardProgramConfigs;
    mapping(bytes32 => mapping(uint256 => uint256)) public programEpochMinted;

    // ─── Events ──────────────────────────────────────────────────────
    event RewardProgramSet(
        bytes32 indexed programId,
        address indexed controller,
        address indexed fixedRecipient,
        uint16 shareBps,
        uint64 startEpoch,
        uint64 endEpoch,
        bool active
    );
    event ProgramEmissionMinted(
        bytes32 indexed programId, address indexed recipient, uint256 indexed epoch, uint256 amount
    );

    // ─── Custom Errors ───────────────────────────────────────────────
    error InvalidAddress();
    error InvalidValue();
    error InvalidProgram();
    error ProgramShareExceeded();
    error NotProgramController();
    error InvalidProgramRecipient();
    error ProgramBudgetExceeded();

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _schedule) Ownable(msg.sender) {
        if (_schedule == address(0)) revert InvalidAddress();
        schedule = IAntseedEmissionSchedule(_schedule);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — CONFIGURE PROGRAMS
    // ═══════════════════════════════════════════════════════════════════

    function setRewardProgram(
        bytes32 programId,
        address controller,
        address fixedRecipient,
        uint16 shareBps,
        uint64 startEpoch,
        uint64 endEpoch,
        bool active
    ) external onlyOwner {
        if (programId == bytes32(0)) revert InvalidProgram();
        if (controller == address(0)) revert InvalidAddress();
        if (shareBps > BPS_DENOMINATOR) revert InvalidValue();
        if (endEpoch != 0 && endEpoch <= startEpoch) revert InvalidValue();

        if (!rewardProgramExists[programId]) {
            rewardProgramExists[programId] = true;
            rewardProgramIds.push(programId);
        } else {
            RewardProgram memory existingProgram = rewardPrograms[programId];
            if (existingProgram.controller != controller || existingProgram.fixedRecipient != fixedRecipient) {
                revert InvalidValue();
            }
        }

        RewardProgramConfig storage config = _rewardProgramConfigs[programId][startEpoch];
        if (config.exists && startEpoch < schedule.currentEpoch()) revert InvalidValue();
        if (!config.exists) {
            config.exists = true;
            rewardProgramConfigStartEpochs[programId].push(startEpoch);
        }
        config.shareBps = shareBps;
        config.endEpoch = endEpoch;
        config.active = active;

        rewardPrograms[programId] = RewardProgram({
            controller: controller,
            fixedRecipient: fixedRecipient,
            shareBps: shareBps,
            startEpoch: startEpoch,
            endEpoch: endEpoch,
            active: active
        });

        _validateProgramShares(startEpoch, endEpoch);
        emit RewardProgramSet(programId, controller, fixedRecipient, shareBps, startEpoch, endEpoch, active);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — MINT PROGRAM EMISSIONS
    // ═══════════════════════════════════════════════════════════════════

    function mintProgramEmission(bytes32 programId, uint256 epoch, address recipient, uint256 amount)
        external
        nonReentrant
    {
        if (recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidValue();

        RewardProgram memory program = _rewardProgramAtEpoch(programId, epoch);
        if (program.controller == address(0) || !program.active) revert InvalidProgram();
        if (msg.sender != program.controller) revert NotProgramController();
        if (program.fixedRecipient != address(0) && recipient != program.fixedRecipient) {
            revert InvalidProgramRecipient();
        }

        uint256 minted = programEpochMinted[programId][epoch] + amount;
        if (minted > programEpochBudget(programId, epoch)) revert ProgramBudgetExceeded();
        programEpochMinted[programId][epoch] = minted;

        schedule.mintScheduleEmission(epoch, recipient, amount);
        emit ProgramEmissionMinted(programId, recipient, epoch, amount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function rewardProgramCount() external view returns (uint256) {
        return rewardProgramIds.length;
    }

    function rewardProgramConfigCount(bytes32 programId) external view returns (uint256) {
        return rewardProgramConfigStartEpochs[programId].length;
    }

    function programEpochBudget(bytes32 programId, uint256 epoch) public view returns (uint256) {
        RewardProgram memory program = _rewardProgramAtEpoch(programId, epoch);
        if (program.controller == address(0) || !program.active) return 0;
        return (schedule.getEpochEmission(epoch) * program.shareBps) / BPS_DENOMINATOR;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _rewardProgramAtEpoch(bytes32 programId, uint256 epoch) internal view returns (RewardProgram memory) {
        RewardProgram memory program = rewardPrograms[programId];
        uint64[] memory starts = rewardProgramConfigStartEpochs[programId];
        bool found;
        uint64 selectedStart;

        for (uint256 i = 0; i < starts.length; i++) {
            uint64 start = starts[i];
            if (start <= epoch && (!found || start >= selectedStart)) {
                selectedStart = start;
                found = true;
            }
        }
        if (!found) return RewardProgram(address(0), address(0), 0, 0, 0, false);

        RewardProgramConfig memory config = _rewardProgramConfigs[programId][selectedStart];
        if (config.endEpoch != 0 && epoch >= config.endEpoch) {
            return RewardProgram(address(0), address(0), 0, selectedStart, config.endEpoch, false);
        }

        program.shareBps = config.shareBps;
        program.startEpoch = selectedStart;
        program.endEpoch = config.endEpoch;
        program.active = config.active;
        return program;
    }

    function _validateProgramShares(uint64 startEpoch, uint64 endEpoch) internal view {
        _validateProgramShareAtEpoch(startEpoch);

        for (uint256 p = 0; p < rewardProgramIds.length; p++) {
            uint64[] memory starts = rewardProgramConfigStartEpochs[rewardProgramIds[p]];
            for (uint256 i = 0; i < starts.length; i++) {
                uint64 start = starts[i];
                if (start > startEpoch && (endEpoch == 0 || start < endEpoch)) {
                    _validateProgramShareAtEpoch(start);
                }
            }
        }
    }

    function _validateProgramShareAtEpoch(uint256 epoch) internal view {
        uint256 totalShareBps;
        for (uint256 p = 0; p < rewardProgramIds.length; p++) {
            RewardProgram memory program = _rewardProgramAtEpoch(rewardProgramIds[p], epoch);
            if (program.active) totalShareBps += program.shareBps;
        }
        if (totalShareBps > BPS_DENOMINATOR) revert ProgramShareExceeded();
    }
}
