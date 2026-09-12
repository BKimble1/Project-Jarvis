/**
 * Netlify scheduled function.
 *
 * It holds no logic of its own: it calls the application's protected cron endpoint with the
 * shared secret, so scheduled and manual synchronisation always take exactly the same code path.
 */
export default async (): Promise<Response> => {
  const secret = process.env.CRON_SECRET;
  const baseUrl = process.env.JARVIS_BASE_URL ?? process.env.URL;

  if (!secret || !baseUrl) {
    console.warn('scheduled-sync skipped: CRON_SECRET or JARVIS_BASE_URL is not configured.');
    return new Response('Not configured', { status: 200 });
  }

  const response = await fetch(`${baseUrl}/api/cron/sync`, {
    method: 'POST',
    headers: { 'x-jarvis-cron-secret': secret },
  });

  if (!response.ok) {
    console.error(`scheduled-sync failed with status ${response.status}`);
    return new Response('Sync failed', { status: 500 });
  }
  return new Response('OK', { status: 200 });
};
