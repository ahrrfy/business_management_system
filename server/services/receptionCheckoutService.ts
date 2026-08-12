import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { auditLogs, customers, invoices, receipts, shifts } from "../../drizzle/schema";
import { extractInsertId } from "../lib/insertId";
import { postEntry } from "./ledgerService";
import type { SaleLineInput, PaymentMethod } from "./sale/types";
import type { PriceTier } from "./pricing";
import { createSaleInTx } from "./sale/create";
import type { PrintSaleLineInput } from "./printSaleService";
import { createPrintSaleInTx } from "./printSaleService";
import type { CreateWorkOrderInput } from "./workOrder/types";
import { createWorkOrderInTx } from "./workOrder/create";
import { dispatchInvoiceInTx } from "./delivery/dispatchInvoice";
import { withTx, type Actor } from "./tx";
import { findIdempotentRefId } from "./idempotency";
import { money, round2 } from "./money";
import { assertTelecomCollectAllowed } from "./reception/telecom";
import { canonicalIraqiMobile } from "../lib/phone";

export interface ReceptionCheckoutInput {
  branchId: number;
  shiftId: number;
  customerId?: number | null;
  /** ٥/٨ — زبونٌ عابر: اسمٌ/هاتفٌ مرجعيّان يُكتبان على الفاتورة وأمر الشغل بلا إنشاء عميل.
   *  يُغني عن إجبار الكاشير على إنشاء عميلٍ (وكان يفشل بـFORBIDDEN لأدوار الاستقبال بلا crm=FULL). */
  contactName?: string | null;
  contactPhone?: string | null;
  paymentMethod: Extract<PaymentMethod, "CASH" | "CARD" | "TRANSFER" | "WALLET" | "TELECOM">;
  paymentReference?: string | null;
  /** المبلغ المطبّق على الطلب كله. البيع المباشر يُغطّى أولاً، ثم أوامر الشغل بالترتيب. */
  paidAmount?: string | null;
  clientRequestId: string;
  /** فئة سعر صريحة لكامل سلة الاستقبال (بيع مباشر + طباعة) — تتبع فئة العميل الافتراضية إن غابت
   *  (نمط resolveTier في sale/create.ts). غيابها يبقي السلوك السابق (RETAIL افتراضياً). */
  priceTier?: PriceTier | null;
  /** كوبون CRM — ينطبق على البيع المباشر فقط (createPrintSaleInTx لا يدعم كوبونات). */
  couponCode?: string | null;
  regularSale?: { lines: SaleLineInput[]; amount: string } | null;
  printSale?: { lines: PrintSaleLineInput[]; amount: string } | null;
  workOrders?: Array<Omit<CreateWorkOrderInput, "branchId" | "customerId" | "clientRequestId">>;
  priceOverrideApproved?: boolean;
  /** الاستقبال (٨/٨) — تأكيد الموظّف أن الأصناف غير المجرودة (رصيد سالب) **متوفّرة فيزيائياً**
   *  في وضع الافتتاح، فيُسمح ببيعها بالسالب حتى لطلب توصيل COD (المندوب يحملها بيده). يُمرَّر
   *  لـcreateSaleInTx (openingSellUnavailableConfirmed) وتبقى رِيلاته نافذة (افتتاح فعّال + تكلفة>0 + سقف). */
  openingSellUnavailableConfirmed?: boolean;
  /** بيع مباشر آجل (قرار المالك ١٠/٨): يسمح بأن يقلّ المقبوض عن إجمالي البضاعة/الطباعة **بلا توصيل**
   *  حين يوجد عميلٌ فعّال بهوية مكتملة (اسم + هاتف عراقي) — المتبقّي يصير ذمّةً على العميل (AR).
   *  التفويض محصور بهذه المعاملة ويُسجَّل تدقيقياً؛ بلا عميلٍ موثّق يبقى الحاجز صارماً. */
  deferredDirect?: boolean;
  /** ش٠ (٥/٨، V1): تقريب نقدي IQD لأقرب ٢٥٠ — للبيع المباشر **الخالص** النقديّ فقط (بلا خدمات
   *  طباعة وبلا أوامر شغل). الواجهة تُقرّب أوّلاً وترسل المبالغ مقرَّبة، والخادم يعيد التقريب
   *  بنفس الدالة ويقيّد الفرق ADJUST (نمط POS حرفياً). السلة المختلطة عبر cashRoundingOverride
   *  أدناه (ش٦) — الحارس يُسقط هذا العلم عنها حتى لو أرسلته الواجهة سهواً. */
  cashRoundIQD?: boolean;
  /** ش٦ — تقريب السلّة المختلطة: فرق تقريب السلّة **كلّها** مبيّتٌ سلفاً في مبلغ الفاتورة
   *  الحاملة (regularSale.amount أو printSale.amount = الخام + الفرق)، وهذا الحقل يسمّيها
   *  فيمرَّر مبلغُها إجماليّاً فعّالاً صريحاً لخدمتها (قيد ADJUST بالفرق). NULL = لا تقريب مختلط. */
  cashRoundingOverride?: "SALE" | "PRINT" | null;
  /** ش٦ (V15) — أجرة توصيلٍ تُقبض في الاستقبال **الآن** لطلبٍ سيُسنَد للتوصيل بعد التثبيت:
   *  إيصال IN نقديّ (أمانةٌ للمندوب — تدخل الدرج حتماً مهما كانت طريقة دفع السلّة) + قيد
   *  DELIVERY_FEE_HELD بـdedupeKey `DELIVERY_FEE_HELD:INV:{invoiceId}` — مرآةُ مسار أمر الشغل
   *  حرفياً، وبها يُرفع حظر COUNTER عن dispatchInvoice (الأجرة في الدرج قبل صرفها للمندوب). */
  deliveryFeeHeld?: string | null;
  /** ش٦ (§٩.٣) — هويّة مُقِرّ تجاوز السعر/الخصم: حين priceOverrideApproved صادقة يُسجَّل سطرُ
   *  تدقيقٍ داخل المعاملة يسمّي المُقِرّ والأسعار النهائية (الراية وحدها كانت بلا هويّة). */
  priceApprovedBy?: number | null;
  /**
   * ش٧ (قرار المالك ٦/٨/٢٦) — **إسناد الطلب للتوصيل داخل نفس معاملة التثبيت**.
   *
   * «لا تُحتسَب الفاتورة التي فيها توصيل ولديها مندوب على الكاشير والدرج — الدرج فقط ما
   * قُبض عربوناً نقدياً أو كاشاً من الفواتير.» ⇒ الفاتورة تُنشأ بالمقبوض نقداً فعلاً
   * (`paidAmount`)، والمتبقّي يصير **عهدةً على المندوب** (قيد DELIVERY_DISPATCH) في نفس
   * المعاملة — فلا لحظةَ تكون فيها الفاتورة بلا دافعٍ ولا حاملِ عهدة.
   */
  delivery?: {
    partyId: number;
    fee?: string | null;
    feeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
    recipientName?: string | null;
    recipientPhone?: string | null;
    address?: string | null;
  } | null;
  /** أوفلاين (تعميم على كاشير الاستقبال — داخليّ، يضبطه `offline.replayReception` حصراً):
   *  وسم منشأ الفاتورتين (البيع المباشر وخدمات الطباعة) بالالتقاط دون اتصال. أوامر الشغل
   *  لا تُلتقَط أصلاً (ترقيم/إسناد/صور خادميّة) فلا معنى لوسمها. */
  offlineCapture?: { capturedAt: Date; offlineReceiptNumber: string; deviceId?: string | null } | null;
  /** ش٤ (§٧.٢) — مالٌ قُبض سلفاً على هذه السلة (عرابين مسوّدة، يضبطه commitDraft حصراً):
   *  يدخل التوزيع الجشع **أولاً** (البيع المباشر ⇒ أمر شغل ١ ⇒ ٢ …) ثم يكمله النقد الجديد
   *  (paidAmount)، ولا يُنشأ له إيصالٌ ثانٍ في أيّ خدمة (I5). receiptIds/paymentIds تحملها
   *  الحمولة لاكتمال العقد؛ التخصيص والختم في allocateAtCommit (حيث تُعرف وحدة الهدف). */
  preCollected?: { total: string; receiptIds?: number[]; paymentIds?: number[] } | null;
}

