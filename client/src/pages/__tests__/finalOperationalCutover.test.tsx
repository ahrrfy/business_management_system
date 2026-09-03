import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INVOICE_LIST_GATE,
  WORK_ORDERS_HUB_GATE,
  canSeeGate,
  type RoleGate,
} from "@/lib/navVisibility";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("final operational UI cutover", () => {
  it("requires every branch of an allOf gate", () => {
    const dailyGate: RoleGate = {
      allOf: [
        {
          roles: ["manager", "accountant", "auditor"],
          module: "reports",
          level: "READ",
        },
        {
          roles: ["manager", "accountant", "auditor"],
          module: "treasury",
          level: "READ",
        },
      ],
    };

    expect(canSeeGate(dailyGate, "admin", null)).toBe(true);
    expect(
      canSeeGate(dailyGate, "accountant", {
        reports: "READ",
        treasury: "READ",
      }),
    ).toBe(true);
    expect(
      canSeeGate(dailyGate, "accountant", {
        reports: "READ",
        treasury: "NONE",
      }),
    ).toBe(false);
    expect(
      canSeeGate(dailyGate, "accountant", {
        reports: "NONE",
        treasury: "READ",
      }),
    ).toBe(false);
  });

  it("keeps direct routes behind the same gates as their server procedures", () => {
    const app = read("../../App.tsx");

    expect(app).toContain('<Redirect to="/reports/sales-hub" />');
    expect(app).toContain(
      "<RequireRole gate={INVOICE_LIST_GATE}><SalesHub /></RequireRole>",
    );
    expect(app).toContain(
      "<RequireRole gate={INVOICE_LIST_GATE}><InvoiceDetail /></RequireRole>",
    );
    expect(app).toContain(
      '<RequireRole roles={["manager"]} module="sales" level="FULL"><SalesReturnNew /></RequireRole>',
    );
    expect(app).toContain(
      "<RequireRole gate={WORK_ORDERS_HUB_GATE}><PrintHub /></RequireRole>",
    );
    expect(app).toContain(
      '<RequireRole module="workorders" level="READ"><WorkOrderDetail /></RequireRole>',
    );
    expect(app).toContain(
      '<RequireRole roles={["manager"]} module="inventory" level="FULL"><ProductionNew /></RequireRole>',
    );
    expect(app).toContain(
      '<RequireRole roles={["manager"]} module="inventory" level="FULL"><ProductionDetail /></RequireRole>',
    );
    expect(app).toContain(
      '<RequireRole roles={["manager", "purchasing"]} module="purchases" level="FULL"><PurchaseReturnNew /></RequireRole>',
    );
    expect(app).toContain(
      '<RequireRole roles={["manager", "purchasing"]} module="purchases" level="FULL"><PurchaseReturnDetail /></RequireRole>',
    );
    expect(app).toContain(
      '<RequireRole module="purchases" level="READ"><PurchaseOrderDetail /></RequireRole>',
    );
    expect(app).toContain("<Redirect to={`/purchases/${params.id}`} />");
    expect(app).toContain(
      '<Route path="/purchases/goods-receipts"><Redirect to="/purchases" /></Route>',
    );
    expect(app).toContain(
      '<Route path="/purchases/supplier-invoices"><Redirect to="/purchases" /></Route>',
    );
    expect(app).not.toContain('import("@/pages/PurchaseReceive")');
    expect(app).not.toContain('import("@/pages/PurchaseGoodsReceipts")');
    expect(app).not.toContain('import("@/pages/PurchaseSupplierInvoices")');

    const namedPurchaseRoute = app.indexOf('path="/purchases/goods-receipts"');
    const legacyReceiveRoute = app.indexOf('path="/purchases/:id/receive"');
    const dynamicPurchaseRoute = app.indexOf('path="/purchases/:id"');
    expect(namedPurchaseRoute).toBeGreaterThanOrEqual(0);
    expect(dynamicPurchaseRoute).toBeGreaterThan(namedPurchaseRoute);
    expect(dynamicPurchaseRoute).toBeGreaterThan(legacyReceiveRoute);

    expect(canSeeGate(INVOICE_LIST_GATE, "print_operator", null)).toBe(true);
    expect(
      canSeeGate(WORK_ORDERS_HUB_GATE, "accountant", { inventory: "FULL" }),
    ).toBe(true);
  });

  it("hides cross-branch purchase controls from branch managers", () => {
    const purchases = read("../Purchases.tsx");
    expect(purchases).toMatch(
      /const canCrossBranches\s*=\s*me\.data\?\.role === "admin" \|\| me\.data\?\.isOwner === true;/,
    );
    expect(purchases).toContain("enabled: canCrossBranches");
    expect(purchases).toContain("branchId: canCrossBranches && f.branchId");
    expect(purchases).not.toContain(
      'const isElevated = me.data?.role === "admin" || me.data?.role === "manager"',
    );
  });

  it("distinguishes transport/authority failures from missing records", () => {
    const production = read("../ProductionDetail.tsx");
    const invoice = read("../InvoiceDetail.tsx");

    expect(production.indexOf("if (q.isError)")).toBeGreaterThanOrEqual(0);
    expect(production.indexOf("if (q.isError)")).toBeLessThan(
      production.indexOf("if (!doc)"),
    );
    expect(production).toContain("onRetry={() => void q.refetch()}");
    expect(invoice.indexOf("if (inv.isError)")).toBeGreaterThanOrEqual(0);
    expect(invoice.indexOf("if (inv.isError)")).toBeLessThan(
      invoice.lastIndexOf("if (!inv.data)"),
    );
    expect(invoice).toContain("onRetry={() => void inv.refetch()}");
  });
});
