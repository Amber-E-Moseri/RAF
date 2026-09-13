// Provenance classification for historical metrics.
// Only SNAPSHOT and LEDGER_RECONSTRUCTED metrics are safe for historical comparison.

export const Provenance = Object.freeze({
  SNAPSHOT: 'SNAPSHOT',
  LEDGER_RECONSTRUCTED: 'LEDGER_RECONSTRUCTED',
  CURRENT_ONLY: 'CURRENT_ONLY',
  UNAVAILABLE: 'UNAVAILABLE',
});
