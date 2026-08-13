// تصحيح فاتورة بيع مُثبَّتة (0168) — «عكسٌ كامل + إعادة إصدار» ذرّياً.
//
// الوثيقة الحاكمة: docs/invoice-correction-design-2026-08-10.md (مُعتمَدةٌ بقرارات المالك §١٠).
// المبدأ: الفاتورة المُثبَّتة لا تُعدَّل حرّاً (تحرّك الدفتر/المخزون/الذمم). «تصحيحها» =
//   ① عكسها كاملاً بمنطق المرتجع المُختبَر (returnSaleInTx، بلا ردٍّ نقديّ) ⇒ يُعكَس
//      الدفتر/COGS/المخزون/الأمانة/تقريب IQD، وترجع الذمّة كاملةً (−الإجمالي).
//   ② تصحيح الذمّة: نُعيد المدفوع (+paid) لأنّه لا يُردّ بل يُنقَل للفاتورة الجديدة ⇒ صافي عكس
//      الذمّة = −(الإجمالي − المدفوع)، مطابقٌ لإزالة مساهمة الأصل في AR.
//   ③ فصل إيصالات القبض عن الأصل (invoiceId ← NULL) ثم إعادة ختمها بالفاتورة الجديدة عبر
//      preCollected.receiptIds (append-only، لا إيصالٌ ثانٍ ولا نقدٌ جديد يدخل الدرج).
//   ④ إعادة الترحيل بالبيانات المصحّحة عبر createSaleInTx (كل حرّاسه: تسعير/ائتمان/تحت التكلفة/
//      مخزون) ⇒ فاتورةٌ جديدة، والأصل يصير SUPERSEDED مربوطاً بها.
//   ⑤ الفرق الزائد (overpay: المصحّح < المقبوض) هجينٌ بقرار الموظّف: رصيد دائن للعميل، أو استرداد
//      نقديّ من الدرج (قرار المالك §١٠). النقص (المصحّح > المقبوض) يُحصَّل الآن بـadditionalPayment.
//
// العمولة/التقارير تُشتقّ من الدفتر لا من حالة الفاتورة (commissions/base.ts:17-18) ⇒ تتعافى
// ذاتياً: قيود RETURN تعكس استحقاق الأصل، وقيد SALE الجديد يثبّت المصحّح.
//
// v1 (مؤجَّلٌ صريحاً، يُرفَض بأمان): المُرتجَعة (كلياً/جزئياً)، منشأ WORKORDER، الرقمية، التوصيل النشط.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  accountingEntries,
  deliveryConsignments,
  digitalSaleDetails,
  invoiceItems,
  invoices,
  products,
  productVariants,
  receipts,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { adjustCustomerBalance, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { returnSaleInTx } from "../returnService";
import { computeExpectedCash, resolveBranchCashShiftTx, openShiftIdTx } from "../shiftService";
import { withTx, type Actor } from "../tx";
import { createSaleInTx } from "./create";
import type { PriceTier } from "../pricing";
import type { SaleLineInput } from "./types";

type CorrectionPayMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";

export interface CorrectSaleInput {
  originalInvoiceId: number;
  // ── البيانات المصحّحة (نفس عقد البيع، الحقول القابلة للتصحيح فقط) ──
  customerId?: number | null;
  contactName?: string | null;
  contactPhone?: string | null;
  priceTier?: PriceTier | null;
  lines: SaleLineInput[];
  invoiceDiscount?: string | null;
  deliveryFee?: string | null;
  taxRatePercent?: string | null;
  dueDate?: string | null;
  notes?: string | null;
  /** دفعةٌ إضافية تُحصَّل الآن حين يزيد المصحّح على المقبوض سلفاً (نقص). */
  additionalPayment?: { amount: string; method: CorrectionPayMethod; reference?: string | null } | null;
  /** معالجة الفرق الزائد (المصحّح < المقبوض) — قرار الموظّف الهجين (§١٠). */
  overpayHandling?: "CREDIT" | "CASH_REFUND";
  /** درج الاسترداد النقديّ للفرق الزائد عند تعدّد الدرج المفتوح. */
  overpayRefundShiftId?: number | null;
  /** تجاوز حدّ الائتمان إن أنشأ التصحيح تعرّضاً آجلاً (يمرّره الراوتر بعد التحقّق). */
  creditApproved?: boolean;
  creditApprovalId?: number;
  managerOverrideByUserId?: number;
  /** موافقة على بيعٍ تحت التكلفة في السطور المصحّحة (يضبطها الراوتر). */
  priceOverrideApproved?: boolean;
  clientRequestId?: string | null;
}

export interface CorrectSaleResult {
  originalInvoiceId: number;
  correctedInvoiceId: number;
  correctedInvoiceNumber: string;
  total: string;
  /** الفرق الزائد المُعالَج (رصيد/استرداد) — صفر إن لم يكن. */
  overpay: string;
  overpayHandled?: "CREDIT" | "CASH_REFUND";
  idempotentReplay?: boolean;
}

export async function correctSale(input: CorrectSaleInput, actor: Actor & { role?: string }): Promise<CorrectSaleResult> {
  return withTx(async (tx) => {
    // ── ٠) idempotency: إعادة التشغيل بنفس المفتاح تُعيد التصحيح الأوّل (refId = الفاتورة الجديدة) ──
    if (input.clientRequestId) {
      const existingNewId = await findIdempotentRefId(tx, "sale.correct", input.clientRequestId);
      if (existingNewId != null) {
        const nrow = (await tx
          .select({ id: invoices.id, number: invoices.invoiceNumber, total: invoices.total, correctionOf: invoices.correctionOfInvoiceId })
          .from(invoices).where(eq(invoices.id, Number(existingNewId))).limit(1))[0];
        if (!nrow) throw new TRPCError({ code: "CONFLICT", message: "تعارض idempotency: تصحيحٌ مُسجَّلٌ بلا فاتورة" });
        return {
          originalInvoiceId: Number(nrow.correctionOf ?? input.originalInvoiceId),
          correctedInvoiceId: Number(nrow.id),
          correctedInvoiceNumber: nrow.number,
          total: nrow.total,
          overpay: "0.00",
          idempotentReplay: true,
        };
      }
    }

    // ── ١) تحميل الأصل تحت قفل الصفّ + الحرّاس ──
    const inv = (await tx.select().from(invoices).where(eq(invoices.id, input.originalInvoiceId)).for("update").limit(1))[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
    if (inv.status === "CANCELLED" || inv.status === "RETURNED" || inv.status === "SUPERSEDED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا تُصحَّح فاتورة ملغاة/مرتجعة/مُستبدَلة سلفاً" });
    }
    // عزل الفرع (مرآة returnService): مدير فرعٍ لا يصحّح فاتورة فرعٍ آخر (يمسّ دفتره/درجه).
    if (actor.role !== "admin" && Number(inv.branchId) !== Number(actor.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الفاتورة لا تخصّ فرعك" });
    }
    if (inv.sourceType === "WORKORDER") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "فاتورة أمر الشغل تُصحَّح من تدفّق أمر الشغل، لا من هنا (المتغيّر الأساس لم يدخل المخزون فعلاً)" });
    }
    if (round2(money(inv.returnedTotal ?? "0")).gt(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا تُصحَّح فاتورةٌ عليها مرتجعٌ سابق — عالِجها عبر المرتجعات" });
    }
    // البطاقات الرقمية: عكسها بقرارٍ إداريّ عبر digitalCards.reversal (الكرت صدر من جهاز المزوّد).
    const digital = await tx.select({ id: digitalSaleDetails.id }).from(digitalSaleDetails).where(eq(digitalSaleDetails.invoiceId, input.originalInvoiceId)).limit(1);
    if (digital.length) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا تُصحَّح فاتورةٌ فيها كروتٌ رقمية — استعمل «عكس بيع الكروت»" });
    }
    // توصيلٌ نشط: عهدةٌ على مندوب — سوِّها/أرجِعها أولاً (تجنّب عكس عهدةٍ متحرّكة).
    const activeCn = await tx.select({ id: deliveryConsignments.id }).from(deliveryConsignments)
      .where(and(eq(deliveryConsignments.invoiceId, input.originalInvoiceId), inArray(deliveryConsignments.status, ["DISPATCHED", "PARTIAL"]))).limit(1);
    if (activeCn.length) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الفاتورة بيد مندوبٍ (توصيلٌ نشط) — سوِّ الإرسالية أو أرجِعها قبل التصحيح" });
    }

    const originalPaid = round2(money(inv.paidAmount));
    // المرحلة الآمنة الحالية: إعادة إصدار مستند غير محصّل فقط. نقل سند قبض مكتمل إلى فاتورة
    // بديلة يعيد كتابة الحقيقة التاريخية للدرج/وسيلة الدفع؛ يبقى محظوراً إلى أن تُبنى
    // paymentApplications + reclassification append-only. الفاتورة المدفوعة تُعالج بمرتجع موثق
    // ثم بيع جديد، لا عبر نقل الإيصال.
    if (originalPaid.gt(0)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "الفاتورة عليها مقبوضات — استخدم مرتجعاً موثقاً ثم فاتورة بيع جديدة؛ لا يجوز نقل إيصال القبض التاريخي إلى فاتورة بديلة",
      });
    }
    const originalCustomerId = inv.customerId != null ? Number(inv.customerId) : null;

    // ── حارس النقل الماليّ (ذكاءٌ حاكمٌ يمنع الخطأ بالبناء) ──
    //    التصحيح ينقل المقبوض للفاتورة الجديدة عبر إيصالات القبض القابلة للفصل (IN مكتمل، عدا
    //    أمانة أجرة التوصيل). لكن `paidAmount` قد يُموَّل من عربونٍ (orderPayments) إيصالُ أمّه
    //    غير مختومٍ بهذه الفاتورة (عربونٌ متعدّد الأهداف/على أمر شغل/مرتجَع جزئياً — راجع
    //    reception/deposits.ts + returnService.ts). حينها detachedSum < paidAmount، فيُعيد
    //    الترحيلُ تحميلَ الفرق ذمّةً وهميّةً على العميل. الحلّ: لا نُصحّح إن اختلّ المجموع — بل
    //    نوجّه لإلغاءٍ كامل ثمّ إعادة بيع. (المجموع محسوبٌ قبل أيّ تعديل ⇒ رفضٌ فاشلٌ نظيف.)
    const payRcpts = await tx.select({ id: receipts.id, amount: receipts.amount }).from(receipts).where(and(
      eq(receipts.invoiceId, input.originalInvoiceId),
      eq(receipts.direction, "IN"),
      eq(receipts.status, "COMPLETED"),
      sql`NOT EXISTS (SELECT 1 FROM accountingEntries ae WHERE ae.receiptId = ${receipts.id} AND ae.entryType = 'DELIVERY_FEE_HELD')`,
    ));
    const detachedIds = payRcpts.map((r) => Number(r.id));
    const detachedSum = round2(payRcpts.reduce((s, r) => s.plus(money(r.amount)), new Decimal(0)));
    if (!detachedSum.equals(originalPaid)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `تعذّر التصحيح: المدفوع المسجَّل (${originalPaid.toFixed(2)}) لا يطابق إيصالات القبض القابلة للنقل (${detachedSum.toFixed(2)}) — قد يكون بعضه من عربونٍ مرتبطٍ بغير هذه الفاتورة. عالِجها بإلغاءٍ كامل ثمّ إعادة بيع.`,
      });
    }
    // منع تغيير العميل عند وجود مدفوعات: المقبوض يخصّ العميل الأصليّ؛ نقله لعميلٍ آخر يُشوّه الذمم
    //    (يُعيد للأصل ويُرصّد الجديد بلا إيصالٍ للأصل). لتغيير العميل: إلغاءٌ كامل ثمّ إعادة بيع.
    const targetCustomerId = input.customerId != null ? Number(input.customerId) : null;
    if (originalPaid.gt(0) && Number(targetCustomerId ?? 0) !== Number(originalCustomerId ?? 0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يُغيَّر العميل في تصحيحٍ عليه مدفوعات — المقبوض يخصّ العميل الأصليّ. لتغييره: ألغِ الفاتورة وأعِد البيع.",
      });
    }

    // ── ٢) العكس الكامل عبر منطق المرتجع المُختبَر (كل البنود، بلا ردٍّ نقديّ, مع إعادة للمخزون) ──
    const items = await tx.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, input.originalInvoiceId));
    if (!items.length) throw new TRPCError({ code: "BAD_REQUEST", message: "الفاتورة بلا بنودٍ لتصحيحها" });
    const variantIds = Array.from(new Set(items.map((item) => Number(item.variantId))));
    const serviceLine = (await tx
      .select({ id: productVariants.id })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(and(inArray(productVariants.id, variantIds), eq(products.isService, true)))
      .limit(1))[0];
    if (serviceLine) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "لا تُعكس فاتورة خدمة كتصحيحٍ مخزني؛ استخدم إلغاء/مرتجع الخدمة الموثق ثم أنشئ الفاتورة الصحيحة",
      });
    }
    // returnedTotal=0 مضمونٌ أعلاه ⇒ المتبقّي القابل للعكس = كامل الكمية الأساس.
    const reverseLines = items.map((it) => ({ invoiceItemId: Number(it.id), baseQuantity: Number(it.baseQuantity) }));
    await returnSaleInTx(tx, { invoiceId: input.originalInvoiceId, lines: reverseLines, refund: null, restock: true, clientRequestId: null }, actor);

    // ── ٣) تصحيح الذمّة: العكس خصم −الإجمالي من AR (كأنّ المدفوع يُردّ رصيداً)؛ لكنّه لا يُردّ بل
    //    يُنقَل للجديدة ⇒ نعيده (+المدفوع) فيصير صافي عكس الأصل = −(الإجمالي − المدفوع). ──
    if (originalCustomerId != null && originalPaid.gt(0)) {
      await adjustCustomerBalance(tx, originalCustomerId, originalPaid);
    }

    // ── ٤) فصل إيصالات القبض عن الأصل (المجموع مُتحقَّقٌ = المدفوع أعلاه؛ تُعاد ختمها عبر preCollected) ──
    if (detachedIds.length) {
      await tx.update(receipts).set({ invoiceId: null }).where(inArray(receipts.id, detachedIds));
    }

    // ── ٥) وسم الأصل SUPERSEDED وتصفيره (لم يُرتجَع، بل استُبدِل) ──
    await tx.update(invoices).set({ status: "SUPERSEDED", paidAmount: "0", returnedTotal: "0" }).where(eq(invoices.id, input.originalInvoiceId));

    // ── ٦) درج الدفعة الإضافية (نقص: المصحّح > المقبوض) — يلزمه درجٌ حين نقدية ──
    let addPayShiftId: number | null = null;
    if (input.additionalPayment && input.additionalPayment.method === "CASH") {
      const resolved = await resolveBranchCashShiftTx(tx, Number(inv.branchId), null);
      addPayShiftId = resolved.shiftId;
    }

    // ── ٧) إعادة الترحيل بالبيانات المصحّحة (المدفوع مُرحَّلٌ سلفاً؛ الفائض يُقصَر بـallowPreCollectedOverpay) ──
    const correctionReqId = input.clientRequestId ? `${input.clientRequestId}:corr` : null;
    const repost = await createSaleInTx(tx, {
      branchId: Number(inv.branchId),
      shiftId: addPayShiftId,
      sourceType: inv.sourceType as "POS" | "ONLINE" | "ORDER",
      customerId: input.customerId === undefined ? originalCustomerId : input.customerId,
      contactName: input.contactName === undefined ? (inv.contactName ?? null) : input.contactName,
      contactPhone: input.contactPhone === undefined ? (inv.contactPhone ?? null) : input.contactPhone,
      priceTier: input.priceTier ?? null,
      lines: input.lines,
      invoiceDiscount: input.invoiceDiscount ?? null,
      deliveryFee: input.deliveryFee ?? null,
      taxRatePercent: input.taxRatePercent ?? null,
      dueDate: input.dueDate ?? null,
      notes: input.notes ?? null,
      payment: input.additionalPayment ?? null,
      preCollected: detachedSum.gt(0) ? { amount: detachedSum.toFixed(2), receiptIds: detachedIds } : null,
      allowPreCollectedOverpay: true,
      creditApproved: input.creditApproved,
      creditApprovalId: input.creditApprovalId,
      managerOverrideByUserId: input.managerOverrideByUserId,
      priceOverrideApproved: input.priceOverrideApproved,
      clientRequestId: correctionReqId,
    }, actor);
    const newId = repost.invoiceId;
    const newTotal = round2(money(repost.total));

    // حارس: الدفعة الإضافية لا تتجاوز الفرق المستحقّ (النقص) — الزائد لن يُردّ (createSaleInTx يقصر
    //    المدفوع بالإجمالي فيُبتَلع الفائض بلا استرداد). حصِّل الفرق فقط. (الرفض هنا يُرجِع الترحيل ذرّياً.)
    if (input.additionalPayment) {
      const addAmt = round2(money(input.additionalPayment.amount));
      const shortfall = round2(Decimal.max(new Decimal(0), newTotal.minus(detachedSum)));
      if (addAmt.gt(shortfall)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `الدفعة الإضافية (${addAmt.toFixed(2)}) تتجاوز الفرق المستحقّ (${shortfall.toFixed(2)}) — حصِّل الفرق فقط.`,
        });
      }
    }

    // ── ٨) ربط الفاتورتين (نسب التصحيح ثنائية الاتجاه) ──
    await tx.update(invoices).set({ correctionOfInvoiceId: input.originalInvoiceId }).where(eq(invoices.id, newId));
    await tx.update(invoices).set({ correctedByInvoiceId: newId }).where(eq(invoices.id, input.originalInvoiceId));

    // ── ٩) الفرق الزائد (overpay): المقبوض سلفاً > مستحقّ المصحّح ⇒ يُردّ/يُرصَّد ──
    const overpay = round2(Decimal.max(new Decimal(0), detachedSum.minus(newTotal)));
    let overpayHandled: "CREDIT" | "CASH_REFUND" | undefined;
    if (overpay.gt(0)) {
      const mode = input.overpayHandling ?? "CASH_REFUND";
      const creditCustomerId = input.customerId ?? originalCustomerId;
      if (mode === "CREDIT" && creditCustomerId == null) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "الرصيد الدائن يتطلّب عميلاً مسجَّلاً — اختر استرداداً نقدياً للعميل العابر" });
      }
      if (mode === "CASH_REFUND") {
        const resolved = await resolveBranchCashShiftTx(tx, Number(inv.branchId), input.overpayRefundShiftId ?? null);
        const drawerCash = await computeExpectedCash(tx, resolved.shiftId, resolved.openingBalance);
        if (overpay.gt(drawerCash)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `الفرق الزائد (${overpay.toFixed(2)}) يتجاوز النقد المتوفّر في هذا الدرج (${drawerCash.toFixed(2)}) — اختر درجاً آخر أو رصيداً دائناً` });
        }
        const rRes = await tx.insert(receipts).values({
          invoiceId: newId, branchId: Number(inv.branchId), shiftId: resolved.shiftId,
          cashBucket: "DRAWER", direction: "OUT", amount: toDbMoney(overpay), paymentMethod: "CASH",
          status: "COMPLETED", createdBy: actor.userId,
        });
        await postEntry(tx, {
          entryType: "PAYMENT_OUT", branchId: Number(inv.branchId), invoiceId: newId,
          receiptId: extractInsertId(rRes), customerId: creditCustomerId, amount: overpay,
          notes: `استرداد فرقٍ زائد — تصحيح فاتورة #${input.originalInvoiceId}`,
        });
        overpayHandled = "CASH_REFUND";
      } else {
        // رصيد دائن: إيصال OUT بلا مسٍّ للدرج (cashBucket=null) + خفض ذمّة العميل (رصيدٌ لصالحه).
        const shiftId = await openShiftIdTx(tx, actor.userId, Number(inv.branchId));
        const rRes = await tx.insert(receipts).values({
          invoiceId: newId, branchId: Number(inv.branchId), shiftId,
          cashBucket: null, direction: "OUT", amount: toDbMoney(overpay), paymentMethod: "CASH",
          status: "COMPLETED", createdBy: actor.userId,
        });
        await postEntry(tx, {
          entryType: "PAYMENT_OUT", branchId: Number(inv.branchId), invoiceId: newId,
          receiptId: extractInsertId(rRes), customerId: creditCustomerId, amount: overpay,
          notes: `فرقٌ زائد مُحوَّل رصيداً دائناً — تصحيح فاتورة #${input.originalInvoiceId}`,
        });
        await adjustCustomerBalance(tx, creditCustomerId!, overpay.neg());
        overpayHandled = "CREDIT";
      }
    }

    // ── ١٠) تسجيل مفتاح idempotency (refId = الفاتورة الجديدة) ──
    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "sale.correct", input.clientRequestId, newId);
    }

    return {
      originalInvoiceId: input.originalInvoiceId,
      correctedInvoiceId: newId,
      correctedInvoiceNumber: repost.invoiceNumber,
      total: repost.total,
      overpay: overpay.toFixed(2),
      overpayHandled,
    };
  });
}
