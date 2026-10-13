/**
 * Database target policy shared by the server and the migration runner.
 *
 * Loopback targets (localhost, 127.0.0.1, ::1) are always allowed.
 *
 * A remote target is refused unless ALL of the following hold:
 *   - the value came from the process environment, never from a .env file;
 *   - RAF_DATABASE_REMOTE_AUTHORIZED is exactly "true" in the process environment;
 *   - RAF_DATABASE_EXPECTED_HOST and RAF_DATABASE_EXPECTED_NAME match the connection
 *     string's host and database name exactly.
 *
 * Errors name only the host and database. They never include the connection string,
 * username, or password.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function parseDatabaseTarget(connectionString) {
  let url;
  try {
    url = new URL(String(connectionString));
  } catch {
    throw new Error('Database connection string is not a valid URL.');
  }
  const host = url.hostname.toLowerCase();
  let database;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    throw new Error('Database connection string has an invalid database name.');
  }
  return { host, database, loopback: LOOPBACK_HOSTS.has(host) };
}

/**
 * @param {Object} options
 * @param {string} options.connectionString - the connection string to validate
 * @param {string} options.label - which setting this is, for error messages (e.g. POSTGRES_CONNECTION_STRING)
 * @param {'process'|'file'} options.source - where the value came from
 * @param {Object} [options.env=process.env] - process environment holding the authorization values
 * @returns {{ host: string, database: string, loopback: boolean }}
 */
export function assertDatabaseTargetAllowed({ connectionString, label, source, env = process.env }) {
  const target = parseDatabaseTarget(connectionString);
  if (target.loopback) return target;

  const where = `${label} (host=${target.host}, database=${target.database})`;

  if (source !== 'process') {
    throw new Error(
      `Refusing remote database target from .env: ${where}. ` +
      'Remote targets must be set in the process environment, not in a .env file.',
    );
  }
  if (env.RAF_DATABASE_REMOTE_AUTHORIZED !== 'true') {
    throw new Error(
      `Refusing remote database target: ${where}. ` +
      'Set RAF_DATABASE_REMOTE_AUTHORIZED=true, RAF_DATABASE_EXPECTED_HOST and RAF_DATABASE_EXPECTED_NAME ' +
      'in the process environment to authorize it.',
    );
  }
  const expectedHost = (env.RAF_DATABASE_EXPECTED_HOST ?? '').trim().toLowerCase();
  const expectedName = (env.RAF_DATABASE_EXPECTED_NAME ?? '').trim();
  if (!expectedHost || !expectedName) {
    throw new Error(
      `Refusing remote database target: ${where}. ` +
      'RAF_DATABASE_EXPECTED_HOST and RAF_DATABASE_EXPECTED_NAME are required for a remote target.',
    );
  }
  if (target.host !== expectedHost || target.database !== expectedName) {
    throw new Error(
      `Refusing remote database target: ${where} does not match the expected ` +
      `host and database name.`,
    );
  }
  return target;
}
