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
import { moduleAccessAllowed, type PermissionMap } from "@shared/permissions";
import { isDeadInvoice } from "@shared/predicates";
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
import { openShiftIdTx, shiftIdForCashTx } from "../shiftService";
import {
  assertCashOutAvailable,
  computeDrawerCashBalance,
  lockCashSourceForUpdate,
} from "../cash/cashAvailability";
import { withTx, type Actor } from "../tx";
import { reverseInvoiceSaleInTx } from "../reversal/invoiceReversal";
import { invoicePaidPool } from "../reversal/materialize/invoice";
import { loadRefundCaps } from "../returns/refundCaps";
import { userNameSnapshot } from "../userSnapshot";
import { assertInvoiceCancellationDeliverySafeTx } from "./invoiceCancellationGuard";
import type { Tx } from "../../db";
import { assertLockedInvoiceControlSnapshotTx, type InvoiceControlSnapshot } from "./controlSnapshot";
import { cancelDeliveryAssignmentInTx } from "../delivery/cancellation";
import {
  evaluateRefundOperationalDecision,
  OperationalApprovalRequiredError,
  type OperationalDecision,
} from "@shared/operationalDecision";
import { todayUtcDate } from "../businessDay";
import {
  loadCurrentOperationalAuthorityTx,
  type CurrentOperationalAuthority,
} from "../authorization/currentOperationalAuthority";
import { assertOperationAuthorityTx } from "../authorization/operationAuthority";

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
  /** يفعّل حدود التنفيذ المباشر لمسار API التشغيلي؛ اعتماد التحكم يستعمل الحراس السيادية القائمة. */
  enforceOperationalDecision?: boolean;
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
  operationalDecision?: OperationalDecision;
}

class CashRefundSourceChangedError extends TRPCError {
  constructor() {
    super({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذر تثبيت مصدر رد إلغاء الفاتورة",
        why: "سُجل قبض نقدي متزامن بعد فحص الفاتورة الأولي",
        doThis: "أعد المحاولة كي يُقفل النظام درج القبض قبل تنفيذ الرد",
      }),
    });
  }
}

