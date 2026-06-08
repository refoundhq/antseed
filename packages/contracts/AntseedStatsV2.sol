// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

import {IAntseedRegistry} from "./interfaces/IAntseedRegistry.sol";
import {IAntseedStats} from "./interfaces/IAntseedStats.sol";
import {IAntseedStaking} from "./interfaces/IAntseedStaking.sol";

/**
 * @title AntseedStatsV2
 * @notice Optional stats sink for V1 and V2 channel metadata.
 *         V2 keeps top-level commitments/totals on-chain while preserving the V1
 *         recordMetadata interface used by AntseedChannels.
 *
 *         If legacyStats is configured, this contract also forwards a
 *         V1-compatible metadata write to the already-deployed AntseedStats
 *         contract. The legacy contract must grant this V2 contract writer
 *         permission for forwarding to succeed.
 */
contract AntseedStatsV2 is IAntseedStats, Ownable {

    // ─── Structs ────────────────────────────────────────────────────
    struct ChannelMetadataSnapshot {
        uint256 totalInputTokens;
        uint256 inputTokens;
        uint256 cachedInputTokens;
        uint256 outputTokens;
        uint256 requestCount;
        uint256 amountPaid;
    }

    struct DecodedMetadata {
        uint256 version;
        bytes32 pricingCatalogRoot;
        bytes32 serviceUsageRoot;
        bytes32 receiptRoot;
        uint256 inputTokens;
        uint256 cachedInputTokens;
        uint256 outputTokens;
        uint256 requestCount;
        uint256 amountPaid;
    }

    struct VerificationRecord {
        address verifier;
        address seller;
        address buyer;
        uint256 sellerAgentId;
        uint256 cumulativeAmount;
        bytes32 channelId;
        bytes32 metadataHash;
        bytes32 pricingCatalogRoot;
        bytes32 serviceUsageRoot;
        bool accepted;
        uint64 verifiedAt;
    }

    struct ServiceUsageRow {
        bytes32 channelId;
        bytes32 serviceIdHash;
        bytes32 servicePricingHash;
        uint256 inputUsdPerMillion;
        uint256 cachedInputUsdPerMillion;
        uint256 outputUsdPerMillion;
        uint256 serviceMode;
        uint256 cumulativeInputTokens;
        uint256 cumulativeCachedInputTokens;
        uint256 cumulativeOutputTokens;
        uint256 cumulativeRequestCount;
        uint256 cumulativeAmountPaid;
    }

    struct ReportVerificationStats {
        uint256 acceptedCount;
        uint256 rejectedCount;
        uint64 lastVerifiedAt;
    }

    struct VerifierStats {
        uint256 submittedCount;
        uint256 acceptedCount;
        uint256 rejectedCount;
        uint64 lastVerifiedAt;
    }

    // ─── State Variables ────────────────────────────────────────────
    mapping(address => bool) public writers;

    mapping(uint256 => mapping(address => BuyerMetadataStats)) private _buyerMetadataStats;
    mapping(bytes32 => ChannelMetadataSnapshot) private _channelSnapshots;
    mapping(bytes32 => mapping(uint256 => VerificationRecord)) private _verificationRecords;
    mapping(bytes32 => ReportVerificationStats) private _reportVerificationStats;
    mapping(uint256 => VerifierStats) private _verifierStats;
    mapping(bytes32 => bool) public reportServiceUsageRecorded;

    IAntseedRegistry public registry;
    address public legacyStats;

    uint256 public constant MAX_SERVICE_USAGE_ROWS = 64;

    // ─── Events ─────────────────────────────────────────────────────
    event MetadataRecorded(
        uint256 indexed agentId,
        address indexed buyer,
        bytes32 indexed channelId,
        bytes32 metadataHash,
        uint256 inputTokens,
        uint256 outputTokens,
        uint256 requestCount
    );

    event MetadataV2Recorded(
        uint256 indexed agentId,
        address indexed buyer,
        bytes32 indexed channelId,
        bytes32 pricingCatalogRoot,
        bytes32 serviceUsageRoot,
        bytes32 receiptRoot,
        uint256 inputTokens,
        uint256 cachedInputTokens,
        uint256 outputTokens,
        uint256 requestCount,
        uint256 amountPaid
    );

    event LegacyStatsSet(address indexed legacyStats);
    event RegistrySet(address indexed registry);
    event LegacyMetadataForwarded(
        uint256 indexed agentId,
        address indexed buyer,
        bytes32 indexed channelId,
        bytes32 legacyMetadataHash,
        bool success
    );
    event UsageReportVerificationRecorded(
        bytes32 indexed reportHash,
        uint256 indexed sellerAgentId,
        uint256 indexed verifierAgentId,
        address seller,
        address buyer,
        address verifier,
        bytes32 channelId,
        bytes32 metadataHash,
        bytes32 pricingCatalogRoot,
        bytes32 serviceUsageRoot,
        uint256 cumulativeAmount,
        bool accepted
    );
    event UsageReportServiceUsageRecorded(
        bytes32 indexed reportHash,
        uint256 indexed sellerAgentId,
        bytes32 indexed serviceIdHash,
        bytes32 servicePricingHash,
        bytes32 channelId,
        uint256 inputUsdPerMillion,
        uint256 cachedInputUsdPerMillion,
        uint256 outputUsdPerMillion,
        uint256 serviceMode,
        uint256 cumulativeInputTokens,
        uint256 cumulativeCachedInputTokens,
        uint256 cumulativeOutputTokens,
        uint256 cumulativeRequestCount,
        uint256 cumulativeAmountPaid
    );

    // ─── Custom Errors ──────────────────────────────────────────────
    error InvalidAddress();
    error NotAuthorized();
    error RegistryNotSet();
    error VerifierIsParticipant();
    error SellerNotStaked();
    error VerifierNotStaked();
    error DuplicateVerification();
    error TooManyServiceUsageRows();
    error InvalidServiceUsageRoot();
    error UnsupportedMetadataVersion(uint256 version);

    // ─── Constructor ────────────────────────────────────────────────
    constructor(address legacyStats_) Ownable(msg.sender) {
        if (legacyStats_ != address(0)) {
            legacyStats = legacyStats_;
            emit LegacyStatsSet(legacyStats_);
        }
    }

    // ─── Views ──────────────────────────────────────────────────────
    function getBuyerMetadataStats(uint256 agentId, address buyer) external view returns (BuyerMetadataStats memory) {
        return _buyerMetadataStats[agentId][buyer];
    }

    function getUsageReportVerification(bytes32 reportHash, uint256 verifierAgentId)
        external
        view
        returns (VerificationRecord memory)
    {
        return _verificationRecords[reportHash][verifierAgentId];
    }

    function getReportVerificationStats(bytes32 reportHash) external view returns (ReportVerificationStats memory) {
        return _reportVerificationStats[reportHash];
    }

    function getVerifierStats(uint256 verifierAgentId) external view returns (VerifierStats memory) {
        return _verifierStats[verifierAgentId];
    }

    // ─── Core ───────────────────────────────────────────────────────
    function recordMetadata(
        uint256 agentId,
        address buyer,
        bytes32 channelId,
        bytes calldata metadata
    ) external {
        if (!writers[msg.sender]) revert NotAuthorized();
        if (buyer == address(0)) revert InvalidAddress();

        DecodedMetadata memory decoded = _decodeMetadata(metadata);

        ChannelMetadataSnapshot storage snapshot = _channelSnapshots[channelId];
        uint256 totalInputTokens = decoded.inputTokens;
        uint256 amountPaid = decoded.version == 1 ? snapshot.amountPaid : decoded.amountPaid;
        if (
            totalInputTokens < snapshot.totalInputTokens
                || decoded.cachedInputTokens > totalInputTokens
                || decoded.outputTokens < snapshot.outputTokens
                || decoded.requestCount < snapshot.requestCount
                || amountPaid < snapshot.amountPaid
        ) {
            return; // non-monotonic metadata — skip silently
        }

        uint256 inputDelta = totalInputTokens - snapshot.totalInputTokens;
        uint256 outputDelta = decoded.outputTokens - snapshot.outputTokens;
        uint256 requestDelta = decoded.requestCount - snapshot.requestCount;

        snapshot.totalInputTokens = totalInputTokens;
        snapshot.inputTokens = decoded.inputTokens;
        snapshot.cachedInputTokens = decoded.cachedInputTokens;
        snapshot.outputTokens = decoded.outputTokens;
        snapshot.requestCount = decoded.requestCount;
        snapshot.amountPaid = amountPaid;

        BuyerMetadataStats storage stats = _buyerMetadataStats[agentId][buyer];
        stats.totalInputTokens += inputDelta;
        stats.totalOutputTokens += outputDelta;
        stats.totalRequestCount += requestDelta;
        stats.lastUpdatedAt = uint64(block.timestamp);

        emit MetadataRecorded(
            agentId,
            buyer,
            channelId,
            keccak256(metadata),
            inputDelta,
            outputDelta,
            requestDelta
        );

        if (decoded.version == 2) {
            emit MetadataV2Recorded(
                agentId,
                buyer,
                channelId,
                decoded.pricingCatalogRoot,
                decoded.serviceUsageRoot,
                decoded.receiptRoot,
                decoded.inputTokens,
                decoded.cachedInputTokens,
                decoded.outputTokens,
                decoded.requestCount,
                amountPaid
            );
        }

        _forwardLegacyMetadata(agentId, buyer, channelId, decoded);
    }

    function recordUsageReportVerification(
        bytes32 reportHash,
        bytes32 channelId,
        address seller,
        address buyer,
        uint256 sellerAgentId,
        uint256 verifierAgentId,
        uint256 cumulativeAmount,
        bytes32 metadataHash,
        bytes32 pricingCatalogRoot,
        bytes32 serviceUsageRoot,
        bool accepted
    ) external {
        _recordUsageReportVerification(
            reportHash,
            channelId,
            seller,
            buyer,
            sellerAgentId,
            verifierAgentId,
            cumulativeAmount,
            metadataHash,
            pricingCatalogRoot,
            serviceUsageRoot,
            accepted
        );
    }

    function recordUsageReportVerificationWithServiceUsage(
        bytes32 reportHash,
        bytes32 channelId,
        address seller,
        address buyer,
        uint256 sellerAgentId,
        uint256 verifierAgentId,
        uint256 cumulativeAmount,
        bytes32 metadataHash,
        bytes32 pricingCatalogRoot,
        bytes32 serviceUsageRoot,
        bool accepted,
        ServiceUsageRow[] calldata serviceUsageRows
    ) external {
        _recordUsageReportVerification(
            reportHash,
            channelId,
            seller,
            buyer,
            sellerAgentId,
            verifierAgentId,
            cumulativeAmount,
            metadataHash,
            pricingCatalogRoot,
            serviceUsageRoot,
            accepted
        );

        if (accepted && !reportServiceUsageRecorded[reportHash]) {
            _recordReportServiceUsage(reportHash, sellerAgentId, serviceUsageRoot, serviceUsageRows);
        }
    }

    function _recordUsageReportVerification(
        bytes32 reportHash,
        bytes32 channelId,
        address seller,
        address buyer,
        uint256 sellerAgentId,
        uint256 verifierAgentId,
        uint256 cumulativeAmount,
        bytes32 metadataHash,
        bytes32 pricingCatalogRoot,
        bytes32 serviceUsageRoot,
        bool accepted
    ) internal {
        if (reportHash == bytes32(0) || channelId == bytes32(0) || seller == address(0) || buyer == address(0)) {
            revert InvalidAddress();
        }
        if (msg.sender == seller || msg.sender == buyer) revert VerifierIsParticipant();
        if (verifierAgentId == 0 || sellerAgentId == 0) revert InvalidAddress();

        VerificationRecord storage existing = _verificationRecords[reportHash][verifierAgentId];
        if (existing.verifiedAt != 0) revert DuplicateVerification();

        IAntseedStaking staking = IAntseedStaking(_stakingContract());
        if (
            !staking.isStakedAboveMin(seller)
                || staking.getAgentId(seller) != sellerAgentId
        ) {
            revert SellerNotStaked();
        }
        if (
            !staking.isStakedAboveMin(msg.sender)
                || staking.getAgentId(msg.sender) != verifierAgentId
        ) {
            revert VerifierNotStaked();
        }

        existing.verifier = msg.sender;
        existing.seller = seller;
        existing.buyer = buyer;
        existing.sellerAgentId = sellerAgentId;
        existing.cumulativeAmount = cumulativeAmount;
        existing.channelId = channelId;
        existing.metadataHash = metadataHash;
        existing.pricingCatalogRoot = pricingCatalogRoot;
        existing.serviceUsageRoot = serviceUsageRoot;
        existing.accepted = accepted;
        existing.verifiedAt = uint64(block.timestamp);

        ReportVerificationStats storage reportStats = _reportVerificationStats[reportHash];
        VerifierStats storage verifier = _verifierStats[verifierAgentId];
        verifier.submittedCount++;
        verifier.lastVerifiedAt = uint64(block.timestamp);
        reportStats.lastVerifiedAt = uint64(block.timestamp);
        if (accepted) {
            reportStats.acceptedCount++;
            verifier.acceptedCount++;
        } else {
            reportStats.rejectedCount++;
            verifier.rejectedCount++;
        }

        emit UsageReportVerificationRecorded(
            reportHash,
            sellerAgentId,
            verifierAgentId,
            seller,
            buyer,
            msg.sender,
            channelId,
            metadataHash,
            pricingCatalogRoot,
            serviceUsageRoot,
            cumulativeAmount,
            accepted
        );
    }

    function _recordReportServiceUsage(
        bytes32 reportHash,
        uint256 sellerAgentId,
        bytes32 serviceUsageRoot,
        ServiceUsageRow[] calldata serviceUsageRows
    ) internal {
        if (serviceUsageRows.length > MAX_SERVICE_USAGE_ROWS) revert TooManyServiceUsageRows();
        if (_computeServiceUsageRoot(serviceUsageRows) != serviceUsageRoot) {
            revert InvalidServiceUsageRoot();
        }

        reportServiceUsageRecorded[reportHash] = true;
        for (uint256 i = 0; i < serviceUsageRows.length; i++) {
            ServiceUsageRow calldata row = serviceUsageRows[i];
            emit UsageReportServiceUsageRecorded(
                reportHash,
                sellerAgentId,
                row.serviceIdHash,
                row.servicePricingHash,
                row.channelId,
                row.inputUsdPerMillion,
                row.cachedInputUsdPerMillion,
                row.outputUsdPerMillion,
                row.serviceMode,
                row.cumulativeInputTokens,
                row.cumulativeCachedInputTokens,
                row.cumulativeOutputTokens,
                row.cumulativeRequestCount,
                row.cumulativeAmountPaid
            );
        }
    }

    function _computeServiceUsageRoot(ServiceUsageRow[] calldata rows) internal pure returns (bytes32) {
        if (rows.length == 0) return bytes32(0);

        bytes32[] memory rowHashes = new bytes32[](rows.length);
        for (uint256 i = 0; i < rows.length; i++) {
            ServiceUsageRow calldata row = rows[i];
            rowHashes[i] = keccak256(abi.encode(
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
        return _computeMerkleRoot(rowHashes);
    }

    function _computeMerkleRoot(bytes32[] memory leaves) internal pure returns (bytes32) {
        _sortHashes(leaves);

        uint256 length = leaves.length;
        while (length > 1) {
            uint256 nextLength = (length + 1) / 2;
            bytes32[] memory nextLevel = new bytes32[](nextLength);
            for (uint256 i = 0; i < length; i += 2) {
                bytes32 left = leaves[i];
                bytes32 right = i + 1 < length ? leaves[i + 1] : left;
                nextLevel[i / 2] = _hashMerklePair(left, right);
            }
            _sortHashes(nextLevel);
            leaves = nextLevel;
            length = nextLength;
        }

        return leaves[0];
    }

    function _hashMerklePair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function _sortHashes(bytes32[] memory hashes) internal pure {
        for (uint256 i = 1; i < hashes.length; i++) {
            bytes32 key = hashes[i];
            uint256 j = i;
            while (j > 0 && hashes[j - 1] > key) {
                hashes[j] = hashes[j - 1];
                j--;
            }
            hashes[j] = key;
        }
    }

    // ─── Admin Functions ────────────────────────────────────────────
    function setWriter(address writer, bool allowed) external onlyOwner {
        if (writer == address(0)) revert InvalidAddress();
        writers[writer] = allowed;
    }

    function setRegistry(address registry_) external onlyOwner {
        if (registry_ == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(registry_);
        emit RegistrySet(registry_);
    }

    function setLegacyStats(address legacyStats_) external onlyOwner {
        legacyStats = legacyStats_;
        emit LegacyStatsSet(legacyStats_);
    }

    // ─── Internal Helpers ───────────────────────────────────────────
    function _decodeMetadata(bytes calldata metadata)
        internal
        pure
        returns (DecodedMetadata memory decoded)
    {
        (uint256 version) = abi.decode(metadata, (uint256));
        decoded.version = version;

        if (version == 1) {
            (, decoded.inputTokens, decoded.outputTokens, decoded.requestCount) =
                abi.decode(metadata, (uint256, uint256, uint256, uint256));
            return decoded;
        }

        if (version == 2) {
            (
                ,
                decoded.pricingCatalogRoot,
                decoded.serviceUsageRoot,
                decoded.receiptRoot,
                decoded.inputTokens,
                decoded.cachedInputTokens,
                decoded.outputTokens,
                decoded.requestCount,
                decoded.amountPaid
            ) = abi.decode(metadata, (uint256, bytes32, bytes32, bytes32, uint256, uint256, uint256, uint256, uint256));
            return decoded;
        }

        revert UnsupportedMetadataVersion(version);
    }

    function _forwardLegacyMetadata(
        uint256 agentId,
        address buyer,
        bytes32 channelId,
        DecodedMetadata memory decoded
    ) internal {
        address target = legacyStats;
        if (target == address(0) || target == address(this)) return;

        bytes memory legacyMetadata = abi.encode(
            uint256(1),
            decoded.inputTokens,
            decoded.outputTokens,
            decoded.requestCount
        );

        try IAntseedStats(target).recordMetadata(agentId, buyer, channelId, legacyMetadata) {
            emit LegacyMetadataForwarded(agentId, buyer, channelId, keccak256(legacyMetadata), true);
        } catch {
            emit LegacyMetadataForwarded(agentId, buyer, channelId, keccak256(legacyMetadata), false);
        }
    }

    function _stakingContract() internal view returns (address staking) {
        if (address(registry) == address(0)) revert RegistryNotSet();
        staking = registry.staking();
        if (staking == address(0)) revert RegistryNotSet();
    }
}
