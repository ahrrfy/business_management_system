import { describe, expect, it } from "vitest";
import {
  productStudioManagerProcedure,
  productStudioReadProcedure,
  productStudioWriteProcedure,
  router,
} from "../../trpc";

const probe = router({
  read: productStudioReadProcedure.query(() => true),
  write: productStudioWriteProcedure.query(() => true),
  manage: productStudioManagerProcedure.query(() => true),
});

function caller(
  role: string,
  options: { branchId?: number | null; productStudio?: "FULL" | "READ" | "NONE" } = {},
) {
  return probe.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      id: 71,
      role,
      branchId: options.branchId === undefined ? 1 : options.branchId,
      permissionsOverride: options.productStudio
        ? { productStudio: options.productStudio }
        : null,
      totpEnabledAt: new Date(),
    },
  } as never);
}

describe("product studio authority", () => {
  it("gives the combined photo/content operator read and write, but not manager actions", async () => {
    const operator = caller("print_operator");
    await expect(operator.read()).resolves.toBe(true);
    await expect(operator.write()).resolves.toBe(true);
    await expect(operator.manage()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps the auditor read-only and unrelated roles outside", async () => {
    const auditor = caller("auditor");
    await expect(auditor.read()).resolves.toBe(true);
    await expect(auditor.write()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("cashier").read()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("honours explicit worker grants without granting manager authority", async () => {
    const delegated = caller("cashier", { productStudio: "FULL" });
    await expect(delegated.read()).resolves.toBe(true);
    await expect(delegated.write()).resolves.toBe(true);
    await expect(delegated.manage()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("fails closed for a delegated worker without an assigned branch", async () => {
    await expect(caller("cashier", { branchId: null, productStudio: "FULL" }).write())
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
