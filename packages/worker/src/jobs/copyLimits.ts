export const COPY_EXECUTION_LIMITS = Object.freeze({
  wallMs: 25_000,
  ownerClaims: 2,
  invocations: 200,
  attempts: 10,
  r2Calls: 20_000,
  // Reads and native writes share this counter. Executor also meters D1 dispatches.
  invocationR2Calls: 112,
  d1Calls: 900,
  // Leave 60 calls for the current step, publication/receipt recovery and release.
  d1YieldCalls: 840,
  steps: 64,
  rangeBytes: 8 * 1024 * 1024,
  streamRangeBytes: 90 * 1024 * 1024,
});
