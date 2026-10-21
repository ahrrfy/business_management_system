import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lazyWithRetry } from "./lazyWithRetry";

type LazyPayloadLoader<T> = {
  _payload: {
    _result: () => Promise<{ default: T }>;
  };
};

function invokeLazyLoader<T extends ComponentType<unknown>>(
  lazyComp: ReturnType<typeof lazyWithRetry<T>>,
): Promise<{ default: T }> {
  return (lazyComp as unknown as LazyPayloadLoader<T>)._payload._result();
}

function createMemorySessionStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

describe("lazyWithRetry", () => {
  let storage: Storage;
  let reloadMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    storage = createMemorySessionStorage();
    reloadMock = vi.fn();
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("window", {
      location: {
        reload: reloadMock,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reloads once on first chunk load failure and throws on the second failure", async () => {
    const chunkErr = new TypeError(
      "Failed to fetch dynamically imported module: https://erp.alarabiya.online/assets/Dashboard-Cdl1COE7.js",
    );

    // Load 1: fails -> triggers reload and hangs pending navigation
    const DashboardLoad1 = lazyWithRetry(async () => {
      throw chunkErr;
    });
    const pendingOutcome = await Promise.race([
      invokeLazyLoader(DashboardLoad1).then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);
    expect(pendingOutcome).toBe("pending");
    expect(reloadMock).toHaveBeenCalledTimes(1);

    // Load 2 (after reload): fails again -> must throw to RouteErrorBoundary without reloading again
    const DashboardLoad2 = lazyWithRetry(async () => {
      throw chunkErr;
    });
    await expect(invokeLazyLoader(DashboardLoad2)).rejects.toThrow(
      "Failed to fetch dynamically imported module",
    );
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("does not enter an infinite reload loop when a cached sibling chunk (QuranStationDrawer) resolves before the route chunk (Dashboard) fails", async () => {
    const DrawerComp = () => null;
    const dashboardErr = new TypeError(
      "Failed to fetch dynamically imported module: https://erp.alarabiya.online/assets/Dashboard-Cdl1COE7.js",
    );

    // Simulate 3 consecutive page loads where QuranStationDrawer is cached and resolves in 1ms,
    // while Dashboard is absent on the server and fails after 5ms.
    for (let loadAttempt = 1; loadAttempt <= 2; loadAttempt++) {
      const QuranStationDrawer = lazyWithRetry(function quranDrawerFactory() {
        return Promise.resolve({ default: DrawerComp });
      });
      const Dashboard = lazyWithRetry(function dashboardFactory() {
        return new Promise<{ default: ComponentType }>((_, reject) => {
          setTimeout(() => reject(dashboardErr), 5);
        });
      });

      // QuranStationDrawer mounts at App root and resolves immediately from CacheStorage
      const drawerMod = await invokeLazyLoader(QuranStationDrawer);
      expect(drawerMod.default).toBe(DrawerComp);

      if (loadAttempt === 1) {
        const firstOutcome = await Promise.race([
          invokeLazyLoader(Dashboard).then(
            () => "resolved",
            () => "rejected",
          ),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve("pending"), 25),
          ),
        ]);
        expect(firstOutcome).toBe("pending");
        expect(reloadMock).toHaveBeenCalledTimes(1);
      } else {
        // On Load 2 (after the single reload), Dashboard must reject to RouteErrorBoundary
        // instead of calling window.location.reload() a second time (which caused the 394x/140x production loop).
        const secondOutcome = await Promise.race([
          invokeLazyLoader(Dashboard).then(
            () => "resolved",
            (e: unknown) => `rejected:${(e as Error).message}`,
          ),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve("hung-on-second-reload"), 25),
          ),
        ]);
        expect(secondOutcome).toContain(
          "rejected:Failed to fetch dynamically imported module",
        );
        expect(reloadMock).toHaveBeenCalledTimes(1);
      }
    }
  });

  it("clears the reload guard when the failing route chunk succeeds after reload (even with a new Vite hash)", async () => {
    const DashboardComp = () => null;
    const oldChunkErr = new TypeError(
      "Failed to fetch dynamically imported module: https://erp.alarabiya.online/assets/Dashboard-Cdl1COE7.js",
    );

    // Load 1: old bundle hash fails (__vitePreload with Dashboard-Cdl1COE7.js)
    const oldDashboardFactory = () =>
      Promise.reject(oldChunkErr) as Promise<{ default: ComponentType }>;
    Object.defineProperty(oldDashboardFactory, "toString", {
      value: () =>
        '() => __vitePreload(() => import("./Dashboard-Cdl1COE7.js"), __vite__mapDeps([0,1,2,3]))',
    });
    const DashboardOld = lazyWithRetry(oldDashboardFactory);
    await Promise.race([
      invokeLazyLoader(DashboardOld),
      new Promise((resolve) => setTimeout(resolve, 15)),
    ]);
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(storage.getItem("alroya:chunk-reload-attempted")).not.toBeNull();

    // Load 2: new bundle hash for the same component succeeds (__vitePreload with Dashboard-BLe69uMD.js)
    const newDashboardFactory = () =>
      Promise.resolve({ default: DashboardComp });
    Object.defineProperty(newDashboardFactory, "toString", {
      value: () =>
        '() => __vitePreload(() => import("./Dashboard-BLe69uMD.js"), __vite__mapDeps([0,4,5,6]))',
    });
    const DashboardNew = lazyWithRetry(newDashboardFactory);
    const loaded = await invokeLazyLoader(DashboardNew);
    expect(loaded.default).toBe(DashboardComp);
    expect(storage.getItem("alroya:chunk-reload-attempted")).toBeNull();

    // Load 3 (future deployment): another failure is allowed to reload once again
    const futureDashboardFactory = () =>
      Promise.reject(oldChunkErr) as Promise<{ default: ComponentType }>;
    Object.defineProperty(futureDashboardFactory, "toString", {
      value: () =>
        '() => __vitePreload(() => import("./Dashboard-BLe69uMD.js"), __vite__mapDeps([0,4,5,6]))',
    });
    const DashboardFuture = lazyWithRetry(futureDashboardFactory);
    await Promise.race([
      invokeLazyLoader(DashboardFuture),
      new Promise((resolve) => setTimeout(resolve, 15)),
    ]);
    expect(reloadMock).toHaveBeenCalledTimes(2);
  });

  it("rethrows non-chunk errors immediately without reloading", async () => {
    const BrokenComp = lazyWithRetry(async () => {
      throw new Error("Unexpected application error");
    });
    await expect(invokeLazyLoader(BrokenComp)).rejects.toThrow(
      "Unexpected application error",
    );
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("allows a fresh single reload if a prior reload guard expired (>30s old after route redirect)", async () => {
    const chunkErr = new TypeError(
      "Failed to fetch dynamically imported module: https://erp.alarabiya.online/assets/Login-DQeKWJUm.js",
    );
    // Simulate a guard set 31 seconds ago by Dashboard before a redirect to /login
    storage.setItem(
      "alroya:chunk-reload-attempted",
      `./Dashboard.js\n${Date.now() - 31_000}`,
    );

    const LoginLazy = lazyWithRetry(function loginFactory() {
      return Promise.reject(chunkErr) as Promise<{ default: ComponentType }>;
    });
    const outcome = await Promise.race([
      invokeLazyLoader(LoginLazy).then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 15)),
    ]);
    expect(outcome).toBe("pending");
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("does not enter an infinite reload loop when two uncached chunks (Login + QuranStationDrawer) both fail across consecutive loads", async () => {
    const loginErr = new TypeError(
      "Failed to fetch dynamically imported module: https://erp.alarabiya.online/assets/Login-DQeKWJUm.js",
    );
    const drawerErr = new TypeError(
      "Failed to fetch dynamically imported module: https://erp.alarabiya.online/assets/QuranStationDrawer-Dz5S4onU.js",
    );

    // Load 1: Both Login (2ms) and QuranStationDrawer (6ms) fail over the network.
    // Login triggers the single reload; QuranStationDrawer failing 4ms later must not
    // erase RELOAD_GUARD_KEY or trigger a second reload.
    const LoginLoad1 = lazyWithRetry(function loginFactory1() {
      return new Promise<{ default: ComponentType }>((_, reject) => {
        setTimeout(() => reject(loginErr), 2);
      });
    });
    const DrawerLoad1 = lazyWithRetry(function drawerFactory1() {
      return new Promise<{ default: ComponentType }>((_, reject) => {
        setTimeout(() => reject(drawerErr), 6);
      });
    });

    const [loginLoad1Outcome, drawerLoad1Outcome] = await Promise.all([
      Promise.race([
        invokeLazyLoader(LoginLoad1).then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("pending"), 20),
        ),
      ]),
      Promise.race([
        invokeLazyLoader(DrawerLoad1).then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("pending"), 20),
        ),
      ]),
    ]);

    expect(loginLoad1Outcome).toBe("pending");
    expect(drawerLoad1Outcome).toBe("pending");
    expect(reloadMock).toHaveBeenCalledTimes(1);

    // Load 2 (after reload): Both Login (2ms) and QuranStationDrawer (6ms) fail again.
    // Both must reject to their error boundaries without erasing the guard or reloading a second time.
    const LoginLoad2 = lazyWithRetry(function loginFactory2() {
      return new Promise<{ default: ComponentType }>((_, reject) => {
        setTimeout(() => reject(loginErr), 2);
      });
    });
    const DrawerLoad2 = lazyWithRetry(function drawerFactory2() {
      return new Promise<{ default: ComponentType }>((_, reject) => {
        setTimeout(() => reject(drawerErr), 6);
      });
    });

    await expect(invokeLazyLoader(LoginLoad2)).rejects.toThrow(
      "Failed to fetch dynamically imported module",
    );
    await expect(invokeLazyLoader(DrawerLoad2)).rejects.toThrow(
      "Failed to fetch dynamically imported module",
    );
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed to ErrorBoundary without reloading when sessionStorage.setItem throws", async () => {
    const chunkErr = new TypeError(
      "Failed to fetch dynamically imported module: https://erp.alarabiya.online/assets/Dashboard-Cdl1COE7.js",
    );
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    const DashboardLazy = lazyWithRetry(async () => {
      throw chunkErr;
    });

    await expect(invokeLazyLoader(DashboardLazy)).rejects.toThrow(
      "Failed to fetch dynamically imported module",
    );
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("recognizes Vite CSS preload errors (Unable to preload CSS / Loading CSS chunk) as chunk load errors", async () => {
    const cssErr = new Error(
      "Unable to preload CSS for /assets/Dashboard-Cdl1COE7.css",
    );

    const DashboardCssLoad1 = lazyWithRetry(function dashboardCssFactory1() {
      return Promise.reject(cssErr) as Promise<{ default: ComponentType }>;
    });
    const firstOutcome = await Promise.race([
      invokeLazyLoader(DashboardCssLoad1).then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);
    expect(firstOutcome).toBe("pending");
    expect(reloadMock).toHaveBeenCalledTimes(1);

    const DashboardCssLoad2 = lazyWithRetry(function dashboardCssFactory2() {
      return Promise.reject(cssErr) as Promise<{ default: ComponentType }>;
    });
    await expect(invokeLazyLoader(DashboardCssLoad2)).rejects.toThrow(
      "Unable to preload CSS for /assets/Dashboard-Cdl1COE7.css",
    );
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("updates and activates an installing/waiting Service Worker before reloading when controlled by a stale Service Worker", async () => {
    const events: string[] = [];
    const chunkErr = new TypeError(
      "Failed to fetch dynamically imported module: https://erp.alarabiya.online/assets/Dashboard-Cdl1COE7.js",
    );

    const oldActiveWorker = {
      state: "activated" as ServiceWorkerState,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
    };

    const listeners = new Set<() => void>();
    const newWorker = {
      state: "installing" as ServiceWorkerState,
      addEventListener: vi.fn((type: string, cb: () => void) => {
        if (type === "statechange") listeners.add(cb);
      }),
      removeEventListener: vi.fn((type: string, cb: () => void) => {
        if (type === "statechange") listeners.delete(cb);
      }),
      postMessage: vi.fn((msg: { type?: string }) => {
        if (msg?.type === "SKIP_WAITING" || msg?.type === "PWA_ACTIVATE") {
          events.push(`sw:${msg.type}`);
          newWorker.state = "activated";
          registration.waiting = null;
          registration.active = newWorker as unknown as ServiceWorker;
          listeners.forEach((cb) => cb());
        }
      }),
    };

    const registration = {
      active: oldActiveWorker as unknown as ServiceWorker,
      waiting: null as ServiceWorker | null,
      installing: null as ServiceWorker | null,
      update: vi.fn(async () => {
        events.push("sw:update");
        registration.installing = newWorker as unknown as ServiceWorker;
        setTimeout(() => {
          events.push("sw:installed");
          newWorker.state = "installed";
          registration.installing = null;
          registration.waiting = newWorker as unknown as ServiceWorker;
          listeners.forEach((cb) => cb());
        }, 5);
      }),
    };

    reloadMock.mockImplementation(() => {
      events.push("window:reload");
    });

    vi.stubGlobal("navigator", {
      serviceWorker: {
        controller: oldActiveWorker,
        getRegistration: vi.fn(async () => registration),
      },
    });

    const DashboardLazy = lazyWithRetry(async () => {
      throw chunkErr;
    });

    const outcome = await Promise.race([
      invokeLazyLoader(DashboardLazy).then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 60)),
    ]);

    expect(outcome).toBe("pending");
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(events[0]).toBe("sw:update");
    expect(events).toContain("sw:installed");
    expect(
      events.some((e) => e === "sw:PWA_ACTIVATE" || e === "sw:SKIP_WAITING"),
    ).toBe(true);
    expect(events[events.length - 1]).toBe("window:reload");
  });
});
