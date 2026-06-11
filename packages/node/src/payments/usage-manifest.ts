import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256 } from 'ethers';

const encoder = new TextEncoder();
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export interface UsageManifestRecordInput {
  requestId: string;
  service?: string;
  costUsdc: bigint;
  cumulativeCostUsdc: bigint;
  inputTokens: number | bigint;
  cachedInputTokens: number | bigint;
  freshInputTokens: number | bigint;
  outputTokens: number | bigint;
  inputBody: Uint8Array;
  outputBody: Uint8Array;
}

export interface UsageManifestRecord {
  requestId: string;
  service?: string;
  costUsdc: string;
  cumulativeCostUsdc: string;
  inputTokens: string;
  cachedInputTokens: string;
  freshInputTokens: string;
  outputTokens: string;
  inputSha256: string;
  outputSha256: string;
}

export type UsageLeaf = UsageManifestRecord;

export const ZERO_USAGE_ROOT = `0x${'00'.repeat(32)}`;

export interface UsageLeafBatch {
  version: 1;
  prevRoot: string;
  usageRoot: string;
  leaves: UsageLeaf[];
}

export interface UsageManifestServiceTotals {
  costUsdc: string;
  inputTokens: string;
  cachedInputTokens: string;
  freshInputTokens: string;
  outputTokens: string;
  requestCount: string;
}

export interface UsageManifest {
  version: 1;
  channelId: string;
  records: UsageManifestRecord[];
  totals: {
    costUsdc: string;
    inputTokens: string;
    cachedInputTokens: string;
    freshInputTokens: string;
    outputTokens: string;
    requestCount: string;
  };
  services: Record<string, UsageManifestServiceTotals>;
}

export interface UsageManifestPointer {
  cid: string;
  usageRoot: string;
  bytes: Uint8Array;
  manifest: UsageManifest;
}

