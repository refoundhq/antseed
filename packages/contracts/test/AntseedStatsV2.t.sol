// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../AntseedStats.sol";
import "../AntseedRegistry.sol";
import "../AntseedStatsV2.sol";
import "../interfaces/IAntseedStats.sol";

contract MockStatsV2Staking {
    mapping(address => bool) public staked;
    mapping(address => uint256) public agentIds;

    function setSeller(address seller, uint256 agentId, bool isStaked) external {
        agentIds[seller] = agentId;
        staked[seller] = isStaked;
    }

    function isStakedAboveMin(address seller) external view returns (bool) {
        return staked[seller];
    }

    function getAgentId(address seller) external view returns (uint256) {
        return agentIds[seller];
    }
}

contract AntseedStatsV2Test is Test {
    AntseedStats public legacyStats;
    AntseedStatsV2 public statsV2;
    AntseedRegistry public registry;
    MockStatsV2Staking public staking;

    address public writer = address(0x2);
    address public buyer = address(0x3);
    address public seller = address(0x4);
    address public verifier = address(0x5);
    uint256 public agentId = 42;
    uint256 public verifierAgentId = 77;

    function setUp() public {
        legacyStats = new AntseedStats();
        registry = new AntseedRegistry();
        staking = new MockStatsV2Staking();
        registry.setStaking(address(staking));

        statsV2 = new AntseedStatsV2(address(legacyStats));
        statsV2.setRegistry(address(registry));

        statsV2.setWriter(writer, true);
        staking.setSeller(seller, agentId, true);
        staking.setSeller(verifier, verifierAgentId, true);
    }

    function test_recordMetadata_acceptsV1Metadata() public {
        vm.prank(writer);
        statsV2.recordMetadata(agentId, buyer, bytes32("chan-v1"), abi.encode(uint256(1), uint256(100), uint256(40), uint256(2)));

        IAntseedStats.BuyerMetadataStats memory buyerStats = statsV2.getBuyerMetadataStats(agentId, buyer);
        assertEq(buyerStats.totalInputTokens, 100);
        assertEq(buyerStats.totalOutputTokens, 40);
        assertEq(buyerStats.totalRequestCount, 2);
    }

    function test_recordMetadata_forwardsV1AsLegacyV1Metadata() public {
        legacyStats.setWriter(address(statsV2), true);

        bytes32 channelId = bytes32("chan-v1-forward");
        bytes memory metadata = abi.encode(uint256(1), uint256(100), uint256(40), uint256(2));

        vm.prank(writer);
        vm.expectEmit(true, true, true, true);
        emit AntseedStatsV2.LegacyMetadataForwarded(
            agentId,
            buyer,
            channelId,
            keccak256(metadata),
            true
        );
        statsV2.recordMetadata(agentId, buyer, channelId, metadata);

        IAntseedStats.BuyerMetadataStats memory v2BuyerStats = statsV2.getBuyerMetadataStats(agentId, buyer);
        assertEq(v2BuyerStats.totalInputTokens, 100);
        assertEq(v2BuyerStats.totalOutputTokens, 40);
        assertEq(v2BuyerStats.totalRequestCount, 2);

        IAntseedStats.BuyerMetadataStats memory legacyBuyerStats = legacyStats.getBuyerMetadataStats(agentId, buyer);
        assertEq(legacyBuyerStats.totalInputTokens, 100);
        assertEq(legacyBuyerStats.totalOutputTokens, 40);
        assertEq(legacyBuyerStats.totalRequestCount, 2);
    }

    function test_recordMetadata_allowsV2SplitAfterV1AggregateMetadata() public {
        bytes32 channelId = bytes32("chan-v1-v2");
        bytes32 pricingCatalogRoot = keccak256("pricing");
        bytes32 serviceUsageRoot = keccak256("usage");
        bytes32 receiptRoot = keccak256("receipt");
        bytes32 buyerSelectionSalt = keccak256("buyer-salt");

        vm.prank(writer);
        statsV2.recordMetadata(
            agentId,
            buyer,
            channelId,
            abi.encode(uint256(1), uint256(125), uint256(40), uint256(2))
        );

        vm.prank(writer);
        vm.expectEmit(true, true, true, true);
        emit AntseedStatsV2.MetadataV2Recorded(
            agentId,
            buyer,
            channelId,
            pricingCatalogRoot,
            serviceUsageRoot,
            receiptRoot,
            buyerSelectionSalt,
            150,
            50,
            55,
            3,
            10e6
        );
        statsV2.recordMetadata(
            agentId,
            buyer,
            channelId,
            abi.encode(
                uint256(2),
                pricingCatalogRoot,
                serviceUsageRoot,
                receiptRoot,
                buyerSelectionSalt,
                uint256(150),
                uint256(50),
                uint256(55),
                uint256(3),
                uint256(10e6)
            )
        );

        IAntseedStats.BuyerMetadataStats memory buyerStats = statsV2.getBuyerMetadataStats(agentId, buyer);
        assertEq(buyerStats.totalInputTokens, 150);
        assertEq(buyerStats.totalOutputTokens, 55);
        assertEq(buyerStats.totalRequestCount, 3);
    }

    function test_recordMetadata_decodesV2MetadataAndEmitsCommitments() public {
        bytes32 channelId = bytes32("chan-v2");
        bytes32 pricingCatalogRoot = keccak256("pricing");
        bytes32 serviceUsageRoot = keccak256("usage");
        bytes32 receiptRoot = keccak256("receipt");
        bytes32 buyerSelectionSalt = keccak256("buyer-salt");

        vm.prank(writer);
        vm.expectEmit(true, true, true, true);
        emit AntseedStatsV2.MetadataV2Recorded(
            agentId,
            buyer,
            channelId,
            pricingCatalogRoot,
            serviceUsageRoot,
            receiptRoot,
            buyerSelectionSalt,
            125,
            25,
            40,
            2,
            50e6
        );
        statsV2.recordMetadata(
            agentId,
            buyer,
            channelId,
            abi.encode(
                uint256(2),
                pricingCatalogRoot,
                serviceUsageRoot,
                receiptRoot,
                buyerSelectionSalt,
                uint256(125),
                uint256(25),
                uint256(40),
                uint256(2),
                uint256(50e6)
            )
        );

        IAntseedStats.BuyerMetadataStats memory buyerStats = statsV2.getBuyerMetadataStats(agentId, buyer);
        assertEq(buyerStats.totalInputTokens, 125);
        assertEq(buyerStats.totalOutputTokens, 40);
        assertEq(buyerStats.totalRequestCount, 2);

        vm.prank(writer);
        statsV2.recordMetadata(
            agentId,
            buyer,
            channelId,
            abi.encode(
                uint256(2),
                pricingCatalogRoot,
                serviceUsageRoot,
                receiptRoot,
                keccak256("buyer-salt-next"),
                uint256(165),
                uint256(35),
                uint256(55),
                uint256(3),
                uint256(65e6)
            )
        );

        buyerStats = statsV2.getBuyerMetadataStats(agentId, buyer);
        assertEq(buyerStats.totalInputTokens, 165);
        assertEq(buyerStats.totalOutputTokens, 55);
        assertEq(buyerStats.totalRequestCount, 3);
    }

    function test_recordMetadata_forwardsV2AsLegacyV1Metadata() public {
        legacyStats.setWriter(address(statsV2), true);

        bytes32 channelId = bytes32("chan-forward");
        vm.prank(writer);
        statsV2.recordMetadata(
            agentId,
            buyer,
            channelId,
            abi.encode(
                uint256(2),
                keccak256("pricing"),
                keccak256("usage"),
                keccak256("receipt"),
                keccak256("buyer-salt"),
                uint256(125),
                uint256(25),
                uint256(40),
                uint256(2),
                uint256(50e6)
            )
        );

        IAntseedStats.BuyerMetadataStats memory v2BuyerStats = statsV2.getBuyerMetadataStats(agentId, buyer);
        assertEq(v2BuyerStats.totalInputTokens, 125);
        assertEq(v2BuyerStats.totalOutputTokens, 40);
        assertEq(v2BuyerStats.totalRequestCount, 2);

        IAntseedStats.BuyerMetadataStats memory legacyBuyerStats = legacyStats.getBuyerMetadataStats(agentId, buyer);
        assertEq(legacyBuyerStats.totalInputTokens, 125);
        assertEq(legacyBuyerStats.totalOutputTokens, 40);
        assertEq(legacyBuyerStats.totalRequestCount, 2);
    }

    function test_recordMetadata_legacyForwardFailureDoesNotRevertV2Write() public {
        // legacyStats has not granted statsV2 writer permission.
        bytes32 channelId = bytes32("chan-forward-fail");

        vm.prank(writer);
        vm.expectEmit(true, true, true, true);
        emit AntseedStatsV2.LegacyMetadataForwarded(
            agentId,
            buyer,
            channelId,
            keccak256(abi.encode(uint256(1), uint256(125), uint256(40), uint256(2))),
            false
        );
        statsV2.recordMetadata(
            agentId,
            buyer,
            channelId,
            abi.encode(
                uint256(2),
                keccak256("pricing"),
                keccak256("usage"),
                keccak256("receipt"),
                keccak256("buyer-salt"),
                uint256(125),
                uint256(25),
                uint256(40),
                uint256(2),
                uint256(50e6)
            )
        );

        IAntseedStats.BuyerMetadataStats memory v2BuyerStats = statsV2.getBuyerMetadataStats(agentId, buyer);
        assertEq(v2BuyerStats.totalInputTokens, 125);
        assertEq(v2BuyerStats.totalOutputTokens, 40);
        assertEq(v2BuyerStats.totalRequestCount, 2);

        IAntseedStats.BuyerMetadataStats memory legacyBuyerStats = legacyStats.getBuyerMetadataStats(agentId, buyer);
        assertEq(legacyBuyerStats.totalInputTokens, 0);
        assertEq(legacyBuyerStats.totalOutputTokens, 0);
        assertEq(legacyBuyerStats.totalRequestCount, 0);
    }

    function test_recordMetadata_revert_unsupportedMetadataVersion() public {
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(AntseedStatsV2.UnsupportedMetadataVersion.selector, uint256(99)));
        statsV2.recordMetadata(agentId, buyer, bytes32("chan-1"), abi.encode(uint256(99), uint256(100), uint256(40), uint256(2)));
    }

    function test_setLegacyStats_canDisableForwarding() public {
        statsV2.setLegacyStats(address(0));
        legacyStats.setWriter(address(statsV2), true);

        vm.prank(writer);
        statsV2.recordMetadata(agentId, buyer, bytes32("chan-v1"), abi.encode(uint256(1), uint256(100), uint256(40), uint256(2)));

        IAntseedStats.BuyerMetadataStats memory legacyBuyerStats = legacyStats.getBuyerMetadataStats(agentId, buyer);
        assertEq(legacyBuyerStats.totalInputTokens, 0);
        assertEq(legacyBuyerStats.totalOutputTokens, 0);
        assertEq(legacyBuyerStats.totalRequestCount, 0);
    }

    function test_recordUsageReportVerification_recordsAcceptedVerification() public {
        bytes32 reportHash = keccak256("report");
        bytes32 channelId = keccak256("channel");
        bytes32 pricingCatalogRoot = keccak256("pricing");
        bytes32 serviceUsageRoot = keccak256("usage");
        (bytes32 metadataHash, bytes32 buyerSelectionSalt) =
            _recordMetadataCommitment(channelId, pricingCatalogRoot, serviceUsageRoot, 50e6);
        bytes32 selectionScore = _selectionScore(buyerSelectionSalt, channelId, metadataHash, verifier, verifierAgentId);

        vm.prank(verifier);
        vm.expectEmit(true, true, true, true);
        emit AntseedStatsV2.UsageReportVerificationRecorded(
            reportHash,
            agentId,
            verifierAgentId,
            seller,
            buyer,
            verifier,
            channelId,
            metadataHash,
            pricingCatalogRoot,
            serviceUsageRoot,
            selectionScore,
            50e6,
            true
        );
        statsV2.recordUsageReportVerification(
            reportHash,
            channelId,
            seller,
            buyer,
            agentId,
            verifierAgentId,
            50e6,
            metadataHash,
            pricingCatalogRoot,
            serviceUsageRoot,
            true
        );

        AntseedStatsV2.VerificationRecord memory record =
            statsV2.getUsageReportVerification(reportHash, verifierAgentId);
        assertEq(record.verifier, verifier);
        assertEq(record.seller, seller);
        assertEq(record.buyer, buyer);
        assertEq(record.sellerAgentId, agentId);
        assertEq(record.cumulativeAmount, 50e6);
        assertEq(record.selectionScore, selectionScore);
        assertEq(record.accepted, true);
        assertGt(record.verifiedAt, 0);

        AntseedStatsV2.ReportVerificationStats memory reportStats =
            statsV2.getReportVerificationStats(reportHash);
        assertEq(reportStats.acceptedCount, 1);
        assertEq(reportStats.rejectedCount, 0);

        AntseedStatsV2.VerifierStats memory verifierStats = statsV2.getVerifierStats(verifierAgentId);
        assertEq(verifierStats.submittedCount, 1);
        assertEq(verifierStats.acceptedCount, 1);
        assertEq(verifierStats.rejectedCount, 0);
    }

    function test_recordUsageReportVerificationWithServiceUsage_recordsServiceRows() public {
        bytes32 reportHash = keccak256("report-with-service");
        bytes32 channelId = keccak256("channel");
        bytes32 pricingCatalogRoot = keccak256("pricing");
        AntseedStatsV2.ServiceUsageRow[] memory rows = new AntseedStatsV2.ServiceUsageRow[](1);
        rows[0] = AntseedStatsV2.ServiceUsageRow({
            channelId: channelId,
            serviceIdHash: keccak256("service:gpt"),
            servicePricingHash: keccak256("service:gpt:pricing"),
            inputUsdPerMillion: 3,
            cachedInputUsdPerMillion: 1,
            outputUsdPerMillion: 15,
            serviceMode: 1,
            cumulativeInputTokens: 100,
            cumulativeCachedInputTokens: 20,
            cumulativeOutputTokens: 50,
            cumulativeRequestCount: 3,
            cumulativeAmountPaid: 12345
        });
        bytes32 serviceUsageRoot = _singleServiceUsageRoot(rows[0]);
        (bytes32 metadataHash, bytes32 buyerSelectionSalt) =
            _recordMetadataCommitment(channelId, pricingCatalogRoot, serviceUsageRoot, 12345);
        bytes32 selectionScore = _selectionScore(buyerSelectionSalt, channelId, metadataHash, verifier, verifierAgentId);

        vm.prank(verifier);
        vm.expectEmit(true, true, true, true);
        emit AntseedStatsV2.UsageReportVerificationRecorded(
            reportHash,
            agentId,
            verifierAgentId,
            seller,
            buyer,
            verifier,
            channelId,
            metadataHash,
            pricingCatalogRoot,
            serviceUsageRoot,
            selectionScore,
            12345,
            true
        );
        vm.expectEmit(true, true, true, true);
        emit AntseedStatsV2.UsageReportServiceUsageRecorded(
            reportHash,
            agentId,
            rows[0].serviceIdHash,
            rows[0].servicePricingHash,
            channelId,
            rows[0].inputUsdPerMillion,
            rows[0].cachedInputUsdPerMillion,
            rows[0].outputUsdPerMillion,
            rows[0].serviceMode,
            rows[0].cumulativeInputTokens,
            rows[0].cumulativeCachedInputTokens,
            rows[0].cumulativeOutputTokens,
            rows[0].cumulativeRequestCount,
            rows[0].cumulativeAmountPaid
        );
        statsV2.recordUsageReportVerificationWithServiceUsage(
            reportHash,
            channelId,
            seller,
            buyer,
            agentId,
            verifierAgentId,
            12345,
            metadataHash,
            pricingCatalogRoot,
            serviceUsageRoot,
            true,
            rows
        );

        assertTrue(statsV2.reportServiceUsageRecorded(reportHash));
    }

    function test_recordUsageReportVerificationWithServiceUsage_countsMultipleVerifiersWithoutDuplicatingServiceRows() public {
        address verifierTwo = address(0x8);
        uint256 verifierTwoAgentId = 88;
        staking.setSeller(verifierTwo, verifierTwoAgentId, true);

        bytes32 reportHash = keccak256("report-multi-verifier-service");
        bytes32 channelId = keccak256("channel");
        bytes32 pricingCatalogRoot = keccak256("pricing");
        AntseedStatsV2.ServiceUsageRow[] memory rows = new AntseedStatsV2.ServiceUsageRow[](1);
        rows[0] = AntseedStatsV2.ServiceUsageRow({
            channelId: channelId,
            serviceIdHash: keccak256("service:gpt"),
            servicePricingHash: keccak256("service:gpt:pricing"),
            inputUsdPerMillion: 3,
            cachedInputUsdPerMillion: 1,
            outputUsdPerMillion: 15,
            serviceMode: 1,
            cumulativeInputTokens: 100,
            cumulativeCachedInputTokens: 20,
            cumulativeOutputTokens: 50,
            cumulativeRequestCount: 3,
            cumulativeAmountPaid: 12345
        });
        bytes32 serviceUsageRoot = _singleServiceUsageRoot(rows[0]);
        (bytes32 metadataHash,) = _recordMetadataCommitment(channelId, pricingCatalogRoot, serviceUsageRoot, 12345);

        vm.prank(verifier);
        statsV2.recordUsageReportVerificationWithServiceUsage(
            reportHash,
            channelId,
            seller,
            buyer,
            agentId,
            verifierAgentId,
            12345,
            metadataHash,
            pricingCatalogRoot,
            serviceUsageRoot,
            true,
            rows
        );

        vm.recordLogs();
        vm.prank(verifierTwo);
        statsV2.recordUsageReportVerificationWithServiceUsage(
            reportHash,
            channelId,
            seller,
            buyer,
            agentId,
            verifierTwoAgentId,
            12345,
            metadataHash,
            pricingCatalogRoot,
            serviceUsageRoot,
            true,
            rows
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 serviceUsageTopic = keccak256(
            "UsageReportServiceUsageRecorded(bytes32,uint256,bytes32,bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)"
        );
        uint256 serviceUsageEvents = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == serviceUsageTopic) {
                serviceUsageEvents++;
            }
        }
        assertEq(serviceUsageEvents, 0);

        AntseedStatsV2.ReportVerificationStats memory reportStats =
            statsV2.getReportVerificationStats(reportHash);
        assertEq(reportStats.acceptedCount, 2);
        assertEq(reportStats.rejectedCount, 0);

        AntseedStatsV2.VerifierStats memory verifierOneStats = statsV2.getVerifierStats(verifierAgentId);
        assertEq(verifierOneStats.submittedCount, 1);
        assertEq(verifierOneStats.acceptedCount, 1);

        AntseedStatsV2.VerifierStats memory verifierTwoStats = statsV2.getVerifierStats(verifierTwoAgentId);
        assertEq(verifierTwoStats.submittedCount, 1);
        assertEq(verifierTwoStats.acceptedCount, 1);
    }

    function test_recordUsageReportVerificationWithServiceUsage_revert_invalidServiceUsageRoot() public {
        AntseedStatsV2.ServiceUsageRow[] memory rows = new AntseedStatsV2.ServiceUsageRow[](1);
        rows[0] = AntseedStatsV2.ServiceUsageRow({
            channelId: keccak256("channel"),
            serviceIdHash: keccak256("service:gpt"),
            servicePricingHash: keccak256("service:gpt:pricing"),
            inputUsdPerMillion: 3,
            cachedInputUsdPerMillion: 1,
            outputUsdPerMillion: 15,
            serviceMode: 1,
            cumulativeInputTokens: 100,
            cumulativeCachedInputTokens: 20,
            cumulativeOutputTokens: 50,
            cumulativeRequestCount: 3,
            cumulativeAmountPaid: 12345
        });
        bytes32 wrongServiceUsageRoot = keccak256("wrong-hash");
        (bytes32 metadataHash,) =
            _recordMetadataCommitment(rows[0].channelId, keccak256("pricing"), wrongServiceUsageRoot, 12345);

        vm.prank(verifier);
        vm.expectRevert(AntseedStatsV2.InvalidServiceUsageRoot.selector);
        statsV2.recordUsageReportVerificationWithServiceUsage(
            keccak256("bad-service-hash-report"),
            rows[0].channelId,
            seller,
            buyer,
            agentId,
            verifierAgentId,
            12345,
            metadataHash,
            keccak256("pricing"),
            wrongServiceUsageRoot,
            true,
            rows
        );
    }

    function test_recordUsageReportVerification_recordsRejectedVerification() public {
        bytes32 reportHash = keccak256("report-rejected");
        bytes32 channelId = keccak256("channel-rejected");
        bytes32 pricingCatalogRoot = keccak256("pricing");
        bytes32 serviceUsageRoot = keccak256("usage");
        (bytes32 metadataHash,) = _recordMetadataCommitment(channelId, pricingCatalogRoot, serviceUsageRoot, 0);

        vm.prank(verifier);
        statsV2.recordUsageReportVerification(
            reportHash,
            channelId,
            seller,
            buyer,
            agentId,
            verifierAgentId,
            0,
            metadataHash,
            pricingCatalogRoot,
            serviceUsageRoot,
            false
        );

        AntseedStatsV2.ReportVerificationStats memory reportStats =
            statsV2.getReportVerificationStats(reportHash);
        assertEq(reportStats.acceptedCount, 0);
        assertEq(reportStats.rejectedCount, 1);

        AntseedStatsV2.VerifierStats memory verifierStats = statsV2.getVerifierStats(verifierAgentId);
        assertEq(verifierStats.submittedCount, 1);
        assertEq(verifierStats.acceptedCount, 0);
        assertEq(verifierStats.rejectedCount, 1);
    }

    function test_recordUsageReportVerification_revert_duplicateVerifierAgent() public {
        bytes32 reportHash = keccak256("report-duplicate");
        bytes32 channelId = keccak256("channel-duplicate");
        bytes32 pricingCatalogRoot = keccak256("pricing");
        bytes32 serviceUsageRoot = keccak256("usage");
        (bytes32 metadataHash,) = _recordMetadataCommitment(channelId, pricingCatalogRoot, serviceUsageRoot, 0);

        vm.prank(verifier);
        statsV2.recordUsageReportVerification(
            reportHash,
            channelId,
            seller,
            buyer,
            agentId,
            verifierAgentId,
            0,
            metadataHash,
            pricingCatalogRoot,
            serviceUsageRoot,
            true
        );

        vm.prank(verifier);
        vm.expectRevert(AntseedStatsV2.DuplicateVerification.selector);
        statsV2.recordUsageReportVerification(
            reportHash,
            channelId,
            seller,
            buyer,
            agentId,
            verifierAgentId,
            0,
            metadataHash,
            pricingCatalogRoot,
            serviceUsageRoot,
            true
        );
    }

    function test_recordUsageReportVerification_revert_verifierIsParticipant() public {
        vm.prank(seller);
        vm.expectRevert(AntseedStatsV2.VerifierIsParticipant.selector);
        statsV2.recordUsageReportVerification(
            keccak256("report"),
            keccak256("channel"),
            seller,
            buyer,
            agentId,
            verifierAgentId,
            0,
            keccak256("metadata"),
            keccak256("pricing"),
            keccak256("usage"),
            true
        );
    }

    function test_recordUsageReportVerification_revert_verifierNotStakedOrAgentMismatch() public {
        address unboundVerifier = address(0x6);

        vm.prank(unboundVerifier);
        vm.expectRevert(AntseedStatsV2.VerifierNotStaked.selector);
        statsV2.recordUsageReportVerification(
            keccak256("report"),
            keccak256("channel"),
            seller,
            buyer,
            agentId,
            verifierAgentId,
            0,
            keccak256("metadata"),
            keccak256("pricing"),
            keccak256("usage"),
            true
        );
    }

    function test_recordUsageReportVerification_revert_sellerNotStakedOrAgentMismatch() public {
        address unboundSeller = address(0x7);

        vm.prank(verifier);
        vm.expectRevert(AntseedStatsV2.SellerNotStaked.selector);
        statsV2.recordUsageReportVerification(
            keccak256("report"),
            keccak256("channel"),
            unboundSeller,
            buyer,
            agentId,
            verifierAgentId,
            0,
            keccak256("metadata"),
            keccak256("pricing"),
            keccak256("usage"),
            true
        );
    }

    function _singleServiceUsageRoot(AntseedStatsV2.ServiceUsageRow memory row) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            row.channelId,
            row.serviceIdHash,
            row.servicePricingHash,
            row.inputUsdPerMillion,
            row.cachedInputUsdPerMillion,
            row.outputUsdPerMillion,
            row.serviceMode,
            row.cumulativeInputTokens,
            row.cumulativeCachedInputTokens,
            row.cumulativeOutputTokens,
            row.cumulativeRequestCount,
            row.cumulativeAmountPaid
        ));
    }

    function _recordMetadataCommitment(
        bytes32 channelId,
        bytes32 pricingCatalogRoot,
        bytes32 serviceUsageRoot,
        uint256 amountPaid
    ) internal returns (bytes32 metadataHash, bytes32 buyerSelectionSalt) {
        buyerSelectionSalt = keccak256(abi.encodePacked("buyer-selection-salt", channelId, amountPaid));
        bytes memory metadata = abi.encode(
            uint256(2),
            pricingCatalogRoot,
            serviceUsageRoot,
            bytes32(0),
            buyerSelectionSalt,
            uint256(100),
            uint256(20),
            uint256(50),
            uint256(3),
            amountPaid
        );
        metadataHash = keccak256(metadata);

        vm.prank(writer);
        statsV2.recordMetadata(agentId, buyer, channelId, metadata);
    }

    function _selectionScore(
        bytes32 buyerSelectionSalt,
        bytes32 channelId,
        bytes32 metadataHash,
        address verifierAddress,
        uint256 verifierId
    ) internal view returns (bytes32) {
        return keccak256(abi.encode(
            buyerSelectionSalt,
            channelId,
            metadataHash,
            seller,
            buyer,
            agentId,
            verifierAddress,
            verifierId
        ));
    }
}
