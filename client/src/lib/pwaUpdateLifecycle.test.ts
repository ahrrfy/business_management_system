import { describe, expect, it } from "vitest";
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
});
