import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 3,
  name: 'create_service_totals',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS payment_channel_service_totals (
        session_id TEXT NOT NULL,
        service_id TEXT NOT NULL,
        cumulative_amount TEXT NOT NULL,
        cumulative_input_tokens TEXT NOT NULL,
        cumulative_cached_input_tokens TEXT NOT NULL,
        cumulative_output_tokens TEXT NOT NULL,
        cumulative_request_count TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, service_id),
        FOREIGN KEY (session_id) REFERENCES payment_channels(session_id)
      );
    `);
  },
};
