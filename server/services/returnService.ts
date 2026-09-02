import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { isDeadInvoiceStatus } from "@shared/invoiceStatus";
import Decimal from "decimal.js";
import { and, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { accountingEntries, customers, deliveryConsignments, deliveryParties, digitalSaleDetails, invoiceItemBundleComponents, inventoryMovements, invoiceItems, invoices, productVariants, products, receipts, shifts, users } from "../../drizzle/schema";
import { classifyVariants } from "./bundleService";
import { localDayStart } from "./dateRange";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "./idempotency";
import { applyMovement } from "./inventoryService";
import { adjustCustomerBalance, adjustSupplierBalance, computeInvoiceStatus, postEntry } from "./ledgerService";
import { createPostingIntent, creditLine, debitLine, signedPostingLines, type AccountRole, type PostingProfile } from "./accounting/postingEngine";
import { money, round2, toDbMoney } from "./money";
import { resolveBranchCashShiftTx, shiftIdForCashTx } from "./shiftService";
import {
  assertCashOutAvailable,
  assertNonPhysicalOutReceipt,
  assertTreasuryOutException,
  lockCashSourceForUpdate,
} from "./cash/cashAvailability";
import { effectiveRefundCap, isSurfacedRefundMethod, loadRefundCaps } from "./returns/refundCaps";
import { withTx, type Actor } from "./tx";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { userNameSnapshot } from "./userSnapshot";
import { classifyGiftPosting } from "./sale/giftPosting";
import { paymentAssetRole } from "./sale/paymentPosting";
import { nextVoucherNumber } from "./voucher/helpers";
import { assertNoActiveInstallmentPlanAfterInvoiceLockTx } from "./installment/guards";
import { assertPeriodOpen } from "./periodLockService";
import { assertLockedInvoiceControlSnapshotTx, type InvoiceControlSnapshot } from "./sale/controlSnapshot";

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";
export type ReturnDisposition = "RESTOCK" | "DAMAGED";

/**
 * تسوية الزبون العابر: قرارٌ صريح مستقلّ عن `refund` التاريخيّ للعملاء المسجّلين.
 * إبقاء `method` في العقد مقصود: تقبل طبقة النقل الحمولة ثم تعطي الخدمة رسالة العمل
 * التوجيهية عند محاولة CARD/تحويل، بدلاً من خطأ enum تقنيّ لا يشرح المسار المتاح.
 */
export interface WalkInReturnResolution {
  kind: "IMMEDIATE_REFUND";
  method: PaymentMethod;
  amount: string;
  shiftId?: number | null;
  reason: string;
  disposition: ReturnDisposition;
}

export interface ReturnLineInput {
  invoiceItemId: number;
  baseQuantity: number;
}
export interface ReturnSaleInput {
  invoiceId: number;
  lines: ReturnLineInput[];
  /** `reference` = مرجع عملية جهاز الدفع، إلزاميّ للردّ بالبطاقة (إثباتٌ لا إقفال). */
  refund?: { amount: string; method: PaymentMethod; shiftId?: number | null; reference?: string | null } | null;
  /** إلزاميّ فقط حين لا تملك الفاتورة customerId؛ النطاق الحالي ردّ CASH فوري كامل. */
  resolution?: WalkInReturnResolution | null;
  restock?: boolean;
  /** Idempotency: نفس المفتاح يُعاد تشغيله بنتيجة المرتجع الأول (لا استرداد/إرجاع مزدوج). */
  clientRequestId?: string | null;
  /** لقطة داخلية من طلب التحكم؛ تُطابَق بعد قفل الفاتورة وقبل أول أثر. */
  controlExpectedSnapshot?: InvoiceControlSnapshot | null;
  /**
   * **تفويضٌ داخليّ حصراً — لا يقبله أيّ راوتر.** عكسُ `correctSale` الكامل قبل إعادة الإصدار.
   * يُعفي من حارس «الزبون العابر يجب أن يُردّ له»: المال هنا لا يُحتجَز بلا طرف، بل يُنقل
   * إلى الفاتورة المصحّحة عبر `preCollected` في نفس المعاملة. بدون هذا الاستثناء كان تصحيح
   * أيّ فاتورةٍ نقديّةٍ لزبونٍ عابر يُرفَض كلّياً.
   */
  internalCorrectionReversal?: boolean;
  /**
   * سببُ المرتجع للعميل **المسجَّل** — يُخزَّن في نصّ قيد RETURN (تصويب مراجعة Codex، P2).
   * `resolution.reason` يخصّ الزبون العابر وحده، فكان سببُ المالك الفوريّ يُتحقَّق منه في
   * الراوتر ثمّ **لا يُخزَّن في أيّ مستندٍ دائم** — يبقى في `logAudit` وحده وهو best-effort.
   */
  operatorReason?: string | null;
}

/** جسم عكس المرتجع داخل معاملةٍ قائمة — يُعاد استعماله من correctSale (تصحيح الفاتورة)
 *  لعكسٍ كاملٍ ذرّيّ بلا فتح معاملةٍ ثانية. الغلاف العام returnSale يبقى بلا تغيير سلوكيّ. */
export async function returnSaleInTx(tx: Tx, input: ReturnSaleInput, actor: Actor) {
    // `refund` يبقى عقد العملاء المسجّلين كما هو. أمّا العابر فـresolution هو مصدر الحقيقة
    // ويُحوَّل داخلياً إلى نفس مسار الإيصال/القيد، فلا ننشئ سكّة مالية ثانية.
    const refund = input.resolution
      ? {
          amount: input.resolution.amount,
          method: input.resolution.method,
          shiftId: input.resolution.shiftId ?? null,
          reference: null,
        }
      : input.refund;
    const resolutionReason = typeof input.resolution?.reason === "string"
      ? input.resolution.reason.trim().replace(/\s+/g, " ")
      // العميلُ المسجَّل: يقبل سبباً صريحاً من المُنفِّذ فيُخزَّن في نصّ القيد كما يُخزَّن سببُ العابر.
      : typeof input.operatorReason === "string" && input.operatorReason.trim().length >= 3
        ? input.operatorReason.trim().replace(/\s+/g, " ").slice(0, 500)
        : null;
    const resolutionDisposition = input.resolution?.disposition ?? null;
    const requestFingerprint = input.clientRequestId ? idempotencyHash(input) : null;
    // Idempotency: تكرار الطلب نفسه يُعاد تشغيله بنتيجة المرتجع الأول بلا استرداد مكرّر.
    // قبل أي replay نتحقّق أنّ المفتاح يخصّ نفس الفاتورة والفرع وبنفس بصمة المرتجع
    // (لا يصحّ أن يُرجع مفتاحٌ مُستعمَلٌ لفاتورة مغايرة نجاحاً صامتاً بـreturnedTotal=0).
    if (input.clientRequestId) {
      const existingRefId = await checkIdempotency(tx, "sale.return", input.clientRequestId, requestFingerprint);
      if (existingRefId != null) {
        if (Number(existingRefId) !== Number(input.invoiceId)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: appErrorMessage({
              what: "تعذّر تسجيل المرتجع",
              // تعارض idempotency: الرقمان يقولان للموظّف أيّ فاتورةٍ أمامه وأيّها سجّلها المفتاح.
              why: `مفتاح هذا الطلب مستعمَلٌ سلفاً لمرتجعٍ على الفاتورة ${Number(existingRefId)}، وأنت تُرجِع من الفاتورة ${Number(input.invoiceId)} — الصفحة على الأرجح مفتوحةٌ منذ مرتجعٍ سابق`,
              doThis: "أغلق الصفحة وافتح المرتجع من الفاتورة التي أمامك من جديد، ثمّ أعِد إدخال الأصناف",
            }),
          });
        }
        const replayInvRows = await tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, input.invoiceId))
          .limit(1);
        const replayInv = replayInvRows[0];
        if (!replayInv) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: appErrorMessage({
              what: "تعذّر إعادة عرض نتيجة المرتجع",
              why: `الفاتورة رقم ${Number(input.invoiceId)} لم تعد موجودة رغم أنّ مفتاح الطلب مسجَّلٌ عليها — حُذفت أو أنّ الرابط يشير إلى قاعدة بيانات أخرى`,
              doThis: "ابحث عن الفاتورة برقمها في قائمة المبيعات؛ وإن لم تظهر فأبلِغ مسؤول النظام بالرقم قبل تكرار المحاولة",
            }),
          });
        }
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
              message: appErrorMessage({
                what: "تعذّر تسجيل المرتجع",
                // تعارض idempotency: نفس المفتاح بأسطرَ مختلفة = عمليةٌ أخرى، لا إعادةَ إرسالٍ للأولى.
                why: `مفتاح هذا الطلب سُجِّل سلفاً بأصنافٍ أخرى: البند ${Number(l.invoiceItemId)} ليس ضمن أصناف الفاتورة ${Number(input.invoiceId)}`,
                doThis: "أغلق الصفحة وافتح مرتجعاً جديداً من الفاتورة، ثمّ اختر الأصناف المطلوبة فيه",
              }),
            });
          }
          if (!Number.isInteger(l.baseQuantity) || l.baseQuantity <= 0) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: appErrorMessage({
                what: "تعذّر تسجيل المرتجع",
                why: `كمية الإرجاع للبند ${Number(l.invoiceItemId)} وصلت «${l.baseQuantity}» — والكمية عددٌ صحيحٌ أكبر من صفر بالوحدة الأساس`,
                doThis: "صحّح الكمية في سطر البند إلى عددٍ صحيحٍ موجب، أو احذف السطر إن لم يكن هناك ما يُرجَع منه",
              }),
            });
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
        // resolution يحمل قيمة العملية الخادمية الدقيقة (ومنها تقريب IQD في المرتجع المُكمِل)،
        // بينما إعادة اشتقاق البنود أعلاه تعطي الخام 1300 لفاتورة إجماليها المقرّب 1250. بصمة
        // idempotency تحرس الحمولة؛ استخدم مبلغ resolution لنتيجة replay ولحدّ التراكم.
        const replayOperationTotal = input.resolution ? money(input.resolution.amount) : expectedTotal;
        // يجب أن يكون التراكمي على الفاتورة شاملاً قيمة هذا المرتجع (وإلا فبصمة الكيان مختلفة).
        const cumulativeReturned = money(replayInv.returnedTotal ?? "0");
        if (cumulativeReturned.lt(replayOperationTotal)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: appErrorMessage({
              what: "تعذّر تسجيل المرتجع",
              // تعارض idempotency رقميّ: الرقمان يُظهران أنّ المفتاح لا يخصّ هذه القيمة.
              why: `مفتاح هذا الطلب سُجِّل سلفاً بقيمةٍ أخرى: المُرجَع فعلياً على الفاتورة ${cumulativeReturned.toFixed(2)} د.ع بينما هذا الطلب قيمته ${replayOperationTotal.toFixed(2)} د.ع`,
              doThis: "افتح الفاتورة وراجع مرتجعاتها المسجَّلة؛ ثمّ سجّل الفرق في مرتجعٍ جديد من الصفحة بدل إعادة إرسال هذا الطلب",
            }),
          });
        }
        const fullyReturnedReplay =
          replayInv.status === "RETURNED" ||
          replayItems.every((r) => (r.returnedBaseQuantity ?? 0) >= r.baseQuantity);
        // رافدا الردّ الفوريّ (نقد/بطاقة) لا يُنشئان سنداً معلَّقاً ⇒ لا مرجعَ معلَّقاً يُبحَث عنه.
        const pendingReference = refund && !isSurfacedRefundMethod(refund.method)
          ? `SALE-RETURN-PENDING-${input.invoiceId}-${requestFingerprint?.slice(0, 12)}`
          : null;
        const replayRefund = pendingReference
          ? (await tx.select({
              amount: receipts.amount,
              status: receipts.status,
              approvalStatus: receipts.approvalStatus,
              voucherNumber: receipts.voucherNumber,
            }).from(receipts).where(and(
              eq(receipts.invoiceId, input.invoiceId),
              eq(receipts.referenceNumber, pendingReference),
              eq(receipts.direction, "OUT"),
            )).orderBy(sql`${receipts.id} DESC`).limit(1))[0]
          : undefined;
        return {
          invoiceId: input.invoiceId,
          returnedTotal: replayOperationTotal.toFixed(2),
          fullyReturned: fullyReturnedReplay,
          pendingRefundAmount: replayRefund?.status === "PENDING" && replayRefund.approvalStatus === "PENDING_APPROVAL"
            ? money(replayRefund.amount).toFixed(2)
            : "0.00",
          pendingRefundVoucherNumber: replayRefund?.voucherNumber ?? null,
          idempotentReplay: true as const,
        };
      }
    }

    // CASH refund must lock its drawer before the invoice and any consignment supplier.
    // Voucher approval uses source→party; doing invoice/consignor→source here creates the inverse.
    const invPreview = (
      await tx.select({ branchId: invoices.branchId }).from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1)
    )[0];
    if (!invPreview) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر فتح المرتجع",
          why: `لا فاتورة بالرقم ${Number(input.invoiceId)} في النظام — الرابط قديم أو الرقم المُدخَل ليس رقم الفاتورة`,
          doThis: "ابحث عن الفاتورة برقمها المطبوع على الإيصال من قائمة المبيعات، وافتح المرتجع من صفحتها",
        }),
      });
    }
    if (actor.role !== "admin" && Number(invPreview.branchId) !== Number(actor.branchId)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر تسجيل المرتجع",
          // «الفاتورة لا تخصّ فرعك» وحدَها كانت تقف هنا: صحيحةٌ والزبون واقفٌ ولا بديل.
          why: `الفاتورة صادرة من الفرع ${Number(invPreview.branchId)} وأنت على الفرع ${Number(actor.branchId)} — والمرتجع يُخرِج نقداً من صندوق الفرع الذي باع`,
          doThis: "أحِل الزبون إلى الفرع الذي أصدر الفاتورة، أو اطلب من المدير تنفيذ المرتجع فصلاحيتُه تعبر الفروع",
        }),
      });
    }
    const deliveryPreview = (
      await tx
        .select({
          id: deliveryConsignments.id,
          partyId: deliveryConsignments.partyId,
          branchId: deliveryConsignments.branchId,
          invoiceId: deliveryConsignments.invoiceId,
        })
        .from(deliveryConsignments)
        .where(eq(deliveryConsignments.invoiceId, input.invoiceId))
        .limit(1)
    )[0] ?? null;
    /**
     * ⭐ **مصدرُ النقد الخارج: درجٌ مفتوح، وإلّا الخزينةُ للإداريّ** (تدقيق ١/٩/٢٦).
     *
     * كان المسار يقفل `DRAWER` **ثابتاً** ويشترط ورديةً مفتوحة، فخارج ساعات الوردية يُحجَب
     * المرتجعُ كلّياً — وهو أكثر أنواعه شيوعاً في مكتبة تجزئة (زبونٌ عابر نقديّ يعود مساءً).
     * فيدفع الموظّف من جيبه ويسجّل غداً، وهو المسار الذي يُنتج النقد اليتيم والعجز في Z-report.
     *
     * نظيرُه `cancelSaleInTx` كان محقّاً: `shiftIdForCashTx` يعطي الدرجَ إن وُجد، وإلّا
     * `TREASURY` للمدير/الأدمن، محروساً بـ`assertTreasuryOutException`. ومفتاحُ المرتجع
     * `SALE_RETURN_COMPENSATION` كان **معرَّفاً في السياسة وبلا مستدعٍ واحد** — مخرجٌ مبنيٌّ
     * وغير موصول. هذا يوصله.
     *
     * **حدودُ التوسيع مقصودة وضيّقة:**
     *  · اختيارٌ صريح للدرج (`refund.shiftId`) ⇒ السلوك القديم حرفياً (يفشل إن أُقفل) — الموظّف
     *    قصد درجاً بعينه فلا نُبدّله من تحته.
     *  · وردياتٌ مفتوحة موجودة ⇒ السلوك القديم حرفياً (واحدة تُختار، وتعدّدُها يطلب تحديداً).
     *  · **صفرُ ورديات + فاعلٌ إداريّ** ⇒ الخزينة. وحدها الحالةُ التي كانت تفشل تغيّرت.
     *  · كاشيرٌ بلا وردية ⇒ يبقى مرفوضاً (حمايةُ النقد اليتيم الحقيقيّ).
     *
     * و`cashBucket = TREASURY` **لا يدخل `computeExpectedCash`** لأيّ وردية ⇒ تسويةُ الدرج تبقى
     * دقيقة، والصرفُ يظهر في تقرير الخزينة الإداريّة بقيدِ `TREASURY_CASH` لا `CASH`.
     */
    let prelockedRefundSource: {
      shiftId: number | null;
      cashBucket: "DRAWER" | "TREASURY";
    } | null = null;
    if (refund?.method === "CASH" && money(refund.amount).gt(0)) {
      const branchForRefund = Number(invPreview.branchId);
      const explicitShiftId = refund.shiftId ?? null;
      const openShiftCount = explicitShiftId != null
        ? 1
        : (await tx
            .select({ id: shifts.id })
            .from(shifts)
            .where(and(eq(shifts.branchId, branchForRefund), eq(shifts.status, "OPEN")))
          ).length;
      if (explicitShiftId != null || openShiftCount > 0) {
        const resolved = await resolveBranchCashShiftTx(tx, branchForRefund, explicitShiftId);
        prelockedRefundSource = { shiftId: resolved.shiftId, cashBucket: "DRAWER" };
      } else {
        // بلا ورديةٍ مفتوحة: `shiftIdForCashTx` يقرّر بالدور — خزينةٌ للإداريّ، ورفضٌ للكاشير.
        const routed = await shiftIdForCashTx(
          tx,
          { userId: actor.userId, branchId: branchForRefund, role: actor.role },
          branchForRefund,
          "استرداد مرتجع البيع نقداً",
        );
        prelockedRefundSource = routed;
      }
      await lockCashSourceForUpdate(tx, {
        branchId: branchForRefund,
        cashBucket: prelockedRefundSource.cashBucket,
        shiftId: prelockedRefundSource.shiftId,
      });
    }
    // مسارات التوصيل تتشارك ترتيباً واحداً بعد المصدر: party→consignment→invoice.
    // بدونه يمسك التوريد الإرسالية ثم ينتظر الفاتورة بينما المرتجع يمسك الفاتورة ثم ينتظرها.
    if (deliveryPreview) {
      const party = (
        await tx.select({ id: deliveryParties.id }).from(deliveryParties)
          .where(eq(deliveryParties.id, Number(deliveryPreview.partyId))).for("update").limit(1)
      )[0];
      if (!party) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر تسجيل المرتجع",
            why: `الفاتورة مرتبطة بإرسالية توصيلٍ جهتُها (رقم ${Number(deliveryPreview.partyId)}) لم تعد موجودة في سجلّ جهات التوصيل`,
            doThis: "افتح صفحة جهات التوصيل وأعِد إنشاء الجهة أو أعِد ربط الإرسالية بجهةٍ قائمة، ثمّ أعِد المرتجع — لا تُترك بضاعةٌ راجعة بلا جهةٍ منسوبةٍ إليها",
          }),
        });
      }
      const lockedDelivery = (
        await tx.select({
          id: deliveryConsignments.id,
          partyId: deliveryConsignments.partyId,
          branchId: deliveryConsignments.branchId,
          invoiceId: deliveryConsignments.invoiceId,
        }).from(deliveryConsignments)
          .where(eq(deliveryConsignments.id, Number(deliveryPreview.id))).for("update").limit(1)
      )[0];
      if (
        !lockedDelivery ||
        Number(lockedDelivery.partyId) !== Number(deliveryPreview.partyId) ||
        Number(lockedDelivery.branchId) !== Number(deliveryPreview.branchId) ||
        Number(lockedDelivery.invoiceId) !== Number(input.invoiceId)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر تسجيل المرتجع",
            why: "إرسالية التوصيل المرتبطة بالفاتورة تغيّرت في اللحظة نفسها (جهةٌ أو فرعٌ أو فاتورةٌ أخرى) — موظّفٌ آخر يعمل على الطرد الآن",
            doThis: "انتظر ثوانيَ ثمّ اضغط «إرجاع» مرّةً أخرى؛ وإن تكرّر الرفض فراجع صفحة التوصيل لتعرف من يعمل على الإرسالية",
          }),
        });
      }
    } else {
      // locking gap/current read يمنع إسناد إرسالية جديدة بين المعاينة وقفل الفاتورة.
      await tx.select({ id: deliveryConsignments.id }).from(deliveryConsignments)
        .where(eq(deliveryConsignments.invoiceId, input.invoiceId)).for("update");
    }

    const invRows = await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).for("update").limit(1);
    const inv = invRows[0];
    if (!inv) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر تسجيل المرتجع",
          why: `الفاتورة ${Number(input.invoiceId)} اختفت بين فتح الشاشة وتنفيذ المرتجع — أُلغيت أو حُذفت في هذه اللحظة`,
          doThis: "حدّث قائمة المبيعات وابحث عن الفاتورة برقمها؛ فإن لم تظهر فلا مرتجعَ عليها وأبلِغ المدير بما استلمه الزبون",
        }),
      });
    }
    if (Number(inv.branchId) !== Number(invPreview.branchId)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر تسجيل المرتجع",
          why: `فرع الفاتورة تغيّر أثناء تنفيذ المرتجع: كان ${Number(invPreview.branchId)} وصار ${Number(inv.branchId)} — نُقلت الفاتورة بين الفروع في اللحظة نفسها`,
          doThis: "اضغط «إرجاع» مرّةً أخرى ليُعاد الحساب على الفرع الجديد؛ ولا تُكرّر المحاولة أكثر من مرّتين قبل مراجعة المدير",
        }),
      });
    }
    await assertLockedInvoiceControlSnapshotTx(tx, inv, input.controlExpectedSnapshot);
    // المرتجع يغيّر الفاتورة وبنودها والمخزون والذمم تاريخياً. قيدٌ بتاريخ اليوم لا
    // يبرر إعادة كتابة حقيقة فاتورة داخل شهر مقفل؛ التصحيح السابق يجب أن يمر بمسار
    // prior-period adjustment مستقل بدلاً من تعديل المستند الأصلي.
    await assertPeriodOpen(tx, inv.invoiceDate);
    // المُستبدَلة كانت محجوبةً **بالمصادفة** لا بالتصميم: التصحيح يعكس كل الأسطر فيصير المتبقّي
    // صفراً، فيسقط الطلب برسالة «كمية الإرجاع تتجاوز المتبقّي للبند ####» — رحلةٌ تنتهي بخطأ
    // تقنيّ غامض بدل توجيهٍ صريح. ولو أُضيف بندٌ بعد التصحيح لتغيّر الحساب وسقط الدفاع.
    if (isDeadInvoiceStatus(inv.status)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          inv.status === "SUPERSEDED"
            ? appErrorMessage({
                what: `تعذّر الإرجاع من الفاتورة ${inv.invoiceNumber}`,
                why: "الفاتورة مستبدَلة بفاتورة مصحّحة، وبنودها مُعادةٌ كلّها فيها — فلا متبقّي عليها يُرجَع",
                doThis: "افتح الفاتورة المصحّحة (تجدها في سجلّ الفاتورة الأصلية تحت «استُبدلت بـ») وسجّل المرتجع منها",
              })
            : appErrorMessage({
                what: `تعذّر الإرجاع من الفاتورة ${inv.invoiceNumber}`,
                why: inv.status === "CANCELLED"
                  ? "الفاتورة ملغاة: البيع عُكس بالكامل سلفاً — إيراداً وبضاعةً وذمّة — فلا شيء عليها يُرجَع"
                  : "الفاتورة مرتجعة بالكامل: كلّ بنودها أُعيدت في مرتجعٍ سابق فلم يبقَ متبقٍّ",
                doThis: inv.status === "CANCELLED"
                  ? "راجع سجلّ الفاتورة لتعرف ما استُرِدّ للزبون فعلاً؛ وإن كان بيده بضاعة فسجّل له فاتورةً جديدة ثمّ أرجِع منها"
                  : "راجع مرتجعات الفاتورة في سجلّها للتأكّد ممّا استُرِدّ؛ وإن كان بيد الزبون صنفٌ زائد فأبلِغ المدير",
              }),
      });
    }
    // G8 (١٩/٦/٢٦): فحص ملكية الفرع — managerProcedure يسمح بالمدير والأدمن، لكن مدير فرع لا
    // يجوز له إصدار مرتجع على فاتورة فرع آخر (يخرج نقد من صندوقه لفاتورة لا تخصّه).
    if (actor.role !== "admin" && Number(inv.branchId) !== Number(actor.branchId)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: `تعذّر الإرجاع من الفاتورة ${inv.invoiceNumber}`,
          why: `الفاتورة تخصّ الفرع ${Number(inv.branchId)} وأنت على الفرع ${Number(actor.branchId)} — ونقدُ المرتجع يخرج من صندوق الفرع البائع لا من صندوقك`,
          doThis: "أحِل الزبون إلى الفرع الذي أصدر الفاتورة، أو اطلب من المدير تنفيذ المرتجع فصلاحيتُه تعبر الفروع",
        }),
      });
    }
    await assertNoActiveInstallmentPlanAfterInvoiceLockTx(tx, {
      invoiceId: input.invoiceId,
      operationLabel: "إرجاع الفاتورة كلياً أو جزئياً",
    });
    const isWalkInReturn = inv.customerId == null && !input.internalCorrectionReversal;
    if (isWalkInReturn) {
      const resolution = input.resolution;
      if (!resolution) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "تعذّر تسجيل مرتجع زبونٍ عابر",
            why: "الفاتورة بلا عميلٍ مسجَّل، ولم يصل معها قرارُ التسوية (resolution) الذي يحدّد ردّ CASH نقداً كاملاً مع سبب المرتجع ومصير البضاعة — وبلا ذلك يبقى مالُ الزبون في الدرج بلا ذمّةٍ تحمله ولا طرفٍ يُنسَب إليه",
            doThis: "أدخِل الردّ النقديّ الكامل والسبب ومصير البضاعة في شاشة المرتجع؛ وإن كان المطلوب رصيداً أو مساراً آخر فسجّل الزبون عميلاً أوّلاً ثمّ أعِد المرتجع من فاتورته",
          }),
        });
      }
      if (input.refund != null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر تسجيل مرتجع زبونٍ عابر",
            why: "الردّ وصل مرّتين في الطلب نفسه: في حقل الاسترداد العام وفي تسوية الزبون العابر معاً — وقبولُهما يفتح باب صرفٍ مزدوج من الدرج",
            doThis: "أدخِل الردّ النقديّ الكامل في تسوية الزبون العابر وحدها، واترك حقل الاسترداد العام فارغاً",
          }),
        });
      }
      if (resolution.kind !== "IMMEDIATE_REFUND" || resolution.method !== "CASH") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "تعذّر تسجيل مرتجع زبونٍ عابر",
            why: `طريقة الردّ المطلوبة «${resolution.method}» غير متاحة لزبونٍ بلا حساب — المسار الوحيد ردّ CASH نقداً فوريّاً كامل فقط: لا بطاقة ولا تحويل ولا رصيد معلّق، فالعابر لا ذمّةَ له تستوعب الفرق`,
            doThis: "بدّل طريقة الردّ إلى النقد وسلّم الزبون مبلغه من الدرج؛ وإن أصرّ على مسارٍ آخر فسجّله عميلاً أوّلاً ثمّ أعِد المرتجع من فاتورته",
          }),
        });
      }
      /**
       * الدرجُ صار **اختيارياً** للزبون العابر (تدقيق ١/٩/٢٦): اشتراطُه حرفياً كان يحجب
       * مرتجعَ العابر النقديّ خارج ساعات الوردية حجباً كاملاً — وهو أكثر أنواع المرتجعات
       * شيوعاً في مكتبة تجزئة. حين لا يُحدَّد، يقرّر `shiftIdForCashTx` بالدور: درجٌ مفتوح
       * إن وُجد، وإلّا الخزينةُ للإداريّ، ورفضٌ للكاشير (النقد اليتيم يبقى ممنوعاً).
       * وحين يُحدَّد يبقى الشرطُ الصارم: رقمٌ صحيحٌ موجبٌ لوردية مفتوحة فعلاً.
       */
      if (resolution.shiftId != null
        && (!Number.isInteger(resolution.shiftId) || Number(resolution.shiftId) <= 0)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "تعذّر تسجيل مرتجع زبونٍ عابر",
            why: `رقم الوردية المحدَّد لصرف الردّ «${String(resolution.shiftId)}» ليس عدداً صحيحاً موجباً`,
            doThis: "اترك حقل الوردية فارغاً ليختار النظام الدرج المفتوح تلقائياً، أو اختر الوردية من القائمة بدل كتابة رقمها يدوياً",
          }),
        });
      }
      if ((resolution.reason?.trim().length ?? 0) < 3) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر تسجيل مرتجع زبونٍ عابر",
            why: `سبب المرتجع إلزاميّ ولا يقلّ عن 3 أحرف — الوارد ${resolution.reason?.trim().length ?? 0} حرفاً؛ وهو المستند الوحيد على سبب خروج النقد من الدرج`,
            doThis: "اكتب السبب كما قاله الزبون: «مقاس غير مناسب» أو «صنف مختلف عن المطلوب» أو «عيب في المنتج»",
          }),
        });
      }
      if (resolution.reason.trim().length > 500) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر تسجيل مرتجع زبونٍ عابر",
            why: `سبب المرتجع أطول من الحدّ المسموح: ${resolution.reason.trim().length} حرفاً والحدّ 500`,
            doThis: "اختصر السبب في سطرٍ واحد يذكر الصنف والعلّة، وضع التفصيل الطويل في ملاحظات الفاتورة",
          }),
        });
      }
      if (resolution.disposition !== "RESTOCK" && resolution.disposition !== "DAMAGED") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر تسجيل مرتجع زبونٍ عابر",
            why: `مصير البضاعة المُرسَل «${String(resolution.disposition)}» ليس أحد الخيارين المقبولين: تعود للرفّ أو تالفة`,
            doThis: "اختر «تعود للرف» إن كانت البضاعة سليمةً تُباع مرّةً أخرى، أو «تالفة» إن لم تعد صالحة — الخيار يقرّر هل تُعاد للمخزون أم تُسجَّل خسارة",
          }),
        });
      }
      if (input.restock != null && input.restock !== (resolution.disposition === "RESTOCK")) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر تسجيل مرتجع زبونٍ عابر",
            why: `مصير البضاعة وصل بقيمتين متعارضتين: «${input.restock ? "تعود للرف" : "لا تعود للرف"}» في حقل إعادة التخزين، و«${resolution.disposition === "RESTOCK" ? "تعود للرف" : "تالفة"}» في تسوية الزبون العابر`,
            doThis: "احذف حقل إعادة التخزين من الطلب واترك القرار في تسوية الزبون العابر وحدها — هي المصدر المعتمَد لمصير بضاعته",
          }),
        });
      }
      if (inv.sourceType === "WORKORDER" && resolution.disposition === "RESTOCK") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر تسجيل مرتجع طلب الخدمة",
            why: "مُنتَج أمر الشغل مصنوعٌ لهذا الزبون بعينه ولا رصيد له على الرفّ — موادُه استُهلكت عند بدء التنفيذ، فإعادته للمخزون تُنشئ رصيداً وهمياً لصنفٍ مخصَّص",
            doThis: "اختر «تالف/لا يعود للمخزون» في مصير البضاعة ثمّ أعِد التسجيل — الردّ الماليّ للزبون يتمّ كاملاً على أيّ حال",
          }),
        });
      }
    } else if (input.resolution && !input.internalCorrectionReversal) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تسجيل المرتجع",
          why: "تسوية الزبون العابر مخصَّصة للفواتير بلا عميل، وهذه الفاتورة مرتبطة بعميلٍ مسجَّل له ذمّةٌ تستوعب المبلغ",
          doThis: "استعمل حقل الاسترداد المعتاد لتردّ نقداً أو بطاقة، أو اتركه فارغاً ليُخصَم المبلغ من ذمّة العميل",
        }),
      });
    }

    /**
     * فاتورة أمر الشغل تبيع متغيّراً أساس لم يُضَف للمخزون فعلاً (المواد استُهلكت عند البدء
     * على `workOrderMaterials`)، فإعادة التخزين تخلق مخزوناً وهمياً لمنتج مُخصَّص.
     * افرض `restock=false` لها.
     *
     * ⚠️ **عطبٌ كامنٌ موثَّقٌ عمداً (تدقيق ١/٩/٢٦ — ولا تُصلحه بتقييمٍ سطريّ وحده):**
     * الإجبارُ على مستوى **الفاتورة** لا السطر، فأوّلُ بندٍ مخزنيّ يُضاف إلى فاتورة أمر شغل
     * سيُبتلَع: يُسجَّل مُرجَعاً مالياً ولا يعود للرفّ ولا تُعكَس تكلفتُه.
     *
     * وهو **غير قابلٍ للوقوع اليوم**: مواضعُ `insert(invoiceItems)` لمسار WORKORDER
     * (`workOrder/deliver.ts` و`delivery/dispatch.ts`) تُدرج **بنداً واحداً** هو
     * `wo.baseVariantId` الذي لم يُخصَم من المخزون أصلاً.
     *
     * ⛔ **ولا يكفي جعلُ القرار سطرياً**: جُرّب في هذه الشريحة فكشف قيدَين لا يُتجاوزان بلا
     * قرارٍ محاسبيّ صريح (أمسكهما Codex على PR #932):
     *  ① **لا profile يقبل الحالة**: `RETURN_SALE_FLEX` (المُختار لكلّ فواتير WORKORDER أدناه)
     *    يقبل `SALES_FLEX/DELIVERY_REVENUE/TAX_PAYABLE` مديناً و`AR` دائناً — بلا
     *    `INVENTORY`/`COGS`. و`RETURN_SALE_FLEX_WORKORDER` يقبل `COGS` دائناً لكنّ مدينَه
     *    `WORK_IN_PROGRESS` لا `INVENTORY` (المادّة تعود لقيد التشغيل لا للبضاعة الجاهزة).
     *    ⇒ إعادةُ سطرٍ مخزنيّ على فاتورة أمر شغل تُصدر `INVENTORY/COGS` فيرفضها التحقّق حين
     *    يكون الدفتر المزدوج ACTIVE. الإصلاحُ الصحيح يبدأ من **profile** يمثّل الحالة، لا من
     *    توسيع profile قائمٍ بأدوار مخزون.
     *  ② **إعادةُ استحقاق الأمانة** (`if (!restock)` أدناه) invoice-wide كذلك؛ فسطرُ أمانةٍ
     *    لم يَعُد بينما `restock=true` كان يفقد إعادةَ استحقاقه ⇒ نقصٌ دائمٌ في ذمّة المودِع.
     * ⇒ أيّ إصلاحٍ لاحق يلزمه الثلاثة معاً: profile + إعادة استحقاقٍ لكلّ مودِعٍ على حدة +
     *   تقييمٌ سطريّ. وليس مستعجَلاً ما دامت الحالة غير قابلةٍ للوقوع.
     */
    const requestedRestock = input.resolution
      ? input.resolution.disposition === "RESTOCK"
      : input.restock !== false;
    const restock = inv.sourceType === "WORKORDER" ? false : requestedRestock;
    if (!input.lines.length) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تسجيل المرتجع",
          why: "لم يُحدَّد أيّ صنفٍ للإرجاع — الطلب وصل بقائمة أصنافٍ فارغة",
          doThis: "حدّد الأصناف التي يعيدها الزبون وكمّية كلٍّ منها في جدول الفاتورة، ثمّ اضغط «إرجاع»",
        }),
      });
    }

    // RETURN-DEDUP (تدقيق ٢/٧): منع تكرار invoiceItemId في أسطر المرتجع. كان الفحص يقارن كل سطر
    // بـremaining من لقطةٍ ثابتة، فسطران بنفس البند [{6},{6}] يمرّان كلاهما ⇒ إعادة تخزين مضاعفة
    // (applyMovement مرّتين) وقيمة مرتجع تتجاوز الفاتورة (returnedTotal > total) وذمّة/نقد مسرَّبان.
    const seenItemIds = new Set<number>();
    for (const l of input.lines) {
      if (seenItemIds.has(l.invoiceItemId)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر تسجيل المرتجع",
            why: `البند ${Number(l.invoiceItemId)} مذكورٌ أكثر من مرّة في أسطر المرتجع — وتمريرُه مرّتين يُعيد كمّيته للمخزون مرّتين ويصرف قيمتها مرّتين`,
            doThis: "احذف السطر المكرّر واجمع الكمّيتين في سطرٍ واحد لهذا البند",
          }),
        });
      }
      seenItemIds.add(l.invoiceItemId);
    }

    const items = await tx.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, input.invoiceId));
    const itemById = new Map(items.map((i) => [Number(i.id), i]));

    // البطاقات الرقمية ش١٢: **حظر المرتجع العام** على أي بندٍ رقميّ. الكرت صدر من جهاز المزوّد
    // وقد يكون استُهلك؛ إعادته ليست إعادةَ بضاعة إلى الرفّ بل عكسٌ ماليّ يحتاج تأكيد المزوّد
    // (أو تحميل الخسارة على المكتبة). المسار الوحيد: digitalCards.reversal بقرارٍ إداريّ.
    const digitalRows = await tx
      .select({ invoiceItemId: digitalSaleDetails.invoiceItemId })
      .from(digitalSaleDetails)
      .where(eq(digitalSaleDetails.invoiceId, input.invoiceId));
    if (digitalRows.length) {
      const digitalItemIds = new Set(digitalRows.map((r) => Number(r.invoiceItemId)));
      const blocked = input.lines.filter((l) => digitalItemIds.has(l.invoiceItemId));
      if (blocked.length) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر تسجيل المرتجع",
            why: `الفاتورة تحوي ${blocked.length} بنداً من الكروت الرقمية، والكرت يصدر من جهاز المزوّد وقد يكون استُهلك — فإعادته عكسٌ ماليّ يحتاج تأكيد المزوّد لا إعادةَ بضاعةٍ إلى الرفّ`,
            doThis: "أزِل بنود الكروت من هذا المرتجع وأرجِع بقيّة الأصناف؛ ثمّ افتح شاشة «عكس بيع الكروت» ليقرّرها المدير مع المزوّد",
          }),
        });
      }
    }

    const work = input.lines.map((l) => {
      const item = itemById.get(l.invoiceItemId);
      if (!item) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر تسجيل المرتجع",
            why: `البند ${Number(l.invoiceItemId)} ليس من بنود الفاتورة ${inv.invoiceNumber} — الصفحة على الأرجح مفتوحةٌ على فاتورةٍ أخرى أو حُذف البند بعد فتحها`,
            doThis: "حدّث صفحة الفاتورة واختر الأصناف من جدولها من جديد، ثمّ أعِد تسجيل المرتجع",
          }),
        });
      }
      if (!Number.isInteger(l.baseQuantity) || l.baseQuantity <= 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر تسجيل المرتجع",
            why: `كمية الإرجاع للبند ${Number(l.invoiceItemId)} وصلت «${l.baseQuantity}» — والكمية عددٌ صحيحٌ أكبر من صفر بالوحدة الأساس (لا كسور ولا صفر)`,
            doThis: "صحّح الكمية إلى عددٍ صحيحٍ موجب، أو احذف السطر إن لم يُرجِع الزبون شيئاً من هذا الصنف",
          }),
        });
      }
      const remaining = item.baseQuantity - (item.returnedBaseQuantity ?? 0);
      if (l.baseQuantity > remaining) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          // ⭐ الزبون واقف: الرقمُ الذي يحتاجه الموظّف هو **المتبقّي**، وكان عليه أن يفتح
          //   الفاتورة ومرتجعاتها ليحسبه بنفسه. الفرق واتّجاهه هنا في نصّ الرسالة.
          message: appErrorMessage({
            what: "تعذّر تسجيل المرتجع",
            why: `المطلوب إرجاعه من البند ${Number(l.invoiceItemId)} هو ${l.baseQuantity} والمتبقّي القابل للإرجاع ${remaining} فقط (المُباع ${item.baseQuantity} · المُرجَع سابقاً ${item.returnedBaseQuantity ?? 0}) — زيادة ${l.baseQuantity - remaining}`,
            doThis: `أنقص الكمية إلى ${remaining} أو أقلّ؛ وإن كان بيد الزبون أكثر من ذلك فراجع مرتجعات الفاتورة في سجلّها قبل استلام الزيادة`,
          }),
        });
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
    // هدايا الفاتورة (0149): تكلفة البنود المُهداة المُرجَعة تُجمَع **منفصلةً**. تكلفتها لم تدخل قيد
    // SALE أصلاً (دخلت قيد GIFT_OUT)، فعكسُها داخل قيد RETURN يُلغي تكلفةً لم تُسجَّل هناك قطّ ⇒
    // ربحٌ منفوخ من العدم. تُعكَس في قيد GIFT_OUT سالبٍ أدناه — كلٌّ يُعكَس في وعائه.
    let returnedGiftCost = new Decimal(0);

    // bundles (٧/٧/٢٦): إن كان أحد البنود المُرجَعة بكجاً، لا نطبّق applyMovement على البكج نفسه
    // (لا branchStock له) — نُوسّع مكوّناته من الوصفة الحالية ونعيدها للمخزون. تجميع لكل المتغيّرات
    // (بمن فيهم مكوّنات البكج + السلع العادية) قبل التطبيق كي يحافظ على ترتيب القفل الحتميّ.
    // ⚠️ ملاحظة توثيقية: التوسيع يستعمل **الوصفة الحالية** للبكج (قد تختلف عن وصفة يوم البيع إن عُدّلت).
    // gstack B6 (٧/٧/٢٦): نستعمل **لقطة المكوّنات** (`invoiceItemBundleComponents`) المحفوظة لحظة
    // البيع بدل `bundleComponents` الحيّة — تعديل الوصفة بين البيع والإرجاع لا يُلوّث المرتجع.
    // اللقطة موجودة لكل invoiceItem بكج (يفرضه sale/create.ts). للفواتير القديمة (قبل هجرة 0060)
    // اللقطة غائبة ⇒ نرفض المرتجع الآلي برسالة صريحة (لا نسقط بصمت للوصفة الحيّة، دفاع صريح).
    const returnedVariantIds = Array.from(new Set(items.map((item) => Number(item.variantId))));
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
      // سطر الهدية: `item.total` صفر ⇒ لا إيراد يُعكَس (لا استرداد نقديّ — لم يُدفع شيء)، وتكلفته
      // تذهب لوعاء الهدايا لا لوعاء COGS.
      const lineCost = round2(money(item.unitCost).times(line.baseQuantity));
      if (item.isGift) returnedGiftCost = returnedGiftCost.plus(lineCost);
      else returnedCost = returnedCost.plus(lineCost);

      const itemVariantId = Number(item.variantId);
      const kind = kindByVariant.get(itemVariantId) ?? "STOCKED";
      if (restock) {
        if (kind === "BUNDLE") {
          // gstack B6: نقرأ اللقطة المحفوظة على invoiceItem بدل الوصفة الحيّة.
          const def = snapshotByItem.get(Number(item.id)) ?? [];
          if (!def.length) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: appErrorMessage({
                what: "تعذّر إرجاع البكج إلى المخزون",
                why: `البند ${Number(item.id)} بكجٌ بِيع قبل 7/7/2026 ولا لقطة محفوظة لمكوّناته وقتَها — وإعادتُه بوصفة اليوم قد تُعيد للمخزون غير ما خرج منه`,
                doThis: "ألغِ هذا السطر من المرتجع، وأرجِع مكوّنات البكج فرادى بأصنافها وكمّياتها كما استلمتها من الزبون",
              }),
            });
          }
          for (const c of def) {
            stockOps.push({
              variantId: c.componentVariantId,
              baseQuantity: c.componentBaseQuantity * line.baseQuantity,
            });
          }
        } else if (kind === "SERVICE") {
          // ١٨/٨: **الخدمة لا تعود للمخزون** — لا رصيد لها أصلاً (طباعة، تجليد، تصميم). كانت
          // تُكتب لها حركة RETURN ورصيدٌ في `branchStock` من العدم: مخزونٌ وهميّ يتضخّم مع كل
          // مرتجع فاتورة طباعة، ويسمّم WAVG وتقارير المخزون. لا شيء يُضاف لـstockOps.
          // (الإيراد والذمّة والقيد تُعكَس كالمعتاد — العكس ماليٌّ لا مخزنيّ.)
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
    // هدايا الفاتورة (0149): مرآةُ القاعدة نفسها على وعاء الهدايا — الهديةُ العائدة إلى الرفّ
    // (restock=true) يُعكَس مصروفها، والتالفةُ/غير العائدة تبقى مصروفاً (البضاعة ذهبت فعلاً).
    returnedGiftCost = round2(returnedGiftCost);
    const reversedGiftCost = restock ? returnedGiftCost : new Decimal(0);

    // RETURN ledger entry: negative values + منفّذ مستقلّ عن بائع الفاتورة.
    const consignByVariant = new Map<number, number>();
  const digitalVariants = new Set<number>();
  const returnVariantIds = Array.from(new Set(work.map((w) => Number(w.item.variantId))));
  if (returnVariantIds.length) {
        const crows = await tx
          .select({ vid: productVariants.id, isConsign: products.isConsignment, cId: products.consignorId,
        productType: products.productType,
      })
          .from(productVariants).innerJoin(products, eq(productVariants.productId, products.id))
          .where(inArray(productVariants.id, returnVariantIds));
        for (const row of crows) {
      if (row.isConsign && row.cId != null) consignByVariant.set(Number(row.vid), Number(row.cId));
      if (row.productType === "DIGITAL_CARD") digitalVariants.add(Number(row.vid));
    }
  }
  const byConsignor = new Map<number, { paid: Decimal; gift: Decimal }>();
  let returnedServicePaidCost = new Decimal(0);
  let returnedServiceGiftCost = new Decimal(0);
        for (const { line, item } of work) {
          const share = round2(money(item.unitCost).times(line.baseQuantity));
    const cId = consignByVariant.get(Number(item.variantId));
          if (cId != null) {
      const current = byConsignor.get(cId) ?? {
        paid: new Decimal(0),
        gift: new Decimal(0),
      };
      if (item.isGift) current.gift = current.gift.plus(share);
      else current.paid = current.paid.plus(share);
      byConsignor.set(cId, current);
    } else if (kindByVariant.get(Number(item.variantId)) === "SERVICE") {
      if (item.isGift) returnedServiceGiftCost = returnedServiceGiftCost.plus(share);
      else returnedServicePaidCost = returnedServicePaidCost.plus(share);
    }
  }
  const consignmentPaidShare = round2(Array.from(byConsignor.values()).reduce((sum, split) => sum.plus(split.paid), new Decimal(0)));
  const consignmentGiftShare = round2(Array.from(byConsignor.values()).reduce((sum, split) => sum.plus(split.gift), new Decimal(0)));
  const ownedReversedCost = restock ? round2(Decimal.max(new Decimal(0), reversedCost.minus(consignmentPaidShare).minus(returnedServicePaidCost))) : new Decimal(0);
  const ownedReversedGiftCost = restock ? round2(Decimal.max(new Decimal(0), reversedGiftCost.minus(consignmentGiftShare).minus(returnedServiceGiftCost))) : new Decimal(0);
  // الخدمة لا تعود مخزوناً عند restock؛ لا نعكس هديتها لأن موادها المستهلكة لم تعد للرف.
  const financiallyReversedGiftCost = restock ? round2(Decimal.max(new Decimal(0), reversedGiftCost.minus(returnedServiceGiftCost))) : new Decimal(0);

  // RETURN ledger entry: negative values + منفّذ مستقلّ عن بائع الفاتورة.
  const returnOperatorName = await userNameSnapshot(tx, actor.userId);
  const deliveryRevenueReversal = fullyReturned ? round2(money(inv.deliveryFee ?? "0")) : new Decimal(0);
  const sectorRevenueReversal = round2(returnedRevenue.minus(deliveryRevenueReversal));
  const returnAccountingAmount = round2(returnedRevenue.plus(returnedTax));
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
  const returnClasses = new Set<"DIGITAL" | "SERVICE" | "CONSIGNMENT" | "INVENTORY">();
  let allocatedReturnRevenue = money(0);
  let balancingRole: AccountRole | null = null;
  for (const { line, item } of work) {
    const lineRevenue = netRevenueByItem.get(Number(item.id)) ?? money(0);
    if (lineRevenue.isZero()) continue;
    const kind = kindByVariant.get(Number(item.variantId)) ?? "STOCKED";
    const returnClass = digitalVariants.has(Number(item.variantId)) ? "DIGITAL" : kind === "SERVICE" ? "SERVICE" : consignByVariant.has(Number(item.variantId)) ? "CONSIGNMENT" : "INVENTORY";
    returnClasses.add(returnClass);
    const role: AccountRole = inv.sourceType === "WORKORDER" ? "SALES_FLEX" : digitalVariants.has(Number(item.variantId)) ? "OTHER_REVENUE" : kind === "SERVICE" ? "SALES_PRINT" : "SALES_STATIONERY";
    const beforeQuantity = item.returnedBaseQuantity ?? 0;
    const afterQuantity = beforeQuantity + line.baseQuantity;
    const cumulativeRevenue = (quantity: number) => (quantity >= item.baseQuantity ? lineRevenue : round2(lineRevenue.times(quantity).div(item.baseQuantity)));
    const currentRevenue = round2(cumulativeRevenue(afterQuantity).minus(cumulativeRevenue(beforeQuantity)));
    allocatedReturnRevenue = allocatedReturnRevenue.plus(currentRevenue);
    returnRevenueByRole.set(role, round2((returnRevenueByRole.get(role) ?? money(0)).plus(currentRevenue)));
    balancingRole = role;
  }
  const sectorDelta = round2(sectorRevenueReversal.minus(allocatedReturnRevenue));
  if (!sectorDelta.isZero() && balancingRole) {
    returnRevenueByRole.set(balancingRole, round2((returnRevenueByRole.get(balancingRole) ?? money(0)).plus(sectorDelta)));
  }
  const returnProfile: PostingProfile = inv.sourceType === "WORKORDER" ? "RETURN_SALE_FLEX" : returnClasses.size > 1 ? "RETURN_SALE_MIXED" : returnClasses.has("DIGITAL") ? "RETURN_SALE_DIGITAL" : returnClasses.has("SERVICE") ? "RETURN_SALE_SERVICE" : returnClasses.has("CONSIGNMENT") ? "RETURN_SALE_CONSIGNMENT" : "RETURN_SALE_INVENTORY";
  const returnPostingLines = [
    ...Array.from(returnRevenueByRole.entries())
      .filter(([, amount]) => !amount.isZero())
      .map(([role, amount]) => debitLine(role, amount)),
    ...(deliveryRevenueReversal.isZero() ? [] : [debitLine("DELIVERY_REVENUE", deliveryRevenueReversal)]),
    ...(returnedTax.isZero() ? [] : [debitLine("TAX_PAYABLE", returnedTax)]),
    ...(returnAccountingAmount.isZero() ? [] : [creditLine("AR", returnAccountingAmount)]),
    ...(ownedReversedCost.isZero() ? [] : [debitLine("INVENTORY", ownedReversedCost), creditLine("COGS", ownedReversedCost)]),
  ];
  const returnPostingSource = {
    roleDebits: {
      SALES_STATIONERY: returnRevenueByRole.get("SALES_STATIONERY") ?? money(0),
      SALES_PRINT: returnRevenueByRole.get("SALES_PRINT") ?? money(0),
      SALES_FLEX: returnRevenueByRole.get("SALES_FLEX") ?? money(0),
      OTHER_REVENUE: returnRevenueByRole.get("OTHER_REVENUE") ?? money(0),
      DELIVERY_REVENUE: deliveryRevenueReversal,
      TAX_PAYABLE: returnedTax,
      INVENTORY: ownedReversedCost,
    },
    roleCredits: { AR: returnAccountingAmount, COGS: ownedReversedCost },
  };
  const returnPostingIntent = returnPostingLines.length ? createPostingIntent(returnProfile, "RETURN", returnPostingLines, returnPostingSource) : null;
  // مرتجع هدية صِرفة لا يعكس SALE/AR؛ أثره المالي الوحيد عكس GIFT_OUT عند عودتها.
  if (returnPostingIntent) {
    await postEntry(tx, {
      entryType: "RETURN",
      branchId: Number(inv.branchId),
      invoiceId: input.invoiceId,
      customerId: inv.customerId,
      revenue: returnedRevenue.neg(),
      // Source cost is the exact owned COGS reversal. Service materials were consumed and
      // consignment is not our inventory; neither may be manufactured into an INVENTORY return.
      cost: ownedReversedCost.neg(),
      profit: returnedRevenue.minus(ownedReversedCost).neg(),
      taxAmount: returnedTax.neg(),
      amount: returnedTotal.neg(),
      createdBy: actor.userId,
      createdByNameSnapshot: returnOperatorName,
      notes:
        `عكس كلفة تحليلية=${toDbMoney(reversedCost)}؛ عكس COGS مملوك=${toDbMoney(ownedReversedCost)}؛ ` +
        `خدمة غير معادة=${toDbMoney(returnedServicePaidCost)}؛ أمانة مستقلة=${toDbMoney(consignmentPaidShare)}` +
        (resolutionReason
          ? `؛ سبب المرتجع=${resolutionReason}؛ مصير البضاعة=${
              (resolutionDisposition ?? (restock ? "RESTOCK" : "DAMAGED")) === "RESTOCK" ? "إعادة للرف" : "تالف"
            }`
          : ""),
      postingIntent: returnPostingIntent,
      postingSourceComponents: returnPostingSource,
    });
  }

  // هدايا الفاتورة (0149): عكسُ مصروف الهدية بقيد GIFT_OUT سالبٍ (تكلفة سالبة ⇒ ربحٌ موجب يُلغي
  // الخصمَ الأصليّ) — نظير عكس النثرية/التلف في `expenseService.cancelExpense`. بلا `dedupeKey`:
  // المرتجعات الجزئية المتعدّدة على الفاتورة نفسها مشروعة، وكلٌّ يعكس حصّته.
  if (financiallyReversedGiftCost.gt(0)) {
    const giftPosting = classifyGiftPosting(financiallyReversedGiftCost, ownedReversedGiftCost, -1);
    await postEntry(tx, {
      entryType: "GIFT_OUT",
      branchId: Number(inv.branchId),
      invoiceId: input.invoiceId,
      customerId: inv.customerId,
      revenue: new Decimal(0),
      cost: financiallyReversedGiftCost.neg(),
      profit: financiallyReversedGiftCost,
      amount: financiallyReversedGiftCost.neg(),
      createdBy: actor.userId,
      createdByNameSnapshot: returnOperatorName,
      notes: `عكس هدايا ضمن مرتجع بيع؛ consignmentRemainder=${toDbMoney(giftPosting.consignmentRemainder)}`,
      postingIntent: giftPosting.intent,
      postingSourceComponents: giftPosting.sourceComponents,
    });
  }

  // بضاعة الأمانة (ش٣): عكس التزام المودِع — **دائماً** (restock أو تالف)، بقيدٍ PURCHASE سالب بنفس
  // invoiceId ⇒ يدخل فلتر خصم العمولة فيستردّ حصّة البائع (صافي وعائه = 0). §٥ حاصرة ١.
  // إن كان تالفاً (restock=false): إعادة استحقاق يتيمة (بلا invoiceId) ⇒ AP صافٍ = 0 (يبقى مستحقاً)
  // والمكتبة تتحمّل الخسارة (COGS غير معكوس). القيد اليتيم خارج فلتر العمولة (لا يمسّ البائع).
  {
    if (consignByVariant.size) {
      for (const cId of Array.from(byConsignor.keys()).sort((a, b) => a - b)) {
          const split = byConsignor.get(cId)!;
        const paidShare = round2(split.paid);
        const giftShare = round2(split.gift);
        const share = round2(paidShare.plus(giftShare));
        if (share.lte(0)) continue;
          // عكس دائماً (بنفس invoiceId — يدخل فلتر العمولة).
          await postEntry(tx, {
            entryType: "PURCHASE", supplierId: cId, invoiceId: input.invoiceId, branchId: Number(inv.branchId),
            amount: share.neg(), cost: paidShare.neg(), profit: paidShare,
            notes: `عكس استحقاق أمانة — مرتجع؛ COGS مبسّط=${toDbMoney(paidShare.neg())}`,
          postingIntent: createPostingIntent("PURCHASE_CONSIGNMENT", "PURCHASE", [...signedPostingLines("COGS", "CONSIGNMENT_PAYABLE", paidShare.neg()), ...signedPostingLines("GIFTS_PROMO", "CONSIGNMENT_PAYABLE", giftShare.neg())], { roleDebits: { CONSIGNMENT_PAYABLE: share }, roleCredits: { COGS: paidShare, GIFTS_PROMO: giftShare } }),
          postingSourceComponents: { roleDebits: { CONSIGNMENT_PAYABLE: share }, roleCredits: { COGS: paidShare, GIFTS_PROMO: giftShare } },
        });
          await adjustSupplierBalance(tx, cId, share.neg());
          if (!restock) {
            // تالف: إعادة استحقاق يتيمة (بلا invoiceId) ⇒ الالتزام يبقى، والبائع لا يتأثّر.
            await postEntry(tx, {
              entryType: "PURCHASE", supplierId: cId, invoiceId: null, branchId: Number(inv.branchId),
              amount: share, cost: paidShare, profit: paidShare.neg(),
              notes: `استحقاق تلف مرتجع أمانة؛ COGS مبسّط=${toDbMoney(paidShare)}`,
            postingIntent: createPostingIntent("PURCHASE_CONSIGNMENT", "PURCHASE", [...signedPostingLines("COGS", "CONSIGNMENT_PAYABLE", paidShare), ...signedPostingLines("GIFTS_PROMO", "CONSIGNMENT_PAYABLE", giftShare)], { roleDebits: { COGS: paidShare, GIFTS_PROMO: giftShare }, roleCredits: { CONSIGNMENT_PAYABLE: share } }),
            postingSourceComponents: { roleDebits: { COGS: paidShare, GIFTS_PROMO: giftShare }, roleCredits: { CONSIGNMENT_PAYABLE: share } },
          });
            await adjustSupplierBalance(tx, cId, share);
          }
        }
      }
    }

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
      postingIntent: createPostingIntent("ADJUST_ROUNDING", "ADJUST", signedPostingLines("AR", "ROUNDING_DIFF", cashRoundOriginal.neg())),
    });
    }

    // Cash refund capped to min(returnedTotal, amount actually paid). Reject overage.
    const requestedRefund = money(refund?.amount ?? "0");
    if (requestedRefund.lt(0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تسجيل المرتجع",
          why: `مبلغ الاسترداد المُدخَل ${requestedRefund.toFixed(2)} د.ع سالب — والاسترداد مالٌ يخرج للزبون فلا يكون بالسالب`,
          doThis: "أدخِل المبلغ موجباً كما ستسلّمه للزبون، أو اتركه صفراً إن لم يُردّ له شيء نقداً في هذه العملية",
        }),
      });
    }
    // سقف الاسترداد — **الحساب موحَّدٌ مع الشاشة حرفياً** في `returns/refundCaps.ts` (مصدر حقيقة
    // واحد). كان مكرَّراً هنا بمنطقٍ يخالف ما تعرضه الشاشة، فيبني الموظف طلباً مرفوضاً حتماً.
    // ⭐ قرار المالك (١٧/٨/٢٦): الاسترداد **النقديّ** متاحٌ من الوعاء كلّه مهما كان رافد القبض
    // (زبونُ البطاقة العابر كان بلا أيّ مسار استرداد — علّة INV-1-20260816-00118)؛ وغيرُ النقد
    // يبقى محدوداً برافده **وبالوعاء معاً** فلا استرداد مزدوج. التفصيل والثابت المحروس هناك.
    const refundMethod = refund?.method;
    let refundCap = new Decimal(0);
    if (refundMethod) {
      // `lock: true` إلزاميّ هنا: current read بعد قفل المصدر — لا نعتمد لقطةً قد يستهلكها
      // استردادٌ متزامنٌ على الفاتورة نفسها بين القراءة والكتابة.
      const caps = await loadRefundCaps(tx, input.invoiceId, { lock: true });
      refundCap = effectiveRefundCap(caps, refundMethod, returnedTotal);
    }
    // ⭐ الزبون العابر (بلا حساب): ما لا يُردّ لا يجد أين يُقيَّد.
    //
    // العميل المسجَّل يستوعب الفارق في ذمّته (`adjustCustomerBalance` أدناه)، أمّا الزبون
    // العابر فـ`customerId = NULL` ⇒ لا ذمّة ولا رصيد دائن. فمرتجعٌ بلا استرداد كان يُعيد
    // البضاعة للرفّ ويعكس الإيراد **ويُبقي ماله في الدرج بلا التزامٍ مقابل ولا طرفٍ منسوبٍ
    // إليه** — نقضٌ مزدوج للمبدأ الحاكم (طرفٌ منسوب + مسار خروجٍ ممكن دائماً). والشاشة كانت
    // تُطمئن الموظف بنصٍّ كاذب: «تُخصَم من ذمّة العميل فقط» — ولا ذمّة أصلاً.
    //
    // لا «رصيد دائن مجهول الطرف» للزبون العابر: resolution النقديّ يساوي **قيمة المرتجع
    // المحسوبة هنا بعد كل تقريب**، لا مبلغاً واجهياً تقريبياً ولا جزءاً منه. هذا الشرط يقع داخل
    // المعاملة وبعد قفل الفاتورة؛ أي اختلاف/سباق يُسقط كل حركة المخزون والدفتر ذرّياً.
    if (isWalkInReturn && !requestedRefund.eq(returnedTotal)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تسجيل مرتجع زبونٍ عابر",
          why: `الردّ يجب أن يساوي قيمة المرتجع بالضبط بعد التقريب: المطلوب ${returnedTotal.toFixed(2)} د.ع والمُدخَل ${requestedRefund.toFixed(2)} د.ع — فرق ${returnedTotal.minus(requestedRefund).abs().toFixed(2)} د.ع ${requestedRefund.lt(returnedTotal) ? "ناقص يبقى في الدرج بلا صاحب" : "زائد يخرج من الدرج بلا مستند"}`,
          doThis: `أدخِل ${returnedTotal.toFixed(2)} د.ع بالضبط وسلّمها للزبون؛ ولا يصحّ ردٌّ جزئيّ لزبونٍ بلا حساب — فإن كان المطلوب رصيداً أو مطالبةً مالية فسجّله عميلاً أوّلاً ثمّ أعِد المرتجع من فاتورته`,
        }),
      });
    }
    if (requestedRefund.gt(refundCap)) {
      const poolNote = refundMethod === "CASH"
        ? "الأقل من قيمة المرتجع والمتبقّي من المقبوض على الفاتورة بكل الطرق"
        : "الأقل من قيمة المرتجع والمقبوض بهذه الطريقة والمتبقّي من المقبوض إجمالاً";
      // أيُّ الحدّين قصّ السقف فعلاً؟ مساواتُه لقيمة المرتجع تعني أنّ الحدّ هو المرتجع نفسه،
      // وإلّا فالحدّ ما تبقّى من مقبوض الفاتورة — وهما مخرجان مختلفان تماماً للموظّف.
      const cappedByReturnValue = refundCap.eq(returnedTotal);
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تسجيل استرداد المرتجع",
          why:
            `المطلوب ردّه بـ${refundMethod ?? "—"} هو ${requestedRefund.toFixed(2)} د.ع، وهو يتجاوز المسموح ${refundCap.toFixed(2)} د.ع بزيادة ${requestedRefund.minus(refundCap).toFixed(2)} د.ع — والمسموح هو ${poolNote}` +
            (cappedByReturnValue
              ? `، والحدّ هنا قيمة المرتجع نفسها ${returnedTotal.toFixed(2)} د.ع`
              : `، والحدّ هنا ما تبقّى من مقبوض الفاتورة لا قيمة المرتجع ${returnedTotal.toFixed(2)} د.ع`),
          doThis: refundCap.isZero()
            ? "لم يبقَ على الفاتورة مقبوضٌ يُردّ (لم تُدفع بعد أو استُرِدّ مقبوضها كلّه سابقاً): سجّل المرتجع بمبلغ استردادٍ صفر ليسقط المبلغ من ذمّة العميل بدل خروج نقدٍ من الدرج"
            : `أنقص مبلغ الاسترداد إلى ${refundCap.toFixed(2)} د.ع أو أقلّ؛ وما زاد عنه يُسوّى على ذمّة العميل لا نقداً من الدرج`,
        }),
      });
    }
    const refundRequest = requestedRefund;
    // ⭐ قرار المالك (١٧/٨/٢٦): **رافدا الردّ الفوريّ نقدٌ أو بطاقة**. الردّ بالبطاقة يُنفَّذ على
    // جهاز الدفع فعلياً ثمّ يُوثَّق بمرجعه هنا ⇒ مالٌ خرج حقيقةً، فيجب أن **يتجسّد** (يُنقص
    // `paidAmount` ويُرحَّل PAYMENT_OUT على CARD_BANK). تسجيلُه «معلَّقاً» كان يكذب على الواقع:
    // الزبون استلم مالَه والدفتر يقول إنّ سنداً ينتظر الاعتماد. وهو مرآةٌ للسياسة الواردة —
    // «البوّابة إثباتٌ لا إقفال» ([[inbound-payment-policy-2026-08-16]]): مرجع الجهاز إلزاميّ.
    // الطرق الأخرى (تحويل/صك/محفظة) غير معروضةٍ في الشاشة وتبقى على مسار السند المعلَّق.
    const isImmediateRefundRail = refundMethod != null && isSurfacedRefundMethod(refundMethod);
    const refundReference = refund?.reference?.trim() || null;
    const materializedRefund = isImmediateRefundRail ? refundRequest : money(0);
    let pendingRefundVoucherNumber: string | null = null;

    if (refundRequest.gt(0)) {
      // انسب الاسترداد إلى وردية الدرج الذي خرج منه النقد فعلياً — لا وردية الفاعل بالضرورة.
      // المرتجعات salesManagerProcedure ⇒ مُنفِّذ الاسترداد غالباً مديرٌ قد يختلف عن الكاشير الذي
      // يُشغّل الدرج الحقيقيّ؛ ربطه بوردية الفاعل (لو خلَت، G9 ١٩/٦/٢٦) كان يُخفي الاسترداد عن
      // Z-report صاحب الدرج فيظهر له عجزٌ لا يفهم سببه عند الإغلاق. resolveBranchCashShiftTx يبحث
      // في ورديات الفرع المفتوحة كلّها (لا الفاعل فقط)، ويتطلّب اختياراً صريحاً (refund.shiftId)
      // حين يتعدّد الدرج المفتوح. غير النقد لا يمسّ صندوقاً فيبقى على النمط القديم (معلوماتيّ بحت).
      let shiftId: number | null = null;
      /** دلو النقد الخارج — DRAWER أو TREASURY، ويبقى NULL لغير النقد (لا يمسّ صندوقاً). */
      let refundCashBucket: "DRAWER" | "TREASURY" | null = null;
      if (refund!.method === "CASH") {
        const resolved = prelockedRefundSource;
        if (!resolved) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: appErrorMessage({
              what: "تعذّر صرف استرداد المرتجع نقداً",
              why: "لم يُحجَز مصدر النقد (درجٌ أو خزينة) في بداية العملية رغم أنّ الردّ نقديّ — خللٌ داخليّ في تسلسل التنفيذ لا في مدخلاتك",
              doThis: "لم يخرج أيّ مبلغ ولم تتغيّر الفاتورة؛ أعِد المحاولة مرّةً واحدة، وإن تكرّر فأبلِغ مسؤول النظام برقم الفاتورة ولا تُسلّم الزبون نقداً خارج النظام",
            }),
          });
        }
        shiftId = resolved.shiftId;
        refundCashBucket = resolved.cashBucket;
        // وسمٌ تدقيقيّ fail-closed: الصرفُ من الخزينة استثناءٌ مصنَّفٌ في سياسةٍ مغلقة، لا مساراً عاماً.
        if (refundCashBucket === "TREASURY") assertTreasuryOutException("SALE_RETURN_COMPENSATION");
        // حدّ الدرج (نمط cashDropService — لا يُسحَب أكثر من النقد الحاليّ فيه): سقف الفاتورة
        // (refundCap أعلاه) وحده لا يكفي — يضمن فقط أن المسترَد ≤ ما دُفع بهذه الطريقة على هذه
        // الفاتورة، لا أنّ الدرج المستهدَف يحمل هذا المبلغ *الآن* (سحبٌ نقديّ أو مصروفٌ سابقٌ في
        // نفس الوردية قد يكون أنقص الدرج فعلياً). بلا هذا الحدّ يُطلَب من الكاشير تسليم نقدٍ لا يملكه
        // فعلياً في درجه أثناء العمل، لا أن يُكتشَف الخلل لاحقاً عند الإغلاق فقط.
        await assertCashOutAvailable(tx, {
          branchId: Number(inv.branchId), cashBucket: refundCashBucket, shiftId,
          amount: materializedRefund, operation: "استرداد مرتجع البيع نقداً",
        });
      } else if (isImmediateRefundRail) {
        // الردّ بالبطاقة: **إثباتٌ لا إقفال**. المرجع (رقم عملية/كود موافقة الجهاز) إلزاميّ —
        // هو الأثر الوحيد الذي يربط ديناراً خرج من حسابنا البنكيّ بمستنده، مطابقةً للمبدأ
        // المالي الحاكم (خمسة: إيصال + قيدٌ مصنَّف + أثر تسوية + طرفٌ منسوب + تقريرٌ يُظهره).
        // لا يشترط عميلاً مسجَّلاً: البطاقة نفسها هي الطرف (زبونٌ عابر يستردّ على بطاقته).
        if (!refundReference) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "تعذّر تسجيل استرداد المرتجع على البطاقة",
              why: `مرجع العملية من جهاز الدفع لم يصل، وهو الأثر الوحيد الذي يربط ${requestedRefund.toFixed(2)} د.ع خرجت من حسابنا البنكيّ بمستندها`,
              doThis: "نفّذ الاسترداد على جهاز الدفع أوّلاً، ثمّ أدخِل رقم العملية أو كود الموافقة المطبوع على قسيمة الجهاز في حقل المرجع",
            }),
          });
        }
        // لا يمسّ درجاً (cashBucket=NULL) ⇒ لا أثر على expectedCash ولا على Z-report النقديّ.
        assertNonPhysicalOutReceipt({
          classification: "NON_CASH_METHOD",
          paymentMethod: refund!.method,
          cashBucket: null,
          approvalStatus: "APPROVED",
          operation: "استرداد مرتجع بيع على البطاقة",
        });
      } else {
        if (inv.customerId == null) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: appErrorMessage({
              what: "تعذّر تسجيل استرداد المرتجع",
              why: `الردّ بـ${refund!.method} لا يخرج فوراً بل يمرّ بسند صرفٍ يعتمده المالك، والسند يلزمه طرفٌ يُنسَب إليه — وهذه الفاتورة بلا عميلٍ مسجَّل`,
              doThis: "ردّ للزبون نقداً أو على بطاقته (رافدا الردّ الفوريّان)، أو سجّله عميلاً على الفاتورة ثمّ أعِد المرتجع بهذه الطريقة",
            }),
          });
        }
        assertNonPhysicalOutReceipt({
          classification: "DEFERRED_APPROVAL",
          paymentMethod: refund!.method,
          cashBucket: null,
          approvalStatus: "PENDING_APPROVAL",
          operation: "طلب استرداد مرتجع بيع غير نقدي",
        });
        pendingRefundVoucherNumber = await nextVoucherNumber(tx, "PAYMENT", Number(inv.branchId));
      }
      const rRes = await tx.insert(receipts).values({
        invoiceId: input.invoiceId,
        branchId: Number(inv.branchId),
        shiftId,
        // cashBucket=DRAWER للنقد (يَخرج من الدُرج بمرتجع نقدي ويظهر في Z-report).
        // البطاقة وغيرها ⇒ NULL (لا يَمسّ صندوقاً). مرآة لنمط saleService/voucherService.
        cashBucket: refundCashBucket,
        direction: "OUT",
        amount: toDbMoney(refundRequest),
        paymentMethod: refund!.method,
        status: isImmediateRefundRail ? "COMPLETED" : "PENDING",
        approvalStatus: isImmediateRefundRail ? "APPROVED" : "PENDING_APPROVAL",
        referenceNumber: refund!.method === "CASH"
          ? null
          : isImmediateRefundRail
            ? refundReference
            : `SALE-RETURN-PENDING-${input.invoiceId}-${requestFingerprint?.slice(0, 12) ?? "LEGACY"}`,
        description: refund!.method === "CASH"
          ? `استرداد مرتجع فاتورة ${inv.invoiceNumber}${input.resolution ? ` — ${input.resolution.reason.trim()}` : ""}`
          : isImmediateRefundRail
            ? `استرداد مرتجع فاتورة ${inv.invoiceNumber} على البطاقة — مرجع الجهاز ${refundReference}`
            : `طلب استرداد غير نقدي معلّق لفاتورة ${inv.invoiceNumber} — بلا أثر حتى الاعتماد والتنفيذ`,
        voucherNumber: pendingRefundVoucherNumber,
        partyType: inv.customerId ? "CUSTOMER" : "OTHER",
        partyId: inv.customerId ?? null,
        internalNote: pendingRefundVoucherNumber
          ? `SALE_CUSTOMER_REFUND:RETURN:${input.invoiceId}`
          : null,
        createdBy: actor.userId,
      });
      const receiptId = extractInsertId(rRes);
      if (materializedRefund.gt(0)) {
        // الدلو يُمرَّر بحسب الرافد فعلاً: النقد من الدرج (CASH)، والبطاقة من الحساب البنكيّ
        // (CARD_BANK) — تمرير "DRAWER" ثابتاً كان يُرحّل ردّ البطاقة على حساب النقد.
        // الدلوُ الفعليّ يقرّر الحساب: درجٌ ⇒ CASH · خزينةٌ ⇒ TREASURY_CASH · بطاقةٌ ⇒ CARD_BANK.
        const refundAssetRole = paymentAssetRole(refund!.method, refundCashBucket, "OUT");
        const refundPostingSource = {
          roleDebits: { AR: materializedRefund },
          roleCredits: { [refundAssetRole]: materializedRefund },
        };
        await postEntry(tx, {
          entryType: "PAYMENT_OUT",
          branchId: Number(inv.branchId),
          invoiceId: input.invoiceId,
          receiptId,
          customerId: inv.customerId,
          amount: materializedRefund,
          postingIntent: createPostingIntent("PAYMENT_OUT_CUSTOMER_REFUND", "PAYMENT_OUT", [debitLine("AR", materializedRefund), creditLine(refundAssetRole, materializedRefund)], refundPostingSource),
          postingSourceComponents: refundPostingSource,
        });
      }
    }

    // paidAmount tracks Σ(IN) − Σ(OUT); recompute status.
    // returnedTotal تراكمي عبر مرتجعات جزئية ⇒ يمنع انحراف AR في reconcile/aging.
    // G7 (١٩/٦/٢٦): clamp ≥ 0 — refundCap نظرياً يضمن `cashRefund ≤ paidAmount`، لكن لو
    // انحرف الحساب لأي سبب (مرتجع قديم مُسجَّل بطريقة مختلفة، حالة حدّية) نمنع paidAmount السالب.
    const paidMinusRefund = money(inv.paidAmount).minus(materializedRefund);
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
      await adjustCustomerBalance(tx, Number(inv.customerId), returnedTotal.minus(materializedRefund).neg());
    }

    // قرار المالك (٦/٨/٢٦) — **مرتجعٌ لفاتورةٍ بيد مندوب: تُخصَم عهدته بقيمة ما عاد**.
    // الحالة الواقعية: المندوب حصّل جزءاً من الفاتورة وأعاد باقي البضاعة. قبل هذا كان
    // المتبقّي يبقى عهدةً عليه **بلا نقدٍ يقابله** — ومخرجاه الوحيدان يكذبان: شطبٌ يُسجَّل
    // خسارةً (والبضاعة عندنا!) أو تسويةٌ يدفع فيها من جيبه ما لم يقبضه. الآن تُعكَس عهدته
    // بمقدار الأقلّ من (قيمة المرتجع، ما تبقّى في عهدته عن هذه الفاتورة)، ويُخفَّض COD
    // الإرسالية بالمثل فلا يُطالَب بتحصيله لاحقاً.
    const cnRows = await tx
      .select({
        id: deliveryConsignments.id,
        number: deliveryConsignments.consignmentNumber,
        partyId: deliveryConsignments.partyId,
        codAmount: deliveryConsignments.codAmount,
        collectedAmount: deliveryConsignments.collectedAmount,
        status: deliveryConsignments.status,
        parcelStatus: deliveryConsignments.parcelStatus,
        moneyStatus: deliveryConsignments.moneyStatus,
      })
      .from(deliveryConsignments)
      .where(eq(deliveryConsignments.invoiceId, input.invoiceId))
      .for("update")
      .limit(1);
    const cn = cnRows[0];
    if (cn && (
      !["DELIVERED", "CANCELLED", "RETURNED"].includes(cn.parcelStatus)
      || cn.moneyStatus === "UNSETTLED"
      || cn.moneyStatus === "PARTIAL"
    )) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر تسجيل المرتجع",
          why: `الفاتورة ما زالت على إرسالية التوصيل ${cn.number}: حالة الطرد «${cn.parcelStatus}» وحالة مالها «${cn.moneyStatus}» — أي أنّ البضاعة أو نقدها ما زال بيد جهة التوصيل، فالمرتجع الآن يعكس بيعاً لم تُغلَق دورتُه`,
          doThis: "أغلق الإرسالية أوّلاً من شاشة التوصيل: سجّل إرجاع الطرد إن عاد إليك، أو ورّد ما حصّله المندوب — ثمّ أعِد تسجيل المرتجع",
        }),
      });
    }

    // Idempotency: سجّل المفتاح بعد نجاح الكتابة (refId = الفاتورة).
    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "sale.return", input.clientRequestId, input.invoiceId, requestFingerprint);
    }

    return {
      invoiceId: input.invoiceId,
      returnedTotal: returnedTotal.toFixed(2),
      fullyReturned,
      // «معلَّق» = ما لم يخرج فعلاً بعد. رافدا الردّ الفوريّ (نقد/بطاقة) خرجا حقيقةً ⇒ صفر معلَّق.
      pendingRefundAmount: isImmediateRefundRail ? "0.00" : refundRequest.toFixed(2),
      pendingRefundVoucherNumber,
    };
}

