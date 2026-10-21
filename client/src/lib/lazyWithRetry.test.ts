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
});
