export function wrapInBase({ title, body, appUrl }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escHtml(title)}</title>
<style>
  body{margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a}
  .wrap{max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.07)}
  .header{background:#1a1a2e;padding:28px 32px;color:#fff}
  .header h1{margin:0;font-size:22px;font-weight:700;letter-spacing:-.3px}
  .header p{margin:4px 0 0;font-size:13px;opacity:.7}
  .body{padding:28px 32px}
  .section{margin-bottom:24px}
  .section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#666;margin-bottom:8px}
  .card{background:#f9f9f9;border:1px solid #eee;border-radius:8px;padding:16px 20px;margin-bottom:12px}
  .stat{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f0f0f0}
  .stat:last-child{border:none}
  .stat-label{font-size:14px;color:#555}
  .stat-value{font-size:14px;font-weight:600}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600}
  .badge-ok{background:#e8f5e9;color:#2e7d32}
  .badge-elevated{background:#fff8e1;color:#f57c00}
  .badge-risky{background:#fce4ec;color:#c62828}
  .btn{display:inline-block;padding:12px 24px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;margin-top:8px}
  .footer{padding:20px 32px;background:#f9f9f9;border-top:1px solid #eee;font-size:12px;color:#999;text-align:center}
  .footer a{color:#4f46e5;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <h1>RAF — Resource Allocation Framework</h1>
    <p>Your weekly financial check-in</p>
  </div>
  <div class="body">${body}</div>
  <div class="footer">
    You're receiving this because reminders are enabled for your household.<br/>
    <a href="${safeHref(appUrl + '/settings/email')}">Manage preferences</a>
  </div>
</div>
</body>
</html>`;
}

export function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Accepts only http/https URLs for use in href attributes.
// Returns '#' (a safe no-op anchor) for any other scheme, preventing
// javascript: / data: / ftp: injection even if configuration is misconfigured.
export function safeHref(url) {
  try {
    const u = new URL(String(url ?? ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '#';
  } catch {
    return '#';
  }
  return escHtml(url);
}
