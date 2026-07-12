import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { accountingEntries, customers, invoiceItemBundleComponents, invoiceItems, invoices, receipts } from "../../drizzle/schema";
import { classifyVariants } from "./bundleService";
import { localDayStart } from "./dateRange";
import { findIdempotentRefId, recordIdempotencyKey } from "./idempotency";
import { applyMovement } from "./inventoryService";
import { adjustCustomerBalance, computeInvoiceStatus, postEntry } from "./ledgerService";
import { money, round2, toDbMoney } from "./money";
import { openShiftIdTx } from "./shiftService";
import { withTx, type Actor } from "./tx";
import { extractInsertId } from "../lib/insertId";

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";

export interface ReturnLineInput {
  invoiceItemId: number;
  baseQuantity: number;
}
export interface ReturnSaleInput {
  invoiceId: number;
  lines: ReturnLineInput[];
  refund?: { amount: string; method: PaymentMethod } | null;
  restock?: boolean;
  /** Idempotency: نفس المفتاح يُعاد تشغيله بنتيجة المرتجع الأول (لا استرداد/إرجاع مزدوج). */
  clientRequestId?: string | null;
}

export async function returnSale(input: ReturnSaleInput, actor: Actor) {
  return withTx(async (tx) => {
    // Idempotency: تكرار الطلب نفسه يُعاد تشغيله بنتيجة المرتجع الأول بلا استرداد مكرّر.
    // قبل أي replay نتحقّق أنّ المفتاح يخصّ نفس الفاتورة والفرع وبنفس بصمة المرتجع
    // (لا يصحّ أن يُرجع مفتاحٌ مُستعمَلٌ لفاتورة مغايرة نجاحاً صامتاً بـreturnedTotal=0).
    if (input.clientRequestId) {
      const existingRefId = await findIdempotentRefId(tx, "sale.return", input.clientRequestId);
      if (existingRefId != null) {
        if (Number(existingRefId) !== Number(input.invoiceId)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح مستعمَل لمرتجع على فاتورة مختلفة",
          });
        }
        const replayInvRows = await tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, input.invoiceId))
          .limit(1);
        const replayInv = replayInvRows[0];
        if (!replayInv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
        // بصمة الكمية الإجمالية للأسطر المطلوبة — إن جاء المفتاح نفسه بأسطر مختلفة فالعملية مختلفة.
        const replayItems = await tx
          .select()
          .from(invoiceItems)
          .where(eq(invoiceItems.invoiceId, input.invoiceId));
        const itemByIdReplay = new Map(replayItems.map((i) => [Number(i.id), i]));
        let expectedGrossNet = new Decimal(0);
        for (const l of input.lines) {
          const it = itemByIdReplay.get(l.invoiceItemId);
          if (!it) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "تعارض idempotency: المفتاح مستعمَل لمرتجع بأسطر مختلفة",
            });
          }
          if (!Number.isInteger(l.baseQuantity) || l.baseQuantity <= 0) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "كمية الإرجاع يجب أن تكون صحيحة موجبة" });
          }
          const portion = new Decimal(l.baseQuantity).dividedBy(it.baseQuantity);
          expectedGrossNet = expectedGrossNet.plus(money(it.total).times(portion));
        }
        const subtotalR = money(replayInv.subtotal);
        const discountAmountR = money(replayInv.discountAmount);
        const taxAmountR = money(replayInv.taxAmount);
        const discountRatioR = subtotalR.gt(0) ? discountAmountR.dividedBy(subtotalR) : new Decimal(0);
        const taxableR = subtotalR.minus(discountAmountR);
        const taxRateR = taxableR.gt(0) ? taxAmountR.dividedBy(taxableR) : new Decimal(0);
        const expectedNetRevenue = round2(expectedGrossNet.times(new Decimal(1).minus(discountRatioR)));
        const expectedTotal = round2(expectedNetRevenue.plus(round2(expectedNetRevenue.times(taxRateR))));
        // يجب أن يكون التراكمي على الفاتورة شاملاً قيمة هذا المرتجع (وإلا فبصمة الكيان مختلفة).
        const cumulativeReturned = money(replayInv.returnedTotal ?? "0");
        if (cumulativeReturned.lt(expectedTotal)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح مستعمَل لمرتجع بقيمة مختلفة",
          });
        }
        const fullyReturnedReplay =
          replayInv.status === "RETURNED" ||
          replayItems.every((r) => (r.returnedBaseQuantity ?? 0) >= r.baseQuantity);
        return {
          invoiceId: input.invoiceId,
          returnedTotal: expectedTotal.toFixed(2),
          fullyReturned: fullyReturnedReplay,
          idempotentReplay: true as const,
        };
      }
    }

    const invRows = await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).for("update").limit(1);
    const inv = invRows[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
    if (inv.status === "CANCELLED" || inv.status === "RETURNED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الفاتورة ملغاة أو مرتجعة بالكامل" });
    }
    // G8 (١٩/٦/٢٦): فحص ملكية الفرع — managerProcedure يسمح بالمدير والأدمن، لكن مدير فرع لا
    // يجوز له إصدار مرتجع على فاتورة فرع آخر (يخرج نقد من صندوقه لفاتورة لا تخصّه).
    if (actor.role !== "admin" && Number(inv.branchId) !== Number(actor.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الفاتورة لا تخصّ فرعك" });
    }
    // فاتورة أمر الشغل تبيع متغيّراً أساس لم يُضَف للمخزون فعلاً (المواد استُهلكت عند البدء)،
    // فإعادة التخزين تخلق مخزوناً وهمياً لمنتج مُخصَّص. افرض restock=false لها.
    const restock = inv.sourceType === "WORKORDER" ? false : input.restock !== false;
    if (!input.lines.length) throw new TRPCError({ code: "BAD_REQUEST", message: "لا أصناف للإرجاع" });

    // RETURN-DEDUP (تدقيق ٢/٧): منع تكرار invoiceItemId في أسطر المرتجع. كان الفحص يقارن كل سطر
    // بـremaining من لقطةٍ ثابتة، فسطران بنفس البند [{6},{6}] يمرّان كلاهما ⇒ إعادة تخزين مضاعفة
    // (applyMovement مرّتين) وقيمة مرتجع تتجاوز الفاتورة (returnedTotal > total) وذمّة/نقد مسرَّبان.
    const seenItemIds = new Set<number>();
    for (const l of input.lines) {
      if (seenItemIds.has(l.invoiceItemId)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `البند ${l.invoiceItemId} مكرّر في أسطر المرتجع — ادمج الكميات في سطرٍ واحد`,
        });
      }
      seenItemIds.add(l.invoiceItemId);
    }

    const items = await tx.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, input.invoiceId));
    const itemById = new Map(items.map((i) => [Number(i.id), i]));

    const work = input.lines.map((l) => {
      const item = itemById.get(l.invoiceItemId);
      if (!item) throw new TRPCError({ code: "BAD_REQUEST", message: `بند ${l.invoiceItemId} لا يخص الفاتورة` });
      if (!Number.isInteger(l.baseQuantity) || l.baseQuantity <= 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "كمية الإرجاع يجب أن تكون صحيحة موجبة" });
      }
      const remaining = item.baseQuantity - (item.returnedBaseQuantity ?? 0);
      if (l.baseQuantity > remaining) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `كمية الإرجاع تتجاوز المتبقّي القابل للإرجاع للبند ${l.invoiceItemId}` });
      }
      return { line: l, item };
    });
    work.sort((a, b) => Number(a.item.variantId) - Number(b.item.variantId));

    // Proportional allocation of revenue/tax against the invoice totals.
    const subtotal = money(inv.subtotal);
    const discountAmount = money(inv.discountAmount);
    const taxAmount = money(inv.taxAmount);
    const discountRatio = subtotal.gt(0) ? discountAmount.dividedBy(subtotal) : new Decimal(0);
    const taxable = subtotal.minus(discountAmount);
    const taxRate = taxable.gt(0) ? taxAmount.dividedBy(taxable) : new Decimal(0);

    let returnedGrossNet = new Decimal(0);
    let returnedCost = new Decimal(0);

    // bundles (٧/٧/٢٦): إن كان أحد البنود المُرجَعة بكجاً، لا نطبّق applyMovement على البكج نفسه
    // (لا branchStock له) — نُوسّع مكوّناته من الوصفة الحالية ونعيدها للمخزون. تجميع لكل المتغيّرات
    // (بمن فيهم مكوّنات البكج + السلع العادية) قبل التطبيق كي يحافظ على ترتيب القفل الحتميّ.
    // ⚠️ ملاحظة توثيقية: التوسيع يستعمل **الوصفة الحالية** للبكج (قد تختلف عن وصفة يوم البيع إن عُدّلت).
    // gstack B6 (٧/٧/٢٦): نستعمل **لقطة المكوّنات** (`invoiceItemBundleComponents`) المحفوظة لحظة
    // البيع بدل `bundleComponents` الحيّة — تعديل الوصفة بين البيع والإرجاع لا يُلوّث المرتجع.
    // اللقطة موجودة لكل invoiceItem بكج (يفرضه sale/create.ts). للفواتير القديمة (قبل هجرة 0060)
    // اللقطة غائبة ⇒ نرفض المرتجع الآلي برسالة صريحة (لا نسقط بصمت للوصفة الحيّة، دفاع صريح).
    const returnedVariantIds = Array.from(new Set(work.map((w) => Number(w.item.variantId))));
    const kindByVariant = await classifyVariants(tx, returnedVariantIds);
    // خريطة (invoiceItemId ⇒ صفوف المكوّنات المحفوظة) — قراءة واحدة بلا N+1.
    const bundleItemIds = work
      .filter((w) => kindByVariant.get(Number(w.item.variantId)) === "BUNDLE")
      .map((w) => Number(w.item.id));
    const snapshotByItem = new Map<number, Array<{ componentVariantId: number; componentBaseQuantity: number }>>();
    if (bundleItemIds.length) {
      const rows = await tx
        .select({
          invoiceItemId: invoiceItemBundleComponents.invoiceItemId,
          componentVariantId: invoiceItemBundleComponents.componentVariantId,
          componentBaseQuantity: invoiceItemBundleComponents.componentBaseQuantity,
        })
        .from(invoiceItemBundleComponents)
        .where(inArray(invoiceItemBundleComponents.invoiceItemId, bundleItemIds));
      for (const r of rows) {
        const iid = Number(r.invoiceItemId);
        const list = snapshotByItem.get(iid) ?? [];
        list.push({
          componentVariantId: Number(r.componentVariantId),
          componentBaseQuantity: Number(r.componentBaseQuantity),
        });
        snapshotByItem.set(iid, list);
      }
    }

    interface StockOp { variantId: number; baseQuantity: number; }
    const stockOps: StockOp[] = [];

    for (const { line, item } of work) {
      const portion = new Decimal(line.baseQuantity).dividedBy(item.baseQuantity);
      returnedGrossNet = returnedGrossNet.plus(money(item.total).times(portion));
      returnedCost = returnedCost.plus(round2(money(item.unitCost).times(line.baseQuantity)));

      const itemVariantId = Number(item.variantId);
      const kind = kindByVariant.get(itemVariantId) ?? "STOCKED";

      if (restock) {
        if (kind === "BUNDLE") {
          // gstack B6: نقرأ اللقطة المحفوظة على invoiceItem بدل الوصفة الحيّة.
          const def = snapshotByItem.get(Number(item.id)) ?? [];
          if (!def.length) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: `البكج (بند ${Number(item.id)}) بلا لقطة مكوّنات محفوظة — الفواتير قبل ٧/٧/٢٦ لا تدعم الإرجاع الآلي للبكج؛ أعِد المكوّنات فرادى`,
            });
          }
          for (const c of def) {
            stockOps.push({
              variantId: c.componentVariantId,
              baseQuantity: c.componentBaseQuantity * line.baseQuantity,
            });
          }
        } else {
          stockOps.push({ variantId: itemVariantId, baseQuantity: line.baseQuantity });
        }
      }
      await tx
        .update(invoiceItems)
        .set({
          returnedBaseQuantity: (item.returnedBaseQuantity ?? 0) + line.baseQuantity,
          // returnedRestockedBaseQuantity يزيد فقط حين عادت البضاعة للرفّ (restock) — يُميّز المُعاد
          // للمخزون عن التالف كي تطرح تقارير COGS التحليلية تكلفة المُعاد فقط (مطابِقةً للدفتر).
          ...(restock
            ? { returnedRestockedBaseQuantity: (item.returnedRestockedBaseQuantity ?? 0) + line.baseQuantity }
            : {}),
        })
        .where(eq(invoiceItems.id, Number(item.id)));
    }

    // تجميع + تطبيق بترتيب variantId التصاعدي — نفس نمط sale/create.ts (خطوة 10).
    if (restock) {
      const aggregated = new Map<number, number>();
      for (const op of stockOps) {
        aggregated.set(op.variantId, (aggregated.get(op.variantId) ?? 0) + op.baseQuantity);
      }
      const sortedVariantIds = Array.from(aggregated.keys()).sort((a, b) => a - b);
      for (const vid of sortedVariantIds) {
        const qty = aggregated.get(vid)!;
        if (qty <= 0) continue;
        await applyMovement(tx, {
          variantId: vid,
          branchId: Number(inv.branchId),
          baseQuantity: qty,
          movementType: "RETURN",
          referenceType: "RETURN",
          referenceId: input.invoiceId,
          createdBy: actor.userId,
        });
      }
    }

    // Completion is known now (returnedBaseQuantity was updated in the loop).
    const refreshed = await tx
      .select({ baseQuantity: invoiceItems.baseQuantity, returnedBaseQuantity: invoiceItems.returnedBaseQuantity })
      .from(invoiceItems)
      .where(eq(invoiceItems.invoiceId, input.invoiceId));
    const fullyReturned = refreshed.every((r) => (r.returnedBaseQuantity ?? 0) >= r.baseQuantity);

    // Prior RETURN entries (stored negative) → positive cumulative totals.
    const priorRows = await tx
      .select({
        rev: sql<string>`COALESCE(SUM(${accountingEntries.revenue}), 0)`,
        tax: sql<string>`COALESCE(SUM(${accountingEntries.taxAmount}), 0)`,
        amt: sql<string>`COALESCE(SUM(${accountingEntries.amount}), 0)`,
      })
      .from(accountingEntries)
      .where(and(eq(accountingEntries.invoiceId, input.invoiceId), eq(accountingEntries.entryType, "RETURN")));
    const priorRevenue = money(priorRows[0]?.rev ?? "0").neg();
    const priorTax = money(priorRows[0]?.tax ?? "0").neg();
    const priorTotal = money(priorRows[0]?.amt ?? "0").neg();

    let returnedRevenue: Decimal;
    let returnedTax: Decimal;
    let returnedTotal: Decimal;
    if (fullyReturned) {
      // Last-installment remainder: cumulative returns equal the original exactly.
      // إيراد الفاتورة الأصلي = (المجموع الفرعي − الخصم) + أجرة الشحن — مطابقٌ تماماً لقيد SALE
      // (create.ts: revenue = subtotal − discount + deliveryFee). عكسُ الشحن على الإرجاع الكامل فقط
      // (لا الجزئي: الشحن يُستحقّ حتى لو أُرجِع بعض البنود) ⇒ يبقى Σ(revenue)=Σ(profit)=0 عند الإرجاع
      // الكامل، وصفراً للفواتير بلا شحن (deliveryFee=0) فلا تغيّر سلوكيّ (مراجعة عدائية ١٢/٧).
      const invoiceRevenue = money(inv.subtotal).minus(money(inv.discountAmount)).plus(money(inv.deliveryFee ?? "0"));
      returnedRevenue = round2(invoiceRevenue.minus(priorRevenue));
      returnedTax = round2(money(inv.taxAmount).minus(priorTax));
      returnedTotal = round2(money(inv.total).minus(priorTotal));
    } else {
      returnedRevenue = round2(returnedGrossNet.times(new Decimal(1).minus(discountRatio)));
      returnedTax = round2(returnedRevenue.times(taxRate));
      returnedTotal = round2(returnedRevenue.plus(returnedTax));
    }
    returnedCost = round2(returnedCost);
    // عند restock=false (تالف/أمر شغل) البضاعة لا تعود للمخزون ⇒ تكلفتها خسارة فعلية،
    // فلا يصحّ عكس COGS (وإلا تبخّرت التكلفة من الدفتر = ربح مُبالَغ + نقص أصل بلا مصروف
    // مقابل، مناقضةً لسياسة «التلف مصروفٌ بالكلفة»). نعكس التكلفة فقط حين تعود البضاعة للرفّ
    // (restock=true) فيتعادل ازديادُ المخزون مع نقصان COGS. أمّا الإيراد/الضريبة/الذمة فتُعكَس
    // في الحالتين (العميل أُسترِدّ/أُسقطت ذمّته بصرف النظر عن مصير البضاعة المُعادة).
    const reversedCost = restock ? returnedCost : new Decimal(0);

    // RETURN ledger entry: negative values.
    await postEntry(tx, {
      entryType: "RETURN",
      branchId: Number(inv.branchId),
      invoiceId: input.invoiceId,
      customerId: inv.customerId,
      revenue: returnedRevenue.neg(),
      cost: reversedCost.neg(),
      profit: returnedRevenue.minus(reversedCost).neg(),
      taxAmount: returnedTax.neg(),
      amount: returnedTotal.neg(),
    });

    // G10 (١٩/٦/٢٦): عكس تقريب النقد العراقي (cashRoundingAdjustment) عند المرتجع الكامل
    // — المرتجع الجزئي يترك التقريب على الفاتورة ويُصفّى عند المرتجع المُكمِل. كان عدم عكسه
    // يخلّف بقايا صامتة في الدفتر (دنانير قليلة لكنها تتراكم عبر آلاف الفواتير).
    const cashRoundOriginal = money(inv.cashRoundingAdjustment ?? "0");
    if (fullyReturned && !cashRoundOriginal.isZero()) {
      await postEntry(tx, {
        entryType: "ADJUST",
        dedupeKey: `ADJUST:IQD:RETURN:${input.invoiceId}`,
        branchId: Number(inv.branchId),
        invoiceId: input.invoiceId,
        customerId: inv.customerId,
        revenue: cashRoundOriginal.neg(),
        profit: cashRoundOriginal.neg(),
        amount: cashRoundOriginal.neg(),
        notes: "عكس تقريب نقدي IQD — مرتجع كامل",
      });
    }

    // Cash refund capped to min(returnedTotal, amount actually paid). Reject overage.
    const requestedRefund = money(input.refund?.amount ?? "0");
    if (requestedRefund.lt(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ الاسترداد لا يصحّ أن يكون سالباً" });
    }
    // سقف الاسترداد بالطريقة نفسها: المتاح = Σ(IN بهذه الطريقة) − Σ(OUT بهذه الطريقة)،
    // فلا يُسترَدّ نقداً ما دُفع بطاقةً (يُفرّغ الصندوق) ولا يتجاوز المقبوض فعلاً بتلك الطريقة.
    const refundMethod = input.refund?.method;
    let methodAvailable = new Decimal(0);
    if (refundMethod) {
      const mr = await tx
        .select({
          inSum: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' THEN ${receipts.amount} ELSE 0 END), 0)`,
          outSum: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'OUT' THEN ${receipts.amount} ELSE 0 END), 0)`,
        })
        .from(receipts)
        .where(
          and(
            eq(receipts.invoiceId, input.invoiceId),
            eq(receipts.paymentMethod, refundMethod),
            eq(receipts.status, "COMPLETED"),
          ),
        );
      methodAvailable = money(mr[0]?.inSum ?? "0").minus(money(mr[0]?.outSum ?? "0"));
    }
    const refundCap = Decimal.min(returnedTotal, methodAvailable);
    if (requestedRefund.gt(refundCap)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `الاسترداد بـ${refundMethod ?? "—"} (${requestedRefund.toFixed(2)}) يتجاوز المسموح (${refundCap.toFixed(2)} = الأقل من قيمة المرتجع والمقبوض بهذه الطريقة)`,
      });
    }
    const cashRefund = requestedRefund;

    if (cashRefund.gt(0)) {
      // انسب الاسترداد النقدي لوردية الموظّف المفتوحة (وإلا فالـZ-report يُظهر عجزاً وهمياً).
      const shiftId = await openShiftIdTx(tx, actor.userId, Number(inv.branchId));
      // G9 (١٩/٦/٢٦): استرداد نقدي بلا وردية مفتوحة كان يكتب receipt بـshiftId=null
      // ⇒ يخرج النقد من الدُرج لكن لا يدخل تسوية Z-report ⇒ عجز وهمي عند الإغلاق.
      if (input.refund!.method === "CASH" && shiftId == null) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "افتح وردية أولاً لاسترداد نقدي" });
      }
      const rRes = await tx.insert(receipts).values({
        invoiceId: input.invoiceId,
        branchId: Number(inv.branchId),
        shiftId,
        // cashBucket=DRAWER للنقد (يَخرج من الدُرج بمرتجع نقدي ويظهر في Z-report).
        // غير النقد ⇒ NULL (لا يَمسّ صندوقاً). مرآة لنمط saleService/voucherService.
        cashBucket: input.refund!.method === "CASH" ? "DRAWER" : null,
        direction: "OUT",
        amount: toDbMoney(cashRefund),
        paymentMethod: input.refund!.method,
        status: "COMPLETED",
        createdBy: actor.userId,
      });
      const receiptId = extractInsertId(rRes);
      await postEntry(tx, {
        entryType: "PAYMENT_OUT",
        branchId: Number(inv.branchId),
        invoiceId: input.invoiceId,
        receiptId,
        customerId: inv.customerId,
        amount: cashRefund,
      });
    }

    // paidAmount tracks Σ(IN) − Σ(OUT); recompute status.
    // returnedTotal تراكمي عبر مرتجعات جزئية ⇒ يمنع انحراف AR في reconcile/aging.
    // G7 (١٩/٦/٢٦): clamp ≥ 0 — refundCap نظرياً يضمن `cashRefund ≤ paidAmount`، لكن لو
    // انحرف الحساب لأي سبب (مرتجع قديم مُسجَّل بطريقة مختلفة، حالة حدّية) نمنع paidAmount السالب.
    const paidMinusRefund = money(inv.paidAmount).minus(cashRefund);
    const newPaid = paidMinusRefund.lt(0) ? money(0) : paidMinusRefund;
    const newReturnedTotal = money(inv.returnedTotal ?? "0").plus(returnedTotal);
    // INVOICE-STATUS (تدقيق ٢/٧): الحالة على الصافي بعد المرتجعات ⇒ فاتورة مُرتجَعة جزئياً وسُدّد
    // صافيها تصبح PAID لا PARTIALLY_PAID الأبدية.
    const status = fullyReturned
      ? "RETURNED"
      : computeInvoiceStatus(inv.total, toDbMoney(newPaid), toDbMoney(newReturnedTotal));
    await tx
      .update(invoices)
      .set({
        paidAmount: toDbMoney(newPaid),
        returnedTotal: toDbMoney(newReturnedTotal),
        status,
      })
      .where(eq(invoices.id, input.invoiceId));

    // AR: the portion not refunded in cash is dropped from the customer's balance.
    if (inv.customerId) {
      await adjustCustomerBalance(tx, Number(inv.customerId), returnedTotal.minus(cashRefund).neg());
    }

    // Idempotency: سجّل المفتاح بعد نجاح الكتابة (refId = الفاتورة).
    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "sale.return", input.clientRequestId, input.invoiceId);
    }

    return {
      invoiceId: input.invoiceId,
      returnedTotal: returnedTotal.toFixed(2),
      fullyReturned,
    };
  });
}

export interface ListSalesReturnsInput {
  customerId?: number;
  branchId?: number;
  invoiceId?: number;
  /** فترة على entryDate (YYYY-MM-DD) — عمود DATE بلا وقت ⇒ gte/lte شاملان مباشرة. */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/** قائمة مرتجعات البيع: قيود RETURN ذات invoiceId بلا supplierId (تمييزها عن مرتجعات الشراء). */
export async function listSalesReturns(input: ListSalesReturnsInput = {}) {
  const { getDb } = await import("../db");
  const db = getDb();
  if (!db) return { rows: [], total: 0 };
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const offset = input.offset ?? 0;
  const where = [
    eq(accountingEntries.entryType, "RETURN"),
    // مرتجع البيع: مرتبط بفاتورة ولا مورد له — عكس مرتجع الشراء (supplierId NOT NULL).
    isNull(accountingEntries.supplierId),
    isNotNull(accountingEntries.invoiceId),
  ];
  if (input.customerId) where.push(eq(accountingEntries.customerId, input.customerId));
  if (input.branchId) where.push(eq(accountingEntries.branchId, input.branchId));
  if (input.invoiceId) where.push(eq(accountingEntries.invoiceId, input.invoiceId));
  // entryDate عمود DATE ⇒ نقارن بمنتصف ليل UTC (timezone:"Z") ليطابق ما يُخزَّن فعلياً.
  // localDayStart يُعيد منتصف ليل محلي (+03:00) فيستثني يوم to كاملاً في بيئات غير UTC.
  if (input.from) where.push(gte(accountingEntries.entryDate, new Date(input.from + "T00:00:00.000Z")));
  if (input.to) where.push(lte(accountingEntries.entryDate, new Date(input.to + "T00:00:00.000Z")));

  const rows = await db
    .select({
      id: accountingEntries.id,
      entryDate: accountingEntries.entryDate,
      branchId: accountingEntries.branchId,
      invoiceId: accountingEntries.invoiceId,
      invoiceNumber: invoices.invoiceNumber,
      customerId: accountingEntries.customerId,
      customerName: customers.name,
      amount: accountingEntries.amount,
      notes: accountingEntries.notes,
      createdAt: accountingEntries.createdAt,
    })
    .from(accountingEntries)
    .leftJoin(invoices, eq(accountingEntries.invoiceId, invoices.id))
    .leftJoin(customers, eq(accountingEntries.customerId, customers.id))
    .where(and(...where))
    .orderBy(sql`${accountingEntries.id} DESC`)
    .limit(limit)
    .offset(offset);

  const totalRow = await db
    .select({ c: sql<number>`COUNT(*)` })
    .from(accountingEntries)
    .where(and(...where));

  return { rows, total: Number(totalRow[0]?.c ?? 0) };
}
