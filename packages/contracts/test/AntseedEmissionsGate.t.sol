// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../core/ANTSToken.sol";
import { AntseedEmissions } from "../legacy/AntseedEmissions.sol";
import { AntseedBuyerUsageRewards } from "../emissions/AntseedBuyerUsageRewards.sol";
import { AntseedEmissionPrograms } from "../emissions/AntseedEmissionPrograms.sol";
import { AntseedEmissionsGate } from "../emissions/AntseedEmissionsGate.sol";
import { AntseedEmissionsV2 } from "../legacy/AntseedEmissionsV2.sol";
import { AntseedSellerOperatorUsageRewards } from "../emissions/AntseedSellerOperatorUsageRewards.sol";
import { AntseedSellerPools } from "../sellers/AntseedSellerPools.sol";
import { AntseedSellerUsageRewards } from "../emissions/AntseedSellerUsageRewards.sol";
import { AntseedUsageAccounting } from "../emissions/AntseedUsageAccounting.sol";
import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";
import { IAntseedPointsPolicy } from "../interfaces/IAntseedPointsPolicy.sol";
import { AntseedSellerRewardsPool } from "../rewards/AntseedSellerRewardsPool.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";

contract MockDepositsForEmissionsGate {
    mapping(address => address) private _operators;

    function setOperator(address buyer, address operator) external {
        _operators[buyer] = operator;
    }

    function getOperator(address buyer) external view returns (address) {
        return _operators[buyer];
    }
}

contract MockUsagePointsPolicy is IAntseedPointsPolicy {
    mapping(address => uint256) public sellerWeightBps;
    uint256 public buyerWeightBps = 10_000;

    function setSellerWeightBps(address seller, uint256 weightBps) external {
        sellerWeightBps[seller] = weightBps;
    }

    function setBuyerWeightBps(uint256 weightBps) external {
        buyerWeightBps = weightBps;
    }

    function points(bytes32, address, address seller, uint256 rawPoints)
        external
        view
        returns (uint256 sellerPoints, uint256 buyerPoints)
    {
        sellerPoints = (rawPoints * sellerWeightBps[seller]) / 10_000;
        buyerPoints = (rawPoints * buyerWeightBps) / 10_000;
    }
}

contract MockSellerAgentLookup {
    mapping(address => uint256) public agentIdBySeller;

    function setAgent(address seller, uint256 agentId) external {
        agentIdBySeller[seller] = agentId;
    }

    function getAgentId(address seller) external view returns (uint256) {
        return agentIdBySeller[seller];
    }
}

