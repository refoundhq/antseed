import type { Migration } from '../../migrate.js';
import { migration as m001 } from './001_create_tables.js';
import { migration as m002 } from './002_add_auth_sig_columns.js';
import { migration as m003 } from './003_create_usage_verification_tables.js';
import { migration as m004 } from './004_add_usage_verification_retry_state.js';

export const channelMigrations: Migration[] = [m001, m002, m003, m004];
