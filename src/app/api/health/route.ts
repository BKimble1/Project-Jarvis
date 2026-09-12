import { sql } from 'drizzle-orm';
import { getConfig } from '@/server/config/env';
import { getDb } from '@/server/db/client';
import { errorResponse, json, ownerRoute } from '@/server/http/handler';
import { assembleReadiness } from '@/server/ops/readiness';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Is this deployment alive, and can it do anything?
 *
 * Two audiences, given deliberately different answers.
 *
 * **GET, unauthenticated** — a load balancer, a container probe, an uptime check. It gets exactly
 * one fact: the process is up and the database answered a query. Nothing else. An unauthenticated
 * endpoint that enumerated which credentials were missing would be a map of the deployment's weak
 * points, handed to anyone who asked for it.
 *
 * **POST, owner only** — the full readiness report: the same one `npm run doctor` prints and the
 * same one Operations renders, from the same assembler, so the three cannot drift into three
 * different answers to one question.
 *
 * Neither carries a credential, a connection string or an environment value. The checks are built
 * to report presence, identity and behaviour, and this route only serialises what they return.
 */
export async function GET(): Promise<Response> {
  try {
    const db = await getDb();
    /*
     * A real query, not a connection object. A pool that constructs and then cannot answer is
     * precisely the failure a health check exists to catch.
     */
    await db.execute(sql`select 1`);
    return json({ ok: true, database: 'reachable' });
  } catch {
    /*
     * No detail, deliberately. Why a database is unreachable — a hostname, a role, a certificate
     * — is exactly the sort of thing that should not be readable without signing in.
     */
    return json({ ok: false, database: 'unreachable' }, { status: 503 });
  }
}

/**
 * The full report, for the owner.
 *
 * POST rather than GET so no browser, proxy or link preview fetches it incidentally, and so
 * nothing between here and the screen caches it. It walks the whole qualification ladder, which
 * reaches GitHub, so it is a thing an owner asks for rather than a thing a page polls.
 */
export const POST = ownerRoute(async ({ services }) => {
  try {
    const config = getConfig();
    const db = await getDb();
    return json({ readiness: await assembleReadiness({ config, db, services }) });
  } catch (error) {
    return errorResponse(error);
  }
});