export async function returnSale(input: ReturnSaleInput, actor: Actor) {
  return withTx((tx) => returnSaleInTx(tx, input, actor));
}

/**
 * ⭐ **مسارُ المالك الفوريّ** (قرار المالك ١/٩/٢٦ — تدقيق «المرتجع وهميّ»).
 *
 * حوكمةُ طلب/اعتماد تفترض وجودَ مراجعٍ مستقلّ. وفي مكتبةٍ يديرها صاحبُها، المالكُ هو البائعُ
 * والمديرُ معاً ⇒ كلّ مرتجعٍ يحتاج شخصاً ثانياً لا وجود له، فيُسلَّم النقدُ والبضاعةُ خارج
 * النظام. المالكُ هو **مالكُ المخاطرة** لا موظّفٌ يُراقَب، ولهذا يُنفّذ مرتجعَه مباشرةً.
 *
 * ثلاثةُ حرّاسٍ تُبقيه محكوماً لا مفتوحاً:
 *  ① **إعادةُ قراءة `isOwner`/`isActive` داخل المعاملة نفسها** — راية الجلسة قد تشيخ؛ نفس
 *    اشتراط `assertTreasuryOutException` (cash/cashAvailability.ts). قفلُ `.for("share")`
 *    يمنع سحبَ الصفة بين الفحص والتنفيذ.
 *  ② **سببٌ إلزاميّ** (٣ أحرف فأكثر) يُخزَّن في `notes` القيد — لا تنفيذ صامت.
 *  ③ الأثرُ يمرّ بـ`returnSaleInTx` نفسها: نفس القيود والإيصالات وحرّاس الدرج والسقوف.
 *    **لا نسخةَ منطقٍ ماليّ ثانية** — الاختصارُ في الحوكمة لا في المحاسبة.
 */