/** حصص المال المقبوض سلفاً لكل هدفٍ بعد التوزيع الجشع — يستهلكها allocateAtCommit (ش٤). */
export interface PreCollectedSplit {
  sale: string;
  print: string;
  workOrders: string[];
}

async function isCompleteReplay(tx: Parameters<Parameters<typeof withTx>[0]>[0], input: ReceptionCheckoutInput) {
  if (input.regularSale) {
    const row = await tx.select({ id: invoices.id }).from(invoices)
      .where(eq(invoices.sourceId, `${input.clientRequestId}-sale`)).limit(1);
    if (!row[0]) return false;
  }
  if (input.printSale) {
    const row = await tx.select({ id: invoices.id }).from(invoices)
      .where(eq(invoices.sourceId, `${input.clientRequestId}-print`)).limit(1);
    if (!row[0]) return false;
  }
  for (let index = 0; index < (input.workOrders?.length ?? 0); index += 1) {
    const id = await findIdempotentRefId(tx, "workOrder.create", `${input.clientRequestId}-wo-${index}`);
    if (!id) return false;
  }
  return true;
}

/**
 * The reception commit boundary. A mixed basket is one business operation:
 * inventory sale, print-service sale, work orders, deposits, receipts and ledger
 * entries either all commit or all roll back.
 *
 * ش٣ (§٧.١): الجسم مستخرَجٌ `checkoutReceptionInTx` **ميكانيكياً بصفر تغيير سلوكيّ** —
 * `withTx` = `db.transaction(fn)` غير قابلة لإعادة الدخول، فتثبيت المسوّدة (commitDraft)
 * يستدعي الجسم داخل معاملته ويُكمل بعده ذرّياً. الغلاف يبقى للمستدعين القائمين
 * (workOrders.receptionCheckout المباشر + offline.replayReception — يبقيان إلى الأبد).
 */
