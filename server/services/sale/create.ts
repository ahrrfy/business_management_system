// إنشاء فاتورة بيع ذرّياً: idempotency + تسعير/تحويل الأسطر + بوّابة أقل-من-التكلفة +
// تقريب نقدي IQD + حدّ الائتمان + خصم المخزون + قيد SALE + الدفعة/الذمم.
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { customers, invoiceItems, invoices, productVariants, receipts, shifts } from "../../../drizzle/schema";
import {
  computeInvoiceCost,
  computeInvoiceTotals,
  computeLineTotal,
  isInvoiceBelowCost,
  snapshotUnitCost,
} from "../billing";
import { assertCreditLimit } from "../../lib/credit";
import { extractInsertId } from "../../lib/insertId";
import { consumeApproval, validateApproval } from "../creditApprovalService";
import { applyMovement, convertToBaseQuantity } from "../inventoryService";
import { adjustCustomerBalance, computeInvoiceStatus, postEntry } from "../ledgerService";
import { money, roundCashIQD, toDbMoney } from "../money";
import { nextInvoiceNumber } from "../numbering";
import { getUnitPrice, resolveTier, type PriceTier } from "../pricing";
import { type Actor, withTx } from "../tx";
import type { CreateSaleInput, CreateSaleResult } from "./types";