export async function returnSaleAsOwner(
  input: ReturnSaleInput & { ownerReason: string },
  actor: Actor,
) {
  const reason = input.ownerReason.trim().replace(/\s+/g, " ");
  if (reason.length < 3 || reason.length > 500) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تنفيذ المرتجع الفوريّ",
        why: `سبب المرتجع إلزاميّ للمالك ويقع بين 3 و500 محرف — الوارد ${reason.length} محرفاً؛ وهو ما يقوم مقام اعتماد الشخص الثاني في هذا المسار`,
        doThis: "اكتب السبب في سطرٍ واحد يذكر الصنف والعلّة (مثل «عيب طباعة في 20 دفتر»)، أو مرّر المرتجع بمسار الطلب والاعتماد المعتاد",
      }),
    });
  }
  return withTx(async (tx) => {
    const [owner] = await tx
      .select({ id: users.id, isActive: users.isActive, isOwner: users.isOwner })
      .from(users)
      .where(eq(users.id, actor.userId))
      .for("share")
      .limit(1);
    if (!owner?.isActive || !owner.isOwner) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر تنفيذ المرتجع الفوريّ",
          why: !owner
            ? "المرتجع الفوريّ محصورٌ بحساب مالكٍ نشط، وحسابك لم يعد موجوداً في سجلّ المستخدمين"
            : !owner.isActive
              ? "المرتجع الفوريّ محصورٌ بحساب مالكٍ نشط، وحسابك موقوف الآن"
              : "المرتجع الفوريّ محصورٌ بحساب مالكٍ نشط، وحسابك ليس عليه صفة المالك — وهي التي تُغني عن اعتماد الشخص الثاني",
          doThis: "سجّل المرتجع من شاشة المرتجعات بمسار الطلب والاعتماد ليعتمده المالك؛ وإن كنت المالك فراجع صفحة المستخدمين للتأكّد من تفعيل حسابك وصفته",
        }),
      });
    }
    return returnSaleInTx(tx, { ...input, operatorReason: reason }, actor);
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
      customerPhone: sql<string | null>`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
      amount: accountingEntries.amount,
      notes: accountingEntries.notes,
      createdAt: accountingEntries.createdAt,
      performedBy: accountingEntries.createdBy,
      performedByName: accountingEntries.createdByNameSnapshot,
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