export interface UsageLeafBatchPointer {
  cid: string;
  usageRoot: string;
  bytes: Uint8Array;
  batch: UsageLeafBatch;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function buildUsageManifestRecord(input: UsageManifestRecordInput): UsageManifestRecord {
  const record: UsageManifestRecord = {
    requestId: input.requestId,
    costUsdc: input.costUsdc.toString(),
    cumulativeCostUsdc: input.cumulativeCostUsdc.toString(),
    inputTokens: BigInt(input.inputTokens).toString(),
    cachedInputTokens: BigInt(input.cachedInputTokens).toString(),
    freshInputTokens: BigInt(input.freshInputTokens).toString(),
    outputTokens: BigInt(input.outputTokens).toString(),
    inputSha256: sha256Hex(input.inputBody),
    outputSha256: sha256Hex(input.outputBody),
  };
  if (input.service) record.service = input.service;
  return record;
}

export function buildUsageManifest(channelId: string, records: UsageManifestRecord[]): UsageManifest {
  const services: Record<string, UsageManifestServiceTotals> = {};
  let costUsdc = 0n;
  let inputTokens = 0n;
  let cachedInputTokens = 0n;
  let freshInputTokens = 0n;
  let outputTokens = 0n;

  for (const record of records) {
    const service = record.service ?? 'unknown';
    const serviceTotals = services[service] ?? {
      costUsdc: '0',
      inputTokens: '0',
      cachedInputTokens: '0',
      freshInputTokens: '0',
      outputTokens: '0',
      requestCount: '0',
    };

    costUsdc += BigInt(record.costUsdc);
    inputTokens += BigInt(record.inputTokens);
    cachedInputTokens += BigInt(record.cachedInputTokens);
    freshInputTokens += BigInt(record.freshInputTokens);
    outputTokens += BigInt(record.outputTokens);

    services[service] = {
      costUsdc: (BigInt(serviceTotals.costUsdc) + BigInt(record.costUsdc)).toString(),
      inputTokens: (BigInt(serviceTotals.inputTokens) + BigInt(record.inputTokens)).toString(),
      cachedInputTokens: (BigInt(serviceTotals.cachedInputTokens) + BigInt(record.cachedInputTokens)).toString(),
      freshInputTokens: (BigInt(serviceTotals.freshInputTokens) + BigInt(record.freshInputTokens)).toString(),
      outputTokens: (BigInt(serviceTotals.outputTokens) + BigInt(record.outputTokens)).toString(),
      requestCount: (BigInt(serviceTotals.requestCount) + 1n).toString(),
    };
  }

  return {
    version: 1,
    channelId,
    records,
    totals: {
      costUsdc: costUsdc.toString(),
      inputTokens: inputTokens.toString(),
      cachedInputTokens: cachedInputTokens.toString(),
      freshInputTokens: freshInputTokens.toString(),
      outputTokens: outputTokens.toString(),
      requestCount: records.length.toString(),
    },
    services,
  };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function computeUsageLeafHash(leaf: UsageLeaf): Uint8Array {
  return createHash('sha256').update(encoder.encode(canonicalJson(leaf))).digest();
}

export function extendUsageRoot(prevRoot: string, leaf: UsageLeaf): string {
  const normalizedPrevRoot = normalizeBytes32(prevRoot);
  const prev = Buffer.from(normalizedPrevRoot.slice(2), 'hex');
  const leafHash = computeUsageLeafHash(leaf);
  return keccak256(Buffer.concat([prev, leafHash]));
}

export function computeUsageRoot(prevRoot: string, leaves: UsageLeaf[]): string {
  let root = normalizeBytes32(prevRoot);
  for (const leaf of leaves) {
    root = extendUsageRoot(root, leaf);
  }
  return root;
}

export function buildUsageLeafBatch(prevRoot: string, leaves: UsageLeaf[]): UsageLeafBatch {
  const normalizedPrevRoot = normalizeBytes32(prevRoot);
  return {
    version: 1,
    prevRoot: normalizedPrevRoot,
    usageRoot: computeUsageRoot(normalizedPrevRoot, leaves),
    leaves,
  };
}

export function computeUsageLeafBatchPointer(batch: UsageLeafBatch): UsageLeafBatchPointer {
  const bytes = encoder.encode(canonicalJson(batch));
  const hash = createHash('sha256').update(bytes).digest();
  return {
    cid: rawSha256CidV1(hash),
    usageRoot: normalizeBytes32(batch.usageRoot),
    bytes,
    batch,
  };
}

export function computeUsageManifestPointer(manifest: UsageManifest): UsageManifestPointer {
  const bytes = encoder.encode(canonicalJson(manifest));
  const hash = createHash('sha256').update(bytes).digest();
  const usageRoot = `0x${hash.toString('hex')}`;
  return {
    cid: rawSha256CidV1(hash),
    usageRoot,
    bytes,
    manifest,
  };
}

export class UsageManifestStore {
  private readonly _records = new Map<string, UsageManifestRecord[]>();
  private readonly _usageRoots = new Map<string, string>();

  constructor(private readonly _baseDir: string) {
    mkdirSync(_baseDir, { recursive: true });
  }

  getRecords(channelId: string): UsageManifestRecord[] {
    return [...this._getRecords(channelId)];
  }

  getUsageRoot(channelId: string): string {
    return this._getUsageRoot(channelId);
  }

  append(channelId: string, record: UsageManifestRecord): UsageManifestPointer {
    const records = this._getRecords(channelId);
    records.push(record);
    const dir = this._channelDir(channelId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'records.jsonl'), `${JSON.stringify(record)}\n`);
    return this._writeLatest(channelId, records);
  }

  replace(channelId: string, records: UsageManifestRecord[]): UsageManifestPointer {
    const copy = [...records];
    this._records.set(channelId, copy);
    return this._write(channelId, copy);
  }

  computePointer(channelId: string, records: UsageManifestRecord[] = this.getRecords(channelId)): UsageManifestPointer {
    return computeUsageManifestPointer(buildUsageManifest(channelId, records));
  }

  appendLeafBatch(channelId: string, batch: UsageLeafBatch): UsageLeafBatchPointer {
    const currentRoot = this._getUsageRoot(channelId);
    if (batch.prevRoot.toLowerCase() !== currentRoot.toLowerCase()) {
      throw new Error(`usage leaf batch prevRoot ${batch.prevRoot} does not match current root ${currentRoot}`);
    }
    const computedRoot = computeUsageRoot(batch.prevRoot, batch.leaves);
    if (computedRoot.toLowerCase() !== batch.usageRoot.toLowerCase()) {
      throw new Error(`usage leaf batch root mismatch`);
    }
    const records = this._getRecords(channelId);
    const dir = this._channelDir(channelId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'batches.jsonl'), `${JSON.stringify(batch)}\n`);
    appendFileSync(join(dir, 'records.jsonl'), batch.leaves.map((leaf) => JSON.stringify(leaf)).join('\n') + (batch.leaves.length > 0 ? '\n' : ''));
    writeFileSync(join(dir, 'latest-root'), batch.usageRoot);
    this._usageRoots.set(channelId, batch.usageRoot);
    records.push(...batch.leaves);
    return this.writeLeafBatch(batch);
  }

