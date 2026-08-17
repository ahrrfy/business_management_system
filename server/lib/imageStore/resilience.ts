/**
 * حدود المرونة المحلية لسائق R2. الحالة مقصودة لكل process/worker: لا قاعدة بيانات ولا شبكة
 * إضافية في مسار الصورة، والحد الكلي في PM2 = عدد WEB_INSTANCES × maxConcurrency.
 */
import type { Readable } from "node:stream";

export interface R2ResilienceConfig {
  maxConcurrency: number;
  maxQueue: number;
  queueTimeoutMs: number;
  failureThreshold: number;
  openMs: number;
}

export type R2Operation = "put" | "head" | "get" | "delete";
export type R2FailureClass = "not_found" | "transient" | "permanent" | "cancelled";
export type ImageStoreUnavailableReason = "circuit_open" | "queue_full" | "queue_timeout" | "upstream";
export type R2CircuitState = "closed" | "open" | "half_open";

export interface R2ResilienceSnapshot {
  state: R2CircuitState;
  inFlight: number;
  queued: number;
  consecutiveFailures: number;
  started: number;
  succeeded: number;
  transientFailures: number;
  permanentFailures: number;
  notFound: number;
  cancelled: number;
  opened: number;
  circuitRejected: number;
  queueRejected: number;
  queueTimeouts: number;
  publicFallbacks: number;
  lastTransitionAt: number | null;
}

export type R2ResilienceEvent =
  | { type: "state"; state: R2CircuitState; previous: R2CircuitState; at: number }
  | { type: "reject"; reason: Exclude<ImageStoreUnavailableReason, "upstream">; operation: R2Operation; at: number }
  | { type: "transient_failure"; operation: R2Operation; consecutiveFailures: number; at: number };

interface R2ResilienceDependencies {
  now?: () => number;
  onEvent?: (event: R2ResilienceEvent) => void;
}

