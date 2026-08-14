// إلغاء فاتورة بيع كاملاً — قرار المالك ١٢/٨/٢٦.
//
// **قاعدة الإلغاء الحاكمة:** «الفاتورة كأنّها لم تكن»:
//   ١) عكسٌ كامل: revenue/cost/tax يُعكَسان في الدفتر بقيد RETURN سالبٍ يزنُ ما تبقى غيرَ مُرتجَع.
//   ٢) إرجاعٌ كامل للبضاعة: applyMovement RETURN بالكميّة الأساسية المتبقّية من كل بند (بكجات
//      عبر لقطة `invoiceItemBundleComponents` كما في returnService — لا وصفة حيّة).
//   ٣) استرداد بجهةٍ مُصرَّحة: سند صرف OUT بمبلغ paidAmount المتبقّي، بطريقةٍ مُدخَلة (CASH/CARD/...)
//      — «لا دينار بلا مسار/سند/قيد» (§٥، مبدأ المالك). النقد يمرّ shiftIdForCashTx (DRAWER
//      إن للمشغّل وردية مفتوحة، وإلّا TREASURY للأدوار الإدارية).
//   ٤) تصفير ذمّة العميل عن هذه الفاتورة، ووسمها CANCELLED بلقطة تدقيقٍ (cancelledBy + الاسم + الوقت).
//
// **حراس:**
//   - managerProcedure على الراوتر (SOD مع بائع الفاتورة).
//   - ملكية الفرع هنا (mirror returnService) — admin يعبُر.
//   - فترة مفتوحة (postEntry يفرضها بـassertPeriodOpen على كل قيد جديد).
//   - CANCELLED / RETURNED مُسبقاً ⇒ رفض صريح.
//   - WORKORDER: مسار إلغاء مخصّص (المواد استُهلكت لحظة بدء الأمر، لا تعود بإرجاع فاتورة).
//   - كروت رقميّة: يمرّ بمسار `digitalCards.reversal` لا هذا الإلغاء العام.
//
// **لماذا مسار مستقلّ عن returnService؟** returnSale يُرجع بنوداً محدّدة بكميّات محدّدة مع خيار
// `restock` (تالف vs بضاعة). cancelSale يعني: كل البند المتبقّي، كل المخزون يعود، حالة CANCELLED
// (لا RETURNED). دلالتان مختلفتان ⇒ خدمتان مستقلّتان. المنطق المشترك (لقطة بكج، عكس أمانة،
// اشتقاق remaining من قيود RETURN السابقة، تقريب نقديّ IQD) مطابقٌ في الحسابات وموثَّق بالمرجع.

import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  accountingEntries,
  digitalSaleDetails,
  installmentPlans,
  invoiceItemBundleComponents,
  invoiceItems,
  invoices,
  onlineOrders,
  productVariants,
  products,
  receipts,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { applyMovement } from "../inventoryService";
