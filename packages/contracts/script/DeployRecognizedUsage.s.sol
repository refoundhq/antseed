// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedBuyerUsageRewards } from "../emissions/AntseedBuyerUsageRewards.sol";
import { AntseedEmissionPrograms } from "../emissions/AntseedEmissionPrograms.sol";
import { AntseedEmissionsGate } from "../emissions/AntseedEmissionsGate.sol";
import { AntseedSellerOperatorUsageRewards } from "../emissions/AntseedSellerOperatorUsageRewards.sol";
import { AntseedSellerUsageRewards } from "../emissions/AntseedSellerUsageRewards.sol";
import { AntseedUsageAccounting } from "../emissions/AntseedUsageAccounting.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { AntseedBootstrapCommitmentClaimPolicy } from "../policies/AntseedBootstrapCommitmentClaimPolicy.sol";
import { AntseedSellerPools } from "../sellers/AntseedSellerPools.sol";
import { AntseedSellerRegistry } from "../sellers/AntseedSellerRegistry.sol";

interface IAntseedRegistryRecognizedUsageAdmin is IAntseedRegistry {
    function setEmissions(address emissions) external;
    function setStaking(address staking) external;
}

interface IANTSTokenMintAuthorityAdmin {
    function setRegistry(address registry) external;
    function setTransferWhitelist(address account, bool allowed) external;
}

interface IAntseedSellerRewardsPoolPolicyAdmin {
    function setSellerClaimPolicy(address policy) external;
}

/**
 * @title DeployRecognizedUsage
 * @notice Deploys the seller-pool / recognized-usage stack and cuts the
 *         registry emissions pointer to usage accounting. ANTS mint authority
 *         is cut separately by pointing the token at AntseedEmissionsGate.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY   Owner/broadcaster key.
 *   ANTSEED_REGISTRY       Existing AntseedRegistry address.
 *
 * Optional env:
 *   SELLER_POOL_USAGE_PROGRAM_SHARE_BPS      Defaults to 6000.
 *   SELLER_OPERATOR_USAGE_PROGRAM_SHARE_BPS  Defaults to 500.
 *   BUYER_USAGE_PROGRAM_SHARE_BPS     Defaults to 500.
 *   TEAM_PROGRAM_SHARE_BPS            Defaults to 1500.
 *   RESERVE_PROGRAM_SHARE_BPS         Defaults to 1500.
 *   SELLER_REWARDS_POOL               Optional existing locked seller rewards pool for bootstrap commitments.
 *   POOL_MAX_APY_BPS                  Reward APY cap in bps. Defaults to 1500 (15%). 0 disables.
 *   POOL_EPOCHS_PER_YEAR              Epochs per year for the APY cap. Defaults to 52.
 *   BOOTSTRAP_COMMITMENT_CAP          Max locked seller rewards usable as bootstrap. Defaults to 1,000,000 ANTS.
 *   BOOTSTRAP_WEIGHT_BPS              Bootstrap effective weight. Defaults to 5000 (50%).
 *
 * Usage:
 *   cd packages/contracts
 *   source .env
 *   forge script script/DeployRecognizedUsage.s.sol \
 *     --rpc-url $BASE_MAINNET_RPC_URL \
 *     --broadcast \
 *     --verify \
 *     --etherscan-api-key $BASESCAN_API_KEY \
 *     --via-ir
 */
