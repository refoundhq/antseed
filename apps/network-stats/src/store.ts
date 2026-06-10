import Database from 'better-sqlite3';
import type { DecodedMetadataPointerRecorded, DecodedMetadataRecorded, UsageManifest } from '@antseed/node';

export type StoredUsageManifestPointer = Omit<DecodedMetadataPointerRecorded, 'metadataHash'>;

export interface SellerTotals {
  totalRequests: bigint;
  totalInputTokens: bigint;
  totalOutputTokens: bigint;
  settlementCount: number;
  firstSettledBlock: number;
  lastSettledBlock: number;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  uniqueBuyers: number;
  uniqueChannels: number;
  avgRequestsPerChannel: number;
  avgRequestsPerBuyer: number;
  lastUpdatedAt: number;
}

export interface NetworkTotals {
  totalRequests: bigint;
  totalInputTokens: bigint;
  totalOutputTokens: bigint;
  settlementCount: number;
  sellerCount: number;
  lastUpdatedAt: number | null;
}

interface SellerRow {
  total_input_tokens: string;
  total_output_tokens: string;
  total_request_count: string;
  settlement_count: number;
  first_settled_block: number | null;
  first_seen_at: number | null;
  last_seen_at: number | null;
}

interface BuyerOrChannelRow {
  total_input_tokens: string;
  total_output_tokens: string;
  total_request_count: string;
  settlement_count: number;
  first_settled_block: number;
}

interface SellerTotalsRow {
  total_request_count: string;
  total_input_tokens: string;
  total_output_tokens: string;
  settlement_count: number;
  first_settled_block: number | null;
  last_settled_block: number | null;
  first_seen_at: number | null;
  last_seen_at: number | null;
  last_updated_at: number;
}

interface UsageManifestPointerRow {
  tx_hash: string;
  log_index: number;
  agent_id: number;
  buyer: string;
  channel_id: string;
  cid: string;
  cid_bytes: string;
  usage_root: string;
  block_number: number;
}

export class SqliteStore {
  private db: Database.Database;

