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
  // Runtime connection (raf_app role — no BYPASSRLS). Preferred over POSTGRES_CONNECTION_STRING
  // for the application server. If absent, the server falls back to POSTGRES_CONNECTION_STRING
  // but will fail-closed at startup when RAF_AUTH_REQUIRED=true and the role has BYPASSRLS.
  POSTGRES_CONNECTION_STRING_APP: z.string().trim().optional(),
  JWT_SECRET: z.string().trim().optional(),
  RAF_AUTH_REQUIRED: z.string().trim().optional(),
  // Error monitoring DSN. When absent, Sentry is not initialised (safe for local dev).
  SENTRY_DSN: z.string().trim().optional(),
  // Comma-separated list of allowed CORS origins in production (e.g. https://normisraf.netlify.app).
  // Localhost origins are always allowed. Set this on the backend host before the frontend goes live.
  ALLOWED_ORIGINS: z.string().trim().optional(),
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
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `- ${issue.message}`).join('\n');
    throw new Error(`Invalid server environment configuration:\n${issues}`);
  }

  const authRequired = parsed.data.RAF_AUTH_REQUIRED === 'true' || parsed.data.RAF_AUTH_REQUIRED === '1';
  if (authRequired && !parsed.data.JWT_SECRET) {
    console.warn('[RAF] WARNING: RAF_AUTH_REQUIRED is set but JWT_SECRET is not — auth will not work correctly');
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

  // Prefer the least-privilege runtime connection string when provided.
  // POSTGRES_CONNECTION_STRING_APP (raf_app role, NOBYPASSRLS) is the runtime connection.
  // POSTGRES_CONNECTION_STRING (neondb_owner / migration role) is the fallback.
  // In production (authRequired=true), the startup safety check will reject BYPASSRLS roles.
  const runtimeConnectionString = parsed.data.POSTGRES_CONNECTION_STRING_APP
    ?? parsed.data.POSTGRES_CONNECTION_STRING
    ?? null;

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
  };
}

/**
 * Verify that the PostgreSQL runtime role does not have BYPASSRLS or superuser privileges.
 * Call this once at server startup, after env is loaded, before accepting requests.
 *
 * In production (authRequired=true): throws if the role is unsafe.
 * In development (authRequired=false): logs a warning.
 */
export async function checkRuntimeRolePrivileges({ postgresConnectionString, authRequired }) {
  if (!postgresConnectionString) return;
  const { Client } = pg;
  const client = new Client({ connectionString: postgresConnectionString });
  try {
    await client.connect();
    const { rows } = await client.query(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    if (!rows.length) return;
    const role = rows[0];
    const dangerous = role.rolsuper || role.rolbypassrls;

    if (!dangerous) {
      console.log(`[RAF] runtime role "${role.rolname}": NOBYPASSRLS NOSUPERUSER — RLS active ✓`);
      return;
    }

    const msg =
      `[RAF] SECURITY: runtime database role "${role.rolname}" has ` +
      `${role.rolsuper ? 'SUPERUSER ' : ''}${role.rolbypassrls ? 'BYPASSRLS' : ''}` +
      ` — PostgreSQL RLS is bypassed. Set POSTGRES_CONNECTION_STRING_APP to a ` +
      `least-privilege role (NOBYPASSRLS NOSUPERUSER LOGIN) for production.`;

    if (authRequired) {
      throw new Error(msg);
    } else {
      console.warn(`[RAF] WARNING: ${msg}`);
    }
  } finally {
    await client.end().catch(() => {});
  }
}
