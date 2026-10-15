import { describe, expect, it, vi } from "vitest";
import {
  automaticStorefrontPersistenceIsSafe,
  clearPwaAutoAttempt,
  decidePwaUpdateDelivery,
  PWA_FAILED_AUTO_RETRY_COOLDOWN_MS,
  pwaActivationTimeoutMessage,
  pwaOfflineReadyMessage,
  readPwaAutoAttempt,
  requestStorefrontPersistence,
  requiresStorefrontPersistence,
  resolveWaitingWorkerVersion,
  shouldAutoApplyWaitingVersion,
  shouldClearPwaAutoAttempt,
  shouldReloadAfterActivationTimeout,
  writePwaAutoAttempt,
} from "./PwaUpdateManager";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
}

describe("PWA update delivery policy", () => {
  it("requires the storefront saver on public store routes, but not unattended kiosks", () => {
    expect(
      requiresStorefrontPersistence({
        hostname: "alarabiya.online",
        pathname: "/store",
      }),
    ).toBe(true);
    expect(
      requiresStorefrontPersistence({
        hostname: "alarabiya.online",
        pathname: "/store/product/1",
      }),
    ).toBe(true);
    for (const pathname of [
      "/kiosk",
      "/kiosk/1",
      "/price-checker",
      "/delivery",
    ]) {
      expect(
        requiresStorefrontPersistence({
          hostname: "alarabiya.online",
          pathname,
        }),
      ).toBe(false);
    }
  });
  it("auto-applies a waiting release for a returning public storefront visitor", () => {
    expect(
      decidePwaUpdateDelivery({
        hostname: "alarabiya.online",
        pathname: "/store",
        hasWaitingWorker: true,
      }),
    ).toBe("AUTO_APPLY");
    expect(
      decidePwaUpdateDelivery({
        hostname: "www.alarabiya.online",
        pathname: "/store/product/1",
        hasWaitingWorker: true,
      }),
    ).toBe("AUTO_APPLY");
  });

  it("does nothing for a fresh visitor without a waiting worker", () => {
    expect(
      decidePwaUpdateDelivery({
        hostname: "alarabiya.online",
        pathname: "/store",
        hasWaitingWorker: false,
      }),
    ).toBe("NONE");
  });

  it("keeps the guarded prompt for internal staff and courier surfaces", () => {
    expect(
      decidePwaUpdateDelivery({
        hostname: "srv1548487.hstgr.cloud",
        pathname: "/pos",
        hasWaitingWorker: true,
      }),
    ).toBe("PROMPT");
    expect(
      decidePwaUpdateDelivery({
        hostname: "alarabiya.online",
        pathname: "/my-deliveries",
        hasWaitingWorker: true,
      }),
    ).toBe("PROMPT");
  });

  it("re-evaluates a waiting worker when the public SPA moves from root to storefront", () => {
    const waiting = { hostname: "alarabiya.online", hasWaitingWorker: true };

    expect(decidePwaUpdateDelivery({ ...waiting, pathname: "/" })).toBe(
      "PROMPT",
    );
    expect(decidePwaUpdateDelivery({ ...waiting, pathname: "/store" })).toBe(
      "AUTO_APPLY",
    );
  });

  it("auto-applies silently for unattended kiosk and price-checker surfaces", () => {
    const waiting = {
      hostname: "srv1548487.hstgr.cloud",
      hasWaitingWorker: true,
    };

    expect(decidePwaUpdateDelivery({ ...waiting, pathname: "/kiosk" })).toBe(
      "AUTO_APPLY",
    );
    expect(
      decidePwaUpdateDelivery({ ...waiting, pathname: "/kiosk/sub" }),
    ).toBe("AUTO_APPLY");
    expect(
      decidePwaUpdateDelivery({ ...waiting, pathname: "/price-checker" }),
    ).toBe("AUTO_APPLY");
    expect(
      decidePwaUpdateDelivery({
        ...waiting,
        pathname: "/price-checker/preview",
      }),
    ).toBe("AUTO_APPLY");
  });
});

