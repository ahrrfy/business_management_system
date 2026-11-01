import { afterEach, describe, expect, it, vi } from "vitest";
import { channel } from "node:diagnostics_channel";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import {
  createResourceAdmission,
  ResourceAdmissionError,
  runWithResourceTailScope,
  trackResourceTail,
} from "../resourceAdmission";

const policy = {
  mode: "enforce" as const,
  maxActiveCost: 6,
  publicMaxActiveCost: 4,
  readMaxActiveCost: 4,
  orderMaxActiveCost: 2,
  maxQueued: 2,
  maxQueuedCost: 4,
  queueTimeoutMs: 20,
};
it("observes deferred admission in the acquiring async context and preserves rejection/ticket behavior", async () => {
  const observations = channel("erp.storefront.admission");
  const context = new AsyncLocalStorage<string>();
  const seen: any[] = [];
  const subscriber = (message: any) => { seen.push({ ...message, owner: context.getStore() }); };
  observations.subscribe(subscriber);
  try {
    const gate = createResourceAdmission({ ...policy, queueTimeoutMs: 500 });
    const active = await gate.acquire("public-order", 2);
    const queued = context.run("quote", () => gate.acquire("public-order", 2));
    await new Promise(resolve => setTimeout(resolve, 12));
    context.run("other", () => active.release());
    const accepted = await queued;
    const granted = seen.find(row => row.owner === "quote" && row.phase === "grant");
    expect(granted.durationMs).toBeGreaterThanOrEqual(8);
    expect(granted).toMatchObject({ lane: "public-order", cost: 2 });
    expect(gate.snapshot().activeCost).toBe(2);
    accepted.release(); accepted.release();
    const abort = new AbortController(); abort.abort();
    await expect(context.run("cancelled", () => gate.acquire("public-read", 1, abort.signal))).rejects.toMatchObject({ reason: "aborted" });
    expect(seen.find(row => row.owner === "cancelled" && row.phase === "reject")).toMatchObject({ reason: "aborted" });
    expect(gate.snapshot().activeCost).toBe(0);
    expect(JSON.stringify(seen)).not.toMatch(/SQL|token|url|password/);
  } finally { observations.unsubscribe(subscriber); }
});
afterEach(() => vi.useRealTimers());
describe("effective PM2 role wait with real admission", () => {
  afterEach(() => vi.unstubAllEnvs());
  async function admissionFor(role: "public" | "admin" | "legacy") {
    const configPath = path.resolve(process.cwd(), "ecosystem.config.cjs");
    const actualRequire = createRequire(configPath);
    const module = { exports: {} as { apps: Array<{ env: Record<string, string> }> } };
    vm.runInNewContext(readFileSync(configPath, "utf8"), {
      module, __dirname: process.cwd(),
      process: { execPath: process.execPath, env: {
        WEB_RUNTIME_MODE: role === "legacy" ? "legacy" : "split",
        WEB_INSTANCES: "3", STOREFRONT_RESOURCE_MODE: "enforce",
        STOREFRONT_RESOURCE_WAIT_MS: "150",
      } },
      require: (name: string) => name === "dotenv" ? { config: () => ({}) } : actualRequire(name),
    });
    const env = module.exports.apps.find(app => app.env.WEB_RUNTIME_ROLE === role)!.env;
    for (const key of ["MODE", "ACTIVE_COST", "PUBLIC_COST", "READ_COST", "ORDER_COST", "QUEUE", "QUEUE_COST", "WAIT_MS", "READ_QUEUE", "READ_QUEUE_COST"]) {
      const name = `STOREFRONT_RESOURCE_${key}`;
      vi.stubEnv(name, env[name] ?? "");
    }
    vi.resetModules();
    const gate = (await import("../resourceAdmission")).storefrontResourceAdmission();
    expect(gate.policy).toMatchObject({
      mode: "enforce", maxActiveCost: 18, publicMaxActiveCost: 14,
      readMaxActiveCost: 12, orderMaxActiveCost: 2, maxQueued: 8,
      maxQueuedCost: 24, readMaxQueued: 6, readMaxQueuedCost: 20,
    });
    return gate;
  }
  it.each(["public", "admin", "legacy"] as const)("%s preserves caps while a cost2 checkout holds the lane for 330ms", async role => {
    vi.useFakeTimers();
    const gate = await admissionFor(role);
    const originalPolicy = { ...gate.policy };
    const create = await gate.acquire("public-order", 2);
    const quote = gate.acquire("public-order", 2).then(ticket => ({ ticket }), error => ({ error }));
    expect(gate.snapshot()).toMatchObject({ activeCost: 2, queued: 1, queuedCost: 2 });
    await vi.advanceTimersByTimeAsync(330);
    if (role === "public") {
      expect(gate.snapshot()).toMatchObject({ activeCost: 2, queued: 1, queuedCost: 2, timedOut: 0 });
      create.release();
      const result = await quote;
      expect(result).toHaveProperty("ticket");
      if ("ticket" in result) { result.ticket.release(); result.ticket.release(); }
      expect(gate.snapshot()).toMatchObject({ admitted: 2, timedOut: 0 });
    } else {
      expect(await quote).toMatchObject({ error: { reason: "timeout" } });
      expect(gate.snapshot()).toMatchObject({ admitted: 1, timedOut: 1 });
      create.release();
    }
    expect(gate.snapshot()).toMatchObject({ activeCost: 0, queued: 0, queuedCost: 0 });
    expect(gate.policy).toEqual(originalPolicy);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("public wait still expires at 900ms with no queued cost or late ticket", async () => {
    vi.useFakeTimers();
    const gate = await admissionFor("public");
    const create = await gate.acquire("public-order", 2);
    const quote = gate.acquire("public-order", 2).then(ticket => ({ ticket }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(899);
    expect(gate.snapshot()).toMatchObject({ activeCost: 2, queued: 1, queuedCost: 2, timedOut: 0 });
    await vi.advanceTimersByTimeAsync(1);
    expect(await quote).toMatchObject({ error: { reason: "timeout" } });
    expect(gate.snapshot()).toMatchObject({ activeCost: 2, queued: 0, queuedCost: 0, timedOut: 1 });
    create.release();
    expect(gate.snapshot()).toMatchObject({ activeCost: 0, admitted: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("public shutdown rejects queued work immediately without waiting 900ms", async () => {
    vi.useFakeTimers();
    const gate = await admissionFor("public");
    const create = await gate.acquire("public-order", 2);
    const quote = gate.acquire("public-order", 2);
    const rejected = expect(quote).rejects.toMatchObject({ reason: "shutdown" });
    const stoppedAt = Date.now();
    gate.stopAccepting();
    await rejected;
    expect(Date.now()).toBe(stoppedAt);
    expect(gate.snapshot()).toMatchObject({ activeCost: 2, queued: 0, queuedCost: 0, timedOut: 0 });
    await expect(gate.acquire("public-read", 1)).rejects.toMatchObject({ reason: "shutdown" });
    create.release();
    expect(gate.snapshot().activeCost).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
describe("resource admission", () => {
  it("reserves existing queue space and cost for checkout when browsing fills its sublimit", async () => {
    const gate = createResourceAdmission({ ...policy, maxQueued: 3, maxQueuedCost: 6, readMaxQueued: 1, readMaxQueuedCost: 2, queueTimeoutMs: 500 });
    const active = await gate.acquire("public-read", 4);
    const read = gate.acquire("public-read", 2);
    await expect(gate.acquire("public-read", 1)).rejects.toMatchObject({ reason: "queue-full" });
    const quote = gate.acquire("public-order", 2);
    expect(gate.snapshot().queued).toBe(2);
    active.release();
    (await quote).release();
    (await read).release();
    expect(gate.snapshot()).toMatchObject({ activeCost: 0, queuedCost: 0 });
  });
  it.each(["observe", "enforce"] as const)(
    "%s records mixed-order policy violations without reserving capacity",
    (mode) => {
      const gate = createResourceAdmission({ ...policy, mode });
      expect(gate.rejectMixedOrderBatch()).toBe(mode === "enforce");
      expect(gate.snapshot()).toMatchObject({
        activeCost: 0,
        queued: 0,
        rejected: mode === "enforce" ? 1 : 0,
        wouldReject: mode === "observe" ? 1 : 0,
      });
    },
  );
  it("bounds public cost while retaining staff headroom and releases once", async () => {
    const gate = createResourceAdmission(policy);
    const read = await gate.acquire("public-read", 4);
    const staff = await gate.acquire("staff", 2);
    expect(gate.snapshot().activeCost).toBe(6);
    staff.release();
    staff.release();
    read.release();
    expect(gate.snapshot().activeCost).toBe(0);
  });
  it("counts queued cost, expires before starting, then recovers", async () => {
    vi.useFakeTimers();
    const gate = createResourceAdmission(policy);
    const ticket = await gate.acquire("public-read", 4);
    const queued = gate.acquire("public-read", 4);
    const failed = expect(queued).rejects.toMatchObject({
      reason: "timeout",
      httpStatus: 503,
    });
    await expect(gate.acquire("public-read", 1)).rejects.toMatchObject({
      reason: "queue-full",
    });
    await vi.advanceTimersByTimeAsync(21);
    await failed;
    ticket.release();
    expect(gate.snapshot()).toMatchObject({
      activeCost: 0,
      queuedCost: 0,
      queued: 0,
    });
  });
  it("cancels queued work without granting a late ticket", async () => {
    const gate = createResourceAdmission(policy);
    const active = await gate.acquire("public-read", 4);
    const abort = new AbortController();
    const pending = gate.acquire("public-read", 1, abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ reason: "aborted" });
    active.release();
    expect(gate.snapshot().activeCost).toBe(0);
  });
  it("observe records would-reject and allows actual work", async () => {
    const gate = createResourceAdmission({ ...policy, mode: "observe" });
    const ticket = await gate.acquire("public-read", 9);
    expect(gate.snapshot()).toMatchObject({ activeCost: 9, wouldReject: 1 });
    ticket.release();
  });
  it("drains bounded workers after failure and preserves successful ordering", async () => {
    const { mapResourceWork } = await import("../resourceAdmission");
    let active = 0;
    let peak = 0;
    let finish!: () => void;
    const blocker = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const work = mapResourceWork([0, 1, 2], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await Promise.resolve();
        if (n === 0) throw new Error("failed");
        await blocker;
        return n;
      } finally {
        active--;
      }
    });
    let settled = false;
    void work.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await expect(work).rejects.toThrow("failed");
    expect(peak).toBe(2);
    expect(active).toBe(0);
    expect(await mapResourceWork([3, 2, 1], 2, async (n) => n * 2)).toEqual([
      6, 4, 2,
    ]);
  });
  it("registers detached tails before their first await without awaiting their response", async () => {
    let count = 0;
    let finish!: () => void;
    const hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const scope = {
      beginWork: () => {
        count++;
        return () => {
          count--;
        };
      },
    };
    let pending!: Promise<void>;
    const result = runWithResourceTailScope(scope, () => {
      pending = trackResourceTail(async () => {
        await hold;
      });
      return "response";
    });
    expect(result).toBe("response");
    expect(count).toBe(1);
    finish();
    await pending;
    expect(count).toBe(0);
    expect(ResourceAdmissionError).toBeDefined();
  });
});

it("stops new and queued admissions without releasing accepted work", async () => {
  const gate = createResourceAdmission({ ...policy, queueTimeoutMs: 500 });
  const active = await gate.acquire("public-read", 4);
  const queued = gate.acquire("public-read", 1);
  const rejected = expect(queued).rejects.toMatchObject({ reason: "shutdown" });
  gate.stopAccepting();
  await rejected;
  await expect(gate.acquire("public-order", 2)).rejects.toMatchObject({ reason: "shutdown" });
  expect(gate.snapshot().activeCost).toBe(4);
  active.release();
  expect(gate.snapshot().activeCost).toBe(0);
});

it("keeps an accepted root and its late tail in the drain, and times out honestly", async () => {
  const { WorkDrain } = await import("../workDrain");
  const drain = new WorkDrain();
  let commit!: () => void, finishTail!: () => void;
  const committed = new Promise<void>(r => { commit = r; });
  const tail = new Promise<void>(r => { finishTail = r; });
  let tailStarted = false;
  const work = drain.run(async () => {
    await committed;
    expect(drain.hasActiveParent).toBe(true);
    void drain.run(async () => { tailStarted = true; await tail; });
  });
  drain.stopAccepting();
  expect(drain.isAccepting).toBe(false);
  expect(drain.hasActiveParent).toBe(false);
  commit(); await work;
  expect(tailStarted).toBe(true);
  await expect(drain.wait(10)).rejects.toThrow(/unfinished scopes/);
  finishTail(); await drain.wait(500);
});

it("rejects new background jobs while accepted job descendants still settle during drain", async () => {
  vi.resetModules();
  vi.stubEnv("CONTROL_DATABASE_URL", "");
  try {
    const { runtimeWorkDrain } = await import("../workDrain");
    const { runAcrossActiveTenants } = await import("../../tenancy/backgroundTenants");
    let commit!: () => void;
    const committed = new Promise<void>(r => { commit = r; });
    let lateChild = false, newJob = false;
    const accepted = runAcrossActiveTenants("accepted", async () => {
      await committed;
      await runAcrossActiveTenants("late-child", async () => { lateChild = true; return 0; });
      return 0;
    });
    runtimeWorkDrain.stopAccepting();
    expect(await runAcrossActiveTenants("new", async () => { newJob = true; return 0; })).toEqual([]);
    commit(); await accepted; await runtimeWorkDrain.wait(1000);
    expect(lateChild).toBe(true); expect(newJob).toBe(false);
  } finally { vi.unstubAllEnvs(); vi.resetModules(); }
});
