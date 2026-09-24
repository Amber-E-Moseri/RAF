import fs from 'node:fs';
import path from 'node:path';

import pg from 'pg';
import { z } from 'zod';

function parseDotEnv(source) {
  const rows = String(source ?? '').split(/\r?\n/);
  const parsed = {};

  for (const row of rows) {
    const line = row.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const equalsIndex = line.indexOf('=');
    if (equalsIndex < 1) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  return parsed;
}

function loadEnvFile({ cwd = process.cwd(), filename = '.env' } = {}) {
  const envPath = path.join(cwd, filename);
  if (!fs.existsSync(envPath)) {
    return;
  }

  const parsed = parseDotEnv(fs.readFileSync(envPath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    // .env is a fallback for local development. Explicit process env always wins,
    // which lets tests force isolated SQLite even when a developer .env uses Postgres.
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

const serverEnvSchema = z.object({
  PORT: z.string().trim().optional(),
  RAF_DB_PATH: z.string().trim().optional(),
  PERSISTENCE_DRIVER: z.enum(['sqlite', 'postgres']).optional(),
  POSTGRES_CONNECTION_STRING: z.string().trim().optional(),
  // Runtime connection (raf_app role — NOSUPERUSER NOBYPASSRLS NOCREATEROLE).
  // REQUIRED when RAF_AUTH_REQUIRED=true; absence causes a startup configuration error.
  // In dev/local (RAF_AUTH_REQUIRED=false): falls back to POSTGRES_CONNECTION_STRING when absent.
  POSTGRES_CONNECTION_STRING_APP: z.string().trim().optional(),
  JWT_SECRET: z.string().trim().optional(),
  RAF_AUTH_REQUIRED: z.string().trim().optional(),
  // Error monitoring DSN. When absent, Sentry is not initialised (safe for local dev).
  SENTRY_DSN: z.string().trim().optional(),
  // Comma-separated list of allowed CORS origins in production (e.g. https://normisraf.netlify.app).
  // Localhost origins are always allowed. Set this on the backend host before the frontend goes live.
  ALLOWED_ORIGINS: z.string().trim().optional(),
  // Supabase auth integration. Both URL and anon key must be provided together.
  // When absent, Supabase auth is disabled and the server uses local JWT auth.
  SUPABASE_URL: z.string().trim().optional(),
  SUPABASE_ANON_KEY: z.string().trim().optional(),
  // Canonical public application origin used to construct absolute recovery redirect URLs
  // in Supabase password-reset emails (e.g. https://app.example.com).
  // When absent and Supabase auth is enabled, Supabase falls back to the project's
  // configured Site URL — startup is not blocked, but a warning is logged.
  RAF_APP_URL: z.string().url().optional(),
});

function parsePort(rawPort) {
  if (rawPort == null || String(rawPort).trim() === '') {
    return 3000;
  }

  const parsed = Number(rawPort);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535. Received "${rawPort}".`);
  }

  return parsed;
}

export function loadServerEnv({ cwd = process.cwd() } = {}) {
  loadEnvFile({ cwd });

  const persistenceDriver = (process.env.PERSISTENCE_DRIVER ?? 'sqlite').toLowerCase();
  const isPostgres = persistenceDriver === 'postgres';

  if (!isPostgres && (process.env.RAF_DB_PATH == null || String(process.env.RAF_DB_PATH).trim() === '')) {
    throw new Error('Invalid server environment configuration:\n- RAF_DB_PATH is required when PERSISTENCE_DRIVER is sqlite');
  }

  if (isPostgres && !process.env.POSTGRES_CONNECTION_STRING) {
    throw new Error('Invalid server environment configuration:\n- POSTGRES_CONNECTION_STRING is required when PERSISTENCE_DRIVER is postgres');
  }

  // Derive authRequired early (mirrors the post-parse derivation below) so we can
  // gate the app-URL requirement before the schema parse.
  const rawAuthRequired = process.env.RAF_AUTH_REQUIRED;
  const authRequiredEarly = rawAuthRequired === 'true' || rawAuthRequired === '1';

  // In production (RAF_AUTH_REQUIRED=true) the server must connect as the least-privilege
  // raf_app role — never as the owner role whose connection string is the migration fallback.
  // Require an explicit app URL; the owner fallback is intentionally absent from this path.
  if (isPostgres && authRequiredEarly) {
    const appUrl = (process.env.POSTGRES_CONNECTION_STRING_APP ?? '').trim();
    if (!appUrl) {
      throw new Error(
        'Invalid server environment configuration:\n' +
        '- POSTGRES_CONNECTION_STRING_APP is required when PERSISTENCE_DRIVER=postgres ' +
        'and RAF_AUTH_REQUIRED=true. The owner-role fallback (POSTGRES_CONNECTION_STRING) ' +
        'is not permitted for production runtime — it has BYPASSRLS and disables RLS.',
      );
    }
  }

  const parsed = serverEnvSchema.safeParse({
    PORT: process.env.PORT,
    RAF_DB_PATH: process.env.RAF_DB_PATH,
    PERSISTENCE_DRIVER: isPostgres ? 'postgres' : 'sqlite',
    POSTGRES_CONNECTION_STRING: process.env.POSTGRES_CONNECTION_STRING,
    POSTGRES_CONNECTION_STRING_APP: process.env.POSTGRES_CONNECTION_STRING_APP,
    JWT_SECRET: process.env.JWT_SECRET,
    RAF_AUTH_REQUIRED: process.env.RAF_AUTH_REQUIRED,
    SENTRY_DSN: process.env.SENTRY_DSN,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    RAF_APP_URL: process.env.RAF_APP_URL,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `- ${issue.message}`).join('\n');
    throw new Error(`Invalid server environment configuration:\n${issues}`);
  }

  const authRequired = parsed.data.RAF_AUTH_REQUIRED === 'true' || parsed.data.RAF_AUTH_REQUIRED === '1';
  if (authRequired && !parsed.data.JWT_SECRET) {
    console.warn('[RAF] WARNING: RAF_AUTH_REQUIRED is set but JWT_SECRET is not — auth will not work correctly');
  }

  // Supabase auth: require both URL and anon key together.
  // Partial configuration (one without the other) is a misconfiguration — fail early.
  const hasSupabaseUrl = Boolean(parsed.data.SUPABASE_URL);
  const hasSupabaseKey = Boolean(parsed.data.SUPABASE_ANON_KEY);
  if (hasSupabaseUrl !== hasSupabaseKey) {
    throw new Error(
      'Invalid server environment configuration:\n' +
      '- SUPABASE_URL and SUPABASE_ANON_KEY must be provided together. ' +
      'Supplying only one is a misconfiguration.',
    );
  }

  const supabaseEnabled = hasSupabaseUrl && hasSupabaseKey;

  if (supabaseEnabled && !parsed.data.RAF_APP_URL) {
    console.warn(
      '[RAF] WARNING: SUPABASE_URL/SUPABASE_ANON_KEY are set but RAF_APP_URL is absent — ' +
      'password recovery redirect URLs will use the Supabase project Site URL. ' +
      'Set RAF_APP_URL to the canonical frontend origin for controlled redirects.',
    );
  }

  // Warn loudly when Postgres is used without auth enforcement. Without
  // RAF_AUTH_REQUIRED=true, the workspace header is trusted without membership
  // verification — any client can request any workspace's data. This is
  // intentional for local development but must not reach a shared environment.
  if (isPostgres && !authRequired) {
    console.warn(
      '[RAF] WARNING: PERSISTENCE_DRIVER=postgres without RAF_AUTH_REQUIRED=true — ' +
      'tenant isolation is disabled (workspace header accepted without verification). ' +
      'Set RAF_AUTH_REQUIRED=true for any shared or production deployment.',
    );
  }

  if (parsed.data.JWT_SECRET) process.env.JWT_SECRET = parsed.data.JWT_SECRET;

  // Select the runtime connection string.
  // In production (authRequired=true): POSTGRES_CONNECTION_STRING_APP is required and already
  // validated non-empty above. The owner-role fallback is intentionally unavailable in this path.
  // In dev/local (authRequired=false): fall back to POSTGRES_CONNECTION_STRING when APP is absent.
  const runtimeConnectionString = authRequired
    ? (parsed.data.POSTGRES_CONNECTION_STRING_APP ?? null)
    : (parsed.data.POSTGRES_CONNECTION_STRING_APP ?? parsed.data.POSTGRES_CONNECTION_STRING ?? null);

  return {
    port: parsePort(parsed.data.PORT),
    dbPath: isPostgres ? null : path.resolve(cwd, parsed.data.RAF_DB_PATH),
    persistenceDriver: parsed.data.PERSISTENCE_DRIVER,
    postgresConnectionString: runtimeConnectionString,
    postgresMigrationConnectionString: parsed.data.POSTGRES_CONNECTION_STRING ?? null,
    authRequired,
    postgresSsl: process.env.RAF_POSTGRES_SSL !== 'false' && process.env.RAF_POSTGRES_SSL !== '0',
    sentryDsn: parsed.data.SENTRY_DSN ?? null,
    allowedOrigins: parsed.data.ALLOWED_ORIGINS
      ? parsed.data.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
      : [],
    supabaseUrl: supabaseEnabled ? (parsed.data.SUPABASE_URL ?? null) : null,
    supabaseAnonKey: supabaseEnabled ? (parsed.data.SUPABASE_ANON_KEY ?? null) : null,
    rafAppUrl: parsed.data.RAF_APP_URL ?? null,
  };
}

/**
 * Verify that the PostgreSQL runtime role does not have dangerous privileges.
 * Dangerous means: SUPERUSER, BYPASSRLS, or CREATEROLE.
 *
 * Call this once at server startup, after env is loaded, before accepting requests.
 *
 * In production (authRequired=true): throws if the role is unsafe.
 * In development (authRequired=false): logs a warning.
 *
 * The check is based on actual PostgreSQL role attributes, not connection-string text.
 */
export async function checkRuntimeRolePrivileges({ postgresConnectionString, authRequired }) {
  if (!postgresConnectionString) return;
  const { Client } = pg;
  const client = new Client({ connectionString: postgresConnectionString });
  try {
    await client.connect();
    const { rows } = await client.query(
      `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user`,
    );
    if (!rows.length) return;
    const role = rows[0];
    const dangerous = role.rolsuper || role.rolbypassrls || role.rolcreaterole;

    if (!dangerous) {
      console.log(`[RAF] runtime role "${role.rolname}": NOSUPERUSER NOBYPASSRLS NOCREATEROLE — RLS active ✓`);
      return;
    }

    const flags = [
      role.rolsuper ? 'SUPERUSER' : null,
      role.rolbypassrls ? 'BYPASSRLS' : null,
      role.rolcreaterole ? 'CREATEROLE' : null,
    ].filter(Boolean).join(' ');

    const msg =
      `[RAF] SECURITY: runtime database role "${role.rolname}" has ` +
      `${flags} — this role must not be used for application runtime. ` +
      `Set POSTGRES_CONNECTION_STRING_APP to a least-privilege role ` +
      `(NOSUPERUSER NOBYPASSRLS NOCREATEROLE LOGIN) for production.`;

    if (authRequired) {
      throw new Error(msg);
    } else {
      console.warn(`[RAF] WARNING: ${msg}`);
    }
  } finally {
    await client.end().catch(() => {});
  }
}
