import { z } from 'zod';
import { TASK_STATES } from '@/domain/mission-task';
import { runUsageSchema } from '@/domain/mission-run';
import { json, workerRoute } from '@/server/http/worker-handler';

export const dynamic = 'force-dynamic';

const taskStateSchema = z.object({
  runId: z.string().uuid(),
  taskId: z.string().uuid(),
  /**
   * Omitted for a metadata-only report — a session id, a token count.
   *
   * The same rule the mission protocol learned: re-asserting the last known state would fight an
   * owner's pause and, during a read-only task, would claim a state the machine has no move to.
   */
  taskState: z.enum(TASK_STATES).nullish(),
  currentAction: z.string().trim().max(300).nullish(),
  agentSessionId: z.string().trim().max(200).nullish(),
  runtimeName: z.string().trim().max(80).nullish(),
  runtimeVersion: z.string().trim().max(40).nullish(),
  workspacePath: z.string().trim().max(500).nullish(),
  branchName: z.string().trim().max(255).nullish(),
  baseSha: z.string().trim().max(64).nullish(),
  headSha: z.string().trim().max(64).nullish(),
  filesChanged: z.array(z.string().trim().min(1).max(400)).max(500).nullish(),
  pullRequestUrl: z.string().trim().max(500).nullish(),
  pullRequestNumber: z.number().int().min(1).max(1_000_000).nullish(),
  usage: runUsageSchema.nullish(),
  completionSummary: z.string().trim().max(4000).nullish(),
  failureCode: z.string().trim().max(60).nullish(),
  failureMessage: z.string().trim().max(2000).nullish(),
  workspacePreserved: z.boolean().nullish(),
});

/** Report where one task has got to. The state machine decides whether the move is legal. */
export const POST = workerRoute(
  taskStateSchema,
  { name: 'worker.task', idempotent: true },
  async ({ services, workerId, body }) => {
    const { task, stopRequested } = await services.taskWorkerService.reportTaskState(workerId, {
      ...body,
      taskState: body.taskState ?? undefined,
      filesChanged: body.filesChanged ?? undefined,
      usage: body.usage ?? undefined,
    });
    return json({ ok: true, taskState: task.state, stopRequested, pauseRequested: false });
  },
);
