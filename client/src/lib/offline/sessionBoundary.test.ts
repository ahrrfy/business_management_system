import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  resetSessionForLogin,
  resetSessionForLogout,
  resetSessionQueryCache,
} from "./sessionBoundary";

describe("session query-cache isolation", () => {
  it("removes a previous employee's fresh shift before the next identity is loaded", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 60_000 } },
    });
    const shiftKey = [
      ["shifts", "current"],
      {
        input: { branchId: 1, shiftType: "RECEPTION" },
        type: "query",
      },
    ] as const;

    queryClient.setQueryData(shiftKey, {
      id: 701,
      userId: 11,
      branchId: 1,
      shiftType: "RECEPTION",
      status: "OPEN",
    });

    await resetSessionQueryCache(queryClient);

    expect(queryClient.getQueryData(shiftKey)).toBeUndefined();
  });

  it("documents why invalidation alone is not an identity boundary", async () => {
    const queryClient = new QueryClient();
    const shiftKey = [
      ["shifts", "current"],
      {
        input: { branchId: 1, shiftType: "RECEPTION" },
        type: "query",
      },
    ] as const;
    queryClient.setQueryData(shiftKey, { id: 701, userId: 11 });

    await queryClient.invalidateQueries({ queryKey: shiftKey });

    expect(queryClient.getQueryData(shiftKey)).toEqual({ id: 701, userId: 11 });
  });

  it("preserves Studio drafts only when company and user are unchanged", async () => {
    const queryClient = new QueryClient();
    let purgeCount = 0;
    let receptionPurgeCount = 0;

    await resetSessionForLogin(queryClient, { companyId: 4, userId: 7 }, {
      loadStudioIdentity: async () => ({ companyId: 4, userId: 7, savedAt: 1 }),
      purgeStudioDrafts: async () => {
        purgeCount += 1;
      },
      purgeReceptionSnapshots: () => { receptionPurgeCount += 1; },
    });

    expect(purgeCount).toBe(0);
    expect(receptionPurgeCount).toBe(1);
  });

  it("purges Studio drafts when the company changes even for the same numeric user", async () => {
    const queryClient = new QueryClient();
    let purgeCount = 0;

    await resetSessionForLogin(queryClient, { companyId: 8, userId: 7 }, {
      loadStudioIdentity: async () => ({ companyId: 4, userId: 7, savedAt: 1 }),
      purgeStudioDrafts: async () => {
        purgeCount += 1;
      },
      purgeReceptionSnapshots: () => undefined,
    });

    expect(purgeCount).toBe(1);
  });

  it("purges Studio drafts for a different user or an unreadable legacy identity", async () => {
    for (const previous of [{ companyId: 4, userId: 7, savedAt: 1 }, null]) {
      const queryClient = new QueryClient(); let purgeCount = 0;
      await resetSessionForLogin(queryClient, { companyId: 4, userId: 8 }, {
        loadStudioIdentity: async () => previous,
        purgeStudioDrafts: async () => { purgeCount += 1; },
        purgeReceptionSnapshots: () => undefined,
      });
      expect(purgeCount).toBe(1);
    }
  });

  it("purges Studio drafts on explicit logout", async () => {
    const queryClient = new QueryClient();
    let purgeCount = 0;
    let receptionPurgeCount = 0;

    await resetSessionForLogout(queryClient, {
      loadStudioIdentity: async () => ({ companyId: 4, userId: 7, savedAt: 1 }),
      purgeStudioDrafts: async () => {
        purgeCount += 1;
      },
      purgeReceptionSnapshots: () => { receptionPurgeCount += 1; },
    });

    expect(purgeCount).toBe(1);
    expect(receptionPurgeCount).toBe(1);
  });

  it("does not block a session boundary when browser storage throws synchronously", async () => {
    const queryClient = new QueryClient();
    const dependencies = {
      loadStudioIdentity: async () => ({ companyId: 4, userId: 7, savedAt: 1 }),
      purgeStudioDrafts: async () => undefined,
      purgeReceptionSnapshots: () => { throw new DOMException("blocked", "SecurityError"); },
    };

    await expect(resetSessionForLogin(queryClient, { companyId: 4, userId: 7 }, dependencies)).resolves.toBeUndefined();
    await expect(resetSessionForLogout(queryClient, dependencies)).resolves.toBeUndefined();
  });
});
