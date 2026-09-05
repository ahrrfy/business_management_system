// إلغاء فاتورة بيع كاملاً — قرار المالك ١٢/٨/٢٦.
//
// **قاعدة الإلغاء الحاكمة:** «الفاتورة كأنّها لم تكن»:
//   ١) عكسٌ كامل: revenue/cost/tax يُعكَسان في الدفتر بقيد RETURN سالبٍ يزنُ ما تبقى غيرَ مُرتجَع.
//   ٢) إرجاعٌ كامل للبضاعة: applyMovement RETURN بالكميّة الأساسية المتبقّية من كل بند (بكجات
//      عبر لقطة `invoiceItemBundleComponents` — لا وصفة حيّة).
//   ٣) استرداد بجهةٍ مُصرَّحة: سند صرف OUT بمبلغ المقبوض المتبقّي، بطريقةٍ مُدخَلة (CASH/CARD/...)
//      — «لا دينار بلا مسار/سند/قيد» (§٥، مبدأ المالك). النقد يمرّ shiftIdForCashTx (DRAWER
//      إن للمشغّل وردية مفتوحة، وإلّا TREASURY للأدوار الإدارية).
//   ٤) تصفير ذمّة العميل عن هذه الفاتورة، وتحرير الكوبون، ووسمها CANCELLED بلقطة تدقيقٍ.
//
// **م٢ (ق٧): الأثرُ كلُّه يمرّ بمحرّك العكس.** كانت الخطوات ٢–٩ هنا نسخةً يدويّةً من
// `returnService` وقد اختلفتا (الكوبون لا يُحرَّر، الحسبات تنجرف). الآن هذا الملفّ **حرّاسٌ +
// قفلُ مصدر النقد + حالةُ المستند** فقط، و`reverseInvoiceSaleInTx` (server/services/reversal)
// يُجسّد الآثار من الحقيقة ثمّ يُنفّذ التعويض نوعاً نوعاً (مخزون · أمانة · قيد · هدايا · تقريب ·
// ردّ مال · ذمّة · كوبون) بمنفّذين مشتركين مع المرتجع الكامل، ويفرض الثابت Σ = 0.
//
// **حراس:**
//   - managerProcedure على الراوتر (SOD مع بائع الفاتورة).
//   - ملكية الفرع هنا (mirror returnService) — admin يعبُر.
//   - فترة مفتوحة (postEntry يفرضها بـassertPeriodOpen على كل قيد جديد).
//   - CANCELLED / RETURNED مُسبقاً ⇒ رفض صريح.
//   - WORKORDER: مسار إلغاء مخصّص (المواد استُهلكت لحظة بدء الأمر، لا تعود بإرجاع فاتورة).
//   - كروت رقميّة: يمرّ بمسار `digitalCards.reversal` لا هذا الإلغاء العام.