describe("PWA offline claim", () => {
  it("describes a cached storefront shell without claiming offline commerce", () => {
    const message = pwaOfflineReadyMessage({
      hostname: "alarabiya.online",
      pathname: "/store",
    });

    expect(message).toContain("واجهة مكتبة العربية");
    expect(message).toContain("يحتاج اتصالاً بالإنترنت");
    expect(message).not.toContain("جاهز للعمل دون اتصال");
  });
});

describe("PWA automatic attempt persistence", () => {
  it("survives a simulated reload and blocks the same waiting version from looping", () => {
    const storage = memoryStorage();
    const attempt = {
      version: "/sw.js|etag:v1",
      status: "RELOADING" as const,
      attemptedAt: 1,
    };

    expect(writePwaAutoAttempt(attempt, storage)).toBe(true);
    const afterReload = readPwaAutoAttempt(storage);
    expect(afterReload).toEqual({ ok: true, value: attempt });
    expect(
      shouldAutoApplyWaitingVersion(attempt.version, afterReload.value),
    ).toBe(false);

    // بقاء waiting يعني أن ACTIVATED لم يُثبت: لا نمسح العلامة ولا نعيد المحاولة الصامتة.
    expect(
      shouldClearPwaAutoAttempt({
        hasWaitingWorker: true,
        activeWorkerState: "activated",
        activationVerified: true,
      }),
    ).toBe(false);
    expect(readPwaAutoAttempt(storage).value).toEqual(attempt);

    // لا تُمحى إلا بعد active=activated واختفاء waiting فعلاً.
    expect(
      shouldClearPwaAutoAttempt({
        hasWaitingWorker: false,
        activeWorkerState: "activated",
        activationVerified: true,
      }),
    ).toBe(true);
    expect(clearPwaAutoAttempt(storage)).toBe(true);
    expect(readPwaAutoAttempt(storage)).toEqual({ ok: true, value: null });
  });

  it("does not clear an attempt merely because the old active worker still exists", () => {
    expect(
      shouldClearPwaAutoAttempt({
        hasWaitingWorker: false,
        activeWorkerState: "activated",
        activationVerified: false,
      }),
    ).toBe(false);
  });

  it("identifies worker versions by response identity instead of object identity", async () => {
    const worker = { scriptURL: "https://alarabiya.online/sw.js" };
    const v1 = vi.fn(
      async () => new Response("worker", { headers: { etag: '"v1"' } }),
    );
    const v2 = vi.fn(
      async () => new Response("worker", { headers: { etag: '"v2"' } }),
    );

    await expect(
      resolveWaitingWorkerVersion(worker, v1 as typeof fetch),
    ).resolves.toContain('etag:"v1"');
    await expect(
      resolveWaitingWorkerVersion(worker, v2 as typeof fetch),
    ).resolves.toContain('etag:"v2"');
  });

  it("does not auto-apply without a durable worker-version fingerprint", async () => {
    const worker = { scriptURL: "https://alarabiya.online/sw.js" };
    const unavailable = vi.fn(async () => new Response("", { status: 503 }));

    await expect(
      resolveWaitingWorkerVersion(worker, unavailable as typeof fetch),
    ).resolves.toBeNull();
  });

  it("fails closed when the persistent attempt marker cannot be stored", () => {
    const blockedStorage = {
      getItem: vi.fn(() => {
        throw new DOMException("blocked", "SecurityError");
      }),
      setItem: vi.fn(() => {
        throw new DOMException("blocked", "SecurityError");
      }),
      removeItem: vi.fn(),
    };

    expect(readPwaAutoAttempt(blockedStorage)).toEqual({
      ok: false,
      value: null,
    });
    expect(
      writePwaAutoAttempt(
        { version: "v1", status: "ATTEMPTING", attemptedAt: 1 },
        blockedStorage,
      ),
    ).toBe(false);
  });

  it("reloads on manual timeout only when the worker acknowledged skipWaiting or entered activating", () => {
    expect(
      shouldReloadAfterActivationTimeout({
        manual: false,
        acknowledged: true,
        activeWorkerState: "activating",
      }),
    ).toBe(false);
    expect(
      shouldReloadAfterActivationTimeout({
        manual: true,
        acknowledged: true,
        activeWorkerState: "activated",
      }),
    ).toBe(true);
    expect(
      shouldReloadAfterActivationTimeout({
        manual: true,
        acknowledged: false,
        activeWorkerState: "activating",
      }),
    ).toBe(true);
    expect(
      shouldReloadAfterActivationTimeout({
        manual: true,
        acknowledged: false,
        activeWorkerState: "activated",
      }),
    ).toBe(false);
  });

  it("uses surface-aware wording when activation times out", () => {
    expect(
      pwaActivationTimeoutMessage({
        hostname: "alarabiya.online",
        pathname: "/store",
      }),
    ).toContain("ولم يُفقد طلبك");
    expect(
      pwaActivationTimeoutMessage({
        hostname: "srv1548487.hstgr.cloud",
        pathname: "/pos",
      }),
    ).toContain("وبقي عملك محفوظاً");
  });

  it("allows unattended kiosks to retry a FAILED version after the cooldown without looping RELOADING", () => {
    const failed = {
      version: "/sw.js|etag:v1",
      status: "FAILED" as const,
      attemptedAt: 1_000,
    };
    expect(shouldAutoApplyWaitingVersion(failed.version, failed)).toBe(false);
    expect(
      shouldAutoApplyWaitingVersion(failed.version, failed, {
        unattended: true,
        now: 1_000 + PWA_FAILED_AUTO_RETRY_COOLDOWN_MS - 1,
      }),
    ).toBe(false);
    expect(
      shouldAutoApplyWaitingVersion(failed.version, failed, {
        unattended: true,
        now: 1_000 + PWA_FAILED_AUTO_RETRY_COOLDOWN_MS,
      }),
    ).toBe(true);
    expect(
      shouldAutoApplyWaitingVersion(
        failed.version,
        { ...failed, status: "RELOADING" },
        {
          unattended: true,
          now: 1_000 + PWA_FAILED_AUTO_RETRY_COOLDOWN_MS * 10,
        },
      ),
    ).toBe(false);
  });
});

