import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

function expectEvery(source: string, fragments: string[]) {
  for (const fragment of fragments) expect(source).toContain(fragment);
}

describe("financial hardening source contracts", () => {
  it("keeps stocktake mutations behind the inventory FULL gate", () => {
    const source = read("server/routers/stocktakeRouter.ts");
    expectEvery(source, [
      "review: inventoryManagerProcedure",
      "resolveConflict: inventoryManagerProcedure",
      "decide: inventoryManagerProcedure",
      "firstSign: inventoryManagerProcedure",
      "approve: inventoryManagerProcedure",
      "forceReview: inventoryManagerProcedure",
      "ira: inventoryManagerProcedure",
      "report: inventoryManagerProcedure",
      "log: inventoryManagerProcedure",
    ]);
  });

  it("keeps user branch assignment fail-closed and transactional", () => {
    const source = read("server/services/userService.ts");
    expectEvery(source, [
      "import {",
      "branches,",
      "async function assertUserBranchAssignmentTx(",
      "await assertUserBranchAssignmentTx(tx, input.branchId, roleValue);",
      "await assertUserBranchAssignmentTx(tx, input.branchId, (nextRole ?? existing.role) as Role);",
      "لا يمكن",
    ]);
  });

  it("keeps financial body limits aligned with router attachment contracts", () => {
    const bodyParsers = read("server/middleware/bodyParsers.ts");
    const expenseRouter = read("server/routers/expenseRouter.ts");
    const payrollRouter = read("server/routers/payrollRouter.ts");
    expectEvery(bodyParsers, [
      'req.path.includes("expenses.requestAccrualCorrection")',
      'req.path.includes("payroll.createRemittance")',
      'req.path.includes("payroll.advanceGrant")',
      'express.json({ limit: "3mb" })',
    ]);
    expect(expenseRouter).toContain("attachmentUrl: z.string().trim().min(1).max(3_000_000)");
    expect(payrollRouter).toContain("supportingDocumentUrl: z.string().trim().min(1).max(3_000_000)");
    expect(payrollRouter).toContain("attachmentUrl: z.string().max(3_000_000).nullish()");
  });

  it("keeps dependency security overrides active under pnpm 11", () => {
    const workspace = read("pnpm-workspace.yaml");
    const packageJson = read("package.json");
    expect(packageJson).toContain('"uuid@<11.1.1": ">=11.1.1"');
    expect(packageJson).toContain('"@opentelemetry/core@<2.8.0": ">=2.8.0"');
    expect(workspace).not.toContain("overrides:");
  });

  it("does not acknowledge external webhooks when persistence fails", () => {
    const source = read("server/routes/channelWebhooks.ts");
    expect(source).toContain('return res.status(503).send("temporary failure")');
    expect(source).toContain("externalId يمنع التكرار");
  });

  it("keeps list actions on the shared gated action contract", () => {
    const pages = [
      "client/src/pages/Promotions.tsx",
      "client/src/pages/Shifts.tsx",
      "client/src/pages/Coupons.tsx",
      "client/src/pages/PeriodLock.tsx",
      "client/src/pages/LegacyDataRepair.tsx",
      "client/src/pages/digitalCards/DigitalDashboard.tsx",
      "client/src/pages/digitalCards/DigitalReview.tsx",
    ];
    for (const page of pages) {
      const source = read(page);
      expect(source, page).toContain("RowActions");
    }
  });
});
