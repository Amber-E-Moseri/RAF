import { wrapInBase, safeHref } from './base.js';

export function renderPasswordResetEmail({ resetUrl, appUrl }) {
  const body = `
<div class="section">
  <p class="section-title">Password Reset</p>
  <div class="card">
    <p style="font-size:15px;margin:0 0 16px">
      We received a request to reset the password for your NOMI account.
      Click the button below to choose a new password.
    </p>
    <a href="${safeHref(resetUrl)}" class="btn">Reset password</a>
    <p style="font-size:12px;color:#999;margin:16px 0 0">
      This link expires in 1 hour and can only be used once.
      If you did not request a password reset, you can safely ignore this email.
    </p>
  </div>
</div>`;

  return wrapInBase({ title: 'Reset your NOMI password', body, appUrl });
}
