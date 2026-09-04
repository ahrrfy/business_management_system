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
import { appErrorMessage } from "@shared/errors";
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
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { applyMovement } from "../inventoryService";
import { classifyVariants } from "../bundleService";
import { adjustCustomerBalance, adjustSupplierBalance, postEntry } from "../ledgerService";
import { createPostingIntent, creditLine, debitLine, signedPostingLines, type AccountRole, type PostingProfile } from "../accounting/postingEngine";
import { money, round2, toDbMoney } from "../money";
import { assertPeriodOpen } from "../periodLockService";
import { shiftIdForCashTx } from "../shiftService";
import {
  assertCashOutAvailable,
  assertNonPhysicalOutReceipt,
  assertTreasuryOutException,
  lockCashSourceForUpdate,
  MATERIALIZED_RECEIPT_STATUSES,
} from "../cash/cashAvailability";
import { isSurfacedRefundMethod } from "../returns/refundCaps";
import { withTx, type Actor } from "../tx";
import { recordEffect } from "../reversalEngine"; // ق٧: ربطٌ ظلّيّ لمحرّك العكس (شريحة ٠٣٢٩)
import { userNameSnapshot } from "../userSnapshot";
import { nextVoucherNumber } from "../voucher/helpers";
import { classifyGiftPosting } from "./giftPosting";
import { assertInvoiceCancellationDeliverySafeTx } from "./invoiceCancellationGuard";
import { paymentAssetRole } from "./paymentPosting";
import type { Tx } from "../../db";
import { assertLockedInvoiceControlSnapshotTx, type InvoiceControlSnapshot } from "./controlSnapshot";

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
  /** مرجع عملية الاسترداد على جهاز الدفع — تفرضه الخدمة إلزامياً لِـCARD وحدها؛ نظير ReturnSaleInput.refund.reference. */
  reference?: string | null;
  /** سبب الإلغاء — يُخزَّن على قيد RETURN.notes للتدقيق. */
  reason?: string | null;
  /** idempotency: نفس المفتاح ⇒ إلغاءٌ واحد (لا استرداد/عكس مزدوج عند النقر المزدوج/إعادة الشبكة). */
  clientRequestId?: string | null;
  /** تفويض داخلي من طلب التحكم؛ يُطابَق بعد قفل الفاتورة وقبل أول أثر. */
  controlExpectedSnapshot?: InvoiceControlSnapshot | null;
}

export interface CancelSaleResult {
  invoiceId: number;
  invoiceNumber: string;
  cancelledAt: Date;
  /** المبلغ المسترَدّ فعلاً (قد يكون صفراً لفاتورةٍ غير مدفوعة). */
  refundAmount: string;
  /** رقم طلب سند الصرف غير النقدي (null للنقد الفوري أو عند غياب مبلغ). */
  refundVoucherNumber: string | null;
  /** طلب غير نقدي بقي صفري الأثر حتى اعتماده وتنفيذه خارج هذه العملية. */
  pendingRefundAmount?: string;
  /** true عند إعادة تشغيل idempotency لنفس المفتاح. */
  idempotentReplay?: true;
}

export async function cancelSale(input: CancelSaleInput, actor: Actor): Promise<CancelSaleResult> {
  return withTx((tx) => cancelSaleInTx(tx, input, actor));
}

