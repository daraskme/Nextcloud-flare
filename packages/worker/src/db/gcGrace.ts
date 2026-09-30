/** Source objects outlive every eligible 35-day logical backup (and 30-day Time Travel). */
export const GC_GRACE_MS = 35 * 86_400_000;
// D1's seconds clock truncates milliseconds; advance a second to avoid early collection.
// Keep migration 0039's existing-candidate/last-reference deadlines in sync.
export const GC_NOT_BEFORE_SQL = `strftime('%s','now')*1000+${GC_GRACE_MS + 1_000}`;
