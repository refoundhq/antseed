// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IANTSToken } from "../interfaces/IANTSToken.sol";
import { IAntseedEmissionsGate } from "../interfaces/IAntseedEmissionsGate.sol";

/**
 * @title AntseedEmissionsGate
 * @notice Canonical ANTS mint authority and immutable emission curve.
 *
 *         Each controller address owns one minter id:
 *         keccak256(abi.encode(controller)). The id controls that controller's
 *         epoch share and minted amount.
 */
contract AntseedEmissionsGate is IAntseedEmissionsGate, Ownable2Step, ReentrancyGuard {
    address public constant ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    uint256 public constant GENESIS = 1_775_728_461;
    uint256 public constant EPOCH_DURATION = 7 days;
    uint256 public constant HALVING_INTERVAL = 104;
    uint256 public constant INITIAL_EMISSION = 5_000_000e18;
    uint256 public constant BPS_DENOMINATOR = 100_000;

    IANTSToken private immutable _antsToken;

    uint256 public immutable effectiveEpoch;
    bool public legacyEpochMintsDisabled;
    mapping(uint256 epoch => uint256 amount) public epochMinted;

    address public legacyEmissionsMinter;
    address public legacyDeposits;
    uint32 public totalMinterShareBps;
    mapping(bytes32 minterId => Minter config) public minters;
    mapping(bytes32 minterId => mapping(uint256 epoch => uint256 amount)) public minterEpochMinted;

    event LegacyEpochMintsDisabled();
    event EmissionMinted(
        bytes32 indexed minterId, address indexed controller, address indexed recipient, uint256 epoch, uint256 amount
    );
    event EmissionClaimed(
        bytes32 indexed minterId, address indexed controller, address indexed recipient, uint256 epoch, uint256 amount
    );
    event MinterSet(bytes32 indexed minterId, address indexed controller, uint32 shareBps, bool editable);
    event MinterRemoved(bytes32 indexed minterId, address indexed controller);
    event LegacyClaimsConfigSet(address indexed minter, address indexed deposits);
    event LegacyEmissionMinted(address indexed recipient, uint256 amount);

    error InvalidAddress();
    error InvalidValue();
    error EpochNotFinalized();
    error NotEmissionMinter();
    error NotLegacyEmissionsMinter();
    error MinterNotEditable();
    error BucketBudgetExceeded();
    error EpochEmissionExceeded();
    error LegacyEpochMintingDisabled();
    error LegacyEpochMintsStillEnabled();
    error MintersNotSet();
    error LegacyClaimsNotConfigured();

    constructor() Ownable(msg.sender) {
        _antsToken = IANTSToken(ANTS_TOKEN);
        uint256 epoch = block.timestamp <= GENESIS ? 0 : (block.timestamp - GENESIS) / EPOCH_DURATION;
        effectiveEpoch = epoch + 1;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        TOKEN AUTH FACADE
    // ═══════════════════════════════════════════════════════════════════

    function emissions() external view returns (address) {
        return address(this);
    }

    function antsToken() external view returns (address) {
        return address(this);
    }

    function actualAntsToken() external pure returns (address) {
        return ANTS_TOKEN;
    }

    function channels() external pure returns (address) {
        return address(0);
    }

    function deposits() external view returns (address) {
        return legacyDeposits;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        OWNER CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════

    function setMinter(address controller, uint32 shareBps, bool editable) external onlyOwner {
        _setMinter(controller, shareBps, editable);
    }

    function removeMinter(address controller) external onlyOwner {
        _removeMinter(controller);
    }

    function setLegacyClaimsConfig(address minter, address deposits_) external onlyOwner {
        if (minter == address(0) || deposits_ == address(0)) revert InvalidAddress();
        legacyEmissionsMinter = minter;
        legacyDeposits = deposits_;
        emit LegacyClaimsConfigSet(minter, deposits_);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — MINTING
    // ═══════════════════════════════════════════════════════════════════

    function mint(uint256 epoch, address recipient, uint256 amount) external nonReentrant {
        bytes32 id = minterId(msg.sender);
        _requireConfiguredMinter(id, msg.sender);
        _mintFromMinter(id, msg.sender, epoch, recipient, amount);
    }

    function claim(uint256 epoch) external nonReentrant {
        bytes32 id = minterId(msg.sender);
        Minter memory minter = _requireConfiguredMinter(id, msg.sender);
        uint256 amount = minterEpochBudget(msg.sender, epoch) - minterEpochMinted[id][epoch];
        if (amount == 0) revert InvalidValue();

        _mintFromMinter(id, msg.sender, epoch, minter.controller, amount);
        emit EmissionClaimed(id, msg.sender, minter.controller, epoch, amount);
    }

    function mint(address recipient, uint256 amount) external nonReentrant {
        if (msg.sender != legacyEmissionsMinter) revert NotLegacyEmissionsMinter();
        if (recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidValue();

        _antsToken.mint(recipient, amount);
        emit LegacyEmissionMinted(recipient, amount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function minterId(address controller) public pure returns (bytes32) {
        if (controller == address(0)) revert InvalidAddress();
        return keccak256(abi.encode(controller));
    }

    function minterConfig(address controller) external view returns (Minter memory) {
        return minters[minterId(controller)];
    }

    function minterEpochBudget(address controller, uint256 epoch) public view returns (uint256) {
        Minter memory minter = minters[minterId(controller)];
        if (minter.controller == address(0)) return 0;
        return _shareBudget(epoch, minter.shareBps);
    }

    function currentEpoch() public view returns (uint256) {
        if (block.timestamp <= GENESIS) return 0;
        return (block.timestamp - GENESIS) / EPOCH_DURATION;
    }

    function getEpochEmission(uint256 epoch) public pure returns (uint256) {
        return INITIAL_EMISSION >> (epoch / HALVING_INTERVAL);
    }

    function currentEmissionRate() external view returns (uint256) {
        return getEpochEmission(currentEpoch()) / EPOCH_DURATION;
    }

    function genesis() external pure returns (uint256) {
        return GENESIS;
    }

    function epochDuration() external pure returns (uint256) {
        return EPOCH_DURATION;
    }

    function halvingInterval() external pure returns (uint256) {
        return HALVING_INTERVAL;
    }

    function initialEmission() external pure returns (uint256) {
        return INITIAL_EMISSION;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ONE-TIME WIRING
    // ═══════════════════════════════════════════════════════════════════

    function disableLegacyEpochMints() external onlyOwner {
        if (legacyEpochMintsDisabled) revert LegacyEpochMintingDisabled();
        legacyEpochMintsDisabled = true;
        emit LegacyEpochMintsDisabled();
    }

    function renounceOwnership() public override onlyOwner {
        if (totalMinterShareBps != BPS_DENOMINATOR) revert MintersNotSet();
        if (legacyEmissionsMinter == address(0) || legacyDeposits == address(0)) revert LegacyClaimsNotConfigured();
        if (!legacyEpochMintsDisabled) revert LegacyEpochMintsStillEnabled();
        super.renounceOwnership();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _setMinter(address controller, uint32 shareBps, bool editable) internal {
        if (controller == address(0)) revert InvalidAddress();
        if (shareBps == 0) revert InvalidValue();

        bytes32 id = minterId(controller);
        Minter memory existing = minters[id];
        if (existing.controller != address(0) && !existing.editable) revert MinterNotEditable();

        uint32 previousShareBps = existing.controller == address(0) ? 0 : existing.shareBps;
        uint32 nextTotalMinterShareBps = totalMinterShareBps - previousShareBps + shareBps;
        if (nextTotalMinterShareBps > BPS_DENOMINATOR) revert InvalidValue();

        totalMinterShareBps = nextTotalMinterShareBps;
        minters[id] = Minter({ controller: controller, shareBps: shareBps, editable: editable });
        emit MinterSet(id, controller, shareBps, editable);
    }

    function _removeMinter(address controller) internal {
        if (controller == address(0)) revert InvalidAddress();

        bytes32 id = minterId(controller);
        Minter memory existing = minters[id];
        if (existing.controller == address(0)) revert NotEmissionMinter();
        if (!existing.editable) revert MinterNotEditable();

        totalMinterShareBps -= existing.shareBps;
        delete minters[id];
        emit MinterRemoved(id, controller);
    }

    function _requireConfiguredMinter(bytes32 id, address controller) internal view returns (Minter memory minter) {
        minter = minters[id];
        if (minter.controller != controller) revert NotEmissionMinter();
    }

    function _mintFromMinter(bytes32 id, address controller, uint256 epoch, address recipient, uint256 amount) internal {
        Minter memory minter = minters[id];
        if (minter.controller == address(0)) revert NotEmissionMinter();
        if (recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidValue();

        uint256 newMinterMinted = minterEpochMinted[id][epoch] + amount;
        if (newMinterMinted > _shareBudget(epoch, minter.shareBps)) revert BucketBudgetExceeded();
        minterEpochMinted[id][epoch] = newMinterMinted;

        _mintEmission(id, controller, epoch, recipient, amount);
    }

    function _mintEmission(bytes32 id, address controller, uint256 epoch, address recipient, uint256 amount) internal {
        if (epoch >= currentEpoch()) revert EpochNotFinalized();
        if (epoch < effectiveEpoch && legacyEpochMintsDisabled) revert LegacyEpochMintingDisabled();

        uint256 minted = epochMinted[epoch] + amount;
        if (minted > getEpochEmission(epoch)) revert EpochEmissionExceeded();
        epochMinted[epoch] = minted;

        _antsToken.mint(recipient, amount);
        emit EmissionMinted(id, controller, recipient, epoch, amount);
    }

    function _shareBudget(uint256 epoch, uint32 shareBps) internal pure returns (uint256) {
        return (getEpochEmission(epoch) * shareBps) / BPS_DENOMINATOR;
    }
}