export async function cancelSale(input: CancelSaleInput, actor: Actor): Promise<CancelSaleResult> {
  try {
    return await withTx((tx) => cancelSaleInTx(tx, input, actor));
  } catch (error) {
    if (!(error instanceof CashRefundSourceChangedError)) throw error;
    return withTx((tx) => cancelSaleInTx(tx, input, actor));
  }
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
            message: appErrorMessage({
              what: "تعذر إتمام طلب الإلغاء",
              why: "تعارض idempotency: المفتاح مستعمَل لإلغاءٍ على فاتورة مختلفة",
              doThis: "استخدم مفتاح طلب فريداً لكل عملية إلغاء",
            }),
          });
        }
        const rInv = (await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1))[0];
        if (!rInv) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: appErrorMessage({
              what: "تعذر العثور على الفاتورة",
              why: "الفاتورة غير موجودة",
              doThis: "تحقق من صحة معرّف الفاتورة",
            }),
          });
        }
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

    let currentOperationalAuthority: CurrentOperationalAuthority | null = null;
    let currentCancellationAllowed = true;
    if (input.enforceOperationalDecision) {
      currentOperationalAuthority = await loadCurrentOperationalAuthorityTx(
        tx,
        actor.userId,
      );
      if (
        currentOperationalAuthority.role !== actor.role ||
        (
          currentOperationalAuthority.role !== "admin" &&
          !currentOperationalAuthority.isOwner &&
          currentOperationalAuthority.branchId !== actor.branchId
        )
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذر تثبيت تفويض إلغاء الفاتورة",
            why: "تغير دور الحساب أو فرعه أثناء تنفيذ الإلغاء",
            doThis: "حدث الصفحة وأعد الإلغاء بصلاحيات الحساب الحالية",
          }),
        });
      }
      let legacyCancellationAllowed = false;
      const canonicalCancellationAllowed = await assertOperationAuthorityTx(
        tx,
        actor,
        "sales.cancel",
        (current) => {
          legacyCancellationAllowed =
            moduleAccessAllowed(
              current.role ?? "user",
              current.permissionsOverride as PermissionMap | null,
              "sales",
              "FULL",
              ["cashier", "manager"],
            ) ||
            moduleAccessAllowed(
              current.role ?? "user",
              current.permissionsOverride as PermissionMap | null,
              "workorders",
              "FULL",
              ["cashier", "manager", "print_operator"],
            ) ||
            moduleAccessAllowed(
              current.role ?? "user",
              current.permissionsOverride as PermissionMap | null,
              "pos",
              "FULL",
              ["cashier", "manager", "print_operator"],
            );
          return legacyCancellationAllowed;
        },
      );
      currentCancellationAllowed =
        canonicalCancellationAllowed || legacyCancellationAllowed;
    }

    // ترتيب الأقفال الحاكم: مصدر النقد قبل الفاتورة/مورّدي الأمانة. اعتماد سند مورد
    // نقدي يسلك source→supplier؛ تأخير المصدر هنا كان يصنع المسار المعاكس.
    const invPreview = (
      await tx.select({ branchId: invoices.branchId }).from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1)
    )[0];
    if (!invPreview) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذر العثور على الفاتورة",
          why: "الفاتورة غير موجودة",
          doThis: "تحقق من صحة معرّف الفاتورة",
        }),
      });
    }
    if (actor.role !== "admin" && Number(invPreview.branchId) !== Number(actor.branchId)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذر إلغاء الفاتورة",
          why: "الفاتورة لا تخصّ فرعك",
          doThis: "سجّل الدخول بحساب الفرع المالك للفاتورة لإلغائها",
        }),
      });
    }
    let prelockedCashSource: Awaited<ReturnType<typeof shiftIdForCashTx>> | null = null;
    let prelockedCashAccount: Awaited<ReturnType<typeof lockCashSourceForUpdate>> | null = null;
    const previewRefundCaps =
      input.refundPaymentMethod === "CASH"
        ? await loadRefundCaps(tx, input.invoiceId)
        : null;
    const expectsCashRefund =
      input.refundPaymentMethod === "CASH" &&
      previewRefundCaps != null &&
      previewRefundCaps.pool.gt(0);
    if (expectsCashRefund) {
      const directLimitsApply =
        input.enforceOperationalDecision === true &&
        currentOperationalAuthority != null &&
        currentOperationalAuthority.role !== "admin" &&
        !currentOperationalAuthority.isOwner;
      if (directLimitsApply) {
        const shiftId = await openShiftIdTx(
          tx,
          actor.userId,
          Number(invPreview.branchId),
        );
        prelockedCashSource = shiftId == null
          ? null
          : { shiftId, cashBucket: "DRAWER" as const };
      } else {
        prelockedCashSource = await shiftIdForCashTx(
          tx,
          actor,
          Number(invPreview.branchId),
          "استرداد إلغاء فاتورة",
        );
      }
      if (prelockedCashSource) {
        prelockedCashAccount = await lockCashSourceForUpdate(tx, {
          branchId: Number(invPreview.branchId),
          cashBucket: prelockedCashSource.cashBucket,
          shiftId: prelockedCashSource.shiftId,
        });
      }
    }

    // بعد مصدر النقد، اقفل جهة التوصيل→الإرسالية/طلب المتجر قبل الفاتورة. الحارس لا يكتفي
    // بوسم CANCELLED: يثبت أيضاً انعدام الحيازة وCOD والتسوية المفتوحة تحت الأقفال نفسها.
    const deliveryGuard = await assertInvoiceCancellationDeliverySafeTx(tx, {
      invoiceId: input.invoiceId,
      expectedBranchId: Number(invPreview.branchId),
      allowAssignedCancellation: input.enforceOperationalDecision === true || input.controlExpectedSnapshot != null,
    });
    if (deliveryGuard.cancellableAssignmentId != null) {
      await cancelDeliveryAssignmentInTx(
        tx,
        {
          consignmentId: deliveryGuard.cancellableAssignmentId,
          reason: input.reason?.trim() || "إلغاء الفاتورة قبل تسليم إسناد التوصيل",
          clientRequestId: `sale-cancel-${input.clientRequestId?.trim() || input.invoiceId}`,
        },
        { userId: actor.userId, branchId: actor.branchId, role: actor.role },
        { assertAuthority: true },
      );
      // أثبت أن تحرير COD وإغلاق الإسناد اكتمل قبل لمس الفاتورة.
      await assertInvoiceCancellationDeliverySafeTx(tx, {
        invoiceId: input.invoiceId,
        expectedBranchId: Number(invPreview.branchId),
      });
    }

    // ═══ ١) قراءة الفاتورة تحت FOR UPDATE + الحراس ═══
    const invRows = await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).for("update").limit(1);
    const inv = invRows[0];
    if (!inv) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذر العثور على الفاتورة المطلوبة للإلغاء",
          why: "الفاتورة غير موجودة",
          doThis: "تحقق من رقم الفاتورة أو ابحث عنها في قائمة المبيعات",
        }),
      });
    }
    if (Number(inv.branchId) !== Number(invPreview.branchId)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذر إتمام إلغاء الفاتورة",
          why: "تغيّر فرع الفاتورة أثناء الإلغاء؛ أعد المحاولة",
          doThis: "أعد فتح تفاصيل الفاتورة وتأكد من الفرع التشغيلي ثم كرر المحاولة",
        }),
      });
    }
    await assertLockedInvoiceControlSnapshotTx(tx, inv, input.controlExpectedSnapshot);

    // ═══ حارس حالة الفاتورة والتعشيق الذري المالي (F6: Atomic Cancellation Interlock) ═══
    // ١) فحص المستند الميت (CANCELLED / RETURNED / SUPERSEDED) وفق عقد رسائل الخطأ الموحد
    if (isDeadInvoice(inv)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          inv.status === "CANCELLED"
            ? appErrorMessage({
                what: `تعذّر إلغاء الفاتورة ${inv.invoiceNumber}`,
                why: "الفاتورة ملغاة مسبقاً",
                doThis: "تحقّق من سجلّ الفاتورة في قائمة المبيعات للتأكّد من تفاصيل الإلغاء السابقة",
                action: { label: "سجل المبيعات", href: "/invoices" },
              })
            : inv.status === "SUPERSEDED"
              ? appErrorMessage({
                  what: `تعذّر إلغاء الفاتورة ${inv.invoiceNumber}`,
                  why: "الفاتورة مستبدلة بفاتورة مصححة ولا يجوز إلغاؤها",
                  doThis: "افتح الفاتورة المصحّحة البديلة من سجلّ الفاتورة تحت «استُبدلت بـ» إن كنت بحاجة لتعديلها أو إلغائها",
                  action: { label: "تفاصيل الفاتورة", href: `/invoices/${inv.id}` },
                })
              : appErrorMessage({
                  what: `تعذّر إلغاء الفاتورة ${inv.invoiceNumber}`,
                  why: "الفاتورة مُرتجَعة بالكامل — لا حاجة للإلغاء (المخزون والذمة مُصفَّران)",
                  doThis: "راجع سجلّ المرتجعات للتأكّد ممّا استُرِدّ للزبون وتصفير بنود الفاتورة",
                  action: { label: "سجل المرتجعات", href: "/sales-returns" },
                }),
      });
    }

    // ٢) التحقق المالي الحاسم: منع إلغاء فاتورة استُنفدت كامل قيمتها عبر المرتجعات التراكمية
    const returnedTotalDec = money(inv.returnedTotal ?? "0");
    const totalDec = money(inv.total);
    if (totalDec.gt(0) && returnedTotalDec.gte(totalDec)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر إلغاء الفاتورة ${inv.invoiceNumber}`,
          why: `الفاتورة مُرتجَعة بالكامل مالياً: إجمالي المرتجع (${returnedTotalDec.toFixed(2)} د.ع) استنفد كامل قيمة الفاتورة (${totalDec.toFixed(2)} د.ع)`,
          doThis: "راجع سجلّ المرتجعات للتأكّد من المبالغ المستردة قبل اتخاذ أي إجراء إداري",
          action: { label: "سجل المرتجعات", href: "/sales-returns" },
        }),
      });
    }
    // Codex P1 (١٢/٨) — حارس الفترة على تاريخ الفاتورة الأصليّ: فاتورة داخل شهرٍ مُقفَلٍ لا تُلغى بيومٍ لاحق
    // مفتوح (assertPeriodOpen على new Date() لا يمنعه) لأن الحالة CANCELLED رجعياً تحذفها من تقارير
    // شهر الإصدار (monthlyClosePack يفلتر CANCELLED) فتتغيّر أرقام شهرٍ مُغلَق ماليّاً بلا فتح صريح.
    await assertPeriodOpen(tx, inv.invoiceDate);
    // ملكية الفرع: مدير فرع لا يُلغي فاتورة فرع آخر (تُخرج نقداً من صندوقه/خزينته لفاتورة لا تخصّه).
    if (actor.role !== "admin" && Number(inv.branchId) !== Number(actor.branchId)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذر إلغاء الفاتورة",
          why: "الفاتورة لا تخصّ فرعك",
          doThis: "سجّل الدخول بحساب الفرع المالك للفاتورة أو راجع الإدارة المركزية",
        }),
      });
    }
    const lockedPaidPool = await invoicePaidPool(tx, input.invoiceId);
    const lockedRefundable = lockedPaidPool.totalIn.minus(lockedPaidPool.outPrior);
    let directDecision: OperationalDecision | undefined;
    if (
      input.enforceOperationalDecision &&
      currentOperationalAuthority != null &&
      currentOperationalAuthority.role !== "admin" &&
      !currentOperationalAuthority.isOwner
    ) {
      const pool = lockedPaidPool;
      const refundable = lockedRefundable;
      const drawerHasFunds =
        input.refundPaymentMethod !== "CASH" ||
        refundable.lte(0) ||
        prelockedCashAccount == null ||
        (prelockedCashAccount?.cashBucket === "DRAWER" &&
          prelockedCashAccount.shiftId != null &&
          (await computeDrawerCashBalance(
            tx,
            prelockedCashAccount.shiftId,
            prelockedCashAccount.openingBalance ?? "0",
          )).gte(refundable));
      directDecision = evaluateRefundOperationalDecision({
        operationAllowed: currentCancellationAllowed,
        sameBranch: Number(inv.branchId) === Number(actor.branchId),
        ownsTransaction: Number(inv.createdBy) === Number(actor.userId),
        sameOpenShift:
          refundable.lte(0) ||
          input.refundPaymentMethod !== "CASH" ||
          (prelockedCashSource?.cashBucket === "DRAWER" &&
            prelockedCashSource.shiftId != null &&
            lockedPaidPool.cashReceiptShiftIds.includes(Number(prelockedCashSource.shiftId))),
        sameBusinessDay: inv.invoiceDate.toISOString().slice(0, 10) === todayUtcDate(),
        accountingPeriodOpen: true,
        hasDownstreamEffects: returnedTotalDec.gt(0),
        hasSourceDocument: true,
        refundAmountIqd: refundable.toFixed(2),
        maxRefundAmountIqd: currentOperationalAuthority.caps.maxRefundAmountIqd,
        refundMethod: input.refundPaymentMethod,
        originalPaymentMethods: Object.keys(pool.byMethod),
        drawerHasFunds,
        approvalOperation: "salesControl.requestCancel",
      });
      if (directDecision.result === "APPROVAL_REQUIRED")
        throw new OperationalApprovalRequiredError(directDecision);
      if (directDecision.result === "DENY")
        throw new TRPCError({ code: "FORBIDDEN", message: directDecision.reason });
    }
    if (
      input.refundPaymentMethod === "CASH" &&
      lockedRefundable.gt(0) &&
      !prelockedCashSource
    ) {
      throw new CashRefundSourceChangedError();
    }
    if (
      input.refundPaymentMethod === "CASH" &&
      lockedRefundable.gt(0) &&
      prelockedCashSource
    ) {
      // The final source is checked only after the direct/approval decision. A
      // short cashier drawer therefore creates an approval request; an approved
      // manager execution checks its newly selected drawer/treasury here.
      await assertCashOutAvailable(tx, {
        branchId: Number(inv.branchId),
        cashBucket: prelockedCashSource.cashBucket,
        shiftId: prelockedCashSource.shiftId,
        amount: lockedRefundable,
        operation: "رد إلغاء فاتورة من مصدر النقد المعتمد",
      });
    }
    // فصل المهام (SOD): فاتورة بيع نهائية مكتملة أو أمر بيع مكتبي لا يُلغيه منشئه بنفسه؛
    // بينما الطلبات المحجوزة أو المعلقة بعربون جزئي في نقاط البيع (POS + PENDING / PARTIALLY_PAID)
    // يحق للكاشير إلغاؤها واسترداد العربون للعميل من ورديته المفتوحة مباشرة عند شباك الخدمة.
    if (
      !input.enforceOperationalDecision &&
      actor.role !== "admin" &&
      !actor.isOwner &&
      !(inv.sourceType === "POS" && (inv.status === "PENDING" || inv.status === "PARTIALLY_PAID")) &&
      Number(actor.userId) === Number(inv.createdBy)
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "مرفوض وفق سياسة فصل المهام",
          why: "لا يجوز إلغاء فاتورةٍ أصدرتها بنفسك — يلزم مدير آخر (فصل المهام)",
          doThis: "اطلب من مدير فرع آخر أو مشرف معتمد مراجعة واعتماد طلب الإلغاء",
        }),
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
          message: appErrorMessage({
            what: "تعذر إلغاء الفاتورة",
            why: "الفاتورة مرتبطة بخطة أقساطٍ نشطة — ألغِ الخطة أولاً ثم أعِد المحاولة",
            doThis: "توجّه إلى شاشة إدارة الأقساط وألغِ الخطة أولاً ثم أعِد محاولة إلغاء الفاتورة",
          }),
        });
      }
    }
    // فاتورة أمر شغل: المواد استُهلكت لحظة إنشاء أمر الشغل، وإعادتها للمخزون تخلق مخزوناً وهمياً
    // لمنتج مُخصَّص لا يُباع من الرفّ. مسار إلغاء أمر الشغل يعالج ذلك بشكل صحيح.
    if (inv.sourceType === "WORKORDER") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "مسار الإلغاء غير صحيح",
          why: "لا تُلغى فواتير أوامر الشغل من هنا — استعمل مسار إلغاء أمر الشغل نفسه",
          doThis: "انتقل إلى صفحة أمر الشغل المرتبط ونفّذ إجراء عكس التسليم أو إلغاء الأمر",
        }),
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
        message: appErrorMessage({
          what: "تعذر إلغاء فاتورة الكروت الرقمية",
          why: "الفاتورة تحوي كروتاً رقميّة — استعمل «عكس بيع الكروت» في مسار الكروت الرقمية لا الإلغاء العام",
          doThis: "استخدم إجراء «عكس بيع الكروت» المخصص في وحدة البطاقات الرقمية",
        }),
      });
    }

    // ═══ ٢) الفاتورة يلزمها بندٌ — الإلغاءُ يعمل بإعادة كلّ بندٍ متبقٍّ ═══
    const itemCount = (
      await tx.select({ n: sql<number>`COUNT(*)` }).from(invoiceItems).where(eq(invoiceItems.invoiceId, input.invoiceId))
    )[0];
    if (!Number(itemCount?.n ?? 0)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذر إلغاء الفاتورة",
          why: "الفاتورة بلا بنود — تعذّر الإلغاء",
          doThis: "تحقق من بنود الفاتورة في سجل المبيعات قبل محاولة الإلغاء",
        }),
      });
    }

    // ═══ ٢-ب) البطاقةُ بلا مرجع جهازٍ تُرفض **قبل أيّ أثر** حين يوجد مقبوضٌ يُردّ ═══
    // الإثباتُ لا الإقفال (سياسة القبض ١٦/٨): المرجع هو الأثر الوحيد الذي يربط المبلغَ الخارج من
    // حسابنا البنكيّ بمستنده. منفّذُ الردّ في المحرّك يفرضه أيضاً لكلّ مستدعٍ؛ وهنا يُرفض مبكّراً
    // بلا تجسيدٍ ولا كتابة — والنصّ متعاقَدٌ عليه في `saleCancel.test.ts` (check:message-drift).
    if (input.refundPaymentMethod === "CARD" && !input.reference?.trim()) {
      const refundable = lockedRefundable;
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
    // الأساسُ المستنديّ (total − returnedTotal) لا قيد SALE الخامّ: الأوّل يشمل تقريب IQD فيساوي
    // returnedTotal بعده الإجماليَّ بالضبط — كان الأساسُ الخامّ يترك فارقَ التقريب في العمود.
    const newReturnedTotal = money(inv.returnedTotal ?? "0").plus(summary.remainingDocumentTotal);
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
      ...(directDecision ? { operationalDecision: directDecision } : {}),
    };
}
