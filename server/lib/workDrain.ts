import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import type { RequestHandler } from "express";
const workObservations = channel("erp.runtime.work");

/** Tracks actual promise lifetime, independently of a disconnected HTTP socket. */
export class WorkDrain {
  private accepting = true;
  private active = 0;
  private scope = new AsyncLocalStorage<{ active: boolean }>();
  private waiters = new Set<() => void>();
  get isAccepting() { return this.accepting; }
  get hasActiveParent() { return this.scope.getStore()?.active === true; }
  stopAccepting() { this.accepting = false; }
  begin() {
    this.active++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      if (--this.active === 0) for (const notify of Array.from(this.waiters)) notify();
    };
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    const end = this.begin();
    const scope = { active: true };
    const observed = workObservations.hasSubscribers;
    if (observed) workObservations.publish({ phase: "start" });
    try { return await this.scope.run(scope, work); }
    finally {
      scope.active = false; end();
      if (observed) workObservations.publish({ phase: "end" });
    }
  }
  async wait(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let notify!: () => void;
    try {
      await new Promise<void>((resolve, reject) => {
        notify = () => { if (this.active === 0) resolve(); };
        this.waiters.add(notify);
        timer = setTimeout(() => reject(new Error(`Shutdown work drain timed out (${this.active} unfinished scopes)`)), timeoutMs);
        notify();
      });
    } finally {
      clearTimeout(timer);
      this.waiters.delete(notify);
    }
  }
}
export const runtimeWorkDrain = new WorkDrain();

/** Stop requests on existing keepalive connections too, before any auth/tenant work. */
export function runtimeDrainBoundary(drain = runtimeWorkDrain): RequestHandler {
  return (_req, res, next) => {
    if (!drain.isAccepting) { res.setHeader("Retry-After", "1"); res.status(503).end(); return; }
    next();
  };
}