export async function checkoutReception(input: ReceptionCheckoutInput, actor: Actor) {
  return withTx((tx) => checkoutReceptionInTx(tx, input, actor));
}

export async function checkoutReceptionInTx(
  tx: Parameters<Parameters<typeof withTx>[0]>[0],
  input: ReceptionCheckoutInput,
  actor: Actor,
) {
  {
    // إعادة ردّ عملية سبق التزامها لا تحتاج وردية ما زالت مفتوحة. هذا مهم إذا وصل الالتزام
    // إلى القاعدة ثم انقطع الرد وأُغلقت الوردية قبل إعادة المحاولة. أي عملية جديدة/ناقصة تمرّ
    // بالحارس الصارم أدناه؛ والحالة الناقصة لا يمكن أن تنتج عن هذه الخدمة لأن الالتزام ذرّي.
    const completeReplay = await isCompleteReplay(tx, input);
    if (!completeReplay) {
      const shift = await tx.select().from(shifts).where(eq(shifts.id, input.shiftId)).for("update").limit(1);
      const current = shift[0];
      if (!current || current.status !== "OPEN" || Number(current.branchId) !== input.branchId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "وردية الاستقبال مغلقة أو لا تخص هذا الفرع",
        });
      }
      if (current.shiftType !== "RECEPTION") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "يجب استخدام وردية استقبال لتنفيذ هذه العملية" });
      }
      if (actor.role !== "admin" && actor.role !== "manager" && Number(current.userId) !== Number(actor.userId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا تستطيع التسجيل على وردية مستخدم آخر" });
      }
    }

    // «بدون عربون» سياسة استقبال وليست تجاوزاً عاماً للائتمان: نُقفل العميل داخل معاملة التثبيت
    // ونتحقق من كونه فعّالاً وذا اسم وهاتف عراقي كامل. بعدها فقط نمرّر تفويضاً داخلياً لخدمتَي
    // البيع والطباعة؛ الراوترات العامة لا تستطيع إرسال هذا التفويض.
    let receptionDeferredAuthorized = false;
    if (!completeReplay && input.deferredDirect === true) {
      if (input.delivery) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "خيار بدون عربون لا يُجمع مع طلب التوصيل" });
      }
      if (input.customerId == null) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "خيار بدون عربون يتطلب عميلاً محفوظاً ومربوطاً" });
      }
      const customer = (
        await tx
          .select({ id: customers.id, name: customers.name, phone: customers.phone, isActive: customers.isActive })
          .from(customers)
          .where(eq(customers.id, input.customerId))
          .for("update")
          .limit(1)
      )[0];
      if (!customer || customer.isActive === false) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "العميل غير موجود أو معطّل" });
      }
      if (customer.name.trim().length < 2 || !canonicalIraqiMobile(customer.phone)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "بدون عربون متاح فقط لعميل فعّال باسمه ورقم هاتف عراقي مكتمل",
        });
      }
      receptionDeferredAuthorized = true;
    }

    // ش٥ (§٩.٤): رصيد زين على أيّ قبضٍ جديد في السلة — خلف ضوابطه (كودٌ أحاديّ + سقفان + قفل
    // تقادم المطابقة). يُفحص مرّةً على مبلغ القبض الجديد كلّه قبل أيّ إنشاء مستند.
    // (يُتخطّى عند إعادة ردّ عمليةٍ ملتزمة — الكود سُجِّل فيها فسيصطدم بنفسه زوراً.)
    if (!completeReplay && input.paymentMethod === "TELECOM" && money(input.paidAmount ?? "0").gt(0)) {
      await assertTelecomCollectAllowed(tx, {
        userId: actor.userId,
        branchId: input.branchId,
        amount: round2(money(input.paidAmount ?? "0")).toFixed(2),
        reference: input.paymentReference,
      });
    }

    // ش٤: التوزيع الجشع بترتيب السلّة كما هو، لكن **المقبوض سلفاً يُطبَّق أولاً** (§٧.٢):
    // البيع المباشر (العادي ثم الطباعة) ⇒ أمر شغل ١ ⇒ ٢ … كلُّ هدفٍ يستهلك P المتبقّي قبل N.
    const preTotalD = round2(money(input.preCollected?.total ?? "0"));
    const preSplit: PreCollectedSplit = { sale: "0.00", print: "0.00", workOrders: [] };
    // ش٧: المقبوض فعلاً المخصَّص لكل فاتورة (يساوي مبلغها الكامل بلا توصيل — والفرق مع COD).
    let saleApplied = round2(money(input.regularSale?.amount ?? "0"));
    let printApplied = round2(money(input.printSale?.amount ?? "0"));
    let normalizedWorkOrders = (input.workOrders ?? []).map((order) => ({
      ...order,
      depositPreCollected: "0.00",
    }));
    if (input.paidAmount != null || preTotalD.gt(0)) {
      const regularAmount = round2(money(input.regularSale?.amount ?? "0"));
      const printAmount = round2(money(input.printSale?.amount ?? "0"));
      const directTotal = round2(regularAmount.plus(printAmount));
      const workTotal = round2(normalizedWorkOrders.reduce(
        (sum, order) => sum.plus(money(order.salePrice)),
        money("0"),
      ));
      const grandTotal = round2(directTotal.plus(workTotal));
      const applied = round2(money(input.paidAmount ?? "0").plus(preTotalD));
      // ش٧: طلبٌ يُسنَد للتوصيل في نفس المعاملة ⇒ **لا يُشترط تغطية البيع المباشر نقداً**
      // (الزبون يدفع للمندوب). المتبقّي يصير عهدةً عليه أدناه، والدرج يبقى على المقبوض فعلاً.
      // بيع مباشر آجل (قرار المالك ١٠/٨): يُرخّى هذا الحاجز حين يوجد عميلٌ مسجَّل والعلَم الصريح
      // مرفوع — المتبقّي يصير ذمّةً على العميل عبر createSaleInTx (حدّ الائتمان نافذٌ فيها). بلا
      // عميلٍ (أو بلا علَم) يبقى صارماً: لا ذمّةٌ بلا صاحب، ولا ذمّةٌ صامتةٌ من إدخالٍ خاطئ.
      const allowDeferredDirect = input.deferredDirect === true && input.customerId != null;
      if (!input.delivery && applied.lt(directTotal) && !allowDeferredDirect) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `المبلغ المقبوض يجب أن يغطي البيع المباشر أولاً (${directTotal.toFixed(2)})`,
        });
      }
      if (applied.gt(grandTotal)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ المطبق يتجاوز إجمالي الطلب" });
      }

      // ش٧: **الفاتورة الحاملة للـCOD واحدةٌ فقط** (البضاعة إن وُجدت، وإلا الطباعة) — لأنّ
      // الإرسالية تُربط بفاتورةٍ واحدة. فلو بقيت فاتورةٌ ثانية غير مدفوعة لصار متبقّيها بلا
      // حاملٍ ولا دافع = مالٌ بلا مسار. لذلك: الطباعة تُسدَّد أولاً كاملةً عند التوصيل، ثم
      // تحمل البضاعةُ المتبقّي عهدةً على المندوب. وبلا توصيلٍ يبقى الترتيب الأصلي كما هو.
      const codCarrier: "SALE" | "PRINT" | null = input.delivery
        ? (input.regularSale ? "SALE" : input.printSale ? "PRINT" : null)
        : null;
      if (input.delivery && codCarrier === "SALE" && printAmount.gt(0) && applied.lt(printAmount)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `طلب التوصيل: تُسدَّد خدمات الطباعة (${printAmount.toFixed(2)}) أوّلاً — المتبقّي المُحصَّل عند الاستلام يكون على فاتورة البضاعة وحدها`,
        });
      }

      // حصص P: البيع العادي ثم الطباعة ثم أوامر الشغل — نفس ترتيب استهلاك N بالضبط.
      // (عند التوصيل بحاملٍ SALE يُقلب الترتيب: الطباعة أولاً كي تبقى الحاملةُ وحدها ناقصة.)
      let preLeft = preTotalD;
      let salePre: ReturnType<typeof money>;
      let printPre: ReturnType<typeof money>;
      if (codCarrier === "SALE") {
        printPre = round2(preLeft.gte(printAmount) ? printAmount : preLeft);
        preLeft = round2(preLeft.minus(printPre));
        salePre = round2(preLeft.gte(regularAmount) ? regularAmount : preLeft);
        preLeft = round2(preLeft.minus(salePre));
      } else {
        salePre = round2(preLeft.gte(regularAmount) ? regularAmount : preLeft);
        preLeft = round2(preLeft.minus(salePre));
        printPre = round2(preLeft.gte(printAmount) ? printAmount : preLeft);
        preLeft = round2(preLeft.minus(printPre));
      }
      preSplit.sale = salePre.toFixed(2);
      preSplit.print = printPre.toFixed(2);

      // ش٧: توزيع **المقبوض فعلاً** (نقداً + سلفاً) على الفواتير بحدّ كلٍّ — كان يفترض أنّه
      // يغطّي البيع المباشر دائماً (صحيحٌ بلا توصيل، خاطئٌ مع COD حيث الدرج لا يستلم شيئاً).
      let leftApplied = applied;
      if (codCarrier === "SALE") {
        printApplied = round2(leftApplied.gte(printAmount) ? printAmount : leftApplied);
        leftApplied = round2(leftApplied.minus(printApplied));
        saleApplied = round2(leftApplied.gte(regularAmount) ? regularAmount : leftApplied);
        leftApplied = round2(leftApplied.minus(saleApplied));
      } else {
        saleApplied = round2(leftApplied.gte(regularAmount) ? regularAmount : leftApplied);
        leftApplied = round2(leftApplied.minus(saleApplied));
        printApplied = round2(leftApplied.gte(printAmount) ? printAmount : leftApplied);
        leftApplied = round2(leftApplied.minus(printApplied));
      }
      let remainingForWork = leftApplied;
      normalizedWorkOrders = normalizedWorkOrders.map((order) => {
        const orderTotal = round2(money(order.salePrice));
        const deposit = remainingForWork.lte(0)
          ? money("0")
          : round2(remainingForWork.gte(orderTotal) ? orderTotal : remainingForWork);
        remainingForWork = round2(remainingForWork.minus(deposit));
        const woPre = round2(preLeft.gte(deposit) ? deposit : preLeft);
        preLeft = round2(preLeft.minus(woPre));
        preSplit.workOrders.push(woPre.toFixed(2));
        const newDeposit = round2(deposit.minus(woPre));
        return {
          ...order,
          deposit: deposit.toFixed(2),
          depositPreCollected: woPre.toFixed(2),
          // طريقة/مرجع إيصال العربون الجديد — تلزم فقط حين يوجد جزءٌ جديد N يُقبض الآن.
          paymentMethod: newDeposit.gt(0) ? input.paymentMethod : null,
          paymentReference: newDeposit.gt(0) && input.paymentMethod !== "CASH"
            ? input.paymentReference?.trim() || null
            : null,
        };
      });
    }

    // ش٠ (V1): العلم يسري على البيع المباشر الخالص النقديّ حصراً — مزجُه بطباعة/أوامر شغل أو
    // بدفعٍ غير نقديّ يُسقطه صامتاً. المختلطة عبر cashRoundingOverride (ش٦) أدناه.
    const roundDirectCash = input.cashRoundIQD === true
      && input.paymentMethod === "CASH"
      && !input.printSale
      && normalizedWorkOrders.length === 0;
    // ش٦ — تقريب السلّة المختلطة: الفاتورة الحاملة تستلم مبلغها (المبيَّت فيه فرق السلّة كلّها)
    // إجماليّاً فعّالاً صريحاً. نقديّ فقط، ولا يجتمع مع علم البيع الخالص.
    const overrideTarget = input.paymentMethod === "CASH" && !roundDirectCash
      ? (input.cashRoundingOverride === "SALE" && input.regularSale ? "SALE"
        : input.cashRoundingOverride === "PRINT" && input.printSale ? "PRINT"
        : null)
      : null;

    // مراجعة PR #495 — أساس تقريب السلّة المختلطة **خادميّ بالكامل**: مجموع أوامر الشغل
    // (سعرُها هو ما يُخزَّن فعلاً على الأمر) + إجماليُّ الفاتورة الأخرى **كما حسبه الخادم**
    // لا كما أرسله العميل. لذلك تُنشأ الفاتورةُ غيرُ الحاملة أوّلاً حين تحمل الأخرى الفرق:
    // الحاملة وحدها تحتاج «الباقي» لتشتقّ الفرق، فلا يبقى للعميل أثرٌ على المبلغ النهائيّ.
    const workTotalServerD = round2(
      normalizedWorkOrders.reduce((sum, order) => sum.plus(money(order.salePrice)), money("0")),
    );
    const buildSale = async (basketOthers: string | null) =>
      input.regularSale
        ? await createSaleInTx(tx, {
          branchId: input.branchId,
          shiftId: input.shiftId,
          customerId: input.customerId ?? null,
          contactName: input.contactName ?? null,
          contactPhone: input.contactPhone ?? null,
          sourceType: "POS",
          priceTier: input.priceTier ?? null,
          couponCode: input.couponCode?.trim() || null,
          lines: input.regularSale.lines,
          cashRoundIQD: roundDirectCash,
          cashRoundingBasketOthers: overrideTarget === "SALE" ? basketOthers : null,
          // ش٤: حصة البيع المباشر من المقبوض سلفاً — تدخل paidAmount بلا إيصالٍ ثانٍ (I5)،
          // والدفعة الجديدة payment.amount تُقلَّص بها (الفاتورة تستلم P + N = أمانها الكامل).
          preCollected: money(preSplit.sale).gt(0) ? { amount: preSplit.sale, receiptIds: [] } : null,
          payment: {
            // ش٧: المدفوع = **المخصَّص فعلاً** لا مبلغ الفاتورة — مع COD يبقى الفرق عهدةَ مندوب.
            amount: round2(saleApplied.minus(money(preSplit.sale))).toFixed(2),
            method: input.paymentMethod,
            reference: input.paymentReference?.trim() || null,
          },
          codDispatchPending: input.delivery != null,
          // الاستقبال (٨/٨): يفتح السالب لطلب COD في وضع الافتتاح بتأكيد الموظّف — رِيلات الأمان في createSaleInTx.
          openingSellUnavailableConfirmed: input.openingSellUnavailableConfirmed === true,
          clientRequestId: `${input.clientRequestId}-sale`,
          offlineCapture: input.offlineCapture ?? null,
          // البضاعة خرجت فعلاً أثناء الانقطاع والنقد قُبض؛ رفض التسجيل يجعل الدفاتر تكذب
          // (قرار المالك ١٨/٧: تسجيل بوسم مراجعة لا تعليق). الوسم = originatedOffline.
          allowNegativeStock: input.offlineCapture != null,
          creditApproved: false,
          receptionDeferredAuthorized,
          priceOverrideApproved: input.priceOverrideApproved === true,
        }, actor)
      : null;

    const buildPrint = async (basketOthers: string | null) =>
      input.printSale
        ? await createPrintSaleInTx(tx, {
          branchId: input.branchId,
          shiftId: input.shiftId,
          customerId: input.customerId ?? null,
          contactName: input.contactName ?? null,
          contactPhone: input.contactPhone ?? null,
          priceTier: input.priceTier ?? null,
          lines: input.printSale.lines,
          cashRoundingBasketOthers: overrideTarget === "PRINT" ? basketOthers : null,
          preCollected: money(preSplit.print).gt(0) ? { amount: preSplit.print, receiptIds: [] } : null,
          payment: {
            // ش٧: المخصَّص فعلاً (الطباعة تُسدَّد كاملةً عند التوصيل بحاملٍ SALE — حارسٌ أعلاه).
            amount: round2(printApplied.minus(money(preSplit.print))).toFixed(2),
            method: input.paymentMethod,
            reference: input.paymentReference?.trim() || null,
          },
          codDispatchPending: input.delivery != null,
          clientRequestId: `${input.clientRequestId}-print`,
          offlineCapture: input.offlineCapture ?? null,
          creditApproved: false,
          receptionDeferredAuthorized,
          priceOverrideApproved: input.priceOverrideApproved === true,
        }, actor)
      : null;

    // ترتيب الإنشاء: غير الحاملة أوّلاً (كي يُعرَف إجماليُّها الخادميّ) ثم الحاملة بأساسها.
    // بلا تقريبٍ مختلط يبقى الترتيب الأصليّ حرفياً (بيع ⇐ طباعة) — صفر تغيير سلوكيّ.
    let regularSale: Awaited<ReturnType<typeof buildSale>>;
    let printSale: Awaited<ReturnType<typeof buildPrint>>;
    if (overrideTarget === "SALE") {
      printSale = await buildPrint(null);
      regularSale = await buildSale(
        round2(money(printSale?.total ?? "0").plus(workTotalServerD)).toFixed(2),
      );
    } else if (overrideTarget === "PRINT") {
      regularSale = await buildSale(null);
      printSale = await buildPrint(
        round2(money(regularSale?.total ?? "0").plus(workTotalServerD)).toFixed(2),
      );
    } else {
      regularSale = await buildSale(null);
      printSale = await buildPrint(null);
    }

    if (!completeReplay && receptionDeferredAuthorized) {
      const deferredAmount = round2(
        money(regularSale?.total ?? "0")
          .minus(saleApplied)
          .plus(money(printSale?.total ?? "0").minus(printApplied)),
      );
      await tx.insert(auditLogs).values({
        userId: actor.userId,
        branchId: input.branchId,
        action: "reception.deferredDirect",
        entityType: "receptionCheckout",
        entityId: input.clientRequestId,
        newValue: JSON.stringify({
          customerId: input.customerId,
          deferredAmount: deferredAmount.toFixed(2),
          regularInvoiceId: regularSale?.invoiceId ?? null,
          printInvoiceId: printSale?.invoiceId ?? null,
        }),
      });
    }

    // ش٦ (V15) — أمانة أجرة توصيل الطلب: إيصال IN نقديّ + قيد DELIVERY_FEE_HELD مربوطان
    // بالفاتورة الحاملة (البيع المباشر ثم الطباعة) — بها يُرفع حظر COUNTER عن dispatchInvoice.
    // تُكتب داخل نفس معاملة المستندات (ذرّية) وتُتخطّى عند replay (كُتبت مع الالتزام الأول).
    // ملاحظة الترتيب: تسبق الإسناد عمداً — dispatchInvoiceInTx يشترط وجودها لقبول COUNTER.
    const feeHeldD = round2(money(input.deliveryFeeHeld ?? "0"));
    if (feeHeldD.gt(0) && !completeReplay) {
      // حارس خادميّ (مراجعة عدائية ٩/٨): حين يُرافق الالتقاطَ توصيلٌ في نفس التثبيت يجب أن
      // تكون أجرته «مقبوضة في الاستقبال» وبنفس المبلغ — أمانةٌ مع توصيل COURIER = المندوب
      // يقبض أجرته من الزبون ثانيةً والأمانة تعلق بلا تبرئة؛ ومبلغٌ يخالف الأجرة يترك فرقاً
      // في الدرج بلا مسار ردّ. **بلا توصيلٍ في التثبيت يبقى الالتقاط مشروعاً** (الإسناد
      // المؤجَّل من الطابور — ش٦/V15): dispatchInvoice يفرض المساواة مع الإيصال لحظة الإسناد،
      // وإلغاء الطلب/الإرجاع يردّانها.
      if (input.delivery && (input.delivery.feeCollection ?? "COURIER") !== "COUNTER") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "أمانة أجرة التوصيل تُقبَض فقط مع توصيلٍ أجرته «مقبوضة في الاستقبال» — أزل المبلغ أو اضبط التوصيل",
        });
      }
      if (input.delivery && !feeHeldD.eq(round2(money(input.delivery.fee ?? "0")))) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `أمانة الأجرة المقبوضة (${feeHeldD.toFixed(2)}) يجب أن تساوي أجرة التوصيل (${round2(money(input.delivery.fee ?? "0")).toFixed(2)})`,
        });
      }
      const carrierInvoiceId = regularSale?.invoiceId ?? printSale?.invoiceId ?? null;
      if (carrierInvoiceId == null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "أجرة التوصيل المقبوضة الآن تحتاج فاتورةً في السلّة (بضاعة أو طباعة) — أوامر الشغل وحدها أجرتُها على بندها",
        });
      }
      const feeRes = await tx.insert(receipts).values({
        branchId: input.branchId,
        shiftId: input.shiftId,
        invoiceId: carrierInvoiceId,
        direction: "IN",
        amount: feeHeldD.toFixed(2),
        // أمانةٌ نقديّة للمندوب تدخل الدرج حتماً — مهما كانت طريقة دفع السلّة (تُصرف له نقداً
        // من نفس الدرج عند توريده، فقبضُها بغير النقد يترك OUT بلا IN).
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        status: "COMPLETED",
        partyType: "OTHER",
        referenceNumber: `DLV-FEE-INV-${carrierInvoiceId}`,
        description: "أجرة توصيل مقبوضة أمانةً للمندوب — طلب استقبال",
        createdBy: actor.userId,
      });
      await postEntry(tx, {
        entryType: "DELIVERY_FEE_HELD",
        dedupeKey: `DELIVERY_FEE_HELD:INV:${carrierInvoiceId}`,
        branchId: input.branchId,
        invoiceId: carrierInvoiceId,
        receiptId: extractInsertId(feeRes),
        amount: feeHeldD,
        notes: "أمانة أجرة توصيل — طلب استقبال",
      });
    }

    // ش٧ (قرار المالك ٦/٨) — **الإسناد داخل المعاملة**: متبقّي فاتورة التوصيل يصير عهدةً على
    // المندوب (DELIVERY_DISPATCH) في نفس اللحظة التي تُنشأ فيها الفاتورة. بهذا لا توجد لحظةٌ
    // واحدة يكون فيها مالٌ بلا مالك: إمّا (فاتورة + عهدة) معاً وإمّا لا شيء.
    let dispatch: Awaited<ReturnType<typeof dispatchInvoiceInTx>> | null = null;
    if (input.delivery && !completeReplay) {
      const carrierInvoiceId = regularSale?.invoiceId ?? printSale?.invoiceId ?? null;
      if (carrierInvoiceId == null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "التوصيل يحتاج فاتورةً في الطلب (بضاعة أو طباعة) — أوامر الشغل تُسلَّم من طابور الطلبات عند جاهزيّتها",
        });
      }
      dispatch = await dispatchInvoiceInTx(
        tx,
        {
          invoiceId: carrierInvoiceId,
          partyId: input.delivery.partyId,
          deliveryFee: input.delivery.fee ?? "0",
          feeCollection: input.delivery.feeCollection ?? "COURIER",
          recipientName: input.delivery.recipientName ?? input.contactName ?? null,
          recipientPhone: input.delivery.recipientPhone ?? input.contactPhone ?? null,
          deliveryAddress: input.delivery.address ?? null,
          clientRequestId: `${input.clientRequestId}-dispatch`,
        },
        { userId: actor.userId, branchId: actor.branchId ?? null, role: actor.role } as never,
      );
    }

    // ش٦ (§٩.٣) — هويّة مُقِرّ السعر داخل المعاملة: الراية بلا هويّةٍ كانت تُذيب المسؤولية.
    if (!completeReplay && input.priceOverrideApproved === true && input.priceApprovedBy != null) {
      const overriddenLines = [
        ...(input.regularSale?.lines ?? []).filter((l) => l.unitPriceOverride != null || l.discountAmount != null),
        ...(input.printSale?.lines ?? []).filter((l) => (l as { unitPriceOverride?: string }).unitPriceOverride != null),
      ].map((l) => ({
        variantId: (l as { variantId?: number }).variantId ?? null,
        productUnitId: (l as { productUnitId?: number }).productUnitId ?? null,
        finalUnitPrice: (l as { unitPriceOverride?: string }).unitPriceOverride ?? null,
        discountAmount: (l as { discountAmount?: string }).discountAmount ?? null,
      }));
      await tx.insert(auditLogs).values({
        userId: actor.userId,
        branchId: input.branchId,
        action: "reception.priceOverride",
        entityType: "invoice",
        entityId: String(regularSale?.invoiceId ?? printSale?.invoiceId ?? 0),
        newValue: JSON.stringify({ approvedBy: input.priceApprovedBy, lines: overriddenLines }),
      });
    }

    const workOrders = [] as Array<Awaited<ReturnType<typeof createWorkOrderInTx>> & { deposit: string }>;
    for (let index = 0; index < normalizedWorkOrders.length; index += 1) {
      const order = normalizedWorkOrders[index];
      const created = await createWorkOrderInTx(tx, {
        ...order,
        branchId: input.branchId,
        customerId: input.customerId ?? null,
        contactName: order.contactName ?? input.contactName ?? null,
        contactPhone: order.contactPhone ?? input.contactPhone ?? null,
        clientRequestId: `${input.clientRequestId}-wo-${index}`,
        // ش٠ (V4): الوردية المُتحقَّق منها أعلاه (OPEN + RECEPTION + الفرع + المالك تحت قفل) تُمرَّر
        // لكل أمر شغل ⇒ عرابين السلة تهبط على درج قابضها نفسه، لا على وردية أخرى يحلّها
        // openShiftIdTx بنفسه (سلّةٌ كانت قابلة للانشطار على درجين ⇒ محاسبة موظّفٍ على نقدٍ لم يستلمه).
        shiftId: input.shiftId,
      }, actor);
      // ش٤: العربون الموزَّع يرافق النتيجة — تطبعه تذكرة الأمر («مدفوع مقدماً/المتبقّي») بلا
      // إعادة حسابٍ واجهيّ قد ينحرف عن الجشع الخادميّ.
      workOrders.push({ ...created, deposit: round2(money(order.deposit ?? "0")).toFixed(2) });
    }

    return { regularSale, printSale, workOrders, preSplit, dispatch };
  }
}