contract AntseedEmissionsGateTest is Test {
    struct StressRun {
        uint256 firstPositionId;
        uint256 washPositionId;
        uint256 expectedTotalWeightedPoints;
        uint256 firstWeightedPoints;
        uint256 washWeightedPoints;
        uint256 firstClaimable;
        uint256 washClaimable;
    }

    ANTSToken token;
    AntseedRegistry realRegistry;
    MockDepositsForEmissionsGate deposits;
    AntseedEmissions legacyV1;
    AntseedEmissionsV2 legacyV2;
    AntseedEmissionsGate gate;
    AntseedEmissionPrograms programs;
    AntseedSellerPools sellerPools;
    AntseedSellerOperatorUsageRewards sellerOperatorUsageRewards;
    AntseedSellerUsageRewards sellerUsageRewards;
    AntseedBuyerUsageRewards buyerUsageRewards;
    AntseedUsageAccounting usageAccounting;
    MockSellerAgentLookup sellerAgentLookup;
    MockERC8004Registry identityRegistry;

    address seller = address(0x10);
    address buyer = address(0x20);
    address operator = address(0x30);
    address otherSeller = address(0x40);
    address staker = address(0x50);
    address claimController = address(0x60);
    address reserveDest = address(0x70);
    address teamWallet = address(0x80);

    address constant KNOWN_ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    uint256 constant GATE_GENESIS = 1_775_728_461;
    uint256 constant GATE_EPOCH_DURATION = 7 days;
    uint256 constant INITIAL_EMISSION = 1_000 ether;
    uint256 constant EPOCH_DURATION = 1 weeks;

    function setUp() public {
        vm.warp(1_700_000_000);

        deployCodeTo("ANTSToken.sol:ANTSToken", KNOWN_ANTS_TOKEN);
        token = ANTSToken(KNOWN_ANTS_TOKEN);
        realRegistry = new AntseedRegistry();
        deposits = new MockDepositsForEmissionsGate();

        realRegistry.setChannels(address(this));
        realRegistry.setDeposits(address(deposits));
        realRegistry.setAntsToken(address(token));
        realRegistry.setProtocolReserve(reserveDest);
        realRegistry.setTeamWallet(teamWallet);
        identityRegistry = new MockERC8004Registry();
        realRegistry.setIdentityRegistry(address(identityRegistry));
        sellerAgentLookup = new MockSellerAgentLookup();
        realRegistry.setStaking(address(sellerAgentLookup));
        realRegistry.setEmissions(address(this));
        token.setRegistry(address(realRegistry));
        token.enableTransfers();
        token.mint(staker, 1_000 ether);

        legacyV1 = new AntseedEmissions(address(realRegistry), INITIAL_EMISSION, EPOCH_DURATION);
        realRegistry.setEmissions(address(legacyV1));
        legacyV1.accrueSellerPoints(seller, 50);
        legacyV1.accrueBuyerPoints(buyer, 50);

        vm.warp(legacyV1.genesis() + EPOCH_DURATION * 2 + 1);
        AntseedSellerRewardsPool v2RewardsPool = new AntseedSellerRewardsPool(address(realRegistry));
        legacyV2 = new AntseedEmissionsV2(address(realRegistry), address(legacyV1), address(v2RewardsPool));
        realRegistry.setEmissions(address(legacyV2));

        deposits.setOperator(buyer, operator);
        legacyV2.accrueSellerPoints(seller, 100);
        legacyV2.accrueBuyerPoints(buyer, 100);
    }

    function _deployGate(uint256 warpEpoch) internal {
        vm.warp(GATE_GENESIS + GATE_EPOCH_DURATION * (warpEpoch - 1) + 1);
        gate = new AntseedEmissionsGate();
        _warpGateEpoch(warpEpoch);
        programs = new AntseedEmissionPrograms(address(gate));
        gate.setEmissionController(address(programs));
        token.setRegistry(address(gate));

        usageAccounting = new AntseedUsageAccounting(address(0), address(this), address(gate));
        realRegistry.setEmissions(address(usageAccounting));
    }

    function _warpGateEpoch(uint256 epoch) internal {
        vm.warp(gate.genesis() + gate.epochDuration() * epoch + 1);
    }

    function _programBudget(uint16 shareBps, uint256 epoch) internal view returns (uint256) {
        return (gate.getEpochEmission(epoch) * shareBps) / 10_000;
    }

    function _epochList(uint256 epoch) internal pure returns (uint256[] memory epochs) {
        epochs = new uint256[](1);
        epochs[0] = epoch;
    }

    function _agentId(address seller_) internal pure returns (uint256) {
        return uint160(seller_);
    }

    function _createSellerPool(AntseedSellerPools pools_, address seller_, uint16, bytes32)
        internal
        returns (address poolSeller)
    {
        deal(address(token), seller_, token.balanceOf(seller_) + 1 ether);
        _stakeAgentPool(pools_, seller_, 1 ether, 4);
        poolSeller = seller_;
    }

    function _stakeAgentPool(AntseedSellerPools pools_, address seller_, uint256 amount, uint256 stakeEpochs)
        internal
        returns (uint256 positionId)
    {
        sellerAgentLookup.setAgent(seller_, _agentId(seller_));
        identityRegistry.setOwner(_agentId(seller_), seller_);
        vm.startPrank(seller_);
        token.approve(address(pools_), amount);
        positionId = pools_.stake(_agentId(seller_), amount, stakeEpochs);
        vm.stopPrank();
    }

    function test_legacyEpochProgramCanMintBeforeLegacyEpochsAreDisabled() public {
        bytes32 legacyProgramId = keccak256("legacy-v2-claims");
        _deployGate(4);

        programs.setRewardProgram(legacyProgramId, address(this), address(0), 10_000, 0, 4, true);
        programs.mintProgramEmission(legacyProgramId, 2, buyer, 10 ether);

        assertEq(token.balanceOf(buyer), 10 ether);
        assertEq(gate.epochScheduleMinted(2), 10 ether);
    }

    function test_disableLegacyEpochMintsBlocksEpochsBeforeEffectiveEpochOnly() public {
        bytes32 legacyProgramId = keccak256("legacy-v2-claims");
        bytes32 currentProgramId = keccak256("current-program");
        _deployGate(5);

        programs.setRewardProgram(legacyProgramId, address(this), address(0), 10_000, 0, 4, true);
        programs.setRewardProgram(currentProgramId, address(this), address(0), 10_000, 5, 0, true);

        gate.disableLegacyEpochMints();
        vm.expectRevert(AntseedEmissionsGate.LegacyEpochMintingDisabled.selector);
        programs.mintProgramEmission(legacyProgramId, 2, buyer, 1 ether);

        _warpGateEpoch(6);
        programs.mintProgramEmission(currentProgramId, 5, buyer, 1 ether);
        assertEq(token.balanceOf(buyer), 1 ether);
    }

    function test_legacyV2HasNoPendingEmissionsForPostCutoverUsageEpoch() public {
        _deployGate(4);

        _warpGateEpoch(5);
        AntseedUsageAccounting(realRegistry.emissions()).accrueSellerPoints(seller, 1_000);
        AntseedUsageAccounting(realRegistry.emissions()).accrueBuyerPoints(buyer, 1_000);

        assertEq(usageAccounting.totalSellerPointsByEpoch(5), 0);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), 0);
        assertEq(legacyV2.epochTotalSellerPoints(5), 0);
        assertEq(legacyV2.epochTotalBuyerPoints(5), 0);
        assertEq(legacyV2.userSellerPoints(seller, 5), 0);
        assertEq(legacyV2.userBuyerPoints(buyer, 5), 0);

        (uint256 sellerPendingSeller, uint256 sellerPendingBuyer) = legacyV2.pendingEmissions(seller, _epochList(5));
        (uint256 buyerPendingSeller, uint256 buyerPendingBuyer) = legacyV2.pendingEmissions(buyer, _epochList(5));
        assertEq(sellerPendingSeller, 0);
        assertEq(sellerPendingBuyer, 0);
        assertEq(buyerPendingSeller, 0);
        assertEq(buyerPendingBuyer, 0);
    }

    function test_sellerUsageRewardsUsePostMigrationProgramAndPools() public {
        bytes32 programId = keccak256("recognized-seller-usage-v1");
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerUsageRewards =
            new AntseedSellerUsageRewards(address(programs), address(sellerPools), address(usageAccounting), programId);
        sellerPools.setRewardStaker(address(sellerUsageRewards), true);
        programs.setRewardProgram(programId, address(sellerUsageRewards), address(0), 7_000, 4, 0, true);

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        vm.startPrank(staker);
        token.approve(address(sellerPools), 100 ether);
        uint256 positionId = sellerPools.stake(_agentId(poolSeller), 100 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(6);
        uint256 expectedStakerClaim = (_programBudget(7_000, 5) * 400 ether) / 404 ether;
        (uint256 grossReward, uint256 claimableReward, uint256 burnedReward) =
            sellerUsageRewards.pendingStakerReward(positionId, 5);
        assertEq(grossReward, expectedStakerClaim);
        assertEq(claimableReward, expectedStakerClaim);
        assertEq(burnedReward, 0);

        vm.prank(staker);
        sellerUsageRewards.claimStakerRewards(positionId, _epochList(5), staker);
        assertEq(token.balanceOf(staker), 900 ether + expectedStakerClaim);
    }

    function test_lantsTransferCarriesUnclaimedStakerRewards() public {
        bytes32 programId = keccak256("recognized-seller-usage-v1");
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerUsageRewards =
            new AntseedSellerUsageRewards(address(programs), address(sellerPools), address(usageAccounting), programId);
        programs.setRewardProgram(programId, address(sellerUsageRewards), address(0), 7_000, 4, 0, true);

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        vm.startPrank(staker);
        token.approve(address(sellerPools), 100 ether);
        uint256 positionId = sellerPools.stake(_agentId(poolSeller), 100 ether, 4);
        sellerPools.transferFrom(staker, operator, positionId);
        vm.stopPrank();

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(6);
        uint256 expectedStakerClaim = (_programBudget(7_000, 5) * 400 ether) / 404 ether;

        vm.prank(staker);
        vm.expectRevert(AntseedSellerUsageRewards.NotPositionOwner.selector);
        sellerUsageRewards.claimStakerRewards(positionId, _epochList(5), staker);

        vm.prank(operator);
        sellerUsageRewards.claimStakerRewards(positionId, _epochList(5), operator);
        assertEq(token.balanceOf(operator), expectedStakerClaim);
    }

    function test_burnedLantsPositionKeepsPastRewardClaimRightsAfterWithdraw() public {
        bytes32 programId = keccak256("recognized-seller-usage-v1");
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerUsageRewards =
            new AntseedSellerUsageRewards(address(programs), address(sellerPools), address(usageAccounting), programId);
        programs.setRewardProgram(programId, address(sellerUsageRewards), address(0), 7_000, 4, 0, true);

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        vm.startPrank(staker);
        token.approve(address(sellerPools), 100 ether);
        uint256 positionId = sellerPools.stake(_agentId(poolSeller), 100 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(6);
        uint256 expectedStakerClaim = (_programBudget(7_000, 5) * 400 ether) / 404 ether;

        vm.prank(staker);
        sellerPools.withdrawStake(positionId);

        vm.prank(staker);
        sellerUsageRewards.claimStakerRewards(positionId, _epochList(5), staker);
        assertEq(token.balanceOf(staker), 900 ether + 75 ether + expectedStakerClaim);
    }

    function test_burnedLantsPositionKeepsPastRewardClaimRightsAfterMove() public {
        bytes32 programId = keccak256("recognized-seller-usage-v1");
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerUsageRewards =
            new AntseedSellerUsageRewards(address(programs), address(sellerPools), address(usageAccounting), programId);
        programs.setRewardProgram(programId, address(sellerUsageRewards), address(0), 7_000, 4, 0, true);

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        sellerAgentLookup.setAgent(otherSeller, _agentId(otherSeller));
        identityRegistry.setOwner(_agentId(otherSeller), otherSeller);

        vm.startPrank(staker);
        token.approve(address(sellerPools), 100 ether);
        uint256 positionId = sellerPools.stake(_agentId(poolSeller), 100 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(6);
        uint256 expectedStakerClaim = (_programBudget(7_000, 5) * 400 ether) / 404 ether;

        vm.prank(staker);
        sellerPools.moveStake(positionId, _agentId(otherSeller));

        vm.prank(staker);
        sellerUsageRewards.claimStakerRewards(positionId, _epochList(5), staker);
        assertEq(token.balanceOf(staker), 900 ether + expectedStakerClaim);
    }

    function test_sellerUsageProgramDoesNotClaimWithoutWeightedPoints() public {
        bytes32 programId = keccak256("recognized-seller-usage-v1");
        _deployGate(5);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerUsageRewards =
            new AntseedSellerUsageRewards(address(programs), address(sellerPools), address(usageAccounting), programId);
        programs.setRewardProgram(programId, address(sellerUsageRewards), address(0), 7_000, 4, 0, true);

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        uint256 positionId = sellerPools.nextPositionId() - 1;

        vm.expectRevert(AntseedSellerUsageRewards.NothingToClaim.selector);
        vm.prank(seller);
        sellerUsageRewards.claimStakerRewards(positionId, _epochList(4), seller);
    }

    function test_gateFixedScheduleAndAdminValidation() public {
        _deployGate(4);
        assertEq(address(gate.antsToken()), KNOWN_ANTS_TOKEN);
        assertEq(gate.genesis(), 1_775_728_461);
        assertEq(gate.epochDuration(), 7 days);
        assertEq(gate.halvingInterval(), 104);
        assertEq(gate.initialEmission(), 5_000_000 ether);
        assertEq(gate.effectiveEpoch(), 4);
        assertEq(gate.currentEmissionRate(), gate.initialEmission() / gate.epochDuration());
        assertEq(programs.rewardProgramCount(), 0);

        vm.expectRevert(AntseedEmissionsGate.InvalidAddress.selector);
        gate.setEmissionController(address(0));

        vm.expectRevert(AntseedEmissionsGate.EmissionControllerAlreadySet.selector);
        gate.setEmissionController(address(this));

        vm.expectRevert(AntseedEmissionPrograms.InvalidAddress.selector);
        new AntseedEmissionPrograms(address(0));

        bytes32 programId = keccak256("program");
        vm.expectRevert(AntseedEmissionPrograms.InvalidProgram.selector);
        programs.setRewardProgram(bytes32(0), address(this), address(0), 1, 0, 0, true);

        vm.expectRevert(AntseedEmissionPrograms.InvalidAddress.selector);
        programs.setRewardProgram(programId, address(0), address(0), 1, 0, 0, true);

        vm.expectRevert(AntseedEmissionPrograms.InvalidValue.selector);
        programs.setRewardProgram(programId, address(this), address(0), 10_001, 0, 0, true);

        vm.expectRevert(AntseedEmissionPrograms.InvalidValue.selector);
        programs.setRewardProgram(programId, address(this), address(0), 1, 2, 2, true);

        programs.setRewardProgram(programId, address(this), address(0), 1_000, 4, 0, true);
        assertEq(programs.rewardProgramCount(), 1);
        programs.setRewardProgram(programId, address(this), address(0), 1_000, 4, 0, true);
        assertEq(programs.rewardProgramCount(), 1);

        vm.expectRevert(AntseedEmissionPrograms.InvalidValue.selector);
        programs.setRewardProgram(programId, address(this), address(0x1234), 1_000, 4, 0, true);

        bytes32 fixedProgramId = keccak256("fixed-program");
        programs.setRewardProgram(fixedProgramId, address(this), address(0x1234), 1_000, 4, 0, true);
        (, address fixedRecipient,,,,) = programs.rewardPrograms(fixedProgramId);
        assertEq(fixedRecipient, address(0x1234));
    }

    function test_gateAndProgramsCanRenounceEmissionAdminControl() public {
        bytes32 programId = keccak256("program");
        _deployGate(4);
        programs.setRewardProgram(programId, address(this), address(0), 1_000, 4, 0, true);
        assertEq(programs.programEpochBudget(programId, 4), _programBudget(1_000, 4));

        gate.renounceOwnership();
        programs.renounceOwnership();
        assertEq(gate.owner(), address(0));
        assertEq(programs.owner(), address(0));
        assertEq(programs.programEpochBudget(programId, 4), _programBudget(1_000, 4));
        assertEq(gate.currentEmissionRate(), gate.initialEmission() / gate.epochDuration());

        vm.expectRevert();
        programs.setRewardProgram(programId, address(this), address(0), 500, 5, 0, true);

        vm.expectRevert();
        gate.setEmissionController(address(this));

        _warpGateEpoch(5);
        programs.mintProgramEmission(programId, 4, address(this), 1 ether);
        assertEq(token.balanceOf(address(this)), 1 ether);
    }

    function test_gatePairsLegacySellerBuyerAccruals() public {
        _deployGate(5);

        usageAccounting.accrueSellerPoints(seller, 123);
        (address pendingSeller, uint256 pendingDelta) = usageAccounting.pendingSellerAccrual();
        assertEq(pendingSeller, seller);
        assertEq(pendingDelta, 123);

        usageAccounting.accrueBuyerPoints(buyer, 123);
        (pendingSeller, pendingDelta) = usageAccounting.pendingSellerAccrual();
        assertEq(pendingSeller, address(0));
        assertEq(pendingDelta, 0);

        assertEq(usageAccounting.totalSellerPointsByEpoch(5), 0);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), 0);
        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 0);
        assertEq(usageAccounting.buyerPointsByEpoch(5, buyer), 0);
    }

    function test_gateAccrualValidationAndFutureChannelIdPath() public {
        _deployGate(5);

        vm.prank(seller);
        vm.expectRevert(IAntseedUsageAccounting.NotUsageRecorder.selector);
        usageAccounting.accrueSellerPoints(seller, 1);

        vm.expectRevert(IAntseedUsageAccounting.InvalidAddress.selector);
        usageAccounting.accrueSellerPoints(address(0), 1);

        vm.expectRevert(IAntseedUsageAccounting.InvalidValue.selector);
        usageAccounting.accrueSellerPoints(seller, 0);

        usageAccounting.accrueSellerPoints(seller, 10);
        vm.expectRevert(IAntseedUsageAccounting.PendingSellerAccrualExists.selector);
        usageAccounting.accrueSellerPoints(seller, 10);

        vm.expectRevert(IAntseedUsageAccounting.AccrualDeltaMismatch.selector);
        usageAccounting.accrueBuyerPoints(buyer, 9);

        usageAccounting.clearPendingSellerAccrual();
        vm.expectRevert(IAntseedUsageAccounting.NoPendingSellerAccrual.selector);
        usageAccounting.accrueBuyerPoints(buyer, 10);

        usageAccounting.accruePoints(bytes32(0), buyer, seller, 1);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), 0);
        assertEq(usageAccounting.totalSellerPointsByEpoch(5), 0);

        bytes32 channelId = keccak256("ignored-channel-id");
        usageAccounting.accruePoints(channelId, buyer, seller, 77);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), 0);
        assertEq(usageAccounting.totalSellerPointsByEpoch(5), 0);
    }

    function test_usageAccountingTracksBuyerAgentRatiosByEpoch() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));
        _createSellerPool(sellerPools, seller, 5_000, keccak256("seller"));
        _createSellerPool(sellerPools, otherSeller, 5_000, keccak256("other-seller"));

        address secondBuyer = address(0x21);
        uint256 sellerAgentId = _agentId(seller);
        uint256 otherAgentId = _agentId(otherSeller);

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("buyer-seller-1"), buyer, seller, 10);
        usageAccounting.accruePoints(keccak256("buyer-seller-2"), buyer, seller, 20);
        usageAccounting.accruePoints(keccak256("buyer-other-seller"), buyer, otherSeller, 30);
        usageAccounting.accruePoints(keccak256("second-buyer-seller"), secondBuyer, seller, 40);

        IAntseedUsageAccounting.BuyerUsage memory buyerUsage = usageAccounting.buyerEpochUsage(5, buyer);
        assertEq(buyerUsage.points, 60);
        assertEq(buyerUsage.weightedPoints, usageAccounting.weightedBuyerPointsByEpoch(5, buyer));

        IAntseedUsageAccounting.BuyerUsage memory buyerSellerUsage =
            usageAccounting.buyerAgentEpochUsage(5, buyer, sellerAgentId);
        assertEq(buyerSellerUsage.points, 30);
        assertEq((buyerSellerUsage.points * 10_000) / buyerUsage.points, 5_000);

        IAntseedUsageAccounting.BuyerUsage memory buyerTotalUsage = usageAccounting.buyerUsageTotal(buyer);
        assertEq(buyerTotalUsage.points, 60);

        IAntseedUsageAccounting.BuyerUsage memory buyerSellerTotalUsage =
            usageAccounting.buyerAgentUsageTotal(buyer, sellerAgentId);
        assertEq(buyerSellerTotalUsage.points, 30);
        assertEq((buyerSellerTotalUsage.points * 10_000) / buyerTotalUsage.points, 5_000);

        IAntseedUsageAccounting.BuyerUsage memory buyerOtherSellerUsage =
            usageAccounting.buyerAgentEpochUsage(5, buyer, otherAgentId);
        assertEq(buyerOtherSellerUsage.points, 30);
        assertEq((buyerOtherSellerUsage.points * 10_000) / buyerUsage.points, 5_000);

        IAntseedUsageAccounting.SellerUsage memory sellerAgentUsage = usageAccounting.agentEpochUsage(5, sellerAgentId);
        assertEq(sellerAgentUsage.points, 70);
        assertEq(sellerAgentUsage.poolPoints, 70);
        assertEq(sellerAgentUsage.weightedPoints, usageAccounting.weightedPoolPointsByEpoch(5, sellerAgentId));
        assertEq(usageAccounting.sellerAgentIdByEpoch(5, seller), sellerAgentId);

        IAntseedUsageAccounting.UsageTotals memory epochUsage = usageAccounting.epochUsage(5);
        assertEq(epochUsage.buyers.points, 100);
        assertEq(epochUsage.sellers.points, 100);
        assertEq(epochUsage.sellers.poolPoints, 100);

        IAntseedUsageAccounting.UsageTotals memory totalUsage = usageAccounting.totalUsage();
        assertEq(totalUsage.buyers.points, 100);
        assertEq(totalUsage.sellers.points, 100);
        assertEq(totalUsage.sellers.poolPoints, 100);
    }

    function test_usageAccountingRequiresMinimumAccountedPoolPower() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));
        _createSellerPool(sellerPools, seller, 5_000, keccak256("seller"));

        uint256 agentId = _agentId(seller);

        _warpGateEpoch(5);
        uint256 poolPower = sellerPools.poolPowerWeightAtEpoch(agentId, 5);
        assertGt(poolPower, 0);
        assertEq(usageAccounting.minimumAccountedPoolPower(), 1);

        usageAccounting.setMinimumAccountedPoolPower(poolPower + 1);
        usageAccounting.accruePoints(keccak256("below-minimum"), buyer, seller, 10);

        assertEq(usageAccounting.buyerPointsByEpoch(5, buyer), 0);
        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 0);
        assertEq(usageAccounting.weightedBuyerPointsByEpoch(5, buyer), 0);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, agentId), 0);
        assertEq(usageAccounting.totalWeightedPoolPointsByEpoch(5), 0);

        usageAccounting.setMinimumAccountedPoolPower(poolPower);
        usageAccounting.accruePoints(keccak256("at-minimum"), buyer, seller, 10);

        assertEq(usageAccounting.buyerPointsByEpoch(5, buyer), 10);
        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 10);
        assertEq(usageAccounting.weightedBuyerPointsByEpoch(5, buyer), 10 * poolPower);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, agentId), 10 * poolPower);
        assertEq(usageAccounting.totalWeightedPoolPointsByEpoch(5), 10 * poolPower);

        vm.expectRevert(IAntseedUsageAccounting.InvalidValue.selector);
        usageAccounting.setMinimumAccountedPoolPower(0);
    }

    function test_usageAccountingGasSnapshotsRecordUsageCases() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));
        _createSellerPool(sellerPools, seller, 5_000, keccak256("seller"));
        _createSellerPool(sellerPools, otherSeller, 5_000, keccak256("other-seller"));

        address secondBuyer = address(0x21);

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("warm-pair"), buyer, seller, 10);

        vm.startSnapshotGas("usage-accounting", "record-repeated-same-buyer-agent");
        usageAccounting.accruePoints(keccak256("repeat-pair"), buyer, seller, 10);
        uint256 repeatedGas = vm.stopSnapshotGas();

        vm.startSnapshotGas("usage-accounting", "record-new-buyer-existing-agent");
        usageAccounting.accruePoints(keccak256("new-buyer"), secondBuyer, seller, 10);
        uint256 newBuyerGas = vm.stopSnapshotGas();

        vm.startSnapshotGas("usage-accounting", "record-new-agent-in-epoch");
        usageAccounting.accruePoints(keccak256("new-agent"), buyer, otherSeller, 10);
        uint256 newAgentGas = vm.stopSnapshotGas();

        assertGt(repeatedGas, 0);
        assertGt(newBuyerGas, repeatedGas);
        assertGt(newAgentGas, repeatedGas);
    }

    function test_sellerUsageRewardsRecordsWeightedPoolPoints() public {
        bytes32 programId = keccak256("recognized-seller-usage-v1");
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerUsageRewards =
            new AntseedSellerUsageRewards(address(programs), address(sellerPools), address(usageAccounting), programId);
        sellerPools.setRewardStaker(address(sellerUsageRewards), true);
        programs.setRewardProgram(programId, address(sellerUsageRewards), address(0), 7_000, 4, 0, true);

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 10);
        usageAccounting.accrueBuyerPoints(buyer, 10);
        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 10);
        assertGt(usageAccounting.weightedPoolPointsByEpoch(5, poolSeller), 0);

        _warpGateEpoch(6);
        uint256 positionId = sellerPools.nextPositionId() - 1;
        (uint256 grossReward, uint256 claimableReward, uint256 burnedReward) =
            sellerUsageRewards.pendingStakerReward(positionId, 5);
        assertEq(grossReward, _programBudget(7_000, 5));
        assertEq(claimableReward, _programBudget(7_000, 5));
        assertEq(burnedReward, 0);

        assertEq(token.balanceOf(seller), 0);
    }

    function test_pointsPolicyCanZeroOrScaleSellerPoolPoints() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));
        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        MockUsagePointsPolicy policy = new MockUsagePointsPolicy();
        usageAccounting.setPointsPolicy(address(policy));

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("unverified"), buyer, seller, 10);
        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 0);
        assertEq(usageAccounting.poolPointsByEpoch(5, poolSeller), 0);
        assertEq(usageAccounting.weightedSellerPointsByEpoch(5, seller), 0);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, poolSeller), 0);

        policy.setSellerWeightBps(seller, 5_000);
        uint256 poolPower = sellerPools.poolPowerWeightAtEpoch(poolSeller, 5);
        usageAccounting.accruePoints(keccak256("verified-half"), buyer, seller, 10);
        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 5);
        assertEq(usageAccounting.buyerPointsByEpoch(5, buyer), 20);
        assertEq(usageAccounting.poolPointsByEpoch(5, poolSeller), 5);
        assertEq(usageAccounting.weightedSellerPointsByEpoch(5, seller), poolPower * 5);
        assertEq(usageAccounting.totalWeightedSellerPointsByEpoch(5), poolPower * 5);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, poolSeller), poolPower * 5);
    }

    function test_poolWeightedPointsAreSavedUncapped() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));

        uint256 honestStake = 1_000_000 ether;
        uint256 washStake = 100 ether;
        deal(address(token), seller, honestStake);
        deal(address(token), otherSeller, washStake);

        vm.startPrank(seller);
        token.approve(address(sellerPools), honestStake);
        sellerAgentLookup.setAgent(seller, _agentId(seller));
        identityRegistry.setOwner(_agentId(seller), seller);
        sellerPools.stake(_agentId(seller), honestStake, 52);
        vm.stopPrank();

        vm.startPrank(otherSeller);
        token.approve(address(sellerPools), washStake);
        sellerAgentLookup.setAgent(otherSeller, _agentId(otherSeller));
        identityRegistry.setOwner(_agentId(otherSeller), otherSeller);
        sellerPools.stake(_agentId(otherSeller), washStake, 52);
        vm.stopPrank();

        address honestSeller = seller;
        address washSeller = otherSeller;

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("honest"), buyer, seller, 1_000);
        usageAccounting.accruePoints(keccak256("wash"), address(0x21), otherSeller, 1_000_000);

        uint256 honestPower = sellerPools.poolPowerWeightAtEpoch(honestSeller, 5);
        uint256 washPower = sellerPools.poolPowerWeightAtEpoch(washSeller, 5);

        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, washSeller), 1_000_000 * washPower);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, honestSeller), 1_000 * honestPower);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, washSeller), 1_000_000 * washPower);
        assertEq(usageAccounting.totalWeightedPoolPointsByEpoch(5), (1_000 * honestPower) + (1_000_000 * washPower));
    }

    function test_positionApyCapBurnsTinyPoolHighVolumeReward() public {
        bytes32 programId = keccak256("recognized-seller-usage-v1");
        uint16 sellerProgramShareBps = 1;
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerUsageRewards =
            new AntseedSellerUsageRewards(address(programs), address(sellerPools), address(usageAccounting), programId);
        sellerPools.setRewardStaker(address(sellerUsageRewards), true);
        sellerPools.setApyCap(10_000, 52);
        programs.setRewardProgram(programId, address(sellerUsageRewards), address(0), sellerProgramShareBps, 4, 0, true);

        deal(address(token), seller, 1_000_000 ether);
        deal(address(token), otherSeller, 100 ether);

        vm.startPrank(seller);
        token.approve(address(sellerPools), 1_000_000 ether);
        sellerAgentLookup.setAgent(seller, _agentId(seller));
        identityRegistry.setOwner(_agentId(seller), seller);
        uint256 honestPositionId = sellerPools.stake(_agentId(seller), 1_000_000 ether, 52);
        vm.stopPrank();

        vm.startPrank(otherSeller);
        token.approve(address(sellerPools), 100 ether);
        sellerAgentLookup.setAgent(otherSeller, _agentId(otherSeller));
        identityRegistry.setOwner(_agentId(otherSeller), otherSeller);
        uint256 washPositionId = sellerPools.stake(_agentId(otherSeller), 100 ether, 52);
        vm.stopPrank();

        address honestSeller = seller;
        address washSeller = otherSeller;

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("honest"), buyer, seller, 1_000);
        usageAccounting.accruePoints(keccak256("wash"), address(0x21), otherSeller, 1_000_000);

        uint256 honestPoints = usageAccounting.weightedPoolPointsByEpoch(5, honestSeller);
        uint256 washPoints = usageAccounting.weightedPoolPointsByEpoch(5, washSeller);
        uint256 totalPoints = usageAccounting.totalWeightedPoolPointsByEpoch(5);

        _warpGateEpoch(6);
        uint256 expectedHonestReward = (_programBudget(sellerProgramShareBps, 5) * honestPoints) / totalPoints;
        uint256 expectedWashReward = (_programBudget(sellerProgramShareBps, 5) * washPoints) / totalPoints;
        (uint256 honestGross,, uint256 honestBurned) = sellerUsageRewards.pendingStakerReward(honestPositionId, 5);
        (uint256 washGross, uint256 washClaimable, uint256 washBurned) =
            sellerUsageRewards.pendingStakerReward(washPositionId, 5);
        assertEq(honestGross, expectedHonestReward);
        assertEq(washGross, expectedWashReward);
        assertEq(honestBurned, 0);
        assertLt(washClaimable, washGross);
        assertEq(washBurned, washGross - washClaimable);
    }

    function test_stressWashTradingCannotDominateSellerOrBuyerPrograms() public {
        bytes32 sellerPoolProgramId = keccak256("recognized-seller-usage-v1");
        bytes32 buyerProgramId = keccak256("recognized-buyer-usage-v1");
        address washBuyer = address(0x9999);
        uint256 honestBuyerCount = 1_000;
        uint256 honestBuyerVolume = 1_000;
        uint256 honestTotalVolume = honestBuyerCount * honestBuyerVolume;
        uint256 washVolume = 100_000_000_000;

        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerUsageRewards = new AntseedSellerUsageRewards(
            address(programs), address(sellerPools), address(usageAccounting), sellerPoolProgramId
        );
        buyerUsageRewards = new AntseedBuyerUsageRewards(address(programs), address(realRegistry), buyerProgramId);
        buyerUsageRewards.setUsageAccounting(address(usageAccounting));
        sellerPools.setRewardStaker(address(sellerUsageRewards), true);
        sellerPools.setApyCap(10_000, 52);
        programs.setRewardProgram(sellerPoolProgramId, address(sellerUsageRewards), address(0), 7_000, 4, 0, true);
        programs.setRewardProgram(buyerProgramId, address(buyerUsageRewards), address(0), 500, 4, 0, true);

        deal(address(token), seller, 1_000_000 ether);
        deal(address(token), otherSeller, 100 ether);

        vm.startPrank(seller);
        token.approve(address(sellerPools), 1_000_000 ether);
        sellerAgentLookup.setAgent(seller, _agentId(seller));
        identityRegistry.setOwner(_agentId(seller), seller);
        uint256 honestPositionId = sellerPools.stake(_agentId(seller), 1_000_000 ether, 52);
        vm.stopPrank();

        vm.startPrank(otherSeller);
        token.approve(address(sellerPools), 100 ether);
        sellerAgentLookup.setAgent(otherSeller, _agentId(otherSeller));
        identityRegistry.setOwner(_agentId(otherSeller), otherSeller);
        uint256 washPositionId = sellerPools.stake(_agentId(otherSeller), 100 ether, 52);
        vm.stopPrank();

        _warpGateEpoch(5);
        for (uint256 i = 0; i < honestBuyerCount; i++) {
            address honestBuyer = address(uint160(0x20000 + i));
            usageAccounting.accruePoints(
                keccak256(abi.encodePacked("honest", i)), honestBuyer, seller, honestBuyerVolume
            );
        }
        usageAccounting.accruePoints(keccak256("wash"), washBuyer, otherSeller, washVolume);

        uint256 honestAgentId = _agentId(seller);
        uint256 washAgentId = _agentId(otherSeller);
        uint256 honestPower = sellerPools.poolPowerWeightAtEpoch(honestAgentId, 5);
        uint256 washPower = sellerPools.poolPowerWeightAtEpoch(washAgentId, 5);
        uint256 expectedWashWeightedPoints = washVolume * washPower;
        uint256 expectedHonestWeightedPoints = honestTotalVolume * honestPower;
        uint256 expectedTotalWeightedPoints = expectedHonestWeightedPoints + expectedWashWeightedPoints;
        uint256 expectedWashBuyerWeightedPoints = washVolume * washPower;
        uint256 expectedTotalBuyerWeightedPoints = expectedHonestWeightedPoints + expectedWashBuyerWeightedPoints;

        assertEq(usageAccounting.agentPoolPointsByEpoch(5, honestAgentId), honestTotalVolume);
        assertEq(usageAccounting.agentPoolPointsByEpoch(5, washAgentId), washVolume);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, washAgentId), washVolume * washPower);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, honestAgentId), expectedHonestWeightedPoints);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, washAgentId), expectedWashWeightedPoints);
        assertEq(usageAccounting.totalWeightedPoolPointsByEpoch(5), expectedTotalWeightedPoints);

        assertEq(usageAccounting.weightedBuyerPointsByEpoch(5, washBuyer), expectedWashBuyerWeightedPoints);
        assertEq(usageAccounting.totalWeightedBuyerPointsByEpoch(5), expectedTotalBuyerWeightedPoints);

        _warpGateEpoch(6);
        uint256 sellerProgramBudget = programs.programEpochBudget(sellerPoolProgramId, 5);
        uint256 buyerProgramBudget = programs.programEpochBudget(buyerProgramId, 5);
        uint256 expectedWashSellerReward =
            (sellerProgramBudget * expectedWashWeightedPoints) / expectedTotalWeightedPoints;
        uint256 expectedHonestSellerReward =
            (sellerProgramBudget * expectedHonestWeightedPoints) / expectedTotalWeightedPoints;
        uint256 expectedWashBuyerReward =
            (buyerProgramBudget * expectedWashBuyerWeightedPoints) / expectedTotalBuyerWeightedPoints;

        (uint256 honestGross, uint256 honestClaimable, uint256 honestBurned) =
            sellerUsageRewards.pendingStakerReward(honestPositionId, 5);
        (uint256 washGross, uint256 washClaimable, uint256 washBurned) =
            sellerUsageRewards.pendingStakerReward(washPositionId, 5);
        assertEq(honestGross, expectedHonestSellerReward);
        assertEq(washGross, expectedWashSellerReward);
        assertEq(washBurned, washGross - washClaimable);
        assertEq(honestBurned, honestGross - honestClaimable);

        uint256 washBuyerCap =
            (buyerProgramBudget * buyerUsageRewards.MAX_REWARD_SHARE_BPS()) / buyerUsageRewards.BPS_DENOMINATOR();
        uint256 cappedWashBuyerReward = expectedWashBuyerReward < washBuyerCap ? expectedWashBuyerReward : washBuyerCap;
        assertEq(buyerUsageRewards.pendingBuyerReward(washBuyer, 5), cappedWashBuyerReward);

        assertGt(expectedWashSellerReward, expectedHonestSellerReward);
        assertLt(washClaimable, honestClaimable);
        assertLt(washClaimable, washGross);
        assertLt(buyerUsageRewards.pendingBuyerReward(washBuyer, 5), expectedWashBuyerReward);
    }

    function test_stressThousandAgentsAndBuyersClaimFromSavedTotals() public {
        bytes32 sellerPoolProgramId = keccak256("recognized-seller-usage-v1");
        bytes32 buyerProgramId = keccak256("recognized-buyer-usage-v1");
        uint256 agentCount = 1_000;
        uint256 honestVolume = 1_000;
        uint256 washVolume = 1_000_000_000;
        address firstSeller = address(uint160(0x30000));
        address firstBuyer = address(uint160(0x40000));
        address washSeller = address(uint160(0x30000 + agentCount - 1));
        address washBuyer = address(uint160(0x40000 + agentCount - 1));
        StressRun memory run;

        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerUsageRewards = new AntseedSellerUsageRewards(
            address(programs), address(sellerPools), address(usageAccounting), sellerPoolProgramId
        );
        buyerUsageRewards = new AntseedBuyerUsageRewards(address(programs), address(realRegistry), buyerProgramId);
        buyerUsageRewards.setUsageAccounting(address(usageAccounting));
        sellerPools.setRewardStaker(address(sellerUsageRewards), true);
        sellerPools.setApyCap(10_000, 52);
        programs.setRewardProgram(sellerPoolProgramId, address(sellerUsageRewards), address(0), 7_000, 4, 0, true);
        programs.setRewardProgram(buyerProgramId, address(buyerUsageRewards), address(0), 500, 4, 0, true);

        for (uint256 i = 0; i < agentCount; i++) {
            address seller_ = address(uint160(0x30000 + i));
            uint256 stakeAmount = seller_ == washSeller ? 100 ether : 1_000 ether;
            deal(address(token), seller_, stakeAmount);
            uint256 positionId = _stakeAgentPool(sellerPools, seller_, stakeAmount, 52);
            if (seller_ == firstSeller) run.firstPositionId = positionId;
            if (seller_ == washSeller) run.washPositionId = positionId;
        }

        _warpGateEpoch(5);
        for (uint256 i = 0; i < agentCount; i++) {
            address seller_ = address(uint160(0x30000 + i));
            address buyer_ = address(uint160(0x40000 + i));
            uint256 volume = seller_ == washSeller ? washVolume : honestVolume;

            usageAccounting.accruePoints(keccak256(abi.encodePacked("stress", i)), buyer_, seller_, volume);

            uint256 weightedPoints = volume * sellerPools.poolPowerWeightAtEpoch(_agentId(seller_), 5);
            run.expectedTotalWeightedPoints += weightedPoints;
            if (seller_ == firstSeller) run.firstWeightedPoints = weightedPoints;
            if (seller_ == washSeller) run.washWeightedPoints = weightedPoints;
        }

        uint256 firstAgentId = _agentId(firstSeller);
        uint256 washAgentId = _agentId(washSeller);
        assertEq(usageAccounting.totalWeightedPoolPointsByEpoch(5), run.expectedTotalWeightedPoints);
        assertEq(usageAccounting.totalWeightedBuyerPointsByEpoch(5), run.expectedTotalWeightedPoints);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, firstAgentId), run.firstWeightedPoints);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, washAgentId), run.washWeightedPoints);
        assertEq(usageAccounting.weightedBuyerPointsByEpoch(5, firstBuyer), run.firstWeightedPoints);
        assertEq(usageAccounting.weightedBuyerPointsByEpoch(5, washBuyer), run.washWeightedPoints);

        _warpGateEpoch(6);
        {
            uint256 sellerProgramBudget = programs.programEpochBudget(sellerPoolProgramId, 5);
            uint256 expectedFirstGross =
                (sellerProgramBudget * run.firstWeightedPoints) / run.expectedTotalWeightedPoints;
            uint256 expectedWashGross = (sellerProgramBudget * run.washWeightedPoints) / run.expectedTotalWeightedPoints;

            (uint256 firstGross, uint256 firstClaimable, uint256 firstBurned) =
                sellerUsageRewards.pendingStakerReward(run.firstPositionId, 5);
            (uint256 washGross, uint256 washClaimable, uint256 washBurned) =
                sellerUsageRewards.pendingStakerReward(run.washPositionId, 5);
            run.firstClaimable = firstClaimable;
            run.washClaimable = washClaimable;
            assertEq(firstGross, expectedFirstGross);
            assertEq(washGross, expectedWashGross);
            assertEq(firstBurned, firstGross - firstClaimable);
            assertEq(washBurned, washGross - washClaimable);
            assertLt(washClaimable, washGross);
        }

        vm.prank(firstSeller);
        sellerUsageRewards.claimStakerRewards(run.firstPositionId, _epochList(5), firstSeller);
        vm.prank(washSeller);
        sellerUsageRewards.claimStakerRewards(run.washPositionId, _epochList(5), washSeller);
        assertEq(token.balanceOf(firstSeller), run.firstClaimable);
        assertEq(token.balanceOf(washSeller), run.washClaimable);

        {
            uint256 buyerProgramBudget = programs.programEpochBudget(buyerProgramId, 5);
            uint256 washBuyerGross = (buyerProgramBudget * run.washWeightedPoints) / run.expectedTotalWeightedPoints;
            uint256 washBuyerCap =
                (buyerProgramBudget * buyerUsageRewards.MAX_REWARD_SHARE_BPS()) / buyerUsageRewards.BPS_DENOMINATOR();
            uint256 washBuyerClaimable = washBuyerGross < washBuyerCap ? washBuyerGross : washBuyerCap;
            assertEq(buyerUsageRewards.pendingBuyerReward(washBuyer, 5), washBuyerClaimable);

            buyerUsageRewards.claimBuyerReward(washBuyer, 5);
            assertEq(token.balanceOf(washBuyer), washBuyerClaimable);
        }
    }

    function test_stakeCreatedDuringEpochDoesNotEarnUntilNextEpoch() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));
        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        usageAccounting.accruePoints(keccak256("same-epoch"), buyer, seller, 10);
        assertEq(usageAccounting.sellerPointsByEpoch(4, seller), 10);
        assertEq(usageAccounting.poolPointsByEpoch(4, poolSeller), 0);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(4, poolSeller), 0);

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("next-epoch"), buyer, seller, 10);
        assertGt(usageAccounting.weightedPoolPointsByEpoch(5, poolSeller), 0);
    }

    function test_buyerRewardsRequirePoolWeightedBuyerPoints() public {
        bytes32 programId = keccak256("recognized-buyer-usage-v1");
        address secondBuyer = address(0x21);
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));
        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        MockUsagePointsPolicy policy = new MockUsagePointsPolicy();
        policy.setSellerWeightBps(seller, 0);
        policy.setBuyerWeightBps(0);
        usageAccounting.setPointsPolicy(address(policy));

        buyerUsageRewards = new AntseedBuyerUsageRewards(address(programs), address(realRegistry), programId);
        buyerUsageRewards.setUsageAccounting(address(usageAccounting));
        programs.setRewardProgram(programId, address(buyerUsageRewards), address(0), 500, 4, 0, true);

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("buyer-one"), buyer, seller, 10);
        usageAccounting.accruePoints(keccak256("buyer-two"), secondBuyer, seller, 30);

        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 0);
        assertEq(usageAccounting.buyerPointsByEpoch(5, buyer), 0);
        assertEq(usageAccounting.buyerPointsByEpoch(5, secondBuyer), 0);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), 0);
        assertEq(usageAccounting.weightedBuyerPointsByEpoch(5, buyer), 0);
        assertEq(usageAccounting.totalWeightedBuyerPointsByEpoch(5), 0);

        _warpGateEpoch(6);
        assertEq(buyerUsageRewards.pendingBuyerReward(buyer, 5), 0);
        assertEq(buyerUsageRewards.pendingBuyerReward(secondBuyer, 5), 0);
    }

    function test_buyerUsageRewardsUsePoolWeightedShareAndOperatorRecipient() public {
        bytes32 programId = keccak256("recognized-buyer-usage-v1");
        address secondBuyer = address(0x21);
        _deployGate(3);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));

        buyerUsageRewards = new AntseedBuyerUsageRewards(address(programs), address(realRegistry), programId);
        buyerUsageRewards.setUsageAccounting(address(usageAccounting));
        programs.setRewardProgram(programId, address(buyerUsageRewards), address(0), 500, 4, 0, true);
        assertEq(programs.programEpochBudget(programId, 4), _programBudget(500, 4));

        deal(address(token), seller, 100 ether);
        deal(address(token), otherSeller, 10 ether);

        vm.startPrank(seller);
        token.approve(address(sellerPools), 100 ether);
        sellerAgentLookup.setAgent(seller, _agentId(seller));
        identityRegistry.setOwner(_agentId(seller), seller);
        sellerPools.stake(_agentId(seller), 100 ether, 4);
        vm.stopPrank();

        vm.startPrank(otherSeller);
        token.approve(address(sellerPools), 10 ether);
        sellerAgentLookup.setAgent(otherSeller, _agentId(otherSeller));
        identityRegistry.setOwner(_agentId(otherSeller), otherSeller);
        sellerPools.stake(_agentId(otherSeller), 10 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(4);
        usageAccounting.accruePoints(keccak256("high-power"), buyer, seller, 100);
        usageAccounting.accruePoints(keccak256("low-power"), secondBuyer, otherSeller, 100);

        uint256 highPower = sellerPools.poolPowerWeightAtEpoch(seller, 4);
        uint256 lowPower = sellerPools.poolPowerWeightAtEpoch(otherSeller, 4);
        uint256 buyerWeightedPoints = 100 * highPower;
        uint256 secondBuyerWeightedPoints = 100 * lowPower;
        uint256 totalWeightedPoints = buyerWeightedPoints + secondBuyerWeightedPoints;

        assertEq(usageAccounting.weightedBuyerPointsByEpoch(4, buyer), buyerWeightedPoints);
        assertEq(usageAccounting.weightedBuyerPointsByEpoch(4, secondBuyer), secondBuyerWeightedPoints);
        assertEq(usageAccounting.totalWeightedBuyerPointsByEpoch(4), totalWeightedPoints);

        _warpGateEpoch(5);

        uint256 grossBuyerReward = (_programBudget(500, 4) * buyerWeightedPoints) / totalWeightedPoints;
        uint256 grossSecondBuyerReward = (_programBudget(500, 4) * secondBuyerWeightedPoints) / totalWeightedPoints;
        uint256 buyerReward = buyerUsageRewards.pendingBuyerReward(buyer, 4);
        uint256 secondBuyerReward = buyerUsageRewards.pendingBuyerReward(secondBuyer, 4);
        uint256 buyerCap =
            (_programBudget(500, 4) * buyerUsageRewards.MAX_REWARD_SHARE_BPS()) / buyerUsageRewards.BPS_DENOMINATOR();
        assertEq(buyerReward, buyerCap);
        assertEq(secondBuyerReward, grossSecondBuyerReward < buyerCap ? grossSecondBuyerReward : buyerCap);

        buyerUsageRewards.claimBuyerReward(buyer, 4);
        assertEq(token.balanceOf(operator), buyerReward);
        assertEq(token.balanceOf(reserveDest), grossBuyerReward - buyerReward);

        buyerUsageRewards.claimBuyerReward(secondBuyer, 4);
        assertEq(token.balanceOf(secondBuyer), secondBuyerReward);
        assertEq(
            token.balanceOf(reserveDest),
            (grossBuyerReward - buyerReward) + (grossSecondBuyerReward - secondBuyerReward)
        );

        vm.expectRevert(AntseedBuyerUsageRewards.AlreadyClaimed.selector);
        buyerUsageRewards.claimBuyerReward(buyer, 4);
    }

    function test_buyerUsageRewardsValidationAndPause() public {
        bytes32 programId = keccak256("recognized-buyer-usage-v1");
        _deployGate(4);

        vm.expectRevert(AntseedBuyerUsageRewards.InvalidAddress.selector);
        new AntseedBuyerUsageRewards(address(0), address(realRegistry), programId);

        vm.expectRevert(AntseedBuyerUsageRewards.InvalidAddress.selector);
        new AntseedBuyerUsageRewards(address(programs), address(0), programId);

        vm.expectRevert(AntseedBuyerUsageRewards.InvalidAddress.selector);
        new AntseedBuyerUsageRewards(address(programs), address(realRegistry), bytes32(0));

        buyerUsageRewards = new AntseedBuyerUsageRewards(address(programs), address(realRegistry), programId);
        programs.setRewardProgram(programId, address(buyerUsageRewards), address(0), 500, 4, 0, true);

        vm.expectRevert(AntseedBuyerUsageRewards.InvalidAddress.selector);
        buyerUsageRewards.setEmissionsAuthority(address(0));
        buyerUsageRewards.setEmissionsAuthority(address(programs));

        vm.expectRevert(AntseedBuyerUsageRewards.InvalidAddress.selector);
        buyerUsageRewards.setRegistry(address(0));
        buyerUsageRewards.setRegistry(address(realRegistry));

        vm.expectRevert(AntseedBuyerUsageRewards.InvalidAddress.selector);
        buyerUsageRewards.setUsageAccounting(address(0));
        buyerUsageRewards.setUsageAccounting(address(usageAccounting));

        vm.expectRevert(AntseedBuyerUsageRewards.InvalidAddress.selector);
        buyerUsageRewards.claimBuyerReward(address(0), 4);

        vm.expectRevert(AntseedBuyerUsageRewards.NothingToClaim.selector);
        buyerUsageRewards.claimBuyerReward(buyer, 4);

        buyerUsageRewards.pause();
        assertTrue(buyerUsageRewards.paused());
        vm.expectRevert();
        buyerUsageRewards.claimBuyerReward(buyer, 4);
        buyerUsageRewards.unpause();
        assertFalse(buyerUsageRewards.paused());
    }

    function test_sellerOperatorRewardsPaySellerDirectly() public {
        bytes32 programId = keccak256("recognized-seller-operator-v1");
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerOperatorUsageRewards = new AntseedSellerOperatorUsageRewards(
            address(programs), address(realRegistry), address(usageAccounting), programId
        );
        programs.setRewardProgram(programId, address(sellerOperatorUsageRewards), address(0), 500, 4, 0, true);

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("seller-direct"), buyer, seller, 100);

        uint256 grossReward = _programBudget(500, 5);
        uint256 expectedReward = (grossReward * sellerOperatorUsageRewards.MAX_REWARD_SHARE_BPS())
            / sellerOperatorUsageRewards.BPS_DENOMINATOR();
        _warpGateEpoch(6);
        assertEq(sellerOperatorUsageRewards.pendingSellerReward(seller, 5), expectedReward);

        sellerOperatorUsageRewards.claimSellerReward(seller, 5);
        assertEq(token.balanceOf(seller), expectedReward);
        assertEq(token.balanceOf(reserveDest), grossReward - expectedReward);

        vm.expectRevert(AntseedSellerOperatorUsageRewards.AlreadyClaimed.selector);
        sellerOperatorUsageRewards.claimSellerReward(seller, 5);
    }

    function test_sellerOperatorRewardsPayCurrentAgentOwner() public {
        bytes32 programId = keccak256("recognized-seller-operator-v1");
        address newOwner = address(0x1111);
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerOperatorUsageRewards = new AntseedSellerOperatorUsageRewards(
            address(programs), address(realRegistry), address(usageAccounting), programId
        );
        programs.setRewardProgram(programId, address(sellerOperatorUsageRewards), address(0), 500, 4, 0, true);

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("seller-direct-sold-agent"), buyer, seller, 100);

        uint256 agentId = _agentId(seller);
        vm.prank(seller);
        identityRegistry.transferAgent(agentId, newOwner);

        uint256 grossReward = _programBudget(500, 5);
        uint256 expectedReward = (grossReward * sellerOperatorUsageRewards.MAX_REWARD_SHARE_BPS())
            / sellerOperatorUsageRewards.BPS_DENOMINATOR();
        _warpGateEpoch(6);
        assertEq(sellerOperatorUsageRewards.rewardRecipient(agentId), newOwner);
        assertEq(sellerOperatorUsageRewards.pendingAgentReward(agentId, 5), expectedReward);

        sellerOperatorUsageRewards.claimAgentReward(agentId, 5);
        assertEq(token.balanceOf(newOwner), expectedReward);
        assertEq(token.balanceOf(seller), 0);
        assertEq(token.balanceOf(reserveDest), grossReward - expectedReward);
    }

    function test_sellerOperatorRewardsAreSeparateFromPoolRewards() public {
        bytes32 operatorProgramId = keccak256("recognized-seller-operator-v1");
        bytes32 poolProgramId = keccak256("recognized-seller-pool-v1");
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerOperatorUsageRewards = new AntseedSellerOperatorUsageRewards(
            address(programs), address(realRegistry), address(usageAccounting), operatorProgramId
        );
        sellerUsageRewards = new AntseedSellerUsageRewards(
            address(programs), address(sellerPools), address(usageAccounting), poolProgramId
        );
        sellerPools.setRewardStaker(address(sellerUsageRewards), true);
        programs.setRewardProgram(operatorProgramId, address(sellerOperatorUsageRewards), address(0), 500, 4, 0, true);
        programs.setRewardProgram(poolProgramId, address(sellerUsageRewards), address(0), 6_000, 4, 0, true);

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        uint256 positionId = sellerPools.nextPositionId() - 1;

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("seller-direct-and-pool"), buyer, seller, 100);

        _warpGateEpoch(6);
        sellerOperatorUsageRewards.claimSellerReward(seller, 5);
        vm.prank(seller);
        sellerUsageRewards.claimStakerRewards(positionId, _epochList(5), seller);

        uint256 expectedOperatorReward = (_programBudget(500, 5) * sellerOperatorUsageRewards.MAX_REWARD_SHARE_BPS())
            / sellerOperatorUsageRewards.BPS_DENOMINATOR();
        assertEq(token.balanceOf(seller), expectedOperatorReward + _programBudget(6_000, 5));
        assertEq(token.balanceOf(reserveDest), _programBudget(500, 5) - expectedOperatorReward);
    }

    function test_gateMintValidationAndPause() public {
        bytes32 programId = keccak256("program");
        _deployGate(4);
        programs.setRewardProgram(programId, address(this), address(0), 1_000, 4, 0, true);

        vm.expectRevert(AntseedEmissionPrograms.InvalidAddress.selector);
        programs.mintProgramEmission(programId, 4, address(0), 1 ether);

        vm.expectRevert(AntseedEmissionPrograms.InvalidValue.selector);
        programs.mintProgramEmission(programId, 4, address(this), 0);

        vm.expectRevert(AntseedEmissionsGate.EpochNotFinalized.selector);
        programs.mintProgramEmission(programId, 5, address(this), 1 ether);

        vm.expectRevert(AntseedEmissionPrograms.InvalidProgram.selector);
        programs.mintProgramEmission(keccak256("missing"), 3, address(this), 1 ether);

        _warpGateEpoch(5);
        vm.prank(seller);
        vm.expectRevert(AntseedEmissionPrograms.NotProgramController.selector);
        programs.mintProgramEmission(programId, 4, seller, 1 ether);

        uint256 programBudget = _programBudget(1_000, 4);
        vm.expectRevert(AntseedEmissionPrograms.ProgramBudgetExceeded.selector);
        programs.mintProgramEmission(programId, 4, address(this), programBudget + 1);

        programs.mintProgramEmission(programId, 4, address(this), 1 ether);
    }

    function test_rewardProgramSharesCannotExceedPostMigrationEpochBudget() public {
        bytes32 sellerPoolProgramId = keccak256("recognized-seller-pool-v1");
        bytes32 sellerOperatorProgramId = keccak256("recognized-seller-operator-v1");
        bytes32 buyerProgramId = keccak256("recognized-buyer-usage-v1");
        bytes32 teamProgramId = keccak256("antseed-team-v1");
        bytes32 reserveProgramId = keccak256("antseed-reserve-v1");
        _deployGate(5);

        programs.setRewardProgram(sellerPoolProgramId, address(this), address(0), 6_000, 4, 0, true);
        programs.setRewardProgram(sellerOperatorProgramId, address(this), address(0), 500, 4, 0, true);
        programs.setRewardProgram(buyerProgramId, address(this), address(0), 500, 4, 0, true);
        programs.setRewardProgram(teamProgramId, teamWallet, teamWallet, 1_500, 4, 0, true);
        programs.setRewardProgram(reserveProgramId, reserveDest, reserveDest, 1_500, 4, 0, true);

        vm.expectRevert(AntseedEmissionPrograms.ProgramShareExceeded.selector);
        programs.setRewardProgram(keccak256("too-much"), address(this), address(0), 1, 4, 0, true);

        programs.setRewardProgram(keccak256("inactive-overage"), address(this), address(0), 1, 4, 0, false);
        programs.setRewardProgram(keccak256("legacy-window"), address(this), address(0), 10_000, 0, 4, true);
    }

    function test_gateCapsTotalScheduledMintsByEpochEmission() public {
        vm.warp(GATE_GENESIS + GATE_EPOCH_DURATION * 4 + 1);
        gate = new AntseedEmissionsGate();
        _warpGateEpoch(5);
        gate.setEmissionController(address(this));
        token.setRegistry(address(gate));

        uint256 epochEmission = gate.getEpochEmission(4);
        gate.mintScheduleEmission(4, address(this), epochEmission / 2);
        gate.mintScheduleEmission(4, address(this), epochEmission - (epochEmission / 2));
        assertEq(gate.epochScheduleMinted(4), epochEmission);

        vm.expectRevert(AntseedEmissionsGate.EpochEmissionExceeded.selector);
        gate.mintScheduleEmission(4, address(this), 1);
    }

    function test_rewardProgramShareCanChangeForFutureEpochsWithSameController() public {
        bytes32 programId = keccak256("recognized-buyer-usage-v1");
        _deployGate(4);

        programs.setRewardProgram(programId, address(this), address(0), 500, 4, 0, true);
        assertEq(programs.rewardProgramConfigCount(programId), 1);
        assertEq(programs.programEpochBudget(programId, 4), _programBudget(500, 4));
        assertEq(programs.programEpochBudget(programId, 7), _programBudget(500, 7));

        programs.setRewardProgram(programId, address(this), address(0), 1_000, 8, 0, true);
        assertEq(programs.rewardProgramConfigCount(programId), 2);
        assertEq(programs.programEpochBudget(programId, 4), _programBudget(500, 4));
        assertEq(programs.programEpochBudget(programId, 7), _programBudget(500, 7));
        assertEq(programs.programEpochBudget(programId, 8), _programBudget(1_000, 8));

        _warpGateEpoch(5);
        programs.mintProgramEmission(programId, 4, address(this), _programBudget(500, 4));
        assertEq(token.balanceOf(address(this)), _programBudget(500, 4));

        vm.expectRevert(AntseedEmissionPrograms.InvalidValue.selector);
        programs.setRewardProgram(programId, address(this), address(0), 1_000, 4, 0, true);

        _warpGateEpoch(9);
        programs.mintProgramEmission(programId, 8, address(this), _programBudget(1_000, 8));
        assertEq(token.balanceOf(address(this)), _programBudget(500, 4) + _programBudget(1_000, 8));
    }

    function test_teamAndReserveProgramsAreCalledByTheirRecipients() public {
        bytes32 teamProgramId = keccak256("antseed-team-v1");
        bytes32 reserveProgramId = keccak256("antseed-reserve-v1");
        _deployGate(5);

        programs.setRewardProgram(teamProgramId, teamWallet, teamWallet, 1_500, 4, 0, true);
        programs.setRewardProgram(reserveProgramId, reserveDest, reserveDest, 1_500, 4, 0, true);
        uint256 teamBudget = _programBudget(1_500, 4);
        uint256 reserveBudget = _programBudget(1_500, 4);

        vm.prank(seller);
        vm.expectRevert(AntseedEmissionPrograms.NotProgramController.selector);
        programs.mintProgramEmission(teamProgramId, 4, teamWallet, 1 ether);

        vm.prank(teamWallet);
        vm.expectRevert(AntseedEmissionPrograms.InvalidProgramRecipient.selector);
        programs.mintProgramEmission(teamProgramId, 4, seller, 1 ether);

        vm.prank(teamWallet);
        programs.mintProgramEmission(teamProgramId, 4, teamWallet, teamBudget);
        assertEq(token.balanceOf(teamWallet), teamBudget);

        vm.prank(reserveDest);
        programs.mintProgramEmission(reserveProgramId, 4, reserveDest, reserveBudget);
        assertEq(token.balanceOf(reserveDest), reserveBudget);

        vm.prank(teamWallet);
        vm.expectRevert(AntseedEmissionPrograms.ProgramBudgetExceeded.selector);
        programs.mintProgramEmission(teamProgramId, 4, teamWallet, 1 wei);
    }

    function test_sellerUsageRewardsDistributionValidation() public {
        bytes32 programId = keccak256("recognized-seller-usage-v1");
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerUsageRewards =
            new AntseedSellerUsageRewards(address(programs), address(sellerPools), address(usageAccounting), programId);
        sellerPools.setRewardStaker(address(sellerUsageRewards), true);
        programs.setRewardProgram(programId, address(sellerUsageRewards), address(0), 7_000, 4, 0, true);

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        uint256 positionId = sellerPools.nextPositionId() - 1;
        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 10);
        usageAccounting.accrueBuyerPoints(buyer, 10);

        _warpGateEpoch(6);
        vm.prank(seller);
        sellerUsageRewards.claimStakerRewards(positionId, _epochList(5), seller);
        assertEq(token.balanceOf(seller), _programBudget(7_000, 5));

        vm.expectRevert(AntseedSellerUsageRewards.NothingToClaim.selector);
        vm.prank(seller);
        sellerUsageRewards.claimStakerRewards(positionId, _epochList(5), seller);

        vm.expectRevert(AntseedSellerUsageRewards.InvalidValue.selector);
        sellerUsageRewards.pendingStakerReward(0, 5);
    }

    function test_sellerUsageRewardsBatchClaimUsesPositionLogic() public {
        bytes32 programId = keccak256("recognized-seller-usage-v1");
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerUsageRewards =
            new AntseedSellerUsageRewards(address(programs), address(sellerPools), address(usageAccounting), programId);
        programs.setRewardProgram(programId, address(sellerUsageRewards), address(0), 7_000, 4, 0, true);

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        sellerAgentLookup.setAgent(otherSeller, _agentId(otherSeller));
        identityRegistry.setOwner(_agentId(otherSeller), otherSeller);

        vm.startPrank(staker);
        token.approve(address(sellerPools), 175 ether);
        uint256 firstPositionId = sellerPools.stake(_agentId(poolSeller), 100 ether, 4);
        uint256 secondPositionId = sellerPools.stake(_agentId(poolSeller), 50 ether, 3);
        uint256 noRewardPositionId = sellerPools.stake(_agentId(otherSeller), 25 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(6);
        uint256[] memory positionIds = new uint256[](3);
        positionIds[0] = firstPositionId;
        positionIds[1] = secondPositionId;
        positionIds[2] = noRewardPositionId;

        (uint256 firstGross,,) = sellerUsageRewards.pendingStakerReward(firstPositionId, 5);
        (uint256 secondGross,,) = sellerUsageRewards.pendingStakerReward(secondPositionId, 5);

        vm.prank(staker);
        sellerUsageRewards.claimStakerRewardsBatch(positionIds, _epochList(5), staker);

        assertEq(token.balanceOf(staker), 825 ether + firstGross + secondGross);
        assertTrue(sellerUsageRewards.positionEpochClaimed(firstPositionId, 5));
        assertTrue(sellerUsageRewards.positionEpochClaimed(secondPositionId, 5));
        assertFalse(sellerUsageRewards.positionEpochClaimed(noRewardPositionId, 5));

        vm.expectRevert(AntseedSellerUsageRewards.NothingToClaim.selector);
        vm.prank(staker);
        sellerUsageRewards.claimStakerRewardsBatch(positionIds, _epochList(5), staker);
    }

    function test_sellerUsageRewardsBatchRestakeUsesPositionLogicAndCreatesSeparatePositions() public {
        bytes32 programId = keccak256("recognized-seller-usage-v1");
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(realRegistry));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerUsageRewards =
            new AntseedSellerUsageRewards(address(programs), address(sellerPools), address(usageAccounting), programId);
        sellerPools.setRewardStaker(address(sellerUsageRewards), true);
        programs.setRewardProgram(programId, address(sellerUsageRewards), address(0), 7_000, 4, 0, true);

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        sellerAgentLookup.setAgent(otherSeller, _agentId(otherSeller));
        identityRegistry.setOwner(_agentId(otherSeller), otherSeller);

        vm.startPrank(staker);
        token.approve(address(sellerPools), 175 ether);
        uint256 firstPositionId = sellerPools.stake(_agentId(poolSeller), 100 ether, 4);
        uint256 secondPositionId = sellerPools.stake(_agentId(poolSeller), 50 ether, 3);
        uint256 noRewardPositionId = sellerPools.stake(_agentId(otherSeller), 25 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(6);
        uint256[] memory positionIds = new uint256[](3);
        positionIds[0] = firstPositionId;
        positionIds[1] = secondPositionId;
        positionIds[2] = noRewardPositionId;

        (uint256 firstGross,,) = sellerUsageRewards.pendingStakerReward(firstPositionId, 5);
        (uint256 secondGross,,) = sellerUsageRewards.pendingStakerReward(secondPositionId, 5);

        vm.prank(staker);
        uint256[] memory newPositionIds = sellerUsageRewards.restakeStakerRewardsBatch(positionIds, _epochList(5), 2);

        assertEq(newPositionIds.length, 3);
        assertNotEq(newPositionIds[0], newPositionIds[1]);
        assertEq(newPositionIds[2], 0);
        assertEq(token.balanceOf(staker), 825 ether);
        assertEq(sellerPools.stakerPositionCount(staker), 5);

        (,, uint256 amount, uint256 weightAmount, uint64 startEpoch, uint64 stakeEndEpoch,,) =
            sellerPools.positions(newPositionIds[0]);
        uint256 expectedBonusBps = (uint256(500) * 2) / 52;
        uint256 expectedFirstWeightAmount = (firstGross * (10_000 + expectedBonusBps)) / 10_000;
        assertEq(amount, firstGross);
        assertEq(weightAmount, expectedFirstWeightAmount);
        assertEq(startEpoch, 7);
        assertEq(stakeEndEpoch, 9);

        (,, amount, weightAmount, startEpoch, stakeEndEpoch,,) = sellerPools.positions(newPositionIds[1]);
        uint256 expectedSecondWeightAmount = (secondGross * (10_000 + expectedBonusBps)) / 10_000;
        assertEq(amount, secondGross);
        assertEq(weightAmount, expectedSecondWeightAmount);
        assertEq(startEpoch, 7);
        assertEq(stakeEndEpoch, 9);
    }

    function test_sellerUsageRewardsAdminAndPause() public {
        bytes32 programId = keccak256("recognized-seller-usage-v1");
        _deployGate(5);
        sellerPools = new AntseedSellerPools(address(realRegistry));
        sellerUsageRewards =
            new AntseedSellerUsageRewards(address(programs), address(sellerPools), address(usageAccounting), programId);

        vm.expectRevert(AntseedSellerUsageRewards.InvalidAddress.selector);
        new AntseedSellerUsageRewards(address(0), address(sellerPools), address(usageAccounting), programId);

        vm.expectRevert(AntseedSellerUsageRewards.InvalidAddress.selector);
        new AntseedSellerUsageRewards(address(programs), address(0), address(usageAccounting), programId);

        vm.expectRevert(AntseedSellerUsageRewards.InvalidAddress.selector);
        new AntseedSellerUsageRewards(address(programs), address(sellerPools), address(0), programId);

        vm.expectRevert(AntseedSellerUsageRewards.InvalidAddress.selector);
        new AntseedSellerUsageRewards(address(programs), address(sellerPools), address(usageAccounting), bytes32(0));

        vm.expectRevert(AntseedSellerUsageRewards.InvalidAddress.selector);
        sellerUsageRewards.setEmissionsAuthority(address(0));
        sellerUsageRewards.setEmissionsAuthority(address(programs));

        sellerUsageRewards.setSellerPools(address(sellerPools));
        assertEq(address(sellerUsageRewards.sellerPools()), address(sellerPools));

        vm.expectRevert(AntseedSellerUsageRewards.InvalidAddress.selector);
        sellerUsageRewards.setUsageAccounting(address(0));
        sellerUsageRewards.setUsageAccounting(address(usageAccounting));

        programs.setRewardProgram(programId, address(sellerUsageRewards), address(0), 7_000, 4, 0, true);
        sellerUsageRewards.pause();
        assertTrue(sellerUsageRewards.paused());
        vm.expectRevert();
        sellerUsageRewards.claimStakerRewards(1, _epochList(4), seller);
        sellerUsageRewards.unpause();
        assertFalse(sellerUsageRewards.paused());
    }

    function test_gateEffectiveEpochIsCurrentEpochPlusOneAtDeployment() public {
        vm.warp(GATE_GENESIS + GATE_EPOCH_DURATION * 10 + 1);
        AntseedEmissionsGate deployedGate = new AntseedEmissionsGate();
        assertEq(deployedGate.currentEpoch(), 10);
        assertEq(deployedGate.effectiveEpoch(), 11);
    }
}
