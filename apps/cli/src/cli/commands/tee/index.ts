import type { Command } from 'commander';
import { registerTeeGenKeyCommand } from './gen-key.js';
import { registerTeeSeedRegistryCommand } from './seed-registry.js';

/**
 * `antseed tee …` — operator tooling for the TEE approved-code (ValidSet)
 * registry: mint the registry-signer authority key and seed a live TDX seller's
 * measurement into a signed ValidSet that buyers pin.
 */
export function registerTeeCommands(program: Command): void {
  const teeCmd = program
    .command('tee')
    .description('TEE approved-code registry tooling (governance/operator)');

  registerTeeGenKeyCommand(teeCmd);
  registerTeeSeedRegistryCommand(teeCmd);
}
