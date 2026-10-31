import { runtimeWorkDrain } from "./workDrain";
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";

const admissionObservations = channel("erp.storefront.admission");

export type ResourceLane = "public-read" | "public-order" | "staff";
export interface ResourcePolicy {
  mode: "observe" | "enforce";
  maxActiveCost: number;
  publicMaxActiveCost: number;
  readMaxActiveCost: number;
  orderMaxActiveCost: number;
  maxQueued: number;
  maxQueuedCost: number;
  queueTimeoutMs: number;
  /** Optional sublimits leave part of the existing queue for checkout/staff. */
  readMaxQueued?: number;
  readMaxQueuedCost?: number;
}
export class ResourceAdmissionError extends Error {
  constructor(
    readonly reason: "quota" | "queue-full" | "timeout" | "aborted" | "batch" | "shutdown",
    readonly httpStatus: 429 | 503 = 503,
  ) {
    super("الخادم مشغول حالياً، أعد المحاولة بعد لحظات.");
  }
}
export interface ResourceTicket {
  release(): void;
}
export type ResourceAdmission = ReturnType<typeof createResourceAdmission>;

// Recorded lab candidate, with observe mandatory by default. These units are
// admission headroom; the isolated latency target was not met (see report).
export const STOREFRONT_RESOURCE_CANDIDATE = Object.freeze({
  maxActiveCost: 18,
  publicMaxActiveCost: 14,
  readMaxActiveCost: 12,
  orderMaxActiveCost: 2,
  maxQueued: 8,
  maxQueuedCost: 24,
  queueTimeoutMs: 150,
});
let defaultAdmission: ResourceAdmission | undefined;
export function storefrontResourceAdmission(): ResourceAdmission {
  if (defaultAdmission) return defaultAdmission;
  const positive = (name: string, fallback: number) => {
    const raw = process.env[name];
    if (raw == null || raw.trim() === "") return fallback;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid ${name}`);
    return n;
  };
  const mode = process.env.STOREFRONT_RESOURCE_MODE ?? "observe";
  if (mode !== "observe" && mode !== "enforce")
    throw new Error("Invalid STOREFRONT_RESOURCE_MODE");
  defaultAdmission = createResourceAdmission({
    mode,
    maxActiveCost: positive(
      "STOREFRONT_RESOURCE_ACTIVE_COST",
      STOREFRONT_RESOURCE_CANDIDATE.maxActiveCost,
    ),
    publicMaxActiveCost: positive(
      "STOREFRONT_RESOURCE_PUBLIC_COST",
      STOREFRONT_RESOURCE_CANDIDATE.publicMaxActiveCost,
    ),
    readMaxActiveCost: positive(
      "STOREFRONT_RESOURCE_READ_COST",
      STOREFRONT_RESOURCE_CANDIDATE.readMaxActiveCost,
    ),
    orderMaxActiveCost: positive(
      "STOREFRONT_RESOURCE_ORDER_COST",
      STOREFRONT_RESOURCE_CANDIDATE.orderMaxActiveCost,
    ),
    maxQueued: positive(
      "STOREFRONT_RESOURCE_QUEUE",
      STOREFRONT_RESOURCE_CANDIDATE.maxQueued,
    ),
    maxQueuedCost: positive(
      "STOREFRONT_RESOURCE_QUEUE_COST",
      STOREFRONT_RESOURCE_CANDIDATE.maxQueuedCost,
    ),
    queueTimeoutMs: positive(
      "STOREFRONT_RESOURCE_WAIT_MS",
      STOREFRONT_RESOURCE_CANDIDATE.queueTimeoutMs,
    ),
    readMaxQueued: positive(
      "STOREFRONT_RESOURCE_READ_QUEUE",
      Math.max(1, positive("STOREFRONT_RESOURCE_QUEUE", 8) - 2),
    ),
    readMaxQueuedCost: positive(
      "STOREFRONT_RESOURCE_READ_QUEUE_COST",
      Math.max(1, positive("STOREFRONT_RESOURCE_QUEUE_COST", 24) - 4),
    ),
  });
  return defaultAdmission;
}

/** Weighted work units are conservative SQL fan-out estimates, not reserved SQL connections. */
export function createResourceAdmission(policy: ResourcePolicy) {
  for (const [name, value] of Object.entries(policy)) {
    if (name !== "mode" && (!Number.isSafeInteger(value) || Number(value) < 1))
      throw new Error(`Invalid resource policy: ${name}`);
  }
  if (policy.mode !== "observe" && policy.mode !== "enforce")
    throw new Error("Invalid resource mode");
  if (
    (policy.readMaxQueued ?? policy.maxQueued) > policy.maxQueued ||
    (policy.readMaxQueuedCost ?? policy.maxQueuedCost) > policy.maxQueuedCost ||
    policy.publicMaxActiveCost >= policy.maxActiveCost ||
    policy.readMaxActiveCost > policy.publicMaxActiveCost ||
    policy.orderMaxActiveCost > policy.publicMaxActiveCost
  )
    throw new Error("Invalid public resource reserve");
  const active: Record<ResourceLane, number> = {
    "public-read": 0,
    "public-order": 0,
    staff: 0,
  };
  let queuedCost = 0,
    admitted = 0,
    rejected = 0,
    wouldReject = 0,
    timedOut = 0;
  let peakActiveCost = 0,
    peakQueued = 0;
  type Waiting = {
    lane: ResourceLane;
    cost: number;
    deadline: number;
    grant(): void;
    reject(error: ResourceAdmissionError): void;
  };
  const queue: Waiting[] = [];
  let accepting = true;
  const total = () =>
    active["public-read"] + active["public-order"] + active.staff;
  const laneMax = (lane: ResourceLane) =>
    lane === "public-read"
      ? policy.readMaxActiveCost
      : lane === "public-order"
        ? policy.orderMaxActiveCost
        : policy.maxActiveCost;
  const fits = (lane: ResourceLane, cost: number) =>
    total() + cost <= policy.maxActiveCost &&
    active[lane] + cost <= laneMax(lane) &&
    (lane === "staff" ||
      active["public-read"] + active["public-order"] + cost <=
        policy.publicMaxActiveCost);
  const reserve = (lane: ResourceLane, cost: number): ResourceTicket => {
    active[lane] += cost;
    admitted++;
    peakActiveCost = Math.max(peakActiveCost, total());
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        active[lane] -= cost;
        drain();
      },
    };
  };
  const remove = (entry: Waiting) => {
    const index = queue.indexOf(entry);
    if (index < 0) return false;
    queue.splice(index, 1);
    queuedCost -= entry.cost;
    return true;
  };
  function drain() {
    // Priority never changes a request's lane. Reserve remains unavailable to public work.
    for (const lane of ["staff", "public-order", "public-read"] as const) {
      for (const entry of [...queue]) {
        if (entry.lane !== lane) continue;
        if (Date.now() >= entry.deadline) {
          if (remove(entry)) {
            timedOut++;
            rejected++;
            entry.reject(new ResourceAdmissionError("timeout"));
          }
        } else if (fits(lane, entry.cost) && remove(entry)) entry.grant();
      }
    }
  }
  function acquire(
    lane: ResourceLane,
    cost = 1,
    signal?: AbortSignal,
  ): Promise<ResourceTicket> {
    if (!accepting) return Promise.reject(new ResourceAdmissionError("shutdown"));
    if (!Number.isSafeInteger(cost) || cost < 1)
      return Promise.reject(new Error("Invalid resource cost"));
    if (signal?.aborted)
      return Promise.reject(new ResourceAdmissionError("aborted"));
    if (policy.mode === "observe") {
      if (!fits(lane, cost)) wouldReject++;
      return Promise.resolve(reserve(lane, cost));
    }
    if (
      cost > laneMax(lane) ||
      (lane !== "staff" && cost > policy.publicMaxActiveCost)
    ) {
      rejected++;
      return Promise.reject(new ResourceAdmissionError("quota", 429));
    }
    if (fits(lane, cost)) return Promise.resolve(reserve(lane, cost));
    if (
      queue.length >= policy.maxQueued ||
      queuedCost + cost > policy.maxQueuedCost ||
      (lane === "public-read" &&
        (queue.filter((entry) => entry.lane === "public-read").length >=
          (policy.readMaxQueued ?? policy.maxQueued) ||
          queue
            .filter((entry) => entry.lane === "public-read")
            .reduce((sum, entry) => sum + entry.cost, 0) +
            cost >
            (policy.readMaxQueuedCost ?? policy.maxQueuedCost)))
    ) {
      rejected++;
      return Promise.reject(new ResourceAdmissionError("queue-full"));
    }
    return new Promise<ResourceTicket>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const entry: Waiting = {
        lane,
        cost,
        deadline: Date.now() + policy.queueTimeoutMs,
        grant() {
          cleanup();
          resolve(reserve(lane, cost));
        },
        reject(error) {
          cleanup();
          reject(error);
        },
      };
      const abort = () => {
        if (remove(entry)) {
          rejected++;
          entry.reject(new ResourceAdmissionError("aborted"));
        }
      };
      const timer = setTimeout(() => {
        if (remove(entry)) {
          timedOut++;
          rejected++;
          entry.reject(new ResourceAdmissionError("timeout"));
        }
      }, policy.queueTimeoutMs);
      queue.push(entry);
      queuedCost += cost;
      peakQueued = Math.max(peakQueued, queue.length);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  return {
    policy,
    stopAccepting() {
      accepting = false;
      for (const entry of [...queue]) {
        if (remove(entry)) { rejected++; entry.reject(new ResourceAdmissionError("shutdown")); }
      }
    },
    /** A structurally unsafe batch is observed without changing default behavior. */
    rejectMixedOrderBatch(): boolean {
      if (policy.mode === "observe") {
        wouldReject++;
        return false;
      }
      rejected++;
      return true;
    },
    acquire(lane: ResourceLane, cost = 1, signal?: AbortSignal): Promise<ResourceTicket> {
      if (!admissionObservations.hasSubscribers) return acquire(lane, cost, signal);
      const start = performance.now();
      admissionObservations.publish({ lane, cost, phase: "start", durationMs: 0 });
      // Register here, inside the acquiring ALS, rather than inside the queue's grant callback.
      return acquire(lane, cost, signal).then(ticket => {
        admissionObservations.publish({ lane, cost, phase: "grant", durationMs: performance.now() - start });
        return ticket;
      }, error => {
        admissionObservations.publish({ lane, cost, phase: "reject", reason: error instanceof ResourceAdmissionError ? error.reason : "invalid", durationMs: performance.now() - start });
        throw error;
      });
    },
    snapshot() {
      return {
        mode: policy.mode,
        activeCost: total(),
        active: { ...active },
        queued: queue.length,
        queuedCost,
        admitted,
        rejected,
        wouldReject,
        timedOut,
        peakActiveCost,
        peakQueued,
      };
    },
  };
}

export interface ResourceTailScope {
  beginWork(): () => void;
}
const tailScope = new AsyncLocalStorage<ResourceTailScope>();
export const runWithResourceTailScope = <T>(
  scope: ResourceTailScope,
  work: () => T,
): T => tailScope.run(scope, work);
/** Register before the first await. The caller retains its existing response/error semantics. */
export async function trackResourceTail<T>(work: () => Promise<T>): Promise<T> {
  const end = tailScope.getStore()?.beginWork();

  try {
    return await runtimeWorkDrain.run(work);
  } finally {
    end?.();
  }
}

/** Small ordered worker map; do not abandon siblings on the first rejection. */
export async function mapResourceWork<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error("Invalid worker count");
  const result = new Array<R>(items.length);
  let next = 0,
    failed = false,
    failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!failed) {
        const index = next++;
        if (index >= items.length) return;
        try {
          result[index] = await work(items[index]);
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
      }
    }),
  );
  if (failed) throw failure;
  return result;
}