  // Prepared statements — compiled once in init(), reused on every applyBatch /
  // read call. Re-preparing on every invocation is measurable overhead when
  // catch-up indexing fires applyBatch many times in quick succession.
  private _selectCheckpoint!: Database.Statement<[string, string], { last_block: number; last_block_timestamp: number | null }>;
  private _upsertCheckpoint!: Database.Statement<[string, string, number, number | null]>;
  private _selectSeller!: Database.Statement<[number], SellerRow>;
  private _upsertSeller!: Database.Statement<[number, string, string, string, number, number, number, number | null, number | null, number]>;
  private _selectBuyer!: Database.Statement<[number, string], BuyerOrChannelRow>;
  private _upsertBuyer!: Database.Statement<[number, string, string, string, string, number, number, number]>;
  private _selectChannel!: Database.Statement<[number, string], BuyerOrChannelRow & { buyer: string }>;
  private _upsertChannel!: Database.Statement<[number, string, string, string, string, string, number, number, number]>;
  private _selectSellerTotals!: Database.Statement<[number], SellerTotalsRow>;
  private _selectAllSellerTotals!: Database.Statement<[], SellerTotalsRow>;
  private _countBuyers!: Database.Statement<[number], { c: number }>;
  private _countChannels!: Database.Statement<[number], { c: number }>;
  private _insertUsageManifestPointer!: Database.Statement<[string, string, string, number, number, string, string, string, string, string, number]>;
  private _selectUsageManifestPointerProcessed!: Database.Statement<[string, string, string, number], { processed_at: number | null }>;
  private _selectPendingUsageManifestPointers!: Database.Statement<[string, string, number], UsageManifestPointerRow>;
  private _markUsageManifestPointerProcessed!: Database.Statement<[number, string, string, string, number]>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
  }

  /** Creates tables if missing and compiles prepared statements. Idempotent. */
  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seller_metadata_totals (
        agent_id INTEGER PRIMARY KEY,
        total_input_tokens TEXT NOT NULL DEFAULT '0',
        total_output_tokens TEXT NOT NULL DEFAULT '0',
        total_request_count TEXT NOT NULL DEFAULT '0',
        settlement_count INTEGER NOT NULL DEFAULT 0,
        first_settled_block INTEGER,
        last_settled_block INTEGER,
        first_seen_at INTEGER,
        last_seen_at INTEGER,
        last_updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS seller_buyer_totals (
        agent_id INTEGER NOT NULL,
        buyer TEXT NOT NULL,
        total_input_tokens TEXT NOT NULL DEFAULT '0',
        total_output_tokens TEXT NOT NULL DEFAULT '0',
        total_request_count TEXT NOT NULL DEFAULT '0',
        settlement_count INTEGER NOT NULL DEFAULT 0,
        first_settled_block INTEGER NOT NULL,
        last_settled_block INTEGER NOT NULL,
        PRIMARY KEY (agent_id, buyer)
      );

      CREATE TABLE IF NOT EXISTS seller_channel_totals (
        agent_id INTEGER NOT NULL,
        channel_id TEXT NOT NULL,
        buyer TEXT NOT NULL,
        total_input_tokens TEXT NOT NULL DEFAULT '0',
        total_output_tokens TEXT NOT NULL DEFAULT '0',
        total_request_count TEXT NOT NULL DEFAULT '0',
        settlement_count INTEGER NOT NULL DEFAULT 0,
        first_settled_block INTEGER NOT NULL,
        last_settled_block INTEGER NOT NULL,
        PRIMARY KEY (agent_id, channel_id)
      );

      CREATE TABLE IF NOT EXISTS indexer_checkpoint (
        chain_id TEXT NOT NULL,
        contract_address TEXT NOT NULL,
        last_block INTEGER NOT NULL,
        last_block_timestamp INTEGER,
        PRIMARY KEY (chain_id, contract_address)
      );

      CREATE TABLE IF NOT EXISTS usage_manifest_pointers (
        chain_id TEXT NOT NULL,
        contract_address TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        agent_id INTEGER NOT NULL,
        buyer TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        cid TEXT NOT NULL,
        cid_bytes TEXT NOT NULL,
        usage_root TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        processed_at INTEGER,
        PRIMARY KEY (chain_id, contract_address, tx_hash, log_index)
      );

      CREATE TABLE IF NOT EXISTS seller_service_totals (
        agent_id INTEGER NOT NULL,
        service TEXT NOT NULL,
        total_cost_usdc TEXT NOT NULL DEFAULT '0',
        total_input_tokens TEXT NOT NULL DEFAULT '0',
        total_cached_input_tokens TEXT NOT NULL DEFAULT '0',
        total_fresh_input_tokens TEXT NOT NULL DEFAULT '0',
        total_output_tokens TEXT NOT NULL DEFAULT '0',
        total_request_count TEXT NOT NULL DEFAULT '0',
        PRIMARY KEY (agent_id, service)
      );

      CREATE TABLE IF NOT EXISTS seller_channel_service_totals (
        agent_id INTEGER NOT NULL,
        channel_id TEXT NOT NULL,
        service TEXT NOT NULL,
        total_cost_usdc TEXT NOT NULL DEFAULT '0',
        total_input_tokens TEXT NOT NULL DEFAULT '0',
        total_cached_input_tokens TEXT NOT NULL DEFAULT '0',
        total_fresh_input_tokens TEXT NOT NULL DEFAULT '0',
        total_output_tokens TEXT NOT NULL DEFAULT '0',
        total_request_count TEXT NOT NULL DEFAULT '0',
        PRIMARY KEY (agent_id, channel_id, service)
      );
    `);

    this._selectCheckpoint = this.db.prepare(
      'SELECT last_block, last_block_timestamp FROM indexer_checkpoint WHERE chain_id = ? AND contract_address = ?',
    );

    this._upsertCheckpoint = this.db.prepare(
      `INSERT INTO indexer_checkpoint (chain_id, contract_address, last_block, last_block_timestamp)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chain_id, contract_address) DO UPDATE SET
         last_block = excluded.last_block,
         last_block_timestamp = excluded.last_block_timestamp`,
    );

    this._selectSeller = this.db.prepare(
      'SELECT total_input_tokens, total_output_tokens, total_request_count, settlement_count, first_settled_block, first_seen_at, last_seen_at FROM seller_metadata_totals WHERE agent_id = ?',
    );

    this._upsertSeller = this.db.prepare(
      `INSERT OR REPLACE INTO seller_metadata_totals
         (agent_id, total_input_tokens, total_output_tokens, total_request_count,
          settlement_count, first_settled_block, last_settled_block,
          first_seen_at, last_seen_at, last_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this._selectBuyer = this.db.prepare(
      'SELECT total_input_tokens, total_output_tokens, total_request_count, settlement_count, first_settled_block FROM seller_buyer_totals WHERE agent_id = ? AND buyer = ?',
    );

    this._upsertBuyer = this.db.prepare(
      `INSERT OR REPLACE INTO seller_buyer_totals
         (agent_id, buyer, total_input_tokens, total_output_tokens, total_request_count,
          settlement_count, first_settled_block, last_settled_block)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this._selectChannel = this.db.prepare(
      'SELECT buyer, total_input_tokens, total_output_tokens, total_request_count, settlement_count, first_settled_block FROM seller_channel_totals WHERE agent_id = ? AND channel_id = ?',
    );

    this._upsertChannel = this.db.prepare(
      `INSERT OR REPLACE INTO seller_channel_totals
         (agent_id, channel_id, buyer, total_input_tokens, total_output_tokens, total_request_count,
          settlement_count, first_settled_block, last_settled_block)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this._selectSellerTotals = this.db.prepare(
      'SELECT total_request_count, total_input_tokens, total_output_tokens, settlement_count, first_settled_block, last_settled_block, first_seen_at, last_seen_at, last_updated_at FROM seller_metadata_totals WHERE agent_id = ?',
    );

    this._selectAllSellerTotals = this.db.prepare(
      'SELECT total_request_count, total_input_tokens, total_output_tokens, settlement_count, first_settled_block, last_settled_block, first_seen_at, last_seen_at, last_updated_at FROM seller_metadata_totals',
    );

    this._countBuyers = this.db.prepare(
      'SELECT COUNT(*) AS c FROM seller_buyer_totals WHERE agent_id = ?',
    );

    this._countChannels = this.db.prepare(
      'SELECT COUNT(*) AS c FROM seller_channel_totals WHERE agent_id = ?',
    );

    this._insertUsageManifestPointer = this.db.prepare(
      `INSERT OR IGNORE INTO usage_manifest_pointers
        (chain_id, contract_address, tx_hash, log_index, agent_id, buyer, channel_id,
         cid, cid_bytes, usage_root, block_number, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    );

    this._selectUsageManifestPointerProcessed = this.db.prepare(
      `SELECT processed_at FROM usage_manifest_pointers
       WHERE chain_id = ? AND contract_address = ? AND tx_hash = ? AND log_index = ?`,
    );

    this._selectPendingUsageManifestPointers = this.db.prepare(
      `SELECT tx_hash, log_index, agent_id, buyer, channel_id, cid, cid_bytes, usage_root, block_number
       FROM usage_manifest_pointers
       WHERE chain_id = ? AND contract_address = ? AND processed_at IS NULL
       ORDER BY block_number ASC, log_index ASC
       LIMIT ?`,
    );

    this._markUsageManifestPointerProcessed = this.db.prepare(
      `UPDATE usage_manifest_pointers
       SET processed_at = ?
       WHERE chain_id = ? AND contract_address = ? AND tx_hash = ? AND log_index = ?`,
    );
  }

  /** Returns last indexed block for (chainId, contractAddress), or null if no checkpoint. */
  getCheckpoint(chainId: string, contractAddress: string): number | null {
    const row = this._selectCheckpoint.get(chainId, contractAddress.toLowerCase());
    return row !== undefined ? row.last_block : null;
  }

  /**
   * Atomic transaction:
   *   1. For each event, upsert seller_metadata_totals (add deltas, track first/last block, bump count).
   *   2. Upsert seller_buyer_totals for (agentId, buyer) with the same deltas.
   *   3. Upsert seller_channel_totals for (agentId, channelId) with the same deltas.
   *   4. Insert v2 usage manifest pointer events as unprocessed retry work.
   *   5. Advance indexer_checkpoint.last_block = newCheckpoint for this (chainId, contractAddress).
   * If any step throws, the transaction is rolled back — next tick re-fetches the same range.
   *
   * Events MUST be sorted ascending by (blockNumber, logIndex) — StatsClient guarantees this.
   * first_settled_block is set only on first insert and never overwritten; last_settled_block is
   * always set to the current event's block (monotonically non-decreasing given the sort order).
   */
  applyBatch(
    chainId: string,
    contractAddress: string,
    events: DecodedMetadataRecorded[],
    newCheckpoint: number,
    blockTimestamps?: Map<number, number>,
    newCheckpointTimestamp?: number | null,
    pointerEvents: DecodedMetadataPointerRecorded[] = [],
  ): void {
    this.db.transaction(() => {
      for (const event of events) {
        // uint256 → number narrowing. In practice agentIds are sequential and small,
        // but the ERC-8004 IdentityRegistry is uint256, so guard against a pathological
        // future value that would silently collide or miss the PK lookup.
        if (event.agentId > BigInt(Number.MAX_SAFE_INTEGER)) {
          console.warn(`[store] agentId ${event.agentId} exceeds MAX_SAFE_INTEGER — skipping event`);
          continue;
        }
        const agentId = Number(event.agentId);
        const buyer = event.buyer.toLowerCase();
        const channelId = event.channelId.toLowerCase();
        const now = Math.floor(Date.now() / 1000);

        // ── seller_metadata_totals ───────────────────────────────────
        const existingSeller = this._selectSeller.get(agentId);
        const prevSellerInput = existingSeller ? BigInt(existingSeller.total_input_tokens) : 0n;
        const prevSellerOutput = existingSeller ? BigInt(existingSeller.total_output_tokens) : 0n;
        const prevSellerCount = existingSeller ? BigInt(existingSeller.total_request_count) : 0n;
        const prevSellerSettlements = existingSeller?.settlement_count ?? 0;
        const prevSellerFirstBlock = existingSeller?.first_settled_block ?? null;
        const prevSellerFirstSeen = existingSeller?.first_seen_at ?? null;
        const prevSellerLastSeen = existingSeller?.last_seen_at ?? null;
        const eventTimestamp = blockTimestamps?.get(event.blockNumber) ?? null;
        const firstSeenAt = prevSellerFirstSeen ?? eventTimestamp;
        // Events arrive sorted ascending by (blockNumber, logIndex), so the
        // current event's block is always >= the stored last_seen_at.
        const lastSeenAt = eventTimestamp ?? prevSellerLastSeen;

        this._upsertSeller.run(
          agentId,
          (prevSellerInput + event.inputTokens).toString(),
          (prevSellerOutput + event.outputTokens).toString(),
          (prevSellerCount + event.requestCount).toString(),
          prevSellerSettlements + 1,
          prevSellerFirstBlock ?? event.blockNumber,
          event.blockNumber,
          firstSeenAt,
          lastSeenAt,
          now,
        );

        // ── seller_buyer_totals ──────────────────────────────────────
        const existingBuyer = this._selectBuyer.get(agentId, buyer);
        const prevBuyerInput = existingBuyer ? BigInt(existingBuyer.total_input_tokens) : 0n;
        const prevBuyerOutput = existingBuyer ? BigInt(existingBuyer.total_output_tokens) : 0n;
        const prevBuyerCount = existingBuyer ? BigInt(existingBuyer.total_request_count) : 0n;
        const prevBuyerSettlements = existingBuyer?.settlement_count ?? 0;
        const prevBuyerFirstBlock = existingBuyer?.first_settled_block ?? event.blockNumber;

        this._upsertBuyer.run(
          agentId,
          buyer,
          (prevBuyerInput + event.inputTokens).toString(),
          (prevBuyerOutput + event.outputTokens).toString(),
          (prevBuyerCount + event.requestCount).toString(),
          prevBuyerSettlements + 1,
          prevBuyerFirstBlock,
          event.blockNumber,
        );

        // ── seller_channel_totals ────────────────────────────────────
        const existingChannel = this._selectChannel.get(agentId, channelId);
        const prevChannelInput = existingChannel ? BigInt(existingChannel.total_input_tokens) : 0n;
        const prevChannelOutput = existingChannel ? BigInt(existingChannel.total_output_tokens) : 0n;
        const prevChannelCount = existingChannel ? BigInt(existingChannel.total_request_count) : 0n;
        const prevChannelSettlements = existingChannel?.settlement_count ?? 0;
        const prevChannelFirstBlock = existingChannel?.first_settled_block ?? event.blockNumber;

        this._upsertChannel.run(
          agentId,
          channelId,
          buyer,
          (prevChannelInput + event.inputTokens).toString(),
          (prevChannelOutput + event.outputTokens).toString(),
          (prevChannelCount + event.requestCount).toString(),
          prevChannelSettlements + 1,
          prevChannelFirstBlock,
          event.blockNumber,
        );
      }

      for (const event of pointerEvents) {
        this._insertPointerEvent(chainId, contractAddress, event);
      }

      this._upsertCheckpoint.run(
        chainId,
        contractAddress.toLowerCase(),
        newCheckpoint,
        newCheckpointTimestamp ?? null,
      );
    })();
  }

  getPendingUsageManifestPointers(
    chainId: string,
    contractAddress: string,
    limit = 100,
  ): StoredUsageManifestPointer[] {
    return this._selectPendingUsageManifestPointers
      .all(chainId, contractAddress.toLowerCase(), limit)
      .map((row) => ({
        blockNumber: row.block_number,
        txHash: row.tx_hash,
        logIndex: row.log_index,
        agentId: BigInt(row.agent_id),
        buyer: row.buyer,
        channelId: row.channel_id,
        cid: row.cid,
        cidBytes: row.cid_bytes,
        usageRoot: row.usage_root,
      }));
  }

  applyUsageManifest(
    chainId: string,
    contractAddress: string,
    event: DecodedMetadataPointerRecorded | StoredUsageManifestPointer,
    manifest: UsageManifest,
    blockTimestamp?: number | null,
  ): void {
    this.db.transaction(() => {
      if (event.agentId > BigInt(Number.MAX_SAFE_INTEGER)) {
        console.warn(`[store] agentId ${event.agentId} exceeds MAX_SAFE_INTEGER — skipping usage manifest`);
        return;
      }
      const agentId = Number(event.agentId);
      const buyer = event.buyer.toLowerCase();
      const channelId = event.channelId.toLowerCase();
      const now = Math.floor(Date.now() / 1000);
      if (manifest.version !== 1 || manifest.channelId.toLowerCase() !== channelId) {
        throw new Error(`usage manifest does not match pointer channel ${channelId}`);
      }

      const inserted = this._insertPointerEvent(chainId, contractAddress, event);

      if (inserted.changes === 0) {
        const row = this._selectUsageManifestPointerProcessed.get(
          chainId,
          contractAddress.toLowerCase(),
          event.txHash.toLowerCase(),
          event.logIndex,
        );
        if (row?.processed_at != null) return;
      }

      const existingChannel = this._selectChannel.get(agentId, channelId);
      const prevChannelInput = existingChannel ? BigInt(existingChannel.total_input_tokens) : 0n;
      const prevChannelOutput = existingChannel ? BigInt(existingChannel.total_output_tokens) : 0n;
      const prevChannelCount = existingChannel ? BigInt(existingChannel.total_request_count) : 0n;
      const nextChannelInput = BigInt(manifest.totals.inputTokens);
      const nextChannelOutput = BigInt(manifest.totals.outputTokens);
      const nextChannelCount = BigInt(manifest.totals.requestCount);
      if (nextChannelInput < prevChannelInput || nextChannelOutput < prevChannelOutput || nextChannelCount < prevChannelCount) {
        throw new Error(`usage manifest regression for channel ${channelId}`);
      }

      const deltaInput = nextChannelInput - prevChannelInput;
      const deltaOutput = nextChannelOutput - prevChannelOutput;
      const deltaCount = nextChannelCount - prevChannelCount;
      const eventTimestamp = blockTimestamp ?? null;

      // v1 MetadataRecorded and v2 usage manifests are intended to be mutually
      // exclusive per settlement/channel. If a deployment emits both for the
      // same payment, token and settlement totals can double count unless the
      // indexer is taught a deployment-specific de-dup policy.
      const existingSeller = this._selectSeller.get(agentId);
      this._upsertSeller.run(
        agentId,
        ((existingSeller ? BigInt(existingSeller.total_input_tokens) : 0n) + deltaInput).toString(),
        ((existingSeller ? BigInt(existingSeller.total_output_tokens) : 0n) + deltaOutput).toString(),
        ((existingSeller ? BigInt(existingSeller.total_request_count) : 0n) + deltaCount).toString(),
        (existingSeller?.settlement_count ?? 0) + 1,
        existingSeller?.first_settled_block ?? event.blockNumber,
        event.blockNumber,
        existingSeller?.first_seen_at ?? eventTimestamp,
        eventTimestamp ?? existingSeller?.last_seen_at ?? null,
        now,
      );

      const existingBuyer = this._selectBuyer.get(agentId, buyer);
      this._upsertBuyer.run(
        agentId,
        buyer,
        ((existingBuyer ? BigInt(existingBuyer.total_input_tokens) : 0n) + deltaInput).toString(),
        ((existingBuyer ? BigInt(existingBuyer.total_output_tokens) : 0n) + deltaOutput).toString(),
        ((existingBuyer ? BigInt(existingBuyer.total_request_count) : 0n) + deltaCount).toString(),
        (existingBuyer?.settlement_count ?? 0) + 1,
        existingBuyer?.first_settled_block ?? event.blockNumber,
        event.blockNumber,
      );

      this._upsertChannel.run(
        agentId,
        channelId,
        buyer,
        nextChannelInput.toString(),
        nextChannelOutput.toString(),
        nextChannelCount.toString(),
        (existingChannel?.settlement_count ?? 0) + 1,
        existingChannel?.first_settled_block ?? event.blockNumber,
        event.blockNumber,
      );

      for (const [service, totals] of Object.entries(manifest.services)) {
        this._applyServiceManifestTotals(agentId, channelId, service, totals);
      }

      this._markUsageManifestPointerProcessed.run(
        now,
        chainId,
        contractAddress.toLowerCase(),
        event.txHash.toLowerCase(),
        event.logIndex,
      );
    })();
  }

  private _insertPointerEvent(
    chainId: string,
    contractAddress: string,
    event: DecodedMetadataPointerRecorded | StoredUsageManifestPointer,
  ): Database.RunResult {
    if (event.agentId > BigInt(Number.MAX_SAFE_INTEGER)) {
      console.warn(`[store] agentId ${event.agentId} exceeds MAX_SAFE_INTEGER — skipping usage manifest pointer`);
      return { changes: 0, lastInsertRowid: 0 };
    }
    return this._insertUsageManifestPointer.run(
      chainId,
      contractAddress.toLowerCase(),
      event.txHash.toLowerCase(),
      event.logIndex,
      Number(event.agentId),
      event.buyer.toLowerCase(),
      event.channelId.toLowerCase(),
      event.cid,
      event.cidBytes,
      event.usageRoot.toLowerCase(),
      event.blockNumber,
    );
  }

  private _applyServiceManifestTotals(
    agentId: number,
    channelId: string,
    service: string,
    totals: UsageManifest['services'][string],
  ): void {
    const selectChannelService = this.db.prepare(
      `SELECT total_cost_usdc, total_input_tokens, total_cached_input_tokens, total_fresh_input_tokens,
              total_output_tokens, total_request_count
       FROM seller_channel_service_totals
       WHERE agent_id = ? AND channel_id = ? AND service = ?`,
    );
    const prev = selectChannelService.get(agentId, channelId, service) as {
      total_cost_usdc: string;
      total_input_tokens: string;
      total_cached_input_tokens: string;
      total_fresh_input_tokens: string;
      total_output_tokens: string;
      total_request_count: string;
    } | undefined;

    const next = {
      cost: BigInt(totals.costUsdc),
      input: BigInt(totals.inputTokens),
      cached: BigInt(totals.cachedInputTokens),
      fresh: BigInt(totals.freshInputTokens),
      output: BigInt(totals.outputTokens),
      count: BigInt(totals.requestCount),
    };
    const previous = {
      cost: prev ? BigInt(prev.total_cost_usdc) : 0n,
      input: prev ? BigInt(prev.total_input_tokens) : 0n,
      cached: prev ? BigInt(prev.total_cached_input_tokens) : 0n,
      fresh: prev ? BigInt(prev.total_fresh_input_tokens) : 0n,
      output: prev ? BigInt(prev.total_output_tokens) : 0n,
      count: prev ? BigInt(prev.total_request_count) : 0n,
    };
    if (
      next.cost < previous.cost || next.input < previous.input || next.cached < previous.cached
      || next.fresh < previous.fresh || next.output < previous.output || next.count < previous.count
    ) {
      throw new Error(`usage manifest regression for service ${service}`);
    }

    this.db.prepare(
      `INSERT OR REPLACE INTO seller_channel_service_totals
        (agent_id, channel_id, service, total_cost_usdc, total_input_tokens,
         total_cached_input_tokens, total_fresh_input_tokens, total_output_tokens, total_request_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      agentId, channelId, service, next.cost.toString(), next.input.toString(),
      next.cached.toString(), next.fresh.toString(), next.output.toString(), next.count.toString(),
    );

    const aggregate = this.db.prepare(
      `SELECT total_cost_usdc, total_input_tokens, total_cached_input_tokens, total_fresh_input_tokens,
              total_output_tokens, total_request_count
       FROM seller_service_totals
       WHERE agent_id = ? AND service = ?`,
    ).get(agentId, service) as typeof prev;

    this.db.prepare(
      `INSERT OR REPLACE INTO seller_service_totals
        (agent_id, service, total_cost_usdc, total_input_tokens, total_cached_input_tokens,
         total_fresh_input_tokens, total_output_tokens, total_request_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      agentId,
      service,
      ((aggregate ? BigInt(aggregate.total_cost_usdc) : 0n) + next.cost - previous.cost).toString(),
      ((aggregate ? BigInt(aggregate.total_input_tokens) : 0n) + next.input - previous.input).toString(),
      ((aggregate ? BigInt(aggregate.total_cached_input_tokens) : 0n) + next.cached - previous.cached).toString(),
      ((aggregate ? BigInt(aggregate.total_fresh_input_tokens) : 0n) + next.fresh - previous.fresh).toString(),
      ((aggregate ? BigInt(aggregate.total_output_tokens) : 0n) + next.output - previous.output).toString(),
      ((aggregate ? BigInt(aggregate.total_request_count) : 0n) + next.count - previous.count).toString(),
    );
  }

  /** Returns last indexed block + block timestamp, or null if no checkpoint. */
  getCheckpointInfo(
    chainId: string,
    contractAddress: string,
  ): { lastBlock: number; lastBlockTimestamp: number | null } | null {
    const row = this._selectCheckpoint.get(chainId, contractAddress.toLowerCase());
    if (row === undefined) return null;
    return { lastBlock: row.last_block, lastBlockTimestamp: row.last_block_timestamp };
  }

  /** Returns cumulative totals for a single agentId, or null if never seen. */
  getSellerTotals(agentId: number): SellerTotals | null {
    const row = this._selectSellerTotals.get(agentId);
    if (row === undefined) return null;

    const uniqueBuyers = (this._countBuyers.get(agentId) ?? { c: 0 }).c;
    const uniqueChannels = (this._countChannels.get(agentId) ?? { c: 0 }).c;

    const totalRequests = BigInt(row.total_request_count);
    const avgRequestsPerBuyer =
      uniqueBuyers === 0 ? 0 : Number(totalRequests / BigInt(uniqueBuyers));
    const avgRequestsPerChannel =
      uniqueChannels === 0 ? 0 : Number(totalRequests / BigInt(uniqueChannels));

    return {
      totalRequests,
      totalInputTokens: BigInt(row.total_input_tokens),
      totalOutputTokens: BigInt(row.total_output_tokens),
      settlementCount: row.settlement_count,
      firstSettledBlock: row.first_settled_block ?? 0,
      lastSettledBlock: row.last_settled_block ?? 0,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      uniqueBuyers,
      uniqueChannels,
      avgRequestsPerChannel,
      avgRequestsPerBuyer,
      lastUpdatedAt: row.last_updated_at,
    };
  }

  /** Returns cumulative totals across all indexed sellers, including sellers not currently online. */
  getNetworkTotals(): NetworkTotals {
    let totalRequests = 0n;
    let totalInputTokens = 0n;
    let totalOutputTokens = 0n;
    let settlementCount = 0;
    let sellerCount = 0;
    let lastUpdatedAt: number | null = null;

    for (const row of this._selectAllSellerTotals.all()) {
      totalRequests += BigInt(row.total_request_count);
      totalInputTokens += BigInt(row.total_input_tokens);
      totalOutputTokens += BigInt(row.total_output_tokens);
      settlementCount += row.settlement_count;
      sellerCount += 1;
      lastUpdatedAt = Math.max(lastUpdatedAt ?? 0, row.last_updated_at);
    }

    return {
      totalRequests,
      totalInputTokens,
      totalOutputTokens,
      settlementCount,
      sellerCount,
      lastUpdatedAt,
    };
  }

  /** Closes the underlying DB handle. */
  close(): void {
    this.db.close();
  }
}
