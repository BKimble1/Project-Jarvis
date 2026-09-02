import { workerEnrolmentSchema } from '@/domain/worker';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

export const GET = ownerRoute(async ({ services }) => {
  return json({ workers: await services.missions.workerHealth() });
});

/**
 * Enrol a worker.
 *
 * The response carries the enrolment token, and it is the only time that value is ever sent
 * anywhere. Only the hash and a short prefix are stored, so it cannot be shown again.
 */
export const POST = ownerRoute(async ({ services, request }) => {
  const input = await parseBody(request, workerEnrolmentSchema);
  const enrolment = await services.workerService.enrol(input.name, input.maxConcurrency);
  await services.activity.record({
    kind: 'source_added',
    summary: `Enrolled worker ${enrolment.worker.name}.`,
    detail: { workerId: enrolment.worker.id },
  });
  return json(enrolment, { status: 201 });
});
