#!/usr/bin/env node
/**
 * Calls WordPress REST sync once (foreground). Requires WP_* in .env / env.
 * Use after `pnpm run reset-dashboard-data` or UI "Run sync".
 */
import { loadConfig } from '../config.js';
import { initWordpressModule, runWpSync } from '../lib/wordpress-sync.js';

const cfg = loadConfig();
initWordpressModule(cfg);
const result = await runWpSync();
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
