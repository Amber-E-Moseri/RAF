/**
 * Global Express error handler.
 *
 * Server faults (5xx) never expose internal messages (upstream API text, SQL, stack details)
 * to clients. Only deliberate client-facing errors (status < 500) carry their message through.
 */
export function apiErrorHandler(error, _req, res, _next) {
  const status = typeof error?.status === 'number' ? error.status : 500;
  const isServerFault = status >= 500;
  const clientMessage = isServerFault ? 'Internal Server Error' : (error?.message ?? 'Request failed');
  console.error(JSON.stringify({
    level: 'error',
    event: 'api_error',
    status,
    message: clientMessage,
  }));
  res.status(status).json({
    error: clientMessage,
  });
}
