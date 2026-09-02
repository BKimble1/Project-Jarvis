import { z } from 'zod';
import { ownerMessageSchema, stopRequestSchema } from '@/domain/mission-run';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Pause, resume, message and stop.
 *
 * Each carries an `idempotencyKey` so a double tap, a flaky connection or a retried request
 * produces one command rather than two.
 */
const commandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('pause'), idempotencyKey: z.string().min(8).max(120) }),
  z.object({ command: z.literal('resume'), idempotencyKey: z.string().min(8).max(120) }),
  z
    .object({ command: z.literal('message'), idempotencyKey: z.string().min(8).max(120) })
    .merge(ownerMessageSchema),
  z
    .object({ command: z.literal('stop'), idempotencyKey: z.string().min(8).max(120) })
    .merge(stopRequestSchema),
]);

export const POST = ownerRouteWithParams<{ id: string }>(
  async ({ services, session, request, params }) => {
    const input = await parseBody(request, commandSchema);
    const by = session.githubLogin ?? session.id;

    switch (input.command) {
      case 'pause':
        return json({
          mission: await services.missions.pause(params.id, by, input.idempotencyKey),
        });
      case 'resume':
        return json({
          mission: await services.missions.resume(params.id, by, input.idempotencyKey),
        });
      case 'message': {
        const result = await services.missions.sendMessage(
          params.id,
          input.message,
          by,
          input.idempotencyKey,
        );
        return json(result);
      }
      case 'stop':
        return json({
          mission: await services.missions.stop(
            params.id,
            input.reason ?? null,
            by,
            input.idempotencyKey,
          ),
        });
    }
  },
);
