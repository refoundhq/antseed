import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import chalk from 'chalk';
import { verifyTdxQuote } from '@antseed/tee';
import {
  signValidSetWithPrivateKey,
  verifyValidSetSignature,
  type ValidSet,
  type ValidSetEntry,
} from '@antseed/tee/registry';
import type { AttestationQuote } from '@antseed/tee/attestation';

const WELLKNOWN_PATH = '/.well-known/antseed-evidence';

/** Subset of the seller's discovery descriptor we use to locate the evidence path. */
interface EvidenceDescriptor {
  scheme?: string;
  platform?: string;
  evidencePath?: string;
}

/** Subset of the seller's evidence bundle the seeder reads. Collateral is optional. */
interface EvidenceBundle {
  platform: string;
  quote: string; // base64 raw DCAP quote bytes
  measurements?: Record<string, string>;
  /** Optional inline DCAP collateral; if absent, --collateral must be supplied. */
  collateral?: Record<string, string>;
}

/**
 * `antseed tee seed-registry` — turn a LIVE TDX seller's evidence into a signed
 * approved-set entry.
 *
 * Flow: resolve the seller's evidence endpoint (`--seller-address host:port` →
 * `/.well-known/antseed-evidence` → `/evidence?nonce=`, or a direct
 * `--evidence-url`), REAL-DCAP-verify the quote with the package verifier
 * (genuine Intel TDX, debug-off, TCB acceptable), extract the canonical
 * measurement, build a `{ platform:'tdx', measurement, status:'active' }` entry,
 * sign the full ValidSet with the registry-signer private key, and write it.
 *
 * Refuses to seed anything that is not a genuine TDX quote. Merges into an
 * existing ValidSet file when `-o` already exists.
 */
