#!/usr/bin/env node
/**
 * Diagnose the real subscription-telemetry path end to end:
 *   credential resolution -> provider measurement -> stored capacity -> report.
 *
 * Prints exactly what it found, including *why* a reading is unavailable.
 * It never invents a number and never falls back to ANTHROPIC_API_KEY.
 */
import os from 'node:os';
import path from 'node:path';
import { systemClock } from '../src/core/clock.js';
import { EventBus } from '../src/core/bus.js';
import { Store } from '../src/core/store.js';
import { UsageService } from '../src/telemetry/usage.js';
import { ClaudeSubscriptionProvider, resolveOAuthToken } from '../src/telemetry/providers/claude-cli.js';

const clock = systemClock;
const dataDir = process.env.JARVIS_DATA_DIR ?? path.join(process.cwd(), 'data');

console.log('Jarvis subscription telemetry probe');
console.log('-----------------------------------');

const resolved = resolveOAuthToken();
if (resolved) {
  console.log(`1. credential      : found via ${resolved.source} (value not shown)`);
} else {
  console.log('1. credential      : NOT FOUND');
  console.log('                     Jarvis will not use ANTHROPIC_API_KEY for subscription usage,');
  console.log('                     because that bills paid API credit instead of reading your plan.');
  console.log('                     Run `claude setup-token` (or set CLAUDE_CODE_OAUTH_TOKEN) to fix.');
}

const provider = new ClaudeSubscriptionProvider({ clock });
const measurement = await provider.measure();
if (measurement.ok) {
  console.log(`2. provider        : ok, ${measurement.windows.length} window(s) reported`);
  for (const w of measurement.windows) {
    console.log(`                     - ${w.label}: ${w.usedPercent.toFixed(1)}% used, resets ${w.resetsAt ? new Date(w.resetsAt).toISOString() : 'unknown'}`);
  }
} else {
  console.log(`2. provider        : unavailable (${measurement.reason})`);
  console.log(`                     ${measurement.message}`);
  if (measurement.remedy) console.log(`                     remedy: ${measurement.remedy}`);
}

const store = new Store({ dir: dataDir, clock });
const bus = new EventBus();
const usage = new UsageService({ store, bus, clock, provider });
const report = await usage.refresh();

console.log(`3. stored capacity : status=${report.status} age=${report.ageMs == null ? 'n/a' : `${Math.round(report.ageMs / 1000)}s`}`);
console.log(`4. dashboard view  : ${report.windows.length} circle(s), timezone ${report.timezone}`);
for (const w of report.windows) {
  console.log(`                     ${w.label}: ${w.usedPercent.toFixed(1)}% used | ${w.remainingPercent.toFixed(1)}% left | resets ${w.resetsAtLocal ?? 'unknown'} | ${w.freshness}`);
}
if (report.status === 'unavailable') {
  console.log(`                     Unavailable — ${report.explanation}`);
  console.log(`                     Recovery: ${report.recovery}`);
}

store.flush();
process.exit(report.status === 'unavailable' ? 2 : 0);