export async function createSale(input: CreateSaleInput, actor: Actor): Promise<CreateSaleResult> {
  return withTx(async (tx) => {
    // 1. Idempotency: replay the existing invoice for a repeated clientRequestId.
    //    SALES-04 (تدقيق ٢٣/٦/٢٦): البصمة كانت قاصرة على branchId ⇒ كاشير يُعيد استعمال المفتاح
    //    على بيع مختلف فيستلم فاتورة بيعٍ سابق ولا يُسجَّل البيع الجديد ⇒ منفذ سرقة نقد. الحلّ على
    //    نمط processPayment/voucherService: نتحقّق من (branch, customer, payment.method, عدد الأسطر)
    //    قبل إرجاع الفاتورة القديمة، وإلا CONFLICT صريح يُظهر للمستخدم أن المفتاح يخصّ بيعاً مغايراً.
    if (input.clientRequestId) {
      const existing = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.sourceId, input.clientRequestId))
        .limit(1);
      if (existing[0]) {
        const ex = existing[0];
        // SALES-03: عزل الفرع — مفتاح idempotency يخصّ بيع فرع آخر لا يُكشَف للمستخدم (تعارض، لا تسريب فاتورة).
        if (Number(ex.branchId) !== input.branchId) {
          throw new TRPCError({ code: "CONFLICT", message: "مفتاح idempotency مستعمَل لبيع فرع آخر" });
        }
        const requestedCustomerId = input.customerId ?? null;
        const storedCustomerId = ex.customerId != null ? Number(ex.customerId) : null;
        if (storedCustomerId !== requestedCustomerId) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح مستعمَل لبيع عميل مختلف",
          });
        }
        const requestedMethod = input.payment?.method ?? null;
        if ((ex.paymentMethod ?? null) !== requestedMethod) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح مستعمَل لبيع بطريقة دفع مختلفة",
          });
        }
        // SALES-04b (تدقيق ٢/٧): البصمة كانت تقارن «عدد» الأسطر فقط ⇒ بيع مختلف بنفس عدد الأصناف
        // يُصادَر بفاتورة قديمة بصمت (منفذ سرقة نقد: النقد يُقبض ولا يُسجَّل). الآن نقارن **محتوى**
        // الأسطر (الصنف + الوحدة + الكمية) كمجموعة مرتّبة. لا نقارن السعر/الخصم عمداً كي لا نُطلق
        // تعارضاً زائفاً عند إعادة محاولة نفس البيع بعد تغيّر تسعيرة — الصنف+الوحدة+الكمية بصمة كافية.
        const existingItems = await tx
          .select({
            variantId: invoiceItems.variantId,
            productUnitId: invoiceItems.productUnitId,
            quantity: invoiceItems.quantity,
          })
          .from(invoiceItems)
          .where(eq(invoiceItems.invoiceId, ex.id));
        const lineKey = (variantId: number | null, unitId: number | null, quantity: string) =>
          `${Number(variantId)}:${unitId == null ? "" : Number(unitId)}:${money(quantity).toFixed(3)}`;
        const existingKeys = existingItems
          .map((i) => lineKey(Number(i.variantId), i.productUnitId == null ? null : Number(i.productUnitId), i.quantity))
          .sort();
        const requestedKeys = input.lines
          .map((l) => lineKey(l.variantId, l.productUnitId, l.quantity))
          .sort();
        if (
          existingKeys.length !== requestedKeys.length ||
          existingKeys.some((k, i) => k !== requestedKeys[i])
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح مستعمَل لبيع بأصناف أو كميات مختلفة",
          });
        }
        return {
          invoiceId: Number(ex.id),
          invoiceNumber: ex.invoiceNumber,
          total: ex.total,
          status: ex.status as CreateSaleResult["status"],
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
      // SHIFT-OWN (تدقيق ٢/٧): فرض ملكية الوردية — كما في processPayment. غياب هذا الفحص كان
      // يُتيح لكاشير تمرير shiftId لوردية زميلٍ في نفس الفرع فيُنسَب نقده لدرج الزميل (عجز مزوّر عند
      // إغلاق الضحية + غطاء اختلاس). المدير/الأدمن معفيان (يسجّلون على أي وردية للتسوية).
      const role = actor.role;
      if (role !== "admin" && role !== "manager" && Number(s[0].userId) !== Number(actor.userId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا تَستطيع التسجيل على وردية مستخدم آخر" });
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
    // D1 (٣٠/٦): حلّ N+1 — قراءة كل المتغيّرات بـinArray دفعةً واحدةً قبل الحلقة بدل
    // round-trip لكل سطر. لا قفل (.for("update")) هنا (نقرأ تكلفة + isActive فقط — متغيّرات
    // الأسعار/التفعيل لا تتعارض مع البيع؛ الأقفال الفعليّة للمخزون لاحقاً عبر applyMovement).
    // قبل: ٢٠ سطر = ٢٠ استعلاماً متسلسلاً. بعد: استعلام واحد ⇒ زمن المعاملة ينخفض دراماتيكياً
    // ونافذة الأقفال على shifts/customers تَنكمش (انكماش هذه النافذة = أقلّ تنافس عند الذروة).
    const uniqueVariantIds = Array.from(new Set(input.lines.map((l) => l.variantId)));
    const variantRows = await tx
      .select({
        id: productVariants.id,
        costPrice: productVariants.costPrice,
        isActive: productVariants.isActive,
      })
      .from(productVariants)
      .where(inArray(productVariants.id, uniqueVariantIds));
    const variantById = new Map<number, { costPrice: string; isActive: boolean | null }>();
    for (const r of variantRows) {
      variantById.set(Number(r.id), { costPrice: String(r.costPrice), isActive: r.isActive });
    }

    const computed = [];
    for (const l of input.lines) {
      const v = variantById.get(l.variantId);
      if (!v) throw new TRPCError({ code: "NOT_FOUND", message: `المتغيّر ${l.variantId} غير موجود` });
      if (v.isActive === false) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${l.variantId} معطّل` });
      }

      const { baseQuantity } = await convertToBaseQuantity(tx, l.productUnitId, l.quantity, l.variantId);
      const unitPrice =
        l.unitPriceOverride != null && l.unitPriceOverride !== ""
          ? money(l.unitPriceOverride)
          : await getUnitPrice(tx, l.productUnitId, tier);
      const unitCost = snapshotUnitCost(v.costPrice);
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

    // 6.b SALES-01/02 — بوّابة البيع بأقل من التكلفة (سدّ حرج: كاشير يبيع بسعر/خصم صفر).
    //     المنطق مشترك في billing.isInvoiceBelowCost ⇒ لا تَنجرف سياسة POS عن قناة الطباعة.
    //     أيُّ بند/فاتورة تحت COGS يَلزمه موافقة مدير (الراوتر يَمنح المدير/الأدمن السلطة ذاتياً)؛
    //     الهدايا (تكلفة=صفر) تَبقى مسموحة.
    const belowCost = isInvoiceBelowCost(computed, totals.subtotal, totals.discountAmount, costTotal);
    if (belowCost && !input.priceOverrideApproved) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "بيع بأقل من التكلفة يتطلب موافقة مدير (سعر أو خصم تحت التكلفة).",
      });
    }

    // 7. تقريب نقدي IQD للبيع النقدي الكامل: يُقرَّب الإجمالي لفئة 250، فالنقد المستلم = الإجمالي المقرّب
    //    (لا فائض/عجز وهمي عند الرفع، ولا رفض بيع نقدي عند الخفض). الفرق يُسجَّل قيد ADJUST لاحقاً.
    const roundCash = !!input.cashRoundIQD && input.payment?.method === "CASH";
    const grandTotalD = money(totals.total);
    const effectiveTotalD = roundCash ? roundCashIQD(grandTotalD) : grandTotalD;
    const cashRoundingAdj = effectiveTotalD.minus(grandTotalD); // ± (صفر إن لا تقريب)
    const tendered = money(input.payment?.amount ?? "0");
    // SALES-05 (تدقيق ٢/٧): كان paidNow يُفرَض = الإجمالي المقرّب عند roundCash متجاهلاً المبلغ
    // المُسلَّم ⇒ بيع آجل جزئي بعلم cashRoundIQD=true يُسجَّل «مدفوعاً بالكامل» فتُمحى ذمة العميل
    // (والنقد الوهمي يظهر عجزاً بدرج الكاشير). الآن: التقريب يطبَّق على الإجمالي دائماً، لكن نعامل
    // البيع كمدفوعٍ بالكامل (paidNow = الإجمالي المقرّب) فقط إذا كان المُسلَّم يغطّي الإجمالي فعلاً؛
    // وإلا فهي دفعة جزئية ⇒ paidNow = المُسلَّم بالضبط والباقي ذمّة على العميل.
    const paidNow = roundCash && tendered.gte(grandTotalD) ? effectiveTotalD : tendered;
    const unpaid = effectiveTotalD.minus(paidNow);
    if (unpaid.gt(0) && !input.customerId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "البيع الآجل يتطلب عميلاً محدداً" });
    }
    // 7.b فحص حدّ الائتمان (H4): null=بلا حدّ، 0=حظر آجل، >0=فحص الإسقاط.
    //     B5 (١٩/٦/٢٦): الموافقة لم تعد blanket — تحتاج إمّا (أ) creditApprovalId جاهز، أو (ب) managerOverrideByUserId
    //     يكون الـrouter قد وثّق هويته. الخدمة في حالة (ب) تُنشئ approval ذرّياً داخل نفس withTx.
    let effectiveApprovalId = input.creditApprovalId;
    if (unpaid.gt(0) && input.customerId) {
      if (input.creditApproved) {
        if (!input.creditApprovalId && !input.managerOverrideByUserId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "تجاوز السقف يحتاج موافقة مُسجَّلة (creditApprovalId) أو هوية مدير مُتحقَّق منها — لا تُقبل موافقة بلا سقف.",
          });
        }
        if (!effectiveApprovalId && input.managerOverrideByUserId) {
          // تَنشئ Approval تلقائياً، مرتبطة بهذا العميل + سقف=unpaid (تماماً)، single-use.
          const created = await (await import("../creditApprovalService")).createApproval(tx, {
            customerId: input.customerId,
            maxAmount: unpaid.toFixed(2),
            approvedBy: input.managerOverrideByUserId,
            ttlMinutes: 5,
            notes: "manager-verified override via sale router (auto-generated)",
          });
          effectiveApprovalId = created.id;
        }
        // SELECT FOR UPDATE داخل validateApproval ⇒ لا double-spend عبر سباق.
        await validateApproval(tx, effectiveApprovalId!, input.customerId, unpaid);
      } else {
        await assertCreditLimit(tx, input.customerId, unpaid, input.branchId);
      }
    }

    // 8. Invoice header.
    const invoiceNumber = await nextInvoiceNumber(tx, input.branchId);
    const status = computeInvoiceStatus(toDbMoney(effectiveTotalD), toDbMoney(paidNow));
    const insRes = await tx.insert(invoices).values({
      invoiceNumber,
      sourceType: input.sourceType,
      // TX-01: clientRequestId فارغ ("") يُخزَّن null لا "" — وإلا اصطدم على uq_invoice_source وحجب
      // كل بيعٍ لاحق بلا مفتاح. (|| يَلتقط "" بخلاف ?? الذي يُمرّره.)
      sourceId: input.clientRequestId || null,
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

    // B5: استهلاك الموافقة (يربطها بالفاتورة الفعلية بعد إنشائها — single-use).
    if (effectiveApprovalId) {
      await consumeApproval(tx, effectiveApprovalId, invoiceId);
    }

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
        // cashBucket=DRAWER للنقد (يدخل تسوية Z-report)، NULL لغير النقد (لا يَمسّ صندوقاً).
        // مرآة لنمط voucherService — يَحرس مستقبلاً صيَغ reconcile/cashOrphans التي تَفلتر بـcashBucket.
        cashBucket: input.payment!.method === "CASH" ? "DRAWER" : null,
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

    return { invoiceId, invoiceNumber, total: toDbMoney(effectiveTotalD), status, priceOverride: belowCost };
  });
}
