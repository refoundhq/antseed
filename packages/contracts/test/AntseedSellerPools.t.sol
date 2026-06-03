// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../core/ANTSToken.sol";
import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { IAntseedSellerPools } from "../interfaces/IAntseedSellerPools.sol";
import { AntseedBootstrapCommitmentClaimPolicy } from "../policies/AntseedBootstrapCommitmentClaimPolicy.sol";
import { AntseedSellerRewardsPool } from "../rewards/AntseedSellerRewardsPool.sol";
import { AntseedSellerRegistry } from "../sellers/AntseedSellerRegistry.sol";
import { AntseedSellerPools } from "../sellers/AntseedSellerPools.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";

contract AntseedSellerPoolsTest is Test {
    ANTSToken token;
    AntseedRegistry registry;
    MockERC8004Registry identityRegistry;
    AntseedSellerPools pools;
    AntseedSellerRegistry sellerRegistry;
    AntseedSellerRewardsPool sellerRewardsPool;

    address seller = address(0x100);
    address buyerSeller = address(0x200);
    address staker = address(0x300);
    address recipient = address(0x400);
    address newOwner = address(0x500);

    uint256 agentId;
    uint256 otherAgentId;
    uint256 genesis;
    uint256 constant EPOCH_DURATION = 1 weeks;

    function setUp() public {
        vm.warp(1_700_000_000);
        genesis = block.timestamp;
        registry = new AntseedRegistry();
        identityRegistry = new MockERC8004Registry();
        token = new ANTSToken();
        token.setRegistry(address(registry));
        registry.setAntsToken(address(token));
        registry.setEmissions(address(this));
        registry.setIdentityRegistry(address(identityRegistry));

        pools = new AntseedSellerPools(address(registry));
        token.setTransferWhitelist(address(pools), true);
        sellerRegistry = new AntseedSellerRegistry(address(registry), address(pools), address(0));
        registry.setStaking(address(sellerRegistry));
        sellerRewardsPool = new AntseedSellerRewardsPool(address(registry));
        token.setTransferWhitelist(address(sellerRewardsPool), true);
        pools.setSellerRewardsPool(address(sellerRewardsPool));

        vm.prank(seller);
        agentId = identityRegistry.register();
        vm.prank(seller);
        sellerRegistry.registerSeller(agentId);

        vm.prank(buyerSeller);
        otherAgentId = identityRegistry.register();
        vm.prank(buyerSeller);
        sellerRegistry.registerSeller(otherAgentId);

        token.mint(staker, 1_000 ether);
        token.mint(address(pools), 10_000 ether);
    }

    function currentEpoch() external view returns (uint256) {
        if (block.timestamp <= genesis) return 0;
        return (block.timestamp - genesis) / EPOCH_DURATION;
    }

    function test_stakeActivatesNextEpochAndUsesAgentIdWeight() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);

        assertEq(pools.poolWeightAtEpoch(agentId, 0), 0);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 0), 0);
        assertEq(pools.positionWeightAtEpoch(positionId, 0), 0);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.positionWeightAtEpoch(positionId, 1), 400 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 1), 400 ether);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 1), 100 ether);
        assertEq(pools.poolWeightAtEpoch(seller, 1), 400 ether);
    }

    function test_stakeActivationDelayControlsNewStakeStartEpoch() public {
        pools.setPoolConfig(1, 52, 2, 5_000, 500);

        uint256 positionId = _stake(staker, agentId, 100 ether, 4);

        (,, uint256 amount, uint256 weightAmount, uint64 startEpoch, uint64 stakeEndEpoch,,) =
            pools.positions(positionId);
        assertEq(amount, 100 ether);
        assertEq(weightAmount, 100 ether);
        assertEq(startEpoch, 2);
        assertEq(stakeEndEpoch, 6);

        assertEq(pools.positionWeightAtEpoch(positionId, 1), 0);
        assertEq(pools.poolWeightAtEpoch(agentId, 1), 0);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 1), 0);

        assertEq(pools.positionWeightAtEpoch(positionId, 2), 400 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 2), 400 ether);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 2), 100 ether);
    }

    function test_stakeForPullsFromCallerAndGivesPositionToStaker() public {
        token.mint(recipient, 100 ether);
        token.setTransferWhitelist(recipient, true);

        vm.startPrank(recipient);
        token.approve(address(pools), 100 ether);
        uint256 positionId = pools.stakeFor(staker, agentId, 100 ether, 4);
        vm.stopPrank();

        (address owner, uint256 positionAgentId, uint256 amount, uint256 weightAmount, uint64 startEpoch,,,) =
            pools.positions(positionId);
        assertEq(owner, staker);
        assertEq(pools.ownerOf(positionId), staker);
        assertEq(positionAgentId, agentId);
        assertEq(amount, 100 ether);
        assertEq(weightAmount, 100 ether);
        assertEq(startEpoch, 1);
        assertEq(token.balanceOf(recipient), 0);
        assertEq(token.balanceOf(staker), 1_000 ether);
        assertEq(pools.stakerTotalActiveStake(staker), 100 ether);
        assertEq(pools.stakerTotalActiveStake(recipient), 0);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.positionWeightAtEpoch(positionId, 1), 400 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 1), 400 ether);

        vm.prank(recipient);
        vm.expectRevert(IAntseedSellerPools.NotPositionOwner.selector);
        pools.moveStake(positionId, otherAgentId);

        vm.prank(staker);
        pools.moveStake(positionId, otherAgentId);
    }

    function test_lantsReceiptTransfersPositionRights() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);

        vm.prank(staker);
        pools.transferFrom(staker, recipient, positionId);

        assertEq(pools.ownerOf(positionId), recipient);
        (address owner,,,,,,,) = pools.positions(positionId);
        assertEq(owner, recipient);
        assertEq(pools.stakerPositionCount(staker), 0);
        assertEq(pools.stakerPositionCount(recipient), 1);
        assertEq(pools.stakerPositionIdAt(recipient, 0), positionId);
        assertEq(pools.stakerTotalActiveStake(staker), 0);
        assertEq(pools.stakerAgentActiveStake(staker, agentId), 0);
        assertEq(pools.stakerTotalActiveStake(recipient), 100 ether);
        assertEq(pools.stakerAgentActiveStake(recipient, agentId), 100 ether);

        vm.prank(staker);
        vm.expectRevert(IAntseedSellerPools.NotPositionOwner.selector);
        pools.withdrawStake(positionId);

        vm.prank(recipient);
        pools.withdrawStake(positionId);
        assertEq(pools.stakerPositionCount(recipient), 0);
        assertEq(pools.stakerTotalActiveStake(recipient), 0);
    }

    function test_lantsReceiptTransferCarriesMoveRights() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);

        vm.prank(staker);
        pools.transferFrom(staker, recipient, positionId);

        vm.prank(staker);
        vm.expectRevert(IAntseedSellerPools.NotPositionOwner.selector);
        pools.moveStake(positionId, otherAgentId);

        vm.prank(recipient);
        uint256 newPositionId = pools.moveStake(positionId, otherAgentId);

        assertEq(pools.ownerOf(newPositionId), recipient);
        assertEq(pools.stakerPositionCount(recipient), 1);
        assertEq(pools.stakerPositionIdAt(recipient, 0), newPositionId);
        assertEq(pools.stakerTotalActiveStake(recipient), 100 ether);
        assertEq(pools.stakerAgentActiveStake(recipient, agentId), 0);
        assertEq(pools.stakerAgentActiveStake(recipient, otherAgentId), 100 ether);
    }

    function test_sameTermPendingStakeCreatesSeparatePositionsAndIdsArePaged() public {
        uint256 firstPositionId = _stake(staker, agentId, 100 ether, 4);

        token.mint(staker, 50 ether);
        vm.startPrank(staker);
        token.approve(address(pools), 50 ether);
        uint256 secondPositionId = pools.stake(agentId, 50 ether, 4);
        vm.stopPrank();

        assertEq(secondPositionId, firstPositionId + 1);
        assertEq(pools.nextPositionId(), secondPositionId + 1);
        assertEq(pools.stakerPositionCount(staker), 2);
        assertEq(pools.stakerPositionIdAt(staker, 0), firstPositionId);
        assertEq(pools.stakerPositionIdAt(staker, 1), secondPositionId);

        (,, uint256 amount, uint256 weightAmount,,,,) = pools.positions(firstPositionId);
        assertEq(amount, 100 ether);
        assertEq(weightAmount, 100 ether);

        (,, amount, weightAmount,,,,) = pools.positions(secondPositionId);
        assertEq(amount, 50 ether);
        assertEq(weightAmount, 50 ether);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.positionWeightAtEpoch(firstPositionId, 1), 400 ether);
        assertEq(pools.positionWeightAtEpoch(secondPositionId, 1), 200 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 1), 600 ether);

        uint256 thirdPositionId = _stake(staker, otherAgentId, 25 ether, 4);
        assertEq(thirdPositionId, secondPositionId + 1);
        assertEq(pools.stakerPositionCount(staker), 3);

        uint256[] memory firstPage = pools.stakerPositionIds(staker, 0, 2);
        assertEq(firstPage.length, 2);
        assertEq(firstPage[0], firstPositionId);
        assertEq(firstPage[1], secondPositionId);

        uint256[] memory secondPage = pools.stakerPositionIds(staker, 2, 10);
        assertEq(secondPage.length, 1);
        assertEq(secondPage[0], thirdPositionId);

        uint256[] memory emptyPage = pools.stakerPositionIds(staker, 3, 10);
        assertEq(emptyPage.length, 0);
    }

    function test_thousandStakersContributeLargePoolWeightExactly() public {
        uint256 stakerCount = 1_000;
        uint256 stakeAmount = 1_000 ether;

        for (uint256 i = 0; i < stakerCount; i++) {
            address account = address(uint160(0x10000 + i));
            _stake(account, agentId, stakeAmount, 52);
        }

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 1), stakerCount * stakeAmount);
        assertEq(pools.poolWeightAtEpoch(agentId, 1), stakerCount * stakeAmount * 52);
    }

    function test_rewardStakerCanStakeMintedRewardsIntoNewLockedPosition() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);
        pools.setRewardStaker(address(this), true);
        token.mint(address(pools), 400 ether);

        uint256 beforeBalance = token.balanceOf(staker);
        uint256 newPositionId = pools.stakeMintedReward(staker, positionId, 400 ether, 3);

        assertEq(token.balanceOf(staker), beforeBalance);

        (
            address owner,
            uint256 positionAgentId,
            uint256 amount,
            uint256 weightAmount,
            uint64 startEpoch,
            uint64 stakeEndEpoch,
            uint64 closedAtEpoch,
            bool withdrawn
        ) = pools.positions(newPositionId);
        assertEq(owner, staker);
        assertEq(positionAgentId, agentId);
        assertEq(amount, 400 ether);
        uint256 expectedBonusBps = (uint256(500) * 3) / 52;
        uint256 expectedWeightAmount = (uint256(400 ether) * (10_000 + expectedBonusBps)) / 10_000;
        assertEq(weightAmount, expectedWeightAmount);
        assertEq(startEpoch, 1);
        assertEq(stakeEndEpoch, 4);
        assertEq(closedAtEpoch, 0);
        assertFalse(withdrawn);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.positionWeightAtEpoch(newPositionId, 1), expectedWeightAmount * 3);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 1), 100 ether + expectedWeightAmount);
    }

    function test_stakeActivationDelayControlsMintedRewardStartEpoch() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);
        pools.setRewardStaker(address(this), true);
        token.mint(address(pools), 400 ether);
        vm.warp(block.timestamp + EPOCH_DURATION);
        pools.setPoolConfig(1, 52, 2, 5_000, 500);

        uint256 newPositionId = pools.stakeMintedReward(staker, positionId, 400 ether, 4);

        (,, uint256 amount, uint256 weightAmount, uint64 startEpoch, uint64 stakeEndEpoch,,) =
            pools.positions(newPositionId);
        uint256 expectedBonusBps = (uint256(500) * 4) / 52;
        uint256 expectedWeightAmount = (uint256(400 ether) * (10_000 + expectedBonusBps)) / 10_000;
        assertEq(amount, 400 ether);
        assertEq(weightAmount, expectedWeightAmount);
        assertEq(startEpoch, 3);
        assertEq(stakeEndEpoch, 7);

        assertEq(pools.positionWeightAtEpoch(newPositionId, 2), 0);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 2), 100 ether);
        assertEq(pools.positionWeightAtEpoch(newPositionId, 3), expectedWeightAmount * 4);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 3), 100 ether + expectedWeightAmount);
    }

    function test_restakedRewardBonusReachesConfiguredRateAtMaxLock() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);
        pools.setRewardStaker(address(this), true);
        token.mint(address(pools), 400 ether);
        uint256 newPositionId = pools.stakeMintedReward(staker, positionId, 400 ether, 52);

        (,,, uint256 weightAmount,,,,) = pools.positions(newPositionId);
        assertEq(weightAmount, 420 ether);
    }

    function test_anyStakerCanMoveStakeBetweenAgentPools() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);

        vm.prank(staker);
        uint256 newPositionId = pools.moveStake(positionId, otherAgentId);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.positionWeightAtEpoch(newPositionId, 1), 400 ether);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 1), 0);
        assertEq(pools.poolActiveStakeAtEpoch(otherAgentId, 1), 100 ether);
    }

    function test_moveWeightPenaltyReducesMovedPowerButKeepsPrincipal() public {
        pools.setMoveWeightPenalty(2_000);
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);

        vm.prank(staker);
        uint256 newPositionId = pools.moveStake(positionId, otherAgentId);

        (,, uint256 amount, uint256 weightAmount, uint64 startEpoch, uint64 stakeEndEpoch,,) =
            pools.positions(newPositionId);
        assertEq(amount, 100 ether);
        assertEq(weightAmount, 80 ether);
        assertEq(startEpoch, 1);
        assertEq(stakeEndEpoch, 5);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.positionWeightAtEpoch(positionId, 1), 0);
        assertEq(pools.positionWeightAtEpoch(newPositionId, 1), 320 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 1), 0);
        assertEq(pools.poolWeightAtEpoch(otherAgentId, 1), 320 ether);
        assertEq(pools.stakerTotalActiveStake(staker), 100 ether);
        assertEq(pools.stakerAgentActiveStake(staker, agentId), 0);
        assertEq(pools.stakerAgentActiveStake(staker, otherAgentId), 100 ether);
    }

    function test_batchMoveCreatesPortfolioPositions() public {
        uint256 firstPositionId = _stake(staker, agentId, 100 ether, 4);
        uint256 secondPositionId = _stake(staker, agentId, 50 ether, 3);

        uint256[] memory positionIds = new uint256[](2);
        positionIds[0] = firstPositionId;
        positionIds[1] = secondPositionId;

        vm.prank(staker);
        uint256[] memory newPositionIds = pools.moveStakes(positionIds, otherAgentId);

        assertEq(newPositionIds.length, 2);
        assertEq(pools.stakerPositionCount(staker), 2);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 1), 0);
        assertEq(pools.poolActiveStakeAtEpoch(otherAgentId, 1), 150 ether);
        assertEq(pools.positionWeightAtEpoch(newPositionIds[0], 1), 400 ether);
        assertEq(pools.positionWeightAtEpoch(newPositionIds[1], 1), 150 ether);
    }

    function test_sellerCanStakeAndMoveLikeAnyOtherStaker() public {
        uint256 positionId = _stake(seller, agentId, 100 ether, 4);

        vm.prank(seller);
        uint256 newPositionId = pools.moveStake(positionId, otherAgentId);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.positionWeightAtEpoch(newPositionId, 1), 400 ether);
        assertEq(pools.poolActiveStakeAtEpoch(otherAgentId, 1), 100 ether);
    }

    function test_earlyWithdrawClosesAtNextEpochAndSlashes() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);

        vm.warp(block.timestamp + EPOCH_DURATION);
        uint256 expectedSlashBps = pools.earlyExitSlashBps(positionId);
        assertEq(expectedSlashBps, 3_750);

        vm.prank(staker);
        pools.withdrawStake(positionId);

        assertEq(pools.positionWeightAtEpoch(positionId, 1), 400 ether);
        assertEq(pools.positionWeightAtEpoch(positionId, 2), 0);
        assertEq(pools.poolWeightAtEpoch(agentId, 1), 400 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 2), 0);

        uint256 expectedSlash = (100 ether * expectedSlashBps) / 10_000;
        assertEq(token.balanceOf(pools.DEAD_ADDRESS()), expectedSlash);
        assertEq(token.balanceOf(staker), 1_000 ether + (100 ether - expectedSlash));
    }

    function test_batchWithdrawAggregatesTransfersAndSlashes() public {
        uint256 firstPositionId = _stake(staker, agentId, 100 ether, 4);
        uint256 secondPositionId = _stake(staker, otherAgentId, 50 ether, 3);

        vm.warp(block.timestamp + EPOCH_DURATION);
        uint256 firstSlashBps = pools.earlyExitSlashBps(firstPositionId);
        uint256 secondSlashBps = pools.earlyExitSlashBps(secondPositionId);

        uint256[] memory positionIds = new uint256[](2);
        positionIds[0] = firstPositionId;
        positionIds[1] = secondPositionId;

        vm.prank(staker);
        (uint256 returnedAmount, uint256 slashedAmount) = pools.withdrawStakes(positionIds);

        uint256 expectedSlash = ((100 ether * firstSlashBps) / 10_000) + ((50 ether * secondSlashBps) / 10_000);
        assertEq(slashedAmount, expectedSlash);
        assertEq(returnedAmount, 150 ether - expectedSlash);
        assertEq(token.balanceOf(pools.DEAD_ADDRESS()), expectedSlash);
        assertEq(token.balanceOf(staker), 1_000 ether + returnedAmount);
        assertEq(pools.positionWeightAtEpoch(firstPositionId, 2), 0);
        assertEq(pools.positionWeightAtEpoch(secondPositionId, 2), 0);
        assertEq(pools.stakerPositionCount(staker), 0);
    }

    function test_agentSaleMovesSellerResolutionButKeepsPoolStake() public {
        _stake(staker, agentId, 100 ether, 4);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(sellerRegistry.getStake(seller), 100 ether);

        vm.prank(seller);
        identityRegistry.transferAgent(agentId, newOwner);
        vm.prank(newOwner);
        sellerRegistry.registerSeller(agentId);

        assertEq(pools.agentIdForSeller(seller), 0);
        assertEq(pools.agentIdForSeller(newOwner), agentId);
        assertEq(sellerRegistry.getStake(seller), 0);
        assertEq(sellerRegistry.getStake(newOwner), 100 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 1), 400 ether);
    }

    function test_apyCapBurnsExcessReward() public {
        pools.setApyCap(1_000, 52);
        uint256 positionId = _stake(seller, agentId, 1_000 ether, 4);

        vm.warp(block.timestamp + EPOCH_DURATION);
        uint256 expectedCap = (uint256(1_000 ether) * 1_000) / (10_000 * 52);

        assertEq(pools.positionRewardCapAtEpoch(positionId, 1), expectedCap);
    }

    function test_bootstrapCommitmentUsesAgentPoolAndDiscountedWeight() public {
        uint256 lockedRewards = 2_000_000 ether;
        sellerRewardsPool.recordLockedReward(seller, lockedRewards);
        token.mint(address(sellerRewardsPool), lockedRewards);
        sellerRewardsPool.setSellerClaimPolicy(address(new AntseedBootstrapCommitmentClaimPolicy(address(pools))));

        vm.prank(seller);
        pools.activateBootstrapCommitment(agentId);

        (uint256 commitmentAgentId, uint256 amount, uint256 matchedAmount, uint64 startEpoch, uint64 stakeEndEpoch) =
            pools.bootstrapCommitments(seller);
        assertEq(commitmentAgentId, agentId);
        assertEq(amount, 1_000_000 ether);
        assertEq(matchedAmount, 0);
        assertEq(startEpoch, 1);
        assertEq(stakeEndEpoch, 53);
        assertEq(pools.sellerBootstrapCommitment(seller), 1_000_000 ether);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 1), 500_000 ether);
        assertEq(pools.bootstrapWeightAtEpoch(agentId, 1), 26_000_000 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 1), 26_000_000 ether);

        assertEq(pools.bootstrapRewardCapAtEpoch(seller, 1), type(uint256).max);
    }

    function test_bootstrapCommitmentUnavailableAfterTransfersEnabled() public {
        sellerRewardsPool.recordLockedReward(seller, 1_000_000 ether);
        token.enableTransfers();

        vm.prank(seller);
        vm.expectRevert(IAntseedSellerPools.BootstrapClosed.selector);
        pools.activateBootstrapCommitment(agentId);
    }

    function test_matchingBootstrapReplacesDiscountedWeightWithRealTwelveMonthStake() public {
        sellerRewardsPool.recordLockedReward(seller, 1_000_000 ether);
        token.mint(address(sellerRewardsPool), 1_000_000 ether);

        vm.prank(seller);
        pools.activateBootstrapCommitment(agentId);

        vm.warp(block.timestamp + EPOCH_DURATION);
        token.mint(seller, 400_000 ether);
        token.enableTransfers();
        vm.startPrank(seller);
        token.approve(address(pools), 400_000 ether);
        uint256 realPositionId = pools.matchBootstrapCommitment(400_000 ether);
        vm.stopPrank();

        assertEq(pools.sellerBootstrapMatchedCommitment(seller), 400_000 ether);
        vm.warp(block.timestamp + EPOCH_DURATION);

        assertEq(pools.bootstrapWeightAtEpoch(agentId, 2), 15_300_000 ether);
        assertEq(pools.positionWeightAtEpoch(realPositionId, 2), 20_800_000 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 2), 36_100_000 ether);
    }

    function test_matchingBootstrapUnavailableBeforeTransfersEnabled() public {
        sellerRewardsPool.recordLockedReward(seller, 1_000_000 ether);
        token.mint(address(sellerRewardsPool), 1_000_000 ether);

        vm.prank(seller);
        pools.activateBootstrapCommitment(agentId);

        token.mint(seller, 400_000 ether);
        token.setTransferWhitelist(seller, true);
        vm.startPrank(seller);
        token.approve(address(pools), 400_000 ether);
        vm.expectRevert(IAntseedSellerPools.BootstrapClosed.selector);
        pools.matchBootstrapCommitment(400_000 ether);
        vm.stopPrank();
    }

    function test_stakeActivationDelayControlsBootstrapAndMatchedStakeStartEpoch() public {
        pools.setPoolConfig(1, 52, 2, 5_000, 500);
        sellerRewardsPool.recordLockedReward(seller, 2_000_000 ether);
        token.mint(address(sellerRewardsPool), 2_000_000 ether);
        sellerRewardsPool.setSellerClaimPolicy(address(new AntseedBootstrapCommitmentClaimPolicy(address(pools))));

        vm.prank(seller);
        pools.activateBootstrapCommitment(agentId);

        (uint256 commitmentAgentId, uint256 amount, uint256 matchedAmount, uint64 startEpoch, uint64 stakeEndEpoch) =
            pools.bootstrapCommitments(seller);
        assertEq(commitmentAgentId, agentId);
        assertEq(amount, 1_000_000 ether);
        assertEq(matchedAmount, 0);
        assertEq(startEpoch, 2);
        assertEq(stakeEndEpoch, 54);
        assertEq(pools.bootstrapWeightAtEpoch(agentId, 1), 0);
        assertEq(pools.poolWeightAtEpoch(agentId, 1), 0);
        assertEq(pools.bootstrapWeightAtEpoch(agentId, 2), 26_000_000 ether);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 2), 500_000 ether);

        vm.warp(block.timestamp + 2 * EPOCH_DURATION);
        token.mint(seller, 400_000 ether);
        token.enableTransfers();
        vm.startPrank(seller);
        token.approve(address(pools), 400_000 ether);
        uint256 realPositionId = pools.matchBootstrapCommitment(400_000 ether);
        vm.stopPrank();

        assertEq(pools.sellerBootstrapMatchedCommitment(seller), 400_000 ether);
        (,, uint256 realAmount, uint256 realWeightAmount, uint64 realStartEpoch, uint64 realStakeEndEpoch,,) =
            pools.positions(realPositionId);
        assertEq(realAmount, 400_000 ether);
        assertEq(realWeightAmount, 400_000 ether);
        assertEq(realStartEpoch, 4);
        assertEq(realStakeEndEpoch, 56);

        assertEq(pools.positionWeightAtEpoch(realPositionId, 3), 0);
        assertEq(pools.bootstrapWeightAtEpoch(agentId, 4), 15_000_000 ether);
        assertEq(pools.positionWeightAtEpoch(realPositionId, 4), 20_800_000 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 4), 35_800_000 ether);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 4), 700_000 ether);
    }

    function test_validationAndAdmin() public {
        vm.startPrank(staker);
        token.approve(address(pools), 1 ether);
        vm.expectRevert(IAntseedSellerPools.InvalidValue.selector);
        pools.stake(0, 1 ether, 1);
        vm.expectRevert(IAntseedSellerPools.InvalidValue.selector);
        pools.stake(agentId, 0, 1);
        vm.expectRevert(IAntseedSellerPools.StakeDurationOutOfBounds.selector);
        pools.stake(agentId, 1 ether, 0);
        vm.expectRevert(IAntseedSellerPools.InvalidAddress.selector);
        pools.stakeFor(address(0), agentId, 1 ether, 1);
        vm.stopPrank();

        vm.expectRevert(IAntseedSellerPools.InvalidAddress.selector);
        pools.setRewardStaker(address(0), true);
        pools.setRewardStaker(recipient, true);
        assertTrue(pools.rewardStakers(recipient));

        vm.expectRevert(IAntseedSellerPools.InvalidValue.selector);
        pools.setRestakedRewardWeightBonus(2_001);
        pools.setRestakedRewardWeightBonus(1_000);
        assertEq(pools.restakedRewardWeightBonusBps(), 1_000);

        vm.expectRevert(IAntseedSellerPools.InvalidValue.selector);
        pools.setMoveWeightPenalty(10_001);
        pools.setMoveWeightPenalty(2_000);
        assertEq(pools.moveWeightPenaltyBps(), 2_000);
    }

    function test_stakeActivationDelayConfigValidation() public {
        vm.expectRevert(IAntseedSellerPools.InvalidValue.selector);
        pools.setPoolConfig(1, 52, 0, 5_000, 500);

        vm.expectRevert(IAntseedSellerPools.InvalidValue.selector);
        pools.setPoolConfig(1, 52, 53, 5_000, 500);

        pools.setPoolConfig(1, 52, 2, 5_000, 500);
        assertEq(pools.stakeActivationDelay(), 2);
    }

    function _stake(address staker_, uint256 agentId_, uint256 amount, uint256 stakeEpochs)
        internal
        returns (uint256 positionId)
    {
        token.mint(staker_, amount);
        token.setTransferWhitelist(staker_, true);
        vm.startPrank(staker_);
        token.approve(address(pools), amount);
        positionId = pools.stake(agentId_, amount, stakeEpochs);
        vm.stopPrank();
    }

    function _epochList(uint256 epoch) internal pure returns (uint256[] memory epochs) {
        epochs = new uint256[](1);
        epochs[0] = epoch;
    }
}