export function registerTeeSeedRegistryCommand(teeCmd: Command): void {
  teeCmd
    .command('seed-registry')
    .description('REAL-DCAP-verify a live TDX seller and seed its measurement into a signed ValidSet')
    .option('--seller-address <host:port>', "seller's signaling host:port (fetches /.well-known + /evidence)")
    .option('--evidence-url <url>', 'direct URL to the seller evidence endpoint (overrides --seller-address)')
    .option('--collateral <path>', 'DCAP collateral JSON (Intel PCS/PCCS) if the evidence bundle omits it')
    .requiredOption('--key <path>', 'registry-signer private key (PKCS#8 PEM) from gen-registry-key')
    .requiredOption('-o, --out <path>', 'output ValidSet JSON file (created or merged into)')
    .option('--version <n>', 'ValidSet version number to stamp (default: bump existing or 1)', (v) => parseInt(v, 10))
    .option('--fetch-timeout-ms <n>', 'per-request fetch timeout (ms)', (v) => parseInt(v, 10), 8000)
    .action(async (options) => {
      try {
        await runSeed(options);
      } catch (err) {
        console.error(chalk.red(`seed-registry failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}

async function runSeed(options: Record<string, unknown>): Promise<void> {
  const sellerAddress = options.sellerAddress as string | undefined;
  const evidenceUrlOpt = options.evidenceUrl as string | undefined;
  const collateralPath = options.collateral as string | undefined;
  const keyPath = resolve(options.key as string);
  const outPath = resolve(options.out as string);
  const fetchTimeoutMs = options.fetchTimeoutMs as number;
  const versionOpt = options.version as number | undefined;

  if (!sellerAddress && !evidenceUrlOpt) {
    throw new Error('provide --seller-address <host:port> or --evidence-url <url>');
  }

  // 1. Resolve the evidence URL (direct, or via the seller's well-known descriptor).
  const evidenceUrl = evidenceUrlOpt
    ? appendNonce(evidenceUrlOpt)
    : await resolveEvidenceUrl(sellerAddress as string, fetchTimeoutMs);
  console.log(chalk.dim(`Fetching evidence: ${evidenceUrl}`));

  // 2. Fetch the evidence bundle.
  const bundle = await fetchJson<EvidenceBundle>(evidenceUrl, fetchTimeoutMs);
  if (bundle.platform !== 'tdx') {
    throw new Error(`seller advertises platform '${bundle.platform}', not 'tdx' — refusing to seed`);
  }

  // 3. Assemble the AttestationQuote with DCAP collateral (inline or from file).
  const collateral = await resolveCollateral(bundle, collateralPath);
  const quote: AttestationQuote = {
    platform: 'tdx',
    quote: new Uint8Array(Buffer.from(bundle.quote, 'base64')),
    reportData: new Uint8Array(0),
    measurements: bundle.measurements ?? {},
    collateral,
  };

  // 4-6. DCAP-verify the quote, derive the measurement, merge + sign the set.
  const existing = await readExistingSet(outPath);
  const privateKeyPem = await fs.readFile(keyPath, 'utf8');
  const { set: signed, tcbStatus, tcbVerdict, measurement } = buildSignedValidSet({
    quote,
    privateKeyPem,
    existing,
    version: versionOpt,
  });

  console.log(chalk.green(`✓ Genuine Intel TDX quote (TCB ${tcbStatus})`));
  if (tcbVerdict === 'warn') {
    console.log(chalk.yellow(`  ! TCB ${tcbStatus} — acceptable with a warning`));
  }
  console.log(chalk.dim(`  measurement: ${measurement}`));

  await fs.writeFile(outPath, JSON.stringify(signed, null, 2) + '\n');

  console.log('');
  console.log(chalk.green(`Wrote signed ValidSet (version ${signed.version}, ${signed.entries.length} entr${signed.entries.length === 1 ? 'y' : 'ies'}) to ${outPath}`));
  console.log(chalk.bold(`  Signer (pin in buyers): ${signed.signer}`));
}

export interface SeedResult {
  /** The freshly-signed ValidSet (entries merged, signer derived from the key). */
  set: ValidSet;
  /** Canonical measurement extracted from the verified quote. */
  measurement: string;
  /** Raw Intel TCB status string. */
  tcbStatus: string;
  /** Verifier tri-state for the TCB status. */
  tcbVerdict: 'current' | 'warn' | 'stale';
}

/**
 * Pure core of `seed-registry`: REAL-DCAP-verify a TDX quote (genuine Intel
 * signature, debug-off, TCB not stale), derive its canonical measurement, merge
 * a `{ platform:'tdx', measurement, status:'active' }` entry into any existing
 * ValidSet, and sign the result with the registry-signer private key.
 *
 * Network-free and side-effect-free so it is directly testable against the real
 * TDX quote fixture. Throws on any non-genuine / stale-TCB condition (refuses to
 * seed). `nowSecs` pins the DCAP verification time (defaults to wall clock).
 */
export function buildSignedValidSet(opts: {
  quote: AttestationQuote;
  privateKeyPem: string;
  existing?: ValidSet | undefined;
  version?: number | undefined;
  nowSecs?: number;
}): SeedResult {
  const { quote, privateKeyPem, existing, version } = opts;

  // REAL DCAP verification — throws on any non-genuine condition.
  const v = verifyTdxQuote(quote, opts.nowSecs);
  if (!v.genuine || !v.debugDisabled) {
    throw new Error('quote is not a genuine debug-off TDX quote — refusing to seed');
  }
  if (v.tcbVerdict === 'stale') {
    throw new Error(`TCB status '${v.tcbStatus}' is not acceptable — refusing to seed`);
  }

  const newEntry: ValidSetEntry = { platform: 'tdx', measurement: v.measurement, status: 'active' };
  const merged = mergeEntries(existing?.entries ?? [], newEntry);
  const nextVersion = version ?? (existing ? existing.version + 1 : 1);

  const set = signValidSetWithPrivateKey(privateKeyPem, {
    version: nextVersion,
    entries: merged,
    ...(existing?.auditUrl ? { auditUrl: existing.auditUrl } : {}),
  });

  // Self-check: the produced set must verify under its own embedded signer.
  if (!verifyValidSetSignature(set)) {
    throw new Error('internal error: produced ValidSet failed self-verification');
  }

  return { set, measurement: v.measurement, tcbStatus: v.tcbStatus, tcbVerdict: v.tcbVerdict };
}

/** Discover the seller's evidence path via /.well-known and return a nonce'd URL. */
async function resolveEvidenceUrl(sellerAddress: string, timeoutMs: number): Promise<string> {
  const base = sellerAddress.startsWith('http') ? sellerAddress : `http://${sellerAddress}`;
  const descriptor = await fetchJson<EvidenceDescriptor>(base + WELLKNOWN_PATH, timeoutMs);
  const evidencePath = typeof descriptor.evidencePath === 'string' ? descriptor.evidencePath : '/evidence';
  return appendNonce(base + evidencePath);
}

/** Append a fresh 32-byte hex nonce to an evidence URL (replay defense). */
function appendNonce(url: string): string {
  const nonce = randomBytes(32).toString('hex');
  const sep = url.includes('?') ? '&' : '?';
  return /[?&]nonce=/.test(url) ? url : `${url}${sep}nonce=${nonce}`;
}

/** Inline collateral from the bundle, else load it from a file. Required for DCAP. */
async function resolveCollateral(
  bundle: EvidenceBundle,
  collateralPath: string | undefined,
): Promise<Record<string, string>> {
  if (bundle.collateral && Object.keys(bundle.collateral).length > 0) {
    return bundle.collateral;
  }
  if (!collateralPath) {
    throw new Error(
      'evidence bundle carries no DCAP collateral — supply --collateral <path> ' +
        '(Intel PCS/PCCS TCB info + QE identity JSON) to verify the quote',
    );
  }
  const raw = await fs.readFile(resolve(collateralPath), 'utf8');
  return JSON.parse(raw) as Record<string, string>;
}

/** Read an existing ValidSet file for merge, or undefined if it does not exist. */
async function readExistingSet(outPath: string): Promise<ValidSet | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(outPath, 'utf8');
  } catch {
    return undefined;
  }
  const parsed = JSON.parse(raw) as ValidSet;
  if (typeof parsed.version !== 'number' || !Array.isArray(parsed.entries)) {
    throw new Error(`${outPath} exists but is not a valid ValidSet JSON — refusing to overwrite`);
  }
  return parsed;
}

/**
 * Merge a new entry into existing entries: replace any same-(platform,measurement)
 * entry (so re-seeding flips it back to active / refreshes it), else append.
 */
function mergeEntries(existing: ValidSetEntry[], entry: ValidSetEntry): ValidSetEntry[] {
  const m = entry.measurement.toLowerCase();
  const kept = existing.filter(
    (e) => !(e.platform === entry.platform && e.measurement.toLowerCase() === m),
  );
  return [...kept, entry];
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}
