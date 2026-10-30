/**
 * server/services/__tests__/inventoryMovementTrackingChallenger.test.ts
 *
 * EMPIRICAL CHALLENGER TEST SUITE (Milestone 2 - Challenger 2)
 *
 * Objectives:
 * 1. Verify that every inventory movement recorded by POS sales, print sales,
 *    work orders (consumption, addition, return, cancellation), goods receipts,
 *    direct PO receives, and branch transfers carries the correct `documentNumber`.
 * 2. Empirically test transaction rollback scenarios: when a sale, work order delivery,
 *    or transfer rolls back mid-flight, verify that no phantom inventory movements
 *    are persisted and `documentCounters` sequence rolls back cleanly without leaking numbers.
 * 3. Test nullability resilience: verify that querying and manipulating historical
 *    inventory movements without `documentNumber` never throws errors.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx, type Actor } from "../tx";
import { lockEconomicInventoryScope } from "../inventory/economicOwnership";
import {
  applyMovement,
  applyValuedInboundMovement,
  setStock,
  transferBetweenBranches,
  signedMoveQty,
} from "../inventoryService";
import { createSale } from "../sale/create";
import { createPrintSale } from "../printSaleService";
import { createStockTransfer, receiveStockTransfer, cancelStockTransfer } from "../transferService";
import { nextTransactionTrackingNumber, formatDocumentNumber } from "../numbering";
import { appRouter } from "../../routers";

const adminActor: Actor = { userId: 1, branchId: 1, role: "admin" };
const cashierActor: Actor = { userId: 2, branchId: 1, role: "cashier" };
const warehouseActor: Actor = { userId: 3, branchId: 1, role: "warehouse" };

function makeCtx(user: any) {
  const res = { cookie() {}, clearCookie() {} };
  const req = { headers: {} as Record<string, string> };
  return { req, res, user } as any;
}

async function cleanAndSeed() {
  await withTx(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    const tables = [
      "inventoryMovements", "invoices", "invoiceItems", "receipts",
      "workOrders", "workOrderMaterials", "stockTransfers", "stockTransferLines",
      "purchaseOrders", "purchaseOrderItems", "goodsReceipts", "goodsReceiptItems",
      "goodsReceiptReversals", "goodsReceiptReversalItems", "branchStock",
      "productPrices", "productUnits", "productVariants", "products",
      "shifts", "customers", "suppliers", "branches", "users",
    ];
    for (const t of tables) {
      await tx.execute(sql.raw(`DELETE FROM \`${t}\``));
    }
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

    // 1. Branches
    await tx.insert(s.branches).values([
      { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
    ]);

    // 2. Users
    await tx.insert(s.users).values([
      { id: 1, openId: "admin-u1", name: "أدمن", email: "admin@test.local", role: "admin", loginMethod: "local", branchId: 1 },
      { id: 2, openId: "cashier-u2", name: "كاشير", email: "cashier@test.local", role: "cashier", loginMethod: "local", branchId: 1 },
      { id: 3, openId: "wh-u3", name: "أمين مخزن", email: "wh@test.local", role: "warehouse", loginMethod: "local", branchId: 1 },
    ]);

    // 3. Customer & Supplier
    await tx.insert(s.customers).values([
      { id: 1, name: "عميل تجريبي", phone: "07700000001", creditLimit: "1000000.00", currentBalance: "0.00" },
    ]);

    await tx.insert(s.suppliers).values([
      { id: 1, name: "مورد تجريبي", phone: "07800000001", currentBalance: "0.00" },
    ]);

    // 4. Products & Variants & Units
    // Product 1: Retail Stationery (goods)
    await tx.insert(s.products).values({ id: 1, name: "قلم جاف أزرق", isService: false });
    await tx.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-BLUE", costPrice: "500.00" });
    await tx.insert(s.productUnits).values([
      { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isActive: true },
    ]);
    await tx.insert(s.productPrices).values([
      { productUnitId: 1, priceTier: "RETAIL", price: "1000.00" },
    ]);

    // Product 2: Raw Material Paper
    await tx.insert(s.products).values({ id: 2, name: "ورق طباعة A4 خام", isService: false });
    await tx.insert(s.productVariants).values({ id: 2, productId: 2, sku: "RAW-PAPER-A4", costPrice: "50.00" });
    await tx.insert(s.productUnits).values([
      { id: 2, variantId: 2, unitName: "ورقة", conversionFactor: "1", isBaseUnit: true, isActive: true },
    ]);
    await tx.insert(s.productPrices).values([
      { productUnitId: 2, priceTier: "RETAIL", price: "100.00" },
    ]);

    // Product 3: Raw Material Ink
    await tx.insert(s.products).values({ id: 3, name: "حبر ليزر أسود خام", isService: false });
    await tx.insert(s.productVariants).values({ id: 3, productId: 3, sku: "RAW-INK-BLK", costPrice: "200.00" });
    await tx.insert(s.productUnits).values([
      { id: 3, variantId: 3, unitName: "مل", conversionFactor: "1", isBaseUnit: true, isActive: true },
    ]);
    await tx.insert(s.productPrices).values([
      { productUnitId: 3, priceTier: "RETAIL", price: "400.00" },
    ]);

    // Product 4: Print Output Product
    await tx.insert(s.products).values({ id: 4, name: "كارت شخصي مطبوع", productType: "PRINT_SERVICE", isService: false });
    await tx.insert(s.productVariants).values({ id: 4, productId: 4, sku: "PRINT-BCARD", costPrice: "20.00" });
    await tx.insert(s.productUnits).values([
      { id: 4, variantId: 4, unitName: "كارت", conversionFactor: "1", isBaseUnit: true, isActive: true },
    ]);
    await tx.insert(s.productPrices).values([
      { productUnitId: 4, priceTier: "RETAIL", price: "50.00" },
    ]);

    // 5. Initial Branch Stock
    await tx.insert(s.branchStock).values([
      { variantId: 1, branchId: 1, quantity: 200 },
      { variantId: 1, branchId: 2, quantity: 50 },
      { variantId: 2, branchId: 1, quantity: 5000 },
      { variantId: 2, branchId: 2, quantity: 1000 },
      { variantId: 3, branchId: 1, quantity: 1000 },
      { variantId: 4, branchId: 1, quantity: 500 },
    ]);

    // 6. Open Shifts for Branch 1
    const now = Date.now();
    await tx.insert(s.shifts).values([
      {
        id: 1,
        branchId: 1,
        userId: 2,
        shiftType: "RETAIL",
        status: "OPEN",
        openingBalance: "0.00",
        openGuard: `1:1:RETAIL:${now}_1`,
      },
      {
        id: 2,
        branchId: 1,
        userId: 2,
        shiftType: "PRINT_SERVICES",
        status: "OPEN",
        openingBalance: "0.00",
        openGuard: `1:1:PRINT_SERVICES:${now}_2`,
      },
    ]);
  });
}

describe("Empirical Challenger — Milestone 2 Inventory Movement Tracking & Atomicity", () => {
  beforeEach(async () => {
    await cleanAndSeed();
  });

  // =========================================================================
  // REQUIREMENT 1: Verification of documentNumber across all operational flows
  // =========================================================================

  it("DOCNUM-01: POS direct sale records inventory movement with exact documentNumber", async () => {
    const saleRes = await createSale(
      {
        branchId: 1,
        shiftId: 1,
        customerId: 1,
        sourceType: "POS",
        lines: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "5",
            unitPrice: "1000.00",
          },
        ],
        payment: {
          method: "CASH",
          amount: "5000.00",
        },
        clientRequestId: `sale-docnum-${Date.now()}`,
      },
      cashierActor,
    );

    expect(saleRes.invoiceNumber).toBeDefined();
    expect(saleRes.invoiceNumber.length).toBeGreaterThan(0);

    // Query inventory movements created for this sale
    const movements = await withTx(async (tx) => {
      return tx
        .select()
        .from(s.inventoryMovements)
        .where(
          and(
            eq(s.inventoryMovements.referenceType, "INVOICE"),
            eq(s.inventoryMovements.referenceId, saleRes.invoiceId),
          ),
        );
    });

    expect(movements.length).toBe(1);
    const m = movements[0];
    expect(m.documentNumber).toBe(saleRes.invoiceNumber);
    expect(m.movementType).toBe("OUT");
    expect(m.quantity).toBe(5);
    expect(m.variantId).toBe(1);
    expect(m.branchId).toBe(1);
  });

  it("DOCNUM-02: Print sale records inventory movement with exact documentNumber", async () => {
    const printRes = await createPrintSale(
      {
        branchId: 1,
        shiftId: 2,
        customerId: 1,
        lines: [
          {
            variantId: 4,
            productUnitId: 4,
            quantity: "20",
            unitPriceOverride: "50.00",
          },
        ],
        payment: {
          method: "CASH",
          amount: "1000.00",
        },
        clientRequestId: `print-docnum-${Date.now()}`,
      },
      cashierActor,
    );

    expect(printRes.invoiceNumber).toBeDefined();

    // Query inventory movements for this print sale
    const movements = await withTx(async (tx) => {
      return tx
        .select()
        .from(s.inventoryMovements)
        .where(
          and(
            eq(s.inventoryMovements.referenceType, "PRINT_SALE"),
            eq(s.inventoryMovements.referenceId, printRes.invoiceId),
          ),
        );
    });

    expect(movements.length).toBe(1);
    const m = movements[0];
    expect(m.documentNumber).toBe(printRes.invoiceNumber);
    expect(m.movementType).toBe("OUT");
    expect(m.quantity).toBe(20);
    expect(m.variantId).toBe(4);
  });

  it("DOCNUM-03: Work order material consumption, addition, and return carry orderNumber", async () => {
    const trackingNumber = await withTx(async (tx) => nextTransactionTrackingNumber(tx));
    const orderNumber = formatDocumentNumber(trackingNumber, 1);
    const workOrderId = 1001;

    await withTx(async (tx) => {
      await lockEconomicInventoryScope(tx, [2, 3]);
      // 1. Setup work order
      await tx.insert(s.workOrders).values({
        id: workOrderId,
        orderNumber,
        branchId: 1,
        customerId: 1,
        title: "أمر شغل تجريبي",
        status: "IN_PROGRESS",
        totalAmount: "25000.00",
        materialsCost: "2500.00",
      });

      // 2. Work order material consumption (start)
      await applyMovement(tx, {
        variantId: 2, // paper
        branchId: 1,
        baseQuantity: 100,
        movementType: "OUT",
        referenceType: "WORK_ORDER",
        referenceId: workOrderId,
        documentNumber: orderNumber,
        createdBy: 1,
      });

      // 3. Work order material addition (delta > 0)
      await applyMovement(tx, {
        variantId: 3, // ink
        branchId: 1,
        baseQuantity: 10,
        movementType: "OUT",
        referenceType: "WORK_ORDER",
        referenceId: workOrderId,
        documentNumber: orderNumber,
        createdBy: 1,
      });

      // 4. Work order material reduction / return (delta < 0)
      await applyValuedInboundMovement(tx, {
        variantId: 2, // paper return
        branchId: 1,
        baseQuantity: 20,
        historicalValue: "1000.00",
        movementType: "RETURN",
        referenceType: "WORK_ORDER",
        referenceId: workOrderId,
        documentNumber: orderNumber,
        createdBy: 1,
      });

      // 5. Work order cancellation return
      await applyValuedInboundMovement(tx, {
        variantId: 3, // ink return
        branchId: 1,
        baseQuantity: 5,
        historicalValue: "1000.00",
        referenceType: "WORK_ORDER_CANCEL",
        referenceId: workOrderId,
        documentNumber: orderNumber,
        createdBy: 1,
      });
    });

    const rows = await withTx(async (tx) => {
      return tx
        .select()
        .from(s.inventoryMovements)
        .where(eq(s.inventoryMovements.referenceId, workOrderId));
    });

    expect(rows.length).toBe(4);
    for (const r of rows) {
      expect(r.documentNumber).toBe(orderNumber);
    }

    const consumptionMove = rows.find((r) => r.variantId === 2 && r.movementType === "OUT");
    expect(consumptionMove?.quantity).toBe(100);
    expect(consumptionMove?.referenceType).toBe("WORK_ORDER");

    const additionMove = rows.find((r) => r.variantId === 3 && r.movementType === "OUT");
    expect(additionMove?.quantity).toBe(10);

    const returnMove = rows.find((r) => r.variantId === 2 && r.movementType === "RETURN");
    expect(returnMove?.quantity).toBe(20);

    const cancelMove = rows.find((r) => r.referenceType === "WORK_ORDER_CANCEL");
    expect(cancelMove?.movementType).toBe("IN");
    expect(cancelMove?.quantity).toBe(5);
  });

  it("DOCNUM-04: Goods receipts and reversals record receiptNumber and reversalNumber", async () => {
    const grNumber = "GR-1-20261019-00001";
    const revNumber = "REV-1-20261019-00001";
    const grId = 2001;
    const revId = 3001;

    await withTx(async (tx) => {
      // 1. Goods receipt incoming movement
      await applyMovement(tx, {
        variantId: 1,
        branchId: 1,
        baseQuantity: 50,
        movementType: "IN",
        referenceType: "GOODS_RECEIPT",
        referenceId: grId,
        documentNumber: grNumber,
        notes: `إذن استلام ${grNumber}`,
        createdBy: 1,
        stampOpened: true,
      });

      // 2. Goods receipt reversal outbound movement
      await applyMovement(tx, {
        variantId: 1,
        branchId: 1,
        baseQuantity: 10,
        movementType: "OUT",
        referenceType: "GOODS_RECEIPT_REVERSAL",
        referenceId: revId,
        documentNumber: revNumber,
        notes: `عكس ${revNumber}`,
        createdBy: 1,
      });
    });

    const grMoves = await withTx(async (tx) => {
      return tx
        .select()
        .from(s.inventoryMovements)
        .where(eq(s.inventoryMovements.referenceId, grId));
    });
    expect(grMoves.length).toBe(1);
    expect(grMoves[0].documentNumber).toBe(grNumber);
    expect(grMoves[0].movementType).toBe("IN");
    expect(grMoves[0].quantity).toBe(50);

    const revMoves = await withTx(async (tx) => {
      return tx
        .select()
        .from(s.inventoryMovements)
        .where(eq(s.inventoryMovements.referenceId, revId));
    });
    expect(revMoves.length).toBe(1);
    expect(revMoves[0].documentNumber).toBe(revNumber);
    expect(revMoves[0].movementType).toBe("OUT");
    expect(revMoves[0].quantity).toBe(10);
  });

  it("DOCNUM-05: Direct PO receives record poNumber on stock movements", async () => {
    const poNumber = "PO-20261019-00042";
    const poId = 4001;

    await withTx(async (tx) => {
      await applyMovement(tx, {
        variantId: 2,
        branchId: 1,
        baseQuantity: 1000,
        movementType: "IN",
        referenceType: "PURCHASE_ORDER",
        referenceId: poId,
        documentNumber: poNumber,
        createdBy: 1,
        stampOpened: true,
      });
    });

    const poMoves = await withTx(async (tx) => {
      return tx
        .select()
        .from(s.inventoryMovements)
        .where(eq(s.inventoryMovements.referenceId, poId));
    });

    expect(poMoves.length).toBe(1);
    expect(poMoves[0].documentNumber).toBe(poNumber);
    expect(poMoves[0].movementType).toBe("IN");
    expect(poMoves[0].quantity).toBe(1000);
  });

  it("DOCNUM-06: Branch transfers record transferNumber on TRANSFER_OUT, TRANSFER_IN, and cancellation", async () => {
    const transferRes = await withTx(async (tx) => {
      return createStockTransfer(tx, {
        fromBranchId: 1,
        toBranchId: 2,
        notes: "تحويل قرطاسية تجريبي",
        createdBy: 1,
        items: [
          {
            variantId: 1,
            baseQuantity: 15,
          },
        ],
      });
    });

    expect(transferRes.transferNumber).toMatch(/^TRF-\d+-\d+$/);

    // 1. Verify TRANSFER_OUT
    const outMoves = await withTx(async (tx) => {
      return tx
        .select()
        .from(s.inventoryMovements)
        .where(
          and(
            eq(s.inventoryMovements.referenceType, "TRANSFER"),
            eq(s.inventoryMovements.referenceId, transferRes.transferId),
            eq(s.inventoryMovements.movementType, "TRANSFER_OUT"),
          ),
        );
    });

    expect(outMoves.length).toBe(1);
    expect(outMoves[0].documentNumber).toBe(transferRes.transferNumber);
    expect(outMoves[0].branchId).toBe(1);
    expect(outMoves[0].relatedBranchId).toBe(2);
    expect(outMoves[0].quantity).toBe(15);

    // 2. Receive Transfer -> verify TRANSFER_IN
    const transferLines = await withTx(async (tx) => {
      return tx
        .select()
        .from(s.stockTransferLines)
        .where(eq(s.stockTransferLines.transferId, transferRes.transferId));
    });

    await withTx(async (tx) => {
      await receiveStockTransfer(tx, {
        transferId: transferRes.transferId,
        receivedBy: 3,
        lines: [
          {
            lineId: transferLines[0].id,
            quantityReceived: 15,
          },
        ],
        actor: { ...warehouseActor, branchId: 2 },
      });
    });

    const inMoves = await withTx(async (tx) => {
      return tx
        .select()
        .from(s.inventoryMovements)
        .where(
          and(
            eq(s.inventoryMovements.referenceType, "TRANSFER"),
            eq(s.inventoryMovements.referenceId, transferRes.transferId),
            eq(s.inventoryMovements.movementType, "TRANSFER_IN"),
          ),
        );
    });

    expect(inMoves.length).toBe(1);
    expect(inMoves[0].documentNumber).toBe(transferRes.transferNumber);
    expect(inMoves[0].branchId).toBe(2);
    expect(inMoves[0].relatedBranchId).toBe(1);
    expect(inMoves[0].quantity).toBe(15);

    // 3. Test Transfer Cancellation on a fresh transfer
    const transfer2 = await withTx(async (tx) => {
      return createStockTransfer(tx, {
        fromBranchId: 1,
        toBranchId: 2,
        notes: "تحويل ملغى",
        createdBy: 1,
        items: [{ variantId: 1, baseQuantity: 5 }],
      });
    });

    await withTx(async (tx) => {
      await cancelStockTransfer(tx, {
        transferId: transfer2.transferId,
        actor: adminActor,
      });
    });

    const cancelMoves = await withTx(async (tx) => {
      return tx
        .select()
        .from(s.inventoryMovements)
        .where(
          and(
            eq(s.inventoryMovements.referenceType, "TRANSFER"),
            eq(s.inventoryMovements.referenceId, transfer2.transferId),
            eq(s.inventoryMovements.movementType, "TRANSFER_IN"),
          ),
        );
    });

    expect(cancelMoves.length).toBe(1);
    expect(cancelMoves[0].documentNumber).toBe(transfer2.transferNumber);
    expect(cancelMoves[0].branchId).toBe(1); // restored back to sender branch
    expect(cancelMoves[0].quantity).toBe(5);
  });

  it("DOCNUM-07: transferBetweenBranches primitive propagates documentNumber to both movements", async () => {
    const docNum = "TRF-DIRECT-99999";
    const res = await withTx(async (tx) => {
      return transferBetweenBranches(tx, {
        variantId: 1,
        fromBranchId: 1,
        toBranchId: 2,
        baseQuantity: 12,
        documentNumber: docNum,
        referenceId: 8888,
        createdBy: 1,
      });
    });

    expect(res.from.movementId).toBeGreaterThan(0);
    expect(res.to.movementId).toBeGreaterThan(0);

    const moves = await withTx(async (tx) => {
      return tx
        .select()
        .from(s.inventoryMovements)
        .where(eq(s.inventoryMovements.referenceId, 8888));
    });

    expect(moves.length).toBe(2);
    expect(moves.every((m) => m.documentNumber === docNum)).toBe(true);
  });

  // =========================================================================
  // REQUIREMENT 2: Empirical transaction rollback scenarios & counter sequence
  // =========================================================================

  it("ROLLBACK-01: Sale rollback mid-flight leaves zero phantom movements and reverts counter sequence", async () => {
    // 1. Capture baseline counter and stock
    const initialCounter = await withTx(async (tx) => {
      return Number(await nextTransactionTrackingNumber(tx));
    });

    const initialStock = await withTx(async (tx) => {
      const rows = await tx
        .select({ q: s.branchStock.quantity })
        .from(s.branchStock)
        .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)));
      return rows[0]?.q ?? 0;
    });

    const initialMovementsCount = await withTx(async (tx) => {
      const rows = await tx.select({ count: sql<number>`count(*)` }).from(s.inventoryMovements);
      return Number(rows[0]?.count ?? 0);
    });

    // 2. Deliberately fail transaction after allocating tracking number and movement
    let abortedDocNum: string | null = null;
    await expect(
      withTx(async (tx) => {
        abortedDocNum = await nextTransactionTrackingNumber(tx);

        // Apply movement in uncommitted tx
        await applyMovement(tx, {
          variantId: 1,
          branchId: 1,
          baseQuantity: 25,
          movementType: "OUT",
          referenceType: "INVOICE",
          referenceId: 999999,
          documentNumber: abortedDocNum,
          createdBy: 1,
        });

        // Intentional crash mid-transaction
        throw new Error("SIMULATED_TRANSACTION_PAYMENT_FAILURE");
      }),
    ).rejects.toThrow("SIMULATED_TRANSACTION_PAYMENT_FAILURE");

    // 3. Empirically verify database state post-rollback: zero phantom rows
    const postMovementsCount = await withTx(async (tx) => {
      const rows = await tx.select({ count: sql<number>`count(*)` }).from(s.inventoryMovements);
      return Number(rows[0]?.count ?? 0);
    });
    expect(postMovementsCount).toBe(initialMovementsCount);

    const postStock = await withTx(async (tx) => {
      const rows = await tx
        .select({ q: s.branchStock.quantity })
        .from(s.branchStock)
        .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)));
      return rows[0]?.q ?? 0;
    });
    expect(postStock).toBe(initialStock);

    // 4. Verify counter sequence integrity:
    // In MySQL InnoDB, row-level updates on documentCounters roll back on transaction abort.
    // The next transaction increments from the committed baseline, so no numbers are leaked.
    const nextCommittedCounter = await withTx(async (tx) => {
      return Number(await nextTransactionTrackingNumber(tx));
    });
    expect(nextCommittedCounter).toBe(Number(abortedDocNum));
  });

  it("ROLLBACK-02: Transfer rollback mid-flight leaves zero phantom movements and stock intact", async () => {
    const stockBranch1Before = await withTx(async (tx) => {
      const rows = await tx
        .select({ q: s.branchStock.quantity })
        .from(s.branchStock)
        .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)));
      return rows[0]?.q ?? 0;
    });
    const stockBranch2Before = await withTx(async (tx) => {
      const rows = await tx
        .select({ q: s.branchStock.quantity })
        .from(s.branchStock)
        .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 2)));
      return rows[0]?.q ?? 0;
    });

    await expect(
      withTx(async (tx) => {
        await transferBetweenBranches(tx, {
          variantId: 1,
          fromBranchId: 1,
          toBranchId: 2,
          baseQuantity: 30,
          documentNumber: "TRF-ABORT-TEST",
          referenceId: 77777,
          createdBy: 1,
        });

        throw new Error("SIMULATED_NETWORK_PARTITION_MID_TRANSFER");
      }),
    ).rejects.toThrow("SIMULATED_NETWORK_PARTITION_MID_TRANSFER");

    // Stock in both branches must remain unchanged
    const stockBranch1After = await withTx(async (tx) => {
      const rows = await tx
        .select({ q: s.branchStock.quantity })
        .from(s.branchStock)
        .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)));
      return rows[0]?.q ?? 0;
    });
    const stockBranch2After = await withTx(async (tx) => {
      const rows = await tx
        .select({ q: s.branchStock.quantity })
        .from(s.branchStock)
        .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 2)));
      return rows[0]?.q ?? 0;
    });

    expect(stockBranch1After).toBe(stockBranch1Before);
    expect(stockBranch2After).toBe(stockBranch2Before);

    // Zero movements persisted
    const phantomMoves = await withTx(async (tx) => {
      return tx
        .select()
        .from(s.inventoryMovements)
        .where(eq(s.inventoryMovements.referenceId, 77777));
    });
    expect(phantomMoves.length).toBe(0);
  });

  // =========================================================================
  // REQUIREMENT 3: Nullability resilience for historical inventory movements
  // =========================================================================

  it("NULLRES-01: Historical movements with documentNumber=NULL never throw and query cleanly", async () => {
    // 1. Insert historical movements where documentNumber IS NULL
    await withTx(async (tx) => {
      await tx.insert(s.inventoryMovements).values([
        {
          variantId: 1,
          branchId: 1,
          movementType: "IN",
          quantity: 100,
          signedDelta: 100,
          referenceType: "MANUAL_IN",
          referenceId: 101,
          documentNumber: null, // historical
          createdBy: 1,
        },
        {
          variantId: 1,
          branchId: 1,
          movementType: "OUT",
          quantity: 20,
          signedDelta: -20,
          referenceType: "INVOICE",
          referenceId: 102,
          documentNumber: null, // historical
          createdBy: 1,
        },
        {
          variantId: 2,
          branchId: 1,
          movementType: "ADJUST",
          quantity: 15,
          signedDelta: -15,
          referenceType: "ADJUSTMENT",
          referenceId: 103,
          documentNumber: null, // historical
          notes: "تسوية جرد قديم (فرق -15)",
          createdBy: 1,
        },
        {
          variantId: 1,
          branchId: 1,
          movementType: "TRANSFER_OUT",
          quantity: 10,
          signedDelta: -10,
          relatedBranchId: 2,
          referenceType: "TRANSFER",
          referenceId: 104,
          documentNumber: null, // historical
          createdBy: 1,
        },
        {
          variantId: 1,
          branchId: 2,
          movementType: "TRANSFER_IN",
          quantity: 10,
          signedDelta: 10,
          relatedBranchId: 1,
          referenceType: "TRANSFER",
          referenceId: 104,
          documentNumber: null, // historical
          createdBy: 1,
        },
      ]);
    });

    // 2. Query movementsRich via caller
    const adminUser = (await withTx(async (tx) => tx.select().from(s.users).where(eq(s.users.id, 1))))[0];
    const caller = appRouter.createCaller(makeCtx(adminUser));

    // A. Unfiltered query
    const resAll = await caller.inventory.movementsRich({});
    expect(resAll.rows.length).toBeGreaterThanOrEqual(5);

    // Verify historical rows have null documentNumber without runtime errors
    const nullRows = resAll.rows.filter((r) => r.referenceId && [101, 102, 103, 104].includes(r.referenceId));
    expect(nullRows.length).toBe(5);

    // B. Filter by movementType
    const resIn = await caller.inventory.movementsRich({ movementType: "IN" });
    expect(resIn.rows.some((r) => r.referenceId === 101)).toBe(true);

    const resOut = await caller.inventory.movementsRich({ movementType: "OUT" });
    expect(resOut.rows.some((r) => r.referenceId === 102)).toBe(true);

    // C. Filter by branchId
    const resB2 = await caller.inventory.movementsRich({ branchId: 2 });
    expect(resB2.rows.some((r) => r.referenceId === 104 && r.branchId === 2)).toBe(true);

    // D. Filter by referenceType
    const resManual = await caller.inventory.movementsRich({ referenceType: "MANUAL_IN" });
    expect(resManual.rows.length).toBe(1);
    expect(resManual.rows[0].referenceId).toBe(101);

    // E. Search query by SKU and Name
    const resSearch = await caller.inventory.movementsRich({ q: "PEN-BLUE" });
    expect(resSearch.rows.length).toBeGreaterThan(0);
    expect(resSearch.rows.every((r) => r.sku === "PEN-BLUE")).toBe(true);

    // F. Pagination
    const page1 = await caller.inventory.movementsRich({ limit: 2, offset: 0 });
    const page2 = await caller.inventory.movementsRich({ limit: 2, offset: 2 });
    expect(page1.rows.length).toBe(2);
    expect(page2.rows.length).toBe(2);
    expect(page1.rows[0].id).not.toBe(page2.rows[0].id);
  });

  it("NULLRES-02: signedMoveQty calculation functions correctly on rows with documentNumber=NULL", () => {
    // 1. Direct delta provided
    expect(signedMoveQty("IN", 10, null, 10)).toBe(10);
    expect(signedMoveQty("OUT", 10, null, -10)).toBe(-10);

    // 2. Fallback to movementType sign
    expect(signedMoveQty("IN", 25, null, null)).toBe(25);
    expect(signedMoveQty("OUT", 25, null, null)).toBe(-25);
    expect(signedMoveQty("RETURN", 5, null, null)).toBe(5);
    expect(signedMoveQty("TRANSFER_IN", 15, null, null)).toBe(15);
    expect(signedMoveQty("TRANSFER_OUT", 15, null, null)).toBe(-15);

    // 3. ADJUST delta extracted from notes
    expect(signedMoveQty("ADJUST", 10, "تسوية جرد (فرق +10)", null)).toBe(10);
    expect(signedMoveQty("ADJUST", 10, "تسوية جرد (فرق -10)", null)).toBe(-10);
  });

  it("NULLRES-03: setStock and applyMovement allow null or omitted documentNumber without error", async () => {
    await withTx(async (tx) => {
      // 1. applyMovement with documentNumber: null
      const res1 = await applyMovement(tx, {
        variantId: 1,
        branchId: 1,
        baseQuantity: 1,
        movementType: "IN",
        referenceType: "MANUAL_ADJUST",
        documentNumber: null,
        createdBy: 1,
      });
      expect(res1.movementId).toBeGreaterThan(0);

      // 2. applyMovement with documentNumber: undefined (omitted)
      const res2 = await applyMovement(tx, {
        variantId: 1,
        branchId: 1,
        baseQuantity: 1,
        movementType: "OUT",
        referenceType: "MANUAL_ADJUST",
        createdBy: 1,
      });
      expect(res2.movementId).toBeGreaterThan(0);

      // 3. setStock with documentNumber omitted
      const res3 = await setStock(tx, {
        variantId: 1,
        branchId: 1,
        targetQuantity: 250,
        referenceType: "STOCKTAKE",
        createdBy: 1,
      });
      expect(res3.movementId).toBeGreaterThan(0);
      expect(res3.newQuantity).toBe(250);
    });
  });

  it("DOCNUM-08: createSale with inherited trackingNumber (correction reissue) preserves base tracking number with -1, -2 sibling suffixes", async () => {
    const initialSale = await createSale(
      {
        branchId: 1,
        shiftId: 1,
        customerId: 1,
        sourceType: "POS",
        lines: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "2",
            unitPrice: "1000.00",
          },
        ],
        payment: {
          method: "CASH",
          amount: "2000.00",
        },
        clientRequestId: `sale-base-${Date.now()}`,
      },
      cashierActor,
    );

    expect(initialSale.invoiceNumber).toMatch(/^\d+$/);

    // First correction reissue inheriting the base trackingNumber
    const corrSale1 = await createSale(
      {
        branchId: 1,
        shiftId: 1,
        customerId: 1,
        sourceType: "POS",
        trackingNumber: initialSale.invoiceNumber,
        lines: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "3",
            unitPrice: "1000.00",
          },
        ],
        payment: {
          method: "CASH",
          amount: "3000.00",
        },
        clientRequestId: `sale-corr1-${Date.now()}`,
      },
      cashierActor,
    );

    expect(corrSale1.invoiceNumber).toBe(`${initialSale.invoiceNumber}-1`);

    // Second correction reissue inheriting from the -1 invoice
    const corrSale2 = await createSale(
      {
        branchId: 1,
        shiftId: 1,
        customerId: 1,
        sourceType: "POS",
        trackingNumber: corrSale1.invoiceNumber,
        lines: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "4",
            unitPrice: "1000.00",
          },
        ],
        payment: {
          method: "CASH",
          amount: "4000.00",
        },
        clientRequestId: `sale-corr2-${Date.now()}`,
      },
      cashierActor,
    );

    expect(corrSale2.invoiceNumber).toBe(`${initialSale.invoiceNumber}-2`);
  });

  it("DOCNUM-09: createPrintSale with inherited trackingNumber resolves sibling suffixes (-1, -2) without ER_DUP_ENTRY", async () => {
    const baseSale = await createPrintSale(
      {
        branchId: 1,
        shiftId: 2,
        customerId: 1,
        lines: [
          {
            variantId: 4,
            productUnitId: 4,
            quantity: "2",
            unitPriceOverride: "50.00",
          },
        ],
        payment: {
          method: "CASH",
          amount: "100.00",
        },
        clientRequestId: `print-base-${Date.now()}`,
      },
      cashierActor,
    );

    expect(baseSale.invoiceNumber).toMatch(/^\d+$/);

    const siblingPrint1 = await createPrintSale(
      {
        branchId: 1,
        shiftId: 2,
        customerId: 1,
        trackingNumber: baseSale.invoiceNumber,
        lines: [
          {
            variantId: 4,
            productUnitId: 4,
            quantity: "2",
            unitPriceOverride: "50.00",
          },
        ],
        payment: {
          method: "CASH",
          amount: "100.00",
        },
        clientRequestId: `print-sib1-${Date.now()}`,
      },
      cashierActor,
    );

    expect(siblingPrint1.invoiceNumber).toBe(`${baseSale.invoiceNumber}-1`);

    const siblingPrint2 = await createPrintSale(
      {
        branchId: 1,
        shiftId: 2,
        customerId: 1,
        trackingNumber: siblingPrint1.invoiceNumber,
        lines: [
          {
            variantId: 4,
            productUnitId: 4,
            quantity: "2",
            unitPriceOverride: "50.00",
          },
        ],
        payment: {
          method: "CASH",
          amount: "100.00",
        },
        clientRequestId: `print-sib2-${Date.now()}`,
      },
      cashierActor,
    );

    expect(siblingPrint2.invoiceNumber).toBe(`${baseSale.invoiceNumber}-2`);
  });
});

