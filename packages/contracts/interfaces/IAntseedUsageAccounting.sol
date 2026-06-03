// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedUsageAccounting {
    function currentEpoch() external view returns (uint256);
    function pendingSellerAccrual() external view returns (address seller, uint256 pointsDelta);

    function accrueSellerPoints(address seller, uint256 pointsDelta) external;
    function accrueBuyerPoints(address buyer, uint256 pointsDelta) external;
    function accruePoints(bytes32 channelId, address buyer, address seller, uint256 pointsDelta) external;
    function clearPendingSellerAccrual() external;
    function setPointsPolicy(address policy) external;

    function maxRewardableVolumeLeverageBps() external view returns (uint256);
    function setMaxRewardableVolumeLeverageBps(uint256 leverageBps) external;
    function totalRawBuyerPointsByEpoch(uint256 epoch) external view returns (uint256);
    function totalRawSellerPointsByEpoch(uint256 epoch) external view returns (uint256);
    function totalRawPairPointsByEpoch(uint256 epoch) external view returns (uint256);
    function totalRawPoolPointsByEpoch(uint256 epoch) external view returns (uint256);
    function totalBuyerPoolPointsByEpoch(uint256 epoch) external view returns (uint256);
    function totalWeightedPoolPointsByEpoch(uint256 epoch) external view returns (uint256);
    function totalWeightedBuyerPointsByEpoch(uint256 epoch) external view returns (uint256);
    function totalWeightedSellerPointsByEpoch(uint256 epoch) external view returns (uint256);
    function sellerAgentIdByEpoch(uint256 epoch, address seller) external view returns (uint256);
    function rawBuyerPointsByEpoch(uint256 epoch, address buyer) external view returns (uint256);
    function rawSellerPointsByEpoch(uint256 epoch, address seller) external view returns (uint256);
    function rawBuyerSellerPointsByEpoch(uint256 epoch, address buyer, address seller)
        external
        view
        returns (uint256);
    function rawAgentPoolPointsByEpoch(uint256 epoch, uint256 agentId) external view returns (uint256);
    function rawPoolPointsByEpoch(uint256 epoch, address seller) external view returns (uint256);
    function buyerAgentPoolPointsByEpoch(uint256 epoch, address buyer, uint256 agentId)
        external
        view
        returns (uint256);
    function buyerPoolPointsByEpoch(uint256 epoch, address buyer, address seller) external view returns (uint256);
    function weightedPoolPointsByEpoch(uint256 epoch, uint256 agentId) external view returns (uint256);
    function weightedPoolPointsByEpoch(uint256 epoch, address seller) external view returns (uint256);
    function weightedSellerPointsByEpoch(uint256 epoch, address seller) external view returns (uint256);
    function weightedBuyerPointsByEpoch(uint256 epoch, address buyer) external view returns (uint256);
}
