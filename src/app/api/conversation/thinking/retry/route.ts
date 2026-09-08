import { NextResponse } from 'next/server';
import { z } from 'zod';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ request: z.string().uuid() });

/**
 * Ask the worker to try a failed question again.
 *
 * A POST, because it changes state, and owner-only through `ownerRoute` like everything else under
 * `/api`. The bound lives in the store: only a request that actually failed is requeued, and only
 * while manual retries remain — so two presses in the same second produce one retry, and a runtime
 * that is broken rather than slow runs out of retries and stays failed with a sentence to read.
 *
 * The proposal is untouched. Retrying asks the same question on the same row; it does not create a
 * second proposal, a second project, or a second anything.
 */
export const POST = ownerRoute(async ({ services, request }) => {
  const body = await parseBody(request, bodySchema);
  const thinking = await services.reasoningService.retry(body.request);
  if (!thinking) {
    return NextResponse.json(
      {
        error: {
          code: 'conflict',
          message:
            'That question cannot be retried — it has not failed, or it has been retried as often as Jarvis allows.',
        },
      },
      { status: 409, headers: { 'cache-control': 'no-store' } },
    );
  }
  return json({ thinking });
});
