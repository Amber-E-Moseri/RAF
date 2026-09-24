// Dynamic import keeps 'resend' out of the module graph when no API key is
// configured — test servers and local-dev environments without the package
// installed work correctly as long as apiKey remains null.
let _resend = null;

async function getClient(apiKey) {
  if (!apiKey) return null;
  if (!_resend) {
    const { Resend } = await import('resend');
    _resend = new Resend(apiKey);
  }
  return _resend;
}

export async function sendEmail({ apiKey, from, to, subject, html }) {
  const client = await getClient(apiKey);
  if (!client) {
    console.info('[RAF email] RESEND_API_KEY not set, skipping email send');
    return { id: null, skipped: true };
  }

  const { data, error } = await client.emails.send({ from, to, subject, html });

  if (error) {
    throw new Error(`Resend error: ${error.message}`);
  }

  return { id: data?.id ?? null, skipped: false };
}
