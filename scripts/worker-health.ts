#!/usr/bin/env tsx
/**
 * Worker health check.
 *
 * Used by the Dockerfile's HEALTHCHECK and by anyone diagnosing a worker that will not pick up
 * work. It reports configuration, runtime availability and workspace writability — and prints no
 * credential, only whether each one is present.
 */
import { buildWorkerConfig, describeWorkerConfig } from '@/worker/config';
import { ClaudeAgentRuntime } from '@/worker/runtime/claude-agent-sdk';
import { checkWorkspaceRoot, listWorkspaces } from '@/worker/workspace';

async function main(): Promise<void> {
  const config = buildWorkerConfig();
  const described = describeWorkerConfig(config);
  const runtime = new ClaudeAgentRuntime({ apiKey: config.anthropicApiKey, model: config.model });
  const availability = await runtime.availability();
  const workspace = await checkWorkspaceRoot(config.workspaceRoot);
  const preserved = await listWorkspaces(config.workspaceRoot);

  const report = {
    name: config.name,
    version: config.version,
    controlPlane: config.controlPlaneUrl,
    tokenConfigured: config.token.length > 0,
    anthropicKeyConfigured: config.anthropicApiKey !== null,
    githubWriteTokenConfigured: described.githubDeliveryConfigured,
    runtime: { name: runtime.name, ...availability },
    workspace: { root: config.workspaceRoot, ...workspace, preserved: preserved.length },
    accepts: config.accepts,
    diagnostics: config.diagnostics,
  };

  console.log(JSON.stringify(report, null, 2));
  const healthy = availability.available && workspace.ok;
  process.exitCode = healthy ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
