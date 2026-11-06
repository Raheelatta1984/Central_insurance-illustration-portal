/** Durable catch-up scheduler. Each tick pages policies; command keys and cycle markers survive restarts. */
import type { FinancialService } from '../../core/financial/service.js';
export interface SchedulerHandle { stop(): void; tick(): Promise<{ processed: number; failed: number }> }
export function startMonthlyScheduler(service: FinancialService, options: { intervalMs?: number; log?: (line: string) => void; now?: () => string } = {}): SchedulerHandle {
  const log = options.log ?? console.error; const now = options.now ?? (() => new Date().toISOString());
  let current: Promise<{ processed: number; failed: number }> | null = null; let stopped = false;
  const run = async () => { let after: string | null = null; let processed = 0; let failed = 0;
    const at = now(); const day = at.slice(0, 10);
    try {
      do {
        const page = await service.dispatch({ name: 'finance-scheduler', roles: ['finance-scheduler'] }, 'GET', '/policies', new URLSearchParams({ limit: '100', ...(after ? { after } : {}) }), {}, undefined);
        const version = page.version ?? 0;
        const body = page.body as { items: Array<{ policyId: string; selectedFunds: Array<{ fundId: string }>; status: string }>; nextCursor: string | null };
        for (const policy of body.items) {
          if (policy.status === 'surrendered' || !policy.selectedFunds[0]) continue;
          try {
            const result = await service.dispatch({ name: 'finance-scheduler', roles: ['finance-scheduler'] }, 'POST', '/monthly/run', new URLSearchParams(), { policyId: policy.policyId, fundId: policy.selectedFunds[0].fundId }, `monthly-${day}-${policy.policyId}-v${version}`);
            if (result.status >= 500) throw new Error(`scheduler command status ${result.status}`);
            processed++;
          } catch (error) { failed++; log(`[finance-scheduler] ${policy.policyId}: ${error instanceof Error ? error.message : String(error)}`); }
        }
        after = body.nextCursor;
      } while (after && !stopped);
      return { processed, failed };
    } finally { current = null; }
  };
  const tick = () => {
    if (stopped) return Promise.resolve({ processed: 0, failed: 0 });
    if (!current) current = run();
    return current;
  };
  const timer = setInterval(() => { void tick().catch((error) => log(`[finance-scheduler] tick failed: ${error instanceof Error ? error.message : String(error)}`)); }, options.intervalMs ?? 60_000);
  timer.unref(); void tick().catch((error) => log(`[finance-scheduler] initial catch-up failed: ${error instanceof Error ? error.message : String(error)}`));
  return { stop() { stopped = true; clearInterval(timer); }, tick };
}
