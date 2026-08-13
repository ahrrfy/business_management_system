import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { resetSessionQueryCache } from "./sessionBoundary";

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
});
