// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedSellerRewardsPool {
    function lockedRewards(address seller) external view returns (uint256);
    function recordLockedReward(address seller, uint256 amount) external;
}
