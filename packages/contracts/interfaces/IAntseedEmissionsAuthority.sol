// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedEmissionSchedule } from "./IAntseedEmissionSchedule.sol";

interface IAntseedEmissionsAuthority {
    function schedule() external view returns (IAntseedEmissionSchedule);
    function programEpochBudget(bytes32 programId, uint256 epoch) external view returns (uint256);
    function mintProgramEmission(bytes32 programId, uint256 epoch, address recipient, uint256 amount) external;
}
