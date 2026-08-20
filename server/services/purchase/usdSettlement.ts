/**
 * Pay a USD supplier invoice directly from a card, transfer, or IQD wallet.
 * AP is cleared at the invoice carrying rate; the receipt records actual IQD cash-out.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { purchaseOrders, receipts, suppliers } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { adjustSupplierBalance, adjustSupplierBalanceUsd, postEntry } from "../ledgerService";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { money, round2, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";
import type { SettlePurchaseUsdDirectInput } from "./types";
import { assertNonPhysicalOutReceipt } from "../cash/cashAvailability";
import { paymentAssetRole } from "../sale/paymentPosting";

export async function settlePurchaseUsdDirect(
  input: SettlePurchaseUsdDirectInput,
  actor: Actor & { role?: string },
) {
  return withTx(async (tx) => {
    const settlementRequestHash = input.clientRequestId
      ? idempotencyHash({
          purchaseOrderId: input.purchaseOrderId,
          settledUsd: money(input.settledUsd).toFixed(2),
          chargedIqd: money(input.chargedIqd).toFixed(2),
          feeIqd: money(input.feeIqd ?? "0").toFixed(2),
          method: input.method,
          referenceNumber: input.referenceNumber.trim(),
        })
      : null;
    if (input.clientRequestId) {
      const existing = await checkIdempotency(
        tx,
        "purchase.usd-settle",
        input.clientRequestId,
        settlementRequestHash,
        { requireStoredHash: true },
      );
      if (existing != null) return { receiptId: existing, idempotent: true };
    }

    const settledUsd = round2(input.settledUsd);
    const chargedIqd = round2(input.chargedIqd);
    const feeIqd = round2(input.feeIqd ?? "0");
    if (settledUsd.lte(0) || chargedIqd.lte(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ الدولار والمبلغ الديناري الفعلي يجب أن يكونا موجبين" });
    }
    if (feeIqd.isNegative()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "عمولة البطاقة أو التحويل لا تكون سالبة" });
    }
    if (!input.referenceNumber.trim()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "مرجع عملية البطاقة أو التحويل مطلوب" });
    }

    const po = (await tx.select().from(purchaseOrders)
      .where(eq(purchaseOrders.id, input.purchaseOrderId)).for("update").limit(1))[0];
    if (!po) throw new TRPCError({ code: "NOT_FOUND", message: "فاتورة الشراء غير موجودة" });
    if (po.status === "CANCELLED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تسديد فاتورة شراء ملغاة" });
    }
    if (po.agreedCurrency !== "USD" || !po.usdTotal || !po.agreedRate) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الفاتورة المحددة ليست فاتورة مورد بالدولار" });
    }
    // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران (owner مُطبَّع ⇒ admin)؛ كان
    // `&& role !== "manager"` يُعفي المدير فيسدّد فاتورة فرعٍ آخر.
    if (actor.branchId != null && Number(po.branchId) !== Number(actor.branchId) && actor.role !== "admin") {
      throw new TRPCError({ code: "FORBIDDEN", message: "فاتورة الشراء تخص فرعاً آخر" });
    }

    const supplier = (await tx.select().from(suppliers)
      .where(eq(suppliers.id, Number(po.supplierId))).for("update").limit(1))[0];
    if (!supplier) throw new TRPCError({ code: "NOT_FOUND", message: "المورد غير موجود" });

    const remainingUsd = round2(money(po.usdTotal).minus(money(po.paidUsd)).minus(money(po.returnedUsd)));
    if (settledUsd.gt(remainingUsd)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `الدفع (${settledUsd.toFixed(2)}$) يتجاوز المتبقي على الفاتورة (${remainingUsd.toFixed(2)}$)`,
      });
    }
    if (settledUsd.gt(money(supplier.currentBalanceUsd))) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ الدولار يتجاوز ذمة المورد الدولارية" });
    }

    const carryingIqd = round2(settledUsd.times(money(po.agreedRate)));
    if (carryingIqd.gt(money(supplier.currentBalance))) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "القيمة الدفترية للتسديد تتجاوز ذمة المورد الدينارية" });
    }
    const fxDiff = carryingIqd.minus(chargedIqd);
    const cashOut = round2(chargedIqd.plus(feeIqd));

    assertNonPhysicalOutReceipt({
      classification: "NON_CASH_METHOD", paymentMethod: input.method, cashBucket: null,
      operation: "تسديد فاتورة المورد الدولارية بوسيلة غير نقدية",
    });
    const paymentRole = paymentAssetRole(input.method, null, "OUT");

    const receiptRes = await tx.insert(receipts).values({
      branchId: Number(po.branchId),
      shiftId: null,
      cashBucket: null,
      direction: "OUT",
      amount: toDbMoney(cashOut),
      paymentMethod: input.method,
      referenceNumber: input.referenceNumber.trim(),
      partyType: "SUPPLIER",
      partyId: Number(po.supplierId),
      description: `USD ${settledUsd.toFixed(2)} settlement for ${po.poNumber}`,
      status: "COMPLETED",
      createdBy: actor.userId,
    });
    const receiptId = extractInsertId(receiptRes);

    await adjustSupplierBalance(tx, Number(po.supplierId), carryingIqd.negated());
    await adjustSupplierBalanceUsd(tx, Number(po.supplierId), settledUsd.negated());
    await tx.update(purchaseOrders).set({
      paidAmount: toDbMoney(money(po.paidAmount).plus(carryingIqd)),
      paidUsd: toDbMoney(money(po.paidUsd).plus(settledUsd)),
    }).where(eq(purchaseOrders.id, input.purchaseOrderId));

    await postEntry(tx, {
      entryType: "PAYMENT_OUT",
      branchId: Number(po.branchId),
      purchaseOrderId: input.purchaseOrderId,
      supplierId: Number(po.supplierId),
      receiptId,
      amount: carryingIqd,
      dedupeKey: `POUSD-PAY:${receiptId}`,
      notes: `Direct USD settlement via ${input.method}`,
      postingSourceComponents: {
        roleDebits: { AP: carryingIqd },
        roleCredits: { [paymentRole]: carryingIqd },
      },
      postingIntent: createPostingIntent("PAYMENT_OUT_SUPPLIER", "PAYMENT_OUT", [debitLine("AP", carryingIqd), creditLine(paymentRole, carryingIqd)], {
        roleDebits: { AP: carryingIqd },
        roleCredits: { [paymentRole]: carryingIqd },
      }),
    });
    if (!fxDiff.isZero()) {
      const fxAbsolute = fxDiff.abs();
      const fxSourceComponents = fxDiff.isPositive()
        ? {
            roleDebits: { [paymentRole]: fxAbsolute },
            roleCredits: { FX_GAIN: fxAbsolute },
          }
        : {
            roleDebits: { FX_LOSS: fxAbsolute },
            roleCredits: { [paymentRole]: fxAbsolute },
          };
      await postEntry(tx, {
        entryType: "EXCHANGE_FX_DIFF",
        branchId: Number(po.branchId),
        purchaseOrderId: input.purchaseOrderId,
        supplierId: Number(po.supplierId),
        receiptId,
        amount: fxDiff,
        dedupeKey: `POUSD-FX:${receiptId}`,
        notes: "Realized FX difference on direct supplier settlement",
        postingSourceComponents: fxSourceComponents,
        postingIntent: createPostingIntent(fxDiff.isPositive() ? "EXCHANGE_FX_GAIN" : "EXCHANGE_FX_LOSS", "EXCHANGE_FX_DIFF", fxDiff.isPositive() ? [debitLine(paymentRole, fxAbsolute), creditLine("FX_GAIN", fxAbsolute)] : [debitLine("FX_LOSS", fxAbsolute), creditLine(paymentRole, fxAbsolute)], fxSourceComponents),
      });
    }
    if (feeIqd.gt(0)) {
      await postEntry(tx, {
        entryType: "EXCHANGE_FEE",
        branchId: Number(po.branchId),
        purchaseOrderId: input.purchaseOrderId,
        supplierId: Number(po.supplierId),
        receiptId,
        amount: feeIqd,
        cost: feeIqd,
        profit: feeIqd.negated(),
        dedupeKey: `POUSD-FEE:${receiptId}`,
        notes: "Card/transfer fee for supplier settlement",
        postingSourceComponents: {
          roleDebits: { OPERATING_EXPENSE: feeIqd },
          roleCredits: { [paymentRole]: feeIqd },
        },
        postingIntent: createPostingIntent("EXCHANGE_FEE_EXPENSE", "EXCHANGE_FEE", [debitLine("OPERATING_EXPENSE", feeIqd), creditLine(paymentRole, feeIqd)], {
          roleDebits: { OPERATING_EXPENSE: feeIqd },
          roleCredits: { [paymentRole]: feeIqd },
        }),
      });
    }
    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "purchase.usd-settle", input.clientRequestId, receiptId, settlementRequestHash);
    }
    return {
      receiptId,
      settledUsd: settledUsd.toFixed(2),
      carryingIqd: carryingIqd.toFixed(2),
      chargedIqd: chargedIqd.toFixed(2),
      feeIqd: feeIqd.toFixed(2),
      fxDiff: toDbMoney(fxDiff),
    };
  });
}
