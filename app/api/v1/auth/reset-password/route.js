import { json } from '../../_shared/http.js';
import { hashResetToken } from '../../../../../lib/auth/passwordReset.js';
import { hashPassword } from '../../../../../lib/auth/password.js';

export async function POST(request, context = {}) {
  // Extract the raw reset token from Authorization: Bearer <token>.
  // PR #37 (feature/auth-nomi-integration) passes the token this way.
  const authHeader = request.headers.get('authorization') ?? '';
  const rawToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!rawToken) {
    return json({ error: 'Authorization token is required' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const password = body?.password;
  if (!password || typeof password !== 'string' || password.length < 8) {
    return json({ error: 'Password must be at least 8 characters' }, 400);
  }

  // Delegate to Supabase when it is the configured auth provider.
  if (context?.authProvider === 'supabase' && context?.supabaseAuth) {
    const result = await context.supabaseAuth.updatePassword({ accessToken: rawToken, password });
    if (!result?.user) {
      return json({ error: 'Invalid or expired reset token' }, 401);
    }
    return json({ message: 'Password updated successfully' });
  }

  const tokenHash = hashResetToken(rawToken);
  if (!tokenHash) {
    return json({ error: 'Invalid or expired reset token' }, 401);
  }

  const db = context?.db;

  // Find a valid token record before entering the write transaction.
  const tokenRecord = await db.transaction((tx) => tx.findValidPasswordResetToken({ tokenHash }));
  if (!tokenRecord) {
    return json({ error: 'Invalid or expired reset token' }, 401);
  }

  const newPasswordHash = await hashPassword(password);

  // Atomically: update password + consume this token + invalidate all others for this user.
  const updated = await db.transaction((tx) =>
    tx.consumePasswordResetTokenAndUpdatePassword({
      tokenHash,
      userId: tokenRecord.user_id ?? tokenRecord.userId,
      newPasswordHash,
    }),
  );

  if (!updated) {
    // Token was consumed between our check and the write — concurrent attempt.
    return json({ error: 'Invalid or expired reset token' }, 401);
  }

  return json({ message: 'Password updated successfully' });
}