interface QueuedEntry<T> {
  operation: R2Operation;
  work: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

const DEFAULT_CONFIG: R2ResilienceConfig = {
  // محافظ للـVPS: كل closure في الطابور قد يحتفظ بصورة رفع كبيرة حتى تبدأ العملية.
  maxConcurrency: 4,
  maxQueue: 8,
  queueTimeoutMs: 2_000,
  failureThreshold: 5,
  openMs: 30_000,
};

function integerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`ImageStore R2: ${name} يجب أن يكون عدداً صحيحاً.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`ImageStore R2: ${name} خارج الحد المسموح (${min}-${max}).`);
  }
  return value;
}

/** يقرأ حدوداً ثابتة ومقيدة؛ الخطأ الإملائي في الإنتاج يفشل عند الإقلاع ولا يتحول إلى حد مفتوح. */
export function readR2ResilienceConfig(env: NodeJS.ProcessEnv = process.env): R2ResilienceConfig {
  return {
    maxConcurrency: integerEnv(env, "R2_MAX_CONCURRENCY", DEFAULT_CONFIG.maxConcurrency, 1, 64),
    maxQueue: integerEnv(env, "R2_MAX_QUEUE", DEFAULT_CONFIG.maxQueue, 0, 16),
    queueTimeoutMs: integerEnv(env, "R2_QUEUE_TIMEOUT_MS", DEFAULT_CONFIG.queueTimeoutMs, 100, 30_000),
    failureThreshold: integerEnv(env, "R2_CIRCUIT_FAILURE_THRESHOLD", DEFAULT_CONFIG.failureThreshold, 1, 100),
    openMs: integerEnv(env, "R2_CIRCUIT_OPEN_MS", DEFAULT_CONFIG.openMs, 1_000, 300_000),
  };
}

function errorShape(error: unknown): {
  name?: string;
  code?: string;
  status?: number;
} {
  if (!error || typeof error !== "object") return {};
  const value = error as {
    name?: string;
    Code?: string;
    code?: string;
    statusCode?: number;
    $metadata?: { httpStatusCode?: number };
  };
  return {
    name: value.name,
    code: value.code ?? value.Code,
    status: value.$metadata?.httpStatusCode ?? value.statusCode,
  };
}

const TRANSIENT_NAMES = new Set([
  "AbortError",
  "TimeoutError",
  "RequestTimeout",
  "RequestTimeoutException",
  "SlowDown",
  "Throttling",
  "ThrottlingException",
  "InternalError",
  "ServiceUnavailable",
]);
const TRANSIENT_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

/** تصنيف محافظ: fallback والقاطع للأعطال العابرة المؤكدة فقط؛ 401/403/validation تبقى صريحة. */
export function classifyR2Failure(error: unknown): R2FailureClass {
  const { name, code, status } = errorShape(error);
  if (name === "ImageStoreClientAbortError") return "cancelled";
  if (status === 404 || name === "NotFound" || name === "NoSuchKey" || code === "NoSuchKey") return "not_found";
  if (
    status === 408 || status === 429 || (status != null && status >= 500 && status <= 599) ||
    (name != null && TRANSIENT_NAMES.has(name)) || (code != null && (TRANSIENT_NAMES.has(code) || TRANSIENT_CODES.has(code)))
  ) return "transient";
  return "permanent";
}

export class ImageStoreUnavailableError extends Error {
  readonly reason: ImageStoreUnavailableReason;
  readonly operation: R2Operation;

  constructor(reason: ImageStoreUnavailableReason, operation: R2Operation, cause?: unknown) {
    super(`ImageStore R2 unavailable (${reason}).`, cause === undefined ? undefined : { cause });
    this.name = "ImageStoreUnavailableError";
    this.reason = reason;
    this.operation = operation;
  }
}

export class ImageStoreClientAbortError extends Error {
  constructor() {
    super("ImageStore stream cancelled by consumer.");
    this.name = "ImageStoreClientAbortError";
  }
}

export function isImageStoreClientAbortError(error: unknown): error is ImageStoreClientAbortError {
  return error instanceof ImageStoreClientAbortError;
}

export function isImageStoreUnavailableError(error: unknown): error is ImageStoreUnavailableError {
  return error instanceof ImageStoreUnavailableError;
}

/** semaphore + bounded queue + circuit breaker، كلها داخل worker ولا تحمل مفاتيح كائنات في حالتها. */
export class R2ResilienceController {
  private readonly config: R2ResilienceConfig;
  private readonly now: () => number;
  private readonly onEvent?: (event: R2ResilienceEvent) => void;
  private readonly queue: Array<QueuedEntry<unknown>> = [];
  private state: R2CircuitState = "closed";
  private openUntil = 0;
  private halfOpenProbeInFlight = false;
  private inFlight = 0;
  private consecutiveFailures = 0;
  private started = 0;
  private succeeded = 0;
  private transientFailures = 0;
  private permanentFailures = 0;
  private notFound = 0;
  private cancelled = 0;
  private opened = 0;
  private circuitRejected = 0;
  private queueRejected = 0;
  private queueTimeouts = 0;
  private publicFallbacks = 0;
  private lastTransitionAt: number | null = null;

  constructor(config: R2ResilienceConfig, dependencies: R2ResilienceDependencies = {}) {
    this.config = { ...config };
    this.now = dependencies.now ?? Date.now;
    this.onEvent = dependencies.onEvent;
  }

  snapshot(): R2ResilienceSnapshot {
    return {
      state: this.state,
      inFlight: this.inFlight,
      queued: this.queue.length,
      consecutiveFailures: this.consecutiveFailures,
      started: this.started,
      succeeded: this.succeeded,
      transientFailures: this.transientFailures,
      permanentFailures: this.permanentFailures,
      notFound: this.notFound,
      cancelled: this.cancelled,
      opened: this.opened,
      circuitRejected: this.circuitRejected,
      queueRejected: this.queueRejected,
      queueTimeouts: this.queueTimeouts,
      publicFallbacks: this.publicFallbacks,
      lastTransitionAt: this.lastTransitionAt,
    };
  }

  recordPublicFallback(): void {
    this.publicFallbacks += 1;
  }

  run<T>(operation: R2Operation, work: () => Promise<T>): Promise<T> {
    if (this.isCircuitUnavailable()) return Promise.reject(this.rejectCircuit(operation));
    return new Promise<T>((resolve, reject) => {
      const entry: QueuedEntry<T> = { operation, work, resolve, reject, timer: null, settled: false };
      if (this.inFlight < this.config.maxConcurrency) {
        this.start(entry);
        return;
      }
      if (this.queue.length >= this.config.maxQueue) {
        this.queueRejected += 1;
        this.emit({ type: "reject", reason: "queue_full", operation, at: this.now() });
        reject(new ImageStoreUnavailableError("queue_full", operation));
        return;
      }
      entry.timer = setTimeout(() => {
        if (entry.settled) return;
        const index = this.queue.indexOf(entry as QueuedEntry<unknown>);
        if (index >= 0) this.queue.splice(index, 1);
        entry.settled = true;
        this.queueTimeouts += 1;
        this.emit({ type: "reject", reason: "queue_timeout", operation, at: this.now() });
        reject(new ImageStoreUnavailableError("queue_timeout", operation));
      }, this.config.queueTimeoutMs);
      entry.timer.unref?.();
      this.queue.push(entry as QueuedEntry<unknown>);
    });
  }

  /**
   * نسخة streaming من run: تُسلّم الـReadable للمستهلك فور وصول headers، لكن لا تحرر permit
   * ولا تسجل النجاح حتى end. خطأ body يدخل التصنيف والقاطع؛ close بلا error (إلغاء مستهلك
   * مقصود) يحرر permit مرة واحدة ولا يلوّث القاطع.
   */
  runStream<T extends Readable | null>(operation: R2Operation, work: () => Promise<T>): Promise<T> {
    let exposed = false;
    let exposeResolve!: (value: T | PromiseLike<T>) => void;
    let exposeReject!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      exposeResolve = resolve;
      exposeReject = reject;
    });

    void this.run(operation, async () => {
      const stream = await work();
      if (!stream) {
        exposed = true;
        exposeResolve(stream);
        return stream;
      }

      const terminal = new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          stream.off("end", onEnd);
          stream.off("error", onError);
          stream.off("close", onClose);
        };
        const settle = (error?: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error === undefined) resolve();
          else reject(error);
        };
        const onEnd = () => settle();
        const onError = (error: unknown) => settle(error);
        // Node يرسل close بعد end/error غالباً؛ settle يحمي release once.
        // close قبل end بلا علامة downstream صريحة هو انقطاع upstream، لا إلغاء عميل.
        const onClose = () => settle(Object.assign(new Error("ImageStore stream closed before end."), {
          code: "ECONNRESET",
        }));
        stream.once("end", onEnd);
        stream.once("error", onError);
        stream.once("close", onClose);
      });
      exposed = true;
      exposeResolve(stream);
      await terminal;
      return stream;
    }).catch((error: unknown) => {
      // إن وقع الخطأ بعد تسليم stream فقد وصل أيضاً عبر حدث error للمستهلك؛ هنا نمنع
      // unhandled rejection فقط، بينما run يكون قد سجله في المقاييس والقاطع.
      if (!exposed) {
        exposed = true;
        exposeReject(error);
      }
    });
    return result;
  }

  private isCircuitUnavailable(): boolean {
    if (this.state === "closed") return false;
    if (this.state === "open") return this.now() < this.openUntil;
    return true;
  }

  private rejectCircuit(operation: R2Operation): ImageStoreUnavailableError {
    this.circuitRejected += 1;
    this.emit({ type: "reject", reason: "circuit_open", operation, at: this.now() });
    return new ImageStoreUnavailableError("circuit_open", operation);
  }

  private start<T>(entry: QueuedEntry<T>): void {
    if (entry.settled) return;
    if (this.state === "open") {
      if (this.now() < this.openUntil) {
        entry.settled = true;
        entry.reject(this.rejectCircuit(entry.operation));
        return;
      }
      this.transition("half_open");
    }
    const isProbe = this.state === "half_open";
    if (isProbe) {
      if (this.halfOpenProbeInFlight) {
        entry.settled = true;
        entry.reject(this.rejectCircuit(entry.operation));
        return;
      }
      this.halfOpenProbeInFlight = true;
    }
    entry.settled = true;
    if (entry.timer) clearTimeout(entry.timer);
    this.inFlight += 1;
    this.started += 1;
    Promise.resolve()
      .then(entry.work)
      .then((value) => {
        this.succeeded += 1;
        this.consecutiveFailures = 0;
        if (isProbe) this.transition("closed");
        entry.resolve(value);
      })
      .catch((error: unknown) => {
        const failureClass = classifyR2Failure(error);
        if (failureClass === "transient") {
          this.transientFailures += 1;
          this.consecutiveFailures += 1;
          this.emit({
            type: "transient_failure",
            operation: entry.operation,
            consecutiveFailures: this.consecutiveFailures,
            at: this.now(),
          });
          if (isProbe || (this.state === "closed" && this.consecutiveFailures >= this.config.failureThreshold)) {
            this.openCircuit();
          }
          entry.reject(new ImageStoreUnavailableError("upstream", entry.operation, error));
          return;
        }
        if (failureClass === "cancelled") {
          this.cancelled += 1;
          if (isProbe) {
            this.openUntil = this.now() + this.config.openMs;
            this.transition("open");
          }
          entry.reject(error);
          return;
        }
        if (failureClass === "not_found") this.notFound += 1;
        else this.permanentFailures += 1;
        if (isProbe) {
          this.consecutiveFailures = 0;
          this.transition("closed");
        }
        entry.reject(error);
      })
      .finally(() => {
        this.inFlight -= 1;
        if (isProbe) this.halfOpenProbeInFlight = false;
        this.drain();
      });
  }

  private drain(): void {
    while (this.inFlight < this.config.maxConcurrency && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      if (entry.timer) clearTimeout(entry.timer);
      this.start(entry);
    }
  }

  private openCircuit(): void {
    this.openUntil = this.now() + this.config.openMs;
    this.opened += 1;
    this.transition("open");
  }

  private transition(next: R2CircuitState): void {
    const previous = this.state;
    if (previous === next) return;
    this.state = next;
    this.lastTransitionAt = this.now();
    this.emit({ type: "state", state: next, previous, at: this.lastTransitionAt });
  }

  private emit(event: R2ResilienceEvent): void {
    this.onEvent?.(event);
  }
}
