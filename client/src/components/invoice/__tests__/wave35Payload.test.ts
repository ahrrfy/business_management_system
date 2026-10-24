import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { D, moneyInput, round2 } from "@/lib/money";

/** Execute the actual page's builder, so a lost editor-to-API wire is observable. */
const source = ts.createSourceFile(
  "SalesInvoiceNew.tsx",
  readFileSync("client/src/pages/SalesInvoiceNew.tsx", "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let builder: ts.FunctionDeclaration | undefined;
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "buildPayload")
    builder = node;
  ts.forEachChild(node, visit);
}
visit(source);
if (!builder) throw new Error("Sales invoice payload builder not found");
const code = ts.transpileModule(builder.getText(source), {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;
const execute = new Function(
  "ctx",
  `const {D,round2,moneyInput,state,totals,computePaidStr,currentShift,splitTender,externalAttempt,clientRequestId,composeDocumentNotes,shouldSendUnitPriceOverride}=ctx;${code};return buildPayload();`,
);
const fixture = (active: boolean, method = "CARD", paid = "1000.00") => ({
  D,
  round2,
  moneyInput,
  state: {
    branchId: 2,
    salesRepId: "",
    entityId: 4,
    tier: "RETAIL",
    items: [
      {
        variantId: 1,
        productUnitId: 2,
        qty: "1",
        price: "1000",
        discountType: "percent",
        discount: "0",
      },
    ],
    shippingFree: false,
    taxEnabled: false,
    paymentMethod: method,
    paymentTerms: "CASH",
    notes: "memo",
    terms: "",
  },
  totals: { grandTotal: "1000", shipping: "0", globalDiscAmt: "0" },
  computePaidStr: () => paid,
  currentShift: { data: { id: 3 } },
  splitTender: {
    active,
    parts: [
      { method: "CASH", amount: "400.00", proof: null },
      {
        method: "CARD",
        amount: "600.00",
        proof: { attemptId: 22, deviceId: "split-device" },
      },
    ],
  },
  externalAttempt: { attemptId: 999, deviceId: "legacy-device" },
  clientRequestId: "invoice-request",
  composeDocumentNotes: ({ notes }: { notes: string }) => notes,
  shouldSendUnitPriceOverride: () => false,
});
describe("advanced sales split wire", () => {
  it("sends actual separate payments and the confirmed split device, without a second single payment", () => {
    const result = execute(fixture(true));
    expect(result.payments).toEqual([
      { method: "CASH", amount: "400.00" },
      { method: "CARD", amount: "600.00", externalPaymentAttemptId: 22 },
    ]);
    expect(result.payment).toBeUndefined();
    expect(result.deviceId).toBe("split-device");
    expect(result.clientRequestId).toBe("invoice-request");
    expect(result.shiftId).toBe(3);
    expect(result.lines).toEqual([
      expect.objectContaining({
        variantId: 1,
        productUnitId: 2,
        quantity: "1",
      }),
    ]);
  });
  it("keeps the legacy single-card proof and payment path", () => {
    const result = execute(fixture(false, "CARD", "600.00"));
    expect(result.payments).toBeUndefined();
    expect(result.payment).toEqual({
      amount: "600.00",
      method: "CARD",
      externalPaymentAttemptId: 999,
    });
    expect(result.deviceId).toBe("legacy-device");
  });
  it("never fabricates a card proof for cash or a collection for zero payment", () => {
    const cash = execute(fixture(false, "CASH", "1000.00"));
    expect(cash.payment).toEqual({ amount: "1000.00", method: "CASH" });
    expect(cash.deviceId).toBeUndefined();
    expect(execute(fixture(false, "CASH", "0.00")).payment).toBeUndefined();
  });
});