contract DeployRecognizedUsage is Script {
    address public constant ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;

    bytes32 public constant SELLER_POOL_USAGE_PROGRAM = keccak256("ANTSEED_SELLER_POOL_USAGE_V1");
    bytes32 public constant SELLER_OPERATOR_USAGE_PROGRAM = keccak256("ANTSEED_SELLER_OPERATOR_USAGE_V1");
    bytes32 public constant BUYER_USAGE_PROGRAM = keccak256("ANTSEED_BUYER_USAGE_V1");
    bytes32 public constant TEAM_PROGRAM = keccak256("ANTSEED_TEAM_V1");
    bytes32 public constant RESERVE_PROGRAM = keccak256("ANTSEED_RESERVE_V1");

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address registryAddress = vm.envAddress("ANTSEED_REGISTRY");

        IAntseedRegistryRecognizedUsageAdmin registry = IAntseedRegistryRecognizedUsageAdmin(registryAddress);
        address antsToken = registry.antsToken();
        address existingEmissions = registry.emissions();
        address existingChannels = registry.channels();
        address existingStaking = registry.staking();
        require(antsToken != address(0), "ANTS token not set");
        require(antsToken == ANTS_TOKEN, "registry ANTS mismatch");
        require(existingEmissions != address(0), "existing emissions not set");
        require(existingChannels != address(0), "channels not set");

        uint256 sellerPoolUsageShare = vm.envOr("SELLER_POOL_USAGE_PROGRAM_SHARE_BPS", uint256(6_000));
        uint256 sellerOperatorUsageShare = vm.envOr("SELLER_OPERATOR_USAGE_PROGRAM_SHARE_BPS", uint256(500));
        uint256 buyerUsageShare = vm.envOr("BUYER_USAGE_PROGRAM_SHARE_BPS", uint256(500));
        uint256 teamShare = vm.envOr("TEAM_PROGRAM_SHARE_BPS", uint256(1_500));
        uint256 reserveShare = vm.envOr("RESERVE_PROGRAM_SHARE_BPS", uint256(1_500));
        require(sellerPoolUsageShare <= 10_000, "seller pool share too high");
        require(sellerOperatorUsageShare <= 10_000, "seller operator share too high");
        require(buyerUsageShare <= 10_000, "buyer usage share too high");
        require(teamShare <= 10_000, "team share too high");
        require(reserveShare <= 10_000, "reserve share too high");
        require(
            sellerPoolUsageShare + sellerOperatorUsageShare + buyerUsageShare + teamShare + reserveShare <= 10_000,
            "program shares exceed 100%"
        );
        uint16 sellerPoolUsageShareBps = uint16(sellerPoolUsageShare);
        uint16 sellerOperatorUsageShareBps = uint16(sellerOperatorUsageShare);
        uint16 buyerUsageShareBps = uint16(buyerUsageShare);
        uint16 teamShareBps = uint16(teamShare);
        uint16 reserveShareBps = uint16(reserveShare);
        address sellerRewardsPool = vm.envOr("SELLER_REWARDS_POOL", address(0));
        uint256 poolMaxApyBps = vm.envOr("POOL_MAX_APY_BPS", uint256(1_500));
        uint256 poolEpochsPerYear = vm.envOr("POOL_EPOCHS_PER_YEAR", uint256(52));
        uint256 bootstrapCommitmentCap = vm.envOr("BOOTSTRAP_COMMITMENT_CAP", uint256(1_000_000e18));
        uint256 bootstrapWeightBps = vm.envOr("BOOTSTRAP_WEIGHT_BPS", uint256(5_000));
        address teamWallet = registry.teamWallet();
        address protocolReserve = registry.protocolReserve();
        require(teamWallet != address(0), "team wallet not set");
        require(protocolReserve != address(0), "protocol reserve not set");

        vm.startBroadcast(deployerPrivateKey);

        AntseedEmissionsGate gate = new AntseedEmissionsGate();
        uint256 currentEpoch = gate.currentEpoch();
        uint256 effectiveEpoch = gate.effectiveEpoch();
        uint256 genesis = gate.genesis();
        uint256 epochDuration = gate.epochDuration();

        console.log("=== AntSeed Recognized Usage Deployment ===");
        console.log("Deployer:               ", deployer);
        console.log("Registry:               ", registryAddress);
        console.log("ANTS Token:             ", antsToken);
        console.log("Existing Emissions:     ", existingEmissions);
        console.log("Existing Channels:      ", existingChannels);
        console.log("Existing Staking:       ", existingStaking);
        console.log("Team Wallet:            ", teamWallet);
        console.log("Protocol Reserve:       ", protocolReserve);
        console.log("Seller Rewards Pool:    ", sellerRewardsPool);
        console.log("Genesis:                ", genesis);
        console.log("Epoch Duration:         ", epochDuration);
        console.log("Current Epoch:          ", currentEpoch);
        console.log("Effective Epoch:        ", effectiveEpoch);
        console.log("");

        AntseedSellerPools sellerPools = new AntseedSellerPools(registryAddress);
        console.log("SellerPools:          ", address(sellerPools));

        // Reward shaping: cap effective APY. Seller operator rewards are paid by a separate program.
        sellerPools.setApyCap(poolMaxApyBps, poolEpochsPerYear);
        sellerPools.setBootstrapConfig(bootstrapCommitmentCap, bootstrapWeightBps);
        console.log("Pool max APY (bps):     ", poolMaxApyBps);
        console.log("Pool epochs/year:       ", poolEpochsPerYear);
        console.log("Bootstrap cap:          ", bootstrapCommitmentCap);
        console.log("Bootstrap weight (bps): ", bootstrapWeightBps);

        AntseedSellerRegistry sellerRegistry =
            new AntseedSellerRegistry(registryAddress, address(sellerPools), existingStaking);
        console.log("SellerRegistry:       ", address(sellerRegistry));

        console.log("EmissionsGate:          ", address(gate));

        AntseedEmissionPrograms programs = new AntseedEmissionPrograms(address(gate));
        console.log("EmissionPrograms:       ", address(programs));

        AntseedUsageAccounting usageAccounting =
            new AntseedUsageAccounting(address(sellerPools), existingChannels, address(gate));
        console.log("UsageAccounting:        ", address(usageAccounting));

        AntseedSellerUsageRewards sellerPoolUsageRewards = new AntseedSellerUsageRewards(
            address(programs), address(sellerPools), address(usageAccounting), SELLER_POOL_USAGE_PROGRAM
        );
        console.log("SellerPoolUsageRewards: ", address(sellerPoolUsageRewards));

        AntseedSellerOperatorUsageRewards sellerOperatorUsageRewards = new AntseedSellerOperatorUsageRewards(
            address(programs), registryAddress, address(usageAccounting), SELLER_OPERATOR_USAGE_PROGRAM
        );
        console.log("SellerOperatorRewards:  ", address(sellerOperatorUsageRewards));

        AntseedBuyerUsageRewards buyerUsageRewards =
            new AntseedBuyerUsageRewards(address(programs), registryAddress, BUYER_USAGE_PROGRAM);
        console.log("BuyerUsageRewards:      ", address(buyerUsageRewards));

        gate.setEmissionController(address(programs));
        IANTSTokenMintAuthorityAdmin(antsToken).setRegistry(address(gate));
        // SellerPools must be able to pay out withdrawals and slash to the dead
        // address even while ANTS transfers are globally disabled.
        IANTSTokenMintAuthorityAdmin(antsToken).setTransferWhitelist(address(sellerPools), true);
        buyerUsageRewards.setUsageAccounting(address(usageAccounting));
        if (sellerRewardsPool != address(0)) {
            sellerPools.setSellerRewardsPool(sellerRewardsPool);
            AntseedBootstrapCommitmentClaimPolicy bootstrapClaimPolicy =
                new AntseedBootstrapCommitmentClaimPolicy(address(sellerPools));
            IAntseedSellerRewardsPoolPolicyAdmin(sellerRewardsPool).setSellerClaimPolicy(address(bootstrapClaimPolicy));
            console.log("BootstrapClaimPolicy:   ", address(bootstrapClaimPolicy));
        }
        sellerPools.setRewardStaker(address(sellerPoolUsageRewards), true);
        programs.setRewardProgram(
            SELLER_POOL_USAGE_PROGRAM,
            address(sellerPoolUsageRewards),
            address(0),
            sellerPoolUsageShareBps,
            uint64(effectiveEpoch),
            0,
            true
        );
        programs.setRewardProgram(
            SELLER_OPERATOR_USAGE_PROGRAM,
            address(sellerOperatorUsageRewards),
            address(0),
            sellerOperatorUsageShareBps,
            uint64(effectiveEpoch),
            0,
            true
        );
        programs.setRewardProgram(
            BUYER_USAGE_PROGRAM,
            address(buyerUsageRewards),
            address(0),
            buyerUsageShareBps,
            uint64(effectiveEpoch),
            0,
            true
        );
        programs.setRewardProgram(TEAM_PROGRAM, teamWallet, teamWallet, teamShareBps, uint64(effectiveEpoch), 0, true);
        programs.setRewardProgram(
            RESERVE_PROGRAM, protocolReserve, protocolReserve, reserveShareBps, uint64(effectiveEpoch), 0, true
        );

        registry.setEmissions(address(usageAccounting));
        registry.setStaking(address(sellerRegistry));

        vm.stopBroadcast();

        console.log("");
        console.log("=== Recognized usage deployment complete ===");
        console.log("Token mint authority is:  ", address(gate));
        console.log("Programs controller is:   ", address(programs));
        console.log("Registry emissions is now:", address(usageAccounting));
        console.log("Registry staking is now:  ", address(sellerRegistry));
        console.log("Seller pool usage program:");
        console.logBytes32(SELLER_POOL_USAGE_PROGRAM);
        console.log("Seller operator usage program:");
        console.logBytes32(SELLER_OPERATOR_USAGE_PROGRAM);
        console.log("Buyer usage program:     ");
        console.logBytes32(BUYER_USAGE_PROGRAM);
        console.log("Team program:            ");
        console.logBytes32(TEAM_PROGRAM);
        console.log("Reserve program:         ");
        console.logBytes32(RESERVE_PROGRAM);
        console.log("Team program caller:     ", teamWallet);
        console.log("Reserve program caller:  ", protocolReserve);
        console.log("");
        console.log("POST-DEPLOY CHECKLIST (manual):");
        console.log("- Sellers staked in legacy USDC staking stay eligible via the");
        console.log("  SellerRegistry legacy fallback. Call setLegacyStakeEligibilityEnabled(false)");
        console.log("  only after seller pools are seeded with ANTS stake.");
        console.log("- Sellers cannot stake ANTS into pools until they are transfer-");
        console.log("  whitelisted or transfers are enabled.");
        console.log("- Audit legacy EmissionsV2 for unclaimed rewards: they can no longer");
        console.log("  mint. If any exist, configure a capped legacy-epoch program, then");
        console.log("  call gate.disableLegacyEpochMints(). If none, disable immediately.");
    }
}
