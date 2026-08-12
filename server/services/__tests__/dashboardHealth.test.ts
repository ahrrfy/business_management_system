import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../../context";
import { appRouter } from "../../routers";
import { truncateTables } from "./__testUtils__";

vi.mock("../arRemindersService", () => ({
  getReminderQueue: vi.fn().mockRejectedValue(new Error("injected reminder source failure")),
}));

beforeEach(async () => {
  await truncateTables([
    "branchStock",
    "productVariants",
    "invoices",
    "workOrders",
    "tasks",
  ]);
});

describe("dashboard source health", () => {
  it("propagates a swallowed dashboard dependency failure to command-center health", async () => {
    const context = {
      req: { headers: {} },
      res: {},
      sessionId: null,
      platformAdmin: null,
      user: {
        id: 55,
        openId: "health-manager",
        name: "Health manager",
        role: "manager",
        branchId: 1,
        isOwner: false,
        isActive: true,
      },
    } as unknown as TrpcContext;

    const result = await appRouter.createCaller(context).executive.commandCenter();

    expect(result.health.status).toBe("degraded");
    expect(result.health.partialErrors).toContainEqual({
      section: "metrics.receivableReminders",
      code: "SOURCE_UNAVAILABLE",
    });
  });
});
