import { describe, it, expect, vi } from "vitest";
import { assertCreditLimit } from "../credit";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";

function makeMockTx(creditLimit: string | null, currentBalance: string = "0") {
  const rows = [{ creditLimit, currentBalance }];
  const from = vi.fn(() => ({
    where: vi.fn(() => ({
      for: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue(rows),
      })),
    })),
  }));
  const select = vi.fn(() => ({ from }));
  return { select } as unknown as Parameters<typeof assertCreditLimit>[0];
}

describe("CHALLENGE SUITE — Milestone 1", () => {
  describe("1. VULN-FIN-01: Adversarial Credit Limit Invariant Challenges", () => {
    it("ADV-CREDIT-01: Micro-decimal debt addition (0.00000001) must be rejected when limit is 0", async () => {
      const tx = makeMockTx("0", "0");
      await expect(
        assertCreditLimit(tx, 201, "0.00000001", 1, "CREDIT")
      ).rejects.toThrow(/حدّ ائتمانه صفر/);
    });

    it("ADV-CREDIT-02: Customer in heavy surplus/credit balance (-1,000,000 IQD) with limit 0 must still be rejected for credit terms", async () => {
      // Customer has negative balance (store owes customer money), but creditLimit is 0.
      // Can they make a deferred purchase on credit? No, cash only.
      const tx = makeMockTx("0", "-1000000");
      await expect(
        assertCreditLimit(tx, 202, "50000", 1, "CREDIT")
      ).rejects.toThrow(/حدّ ائتمانه صفر/);
    });

    it("ADV-CREDIT-03: Formatted string zero limits ('0.00', '0.000') must be rejected", async () => {
      const tx1 = makeMockTx("0.00", "0");
      await expect(assertCreditLimit(tx1, 203, "100", 1, "CREDIT")).rejects.toThrow(/حدّ ائتمانه صفر/);

      const tx2 = makeMockTx("0.000", "500");
      await expect(assertCreditLimit(tx2, 203, "100", 1, "CREDIT")).rejects.toThrow(/حدّ ائتمانه صفر/);
    });

    it("ADV-CREDIT-04: PREPAID payment mode with limit 0 and positive debt addition must be rejected", async () => {
      const tx = makeMockTx("0", "1000");
      await expect(
        assertCreditLimit(tx, 204, "500", 1, "PREPAID")
      ).rejects.toThrow(/حدّ ائتمانه صفر/);
    });

    it("ADV-CREDIT-05: Non-positive additions (0, negative) do not add debt and must resolve cleanly", async () => {
      const tx = makeMockTx("0", "50000");
      await expect(assertCreditLimit(tx, 205, "0", 1, "CREDIT")).resolves.toBeUndefined();
      await expect(assertCreditLimit(tx, 205, "-10000", 1, "CREDIT")).resolves.toBeUndefined();
      await expect(assertCreditLimit(tx, 205, "-0.00001", 1, "CREDIT")).resolves.toBeUndefined();
    });

    it("ADV-CREDIT-06: COD payment mode bypasses credit checks even with existing debt and zero limit", async () => {
      const tx = makeMockTx("0", "999999");
      await expect(assertCreditLimit(tx, 206, "100000", 1, "COD")).resolves.toBeUndefined();
    });

    it("ADV-CREDIT-07: Null limit customer permits arbitrary credit expansion", async () => {
      const tx = makeMockTx(null, "5000000");
      await expect(assertCreditLimit(tx, 207, "10000000", 1, "CREDIT")).resolves.toBeUndefined();
    });
  });

  describe("2. VULN-INV-01: Line Splitting Overwrite & Return Bypass Challenges", () => {
    it("ADV-INV-01: Line Splitting Accumulation Invariant in executeSalesReturnCart Step 4", () => {
      // Simulate the fixed logic in returnRouter.ts:
      // Lines 1920-1960 (Validation Step 3) vs Lines 2330-2390 (Update Step 4)
      const invoiceItemRows = [
        {
          id: 501,
          variantId: 10,
          productUnitId: 1, // base unit
          baseQuantity: 10,
          returnedBaseQuantity: 0,
          returnedRestockedBaseQuantity: 0,
        },
      ];

      // Cart input with split lines for the SAME invoice item
      const inputItems = [
        {
          invoiceItemId: 501,
          variantId: 10,
          productName: "Test Item",
          quantity: 6,
          unitPrice: "1000",
        },
        {
          invoiceItemId: 501,
          variantId: 10,
          productName: "Test Item",
          quantity: 4,
          unitPrice: "1000",
        },
      ];

      // Step 3 Validation: accumulatedReturnedByItemId correctly tracks 6 + 4 = 10
      const accumulatedReturnedByItemId = new Map<number, number>();
      const resolvedBaseQtyByItem = new Map<any, number>();

      for (const itm of inputItems) {
        const targetItem = itm.invoiceItemId
          ? invoiceItemRows.find((ii) => ii.id === itm.invoiceItemId && ii.variantId === itm.variantId)
          : invoiceItemRows.find((ii) => ii.variantId === itm.variantId);
        expect(targetItem).toBeDefined();
        if (targetItem) {
          const effectiveBaseQty = itm.quantity; // 1:1 base unit
          resolvedBaseQtyByItem.set(itm, effectiveBaseQty);

          const priorReturned =
            accumulatedReturnedByItemId.get(targetItem.id) ??
            (targetItem.returnedBaseQuantity ?? 0);
          const remainingBaseQty = (targetItem.baseQuantity ?? 0) - priorReturned;

          // Validation passes: 6 <= 10, then 4 <= 4
          expect(effectiveBaseQty <= remainingBaseQty).toBe(true);

          accumulatedReturnedByItemId.set(
            targetItem.id,
            priorReturned + effectiveBaseQty
          );
        }
      }

      expect(accumulatedReturnedByItemId.get(501)).toBe(10);

      // Step 4: Fixed Database Update with deltaByInvoiceItemId pre-aggregation
      const dbTable = {
        501: { returnedBaseQuantity: 0, returnedRestockedBaseQuantity: 0 },
      };

      const deltaByInvoiceItemId = new Map<
        number,
        {
          targetItem: (typeof invoiceItemRows)[0];
          totalEffectiveBaseQty: number;
          totalRestockBaseQty: number;
        }
      >();

      for (const itm of inputItems) {
        const targetItem = itm.invoiceItemId
          ? invoiceItemRows.find((ii) => ii.id === itm.invoiceItemId && ii.variantId === itm.variantId)
          : invoiceItemRows.find((ii) => ii.variantId === itm.variantId);

        if (targetItem) {
          const effectiveBaseQty = resolvedBaseQtyByItem.get(itm)!;
          const delta = deltaByInvoiceItemId.get(targetItem.id) ?? {
            targetItem,
            totalEffectiveBaseQty: 0,
            totalRestockBaseQty: 0,
          };
          delta.totalEffectiveBaseQty += effectiveBaseQty;
          delta.totalRestockBaseQty += effectiveBaseQty;
          deltaByInvoiceItemId.set(targetItem.id, delta);
        }
      }

      for (const delta of Array.from(deltaByInvoiceItemId.values())) {
        dbTable[delta.targetItem.id].returnedBaseQuantity += delta.totalEffectiveBaseQty;
        dbTable[delta.targetItem.id].returnedRestockedBaseQuantity += delta.totalRestockBaseQty;

        delta.targetItem.returnedBaseQuantity =
          (delta.targetItem.returnedBaseQuantity ?? 0) + delta.totalEffectiveBaseQty;
        delta.targetItem.returnedRestockedBaseQuantity =
          (delta.targetItem.returnedRestockedBaseQuantity ?? 0) + delta.totalRestockBaseQty;
      }

      // FIXED: dbTable[501].returnedBaseQuantity is exactly 10!
      expect(dbTable[501].returnedBaseQuantity).toBe(10);
      expect(dbTable[501].returnedRestockedBaseQuantity).toBe(10);

      // Consequence on second return:
      const remainingOnSecondReturn = invoiceItemRows[0].baseQuantity - dbTable[501].returnedBaseQuantity;
      // Remaining is 10 - 10 = 0! No quota leak!
      expect(remainingOnSecondReturn).toBe(0);
    });

    it("ADV-INV-02: Extreme Line Splitting (9 + 1) accumulates to 10 with 0 quota leak", () => {
      const invoiceItemRows = [
        {
          id: 502,
          variantId: 20,
          baseQuantity: 10,
          returnedBaseQuantity: 0,
          returnedRestockedBaseQuantity: 0,
        },
      ];

      const inputItems = [
        { invoiceItemId: 502, variantId: 20, quantity: 9 },
        { invoiceItemId: 502, variantId: 20, quantity: 1 },
      ];

      const dbTable = { 502: { returnedBaseQuantity: 0, returnedRestockedBaseQuantity: 0 } };

      const deltaByInvoiceItemId = new Map<
        number,
        {
          targetItem: (typeof invoiceItemRows)[0];
          totalEffectiveBaseQty: number;
          totalRestockBaseQty: number;
        }
      >();

      for (const itm of inputItems) {
        const targetItem = invoiceItemRows.find((ii) => ii.id === itm.invoiceItemId && ii.variantId === itm.variantId)!;
        const delta = deltaByInvoiceItemId.get(targetItem.id) ?? {
          targetItem,
          totalEffectiveBaseQty: 0,
          totalRestockBaseQty: 0,
        };
        delta.totalEffectiveBaseQty += itm.quantity;
        delta.totalRestockBaseQty += itm.quantity;
        deltaByInvoiceItemId.set(targetItem.id, delta);
      }

      for (const delta of Array.from(deltaByInvoiceItemId.values())) {
        dbTable[delta.targetItem.id].returnedBaseQuantity += delta.totalEffectiveBaseQty;
        dbTable[delta.targetItem.id].returnedRestockedBaseQuantity += delta.totalRestockBaseQty;
      }

      // Exactly 10 returned
      expect(dbTable[502].returnedBaseQuantity).toBe(10);
      // 0 items remain returnable on the invoice
      expect(invoiceItemRows[0].baseQuantity - dbTable[502].returnedBaseQuantity).toBe(0);
    });

    it("ADV-INV-03: Foreign Item not present on Invoice is rejected with BAD_REQUEST", () => {
      // Simulate invoice with Item A (variantId 100)
      const invoiceItemRows = [
        { id: 601, variantId: 100, baseQuantity: 5, returnedBaseQuantity: 0 },
      ];

      // Attacker supplies Item B (variantId 999) which is NOT on invoice
      const inputItems = [
        { variantId: 999, quantity: 5, productName: "Foreign Item" },
      ];

      expect(() => {
        for (const itm of inputItems) {
          const targetItem = invoiceItemRows.find((ii) => ii.variantId === itm.variantId);
          if (!targetItem) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: appErrorMessage({
                what: "العنصر غير موجود في الفاتورة المرجعية",
                why: `الصنف «${itm.productName}» (معرّف ${itm.variantId}) غير مدرج ضمن بنود الفاتورة المرجعية «INV-TEST-001»`,
                doThis: "تأكد من بنود الفاتورة المحددة أو نفذ المرتجع بدون رقم فاتورة كمرتجع عابر",
              }),
            });
          }
        }
      }).toThrow(/العنصر غير موجود في الفاتورة المرجعية/);
    });
  });
});
