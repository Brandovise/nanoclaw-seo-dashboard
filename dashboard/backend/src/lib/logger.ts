import pino from 'pino';

/** Shared pino: stdout, respects `LOG_LEVEL` (e.g. info, debug, warn). */
export const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'nanoclaw-dashboard-api' },
});
