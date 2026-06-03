// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IANTSToken {
    function mint(address to, uint256 amount) external;
    function transfersEnabled() external view returns (bool);
}
