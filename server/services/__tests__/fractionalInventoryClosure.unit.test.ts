import { expect, it } from "vitest";
import { loadApplyEffects, toEffectQuantity } from "../reversal/effectLedger";

it("persists signed material effects at exact inventory precision", () => {
  expect(toEffectQuantity(-1.5)).toBe(-1.5);
  expect(toEffectQuantity(0.0001)).toBe(0.0001);
  expect(() => toEffectQuantity(0.00001)).toThrow();
  expect(() => toEffectQuantity(Number.POSITIVE_INFINITY)).toThrow();
});

it("resolves partial material reversals without a binary remainder", async () => {
  const tx = { execute: async () => [[{
    id: 1, documentType: "INVOICE", documentId: 1, effectKind: "INVENTORY",
    signedAmount: "0.0000", signedQuantity: "-0.3000", reversedAmount: "0.0000", reversedQuantity: "0.1000",
  }], []] };
  const effects = await loadApplyEffects(tx as never, "INVOICE", 1, { kind: "ALL" }, { onlyOutstanding: true });
  expect(effects[0].outstandingQuantity).toBe(-0.2);
});
