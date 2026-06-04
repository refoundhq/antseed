// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedChannels {
    enum ChannelStatus {
        None,
        Active,
        Settled,
        TimedOut
    }

    struct Channel {
        address buyer;
        address seller;
        uint128 deposit;
        uint128 settled;
        bytes32 metadataHash;
        uint256 deadline;
        uint256 settledAt;
        uint256 closeRequestedAt;
        ChannelStatus status;
    }

    struct AgentStats {
        uint64 channelCount;
        uint64 ghostCount;
        uint256 totalVolumeUsdc;
        uint64 lastSettledAt;
    }

    error InvalidAddress();
    error InvalidAmount();
    error InvalidSignature();
    error ChannelExists();
    error ChannelNotActive();
    error ChannelExpired();
    error NotAuthorized();
    error InvalidFee();
    error FirstSignCapExceeded();
    error SellerNotStaked();
    error FinalAmountBelowSettled();
    error CloseNotReady();
    error CloseAlreadyRequested();
    error TopUpThresholdNotMet();
    error TopUpAmountTooLow();

    function FIRST_SIGN_CAP() external view returns (uint256);
    function PLATFORM_FEE_BPS() external view returns (uint256);
    function registry() external view returns (address);
    function domainSeparator() external view returns (bytes32);
    function channels(bytes32 channelId)
        external
        view
        returns (
            address buyer,
            address seller,
            uint128 deposit,
            uint128 settled,
            bytes32 metadataHash,
            uint256 deadline,
            uint256 settledAt,
            uint256 closeRequestedAt,
            ChannelStatus status
        );
    function getAgentStats(uint256 agentId) external view returns (AgentStats memory);
    function activeChannelCount(address seller) external view returns (uint256);
    function computeChannelId(address buyer, address seller, bytes32 salt) external pure returns (bytes32);

    function reserve(address buyer, bytes32 salt, uint128 maxAmount, uint256 deadline, bytes calldata buyerSig)
        external;

    function topUp(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata metadata,
        bytes calldata spendingSig,
        uint128 newMaxAmount,
        uint256 deadline,
        bytes calldata reserveSig
    ) external;

    function settle(bytes32 channelId, uint128 cumulativeAmount, bytes calldata metadata, bytes calldata buyerSig)
        external;

    function close(bytes32 channelId, uint128 finalAmount, bytes calldata metadata, bytes calldata buyerSig) external;

    function requestClose(bytes32 channelId) external;

    function withdraw(bytes32 channelId) external;

    function setRegistry(address registry) external;
    function setFirstSignCap(uint256 value) external;
    function setPlatformFeeBps(uint256 value) external;
    function setTopUpSettledThresholdBps(uint256 value) external;
    function pause() external;
    function unpause() external;
}
