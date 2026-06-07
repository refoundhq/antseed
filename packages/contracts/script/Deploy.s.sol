// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import {ISetRegistry, ISetWriter} from "../interfaces/IAntseedWiring.sol";
import {ANTSToken} from "../ANTSToken.sol";
import {AntseedChannels} from "../AntseedChannels.sol";
import {AntseedDeposits} from "../AntseedDeposits.sol";
import {AntseedEmissions} from "../AntseedEmissions.sol";
import {AntseedRegistry} from "../AntseedRegistry.sol";
import {AntseedStaking} from "../AntseedStaking.sol";
import {AntseedStatsV2} from "../AntseedStatsV2.sol";
import {AntseedSubPool} from "../AntseedSubPool.sol";
import {MockERC8004Registry} from "../MockERC8004Registry.sol";
import {MockUSDC} from "../MockUSDC.sol";

/**
 * @title Deploy
 * @notice Deploys the full AntSeed protocol to a local anvil chain.
 *         Uses MockERC8004Registry for local testing (on mainnet, use the real ERC-8004).
 *
 * Usage:
 *   anvil &
 *   forge script contracts/script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
 */
contract Deploy is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envOr(
            "DEPLOYER_PRIVATE_KEY",
            uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80) // anvil account 0
        );

        address protocolReserve = vm.envOr("PROTOCOL_RESERVE", vm.addr(deployerPrivateKey));
        address legacyStats = vm.envOr("LEGACY_STATS", address(0));

        // 1. MockUSDC
        vm.broadcast(deployerPrivateKey);
        address usdc = address(new MockUSDC());
        console.log("MockUSDC:             ", usdc);

        // 2. MockERC8004Registry (local testing; on mainnet use 0x8004A169...)
        vm.broadcast(deployerPrivateKey);
        address identityRegistry = address(new MockERC8004Registry());
        console.log("MockERC8004Registry:  ", identityRegistry);

        // 3. ANTSToken
        vm.broadcast(deployerPrivateKey);
        address antsToken = address(new ANTSToken());
        console.log("ANTSToken:            ", antsToken);

        // 4. AntseedRegistry (central address book)
        vm.broadcast(deployerPrivateKey);
        AntseedRegistry antseedRegistry = new AntseedRegistry();
        console.log("AntseedRegistry:      ", address(antseedRegistry));

        // 5. AntseedStaking(usdc, registry)
        vm.broadcast(deployerPrivateKey);
        address staking = address(new AntseedStaking(usdc, address(antseedRegistry)));
        console.log("AntseedStaking:       ", staking);

        // 6. AntseedDeposits(usdc)
        vm.broadcast(deployerPrivateKey);
        address deposits = address(new AntseedDeposits(usdc));
        console.log("AntseedDeposits:      ", deposits);

        // 7. AntseedChannels(registry)
        vm.broadcast(deployerPrivateKey);
        address channels = address(new AntseedChannels(address(antseedRegistry)));
        console.log("AntseedChannels:      ", channels);

        // 8. AntseedStatsV2(legacyStats)
        vm.broadcast(deployerPrivateKey);
        address stats = address(new AntseedStatsV2(legacyStats));
        console.log("AntseedStatsV2:       ", stats);

        // 9. AntseedEmissions(registry, initialEmission, epochDuration)
        vm.broadcast(deployerPrivateKey);
        address emissions = address(new AntseedEmissions(address(antseedRegistry), 5_000_000e18, 7 days));
        console.log("AntseedEmissions:     ", emissions);

        // 10. AntseedSubPool(usdc, registry)
        vm.broadcast(deployerPrivateKey);
        address subPool = address(new AntseedSubPool(usdc, address(antseedRegistry)));
        console.log("AntseedSubPool:       ", subPool);

        // ---- Wire registry ----
        vm.broadcast(deployerPrivateKey);
        antseedRegistry.setChannels(channels);
        vm.broadcast(deployerPrivateKey);
        antseedRegistry.setStats(stats);
        vm.broadcast(deployerPrivateKey);
        antseedRegistry.setDeposits(deposits);
        vm.broadcast(deployerPrivateKey);
        antseedRegistry.setStaking(staking);
        vm.broadcast(deployerPrivateKey);
        antseedRegistry.setEmissions(emissions);
        vm.broadcast(deployerPrivateKey);
        antseedRegistry.setAntsToken(antsToken);
        vm.broadcast(deployerPrivateKey);
        antseedRegistry.setIdentityRegistry(identityRegistry);
        vm.broadcast(deployerPrivateKey);
        antseedRegistry.setProtocolReserve(protocolReserve);

        // ---- Point each contract at the registry ----
        // Channels and Staking already received the registry in their constructors,
        // but we include them here for uniformity so the pattern is obvious in upgrades.
        vm.broadcast(deployerPrivateKey);
        ISetRegistry(channels).setRegistry(address(antseedRegistry));
        vm.broadcast(deployerPrivateKey);
        ISetRegistry(stats).setRegistry(address(antseedRegistry));
        vm.broadcast(deployerPrivateKey);
        ISetRegistry(deposits).setRegistry(address(antseedRegistry));
        vm.broadcast(deployerPrivateKey);
        ISetRegistry(staking).setRegistry(address(antseedRegistry));
        vm.broadcast(deployerPrivateKey);
        ISetRegistry(emissions).setRegistry(address(antseedRegistry));
        vm.broadcast(deployerPrivateKey);
        ISetRegistry(antsToken).setRegistry(address(antseedRegistry));
        vm.broadcast(deployerPrivateKey);
        ISetRegistry(subPool).setRegistry(address(antseedRegistry));

        // ---- Authorize Channels as Stats writer ----
        vm.broadcast(deployerPrivateKey);
        ISetWriter(stats).setWriter(channels, true);
        if (legacyStats != address(0)) {
            vm.broadcast(deployerPrivateKey);
            try ISetWriter(legacyStats).setWriter(stats, true) {
                console.log("Legacy stats writer:  ", stats);
            } catch {
                console.log("Legacy stats writer authorization skipped");
            }
        }

        console.log("");
        console.log("--- Protocol fully deployed and wired ---");
    }
}
