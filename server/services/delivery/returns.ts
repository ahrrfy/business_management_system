// إرجاع إرسالية (البضاعة عادت): عكس SALE + إعادة مخزون + عكس العهدة + رد العربون.
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { deliveryConsignments, deliveryParties, invoiceItemBundleComponents, invoiceItems, invoices, productVariants, products, receipts } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { applyMovement } from "../inventoryService";
import { adjustCustomerBalance, adjustDeliveryBalance, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { computeExpectedCash, resolveBranchCashShiftTx } from "../shiftService";
import { withTx } from "../tx";
import type { DeliveryTxActor } from "./types";

/** إرجاع إرسالية (البضاعة عادت): عكس SALE + إعادة مخزون + عكس العهدة + رد العربون. مقيَّد بـDISPATCHED (collected==0). */
export async function returnConsignment(
  consignmentId: number,
  actor: DeliveryTxActor & { clientRequestId?: string | null; refundShiftId?: number | null },
) {
  return withTx(async (tx) => {
    if (actor.clientRequestId) {
      const existingId = await findIdempotentRefId(tx, "delivery.return", actor.clientRequestId);
      if (existingId != null) return { consignmentId, reversed: true as const, idempotentReplay: true as const };
    }
    const cn = (await tx.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, consignmentId)).for("update").limit(1))[0];
    if (!cn) throw new TRPCError({ code: "NOT_FOUND", message: "الإرسالية غير موجودة" });
    if (cn.status !== "DISPATCHED") throw new TRPCError({ code: "BAD_REQUEST", message: "يُرجَع فقط إرسالٌ لم يُحصَّل منه شيء (للجزئي استعمل المرتجعات)" });
    const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, Number(cn.partyId))).for("update").limit(1))[0];
    const inv = (await tx.select().from(invoices).where(eq(invoices.id, Number(cn.invoiceId))).for("update").limit(1))[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "فاتورة الإرسالية غير موجودة" });
    // تدقيق ٦/٨ (ث٤): حارسٌ متبادل مع شاشة المرتجعات — فاتورةٌ أُرجع منها شيءٌ سلفاً يقيّد هنا
    // RETURN بكامل الإجمالي ويُعيد **كل** البنود للمخزون ⇒ إيرادٌ معكوسٌ مرّتين ومخزونٌ مضاعف.
    if (money(inv.returnedTotal ?? "0").gt(0)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `الفاتورة أُرجع منها سلفاً (${money(inv.returnedTotal ?? "0").toFixed(2)}) — أكمل الإرجاع من شاشة المرتجعات لا من هنا (وإلّا انعكس البيع مرّتين)`,
      });
    }

    const items = await tx.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, Number(cn.invoiceId)));
    // إعادة المخزون (حركة IN) لكل بند له صنف.
    // ملاحظة (تدقيق ٢/٧): تمييز «البند الذي خُصم مخزونه فعلاً» عن «منتج مُخصَّص لم يُخصَم» ليس
    // بمجرّد workOrderId (بند أمر شغل بـbaseVariant يُخصَم فعلاً) — يحتاج فحص «هل جرت حركة OUT
    // للصنف على هذه الفاتورة». مؤجَّل لتفادي منع إعادة تخزينٍ مشروع (أمسك CI الحارس الفجّ).
    //
    // gstack B7 (٧/٧/٢٦): بنود البكج بلا branchStock ⇒ applyMovement يرفضها. نُوسّعها إلى مكوّناتها
    // عبر لقطة `invoiceItemBundleComponents` (كنمط returnService بالضبط). ثم نطبّق الحركات مجمَّعةً.
    const variantIds = Array.from(new Set(items.map((i) => Number(i.variantId))));
    const bundleFlags = variantIds.length
      ? await tx
          .select({ id: productVariants.id, isBundle: products.isBundle })
          .from(productVariants)
          .innerJoin(products, eq(productVariants.productId, products.id))
          .where(inArray(productVariants.id, variantIds))
      : [];
    const isBundleVariant = new Map<number, boolean>(bundleFlags.map((f) => [Number(f.id), !!f.isBundle]));
    const bundleItemIds = items.filter((i) => isBundleVariant.get(Number(i.variantId))).map((i) => Number(i.id));
    const snapshotByItem = new Map<number, Array<{ componentVariantId: number; componentBaseQuantity: number }>>();
    if (bundleItemIds.length) {
      const snapRows = await tx
        .select({
          invoiceItemId: invoiceItemBundleComponents.invoiceItemId,
          componentVariantId: invoiceItemBundleComponents.componentVariantId,
          componentBaseQuantity: invoiceItemBundleComponents.componentBaseQuantity,
        })
        .from(invoiceItemBundleComponents)
        .where(inArray(invoiceItemBundleComponents.invoiceItemId, bundleItemIds));
      for (const r of snapRows) {
        const iid = Number(r.invoiceItemId);
        const list = snapshotByItem.get(iid) ?? [];
        list.push({ componentVariantId: Number(r.componentVariantId), componentBaseQuantity: Number(r.componentBaseQuantity) });
        snapshotByItem.set(iid, list);
      }
    }

    const stockOps = new Map<number, number>(); // variantId → baseQuantity مجمَّعة
    for (const it of items) {
      const itemVariantId = Number(it.variantId);
      const itemBase = Number(it.baseQuantity);
      if (isBundleVariant.get(itemVariantId)) {
        const snap = snapshotByItem.get(Number(it.id)) ?? [];
        if (!snap.length) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `بند البكج ${Number(it.id)} بلا لقطة مكوّنات — لا يمكن إرجاع الإرسالية آلياً (فاتورة قبل ٧/٧/٢٦)`,
          });
        }
        for (const c of snap) {
          const q = c.componentBaseQuantity * itemBase;
          stockOps.set(c.componentVariantId, (stockOps.get(c.componentVariantId) ?? 0) + q);
        }
      } else {
        stockOps.set(itemVariantId, (stockOps.get(itemVariantId) ?? 0) + itemBase);
      }
    }
    // تطبيق مجمَّع بترتيب variantId تصاعدي (اتّساق مع sale/create.ts + returnService).
    const sortedVids = Array.from(stockOps.keys()).sort((a, b) => a - b);
    for (const vid of sortedVids) {
      const qty = stockOps.get(vid)!;
      if (qty <= 0) continue;
      await applyMovement(tx, {
        variantId: vid, branchId: Number(cn.branchId), baseQuantity: qty,
        movementType: "IN", referenceType: "DELIVERY_RETURN", referenceId: consignmentId, createdBy: actor.userId,
      });
    }

    // عكس البيع: قيد RETURN بقيم سالبة.
    // تدقيق ٦/٨ (ث٣): الفاتورة قد تحمل عميلاً مسجَّلاً (مسار إسناد الفاتورة يُبقي customerId
    // بخلاف مسار أمر الشغل) ⇒ التعليق القديم «لا AR — customerId=NULL» صار خاطئاً: البضاعة
    // عادت للرفّ والعميل يبقى مديناً بها للأبد. القيد يُختَم بالعميل، والذمّة تُخصَم أدناه.
    const total = money(inv.total);
    const costTotal = money(inv.costTotal);
    const invCustomerId = inv.customerId != null ? Number(inv.customerId) : null;
    await postEntry(tx, {
      entryType: "RETURN", branchId: Number(cn.branchId), invoiceId: Number(cn.invoiceId),
      customerId: invCustomerId,
      revenue: total.neg(), cost: costTotal.neg(), profit: round2(total.minus(costTotal)).neg(), amount: total.neg(),
      notes: `إرجاع إرسالية ${cn.consignmentNumber}`,
    });
    await tx.update(invoices).set({ status: "RETURNED", returnedTotal: toDbMoney(total) }).where(eq(invoices.id, Number(cn.invoiceId)));

    // عكس العهدة بالـCOD القائم (collected==0 ⇒ = codAmount).
    const outstanding = round2(money(cn.codAmount).minus(money(cn.collectedAmount)));
    if (outstanding.gt(0)) {
      await adjustDeliveryBalance(tx, Number(cn.partyId), outstanding.neg());
      await postEntry(tx, {
        entryType: "DELIVERY_REMIT", dedupeKey: `DELIVERY_RETURN:${consignmentId}`,
        branchId: Number(cn.branchId), invoiceId: Number(cn.invoiceId), deliveryPartyId: Number(cn.partyId),
        amount: outstanding, notes: `عكس عهدة — إرجاع ${cn.consignmentNumber}`,
      });
    }

    // رد العربون نقداً إن وُجد (paidAmount على فاتورة COD = العربون).
    const deposit = round2(money(inv.paidAmount));
    if (deposit.gt(0)) {
      // الدرج مورد فرعٍ لا مستخدم — الإرجاع صلاحية مدير (managerProcedure، «إجراء تصحيحيّ») قد يختلف
      // عن الكاشير صاحب درج الاستقبال الذي قبض العربون فعلاً. shiftIdForCashTx القديمة كانت تنسب
      // الاسترداد لوردية الفاعل نفسه (إن وُجدت) أو تُسقطه في TREASURY بمعزلٍ عن أيّ Z-report — كلاهما
      // قد يُخفي خروج النقد الفعليّ عن صاحب الدرج الحقيقيّ. مرآة إصلاح returnService.ts (بلاغ مالك
      // ٢/٨/٢٦): resolveBranchCashShiftTx يبحث في ورديات الفرع المفتوحة كلّها، ويتحقّق أنّ الدرج
      // المستهدَف يحمل هذا المبلغ الآن فعلياً (نمط cashDropService — لا عجز أثناء العمل).
      const resolved = await resolveBranchCashShiftTx(tx, Number(cn.branchId), actor.refundShiftId ?? null);
      const currentDrawerCash = await computeExpectedCash(tx, resolved.shiftId, resolved.openingBalance);
      if (deposit.gt(currentDrawerCash)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `المبلغ يتجاوز النقد المتوفّر حالياً في هذا الدرج (المتاح ${currentDrawerCash.toFixed(2)} < المطلوب ${deposit.toFixed(2)}) — راجع الدرج أو اختر درجاً آخر.`,
        });
      }
      const rOut = await tx.insert(receipts).values({
        branchId: Number(cn.branchId), shiftId: resolved.shiftId, direction: "OUT", amount: toDbMoney(deposit),
        paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED", invoiceId: Number(cn.invoiceId),
        referenceNumber: `RET-${cn.consignmentNumber}`, description: `رد عربون إرجاع ${cn.consignmentNumber}`, createdBy: actor.userId,
      });
      await postEntry(tx, {
        entryType: "PAYMENT_OUT", branchId: Number(cn.branchId), invoiceId: Number(cn.invoiceId),
        receiptId: extractInsertId(rOut), amount: deposit, notes: `رد عربون ${cn.consignmentNumber}`,
      });
      await tx.update(invoices).set({ paidAmount: "0.00" }).where(eq(invoices.id, Number(cn.invoiceId)));
    }

    // تدقيق ٦/٨ (ث٣) — **خصم ذمّة العميل** (طلب المالك الحرفيّ: «لكي يتم خصم الذمم منه»):
    // ما لم يُستردّ نقداً من المدفوع يبقى ديناً على العميل عن بضاعةٍ عادت للرفّ. يُخصَم هنا
    // بنفس دلالة returnService (الجزء غير المستردّ نقداً يسقط من الذمّة).
    if (invCustomerId != null) {
      const arDrop = round2(total.minus(deposit));
      if (arDrop.gt(0)) await adjustCustomerBalance(tx, invCustomerId, arDrop.neg());
    }

    // تدقيق ٦/٨ (ث٢) — **ردّ أمانة أجرة التوصيل** إن قُبضت في الاستقبال ولم تُصرف للمندوب:
    // التوصيل لم يقع، فالأمانة مالُ الزبون لا مالُ المكتبة ولا المندوب. بلا هذا الردّ تبقى
    // في الدرج بلا مالكٍ وتُرحَّل للخزينة كأنها إيراد.
    const feeHeldRow = (
      await tx
        .select({ v: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' THEN ${receipts.amount} ELSE -${receipts.amount} END), 0)` })
        .from(receipts)
        .where(and(
          eq(receipts.invoiceId, Number(cn.invoiceId)),
          eq(receipts.referenceNumber, `DLV-FEE-INV-${Number(cn.invoiceId)}`),
          eq(receipts.status, "COMPLETED"),
        ))
    )[0];
    const feeHeldNet = round2(money(feeHeldRow?.v ?? "0"));
    if (feeHeldNet.gt(0)) {
      const feeShift = await resolveBranchCashShiftTx(tx, Number(cn.branchId), actor.refundShiftId ?? null);
      const drawerNow = await computeExpectedCash(tx, feeShift.shiftId, feeShift.openingBalance);
      if (feeHeldNet.gt(drawerNow)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `ردّ أمانة أجرة التوصيل (${feeHeldNet.toFixed(2)}) يتجاوز النقد المتوفّر في هذا الدرج (${drawerNow.toFixed(2)}) — اختر درجاً آخر`,
        });
      }
      const feeOut = await tx.insert(receipts).values({
        branchId: Number(cn.branchId), shiftId: feeShift.shiftId, invoiceId: Number(cn.invoiceId),
        direction: "OUT", amount: toDbMoney(feeHeldNet), paymentMethod: "CASH", cashBucket: "DRAWER",
        status: "COMPLETED", partyType: "OTHER",
        referenceNumber: `DLV-FEE-INV-${Number(cn.invoiceId)}`,
        description: `ردّ أمانة أجرة توصيل — إرجاع ${cn.consignmentNumber}`,
        createdBy: actor.userId,
      });
      await postEntry(tx, {
        entryType: "DELIVERY_FEE_HELD",
        dedupeKey: `DELIVERY_FEE_HELD_REFUND:${consignmentId}`,
        branchId: Number(cn.branchId), invoiceId: Number(cn.invoiceId),
        receiptId: extractInsertId(feeOut),
        amount: feeHeldNet.neg(),
        notes: `ردّ أمانة أجرة توصيل — إرجاع ${cn.consignmentNumber}`,
      });
    }

    await tx.update(deliveryConsignments).set({ status: "RETURNED", settledAt: new Date() }).where(eq(deliveryConsignments.id, consignmentId));
    if (actor.clientRequestId) await recordIdempotencyKey(tx, "delivery.return", actor.clientRequestId, consignmentId);
    void party;
    return { consignmentId, reversed: true as const, invoiceId: Number(cn.invoiceId) };
  });
}
