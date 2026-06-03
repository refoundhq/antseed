// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedSellerVettedClaimPolicy } from "../policies/AntseedSellerVettedClaimPolicy.sol";

contract AntseedSellerVettedClaimPolicyTest is Test {
    AntseedSellerVettedClaimPolicy policy;
    address seller = address(0x123);
    address seller2 = address(0x456);

    function setUp() public {
        policy = new AntseedSellerVettedClaimPolicy();
    }

    function test_blocksByDefaultAndZeroSeller() public view {
        assertEq(policy.claimableSellerRewards(seller, 100 ether), 0);
        assertEq(policy.claimableSellerRewards(address(0), 100 ether), 0);
    }

    function test_approvedSellerCanClaimAboveMinimumLockedBalance() public {
        policy.setSellerReview(seller, true, false, 40 ether);
        assertEq(policy.claimableSellerRewards(seller, 100 ether), 60 ether);
        assertEq(policy.claimableSellerRewards(seller, 40 ether), 0);
    }

    function test_frozenSellerCannotClaim() public {
        policy.setSellerReview(seller, true, true, 0);
        assertEq(policy.claimableSellerRewards(seller, 100 ether), 0);
    }

    function test_individualSetters() public {
        policy.setSellerApproval(seller, true);
        policy.setMinimumLockedBalance(seller, 10 ether);
        assertEq(policy.claimableSellerRewards(seller, 100 ether), 90 ether);

        policy.setSellerFrozen(seller, true);
        assertEq(policy.claimableSellerRewards(seller, 100 ether), 0);
    }

    function test_batchSellerReviews() public {
        address[] memory sellers = new address[](2);
        bool[] memory approvals = new bool[](2);
        bool[] memory freezes = new bool[](2);
        uint256[] memory minimums = new uint256[](2);

        sellers[0] = seller;
        sellers[1] = seller2;
        approvals[0] = true;
        approvals[1] = true;
        freezes[0] = false;
        freezes[1] = true;
        minimums[0] = 25 ether;
        minimums[1] = 0;

        policy.setSellerReviews(sellers, approvals, freezes, minimums);

        assertEq(policy.claimableSellerRewards(seller, 100 ether), 75 ether);
        assertEq(policy.claimableSellerRewards(seller2, 100 ether), 0);
    }

    function test_revertsOnInvalidInputs() public {
        vm.expectRevert(AntseedSellerVettedClaimPolicy.InvalidAddress.selector);
        policy.setSellerApproval(address(0), true);

        vm.expectRevert(AntseedSellerVettedClaimPolicy.InvalidAddress.selector);
        policy.setSellerFrozen(address(0), true);

        vm.expectRevert(AntseedSellerVettedClaimPolicy.InvalidAddress.selector);
        policy.setMinimumLockedBalance(address(0), 1);

        vm.expectRevert(AntseedSellerVettedClaimPolicy.InvalidAddress.selector);
        policy.setSellerReview(address(0), true, false, 0);
    }

    function test_batchRevertsOnLengthMismatchAndZeroSeller() public {
        address[] memory sellers = new address[](1);
        bool[] memory approvals = new bool[](0);
        bool[] memory freezes = new bool[](1);
        uint256[] memory minimums = new uint256[](1);

        sellers[0] = seller;
        vm.expectRevert(AntseedSellerVettedClaimPolicy.ArrayLengthMismatch.selector);
        policy.setSellerReviews(sellers, approvals, freezes, minimums);

        approvals = new bool[](1);
        sellers[0] = address(0);
        vm.expectRevert(AntseedSellerVettedClaimPolicy.InvalidAddress.selector);
        policy.setSellerReviews(sellers, approvals, freezes, minimums);
    }
}
