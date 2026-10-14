import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { type OperationUser } from "@shared/operationPermissions";
import {
  salesOperationAllowed,
  salesCostVisible,
  salesCorrectionKinds,
  salesEditorActions,
  salesDigitalAllowed,
  salesExternalPaymentAllowed,
  salesEditorShortcuts,
} from "./salesOperationAccess";

function user(paths: string[], role = "manager"): OperationUser {
  return {
    role,
    operationPolicyEnabled: true,
    roleOperationPolicy: { version: 1, grants: {} },
    operationPolicy: {
      version: 1,
      grants: Object.fromEntries(
        paths.map((path) => [`operation.${path}`, true]),
      ),
    },
  };
}

describe("sales operation choices", () => {
  it("denies payment, correction and creation independently of the base role", () => {
    const account = user(["sales.pay"]);
    expect(salesOperationAllowed(account, "sales.pay")).toBe(true);
    expect(salesOperationAllowed(account, "sales.create", true)).toBe(false);
    expect(salesOperationAllowed(account, "sales.cancel", true)).toBe(false);
    expect(salesOperationAllowed(account, "sales.correct", true)).toBe(false);
  });

  it("exposes only the selected correction request and grants it outside legacy manager role", () => {
    const account = user(["salesControl.requestExchange"], "warehouse");
    expect(salesCorrectionKinds(account)).toEqual(["EXCHANGE"]);
    expect(salesEditorActions(account, true, "REISSUE")).toEqual([]);
    expect(salesEditorActions(account, true, "EXCHANGE")).toEqual(["save"]);
    expect(salesOperationAllowed(account, "sales.correct")).toBe(false);
  });

  it("requires invoice reading and the exact print/share operation for save follow-ups", () => {
    const account = user([
      "sales.create",
      "invoicePrinting.requestPrint",
      "documentDelivery.sendWhatsAppPdf",
    ]);
    expect(salesEditorActions(account, false, "REISSUE")).toEqual([
      "save",
      "duplicate",
      "paste",
    ]);
    account.operationPolicy!.grants["operation.sales.get"] = true;
    expect(salesEditorActions(account, false, "REISSUE")).toContain("print");
    expect(salesEditorActions(account, false, "REISSUE")).toContain("send");
    expect(salesEditorActions(account, false, "REISSUE")).not.toContain(
      "return",
    );
  });

  it("preserves the legacy choices and cost visibility while canonical flags take precedence", () => {
    expect(salesCorrectionKinds({ role: "cashier" })).toEqual([
      "REISSUE",
      "EXCHANGE",
    ]);
    expect(salesCostVisible({ role: "manager" })).toBe(true);
    expect(salesCostVisible(user(["sales.create"]))).toBe(false);
    const account = user(["sales.create"], "cashier");
    account.operationPolicy!.dataVisibility = {
      purchaseCost: true,
      profitMargin: true,
    };
    expect(salesCostVisible(account)).toBe(true);
    expect(
      salesOperationAllowed({ role: "cashier" }, "sales.create", false),
    ).toBe(false);
  });

  it("requires the complete digital fulfillment path before exposing digital sale entry", () => {
    const paths = [
      "digitalCards.sales.prepare",
      "digitalCards.sales.getIntent",
      "digitalCards.sales.claimExecution",
      "digitalCards.sales.markExecution",
      "digitalCards.sales.finalize",
    ];
    expect(salesDigitalAllowed(user(paths))).toBe(true);
    expect(salesEditorActions(user(paths), false, "REISSUE", true)).toContain(
      "save",
    );
    expect(salesEditorActions(user(paths), false, "REISSUE", false)).toEqual(
      [],
    );
    for (const missing of paths)
      expect(
        salesDigitalAllowed(user(paths.filter((path) => path !== missing))),
      ).toBe(false);
  });

  it("permits confirming an existing attempt independently from starting a new attempt", () => {
    const account = user(["sales.confirmExternalPayment"]);
    expect(salesExternalPaymentAllowed(account, false)).toBe(false);
    expect(salesExternalPaymentAllowed(account, true)).toBe(true);
    expect(
      salesExternalPaymentAllowed(
        user(["sales.initiateExternalPayment"]),
        true,
      ),
    ).toBe(false);
  });

  it("shows only available mutation shortcuts", () => {
    const keys = salesEditorShortcuts(["save"], false).map(
      (shortcut) => shortcut.key,
    );
    expect(keys).toContain("F4");
    expect(keys).not.toContain("F9");
    expect(
      salesEditorShortcuts([], false).map((shortcut) => shortcut.key),
    ).not.toContain("F4");
  });

  it("keeps cash and price approval validation and blocks shortcuts to denied operations", () => {
    const editor = readFileSync(
      new URL("../pages/SalesInvoiceNew.tsx", import.meta.url),
      "utf8",
    );
    expect(editor).toContain("if (!availableActions.includes(action))");
    expect(editor).toContain('availableActions.includes("save")');
    expect(editor).toContain('availableActions.includes("print")');
    expect(editor).toContain('if (!availableActions.includes("save"))');
    expect(editor).toContain(
      "!externalConfirmed || externalAttempt?.attemptId == null",
    );
    expect(editor).toContain(
      "...(approval ? { managerApproval: approval } : {})",
    );
    expect(editor).toContain("allowedKinds={allowedKinds}");
  });

  it("binds list actions to exact paths and authorizes printing before output", () => {
    const list = readFileSync(
      new URL("../pages/Invoices.tsx", import.meta.url),
      "utf8",
    );
    for (const path of [
      "sales.get",
      "sales.pay",
      "sales.create",
      "sales.reissue",
      "salesControl.requestExchange",
      "returns.create",
      "delivery.dispatchInvoice",
      "delivery.cancelAssignment",
      "invoicePrinting.requestPrint",
      "invoicePrinting.requestReprint",
      "documentDelivery.downloadPdf",
    ])
      expect(list).toMatch(
        new RegExp(`operations:\\s*\\[[^\\]]*"${path.replaceAll(".", "\\.")}"`),
      );
    expect(
      list.indexOf("utils.client.invoicePrinting.requestPrint.mutate"),
    ).toBeLessThan(list.indexOf("printInvoiceA4(invoiceDetailPrintData("));
    expect(
      list.indexOf("utils.client.invoicePrinting[attempt.mode"),
    ).toBeLessThan(list.indexOf("printReceipt(invoiceToReceipt(d))"));
  });
});
