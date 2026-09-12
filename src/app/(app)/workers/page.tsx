import type { Metadata } from 'next';
import { requireOwnerPage } from '@/server/auth/guard';
import { getServices } from '@/server/container';
import { WorkerManager } from '@/components/mission/worker-manager';

export const metadata: Metadata = { title: 'Workers' };
export const dynamic = 'force-dynamic';

export default async function WorkersPage() {
  await requireOwnerPage('/workers');
  const services = await getServices();
  const workers = await services.missions.workerHealth();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold">Workers</h1>
        <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">
          Jarvis runs {services.config.missions.concurrencyLimit} mission at a time in this phase. A
          worker survives you closing this page — the mission keeps going.
        </p>
      </header>
      <WorkerManager workers={workers} />
    </div>
  );
}
