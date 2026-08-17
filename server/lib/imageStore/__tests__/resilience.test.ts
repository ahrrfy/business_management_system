import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  ImageStoreUnavailableError,
  ImageStoreClientAbortError,
  R2ResilienceController,
  classifyR2Failure,
  readR2ResilienceConfig,
} from "../resilience";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const baseConfig = {
  maxConcurrency: 2,
  maxQueue: 1,
  queueTimeoutMs: 100,
  failureThreshold: 2,
  openMs: 1_000,
};

describe("R2ResilienceController", () => {
  it("يحد التوازي والطابور ويرفض الزيادة بلا نمو غير محدود", async () => {
    const controller = new R2ResilienceController(baseConfig);
    const a = deferred<string>();
    const b = deferred<string>();
    const c = deferred<string>();
    const first = controller.run("get", () => a.promise);
    const second = controller.run("get", () => b.promise);
    const queued = controller.run("get", () => c.promise);

    await expect(controller.run("get", async () => "never")).rejects.toMatchObject({
      name: "ImageStoreUnavailableError",
      reason: "queue_full",
    });
    expect(controller.snapshot()).toMatchObject({ inFlight: 2, queued: 1, queueRejected: 1 });

    a.resolve("a");
    await expect(first).resolves.toBe("a");
    expect(controller.snapshot()).toMatchObject({ inFlight: 2, queued: 0 });
    b.resolve("b");
    c.resolve("c");
    await expect(Promise.all([second, queued])).resolves.toEqual(["b", "c"]);
    expect(controller.snapshot()).toMatchObject({ inFlight: 0, queued: 0, succeeded: 3 });
    controller.recordPublicFallback();
    expect(controller.snapshot().publicFallbacks).toBe(1);
  });

  it("يسقط المنتظر عند مهلة الطابور ولا ينفذ عمله لاحقاً", async () => {
    vi.useFakeTimers();
    try {
      const controller = new R2ResilienceController({ ...baseConfig, maxConcurrency: 1 });
      const running = deferred<void>();
      const queuedWork = vi.fn(async () => undefined);
      const first = controller.run("head", () => running.promise);
      const queued = controller.run("head", queuedWork);
      const rejection = expect(queued).rejects.toMatchObject({ reason: "queue_timeout" });

      await vi.advanceTimersByTimeAsync(101);
      await rejection;
      running.resolve();
      await first;
      expect(queuedWork).not.toHaveBeenCalled();
      expect(controller.snapshot()).toMatchObject({ queueTimeouts: 1, queued: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("يفتح بعد الأخطاء العابرة فقط ويسمح بمسبار half-open واحد ثم يغلق عند نجاحه", async () => {
    let now = 10_000;
    const transitions: unknown[] = [];
    const controller = new R2ResilienceController(baseConfig, {
      now: () => now,
      onEvent: (event) => transitions.push(event),
    });
    const unavailable = () => Object.assign(new Error("upstream"), { $metadata: { httpStatusCode: 503 } });

    await expect(controller.run("get", async () => { throw unavailable(); })).rejects.toBeInstanceOf(ImageStoreUnavailableError);
    await expect(controller.run("get", async () => { throw unavailable(); })).rejects.toMatchObject({ reason: "upstream" });
    expect(controller.snapshot()).toMatchObject({ state: "open", transientFailures: 2, opened: 1 });

    const shouldNotRun = vi.fn(async () => undefined);
    await expect(controller.run("get", shouldNotRun)).rejects.toMatchObject({ reason: "circuit_open" });
    expect(shouldNotRun).not.toHaveBeenCalled();

    now += 1_001;
    const probe = deferred<string>();
    const halfOpen = controller.run("head", () => probe.promise);
    await expect(controller.run("head", async () => "second probe")).rejects.toMatchObject({ reason: "circuit_open" });
    expect(controller.snapshot().state).toBe("half_open");
    probe.resolve("ok");
    await expect(halfOpen).resolves.toBe("ok");
    expect(controller.snapshot()).toMatchObject({ state: "closed", consecutiveFailures: 0 });
    expect(transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "state", state: "open" }),
      expect.objectContaining({ type: "state", state: "half_open" }),
      expect.objectContaining({ type: "state", state: "closed" }),
    ]));
  });

  it("لا يحتسب 404 ولا أخطاء الإدخال/الصلاحية ولا يحول AccessDenied إلى fallback", async () => {
    const controller = new R2ResilienceController(baseConfig);
    const missing = Object.assign(new Error("missing"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
    const denied = Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    const validation = new TypeError("invalid key");

    await expect(controller.run("get", async () => { throw missing; })).rejects.toBe(missing);
    await expect(controller.run("get", async () => { throw denied; })).rejects.toBe(denied);
    await expect(controller.run("put", async () => { throw validation; })).rejects.toBe(validation);
    expect(controller.snapshot()).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
      transientFailures: 0,
      permanentFailures: 2,
      notFound: 1,
    });
    expect(classifyR2Failure(missing)).toBe("not_found");
    expect(classifyR2Failure(denied)).toBe("permanent");
  });

  it("لا يعيد فتح القاطع أو يمدد نافذته لكل فشل كان جارياً لحظة الفتح", async () => {
    const controller = new R2ResilienceController({ ...baseConfig, failureThreshold: 1 });
    const first = deferred<void>();
    const second = deferred<void>();
    const a = controller.run("get", () => first.promise);
    const b = controller.run("get", () => second.promise);
    const unavailable = Object.assign(new Error("down"), { $metadata: { httpStatusCode: 503 } });
    first.reject(unavailable);
    await expect(a).rejects.toMatchObject({ reason: "upstream" });
    second.reject(unavailable);
    await expect(b).rejects.toMatchObject({ reason: "upstream" });
    expect(controller.snapshot()).toMatchObject({ state: "open", opened: 1, transientFailures: 2 });
  });

  it("يمسك permit حتى نهاية Body ويقيد 20 stream إلى active=1 وطابور محدود", async () => {
    const controller = new R2ResilienceController({ ...baseConfig, maxConcurrency: 1, maxQueue: 2 });
    const bodies = Array.from({ length: 20 }, () => new PassThrough());
    let active = 0;
    let maximumActive = 0;
    const requests = bodies.map((body) => controller.runStream("get", async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      body.once("close", () => { active -= 1; });
      body.resume();
      return body;
    }).then((value) => value, (error) => error));

    await vi.waitFor(() => expect(controller.snapshot()).toMatchObject({ inFlight: 1, queued: 2, queueRejected: 17 }));
    expect(maximumActive).toBe(1);
    bodies[0].end(Buffer.from("a"));
    await vi.waitFor(() => expect(controller.snapshot().started).toBe(2));
    expect(maximumActive).toBe(1);
    bodies[1].end(Buffer.from("b"));
    await vi.waitFor(() => expect(controller.snapshot().started).toBe(3));
    bodies[2].end(Buffer.from("c"));
    await Promise.all(requests);
    await vi.waitFor(() => expect(controller.snapshot().inFlight).toBe(0));
    expect(controller.snapshot()).toMatchObject({ inFlight: 0, queued: 0, succeeded: 3, queueRejected: 17 });
    expect(maximumActive).toBe(1);
  });

  it("يزيل الطلب المنقطع من الطابور فوراً بلا بدء شبكة أو تلويث القاطع", async () => {
    const controller = new R2ResilienceController({ ...baseConfig, maxConcurrency: 1, maxQueue: 2 });
    const blocker = deferred<void>();
    const first = controller.run("get", () => blocker.promise);
    const abort = new AbortController();
    const queuedWork = vi.fn(async () => "late");
    const queued = controller.run("get", queuedWork, { signal: abort.signal });

    await vi.waitFor(() => expect(controller.snapshot()).toMatchObject({ inFlight: 1, queued: 1, started: 1 }));
    abort.abort();
    await expect(queued).rejects.toBeInstanceOf(ImageStoreClientAbortError);
    expect(controller.snapshot()).toMatchObject({
      inFlight: 1,
      queued: 0,
      started: 1,
      cancelled: 1,
      transientFailures: 0,
      permanentFailures: 0,
      state: "closed",
    });
    expect(queuedWork).not.toHaveBeenCalled();

    blocker.resolve();
    await expect(first).resolves.toBeUndefined();
  });

  it("يعد خطأ Body العابر للقاطع، ولا يعد destroy المقصود فشلاً", async () => {
    const controller = new R2ResilienceController({ ...baseConfig, maxConcurrency: 1, failureThreshold: 1 });
    const failedBody = new PassThrough();
    await controller.runStream("get", async () => failedBody);
    failedBody.destroy(Object.assign(new Error("reset"), { code: "ECONNRESET" }));
    await vi.waitFor(() => expect(controller.snapshot()).toMatchObject({ inFlight: 0, state: "open", transientFailures: 1 }));

    let now = 10_000;
    const intentional = new R2ResilienceController(baseConfig, { now: () => now });
    const cancelledBody = new PassThrough();
    await intentional.runStream("get", async () => cancelledBody);
    cancelledBody.destroy(new ImageStoreClientAbortError());
    await vi.waitFor(() => expect(intentional.snapshot().inFlight).toBe(0));
    expect(intentional.snapshot()).toMatchObject({ transientFailures: 0, permanentFailures: 0, succeeded: 0, cancelled: 1 });
  });

  it("يعد close مبكراً من upstream عطلاً عابراً لا إلغاء عميل", async () => {
    const controller = new R2ResilienceController({ ...baseConfig, maxConcurrency: 1, failureThreshold: 1 });
    const body = new PassThrough();
    await controller.runStream("get", async () => body);
    body.destroy();
    await vi.waitFor(() => expect(controller.snapshot().inFlight).toBe(0));
    expect(controller.snapshot()).toMatchObject({
      state: "open",
      transientFailures: 1,
      cancelled: 0,
      succeeded: 0,
    });
  });
});

