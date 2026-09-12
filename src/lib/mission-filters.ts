import type { MissionState } from '@/domain/mission';

/**
 * The mission inbox's filters.
 *
 * In `lib` rather than beside the list component because the missions page is a server component
 * and the list is a client one: a value exported from a `'use client'` module becomes a client
 * *reference* on the server, so importing this array from there would hand the page a proxy
 * rather than an array. Plain shared data belongs on neither side of that boundary.
 */
export interface MissionFilter {
  readonly id: string;
  readonly label: string;
  /** Empty means "everything that is not finished", which the page applies itself. */
  readonly states: readonly MissionState[];
}

export const MISSION_FILTERS: readonly MissionFilter[] = [
  { id: 'open', label: 'Open', states: [] },
  {
    id: 'needs-me',
    label: 'Needs me',
    states: [
      'needs_clarification',
      'awaiting_plan_approval',
      'waiting_for_permission',
      'waiting_for_input',
    ],
  },
  { id: 'draft', label: 'Draft', states: ['draft', 'resolving_project'] },
  { id: 'clarification', label: 'Clarifying', states: ['needs_clarification'] },
  { id: 'approval', label: 'Awaiting approval', states: ['awaiting_plan_approval'] },
  { id: 'queued', label: 'Queued', states: ['queued'] },
  {
    id: 'running',
    label: 'Running',
    states: [
      'claimed',
      'preparing_workspace',
      'running',
      'verifying',
      'creating_pull_request',
      'resuming',
    ],
  },
  { id: 'paused', label: 'Paused', states: ['paused', 'pausing'] },
  { id: 'pr', label: 'PR ready', states: ['pull_request_ready'] },
  { id: 'failed', label: 'Failed', states: ['failed'] },
  { id: 'stopped', label: 'Stopped', states: ['stopped'] },
  { id: 'completed', label: 'Completed', states: ['completed'] },
];
