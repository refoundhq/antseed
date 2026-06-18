// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedEmissionsGate {
    struct Minter {
        address controller;
        uint32 shareBps;
        bool editable;
    }

    function currentEpoch() external view returns (uint256);
    function getEpochEmission(uint256 epoch) external view returns (uint256);
    function minters(bytes32 minterId) external view returns (address, uint32, bool);
    function minterConfig(bytes32 minterId) external view returns (Minter memory);
    function minterEpochBudget(bytes32 minterId, uint256 epoch) external view returns (uint256);
    function controllerEpochBudget(address controller, uint256 epoch) external view returns (uint256);
    function claim(uint256 epoch, address recipient, uint256 amount) external;
}
