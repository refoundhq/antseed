// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedEmissionSchedule {
    function currentEpoch() external view returns (uint256);
    function getEpochEmission(uint256 epoch) external view returns (uint256);
    function mintScheduleEmission(uint256 epoch, address recipient, uint256 amount) external;
}
