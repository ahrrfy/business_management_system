import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { customers, invoiceItems, invoices, productVariants, receipts, shifts } from "../../drizzle/schema";
import {
  computeInvoiceCost,
  computeInvoiceTotals,
  computeLineTotal,
  snapshotUnitCost,
} from "./billing";
import { applyMovement, convertToBaseQuantity } from "./inventoryService";
import { adjustCustomerBalance, computeInvoiceStatus, postEntry } from "./ledgerService";
import { money, roundCashIQD, toDbMoney } from "./money";
import { findIdempotentRefId, recordIdempotencyKey } from "./idempotency";
import { nextInvoiceNumber } from "./numbering";
import { openShiftIdTx } from "./shiftService";
import { getUnitPrice, resolveTier, type PriceTier } from "./pricing";
import { withTx, type Actor } from "./tx";
import { assertCreditLimit } from "../lib/credit";
import { extractInsertId } from "../lib/insertId";

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";

export interface SaleLineInput {
  variantId: number;
  productUnitId: number;
  quantity: string;
  unitPriceOverride?: string | null;
  discountPercent?: string | null;
  discountAmount?: string | null;
}

export interface CreateSaleInput {
  branchId: number;
  shiftId?: number | null;
  customerId?: number | null;
  priceTier?: PriceTier | null;
  sourceType: "POS" | "ONLINE" | "ORDER" | "WORKORDER";
  lines: SaleLineInput[];
  invoiceDiscount?: string | null;
  taxRatePercent?: string | null;
  payment?: { amount: string; method: PaymentMethod } | null;
  clientRequestId?: string | null;
  notes?: string | null;
  /** موافقة مدير على تجاوز حدّ الائتمان (يضبطها الراوتر بعد التحقّق من هوية المدير). */
  creditApproved?: boolean;
  /** تاريخ استحقاق الفاتورة (YYYY-MM-DD) — للبيع الآجل. يظهر في AR aging والتنبيهات. */
  dueDate?: string | null;
  /** تقريب نقدي عراقي للبيع النقدي الكامل (يضبطه POS): الخادم يقرّب الإجمالي ويُسجّل الفرق ADJUST. */
  cashRoundIQD?: boolean;
}

export interface CreateSaleResult {
  invoiceId: number;
  invoiceNumber: string;
  total: string;
  status: "PENDING" | "PARTIALLY_PAID" | "PAID";
  idempotentReplay?: boolean;
}

