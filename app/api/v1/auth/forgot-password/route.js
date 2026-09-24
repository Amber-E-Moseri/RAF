import { json } from '../../_shared/http.js';
import { generateResetToken, RESET_TOKEN_EXPIRY_SECONDS } from '../../../../../lib/auth/passwordReset.js';
import { sendEmail } from '../../../../../lib/email/emailService.js';
import { renderPasswordResetEmail } from '../../../../../lib/email/templates/passwordReset.js';

export async function POST(request, context = {}) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const email = body?.email;
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return json({ error: 'email is required' }, 400);
  }

  // Always return the same neutral response to prevent account enumeration.
  const neutral = json({ message: 'If an account exists, a reset link has been sent.' });

  // Delegate to Supabase when it is the configured auth provider.
  if (context?.authProvider === 'supabase' && context?.supabaseAuth) {
    await context.supabaseAuth.sendPasswordReset({ email });
    return neutral;
  }

  const db = context?.db;

  let user;
  try {
    user = await db.transaction((tx) => tx.getUserByEmail({ email }));
  } catch {
    return neutral;
  }

  if (!user) {
    return neutral;
  }

  const { rawToken, tokenHash } = generateResetToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_SECONDS * 1000).toISOString();

  try {
    await db.transaction(async (tx) => {
      // Invalidate any outstanding tokens before creating the new one.
      await tx.invalidatePasswordResetTokensForUser({ userId: user.id });
      await tx.createPasswordResetToken({ userId: user.id, tokenHash, expiresAt });
    });
  } catch {
    // Persistence failure: log server-side without leaking details.
    console.error(JSON.stringify({ level: 'error', event: 'forgot_password_persist_failure', userId: user.id }));
    return neutral;
  }

  const { rafAppUrl, resendApiKey, emailFrom } = context?.emailConfig ?? {};

  if (!rafAppUrl) {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'forgot_password_no_app_url',
      message: 'RAF_APP_URL not set; reset email not sent',
      userId: user.id,
    }));
    return neutral;
  }

  // Format the reset URL so PR #37's parseRecoveryToken() can read it.
  // The page reads: window.location.hash → type=recovery&access_token=<rawToken>
  const resetUrl = `${rafAppUrl}/reset-password#type=recovery&access_token=${rawToken}`;
  const html = renderPasswordResetEmail({ resetUrl, appUrl: rafAppUrl });

  try {
    await sendEmail({
      apiKey: resendApiKey,
      from: emailFrom ?? 'NOMI <noreply@mail.normisraf.com>',
      to: email,
      subject: 'Reset your NOMI password',
      html,
    });
  } catch (err) {
    // Email delivery failure: log server-side. The token remains valid for its
    // 1-hour window — the user can request again. Do NOT expose the failure.
    console.error(JSON.stringify({
      level: 'error',
      event: 'forgot_password_email_failure',
      userId: user.id,
      error: err?.message ?? 'unknown',
    }));
  }

  return neutral;
}
