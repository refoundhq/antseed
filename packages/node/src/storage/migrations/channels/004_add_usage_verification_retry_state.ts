import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 4,
  name: 'add_usage_verification_retry_state',
  up: (db) => {
    const columns = new Set(
      (db.pragma('table_info(usage_verification_attestations)') as Array<{ name: string }>).map((column) => column.name),
    );

    if (!columns.has('attempt_count')) {
      db.exec('ALTER TABLE usage_verification_attestations ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.has('last_error')) {
      db.exec('ALTER TABLE usage_verification_attestations ADD COLUMN last_error TEXT');
    }
    if (!columns.has('next_retry_at')) {
      db.exec('ALTER TABLE usage_verification_attestations ADD COLUMN next_retry_at INTEGER NOT NULL DEFAULT 0');
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_usage_verification_attestations_retry
        ON usage_verification_attestations(status, next_retry_at, updated_at);
    `);
  },
};
