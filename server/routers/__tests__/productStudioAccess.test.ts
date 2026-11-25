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

  it("keeps the auditor read-only and excludes delivery couriers", async () => {
    const auditor = caller("auditor");
    await expect(auditor.read()).resolves.toBe(true);
    await expect(auditor.write()).rejects.toMatchObject({ code: "FORBIDDEN" });
    const courier = caller("courier");
    await expect(courier.read()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(courier.write()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(courier.manage()).rejects.toMatchObject({ code: "FORBIDDEN" });
    
    await expect(caller("cashier", { productStudio: "NONE" }).read()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows all non-courier company employees to read and write for approval, without manager authority", async () => {
    for (const role of ["accountant", "cashier", "warehouse", "purchasing", "sales_rep", "user"]) {
      const employee = caller(role);
      await expect(employee.read()).resolves.toBe(true);
      await expect(employee.write()).resolves.toBe(true);
      await expect(employee.manage()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("grants company cashier studio read/write by default without manager authority", async () => {
    const cashier = caller("cashier");
    await expect(cashier.read()).resolves.toBe(true);
    await expect(cashier.write()).resolves.toBe(true);
    await expect(cashier.manage()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("fails closed for a delegated worker without an assigned branch", async () => {
    await expect(caller("cashier", { branchId: null, productStudio: "FULL" }).write())
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