/** جسم الإلغاء داخل معاملة قائمة؛ تستخدمه موافقة التحكم كي يكون التنفيذ وختم الطلب ذريَّين. */
export async function cancelSaleInTx(
  tx: Tx,
  input: CancelSaleInput,
  actor: Actor,
): Promise<CancelSaleResult> {
    const requestFingerprint = input.clientRequestId?.trim() ? idempotencyHash(input) : null;
    // ═══ Idempotency: تكرار المفتاح ⇒ إرجاع نتيجة الإلغاء الأول (لا استرداد/عكس مزدوج) ═══
    // Codex P2 (١٢/٨): نُعيد بناء تفاصيل الاسترداد الحقيقية من الإيصال الذي كُتب — لا صفراً وهمياً.
    // كان الـreplay يُشعِر العميل «إلغاء بلا استرداد» في حين أن العملية الأولى قد سدّدت مبلغاً وأصدرت
    // إيصال صرف؛ فرقٌ بين التقرير والوقائع يخلّف انطباعاً بسرقة أو ازدواج فحص.
    if (input.clientRequestId?.trim()) {
      const existingRefId = await checkIdempotency(tx, "sale.cancel", input.clientRequestId, requestFingerprint);
      if (existingRefId != null) {
        if (Number(existingRefId) !== Number(input.invoiceId)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح مستعمَل لإلغاءٍ على فاتورة مختلفة",
          });
        }
        const rInv = (await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1))[0];
        if (!rInv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
        // أحدث خروج قد يكون نقداً منفذاً أو طلب سند غير نقدي ما زال معلقاً.
        const priorRefund = (
          await tx
            .select({
              amount: receipts.amount,
              id: receipts.id,
              status: receipts.status,
              approvalStatus: receipts.approvalStatus,
              voucherNumber: receipts.voucherNumber,
            })
            .from(receipts)
            .where(
              and(
                eq(receipts.invoiceId, input.invoiceId),
                eq(receipts.direction, "OUT"),
              ),
            )
            .orderBy(sql`${receipts.id} DESC`)
            .limit(1)
        )[0];
        return {
          invoiceId: input.invoiceId,
          invoiceNumber: rInv.invoiceNumber,
          cancelledAt: rInv.cancelledAt ?? new Date(),
          refundAmount: priorRefund?.status === "COMPLETED" && priorRefund.approvalStatus === "APPROVED"
            ? money(priorRefund.amount).toFixed(2)
            : "0.00",
          refundVoucherNumber: priorRefund?.voucherNumber ?? null,
          pendingRefundAmount: priorRefund?.status === "PENDING" && priorRefund.approvalStatus === "PENDING_APPROVAL"
            ? money(priorRefund.amount).toFixed(2)
            : "0.00",
          idempotentReplay: true,
        };
      }
    }

    // ترتيب الأقفال الحاكم: مصدر النقد قبل الفاتورة/مورّدي الأمانة. اعتماد سند مورد
    // نقدي يسلك source→supplier؛ تأخير المصدر هنا كان يصنع المسار المعاكس.
    const invPreview = (
      await tx.select({ branchId: invoices.branchId }).from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1)
    )[0];
    if (!invPreview) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
    if (actor.role !== "admin" && Number(invPreview.branchId) !== Number(actor.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الفاتورة لا تخصّ فرعك" });
    }
    let prelockedCashSource: Awaited<ReturnType<typeof shiftIdForCashTx>> | null = null;
    if (input.refundPaymentMethod === "CASH") {
      prelockedCashSource = await shiftIdForCashTx(
        tx,
        actor,
        Number(invPreview.branchId),
        "استرداد إلغاء فاتورة",
      );
      await lockCashSourceForUpdate(tx, {
        branchId: Number(invPreview.branchId),
        cashBucket: prelockedCashSource.cashBucket,
        shiftId: prelockedCashSource.shiftId,
      });
    }

    // بعد مصدر النقد، اقفل جهة التوصيل→الإرسالية/طلب المتجر قبل الفاتورة. الحارس لا يكتفي
    // بوسم CANCELLED: يثبت أيضاً انعدام الحيازة وCOD والتسوية المفتوحة تحت الأقفال نفسها.
    await assertInvoiceCancellationDeliverySafeTx(tx, {
      invoiceId: input.invoiceId,
      expectedBranchId: Number(invPreview.branchId),
    });

    // ═══ ١) قراءة الفاتورة تحت FOR UPDATE + الحراس ═══
    const invRows = await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).for("update").limit(1);
    const inv = invRows[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
    if (Number(inv.branchId) !== Number(invPreview.branchId)) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّر فرع الفاتورة أثناء الإلغاء؛ أعد المحاولة" });
    }
    await assertLockedInvoiceControlSnapshotTx(tx, inv, input.controlExpectedSnapshot);

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
    // المسار العام القديم لا يُستدعى من الراوتر بعد 0313. طلب التحكم يفرض SOD بلا استثناء
    // قبل بلوغ الخدمة؛ نبقي توافق الاستدعاءات الداخلية التاريخية للأدمن/المالك.
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
    let restockedGiftCost = new Decimal(0);
    let serviceRestockedCost = new Decimal(0);
    let serviceRestockedGiftCost = new Decimal(0);
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
      const lineRestockedCost = round2(money(w.item.unitCost).times(w.remainingBase));
      if (w.item.isGift) {
        restockedGiftCost = restockedGiftCost.plus(lineRestockedCost);
        if (kind === "SERVICE") serviceRestockedGiftCost = serviceRestockedGiftCost.plus(lineRestockedCost);
      } else {
        restockedCost = restockedCost.plus(lineRestockedCost);
        if (kind === "SERVICE") serviceRestockedCost = serviceRestockedCost.plus(lineRestockedCost);
      }
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
    restockedGiftCost = round2(restockedGiftCost);

    // تطبيق حركات المخزون بترتيب variantId التصاعدي — يحافظ على ترتيب القفل الحتميّ (منع deadlock).
    const aggregated = new Map<number, number>();
    for (const op of stockOps) aggregated.set(op.variantId, (aggregated.get(op.variantId) ?? 0) + op.baseQuantity);
    const sortedVariantIds = Array.from(aggregated.keys()).sort((a, b) => a - b);
    for (const vid of sortedVariantIds) {
      const qty = aggregated.get(vid)!;
      if (qty <= 0) continue;
      const mv = await applyMovement(tx, {
        variantId: vid,
        branchId: Number(inv.branchId),
        baseQuantity: qty,
        movementType: "RETURN",
        referenceType: "RETURN",
        referenceId: input.invoiceId,
        createdBy: actor.userId,
        notes: "إلغاء فاتورة بيع — إرجاع كامل البضاعة للمخزون",
      });
      // Codex #957: `applyMovement` يتخطّى المتغيّرات الخدميّة صراحةً ويُرجع
      // `{ movementId: 0 }` بلا تغييرٍ في المخزون (`inventoryService.ts` ~١٩٥). تسجيلُ
      // أثرٍ بكمّيةٍ موجبة ومرجعِ صفٍّ `null` كان يبني **أثراً وهمياً** يُطالبه العاكس لاحقاً
      // بحسمٍ من المخزون لم يحدث. الحلّ: نحترمُ سلوكَ `applyMovement` — لا حركةَ ⇒ لا أثر.
      if (!mv.movementId) continue;
      // ═══ ق٧ — ربطٌ ظلّيّ (شريحة ٠٣٢٩): سجلٌّ ماديٌّ لأثرِ إعادة البضاعة إلى المخزون
      //  عند الإلغاء. يعمل بجانب التنفيذ اليدويّ القائم ولا يستبدله. صفٌّ APPLY لأنّه أثرٌ
      //  حقيقيٌّ يقع الآن؛ لو أُلغي الإلغاءُ يوماً، محرّكُ العكس سيكتب صفَّ REVERSE مقابل.
      await recordEffect(
        tx,
        {
          documentType: "INVOICE",
          documentId: input.invoiceId,
          effectKind: "INVENTORY",
          effectTable: "inventoryMovements",
          effectRowId: mv.movementId || null,
          signedQuantity: qty,
          branchId: Number(inv.branchId),
          reason: "sale.cancel — إرجاع كامل البضاعة",
          scope: "cancel",
          payloadJson: { variantId: vid, movementType: "RETURN" },
        },
        actor,
      );
    }

    // ═══ ٥) عكس التزام المودِع لبضاعة الأمانة (mirror returnService §٥ حاصرة ١) ═══
    let consignmentRestockedCost = new Decimal(0);
    let consignmentRestockedGiftCost = new Decimal(0);
    const consignByVariant = new Map<number, number>();
    {
      const rvids = variantIds;
      if (rvids.length) {
        const crows = await tx
          .select({ vid: productVariants.id, isConsign: products.isConsignment, cId: products.consignorId })
          .from(productVariants)
          .innerJoin(products, eq(productVariants.productId, products.id))
          .where(inArray(productVariants.id, rvids));
        for (const r of crows) if (r.isConsign && r.cId != null) consignByVariant.set(Number(r.vid), Number(r.cId));
      }
      if (consignByVariant.size) {
        const byConsignor = new Map<number, { paid: Decimal; gift: Decimal }>();
        for (const w of workLines) {
          const cId = consignByVariant.get(Number(w.item.variantId));
          if (cId == null) continue;
          const share = round2(money(w.item.unitCost).times(w.remainingBase));
          const split = byConsignor.get(cId) ?? { paid: new Decimal(0), gift: new Decimal(0) };
          if (w.item.isGift) split.gift = split.gift.plus(share);
          else split.paid = split.paid.plus(share);
          byConsignor.set(cId, split);
        }
        for (const cId of Array.from(byConsignor.keys()).sort((a, b) => a - b)) {
          const split = byConsignor.get(cId)!;
          const paidShare = round2(split.paid);
          const giftShare = round2(split.gift);
          const share = round2(paidShare.plus(giftShare));
          if (share.lte(0)) continue;
          consignmentRestockedCost = consignmentRestockedCost.plus(paidShare);
          consignmentRestockedGiftCost = consignmentRestockedGiftCost.plus(giftShare);
          // عكس بنفس invoiceId ⇒ يدخل فلتر خصم العمولة (استرداد حصّة البائع الأصلي).
          await postEntry(tx, {
            entryType: "PURCHASE",
            supplierId: cId,
            invoiceId: input.invoiceId,
            branchId: Number(inv.branchId),
            amount: share.neg(),
            cost: paidShare.neg(),
            profit: paidShare,
            notes: `عكس استحقاق أمانة — إلغاء فاتورة؛ COGS مبسّط=${toDbMoney(paidShare.neg())}`,
            postingIntent: createPostingIntent("PURCHASE_CONSIGNMENT", "PURCHASE", [...signedPostingLines("COGS", "CONSIGNMENT_PAYABLE", paidShare.neg()), ...signedPostingLines("GIFTS_PROMO", "CONSIGNMENT_PAYABLE", giftShare.neg())], { roleDebits: { CONSIGNMENT_PAYABLE: share }, roleCredits: { COGS: paidShare, GIFTS_PROMO: giftShare } }),
            postingSourceComponents: { roleDebits: { CONSIGNMENT_PAYABLE: share }, roleCredits: { COGS: paidShare, GIFTS_PROMO: giftShare } },
          });
          await adjustSupplierBalance(tx, cId, share.neg());
        }
      }
    }

    // ═══ ٦) قيد RETURN معكوس يزنُ ما تبقّى (assertPeriodOpen يفرض فتح الفترة تلقائياً) ═══
    const cancelOperatorName = await userNameSnapshot(tx, actor.userId);
    const ownedRestockedCost = round2(Decimal.max(new Decimal(0), restockedCost.minus(consignmentRestockedCost).minus(serviceRestockedCost)));
    const ownedRestockedGiftCost = round2(Decimal.max(new Decimal(0), restockedGiftCost.minus(consignmentRestockedGiftCost).minus(serviceRestockedGiftCost)));
    const financiallyRestockedGiftCost = round2(Decimal.max(new Decimal(0), restockedGiftCost.minus(serviceRestockedGiftCost)));
    const deliveryRevenueReversal = round2(money(inv.deliveryFee ?? "0"));
    const sectorRevenueReversal = round2(remainingRevenue.minus(deliveryRevenueReversal));
    const returnAccountingAmount = round2(remainingRevenue.plus(remainingTax));
    const invoiceMerchandiseRevenue = round2(money(inv.subtotal).minus(money(inv.discountAmount)));
    const revenueItems = items.filter((item) => !item.isGift && money(item.total).gt(0)).sort((a, b) => Number(a.id) - Number(b.id));
    const itemRevenueBasis = revenueItems.reduce((sum, item) => sum.plus(money(item.total)), money(0));
    const netRevenueByItem = new Map<number, Decimal>();
    let allocatedInvoiceRevenue = money(0);
    for (let index = 0; index < revenueItems.length; index++) {
      const item = revenueItems[index]!;
      const lineRevenue = index === revenueItems.length - 1 ? round2(invoiceMerchandiseRevenue.minus(allocatedInvoiceRevenue)) : round2(invoiceMerchandiseRevenue.times(money(item.total)).div(itemRevenueBasis));
      allocatedInvoiceRevenue = allocatedInvoiceRevenue.plus(lineRevenue);
      netRevenueByItem.set(Number(item.id), lineRevenue);
    }
    const returnRevenueByRole = new Map<AccountRole, Decimal>();
    const returnClasses = new Set<"SERVICE" | "CONSIGNMENT" | "INVENTORY">();
    let allocatedReturnRevenue = money(0);
    let balancingRole: AccountRole | null = null;
    for (const { item, remainingBase } of workLines) {
      const lineRevenue = netRevenueByItem.get(Number(item.id)) ?? money(0);
      if (lineRevenue.isZero()) continue;
      const kind = kindByVariant.get(Number(item.variantId)) ?? "STOCKED";
      const returnClass = kind === "SERVICE" ? "SERVICE" : consignByVariant.has(Number(item.variantId)) ? "CONSIGNMENT" : "INVENTORY";
      returnClasses.add(returnClass);
      const role: AccountRole = kind === "SERVICE" ? "SALES_PRINT" : "SALES_STATIONERY";
      const currentRevenue = remainingBase >= item.baseQuantity ? lineRevenue : round2(lineRevenue.times(remainingBase).div(item.baseQuantity));
      allocatedReturnRevenue = allocatedReturnRevenue.plus(currentRevenue);
      returnRevenueByRole.set(role, round2((returnRevenueByRole.get(role) ?? money(0)).plus(currentRevenue)));
      balancingRole = role;
    }
    const sectorDelta = round2(sectorRevenueReversal.minus(allocatedReturnRevenue));
    if (!sectorDelta.isZero() && balancingRole) {
      returnRevenueByRole.set(balancingRole, round2((returnRevenueByRole.get(balancingRole) ?? money(0)).plus(sectorDelta)));
    }
    const returnProfile: PostingProfile = returnClasses.size > 1 ? "RETURN_SALE_MIXED" : returnClasses.has("SERVICE") ? "RETURN_SALE_SERVICE" : returnClasses.has("CONSIGNMENT") ? "RETURN_SALE_CONSIGNMENT" : "RETURN_SALE_INVENTORY";
    const returnPostingLines = [
      ...Array.from(returnRevenueByRole.entries())
        .filter(([, amount]) => !amount.isZero())
        .map(([role, amount]) => debitLine(role, amount)),
      ...(deliveryRevenueReversal.isZero() ? [] : [debitLine("DELIVERY_REVENUE", deliveryRevenueReversal)]),
      ...(remainingTax.isZero() ? [] : [debitLine("TAX_PAYABLE", remainingTax)]),
      ...(returnAccountingAmount.isZero() ? [] : [creditLine("AR", returnAccountingAmount)]),
      ...(ownedRestockedCost.isZero() ? [] : [debitLine("INVENTORY", ownedRestockedCost), creditLine("COGS", ownedRestockedCost)]),
    ];
    const returnPostingSource = {
      roleDebits: {
        SALES_STATIONERY: returnRevenueByRole.get("SALES_STATIONERY") ?? money(0),
        SALES_PRINT: returnRevenueByRole.get("SALES_PRINT") ?? money(0),
        SALES_FLEX: returnRevenueByRole.get("SALES_FLEX") ?? money(0),
        OTHER_REVENUE: returnRevenueByRole.get("OTHER_REVENUE") ?? money(0),
        DELIVERY_REVENUE: deliveryRevenueReversal,
        TAX_PAYABLE: remainingTax,
        INVENTORY: ownedRestockedCost,
      },
      roleCredits: { AR: returnAccountingAmount, COGS: ownedRestockedCost },
    };
    const returnPostingIntent = returnPostingLines.length ? createPostingIntent(returnProfile, "RETURN", returnPostingLines, returnPostingSource) : null;
    // إلغاء فاتورة هدايا صِرفة لا يعكس SALE/AR؛ عكس GIFT_OUT أدناه هو أثره المالي.
    if (returnPostingIntent) {
      await postEntry(tx, {
      entryType: "RETURN",
      branchId: Number(inv.branchId),
      invoiceId: input.invoiceId,
      customerId: inv.customerId,
      revenue: remainingRevenue.neg(),
      // `cost` is a canonical source field: it must equal the owned COGS credit exactly.
      // Service materials are already consumed and consignment is never our inventory.
      cost: ownedRestockedCost.neg(),
      profit: remainingRevenue.minus(ownedRestockedCost).neg(),
      taxAmount: remainingTax.neg(),
      amount: remainingAmount.neg(),
      createdBy: actor.userId,
      createdByNameSnapshot: cancelOperatorName,
      notes: `${input.reason ? `إلغاء فاتورة — ${input.reason.slice(0, 200)}؛ ` : "إلغاء فاتورة؛ "}عكس كلفة تحليلية=${toDbMoney(restockedCost)}؛ عكس COGS مملوك=${toDbMoney(ownedRestockedCost)}؛ خدمة غير معادة=${toDbMoney(serviceRestockedCost)}؛ أمانة مستقلة=${toDbMoney(consignmentRestockedCost)}`,
        postingIntent: returnPostingIntent,
        postingSourceComponents: returnPostingSource,
      });
    }

    if (financiallyRestockedGiftCost.gt(0)) {
      const giftPosting = classifyGiftPosting(financiallyRestockedGiftCost, ownedRestockedGiftCost, -1);
      await postEntry(tx, {
        entryType: "GIFT_OUT",
        branchId: Number(inv.branchId),
        invoiceId: input.invoiceId,
        customerId: inv.customerId,
        revenue: money(0),
        cost: financiallyRestockedGiftCost.neg(),
        profit: financiallyRestockedGiftCost,
        amount: financiallyRestockedGiftCost.neg(),
        createdBy: actor.userId,
        createdByNameSnapshot: cancelOperatorName,
        notes: `عكس هدايا ضمن إلغاء فاتورة بيع؛ consignmentRemainder=${toDbMoney(giftPosting.consignmentRemainder)}`,
        postingIntent: giftPosting.intent,
        postingSourceComponents: giftPosting.sourceComponents,
      });
    }

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
          postingIntent: createPostingIntent("ADJUST_ROUNDING", "ADJUST", signedPostingLines("AR", "ROUNDING_DIFF", cashRoundOriginal.neg())),
        });
      }
    }

    // ═══ ٨) الاسترداد: النقد فوري؛ غير النقد طلب PAYMENT قابل لاعتماد المالك ═══
    // Codex P1 (١٢/٨): جمع كل المقبوضات المرتبطة بالفاتورة (IN) − ما استُرِدّ (OUT) كأساسٍ للاسترداد،
    // بدل الاعتماد على inv.paidAmount وحده. voucher/create.ts يخفض ذمّة العميل عند سند قبضٍ مرتبط
    // بفاتورة لكنه لا يرفع invoices.paidAmount ⇒ إن اعتمدنا paidAmount وحده يبقى قسمٌ من نقد العميل
    // غير مُسترَدٍّ فتنقلب ذمّته لدائن (فائض ائتمان). النموذج الصحيح: كل حركة receipt IN/OUT مرتبطة
    // بالفاتورة تدخل الحساب، مطابقةً لما تراه voucher-linked flows ونماذج التحصيل الفعلية.
    // Current locking read: invPreview سبق انتظار source وقد أنشأ snapshot أقدم من دفعة
    // متزامنة. aggregate عادي بعد الانتظار كان يلغي الفاتورة ولا يرى القبض الذي التزم للتو.
    const materialReceipts = await tx
      .select({ direction: receipts.direction, amount: receipts.amount })
      .from(receipts)
      .where(and(
        eq(receipts.invoiceId, input.invoiceId),
        inArray(receipts.status, [...MATERIALIZED_RECEIPT_STATUSES]),
        eq(receipts.approvalStatus, "APPROVED"),
      ))
      .for("update");
    const totalIn = materialReceipts.reduce(
      (sum, receipt) => receipt.direction === "IN" ? sum.plus(money(receipt.amount)) : sum,
      money(0),
    );
    const totalOutPrior = materialReceipts.reduce(
      (sum, receipt) => receipt.direction === "OUT" ? sum.plus(money(receipt.amount)) : sum,
      money(0),
    );
    const refundable = totalIn.minus(totalOutPrior);
    let refundAmount = new Decimal(0);
    let pendingRefundAmount = new Decimal(0);
    let pendingRefundVoucherNumber: string | null = null;
    if (refundable.gt(0)) {
      // تحديد الوردية والدلو: النقد يمرّ shiftIdForCashTx (يضمن ورديةً للكاشير ويعطي TREASURY للمدير/الأدمن
      // بلا وردية). غير النقد لا يمسّ صندوقاً ⇒ shiftId اختياري (نأخذ ما هو مفتوح إن وُجد للربط بالتسوية).
      let shiftId: number | null = null;
      let cashBucket: "DRAWER" | "TREASURY" | null = null;
      // ⭐ قرار المالك (١٧/٨/٢٦): رافدا الردّ الفوريّ نقدٌ أو بطاقة (مطابقٌ لـreturnService.ts) — البطاقة
      // تتجسّد الآن فوراً بمرجع جهازٍ إلزاميّ، لا تنتظر اعتماد سندٍ معلَّق كـCHECK/TRANSFER/WALLET.
      const isImmediateRefundRail = isSurfacedRefundMethod(input.refundPaymentMethod);
      let cardReference: string | null = null;
      if (input.refundPaymentMethod === "CASH") {
        const g = prelockedCashSource;
        if (!g) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم يُقفل مصدر استرداد الإلغاء النقدي" });
        }
        shiftId = g.shiftId;
        cashBucket = g.cashBucket;
        if (cashBucket === "TREASURY") assertTreasuryOutException("SALE_CANCELLATION_COMPENSATION");
        await assertCashOutAvailable(tx, {
          branchId: Number(inv.branchId),
          cashBucket,
          shiftId,
          amount: refundable,
          operation: "استرداد إلغاء الفاتورة",
        });
      } else if (isSurfacedRefundMethod(input.refundPaymentMethod)) {
        cardReference = input.reference?.trim() || null;
        if (!cardReference) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "تعذّر تسجيل استرداد إلغاء الفاتورة على البطاقة",
              why: `مرجع عملية الاسترداد من جهاز الدفع لم يصل، وهو الأثر الوحيد الذي يربط ${refundable.toFixed(2)} د.ع خرجت من حسابنا البنكيّ بمستندها`,
              doThis: "نفّذ الاسترداد على جهاز الدفع أوّلاً، ثمّ أدخِل رقم العملية أو كود الموافقة المطبوع على قسيمة الجهاز في حقل المرجع",
            }),
          });
        }
        // لا يمسّ درجاً (cashBucket=NULL) ⇒ لا أثر على expectedCash ولا Z-report. لا يشترط عميلاً
        // مسجَّلاً — البطاقة نفسها هي الطرف (مطابقٌ لـreturnService.ts:1192-1214).
        assertNonPhysicalOutReceipt({
          classification: "NON_CASH_METHOD",
          paymentMethod: input.refundPaymentMethod,
          cashBucket: null,
          approvalStatus: "APPROVED",
          operation: "استرداد إلغاء فاتورة على البطاقة",
        });
      } else {
        if (inv.customerId == null) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "الاسترداد غير النقدي يحتاج عميلاً مرتبطاً بالفاتورة كي يمرّ بسند صرف واعتماد مالك",
          });
        }
        assertNonPhysicalOutReceipt({
          classification: "DEFERRED_APPROVAL",
          paymentMethod: input.refundPaymentMethod,
          cashBucket: null,
          approvalStatus: "PENDING_APPROVAL",
          operation: "طلب استرداد إلغاء فاتورة غير نقدي",
        });
        pendingRefundVoucherNumber = await nextVoucherNumber(tx, "PAYMENT", Number(inv.branchId));
      }

      // غير النقد يحمل voucherNumber فيظهر بطابور السندات وي materialize حصراً عبر
      // voucher.approve من مالك آخر. النقد والبطاقة الفوريّان يبقيان إيصال مرتجعٍ بلا voucherNumber.
      const rRes = await tx.insert(receipts).values({
        invoiceId: input.invoiceId,
        branchId: Number(inv.branchId),
        shiftId,
        cashBucket,
        direction: "OUT",
        amount: toDbMoney(refundable),
        paymentMethod: input.refundPaymentMethod,
        status: isImmediateRefundRail ? "COMPLETED" : "PENDING",
        description: `استرداد إلغاء فاتورة ${inv.invoiceNumber}`,
        approvalStatus: isImmediateRefundRail ? "APPROVED" : "PENDING_APPROVAL",
        referenceNumber: input.refundPaymentMethod === "CASH"
          ? null
          : isImmediateRefundRail
            ? cardReference
            : `SALE-CANCEL-PENDING-${input.invoiceId}-${requestFingerprint?.slice(0, 12) ?? "LEGACY"}`,
        voucherNumber: pendingRefundVoucherNumber,
        partyType: inv.customerId ? "CUSTOMER" : "OTHER",
        partyId: inv.customerId ?? null,
        internalNote: pendingRefundVoucherNumber
          ? `SALE_CUSTOMER_REFUND:CANCEL:${input.invoiceId}`
          : null,
        createdBy: actor.userId,
      });
      const receiptId = extractInsertId(rRes);
      if (isImmediateRefundRail) {
        const refundAssetRole = paymentAssetRole(input.refundPaymentMethod, cashBucket, "OUT");
        const refundPostingSource = {
          roleDebits: { AR: refundable },
          roleCredits: { [refundAssetRole]: refundable },
        };
        await postEntry(tx, {
          entryType: "PAYMENT_OUT",
          branchId: Number(inv.branchId),
          invoiceId: input.invoiceId,
          receiptId,
          customerId: inv.customerId,
          amount: refundable,
          postingIntent: createPostingIntent("PAYMENT_OUT_CUSTOMER_REFUND", "PAYMENT_OUT", [debitLine("AR", refundable), creditLine(refundAssetRole, refundable)], refundPostingSource),
          postingSourceComponents: refundPostingSource,
        });
        refundAmount = refundable;
      } else {
        pendingRefundAmount = refundable;
      }
    }

    // ═══ ٩) تصفير ذمّة العميل عن هذه الفاتورة ═══
    // مساهمة الفاتورة في AR قبل الإلغاء: (remainingAmount − ما استُرد فعلياً الآن).
    // طلب الاسترداد غير النقدي المعلّق لا يُعامل كدفع: يبقى رصيد العميل دائناً حتى materialization
    // الذي ينشئ PAYMENT_OUT/Dr AR، فلا نُصفّر ديناراً لم يغادر الحساب فعلاً.
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
      await recordIdempotencyKey(tx, "sale.cancel", input.clientRequestId, input.invoiceId, requestFingerprint);
    }

    return {
      invoiceId: input.invoiceId,
      invoiceNumber: inv.invoiceNumber,
      cancelledAt,
      refundAmount: refundAmount.toFixed(2),
      refundVoucherNumber: pendingRefundVoucherNumber,
      pendingRefundAmount: pendingRefundAmount.toFixed(2),
    };
}