describe("storefront save handshake", () => {
  it("allows automatic apply only after the mounted storefront confirms its snapshot", () => {
    const target = {
      dispatchEvent(event: Event) {
        const detail = (
          event as CustomEvent<{ report: (saved: boolean) => void }>
        ).detail;
        detail.report(true);
        return true;
      },
    };

    const result = requestStorefrontPersistence(target);
    expect(result).toEqual({ attempted: 1, ok: true, inFlight: false });
    expect(automaticStorefrontPersistenceIsSafe(result)).toBe(true);
  });

  it("blocks automatic apply when the mounted storefront reports quota failure", () => {
    const target = {
      dispatchEvent(event: Event) {
        const detail = (
          event as CustomEvent<{ report: (saved: boolean) => void }>
        ).detail;
        detail.report(false);
        return true;
      },
    };

    const result = requestStorefrontPersistence(target);
    expect(result).toEqual({ attempted: 1, ok: false, inFlight: false });
    expect(automaticStorefrontPersistenceIsSafe(result)).toBe(false);
  });

  it("requires a mounted storefront saver before automatic apply", () => {
    const target = { dispatchEvent: vi.fn(() => true) };
    const result = requestStorefrontPersistence(target);

    expect(result).toEqual({ attempted: 0, ok: true, inFlight: false });
    expect(automaticStorefrontPersistenceIsSafe(result)).toBe(false);
  });

  it("blocks automatic apply while createOrder is in flight even after the snapshot is durable", () => {
    const target = {
      dispatchEvent(event: Event) {
        const detail = (
          event as CustomEvent<{
            report: (saved: boolean, state?: { inFlight: boolean }) => void;
          }>
        ).detail;
        detail.report(true, { inFlight: true });
        return true;
      },
    };
    const result = requestStorefrontPersistence(target);
    expect(result).toEqual({ attempted: 1, ok: true, inFlight: true });
    expect(automaticStorefrontPersistenceIsSafe(result)).toBe(false);
  });
});