export async function createSale(input: CreateSaleInput, actor: Actor): Promise<CreateSaleResult> {
  return withTx(async (tx) => {
    // 1. Idempotency: replay the existing invoice for a repeated clientRequestId.
    if (input.clientRequestId) {
      const existing = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.sourceId, input.clientRequestId))
        .limit(1);
      if (existing[0]) {
        return {
          invoiceId: Number(existing[0].id),
          invoiceNumber: existing[0].invoiceNumber,
          total: existing[0].total,
          status: existing[0].status as CreateSaleResult["status"],
          idempotentReplay: true,
        };
      }
    }

    if (!input.lines.length) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إنشاء فاتورة بلا أصناف" });
    }

    // 2. Shift must be OPEN and belong to the branch (when provided — POS).
    //    .for("update") يُسَلْسِل البيع مع closeShift على نفس الصفّ ⇒ إمّا يقفل البيع قبل
    //    الإغلاق ويُحتسَب، أو يُرفض إن سبق الإغلاق فلا يدخل receipt بعد قطع الـZ-report.
    const isCashPayment = input.payment?.method === "CASH" && money(input.payment?.amount ?? "0").gt(0);
    if (isCashPayment && (input.shiftId == null)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "يَلزم وردية مفتوحة للبيع النقدي",
      });
    }
    if (input.shiftId) {
      const s = await tx
        .select()
        .from(shifts)
        .where(eq(shifts.id, input.shiftId))
        .for("update")
        .limit(1);
      if (!s[0] || s[0].status !== "OPEN" || Number(s[0].branchId) !== input.branchId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "الوردية غير مفتوحة أو لا تخص هذا الفرع" });
      }
    }

    // 3. Resolve the effective price tier.
    let customerTier: PriceTier | null = null;
    if (input.customerId) {
      // قفل صفّ العميل: يُسلسِل البيوع الآجلة المتزامنة فلا يتجاوز اثنان حدّ الائتمان معاً.
      const c = await tx.select().from(customers).where(eq(customers.id, input.customerId)).for("update").limit(1);
      if (!c[0]) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
      customerTier = c[0].defaultPriceTier as PriceTier;
    }
    const tier = resolveTier({ override: input.priceTier ?? null, customerTier });

    // 4. Price/cost/convert each line.
    const computed = [];
    for (const l of input.lines) {
      const v = await tx
        .select({ costPrice: productVariants.costPrice, isActive: productVariants.isActive })
        .from(productVariants)
        .where(eq(productVariants.id, l.variantId))
        .limit(1);
      if (!v[0]) throw new TRPCError({ code: "NOT_FOUND", message: `المتغيّر ${l.variantId} غير موجود` });
      if (v[0].isActive === false) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${l.variantId} معطّل` });
      }

      const { baseQuantity } = await convertToBaseQuantity(tx, l.productUnitId, l.quantity, l.variantId);
      const unitPrice =
        l.unitPriceOverride != null && l.unitPriceOverride !== ""
          ? money(l.unitPriceOverride)
          : await getUnitPrice(tx, l.productUnitId, tier);
      const unitCost = snapshotUnitCost(v[0].costPrice);
      const lineRes = computeLineTotal({
        unitPrice,
        quantity: money(l.quantity),
        discountPercent: l.discountPercent,
        discountAmount: l.discountAmount,
      });
      computed.push({
        variantId: l.variantId,
        productUnitId: l.productUnitId,
        baseQuantity,
        unitPrice: lineRes.unitPrice,
        unitCost,
        quantity: lineRes.quantity,
        discountAmount: lineRes.discountAmount,
        total: lineRes.total,
      });
    }

    // 5. Deterministic lock order: sort by variantId ascending.
    computed.sort((a, b) => a.variantId - b.variantId);

    // 6. Totals + COGS.
    const totals = computeInvoiceTotals({
      lineTotals: computed.map((c) => c.total),
      invoiceDiscount: input.invoiceDiscount,
      taxRatePercent: input.taxRatePercent,
    });
    const costTotal = computeInvoiceCost(
      computed.map((c) => ({ unitCost: c.unitCost, baseQuantity: c.baseQuantity }))
    );

    // 7. تقريب نقدي IQD للبيع النقدي الكامل: يُقرَّب الإجمالي لفئة 250، فالنقد المستلم = الإجمالي المقرّب
    //    (لا فائض/عجز وهمي عند الرفع، ولا رفض بيع نقدي عند الخفض). الفرق يُسجَّل قيد ADJUST لاحقاً.
    const roundCash = !!input.cashRoundIQD && input.payment?.method === "CASH";
    const grandTotalD = money(totals.total);
    const effectiveTotalD = roundCash ? roundCashIQD(grandTotalD) : grandTotalD;
    const cashRoundingAdj = effectiveTotalD.minus(grandTotalD); // ± (صفر إن لا تقريب)
    const paidNow = roundCash ? effectiveTotalD : money(input.payment?.amount ?? "0");
    const unpaid = effectiveTotalD.minus(paidNow);
    if (unpaid.gt(0) && !input.customerId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "البيع الآجل يتطلب عميلاً محدداً" });
    }
    // 7.b فحص حدّ الائتمان (H4): null=بلا حدّ، 0=حظر آجل، >0=فحص الإسقاط. موافقة المدير تتجاوز.
    if (unpaid.gt(0) && input.customerId && !input.creditApproved) {
      await assertCreditLimit(tx, input.customerId, unpaid, input.branchId);
    }

    // 8. Invoice header.
    const invoiceNumber = await nextInvoiceNumber(tx, input.branchId);
    const status = computeInvoiceStatus(toDbMoney(effectiveTotalD), toDbMoney(paidNow));
    const insRes = await tx.insert(invoices).values({
      invoiceNumber,
      sourceType: input.sourceType,
      sourceId: input.clientRequestId ?? null,
      branchId: input.branchId,
      shiftId: input.shiftId ?? null,
      customerId: input.customerId ?? null,
      priceTier: tier,
      // dueDate يُحفظ كـDate إن وُرد، وإلا null. يستعمله AR aging والتنبيهات.
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      subtotal: totals.subtotal,
      taxAmount: totals.taxAmount,
      discountAmount: totals.discountAmount,
      total: toDbMoney(effectiveTotalD),
      costTotal,
      cashRoundingAdjustment: toDbMoney(cashRoundingAdj),
      status,
      paidAmount: toDbMoney(paidNow),
      paymentMethod: input.payment?.method ?? null,
      paymentDate: paidNow.gt(0) ? new Date() : null,
      notes: input.notes ?? null,
      createdBy: actor.userId,
    });
    const invoiceId = extractInsertId(insRes);

    // 9. Items.
    for (const c of computed) {
      await tx.insert(invoiceItems).values({
        invoiceId,
        variantId: c.variantId,
        productUnitId: c.productUnitId,
        quantity: c.quantity,
        baseQuantity: c.baseQuantity,
        unitPrice: c.unitPrice,
        unitCost: c.unitCost,
        discountAmount: c.discountAmount,
        total: c.total,
      });
    }

    // 10. Deduct stock (OUT) per line.
    for (const c of computed) {
      await applyMovement(tx, {
        variantId: c.variantId,
        branchId: input.branchId,
        baseQuantity: c.baseQuantity,
        movementType: "OUT",
        referenceType: "INVOICE",
        referenceId: invoiceId,
        createdBy: actor.userId,
      });
    }

    // 11. SALE ledger entry (revenue = net before tax).
    const revenue = money(totals.subtotal).minus(money(totals.discountAmount));
    const cost = money(costTotal);
    await postEntry(tx, {
      entryType: "SALE",
      dedupeKey: `SALE:${invoiceId}`, // حارس بنيوي: قيد SALE واحد لكل فاتورة
      branchId: input.branchId,
      invoiceId,
      customerId: input.customerId ?? null,
      revenue,
      cost,
      profit: revenue.minus(cost),
      taxAmount: money(totals.taxAmount),
      amount: money(totals.total),
    });

    // 11.b تسوية التقريب النقدي: قيد ADJUST بفرق التقريب ⇒ (SALE.amount + ADJUST.amount) = الإجمالي المقرّب = النقد المستلم.
    // G6 (١٩/٦/٢٦): dedupeKey حارس ضدّ تكرار ADJUST لو حدثت إعادة محاولة بعد ER_DUP_ENTRY
    // (tx.atomicity تحمي نظرياً، لكن dedupeKey defense-in-depth صريح).
    if (!cashRoundingAdj.isZero()) {
      await postEntry(tx, {
        entryType: "ADJUST",
        dedupeKey: `ADJUST:IQD:${invoiceId}`,
        branchId: input.branchId,
        invoiceId,
        customerId: input.customerId ?? null,
        revenue: cashRoundingAdj,
        profit: cashRoundingAdj,
        amount: cashRoundingAdj,
        notes: "تقريب نقدي IQD",
      });
    }

    // 12. Payment + AR.
    if (paidNow.gt(0)) {
      const rRes = await tx.insert(receipts).values({
        invoiceId,
        branchId: input.branchId,
        shiftId: input.shiftId ?? null,
        direction: "IN",
        amount: toDbMoney(paidNow),
        paymentMethod: input.payment!.method,
        status: "COMPLETED",
        createdBy: actor.userId,
      });
      const receiptId = extractInsertId(rRes);
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        branchId: input.branchId,
        invoiceId,
        receiptId,
        customerId: input.customerId ?? null,
        amount: paidNow,
      });
    }
    if (input.customerId) {
      await adjustCustomerBalance(tx, input.customerId, effectiveTotalD.minus(paidNow));
    }

    return { invoiceId, invoiceNumber, total: toDbMoney(effectiveTotalD), status };
  });
}

export interface ProcessPaymentInput {
  invoiceId: number;
  amount: string;
  method: PaymentMethod;
  shiftId?: number | null;
  /** إن حُدِّد، يُرفض الدفع على فاتورة فرعٍ مغاير (عزل الفروع لغير المدير). */
  enforceBranchId?: number | null;
  /** Idempotency: نفس الـmagic key يُعاد تشغيله بنتيجة العملية الأولى (لا تكرّر دفعة عند النقر المزدوج). */
  clientRequestId?: string | null;
}

/** Record a later payment against a credit invoice; updates status + AR. */
export async function processPayment(input: ProcessPaymentInput, actor: Actor) {
  return withTx(async (tx) => {
    // Idempotency (نمط جذري ١): قبل أيّ replay، نتحقّق أنّ الإيصال المخزَّن يخصّ نفس الفاتورة
    // وفرع المستخدم الحقيقي. كان الـreplay يَعود قبل enforceBranchId وقبل أيّ ربط بـinput.invoiceId
    // ⇒ مفتاح يُعاد استعماله على فاتورة مختلفة كان يُرجع نجاحاً صامتاً (no-op) فيتلقّى الكاشير «مدفوع»
    // ولا تُسجَّل دفعةٌ ثانية فعلياً ⇒ منفذ سرقة نقد. التأكيد يغلق الفئة بأكملها.
    if (input.clientRequestId) {
      const existingRefId = await findIdempotentRefId(tx, "sale.pay", input.clientRequestId);
      if (existingRefId != null) {
        const r = (await tx.select().from(receipts).where(eq(receipts.id, existingRefId)).limit(1))[0];
        if (!r || Number(r.invoiceId) !== Number(input.invoiceId)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح مستعمَل لدفعة على فاتورة مختلفة",
          });
        }
        if (money(r.amount).toFixed(2) !== money(input.amount).toFixed(2)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح مستعمَل لدفعة بمبلغ مختلف",
          });
        }
        // أعِد قراءة الفاتورة لإرجاع حالتها الحديثة (replay آمن، لا كتابة).
        const inv = (await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1))[0];
        if (input.enforceBranchId != null && inv && Number(inv.branchId) !== input.enforceBranchId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية على فاتورة فرع آخر" });
        }
        return {
          invoiceId: input.invoiceId,
          paidAmount: inv?.paidAmount ?? "0.00",
          status: inv?.status ?? "PENDING",
          idempotentReplay: true as const,
        };
      }
    }

    const rows = await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).for("update").limit(1);
    const inv = rows[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
    // عزل الفرع: غير المدير لا يدفع على فاتورة فرع آخر (منع IDOR).
    if (input.enforceBranchId != null && Number(inv.branchId) !== input.enforceBranchId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية على فاتورة فرع آخر" });
    }
    if (inv.status === "CANCELLED" || inv.status === "RETURNED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن الدفع على فاتورة ملغاة أو مرتجعة" });
    }
    if (inv.status === "PAID") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الفاتورة مدفوعة بالكامل" });
    }
    const amount = money(input.amount);
    if (amount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ يجب أن يكون موجباً" });

    // إن مُرِّر shiftId: تَحقّق من حالة الوردية وملكيتها (M5 + M9).
    if (input.shiftId != null) {
      const sRows = await tx
        .select()
        .from(shifts)
        .where(eq(shifts.id, input.shiftId))
        .for("update")
        .limit(1);
      const s = sRows[0];
      if (!s) {
        throw new TRPCError({ code: "NOT_FOUND", message: "الوردية غير موجودة" });
      }
      if (s.status !== "OPEN") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الوردية مغلقة" });
      }
      const role = actor.role;
      if (role !== "admin" && role !== "manager") {
        if (Number(s.userId) !== Number(actor.userId)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "لا تَستطيع التسجيل على وردية مستخدم آخر",
          });
        }
      }
    }
    // انسب الدفع النقدي لوردية الموظّف المفتوحة إن لم يُمرَّر صراحةً (تسوية الصندوق).
    const shiftId = input.shiftId ?? (await openShiftIdTx(tx, actor.userId, Number(inv.branchId)));
    // M5/M8: النقد يَستوجب وردية مفتوحة (سواء مُرِّرت صراحةً أو حُلّت من المستخدم).
    if (input.method === "CASH" && shiftId == null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "يَلزم وردية مفتوحة للبيع النقدي",
      });
    }
    const rRes = await tx.insert(receipts).values({
      invoiceId: input.invoiceId,
      branchId: Number(inv.branchId),
      shiftId,
      direction: "IN",
      amount: toDbMoney(amount),
      paymentMethod: input.method,
      status: "COMPLETED",
      createdBy: actor.userId,
    });
    const receiptId = extractInsertId(rRes);
    if (input.clientRequestId) await recordIdempotencyKey(tx, "sale.pay", input.clientRequestId, receiptId);

    const newPaid = money(inv.paidAmount).plus(amount);
    const status = computeInvoiceStatus(inv.total, toDbMoney(newPaid));
    await tx
      .update(invoices)
      .set({ paidAmount: toDbMoney(newPaid), status, paymentDate: new Date(), paymentMethod: input.method })
      .where(eq(invoices.id, input.invoiceId));

    await postEntry(tx, {
      entryType: "PAYMENT_IN",
      branchId: Number(inv.branchId),
      invoiceId: input.invoiceId,
      receiptId,
      customerId: inv.customerId,
      amount,
    });
    if (inv.customerId) {
      await adjustCustomerBalance(tx, Number(inv.customerId), amount.neg());
    }

    return { invoiceId: input.invoiceId, paidAmount: toDbMoney(newPaid), status };
  });
}
