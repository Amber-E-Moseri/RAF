import crypto from 'node:crypto';

export const RESET_TOKEN_EXPIRY_SECONDS = 60 * 60; // 1 hour

export function generateResetToken() {
  const rawToken = crypto.randomBytes(32).toString('hex'); // 256 bits of entropy
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  return { rawToken, tokenHash };
}

export function hashResetToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}
