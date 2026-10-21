/**
 * Runtime configuration. Everything is overridable through environment variables
 * so the same build runs against the real Hypixel API or the local mock.
 */
function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got "${v}"`);
  return n;
}
function str(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

export const config = {
  /** Base URL of the Hypixel API. Point at the mock server for offline testing. */
  hypixelBase: str('HYPIXEL_BASE', 'https://api.hypixel.net/v2'),
  /** Port for the web UI + WebSocket feed. */
  port: num('PORT', 3131),
  /** Where the SQLite database and settings.json live. */
  dataDir: str('DATA_DIR', './data'),
  /** Parallel HTTP connections kept open to the API. */
  connections: num('HTTP_CONNECTIONS', 32),
  /** Expected API cache refresh interval, used only as the initial guess. */
  refreshIntervalMs: num('REFRESH_INTERVAL_MS', 60_000),
  /** Start hammering page 0 this many ms before the predicted refresh. */
  preRefreshLeadMs: num('PRE_REFRESH_LEAD_MS', 2_500),
  /** Interval between page-0 probes while waiting for the refresh. */
  probeIntervalMs: num('PROBE_INTERVAL_MS', 120),
  /** Max attempts to re-fetch a page that still carries the previous lastUpdated. */
  stalePageRetries: num('STALE_PAGE_RETRIES', 10),
  stalePageRetryDelayMs: num('STALE_PAGE_RETRY_DELAY_MS', 150),
  /** Days of sales history to keep in memory for medians. */
  historyDays: num('HISTORY_DAYS', 7),
  /** Verbose logging. */
  debug: str('DEBUG', '') !== '',
};
export type Config = typeof config;
