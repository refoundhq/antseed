// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedEmissionsAuthority {
    function programEpochBudget(bytes32 programId, uint256 epoch) external view returns (uint256);
    function mintProgramEmission(bytes32 programId, uint256 epoch, address recipient, uint256 amount) external;
}
