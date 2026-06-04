// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

import {IAntseedRegistry} from "./interfaces/IAntseedRegistry.sol";
import {IAntseedStats} from "./interfaces/IAntseedStats.sol";
import {IAntseedStaking} from "./interfaces/IAntseedStaking.sol";

/**
 * @title AntseedStatsV2
 * @notice Optional stats sink for V1 and V2 channel metadata.
 *         V2 keeps top-level roots/totals on-chain while preserving the V1
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
        uint256 freshInputTokens;
        uint256 cachedInputTokens;
        uint256 outputTokens;
        uint256 requestCount;
        uint256 amountPaid;
    }

    struct DecodedMetadata {
        uint256 version;
        bytes32 catalogRoot;
        bytes32 usageByServiceRoot;
        bytes32 receiptRoot;
        uint256 freshInputTokens;
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
        bytes32 catalogRoot;
        bytes32 usageByServiceRoot;
        bool accepted;
        uint64 verifiedAt;
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

    IAntseedRegistry public registry;
    address public legacyStats;

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
        bytes32 catalogRoot,
        bytes32 usageByServiceRoot,
        bytes32 receiptRoot,
        uint256 freshInputTokens,
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
        bytes32 catalogRoot,
        bytes32 usageByServiceRoot,
        uint256 cumulativeAmount,
        bool accepted
    );

    // ─── Custom Errors ──────────────────────────────────────────────
    error InvalidAddress();
    error NotAuthorized();
    error RegistryNotSet();
    error VerifierIsParticipant();
    error SellerNotStaked();
    error VerifierNotStaked();
    error DuplicateVerification();
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
        uint256 totalInputTokens = decoded.freshInputTokens + decoded.cachedInputTokens;
        uint256 amountPaid = decoded.version == 1 ? snapshot.amountPaid : decoded.amountPaid;
        if (
            totalInputTokens < snapshot.totalInputTokens
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
        snapshot.freshInputTokens = decoded.freshInputTokens;
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
                decoded.catalogRoot,
                decoded.usageByServiceRoot,
                decoded.receiptRoot,
                decoded.freshInputTokens,
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
        bytes32 catalogRoot,
        bytes32 usageByServiceRoot,
        bool accepted
    ) external {
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
        existing.catalogRoot = catalogRoot;
        existing.usageByServiceRoot = usageByServiceRoot;
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
            catalogRoot,
            usageByServiceRoot,
            cumulativeAmount,
            accepted
        );
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
            (, decoded.freshInputTokens, decoded.outputTokens, decoded.requestCount) =
                abi.decode(metadata, (uint256, uint256, uint256, uint256));
            return decoded;
        }

        if (version == 2) {
            (
                ,
                decoded.catalogRoot,
                decoded.usageByServiceRoot,
                decoded.receiptRoot,
                decoded.freshInputTokens,
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
            decoded.freshInputTokens + decoded.cachedInputTokens,
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
