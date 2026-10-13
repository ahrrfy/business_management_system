import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  activateRegistrationUpdate,
  decidePwaUpdateAction,
  waitForWorkerActivation,
} from "./pwaUpdateLifecycle";

class WorkerStub extends EventTarget {
  state: ServiceWorkerState = "installed";

  postMessage(): void {}

  moveTo(state: ServiceWorkerState): void {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

function registrationStub(input: {
  waiting?: WorkerStub | null;
  active?: WorkerStub | null;
}): ServiceWorkerRegistration & {
  waiting: ServiceWorker | null;
  active: ServiceWorker | null;
} {
  return {
    waiting: (input.waiting ?? null) as ServiceWorker | null,
    active: (input.active ?? null) as ServiceWorker | null,
  } as ServiceWorkerRegistration & {
    waiting: ServiceWorker | null;
    active: ServiceWorker | null;
  };
}

describe("PWA update lifecycle", () => {
  it("continues activation retries after an early ACK until activated is independently observed", async () => {
    vi.useFakeTimers();
    let clientPort: any;
    vi.stubGlobal(
      "MessageChannel",
      class {
        port1 = (clientPort = { onmessage: null, close: vi.fn() });
        port2 = {};
      },
    );
    try {
      const candidate = new WorkerStub();
      const messages: string[] = [];
      candidate.postMessage = ((data: { type: string }) => {
        messages.push(data.type);
        if (data.type === "PWA_ACTIVATE")
          clientPort.onmessage({ data: { type: "PWA_ACTIVATION_ACCEPTED" } });
      }) as typeof candidate.postMessage;
      const pending = waitForWorkerActivation(
        registrationStub({ waiting: candidate }),
        candidate as unknown as ServiceWorker,
        { timeoutMs: 10_000 },
      );
      await vi.advanceTimersByTimeAsync(6_100);
      expect(messages.filter((type) => type === "SKIP_WAITING")).toHaveLength(
        3,
      );
      candidate.moveTo("activated");
      await expect(pending).resolves.toEqual({
        status: "activated",
        acknowledged: true,
      });
      const count = messages.length;
      await vi.advanceTimersByTimeAsync(6_000);
      expect(messages).toHaveLength(count);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
  it("يفعّل العامل المنتظر من الحالة الفعلية", () => {
    expect(
      decidePwaUpdateAction({
        hasRegistration: true,
        hasWaitingWorker: true,
        hasActiveWorker: true,
        updateWasSignaled: true,
      }),
    ).toBe("ACTIVATE_WAITING");
  });

  it("يعيد الفتح إذا صار التحديث active بلا waiting", () => {
    expect(
      decidePwaUpdateAction({
        hasRegistration: true,
        hasWaitingWorker: false,
        hasActiveWorker: true,
        updateWasSignaled: true,
      }),
    ).toBe("RELOAD_ACTIVE");
  });

  it("لا يعيد فتح صفحة لمجرد وجود عامل active بلا إشارة تحديث", () => {
    expect(
      decidePwaUpdateAction({
        hasRegistration: true,
        hasWaitingWorker: false,
        hasActiveWorker: true,
        updateWasSignaled: false,
      }),
    ).toBe("CHECK_AGAIN");
  });

  it("يتحقق من active حتى إن فات حدث statechange", async () => {
    const oldWorker = new WorkerStub();
    oldWorker.state = "activated";
    const nextWorker = new WorkerStub();
    const registration = registrationStub({
      waiting: nextWorker,
      active: oldWorker,
    });

    const resultPromise = waitForWorkerActivation(
      registration,
      nextWorker as unknown as ServiceWorker,
      {
        timeoutMs: 200,
        pollIntervalMs: 2,
        sendActivation: (_worker, acknowledge) => {
          acknowledge();
          setTimeout(() => {
            registration.active = nextWorker as unknown as ServiceWorker;
            registration.waiting = null;
            nextWorker.state = "activated";
          }, 5);
        },
      },
    );

    await expect(resultPromise).resolves.toEqual({
      status: "activated",
      acknowledged: true,
    });
  });

  it("يفعّل العامل الأحدث إذا صار الأول redundant أثناء المحاولة", async () => {
    const oldWorker = new WorkerStub();
    oldWorker.state = "activated";
    const firstCandidate = new WorkerStub();
    const latestCandidate = new WorkerStub();
    const registration = registrationStub({
      waiting: firstCandidate,
      active: oldWorker,
    });
    let requests = 0;

    const result = await activateRegistrationUpdate({
      getRegistration: async () => registration,
      timeoutMs: 500,
      pollIntervalMs: 2,
      sendActivation: (worker, acknowledge) => {
        requests += 1;
        acknowledge();
        setTimeout(() => {
          if (worker === (firstCandidate as unknown as ServiceWorker)) {
            registration.waiting = latestCandidate as unknown as ServiceWorker;
            firstCandidate.moveTo("redundant");
          } else {
            registration.waiting = null;
            registration.active = latestCandidate as unknown as ServiceWorker;
            latestCandidate.moveTo("activated");
          }
        }, 5);
      },
    });

    expect(result).toEqual({
      status: "activated",
      attempts: 2,
      acknowledged: true,
    });
    expect(requests).toBe(2);
  });

  it("لا يدّعي النجاح ولا يطلب إعادة الفتح عند انتهاء المهلة", async () => {
    const waiting = new WorkerStub();
    const registration = registrationStub({ waiting });

    const result = await activateRegistrationUpdate({
      getRegistration: async () => registration,
      timeoutMs: 15,
      pollIntervalMs: 2,
      sendActivation: () => undefined,
    });

    expect(result.status).toBe("timeout");
  });

  it("waits for activate to finish even after registration.active changes and ACK arrives", async () => {
    const previous = new WorkerStub();
    previous.state = "activated";
    const candidate = new WorkerStub();
    const registration = registrationStub({
      active: previous,
      waiting: candidate,
    });
    let finished = false;
    const pending = waitForWorkerActivation(
      registration,
      candidate as unknown as ServiceWorker,
      {
        timeoutMs: 200,
        pollIntervalMs: 2,
        sendActivation: (_worker, acknowledge) => {
          registration.waiting = null;
          registration.active = candidate as unknown as ServiceWorker;
          candidate.moveTo("activating");
          acknowledge();
        },
      },
    ).then((result) => {
      finished = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finished).toBe(false);
    candidate.moveTo("activated");
    await expect(pending).resolves.toEqual({
      status: "activated",
      acknowledged: true,
    });
  });

  it("waits for an already activating worker when waiting has been cleared", async () => {
    const candidate = new WorkerStub();
    candidate.state = "activating";
    const registration = registrationStub({ active: candidate });
    setTimeout(() => candidate.moveTo("activated"), 10);
    await expect(
      activateRegistrationUpdate({
        getRegistration: async () => registration,
        timeoutMs: 200,
        pollIntervalMs: 2,
        sendActivation: () => undefined,
      }),
    ).resolves.toMatchObject({ status: "activated" });
  });
});

describe("waiting worker stream release protocol", () => {
  function setup(fetchImpl: typeof fetch, online = true) {
    const handlers: Array<(event: any) => void> = [];
    const pending: Promise<unknown>[] = [];
    const skipWaiting = vi.fn(async () => undefined);
    runInNewContext(
      readFileSync(
        new URL("../../public/pwa-update-worker.js", import.meta.url),
        "utf8",
      ),
      {
        self: {
          location: { origin: "https://erp.example" },
          navigator: { onLine: online },
          skipWaiting,
          addEventListener: (_type: string, handler: any) =>
            handlers.push(handler),
        },
        fetch: fetchImpl,
        URL,
        AbortController,
        setTimeout,
        clearTimeout,
      },
    );
    return {
      skipWaiting,
      send(type: string, origin = "https://erp.example") {
        const reply = vi.fn();
        const stopImmediatePropagation = vi.fn();
        for (const handler of handlers)
          handler({
            data: { type, requestId: "test" },
            source: { url: `${origin}/delivery` },
            ports: [{ postMessage: reply }],
            stopImmediatePropagation,
            waitUntil: (promise: Promise<unknown>) => pending.push(promise),
          });
        return Object.assign(reply, { stopImmediatePropagation });
      },
      settle: () => Promise.all(pending),
    };
  }

  it("releases the authenticated stream before requesting activation and coalesces legacy messages", async () => {
    let release!: (value: Response) => void;
    const transport = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const worker = setup(transport as typeof fetch);
    const reply = worker.send("PWA_ACTIVATE");
    worker.send("SKIP_WAITING");
    expect(worker.skipWaiting).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    expect(transport).toHaveBeenCalledWith(
      "/api/realtime/pwa-quiesce",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: "{}",
      }),
    );
    release({ ok: true } as Response);
    await worker.settle();
    expect(worker.skipWaiting).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      type: "PWA_ACTIVATION_ACCEPTED",
      requestId: "test",
    });
    expect(reply.stopImmediatePropagation).toHaveBeenCalledTimes(1);
  });

  it("supports a legacy SKIP_WAITING-only client", async () => {
    const transport = vi.fn(async () => ({ ok: true }) as Response);
    const worker = setup(transport as typeof fetch);
    worker.send("SKIP_WAITING");
    await worker.settle();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(worker.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("retries stream release after a failed POST even when skipWaiting resolves immediately", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true });
    const worker = setup(transport as typeof fetch);
    worker.send("PWA_ACTIVATE");
    await worker.settle();
    expect(worker.skipWaiting).not.toHaveBeenCalled();
    worker.send("SKIP_WAITING");
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    await worker.settle();
    expect(worker.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("allows an anonymous storefront and a genuinely offline browser to activate", async () => {
    const anonymous = setup(
      vi.fn(
        async () => ({ ok: false, status: 401 }) as Response,
      ) as typeof fetch,
    );
    anonymous.send("SKIP_WAITING");
    await anonymous.settle();
    expect(anonymous.skipWaiting).toHaveBeenCalledTimes(1);
    const offline = setup(
      vi.fn(async () => {
        throw new Error("offline");
      }) as typeof fetch,
      false,
    );
    offline.send("SKIP_WAITING");
    await offline.settle();
    expect(offline.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("does not release streams for a cross-origin sender", async () => {
    const transport = vi.fn(async () => ({ ok: true }) as Response);
    const worker = setup(transport as typeof fetch);
    worker.send("PWA_ACTIVATE", "https://other.example");
    await worker.settle();
    expect(transport).not.toHaveBeenCalled();
    expect(worker.skipWaiting).not.toHaveBeenCalled();
  });

  it("does not acknowledge or request activation after transient release failure", async () => {
    const transport = vi.fn(async () => {
      throw new Error("offline");
    });
    const worker = setup(transport as typeof fetch);
    const reply = worker.send("PWA_ACTIVATE");
    await worker.settle();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(worker.skipWaiting).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      type: "PWA_ACTIVATION_REJECTED",
      requestId: "test",
    });
  });
});
