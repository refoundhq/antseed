import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import chalk from 'chalk';
import { generateRegistryKeypair } from '@antseed/tee/registry';

/**
 * `antseed tee gen-registry-key` — mint the approved-code authority key.
 *
 * Generates an ed25519 registry-signer keypair: prints the PUBLIC key (hex) for
 * buyers to pin via `--tee-registry-signer`, and writes the PRIVATE key (PKCS#8
 * PEM) to a file the operator keeps. The private key is the sole authority that
 * can sign a ValidSet buyers will trust, so it is written with 0600 perms and
 * never printed.
 */
export function registerTeeGenKeyCommand(teeCmd: Command): void {
  teeCmd
    .command('gen-registry-key')
    .description('Generate an ed25519 registry-signer keypair (the approved-code authority key)')
    .option(
      '-o, --out <path>',
      'file to write the private key (PKCS#8 PEM) to',
      'registry-signer.key',
    )
    .option('--force', 'overwrite the private-key file if it already exists')
    .action(async (options) => {
      const outPath = resolve(options.out as string);

      if (!options.force) {
        try {
          await fs.access(outPath);
          console.error(
            chalk.red(`Error: ${outPath} already exists. Use --force to overwrite ` +
              `(this will REPLACE the registry signing authority).`),
          );
          process.exit(1);
        } catch {
          // does not exist — good to write
        }
      }

      const { publicKeyHex, privateKeyPem } = generateRegistryKeypair();

      // 0600: only the operator can read the signing authority.
      await fs.writeFile(outPath, privateKeyPem, { mode: 0o600 });

      console.log(chalk.green('Registry-signer keypair generated.'));
      console.log('');
      console.log(chalk.bold('  Public key (pin this in buyers):'));
      console.log(`    ${publicKeyHex}`);
      console.log('');
      console.log(chalk.dim(`  Private key written to: ${outPath} (keep this secret)`));
      console.log('');
      console.log(chalk.dim('  Buyers verify with:'));
      console.log(chalk.dim(`    antseed buyer start --require-tee --tee-registry-signer ${publicKeyHex} \\`));
      console.log(chalk.dim('      --tee-registry-url <validset url or path>'));
    });
}
