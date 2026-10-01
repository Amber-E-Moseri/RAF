/**
 * Test database safety: Prevent accidental mutations to production.
 *
 * Database-mutating integration tests MUST explicitly accept the test database,
 * never silently fall back to the `.env` file (which currently points at production).
 *
 * Usage (at file top):
 *   const { connectionString, maybeTest } = requireExplicitTestDb({
 *     envVar: 'POSTGRES_CONNECTION_STRING',
 *     fallbackEnvVar: 'DATABASE_URL', // optional second fallback
 *     confirmNonProd: true, // require RAF_CONFIRM_NON_PRODUCTION_DB=true
 *   });
 *   const maybeDescribe = shouldRun ? describe : describe.skip;
 *   // Use maybeTest and maybeDescribe for all test definitions.
 */

import process from 'node:process';

/**
 * Safely acquire a test database connection string.
 *
 * @param {Object} options
 * @param {string} options.envVar - Primary env var name (e.g., 'POSTGRES_CONNECTION_STRING')
 * @param {string} [options.fallbackEnvVar] - Optional second env var (e.g., 'DATABASE_URL')
 * @param {string} [options.confirmNonProd] - Require RAF_CONFIRM_NON_PRODUCTION_DB=true for non-local URLs
 * @returns {{ connectionString: string, shouldRun: boolean, maybeTest: function, databaseLabel: string }}
 */
export function requireExplicitTestDb({
  envVar,
  fallbackEnvVar = null,
  confirmNonProd = false,
} = {}) {
  // Acquire connection string from the specified env var only (no .env fallback).
  const connectionString = process.env[envVar] ?? (fallbackEnvVar ? process.env[fallbackEnvVar] : null);

  // Validation logic.
  let shouldRun = false;
  let reason = '';

  if (!connectionString) {
    reason = `${envVar} not set in environment`;
  } else if (!isLocalhost(connectionString)) {
    // Non-local database requires explicit confirmation.
    if (confirmNonProd && process.env.RAF_CONFIRM_NON_PRODUCTION_DB !== 'true') {
      reason = 'Non-local database detected but RAF_CONFIRM_NON_PRODUCTION_DB !== "true"';
    } else {
      shouldRun = true;
    }
  } else {
    // Local database, safe.
    shouldRun = true;
  }

  if (!shouldRun) {
    console.log(`[test-db-guard] Skipping: ${reason}`);
  }

  // Database label for test output (hide password).
  const databaseLabel = sanitizeUrl(connectionString);

  return {
    connectionString: shouldRun ? connectionString : null,
    shouldRun,
    maybeTest: shouldRun
      ? (name, fn) => import('node:test').then(t => t.default(name, fn))
      : (name, fn) => import('node:test').then(t => t.default.skip(name, fn)),
    databaseLabel,
  };
}

/**
 * Detect localhost (127.0.0.1, [::1], localhost).
 */
function isLocalhost(url) {
  return /@(127\.0\.0\.1|localhost|\[::1\])(:|\/)/.test(url);
}

/**
 * Redact password from a connection string for logging.
 * Converts `postgresql://user:password@host/db` → `postgresql://user@host/db`
 */
function sanitizeUrl(url) {
  if (!url) return '(no database)';
  try {
    const u = new URL(url);
    u.password = '';
    return u.toString();
  } catch {
    return url.replace(/:([^@]+)@/, ':***@');
  }
}
