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
    function minterId(address controller) external pure returns (bytes32);
    function minters(bytes32 minterId) external view returns (address, uint32, bool);
    function minterConfig(address controller) external view returns (Minter memory);
    function minterEpochBudget(address controller, uint256 epoch) external view returns (uint256);
    function mint(uint256 epoch, address recipient, uint256 amount) external;
    function claim(uint256 epoch) external;
}