describe("readR2ResilienceConfig", () => {
  it("يعطي حدوداً إنتاجية محافظة ويقبل قيماً صحيحة ضمن الحدود", () => {
    expect(readR2ResilienceConfig({})).toEqual({
      maxConcurrency: 4,
      maxQueue: 8,
      queueTimeoutMs: 2_000,
      failureThreshold: 5,
      openMs: 30_000,
    });
    expect(readR2ResilienceConfig({
      R2_MAX_CONCURRENCY: "4",
      R2_MAX_QUEUE: "9",
      R2_QUEUE_TIMEOUT_MS: "500",
      R2_CIRCUIT_FAILURE_THRESHOLD: "3",
      R2_CIRCUIT_OPEN_MS: "10000",
    })).toEqual({ maxConcurrency: 4, maxQueue: 9, queueTimeoutMs: 500, failureThreshold: 3, openMs: 10_000 });
  });

  it("يفشل مغلقاً عند قيم غير صحيحة أو تتجاوز السقف", () => {
    expect(() => readR2ResilienceConfig({ R2_MAX_CONCURRENCY: "0" })).toThrow(/R2_MAX_CONCURRENCY/);
    expect(() => readR2ResilienceConfig({ R2_MAX_QUEUE: "17" })).toThrow(/R2_MAX_QUEUE/);
    expect(() => readR2ResilienceConfig({ R2_MAX_QUEUE: "10001" })).toThrow(/R2_MAX_QUEUE/);
    expect(() => readR2ResilienceConfig({ R2_QUEUE_TIMEOUT_MS: "1.5" })).toThrow(/R2_QUEUE_TIMEOUT_MS/);
  });
});