import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import {
  digitalSaleDetails,
  installmentPlans,
  invoiceItems,
  invoices,
  onlineOrders,
  receipts,
} from "../../../drizzle/schema";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { money, toDbMoney } from "../money";
import { assertPeriodOpen } from "../periodLockService";
import { shiftIdForCashTx } from "../shiftService";
import { lockCashSourceForUpdate } from "../cash/cashAvailability";
import { withTx, type Actor } from "../tx";
import { reverseInvoiceSaleInTx } from "../reversal/invoiceReversal";
import { invoicePaidPool } from "../reversal/materialize/invoice";
import { userNameSnapshot } from "../userSnapshot";
import { assertInvoiceCancellationDeliverySafeTx } from "./invoiceCancellationGuard";
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

    // ═══ ٢) الفاتورة يلزمها بندٌ — الإلغاءُ يعمل بإعادة كلّ بندٍ متبقٍّ ═══
    const itemCount = (
      await tx.select({ n: sql<number>`COUNT(*)` }).from(invoiceItems).where(eq(invoiceItems.invoiceId, input.invoiceId))
    )[0];
    if (!Number(itemCount?.n ?? 0)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الفاتورة بلا بنود — تعذّر الإلغاء" });
    }

    // ═══ ٢-ب) البطاقةُ بلا مرجع جهازٍ تُرفض **قبل أيّ أثر** حين يوجد مقبوضٌ يُردّ ═══
    // الإثباتُ لا الإقفال (سياسة القبض ١٦/٨): المرجع هو الأثر الوحيد الذي يربط المبلغَ الخارج من
    // حسابنا البنكيّ بمستنده. منفّذُ الردّ في المحرّك يفرضه أيضاً لكلّ مستدعٍ؛ وهنا يُرفض مبكّراً
    // بلا تجسيدٍ ولا كتابة — والنصّ متعاقَدٌ عليه في `saleCancel.test.ts` (check:message-drift).
    if (input.refundPaymentMethod === "CARD" && !input.reference?.trim()) {
      const pool = await invoicePaidPool(tx, input.invoiceId);
      const refundable = pool.totalIn.minus(pool.outPrior);
      if (refundable.gt(0)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر تسجيل استرداد إلغاء الفاتورة على البطاقة",
            why: `مرجع عملية الاسترداد من جهاز الدفع لم يصل، وهو الأثر الوحيد الذي يربط ${refundable.toFixed(2)} د.ع خرجت من حسابنا البنكيّ بمستندها`,
            doThis: "نفّذ الاسترداد على جهاز الدفع أوّلاً، ثمّ أدخِل رقم العملية أو كود الموافقة المطبوع على قسيمة الجهاز في حقل المرجع",
          }),
        });
      }
    }

    // ═══ ٣) الأثرُ كلُّه عبر محرّك العكس (ق٧): مخزون · أمانة · قيد · هدايا · تقريب · ردّ مال · ذمّة · كوبون ═══
    const cancelOperatorName = await userNameSnapshot(tx, actor.userId);
    const reasonNote = input.reason?.trim() || null;
    const summary = await reverseInvoiceSaleInTx(
      tx,
      {
        invoiceId: input.invoiceId,
        flavor: "CANCEL",
        reason: `إلغاء فاتورة ${inv.invoiceNumber}${reasonNote ? ` — ${reasonNote.slice(0, 120)}` : ""}`,
        reasonNote,
        restock: true,
        refund: {
          method: input.refundPaymentMethod,
          reference: input.reference ?? null,
          cashSource: prelockedCashSource,
          requestFingerprint,
        },
      },
      actor,
    );
    const refundAmount = summary.refundAmount;
    const pendingRefundAmount = summary.pendingRefundAmount;
    const pendingRefundVoucherNumber = summary.pendingRefundVoucherNumber;

    // Codex P2 (١٢/٨) — مزامنة الطلب الإلكتروني: فاتورة ONLINE مرتبطة بطلب في `onlineOrders`؛ الإلغاء
    // بلا مزامنة يترك الطلب SHIPPED/DELIVERED بينما المخزون رجع والقيد عُكس ⇒ طوابير المندوبين وتحليلات
    // المتجر تُظهر طلباً حيّاً مقابل فاتورةٍ ملغاة. نُحدّث للحالة CANCELLED بنفس المعاملة (ذرّياً).
    if (inv.sourceType === "ONLINE") {
      await tx
        .update(onlineOrders)
        .set({
          status: "CANCELLED",
          cancelReason: input.reason?.trim() || "إلغاء فاتورة",
        })
        .where(and(eq(onlineOrders.invoiceId, input.invoiceId), sql`${onlineOrders.status} != 'CANCELLED'`));
    }

    // ═══ ٤) وسم CANCELLED مع لقطة تدقيق — المدفوع أنقصه منفّذُ الردّ بما خرج فعلاً ═══
    const newReturnedTotal = money(inv.returnedTotal ?? "0").plus(summary.remainingAmount);
    const cancelledAt = new Date();
    await tx
      .update(invoices)
      .set({
        status: "CANCELLED",
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
      refundAmount: new Decimal(refundAmount).toFixed(2),
      refundVoucherNumber: pendingRefundVoucherNumber,
      pendingRefundAmount: new Decimal(pendingRefundAmount).toFixed(2),
    };
}