  writeLeafBatch(batch: UsageLeafBatch): UsageLeafBatchPointer {
    const pointer = computeUsageLeafBatchPointer(batch);
    const dir = this._channelDir(batch.usageRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${pointer.cid}.json`), pointer.bytes);
    return pointer;
  }

  private _write(channelId: string, records: UsageManifestRecord[]): UsageManifestPointer {
    const dir = this._channelDir(channelId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'records.jsonl'), records.map((record) => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : ''));
    return this._writeLatest(channelId, records);
  }

  private _writeLatest(channelId: string, records: UsageManifestRecord[]): UsageManifestPointer {
    const dir = this._channelDir(channelId);
    mkdirSync(dir, { recursive: true });
    const pointer = computeUsageManifestPointer(buildUsageManifest(channelId, records));
    writeFileSync(join(dir, 'latest.json'), pointer.bytes);
    return pointer;
  }

  private _getRecords(channelId: string): UsageManifestRecord[] {
    const existing = this._records.get(channelId);
    if (existing) return existing;

    const dir = this._channelDir(channelId);
    const path = join(dir, 'records.jsonl');
    let records: UsageManifestRecord[] = [];
    try {
      const raw = readFileSync(path, 'utf8').trim();
      records = raw.length === 0
        ? []
        : raw.split('\n').map((line) => JSON.parse(line) as UsageManifestRecord);
    } catch {
      records = [];
    }
    this._records.set(channelId, records);
    return records;
  }

  private _getUsageRoot(channelId: string): string {
    const existing = this._usageRoots.get(channelId);
    if (existing) return existing;

    const dir = this._channelDir(channelId);
    const path = join(dir, 'latest-root');
    let root = ZERO_USAGE_ROOT;
    try {
      const raw = readFileSync(path, 'utf8').trim();
      root = normalizeBytes32(raw);
    } catch {
      const records = this._getRecords(channelId);
      root = computeUsageRoot(ZERO_USAGE_ROOT, records);
    }
    this._usageRoots.set(channelId, root);
    return root;
  }

  private _channelDir(channelId: string): string {
    return join(this._baseDir, channelId.replace(/^0x/, ''));
  }
}

export function publishUsageLeafBatchBestEffort(pointer: UsageLeafBatchPointer): void {
  const endpoint = process.env['ANTSEED_IPFS_API_URL'];
  if (!endpoint || typeof fetch !== 'function') return;

  const form = new FormData();
  form.append('file', new Blob([pointer.bytes], { type: 'application/json' }), `${pointer.cid}.json`);
  void fetch(`${endpoint.replace(/\/$/, '')}/api/v0/add?cid-version=1&raw-leaves=true&pin=true`, {
    method: 'POST',
    body: form,
  }).catch(() => undefined);
}

export function publishUsageManifestBestEffort(pointer: UsageManifestPointer): void {
  const endpoint = process.env['ANTSEED_IPFS_API_URL'];
  if (!endpoint || typeof fetch !== 'function') return;

  const form = new FormData();
  form.append('file', new Blob([pointer.bytes], { type: 'application/json' }), `${pointer.cid}.json`);
  void fetch(`${endpoint.replace(/\/$/, '')}/api/v0/add?cid-version=1&raw-leaves=true&pin=true`, {
    method: 'POST',
    body: form,
  }).catch(() => undefined);
}

function rawSha256CidV1(hash: Buffer): string {
  const cidBytes = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), hash]);
  return `b${base32(cidBytes)}`;
}

function normalizeBytes32(value: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`expected bytes32 hex value`);
  }
  return value.toLowerCase();
}

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}