import { classifyVariants } from "../bundleService";
import { adjustCustomerBalance, adjustSupplierBalance, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { assertPeriodOpen } from "../periodLockService";
import { openShiftIdTx, shiftIdForCashTx } from "../shiftService";
import { assertCashOutAvailable } from "../cash/cashAvailability";
import { withTx, type Actor } from "../tx";
import { userNameSnapshot } from "../userSnapshot";

// ملاحظة: EXCHANGE ممنوع (مسار الصيرفة له خدمة مخصّصة كما في voucherService)، وWALLET/CHECK/
// TRANSFER تُمرَّر بلا shift-guard إن غاب — النقد وحده يستوجب shiftIdForCashTx.
export type CancelRefundMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";

export interface CancelSaleInput {
  invoiceId: number;
  /**
   * جهة الاسترداد الإلزامية — طريقة الدفع للسند الصادر بمبلغ الاسترداد.
   * النقد يمرّ shiftIdForCashTx فيُعيَّن الدلو تلقائياً (DRAWER للمشغّل ذي الوردية، TREASURY للأدمن/مدير بلا وردية).
   */
  refundPaymentMethod: CancelRefundMethod;
  /** سبب الإلغاء — يُخزَّن على قيد RETURN.notes للتدقيق. */
  reason?: string | null;
  /** idempotency: نفس المفتاح ⇒ إلغاءٌ واحد (لا استرداد/عكس مزدوج عند النقر المزدوج/إعادة الشبكة). */
  clientRequestId?: string | null;
}

export interface CancelSaleResult {
  invoiceId: number;
  invoiceNumber: string;
  cancelledAt: Date;
  /** المبلغ المسترَدّ فعلاً (قد يكون صفراً لفاتورةٍ غير مدفوعة). */
  refundAmount: string;
  /** رقم سند الصرف الصادر (null إن لا استرداد نقديّ لأن paidAmount=0). */
  refundVoucherNumber: string | null;
  /** true عند إعادة تشغيل idempotency لنفس المفتاح. */
  idempotentReplay?: true;
}

export async function cancelSale(input: CancelSaleInput, actor: Actor): Promise<CancelSaleResult> {
  return withTx(async (tx) => {
    // ═══ Idempotency: تكرار المفتاح ⇒ إرجاع نتيجة الإلغاء الأول (لا استرداد/عكس مزدوج) ═══
    // Codex P2 (١٢/٨): نُعيد بناء تفاصيل الاسترداد الحقيقية من الإيصال الذي كُتب — لا صفراً وهمياً.
    // كان الـreplay يُشعِر العميل «إلغاء بلا استرداد» في حين أن العملية الأولى قد سدّدت مبلغاً وأصدرت
    // إيصال صرف؛ فرقٌ بين التقرير والوقائع يخلّف انطباعاً بسرقة أو ازدواج فحص.
    if (input.clientRequestId?.trim()) {
      const existingRefId = await findIdempotentRefId(tx, "sale.cancel", input.clientRequestId);
      if (existingRefId != null) {
        if (Number(existingRefId) !== Number(input.invoiceId)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح مستعمَل لإلغاءٍ على فاتورة مختلفة",
          });
        }
        const rInv = (await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1))[0];
        if (!rInv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
        // ابحث عن إيصال الصرف الذي أُنشئ لهذه الفاتورة (الأحدث) بعد لحظة الإلغاء — يمثّل الاسترداد الفعلي.
        // إن غاب (لم يُدفع أصلاً) ⇒ صفر واستعمال null. لا نستعمل voucherNumber لأننا لا نضعه (P1 #1).
        const priorRefund = (
          await tx
            .select({ amount: receipts.amount, id: receipts.id })
            .from(receipts)
            .where(
              and(
                eq(receipts.invoiceId, input.invoiceId),
                eq(receipts.direction, "OUT"),
                eq(receipts.status, "COMPLETED"),
              ),
            )
            .orderBy(sql`${receipts.id} DESC`)
            .limit(1)
        )[0];
        return {
          invoiceId: input.invoiceId,
          invoiceNumber: rInv.invoiceNumber,
          cancelledAt: rInv.cancelledAt ?? new Date(),
          refundAmount: priorRefund ? money(priorRefund.amount).toFixed(2) : "0.00",
          refundVoucherNumber: null, // انظر P1 #1: لا نضع voucherNumber على إيصال الاسترداد.
          idempotentReplay: true,
        };
      }
    }

    // ═══ ١) قراءة الفاتورة تحت FOR UPDATE + الحراس ═══
    const invRows = await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).for("update").limit(1);
    const inv = invRows[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });

    if (inv.status === "CANCELLED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الفاتورة ملغاة مسبقاً" });
    }
    if (inv.status === "RETURNED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "الفاتورة مُرتجَعة بالكامل — لا حاجة للإلغاء (المخزون والذمة مُصفَّران)",
      });
    }
    // Codex P1 (١٢/٨) — حارس الفترة على تاريخ الفاتورة الأصليّ: فاتورة داخل شهرٍ مُقفَلٍ لا تُلغى بيومٍ لاحق
    // مفتوح (assertPeriodOpen على new Date() لا يمنعه) لأن الحالة CANCELLED رجعياً تحذفها من تقارير
    // شهر الإصدار (monthlyClosePack يفلتر CANCELLED) فتتغيّر أرقام شهرٍ مُغلَق ماليّاً بلا فتح صريح.
    await assertPeriodOpen(tx, inv.invoiceDate);
    // ملكية الفرع: مدير فرع لا يُلغي فاتورة فرع آخر (تُخرج نقداً من صندوقه/خزينته لفاتورة لا تخصّه).
    if (actor.role !== "admin" && Number(inv.branchId) !== Number(actor.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الفاتورة لا تخصّ فرعك" });
    }
    // Codex P1 (١٢/٨) — فصل المهام Maker/Checker: مُصدِر الفاتورة لا يُلغيها بنفسه (isOwner يعبُر لأنه
    // السلطة النهائية للتصحيح الإداري؛ admin كذلك بسلطته المتحيّزة الموثّقة عبر أثر تدقيقٍ منفصل).
    // كان الراوتر يمرّر مديراً باعه ثم ألغاه = فتحُ بابٍ لتنفيذ+إلغاء بيدٍ واحدة (فقد الرقابة الازدواجية).
    if (actor.role !== "admin" && !actor.isOwner && Number(actor.userId) === Number(inv.createdBy)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "لا يجوز إلغاء فاتورةٍ أصدرتها بنفسك — يلزم مدير آخر (فصل المهام)",
      });
    }
    // Codex P1 (١٢/٨) — خطة الأقساط ACTIVE مرتبطة بالفاتورة تبقى صالحة للتحصيل بعد الإلغاء
    // (installmentService.payLine يُنشئ سنداً بـinvoiceId=null بقصد فيتّسق مع فواتير ملغاة سابقاً)
    // فيستمرّ التحصيل على التزامٍ سبق إلغاؤه. الحلّ: أرفض حتى تُلغى الخطة يدوياً (قرار محاسبيّ خارج نطاق هذا).
    if (inv.customerId) {
      const activePlan = (
        await tx
          .select({ id: installmentPlans.id })
          .from(installmentPlans)
          .where(and(eq(installmentPlans.invoiceId, input.invoiceId), eq(installmentPlans.status, "ACTIVE")))
          .limit(1)
      )[0];
      if (activePlan) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "الفاتورة مرتبطة بخطة أقساطٍ نشطة — ألغِ الخطة أولاً ثم أعِد المحاولة",
        });
      }
    }
    // فاتورة أمر شغل: المواد استُهلكت لحظة إنشاء أمر الشغل، وإعادتها للمخزون تخلق مخزوناً وهمياً
    // لمنتج مُخصَّص لا يُباع من الرفّ. مسار إلغاء أمر الشغل يعالج ذلك بشكل صحيح.
    if (inv.sourceType === "WORKORDER") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا تُلغى فواتير أوامر الشغل من هنا — استعمل مسار إلغاء أمر الشغل نفسه",
      });
    }
    // كروت رقميّة: الكرت صدر من جهاز المزوّد وقد يكون استُهلك ⇒ إلغاء الفاتورة لا يستعيده.
    // المسار الوحيد الآمن: `digitalCards.reversal` بقرار المدير (مثل حظر المرتجع في returnService).
    const digitalRows = await tx
      .select({ id: digitalSaleDetails.invoiceItemId })
      .from(digitalSaleDetails)
      .where(eq(digitalSaleDetails.invoiceId, input.invoiceId));
    if (digitalRows.length) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "الفاتورة تحوي كروتاً رقميّة — استعمل «عكس بيع الكروت» في مسار الكروت الرقمية لا الإلغاء العام",
      });
    }

    // ═══ ٢) قراءة البنود واحتساب الكميات المتبقّية غير المُرتجَعة ═══
    const items = await tx.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, input.invoiceId));
    if (!items.length) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الفاتورة بلا بنود — تعذّر الإلغاء" });
    }

    interface WorkLine {
      item: (typeof items)[number];
      remainingBase: number;
    }
    const workLines: WorkLine[] = items
      .map((item) => ({ item, remainingBase: (item.baseQuantity ?? 0) - (item.returnedBaseQuantity ?? 0) }))
      .filter((w) => w.remainingBase > 0);

    // ═══ ٣) قيم البيع الأصلية + رصيد قيود RETURN السابقة (جزئي مُرتجَع سابقاً) ═══
    // revenue الأصلي = subtotal − discount + deliveryFee (مطابقٌ لـ sale/create.ts خطوة 11).
    const subtotal = money(inv.subtotal);
    const discountAmount = money(inv.discountAmount);
    const taxAmount = money(inv.taxAmount);
    const deliveryFee = money(inv.deliveryFee ?? "0");
    const saleRevenue = subtotal.minus(discountAmount).plus(deliveryFee);
    // Codex P2 (١٢/٨) — تقريب IQD: `inv.total` يحمل الإجمالي المُقرَّب فقط، بينما قيد SALE الأصلي يحمل
    // الإجمالي الخام (subtotal + tax) وقيد ADJUST يحمل فارق التقريب. لو استعملنا `inv.total` كأساس
    // للأمانة على `amount` ثم عكسنا قيد ADJUST المنفصل يصير Σ(amount) = فارق التقريب لا صفراً.
    // الحلّ: نقرأ قيد SALE فعلياً (amount الخام قبل التقريب) — يطابق ما تفعله returnService.fullyReturned.
    const saleEntry = (
      await tx
        .select({ amount: accountingEntries.amount })
        .from(accountingEntries)
        .where(and(eq(accountingEntries.invoiceId, input.invoiceId), eq(accountingEntries.entryType, "SALE")))
        .limit(1)
    )[0];
    const saleAmount = saleEntry ? money(saleEntry.amount) : money(inv.total);

    // قيود RETURN مُخزَّنة بقيم سالبة ⇒ عكسها بـ.neg() يعطي التراكم الموجب.
    const priorRet = (
      await tx
        .select({
          rev: sql<string>`COALESCE(SUM(${accountingEntries.revenue}), 0)`,
          tax: sql<string>`COALESCE(SUM(${accountingEntries.taxAmount}), 0)`,
          amt: sql<string>`COALESCE(SUM(${accountingEntries.amount}), 0)`,
        })
        .from(accountingEntries)
        .where(and(eq(accountingEntries.invoiceId, input.invoiceId), eq(accountingEntries.entryType, "RETURN")))
    )[0];
    const priorRevenue = money(priorRet?.rev ?? "0").neg();
    const priorTax = money(priorRet?.tax ?? "0").neg();
    const priorAmount = money(priorRet?.amt ?? "0").neg();

    // ما تبقّى للعكس (نمط "fullyReturned" في returnService — لا نستعمل الحساب النسبي لأننا نلغي الكلّ).
    const remainingRevenue = round2(saleRevenue.minus(priorRevenue));
    const remainingTax = round2(taxAmount.minus(priorTax));
    const remainingAmount = round2(saleAmount.minus(priorAmount));

    // ═══ ٤) لقطة مكوّنات البكج (نفس نمط returnService) + تجميع حركات المخزون + تكلفة الإرجاع ═══
    // نعتمد على invoiceItemBundleComponents كلقطةٍ محفوظة لحظة البيع — لا الوصفة الحيّة.
    const variantIds = Array.from(new Set(workLines.map((w) => Number(w.item.variantId))));
    const kindByVariant = variantIds.length
      ? await classifyVariants(tx, variantIds)
      : new Map<number, "STOCKED" | "BUNDLE" | "SERVICE">();
    const bundleItemIds = workLines
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

    interface StockOp {
      variantId: number;
      baseQuantity: number;
    }
    const stockOps: StockOp[] = [];
    // تكلفة العكس تُحسب مقصورةً على ما نُعيده للمخزون فعلاً (بنود لم تُرجَع سابقاً كتالف).
    // إن كان مرتجعٌ سابق بـrestock=false (تالف)، تكلفته لم تُعكَس آنذاك (تبقى خسارةً على المكتبة)
    // — و«remainingBase» يُقصيها من workLines ⇒ لا نعكس تكلفتها هنا. يبقى صافي الأثر: خسارةٌ فعليّة
    // على المكتبة بمقدار كلفة التالف. النمط مطابقٌ لـreturnService.returnedCost.
    let restockedCost = new Decimal(0);
    for (const w of workLines) {
      const kind = kindByVariant.get(Number(w.item.variantId)) ?? "STOCKED";
      if (kind === "BUNDLE") {
        const def = snapshotByItem.get(Number(w.item.id)) ?? [];
        if (!def.length) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `البكج (بند ${Number(w.item.id)}) بلا لقطة مكوّنات محفوظة — لا يمكن إعادة تخزينه آلياً`,
          });
        }
        for (const c of def) {
          stockOps.push({ variantId: c.componentVariantId, baseQuantity: c.componentBaseQuantity * w.remainingBase });
        }
      } else {
        // STOCKED / SERVICE — applyMovement يعرف كيف يعامل الخدمة (لا branchStock لها ⇒ لا حركة).
        stockOps.push({ variantId: Number(w.item.variantId), baseQuantity: w.remainingBase });
      }
      restockedCost = restockedCost.plus(round2(money(w.item.unitCost).times(w.remainingBase)));
      // Codex P2 (١٢/٨): لا نطمس returnedRestockedBaseQuantity — نضيف إليها المُعاد الآن فقط
      // (كان الاستبدال بـbaseQuantity يزعم أن كل الوحدات عادت للرفّ حتى تلك المُرتجَعة سابقاً كتالف
      // ⇒ يخالف حركة المخزون والدفتر: إجمالي الحركات RETURN إعادةً = المُعاد الفعلي، والتقارير المستنِدة
      // على المُعاد صفر تُبالغ). بينما returnedBaseQuantity يمثّل «الكميّة الملغاة من البند» فيصير كلها.
      await tx
        .update(invoiceItems)
        .set({
          returnedBaseQuantity: w.item.baseQuantity,
          returnedRestockedBaseQuantity: (w.item.returnedRestockedBaseQuantity ?? 0) + w.remainingBase,
        })
        .where(eq(invoiceItems.id, Number(w.item.id)));
    }
    restockedCost = round2(restockedCost);

    // تطبيق حركات المخزون بترتيب variantId التصاعدي — يحافظ على ترتيب القفل الحتميّ (منع deadlock).
    const aggregated = new Map<number, number>();
    for (const op of stockOps) aggregated.set(op.variantId, (aggregated.get(op.variantId) ?? 0) + op.baseQuantity);
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
        notes: "إلغاء فاتورة بيع — إرجاع كامل البضاعة للمخزون",
      });
    }

    // ═══ ٥) عكس التزام المودِع لبضاعة الأمانة (mirror returnService §٥ حاصرة ١) ═══
    {
      const rvids = variantIds;
      const consignByVariant = new Map<number, number>();
      if (rvids.length) {
        const crows = await tx
          .select({ vid: productVariants.id, isConsign: products.isConsignment, cId: products.consignorId })
          .from(productVariants)
          .innerJoin(products, eq(productVariants.productId, products.id))
          .where(inArray(productVariants.id, rvids));
        for (const r of crows) if (r.isConsign && r.cId != null) consignByVariant.set(Number(r.vid), Number(r.cId));
      }
      if (consignByVariant.size) {
        const byConsignor = new Map<number, Decimal>();
        for (const w of workLines) {
          const cId = consignByVariant.get(Number(w.item.variantId));
          if (cId == null) continue;
          const share = round2(money(w.item.unitCost).times(w.remainingBase));
          byConsignor.set(cId, (byConsignor.get(cId) ?? new Decimal(0)).plus(share));
        }
        for (const cId of Array.from(byConsignor.keys()).sort((a, b) => a - b)) {
          const share = byConsignor.get(cId)!;
          if (share.lte(0)) continue;
          // عكس بنفس invoiceId ⇒ يدخل فلتر خصم العمولة (استرداد حصّة البائع الأصلي).
          await postEntry(tx, {
            entryType: "PURCHASE",
            supplierId: cId,
            invoiceId: input.invoiceId,
            branchId: Number(inv.branchId),
            amount: share.neg(),
            notes: "عكس استحقاق أمانة — إلغاء فاتورة",
          });
          await adjustSupplierBalance(tx, cId, share.neg());
        }
      }
    }

    // ═══ ٦) قيد RETURN معكوس يزنُ ما تبقّى (assertPeriodOpen يفرض فتح الفترة تلقائياً) ═══
    const cancelOperatorName = await userNameSnapshot(tx, actor.userId);
    await postEntry(tx, {
      entryType: "RETURN",
      branchId: Number(inv.branchId),
      invoiceId: input.invoiceId,
      customerId: inv.customerId,
      revenue: remainingRevenue.neg(),
      cost: restockedCost.neg(),
      profit: remainingRevenue.minus(restockedCost).neg(),
      taxAmount: remainingTax.neg(),
      amount: remainingAmount.neg(),
      createdBy: actor.userId,
      createdByNameSnapshot: cancelOperatorName,
      notes: input.reason ? `إلغاء فاتورة — ${input.reason.slice(0, 200)}` : "إلغاء فاتورة",
    });

    // ═══ ٧) عكس تقريب النقد العراقي إن لم يُعكَس سابقاً بمرتجع كامل ═══
    // returnService.fullyReturned يعكس التقريب بـdedupeKey `ADJUST:IQD:RETURN:<id>`؛ لن يكون موجوداً
    // لفاتورةٍ نُلغيها الآن (guard أعلاه يرفض RETURNED). لكن دفاعياً نفحص وننشئ بمفتاحٍ مستقلّ.
    const cashRoundOriginal = money(inv.cashRoundingAdjustment ?? "0");
    if (!cashRoundOriginal.isZero()) {
      const priorAdjustRevRow = (
        await tx
          .select({ n: sql<number>`COUNT(*)` })
          .from(accountingEntries)
          .where(
            and(
              eq(accountingEntries.invoiceId, input.invoiceId),
              eq(accountingEntries.entryType, "ADJUST"),
              eq(accountingEntries.dedupeKey, `ADJUST:IQD:RETURN:${input.invoiceId}`),
            ),
          )
      )[0];
      if (!Number(priorAdjustRevRow?.n ?? 0)) {
        await postEntry(tx, {
          entryType: "ADJUST",
          dedupeKey: `ADJUST:IQD:CANCEL:${input.invoiceId}`,
          branchId: Number(inv.branchId),
          invoiceId: input.invoiceId,
          customerId: inv.customerId,
          revenue: cashRoundOriginal.neg(),
          profit: cashRoundOriginal.neg(),
          amount: cashRoundOriginal.neg(),
          notes: "عكس تقريب نقدي IQD — إلغاء فاتورة",
        });
      }
    }

    // ═══ ٨) الاسترداد: إيصال صرف OUT بجهة صرفٍ مُصرَّحة (بلا voucherNumber) ═══
    // Codex P1 (١٢/٨): جمع كل المقبوضات المرتبطة بالفاتورة (IN) − ما استُرِدّ (OUT) كأساسٍ للاسترداد،
    // بدل الاعتماد على inv.paidAmount وحده. voucher/create.ts يخفض ذمّة العميل عند سند قبضٍ مرتبط
    // بفاتورة لكنه لا يرفع invoices.paidAmount ⇒ إن اعتمدنا paidAmount وحده يبقى قسمٌ من نقد العميل
    // غير مُسترَدٍّ فتنقلب ذمّته لدائن (فائض ائتمان). النموذج الصحيح: كل حركة receipt IN/OUT مرتبطة
    // بالفاتورة تدخل الحساب، مطابقةً لما تراه voucher-linked flows ونماذج التحصيل الفعلية.
    const receiptSums = (
      await tx
        .select({
          inSum: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' THEN ${receipts.amount} ELSE 0 END), 0)`,
          outSum: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'OUT' THEN ${receipts.amount} ELSE 0 END), 0)`,
        })
        .from(receipts)
        .where(and(eq(receipts.invoiceId, input.invoiceId), eq(receipts.status, "COMPLETED")))
    )[0];
    const totalIn = money(receiptSums?.inSum ?? "0");
    const totalOutPrior = money(receiptSums?.outSum ?? "0");
    const refundable = totalIn.minus(totalOutPrior);
    let refundAmount = new Decimal(0);
    if (refundable.gt(0)) {
      // تحديد الوردية والدلو: النقد يمرّ shiftIdForCashTx (يضمن ورديةً للكاشير ويعطي TREASURY للمدير/الأدمن
      // بلا وردية). غير النقد لا يمسّ صندوقاً ⇒ shiftId اختياري (نأخذ ما هو مفتوح إن وُجد للربط بالتسوية).
      let shiftId: number | null = null;
      let cashBucket: "DRAWER" | "TREASURY" | null = null;
      if (input.refundPaymentMethod === "CASH") {
        const g = await shiftIdForCashTx(tx, actor, Number(inv.branchId), "استرداد إلغاء فاتورة");
        shiftId = g.shiftId;
        cashBucket = g.cashBucket;
        await assertCashOutAvailable(tx, {
          branchId: Number(inv.branchId),
          cashBucket,
          shiftId,
          amount: refundable,
          operation: "استرداد إلغاء الفاتورة",
        });
      } else {
        shiftId = await openShiftIdTx(tx, actor.userId, Number(inv.branchId));
      }

      // Codex P1 #1 + P2 #4 (١٢/٨): **لا voucherNumber** على إيصال استرداد الإلغاء — تسميته سنداً في
      // vouchers.list يفتح مسار voucher/cancel.ts العام (يعكس النقد ويعدّل رصيد العميل تاركاً حالة
      // الفاتورة CANCELLED وpaidAmount=0 ⇒ ازدواج عكسٍ ينقلب ائتماناً وهميّاً)، كما يُصنَّف تحت
      // «expensesCash» في تقرير إغلاق اليوم بدل «returnsCash» (الشرط: voucherNumber IS NULL).
      // نمط returnService.receipt هو المرجعية (بلا voucherNumber، مصنَّف كمرتجع، غير قابل للـcancel العام).
      const rRes = await tx.insert(receipts).values({
        invoiceId: input.invoiceId,
        branchId: Number(inv.branchId),
        shiftId,
        cashBucket,
        direction: "OUT",
        amount: toDbMoney(refundable),
        paymentMethod: input.refundPaymentMethod,
        status: "COMPLETED",
        partyType: inv.customerId ? "CUSTOMER" : "OTHER",
        partyId: inv.customerId ?? null,
        description: `استرداد إلغاء فاتورة ${inv.invoiceNumber}`,
        approvalStatus: "APPROVED",
        createdBy: actor.userId,
      });
      const receiptId = extractInsertId(rRes);
      await postEntry(tx, {
        entryType: "PAYMENT_OUT",
        branchId: Number(inv.branchId),
        invoiceId: input.invoiceId,
        receiptId,
        customerId: inv.customerId,
        amount: refundable,
      });
      refundAmount = refundable;
    }

    // ═══ ٩) تصفير ذمّة العميل عن هذه الفاتورة ═══
    // مساهمة الفاتورة في AR قبل الإلغاء: (remainingAmount − nonInvoicePaidPortion) — لكن نتّبع النمط
    // المُثبَت في returnService: نُسقط بمقدار (remainingAmount − refundAmount). refundAmount الآن يشمل
    // كامل ما قُبض على الفاتورة (voucher-linked receipts + الكاشير) ⇒ AR يعود لصفر بلا فائض ائتماني.
    if (inv.customerId) {
      const arDrop = remainingAmount.minus(refundAmount);
      await adjustCustomerBalance(tx, Number(inv.customerId), arDrop.neg());
    }

    // Codex P2 (١٢/٨) — مزامنة الطلب الإلكتروني: فاتورة ONLINE مرتبطة بطلب في `onlineOrders`؛ الإلغاء
    // بلا مزامنة يترك الطلب SHIPPED/DELIVERED بينما المخزون رجع والقيد عُكس ⇒ طوابير المندوبين وتحليلات
    // المتجر تُظهر طلباً حيّاً مقابل فاتورةٍ ملغاة، وتأكيد المندوب اللاحق يرفض «الفاتورة ملغاة» فيبقى
    // الطلب عالقاً حتى تدخّلٍ يدوي. نُحدّث للحالة CANCELLED بنفس المعاملة (ذرّياً).
    if (inv.sourceType === "ONLINE") {
      await tx
        .update(onlineOrders)
        .set({
          status: "CANCELLED",
          cancelReason: input.reason?.trim() || "إلغاء فاتورة",
        })
        .where(and(eq(onlineOrders.invoiceId, input.invoiceId), sql`${onlineOrders.status} != 'CANCELLED'`));
    }

    // ═══ ١٠) وسم CANCELLED مع لقطة تدقيق ═══
    const newPaid = money(inv.paidAmount).minus(refundAmount);
    const newReturnedTotal = money(inv.returnedTotal ?? "0").plus(remainingAmount);
    const cancelledAt = new Date();
    await tx
      .update(invoices)
      .set({
        status: "CANCELLED",
        paidAmount: toDbMoney(newPaid.lt(0) ? new Decimal(0) : newPaid),
        returnedTotal: toDbMoney(newReturnedTotal),
        cancelledBy: actor.userId,
        cancelledByNameSnapshot: cancelOperatorName,
        cancelledAt,
      })
      .where(eq(invoices.id, input.invoiceId));

    if (input.clientRequestId?.trim()) {
      // recordIdempotencyKey ذرّي: INSERT وحيد يرمي ER_DUP_ENTRY عند ازدواج (سباقٌ نظيف).
      await recordIdempotencyKey(tx, "sale.cancel", input.clientRequestId, input.invoiceId);
    }

    return {
      invoiceId: input.invoiceId,
      invoiceNumber: inv.invoiceNumber,
      cancelledAt,
      refundAmount: refundAmount.toFixed(2),
      refundVoucherNumber: null,
    };
  });
}
