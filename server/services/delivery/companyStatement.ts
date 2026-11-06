/**
 * **كشف شركة التوصيل** — مستند التسوية الموحّد (إطار المالك نسخة ٢، ١٩/٨).
 *
 * نصّ المالك: «كشف الشركة هو الدليل الأساسيّ للشركات التي لا تملك بوابة. بوابة المندوب
 * اختيارية، والإثبات اليدوي الاستثنائي يحتاج دليلاً وموافقة مدير».
 *
 * ═══ العقدة التي يفكّها ═══
 * التوريد يشترط على كل سطر `parcelStatus = DELIVERED`، وختمُ التسليم حصريٌّ ببوّابة المندوب
 * (`courierProcedure` + عضوية جهةٍ نشطة). وأغلب جهات التوصيل **كيانُ بياناتٍ بلا حساب نظام**
 * ⇒ لا سطر يُختَم مُسلَّماً أبداً ⇒ لا توريد ولا أجرة، والمال يعلق بلا مخرج. الكشف يجعل سطرَه
 * هو الدليل: يقود **إثبات التسليم ثمّ التحصيل ثمّ التوريد**.
 *
 * ═══ الذرّية الماليّة والمحاسبيّة ═══
 * الكشفُ كلُّه وحدةُ عملٍ واحدة: إثبات التسليم، تحصيل الفاتورة، نقل ذمّة العميل إلى عهدة
 * شركة التوصيل، ثمّ التوريد إلى الدرج والقيود المحاسبيّة وسجلّ التدقيق. كلُّ الخدمات الماليّة
 * تُستدعى بجسمها الداخليّ على **نفس معاملة قاعدة البيانات**؛ أيّ رفضٍ في آخر خطوة يعيد كلّ
 * ما سبقها؛ أسطر الإثبات التي لا تتضمن نقداً لا تنشئ سند توريد.
 *
 * ═══ أسطر الصفر = إثبات تسليمٍ بلا نقد (٢١/٨) ═══
 * الكشف الواقعيّ يحمل نوعَي سطر: **سطرُ مالٍ** (`collectedAmount > 0`) يمرّ بالمرحلتين، و**سطرُ
 * إثباتٍ** (`= 0`) يمرّ بالمرحلة ① وحدها — طردٌ سلّمته الشركةُ بلا تحصيل (COD=0 مدفوعٌ سلفاً،
 * أو زبونٌ لم يدفع). تمريرُه للمرحلة ② كان يُفجّرها: الطرد الصفريّ يُغلَق `status=DELIVERED`
 * عند الختم فيرفضه حارسُ «غير قابلة للتسوية» ويُسقط الكشفَ المختلط كلَّه.
 * سطر إثبات لطرد ذي مطالبة موجبة يحتاج قرار المسؤولية ولقطة المبالغ الصريحة؛ يبقى النقد
 * المثبت عهدةً على الجهة، وتُحدد مسؤولية الجزء غير المثبت للعميل أو لجهة التوصيل.
 *
 * ═══ عدم التكرار والدفعات ═══
 * مفتاح الطلب يمتصّ الإعادة، والكشف الأصلي فريد للجهة. إضافته كدفعة لاحقة تتطلب اختياراً
 * صريحاً، وترتبط بسند مستقل ولا تعيد إرسالية من سند سابق. يحتفظ السند الأول بالرقم القديم
 * وفهرسه الفريد؛ الدفعات التالية تصل إلى الرقم عبر رأس الكشف. الإثبات المحض لا ينشئ سنداً.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { deliveryCompanyStatementBatches, deliveryCompanyStatements, deliveryConsignments, deliveryLedgerEntries, deliveryParties, deliveryRemittanceLines, deliveryRemittances, invoices } from "../../../drizzle/schema";
import { getDb, type Tx } from "../../db";
import { isDupEntry } from "@shared/errorMap.ar";
import { appErrorMessage } from "@shared/errors";
import { isShortfallReason } from "@shared/shortfallReason";
import Decimal from "decimal.js";
import { money, round2, toDbMoney } from "../money";
import { confirmConsignmentDelivery, recordSupplementaryStatementCollection, type ConfirmConsignmentResult } from "./courier";
import {
  findDeliveryRemittanceReplayInTx,
  lockDeliveryRemittanceCashSourceInTx,
  recordDeliveryRemittanceInTx,
  type DeliveryRemittanceCashSourceLock,
  type RemittanceInput,
} from "./remittance";
import type { DeliveryTxActor } from "./types";
import { withTx } from "../tx";
import { loadShipmentMembersTx, operationalShipmentMembers } from "./shipments";
import { unremittedCollectionForConsignmentTx } from "./collectionAccounting";
import { shortfallAssignedForConsignmentTx } from "./openParcelPredicates";
import { assignedGoodsCodDue, collectAssignedConsignmentClaimsTx, loadAssignedChargeClaimsTx } from "../fulfillment/chargeDelivery";
import { creditCollectionChoiceTx } from "./creditCollectionTerms";
import { effectiveDeliveryLedgerEntrySql } from "./legacyLedger";
import { extractInsertId } from "../../lib/insertId";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { adjustCustomerBalance, adjustDeliveryBalance, computeInvoiceStatus, postEntry } from "../ledgerService";
import { appendDeliveryEvent, appendDeliveryLedgerEntry } from "./lifecycle";
import { deliveryCustomerCollectionIntent, deliveryDispatchMemoIntent } from "./posting";

export type StatementShortfallResponsibility = "CUSTOMER" | "DELIVERY_PARTY" | "COURIER_CUSTODY";

export interface CompanyStatementLineInput {
  consignmentId: number;
  /** المبلغ المورد على هذه الإرسالية في هذه الدفعة، وقد يكون صفراً. */
  collectedAmount: string;
  /** سبب مصنف مطلوب حين يُسند الجزء غير المثبت إلى الجهة، بما فيه الطرد المختوم سابقاً. */
  shortfallReason?: string | null;
  shortfallResponsibility?: StatementShortfallResponsibility | null;
  /** Preview pair; both must match current values under the transaction locks. */
  expectedDue?: string | null;
  expectedProven?: string | null;
  zeroDeliveryConfirmed?: boolean;
}

export interface CompanyStatementInput {
  branchId: number;
  partyId: number;
  statementNumber: string;
  /** Deliberate continuation of a previously saved original document. */
  appendToStatement?: boolean;
  statementDate?: string | null;
  attachmentUrl?: string | null;
  /** استقطاعات الشركة (أجور توصيل حسمتها من الحصيلة) — إفصاحٌ على المستند. */
  deductionsTotal?: string | null;
  notes?: string | null;
  lines: CompanyStatementLineInput[];
  /** النقد المعدود فعلاً — تفرض آلةُ التوريد مطابقتَه لصافي الكشف بالضبط. */
  countedCash: string;
  shiftType?: "RECEPTION" | "RETAIL";
  /**
   * ش-ISOLATION — الوردية/الدرج الذي سيستلم هذا النقد فعلياً.
   * يُجاوز `shiftType` والبحث الآلي بـ`actor.userId` حين يكون الفرع فيه
   * أكثر من وردية مفتوحة لموظفَين مختلفَين.
   * بدونه: السلوك الحالي (درج actor) — متوافق للخلف تماماً.
   */
  targetShiftId?: number | null;
  clientRequestId?: string | null;
}

export interface CompanyStatementResult {
  /** `null` = كل أسطر الكشف صفرية؛ قد يثبت عجز على الجهة لكن لا يوجد سند توريد أو نقد. */
  remittanceId: number | null;
  remittanceNumber: string | null;
  statementNumber: string;
  /** عدد الأسطر التي أثبت الكشفُ تسليمها الآن (لم تكن مختومة) — أثرٌ يُعرَض للمستخدم. */
  deliveriesConfirmed: number;
  collectedTotal: string;
  netRemitted: string;
  /** كل أسطر الكشف إثباتُ تسليمٍ بلا نقد ⇒ تخطّينا المرحلة ② (التوريد) كلّياً. */
  proofOnly?: boolean;
  idempotentReplay?: boolean;
}

type DeliveryRemittanceReplay = NonNullable<
  Awaited<ReturnType<typeof findDeliveryRemittanceReplayInTx>>
>;

function companyStatementReplayResult(
  statementNumber: string,
  replay: DeliveryRemittanceReplay,
): CompanyStatementResult {
  return {
    remittanceId: replay.remittanceId,
    remittanceNumber: replay.remittanceNumber,
    statementNumber,
    // replay لا ينفّذ أثراً جديداً؛ العدد يصف هذه المحاولة لا المحاولة الأصلية.
    deliveriesConfirmed: 0,
    collectedTotal: replay.collectedTotal,
    netRemitted: replay.netRemitted,
    idempotentReplay: true,
  };
}

/** طول عمود `deliveryRemittances.companyStatementNumber` (varchar 64) — سقفُ أيّ رقم كشفٍ مشتقّ. */
const STATEMENT_NUMBER_MAX = 64;

/** يرتدّ بخطأٍ مفهوم بدل خطأ قاعدةٍ خامّ حين يُعاد إدخال كشفٍ مسجَّل. */
async function assertStatementNotUsed(
  partyId: number,
  statementNumber: string,
  existingTx?: Tx,
) {
  const db = existingTx ?? getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const query = db.select({ id: deliveryRemittances.id, number: deliveryRemittances.remittanceNumber })
    .from(deliveryRemittances).where(and(
      eq(deliveryRemittances.partyId, partyId), eq(deliveryRemittances.companyStatementNumber, statementNumber),
    ));
  const existing = (await (existingTx ? query.for("share") : query).limit(1))[0];
  if (existing) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `كشف الشركة «${statementNumber}» مُسجَّلٌ سلفاً على سند التوريد ${existing.number} — لا يُدخَل مرّتين`,
    });
  }
}

/** Party is locked by the caller. Existing receipts are linked, never rewritten. */
async function prepareStatementBatchTx(tx: Tx, input: CompanyStatementInput, statementNumber: string, actor: DeliveryTxActor) {
  let header = (await tx.select().from(deliveryCompanyStatements).where(and(
    eq(deliveryCompanyStatements.partyId, input.partyId), eq(deliveryCompanyStatements.statementNumber, statementNumber),
  )).for("update").limit(1))[0];
  const legacy = (await tx.select().from(deliveryRemittances).where(and(
    eq(deliveryRemittances.partyId, input.partyId), eq(deliveryRemittances.companyStatementNumber, statementNumber),
  )).for("share").limit(1))[0];
  const exists = !!header || !!legacy;
  if (exists && !input.appendToStatement) {
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "كشف الشركة مسجّل سلفاً", why: `الكشف ${statementNumber} مرتبط بتوريد سابق`, doThis: "راجع سندات الكشف واختر إكمال الكشف السابق صراحةً لإضافة شحنة أخرى" }) });
  }
  if (!exists && input.appendToStatement) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({ what: "تعذر إكمال كشف الشركة", why: `لا يوجد كشف سابق بالرقم ${statementNumber} لهذه الجهة`, doThis: "تحقق من الرقم أو سجل الكشف لأول مرة دون خيار الإكمال" }) });
  }
  if ((header && Number(header.branchId) !== input.branchId) || (legacy && Number(legacy.branchId) !== input.branchId)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({ what: "تعذر إكمال كشف الشركة", why: "الكشف الأصلي يخص فرعاً آخر", doThis: "افتح الكشف من الفرع الذي استلم دفعته الأولى" }) });
  }
  if (!header) {
    const id = extractInsertId(await tx.insert(deliveryCompanyStatements).values({
      partyId: input.partyId, branchId: input.branchId, statementNumber,
      statementDate: legacy?.statementDate ?? (input.statementDate ? new Date(input.statementDate) : null),
      attachmentUrl: legacy?.statementAttachmentUrl ?? input.attachmentUrl ?? null,
      createdBy: actor.userId,
    }));
    header = (await tx.select().from(deliveryCompanyStatements).where(eq(deliveryCompanyStatements.id, id)).limit(1))[0];
    if (legacy) await tx.insert(deliveryCompanyStatementBatches).values({ statementId: id, remittanceId: Number(legacy.id) });
  }
  if (!header) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء سجل الكشف" });
  const originalDate = header.statementDate ? new Date(header.statementDate).toISOString().slice(0, 10) : null;
  if (exists && ((input.statementDate && input.statementDate !== originalDate) ||
      (input.attachmentUrl?.trim() && input.attachmentUrl.trim() !== header.attachmentUrl))) {
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
      what: "تعذر إكمال كشف الشركة", why: "تاريخ الكشف أو مرفقه يختلف عن المستند الأصلي",
      doThis: "راجع بيانات الكشف الأصلي وأضف الدفعة دون تغيير مستنده",
    }) });
  }
  const prior = await tx.select({ id: deliveryCompanyStatementBatches.remittanceId }).from(deliveryCompanyStatementBatches)
    .where(eq(deliveryCompanyStatementBatches.statementId, Number(header.id))).for("share");
  if (exists && prior.length === 0) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({ what: "تعذر إكمال كشف الشركة", why: "سجل الكشف السابق لا يرتبط بأي سند توريد", doThis: "راجع سجل الكشف مع المحاسب قبل إضافة دفعة" }) });
  }
  if (prior.length) {
    const priorIds = prior.map((row) => Number(row.id));
    const priorHeaders = await tx.select({ id: deliveryRemittances.id, total: deliveryRemittances.collectedTotal })
      .from(deliveryRemittances).where(inArray(deliveryRemittances.id, priorIds)).for("share");
    const priorLines = await tx.select({ remittanceId: deliveryRemittanceLines.remittanceId,
      grossApplied: deliveryRemittanceLines.grossApplied, legacySnapshot: deliveryRemittanceLines.legacySnapshot })
      .from(deliveryRemittanceLines).where(inArray(deliveryRemittanceLines.remittanceId, priorIds)).for("share");
    if (priorHeaders.length !== priorIds.length || priorHeaders.some((receipt) => {
      const lines = priorLines.filter((line) => Number(line.remittanceId) === Number(receipt.id));
      return lines.some((line) => line.legacySnapshot) ||
        !round2(lines.reduce((sum, line) => sum.plus(money(line.grossApplied)), money(0))).eq(money(receipt.total));
    })) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
        what: "تعذر إكمال الكشف التاريخي تلقائياً", why: "أسطر أحد سندات الكشف السابق غير مكتملة أو مستخرجة من لقطة تاريخية",
        doThis: "طابق السند وفواتيره مع كشف الشركة الأصلي قبل إضافة دفعة جديدة",
      }) });
    }
    const duplicate = await tx.select({ consignmentId: deliveryRemittanceLines.consignmentId }).from(deliveryRemittanceLines)
      .where(and(inArray(deliveryRemittanceLines.remittanceId, priorIds),
        inArray(deliveryRemittanceLines.consignmentId, input.lines.map((line) => line.consignmentId))))
      .for("share").limit(1);
    if (duplicate.length) throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
      what: "تعذر إضافة دفعة الكشف", why: `الإرسالية ${duplicate[0].consignmentId} موجودة في سند سابق للكشف نفسه`,
      doThis: "راجع الدفعات المسجلة وحدد الشحنات التي لم تُورّد بعد فقط",
    }) });
  }
  return { statementId: Number(header.id), storeOriginalNumber: !exists };
}

/**
 * قراءةُ أسطر الكشف والتحقّق من ملكيّتها **قبل أيّ كتابة**: كل إرساليةٍ موجودةٌ وتخصّ الجهةَ
 * والفرعَ المذكورَين. مشتركة بين الكشف الكامل وإثبات التسليم المستنديّ كي لا ينجرف تحقّقان.
 */
async function loadStatementConsignments(input: {
  branchId: number;
  partyId: number;
  lines: CompanyStatementLineInput[];
}, existingTx?: Tx) {
  const db = existingTx ?? getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const ids = input.lines.map((l) => Number(l.consignmentId));
  const query = db
    .select({
      id: deliveryConsignments.id,
      partyId: deliveryConsignments.partyId,
      branchId: deliveryConsignments.branchId,
      parcelStatus: deliveryConsignments.parcelStatus,
      status: deliveryConsignments.status,
      moneyStatus: deliveryConsignments.moneyStatus,
      codAmount: deliveryConsignments.codAmount,
      collectedAmount: deliveryConsignments.collectedAmount,
      counterSettledAmount: deliveryConsignments.counterSettledAmount,
      custodyRecognizedAt: deliveryConsignments.custodyRecognizedAt,
      createdAt: deliveryConsignments.createdAt,
      invoiceId: deliveryConsignments.invoiceId,
      sourceType: deliveryConsignments.sourceType,
      fulfillmentRequestId: deliveryConsignments.fulfillmentRequestId,
      aftercareExecutionId: deliveryConsignments.aftercareExecutionId,
      returnDeclaredAt: deliveryConsignments.returnDeclaredAt,
    })
    .from(deliveryConsignments)
    .where(inArray(deliveryConsignments.id, ids))
    .orderBy(asc(deliveryConsignments.id));
  const rows = await (existingTx ? query.for("update") : query);
  const byId = new Map(rows.map((r) => [Number(r.id), r]));

  for (const id of ids) {
    const cn = byId.get(id);
    if (!cn) throw new TRPCError({ code: "NOT_FOUND", message: `الإرسالية ${id} غير موجودة` });
    if (Number(cn.partyId) !== Number(input.partyId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `الإرسالية ${id} لا تخصّ هذه الجهة` });
    }
    if (Number(cn.branchId) !== Number(input.branchId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `الإرسالية ${id} تخصّ فرعاً آخر` });
    }
  }
  return { ids, byId };
}

/**
 * تحقّقٌ مسبقٌ لأسطر الكشف قبل الكتابة: تجاوز المتبقّي الحيّ أو رجوعٌ مُعلَن.
 * الحسمُ النهائيّ يبقى داخل المعاملة وتحت أقفال الصفوف في خدمات التسليم والتوريد.
 */
async function preValidateStatementLines(
  input: { partyId: number; lines: CompanyStatementLineInput[] },
  ids: number[],
  byId: Map<number, {
    codAmount: string; collectedAmount: string; invoiceId: number | null;
    sourceType?: string; fulfillmentRequestId?: number | null;
    parcelStatus: string; returnDeclaredAt: unknown;
  }>,
) {
  // 1) تجاوزُ COD أو رجوعٌ مُعلَن لكل سطر — تحقّقٌ محلّيّ من صفوف الإرسالية.
  for (const l of input.lines) {
    const cn = byId.get(Number(l.consignmentId));
    if (!cn) continue;
    if (cn.returnDeclaredAt != null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `الإرسالية ${l.consignmentId} أُعلن رجوعُها — لا يُثبَت تسليمها من كشف`,
      });
    }
    const declared = round2(money(l.collectedAmount));
    if (cn.sourceType === "AFTERCARE_EXECUTION" && !declared.isZero()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذر تحصيل مبلغ على معالجة مجانية", why: "إرسالية المعالجة لا تحمل مطالبة مالية على العميل", doThis: "سجّل إثبات التسليم بمبلغ صفر دون تغيير الفاتورة الأصلية" }) });
    }
    const codAmount = round2(money(cn.codAmount));
    const currentCollected = round2(money(cn.collectedAmount ?? "0"));
    const available = round2(codAmount.minus(currentCollected));
    if (declared.gt(available) && cn.sourceType !== "FULFILLMENT_REQUEST" && cn.fulfillmentRequestId == null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `الإرسالية ${l.consignmentId}: مبلغ هذا الكشف ${declared.toFixed(2)} أكثر من المتبقّي ${available.isNegative() ? "0.00" : available.toFixed(2)} (COD ${codAmount.toFixed(2)} ناقص المحصّل سابقاً ${currentCollected.toFixed(2)})`,
      });
    }
  }
  // ⚠️ متبقّي الفاتورة يُفحَص داخل `confirmConsignmentDelivery` و`recordSupplementaryStatementCollection`
  // تحت قفل .for("update") — وهو المرجعُ الحاسمُ. فحصُه هنا استرشادياً بلا قفل يُنتج **إنذاراتٍ
  // كاذبة** حين تسدَّد الفاتورة بمسارٍ مشروعٍ سابقاً (عربونٌ عند الاستقبال أو دفعةٌ متجرية) فيبقى
  // `paidAmount>0` عند القراءة قبل الإثبات ⇒ نرفضُ تحصيلاً سيمرّ فعلاً داخل المعاملة (invoiceRemaining
  // يُحسَب من `collectedAmount + counterSettled + الأصل` لا paidAmount وحده). نتركُ الفحصَ لموقعه
  // الأصليّ ونكتفي هنا بالسطور المحلّية (رجوعٌ مُعلَن، تجاوز المتبقّي الحيّ).
}

/**
 * تطبيعُ مبالغ الأسطر + رفضُ السالب قبل أيّ كتابة، وفرزُها: **أسطرُ مالٍ** (>0) تمرّ
 * بالمرحلتين، و**أسطرُ إثباتٍ** (=0) بالمرحلة ① وحدها (انظر رأس الملف).
 */
function splitStatementLines(lines: CompanyStatementLineInput[]) {
  const collectedByLine = new Map<number, string>();
  const reasonByLine = new Map<number, string>();
  const moneyLines: CompanyStatementLineInput[] = [];
  for (const l of lines) {
    const amt = round2(money(l.collectedAmount));
    if (amt.lt(0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `مبلغ تحصيلٍ سالب على سطر الإرسالية ${l.consignmentId} — صحّح الكشف قبل الإدخال`,
      });
    }
    const reason = l.shortfallReason?.trim() || null;
    if (reason && !isShortfallReason(reason)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
        what: `تعذر تسجيل سبب العجز للإرسالية ${l.consignmentId}`,
        why: "سبب العجز غير معروف في القائمة",
        doThis: "اختر سبباً من قائمة أسباب العجز ثم أعد تسجيل الكشف",
      }) });
    }
    if (l.shortfallResponsibility && !["CUSTOMER", "DELIVERY_PARTY", "COURIER_CUSTODY"].includes(l.shortfallResponsibility)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
        what: `تعذر تحديد مسؤولية فرق الإرسالية ${l.consignmentId}`,
        why: "مسؤولية الفرق غير معروفة",
        doThis: "اختر العميل أو جهة التوصيل أو العهدة المثبتة وفق مستند التحصيل",
      }) });
    }
    if (l.shortfallResponsibility === "DELIVERY_PARTY" && !reason) {
      throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
        what: `تعذر إسناد فرق الإرسالية ${l.consignmentId} إلى جهة التوصيل`,
        why: "يجب تحديد سبب مصنّف للفرق على جهة التوصيل",
        doThis: "اختر سبب العجز من القائمة بعد مراجعة كشف الشركة",
      }) });
    }
    if (reason && l.shortfallResponsibility && l.shortfallResponsibility !== "DELIVERY_PARTY") {
      throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
        what: `تعذر تسجيل فرق الإرسالية ${l.consignmentId}`,
        why: "سبب عجز جهة التوصيل يتعارض مع مسؤولية الفرق المختارة",
        doThis: "راجع مستند التحصيل، ثم اختر مسؤولية الجهة أو أزل سبب العجز",
      }) });
    }
    if ((l.expectedDue == null) !== (l.expectedProven == null)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
        what: `تعذر مطابقة معاينة الإرسالية ${l.consignmentId}`,
        why: "يلزم إرسال المطالبة والتحصيل المثبت معاً",
        doThis: "حدّث معاينة الكشف لإرسال المبلغين الحاليين ثم أعد التسجيل",
      }) });
    }
    // التكرار يُرفض هنا لا في آلة التوريد وحدها: سطرا (صفر + مال) لنفس الطرد كانا سيندمجان
    // صامتَين قبل أن تراهما — والمرحلة ① تسبقها فلا يحميها حارسُها.
    if (collectedByLine.has(Number(l.consignmentId))) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `الإرسالية ${l.consignmentId} مكرّرة في أسطر الكشف — سطرٌ واحد لكل طرد`,
      });
    }
    collectedByLine.set(Number(l.consignmentId), amt.toFixed(2));
    if (reason) reasonByLine.set(Number(l.consignmentId), reason);
    if (amt.gt(0)) {
      moneyLines.push({ consignmentId: Number(l.consignmentId), collectedAmount: amt.toFixed(2) });
    }
  }
  return { collectedByLine, reasonByLine, moneyLines };
}

async function recordStatementRequestTx(tx: Tx, key: string | null | undefined, refId: number, hash: string) {
  if (!key) return;
  try {
    await recordIdempotencyKey(tx, "delivery.companyStatement", key, refId, hash);
  } catch (error) {
    if (isDupEntry(error)) throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
      what: "تعذر تسجيل طلب الكشف",
      why: "معرّف طلب الكشف سُجّل بالتزامن؛ راجع العملية قبل إعادة المحاولة",
      doThis: "افتح سجل كشوف الشركة وتحقق من الطلب المسجل قبل استخدام معرّف جديد",
    }) });
    throw error;
  }
}

/** Transfer only the still-unpaid customer claim, never proven courier cash. */
async function assignDeliveredStatementShortfallTx(
  tx: Tx,
  cn: { id: number; partyId: number; branchId: number; invoiceId: number | null; fulfillmentRequestId: number | null },
  amount: Decimal,
  reason: string,
  statementKey: string,
  actor: DeliveryTxActor,
) {
  if (amount.lte(0)) return;
  const suffix = idempotencyHash({ statementKey, consignmentId: cn.id }).slice(0, 32);
  if (cn.fulfillmentRequestId != null) {
    // The classified-claim helper owns the allocation and its legacy fixed key.
    const existing = await tx.select({ id: deliveryLedgerEntries.id }).from(deliveryLedgerEntries)
      .where(eq(deliveryLedgerEntries.eventKey, `CN:${cn.id}:SHORTFALL_ASSIGNED`)).for("share").limit(1);
    if (existing.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
      what: "تعذر تسجيل عجز إضافي للطلب المصنف", why: "يوجد قيد عجز سابق يحتاج مطابقة قبل إعادة التخصيص",
      doThis: "راجع مطالبات الطلب ودفتر العجز قبل إكمال الكشف",
    }) });
    const result = await collectAssignedConsignmentClaimsTx(tx, {
      consignmentId: cn.id, actualAmount: "0.00", eventKey: statementKey,
      shortfallReason: reason, supplementary: true,
    }, { userId: actor.userId, branchId: cn.branchId });
    if (!result || !money(result.shortfallAmount).eq(amount)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
        what: `تعذر إسناد عجز الإرسالية ${cn.id}`,
        why: "مطالبات الطلب المصنف لا تطابق الفرق غير المثبت",
        doThis: "طابق مطالبات الطلب مع دفتر الإرسالية ثم أعد تسجيل الكشف",
      }) });
    }
    return;
  }
  const invoice = cn.invoiceId == null ? undefined : (await tx.select().from(invoices)
    .where(eq(invoices.id, cn.invoiceId)).for("update").limit(1))[0];
  if (!invoice || ["CANCELLED", "RETURNED", "SUPERSEDED"].includes(invoice.status) ||
      Number(invoice.branchId) !== cn.branchId ||
      !round2(Decimal.max(0, money(invoice.total).minus(money(invoice.returnedTotal ?? "0"))
        .minus(money(invoice.paidAmount)))).eq(amount)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
      what: `تعذر إسناد عجز الإرسالية ${cn.id}`,
      why: "متبقي الفاتورة لا يطابق الفرق غير المثبت على جهة التوصيل",
      doThis: "راجع حالة الفاتورة ومتبقيها ودفتر الإرسالية قبل تسجيل العجز",
    }) });
  }
  await adjustDeliveryBalance(tx, cn.partyId, amount);
  await appendDeliveryLedgerEntry(tx, {
    eventKey: `CN:${cn.id}:SHORTFALL_ASSIGNED:STMT:${suffix}`,
    partyId: cn.partyId, consignmentId: cn.id, branchId: cn.branchId,
    entryType: "SHORTFALL_ASSIGNED", amount: toDbMoney(amount),
    shortfallReason: reason, actorUserId: actor.userId,
  });
  await postEntry(tx, {
    entryType: "DELIVERY_DISPATCH", branchId: cn.branchId, invoiceId: cn.invoiceId,
    deliveryPartyId: cn.partyId, amount, createdBy: actor.userId,
    dedupeKey: `DELIVERY_CUSTODY_STMT_SHORT:${cn.id}:${suffix}`,
    postingIntent: deliveryDispatchMemoIntent(), notes: "عجز تحصيل متمم مثبت بكشف الشركة",
  });
  await postEntry(tx, {
    entryType: "PAYMENT_IN", branchId: cn.branchId, invoiceId: cn.invoiceId,
    customerId: invoice.customerId, deliveryPartyId: cn.partyId, amount, createdBy: actor.userId,
    dedupeKey: `PAYMENT_IN:COURIER_DELIVERY_SUPP:${cn.id}:${suffix}`,
    postingIntent: deliveryCustomerCollectionIntent(amount), notes: "نقل المتبقي غير المحصل إلى ذمة جهة التوصيل",
  });
  const paid = round2(money(invoice.paidAmount).plus(amount));
  await tx.update(invoices).set({ paidAmount: toDbMoney(paid),
    status: computeInvoiceStatus(invoice.total, toDbMoney(paid), invoice.returnedTotal), paymentDate: new Date() })
    .where(eq(invoices.id, invoice.id));
  if (invoice.customerId != null) await adjustCustomerBalance(tx, Number(invoice.customerId), amount.neg());
}

export async function recordCompanyStatement(
  input: CompanyStatementInput,
  actor: DeliveryTxActor,
): Promise<CompanyStatementResult> {
  const statementNumber = input.statementNumber.trim();
  if (statementNumber.length < 2) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "رقم كشف الشركة مطلوب" });
  }
  if (!input.lines.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الكشف بلا أسطر" });
  }
  const { collectedByLine, reasonByLine, moneyLines } = splitStatementLines(input.lines);
  if (input.lines.some((line) => line.shortfallReason?.trim() && line.shortfallResponsibility !== "DELIVERY_PARTY")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
      what: "تعذر تسجيل سبب العجز في كشف الشركة",
      why: "سبب عجز جهة التوصيل يحتاج اختيار مسؤوليتها صراحةً",
      doThis: "راجع السطر واختر مسؤولية جهة التوصيل أو أزل سبب العجز",
    }) });
  }
  const proofOnly = moneyLines.length === 0;
  if (proofOnly) {
    if (input.appendToStatement) {
      throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
        what: "تعذر إكمال كشف الشركة بإثبات بلا نقد",
        why: "إثبات بلا نقد لا ينشئ دفعة كشف؛ أزل خيار إكمال الكشف",
        doThis: "سجّل الإثبات دون خيار إكمال الكشف، أو أضف مبلغ الدفعة التي استلمتها",
      }) });
    }
    // كشفُ إثباتٍ محض: لا نقد يدخل ⇒ نقدٌ معدودٌ غير صفريّ تناقضٌ يُرفض **قبل أيّ كتابة**
    // — قبولُه كان سيُدخل الدرجَ مالاً بلا سطرٍ يقابله (خرقُ «لا دينار بلا مسار» §٥).
    if (!round2(money(input.countedCash)).isZero()) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `كل أسطر الكشف صفرية (إثبات تسليمٍ بلا نقد) والنقد المعدود ${round2(money(input.countedCash)).toFixed(2)} — أدخِل صفراً، أو أضف أسطر التحصيل التي يقابلها هذا النقد`,
      });
    }
    // والاستقطاع يُحسم **من الحصيلة** — لا حصيلةَ هنا يُحسم منها.
    if (!round2(money(input.deductionsTotal ?? "0")).isZero()) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "كشفٌ بلا أسطر تحصيلٍ لا يحمل استقطاعاً — الاستقطاع يُحسم من الحصيلة",
      });
    }
  }

  const remittanceInput: RemittanceInput | null = proofOnly
    ? null
    : {
        branchId: input.branchId,
        partyId: input.partyId,
        lines: moneyLines,
        countedCash: round2(money(input.countedCash)).toFixed(2),
        requireFullShipment: true,
        shiftType: input.shiftType,
        clientRequestId: input.clientRequestId ?? (input.appendToStatement
          ? `stmt-batch:${input.partyId}:${idempotencyHash({ statementNumber, moneyLines }).slice(0, 32)}`
          : `stmt:${input.partyId}:${statementNumber}`),
        targetShiftId: input.targetShiftId,
        companyStatement: {
          statementNumber,
          isContinuation: input.appendToStatement === true,
          statementDate: input.statementDate ?? null,
          attachmentUrl: input.attachmentUrl ?? null,
          deductionsTotal: input.deductionsTotal ?? null,
          notes: input.notes ?? null,
          statementLines: input.lines.map((line) => ({
            consignmentId: Number(line.consignmentId),
            collectedAmount: round2(money(line.collectedAmount)).toFixed(2),
            shortfallReason: line.shortfallReason?.trim() || null,
            ...(line.shortfallResponsibility ? { shortfallResponsibility: line.shortfallResponsibility } : {}),
            ...(line.expectedDue != null ? { expectedDue: toDbMoney(money(line.expectedDue)) } : {}),
            ...(line.expectedProven != null ? { expectedProven: toDbMoney(money(line.expectedProven)) } : {}),
            ...(line.zeroDeliveryConfirmed != null ? { zeroDeliveryConfirmed: line.zeroDeliveryConfirmed } : {}),
          })),
        },
      };
  const proofKey = input.clientRequestId ?? `stmt-proof:${input.partyId}:${statementNumber}`;
  const proofHash = idempotencyHash({
    partyId: input.partyId, branchId: input.branchId, statementNumber,
    lines: input.lines.map((line) => ({
      consignmentId: Number(line.consignmentId), collectedAmount: toDbMoney(money(line.collectedAmount)),
      shortfallResponsibility: line.shortfallResponsibility ?? null,
      shortfallReason: line.shortfallReason?.trim() || null,
      expectedDue: line.expectedDue == null ? null : toDbMoney(money(line.expectedDue)),
      expectedProven: line.expectedProven == null ? null : toDbMoney(money(line.expectedProven)),
      zeroDeliveryConfirmed: line.zeroDeliveryConfirmed ?? false,
    })).sort((a, b) => a.consignmentId - b.consignmentId),
    statementDate: input.statementDate ?? null, attachmentUrl: input.attachmentUrl ?? null,
    notes: input.notes ?? null, countedCash: toDbMoney(money(input.countedCash)),
    deductionsTotal: toDbMoney(money(input.deductionsTotal ?? "0")),
    shiftType: input.shiftType ?? "RECEPTION", targetShiftId: input.targetShiftId ?? null,
    appendToStatement: input.appendToStatement === true,
  });

  return withTx(async (tx) => {
  let cashSourceLock: DeliveryRemittanceCashSourceLock | undefined;
  if (remittanceInput) {
    // exact replay يسبق تعارض رقم الكشف: النقر المزدوج يعيد السند نفسه بلا أقفالٍ أو آثار.
    const replay = await findDeliveryRemittanceReplayInTx(tx, remittanceInput);
    if (replay) return companyStatementReplayResult(statementNumber, replay);

    // الترتيب العالمي للمسارات المالية: مصدر النقد ← الجهة ← الإرسالية ← الفاتورة.
    cashSourceLock = await lockDeliveryRemittanceCashSourceInTx(tx, remittanceInput, actor);
  }

  // بعد مصدر النقد (إن وُجد) نقفل الجهة، ثمّ تقفل خدماتُ التسليم الوثائقَ بترتيبها التصاعدي.
  const party = (
    await tx
      .select({
        id: deliveryParties.id,
        partyType: deliveryParties.partyType,
        branchId: deliveryParties.branchId,
        isActive: deliveryParties.isActive,
      })
      .from(deliveryParties)
      .where(eq(deliveryParties.id, input.partyId))
      .for("update")
      .limit(1)
  )[0];
  if (!party || !party.isActive) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسجيل كشف شركة التوصيل",
        why: "جهة التوصيل غير موجودة أو معطّلة، ولا يُسجَّل كشف مالي على جهة غير نشطة",
        doThis: "اختر شركة توصيل نشطة من القائمة أو اطلب من المدير إعادة تفعيلها أولاً",
      }),
    });
  }
  if (party.partyType !== "COMPANY") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسجيل كشف شركة التوصيل",
        why: "الجهة المختارة مندوب فردي وليست شركة توصيل؛ كشف الشركة مخصص لبوالص الشركات فقط",
        doThis: "استخدم تسوية المندوب للجهة الفردية، أو اختر شركة التوصيل المطابقة للكشف",
      }),
    });
  }
  if (party.branchId != null && Number(party.branchId) !== input.branchId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر تسجيل كشف شركة التوصيل",
        why: "شركة التوصيل تخصّ فرعاً آخر غير فرع الكشف",
        doThis: "افتح الكشف من فرع الشركة الصحيح أو اختر الشركة المرتبطة بهذا الفرع",
      }),
    });
  }
  // One client request cannot change between proof-only and money-bearing work.
  if (input.clientRequestId) {
    const otherOperation = proofOnly ? "delivery.remit" : "delivery.companyStatementProof";
    if (await checkIdempotency(tx, otherOperation, input.clientRequestId, undefined, { forUpdate: true }) != null) {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
        what: "تعذر تسجيل طلب كشف الشركة",
        why: "معرّف الطلب مستخدم لنوع آخر من كشف الشركة؛ استخدم معرّفاً جديداً",
        doThis: "راجع العملية السابقة، ثم استخدم معرّفاً جديداً إذا كانت هذه عملية أخرى",
      }) });
    }
  }
  const unifiedReplay = input.clientRequestId
    ? await checkIdempotency(tx, "delivery.companyStatement", input.clientRequestId, proofHash,
      { requireStoredHash: true, forUpdate: true })
    : null;
  if (remittanceInput) {
    // إعادةُ الفحص تحت قفلَي المصدر والجهة تغلق سباق طلبَين حملا المفتاح نفسه.
    const replayAfterLock = await findDeliveryRemittanceReplayInTx(
      tx,
      remittanceInput,
      { forUpdate: true },
    );
    if (replayAfterLock) {
      return companyStatementReplayResult(statementNumber, replayAfterLock);
    }
  }
  if (proofOnly && await checkIdempotency(tx, "delivery.companyStatementProof", proofKey, proofHash,
    { requireStoredHash: true, forUpdate: true }) != null) {
    return { remittanceId: null, remittanceNumber: null, statementNumber, deliveriesConfirmed: 0,
      collectedTotal: "0.00", netRemitted: "0.00", proofOnly: true, idempotentReplay: true };
  }
  if (unifiedReplay != null) {
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
      what: "تعذر إعادة طلب كشف الشركة",
      why: "سجل إعادة طلب كشف الشركة غير مكتمل؛ راجع المستند قبل الإعادة",
      doThis: "افتح سجل الكشف واطلب مطابقة المستند مع السند قبل إرسال طلب جديد",
    }) });
  }
  if (proofOnly) await assertStatementNotUsed(input.partyId, statementNumber, tx);
  if (!proofOnly && !input.appendToStatement) await assertStatementNotUsed(input.partyId, statementNumber, tx);

  // ── المرحلة ①: إثبات التسليم لكل سطرٍ غير مختوم — **بنوعَي السطر معاً** ──
  // القراءة قبل الكتابة تحدّد **ما يحتاج إثباتاً فعلاً**؛ الأسطر المختومة سلفاً (بوّابة مندوب
  // أو كشف سابق) لا يُعاد ختمها؛ قد يلزم تحصيل متمم أو إسناد الجزء غير المثبت إلى الجهة.
  const { ids, byId } = await loadStatementConsignments(input, tx);
  // The same physical shipment must be complete even after customer delivery.
  const statementIds = new Set(ids);
  const checkedMembers = new Set<number>();
  for (const id of ids) {
    if (checkedMembers.has(id)) continue;
    const members = operationalShipmentMembers(await loadShipmentMembersTx(tx, id, { currentRead: true }));
    for (const member of members) checkedMembers.add(Number(member.id));
    const missing = [];
    for (const member of members) {
      if (Number(member.partyId) !== input.partyId || Number(member.branchId) !== input.branchId) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({ what: "تعذر تسجيل الشحنة", why: "أحد أعضائها يخص جهة أو فرعاً آخر", doThis: "راجع جهة وفرع كل فاتورة مرتبطة بالشحنة" }) });
      }
      const due = round2(money(member.codAmount).minus(money(member.collectedAmount))
        .minus(money(member.counterSettledAmount ?? "0"))
        .minus(await shortfallAssignedForConsignmentTx(tx, Number(member.id), { partyId: input.partyId, branchId: input.branchId })));
      if (!statementIds.has(Number(member.id)) && (member.parcelStatus !== "DELIVERED" || due.gt(0))) missing.push(member.id);
    }
    if (missing.length) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
        what: "تعذر تسجيل جزء من شحنة في كشف الشركة",
        why: "تضم الشحنة فواتير أخرى غير موجودة في أسطر الكشف",
        doThis: "أضف جميع فواتير الشحنة إلى الكشف أو أكد الشحنة كاملة من تفاصيل التوصيل",
      }) });
    }
  }
  // فحصٌ مسبقٌ لكل شروط الرفض المُنتظَرة قبل أيّ كتابة (Codex P1 #5).
  await preValidateStatementLines(input, ids, byId);
  const lineById = new Map(input.lines.map((line) => [Number(line.consignmentId), line]));
  const plans = new Map<number, { due: Decimal; proven: Decimal; declared: Decimal;
    custodyRemaining: Decimal; unprovenRemaining: Decimal; responsibility: StatementShortfallResponsibility; reason: string | null }>();
  for (const id of ids) {
    const cn = byId.get(id)!;
    const line = lineById.get(id)!;
    const reason = reasonByLine.get(id) ?? null;
    const responsibility = line.shortfallResponsibility ?? "CUSTOMER";
    const due = round2(money(cn.codAmount).minus(money(cn.collectedAmount))
      .minus(money(cn.counterSettledAmount ?? "0"))
      .minus(await shortfallAssignedForConsignmentTx(tx, id, { partyId: input.partyId, branchId: input.branchId })));
    const proven = await unremittedCollectionForConsignmentTx(tx, id, { partyId: input.partyId, branchId: input.branchId });
    if (line.expectedDue != null && (!due.eq(round2(money(line.expectedDue))) ||
      !proven.eq(round2(money(line.expectedProven))))) {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
        what: `تغيرت مطالبة الإرسالية ${id}`, why: "المطالبة أو التحصيل المثبت تغير منذ المعاينة",
        doThis: "حدّث الكشف وراجع المبلغ والفرق قبل التسجيل",
      }) });
    }
    const declared = money(collectedByLine.get(id) ?? "0");
    if (declared.isZero() && (due.gt(0) || cn.parcelStatus !== "DELIVERED") && line.zeroDeliveryConfirmed !== true) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
        what: `تعذر تسجيل سطر الصفر للإرسالية ${id}`,
        why: `يلزم الإقرار الصريح بتسليم الإرسالية ${id} لسطر الصفر`,
        doThis: "تحقق من تسليم الإرسالية ثم أكد الإقرار، أو أزل السطر من الكشف",
      }) });
    }
    if (due.lt(0) || proven.gt(due) || declared.gt(due)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
        what: `تعذر مطابقة الإرسالية ${id}`, why: "المبلغ المعلن أو التحصيل المثبت يتجاوز المطالبة الحالية",
        doThis: "راجع الفاتورة ودفتر الإرسالية قبل تسجيل الكشف",
      }) });
    }
    const partial = declared.lt(due);
    if (partial && (line.shortfallResponsibility == null || line.expectedDue == null || line.expectedProven == null)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
        what: `تعذر تسجيل فرق الإرسالية ${id}`, why: "الفرق يحتاج مسؤولية صريحة ولقطة المطالبة والتحصيل المثبت",
        doThis: "حدّث الكشف وحدد مسؤولية الفرق قبل التسجيل",
      }) });
    }
    const custodyRemaining = round2(Decimal.max(0, proven.minus(declared)));
    const unprovenRemaining = round2(due.minus(Decimal.max(proven, declared)));
    if (unprovenRemaining.isZero() && custodyRemaining.gt(0)) {
      if ((line.shortfallResponsibility && line.shortfallResponsibility !== "COURIER_CUSTODY") || reason) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
          what: `تعذر تسجيل مسؤولية فرق الإرسالية ${id}`,
          why: "الفرق كله نقد مثبت في عهدة جهة التوصيل؛ المسؤولية أو السبب المرسل غير مطابق",
          doThis: "اختر العهدة المثبتة وأزل سبب العجز بعد مطابقة النقد غير المورد",
        }) });
      }
    }
    if (responsibility === "COURIER_CUSTODY" && (unprovenRemaining.gt(0) || custodyRemaining.lte(0))) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
        what: `تعذر إثبات عهدة الإرسالية ${id}`, why: "جزء من الفرق لم يثبت قبضه لدى جهة التوصيل",
        doThis: "حدد مسؤولية العميل أو الجهة للجزء غير المثبت، ولا تعتبره نقداً مقبوضاً",
      }) });
    }
    if (responsibility === "DELIVERY_PARTY" && unprovenRemaining.isZero()) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
        what: `تعذر تسجيل عجز للإرسالية ${id}`,
        why: "لا يوجد فرق غير مثبت يمكن تسجيل سببه عجزاً على الجهة",
        doThis: "راجع التحصيل المثبت وأزل سبب العجز أو اختر العهدة إن بقي نقد غير مورد",
      }) });
    }
    if (cn.parcelStatus !== "DELIVERED" && proven.gt(0) && (declared.gt(0) || responsibility === "DELIVERY_PARTY")) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
        what: `تعذر تسجيل كشف الإرسالية ${id}`,
        why: "للإرسالية غير المسلمة تحصيل سابق مثبت يحتاج مطابقة قبل الكشف",
        doThis: "طابق مستند التسليم والتحصيل السابق مع دفتر الإرسالية قبل تسجيل كشف جديد",
      }) });
    }
    const addsCustody = (cn.parcelStatus !== "DELIVERED" ? declared.gt(0) : declared.gt(proven)) ||
      (responsibility === "DELIVERY_PARTY" && unprovenRemaining.gt(0));
    if (addsCustody) {
      const opening = (await tx.select({ createdAt: deliveryLedgerEntries.createdAt }).from(deliveryLedgerEntries)
        .where(and(eq(deliveryLedgerEntries.partyId, input.partyId),
          eq(deliveryLedgerEntries.eventKey, `BACKFILL:PARTY:${input.partyId}:CASH_CUSTODY`),
          effectiveDeliveryLedgerEntrySql())).for("share").limit(1))[0];
      if (opening && cn.createdAt.getTime() <= opening.createdAt.getTime()) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
          what: `تعذر تسجيل تحصيل الإرسالية ${id} تلقائياً`, why: "توجد عهدة افتتاحية تاريخية قد تشمل هذا المبلغ",
          doThis: "طابق العهدة مع مستندات الإرسالية قبل تسجيل تحصيل أو عجز جديد",
        }) });
      }
    }
    if (cn.parcelStatus !== "DELIVERED" || partial || declared.gt(proven)) {
      const invoice = cn.invoiceId == null ? undefined : (await tx.select().from(invoices)
        .where(eq(invoices.id, Number(cn.invoiceId))).for("update").limit(1))[0];
      const charges = await loadAssignedChargeClaimsTx(tx, id);
      const invoiceDue = round2(assignedGoodsCodDue(invoice, await creditCollectionChoiceTx(tx, id)).plus(charges.remaining));
      if (!invoiceDue.eq(due.minus(proven))) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
          what: `تعذر تسجيل الإرسالية ${id}`, why: `متبقي الفاتورة والأجور ${invoiceDue.toFixed(2)} لا يطابق الجزء غير المثبت ${due.minus(proven).toFixed(2)}`,
          doThis: "طابق الفاتورة والتحصيل المثبت قبل تسجيل الفرق",
        }) });
      }
    }
    plans.set(id, { due, proven, declared, custodyRemaining, unprovenRemaining, responsibility, reason });
  }
  const statementBatch = proofOnly ? null : await prepareStatementBatchTx(tx, input, statementNumber, actor);
  if (remittanceInput?.companyStatement && statementBatch) remittanceInput.companyStatement.storeOriginalNumber = statementBatch.storeOriginalNumber;
  const needConfirm = ids
    .filter((id) => byId.get(id)!.parcelStatus !== "DELIVERED")
    .sort((a, b) => a - b);
  const alreadyDeliveredIds = ids
    .filter((id) => byId.get(id)!.parcelStatus === "DELIVERED")
    .sort((a, b) => a - b);
  for (const id of needConfirm) {
    // مفتاحٌ مشتقٌّ من (الكشف × الإرسالية): إعادة إدخال الكشف تُعيد النتيجة نفسها بلا قيدٍ ثانٍ.
    // يثبت مبلغ هذا السطر فقط، مع سبب الجهة إذا اختيرت لمسؤولية الجزء غير المقبوض.
    await confirmConsignmentDelivery(
      {
        consignmentId: id,
        clientRequestId: `stmt:${input.partyId}:${statementNumber}:${id}`,
        statementWitness: {
          partyId: Number(input.partyId),
          statementNumber,
          collectedAmount: collectedByLine.get(id),
          shortfallReason: plans.get(id)!.responsibility === "DELIVERY_PARTY" ? plans.get(id)!.reason ?? undefined : undefined,
        },
      },
      { userId: actor.userId },
      tx,
      { shipmentMember: true },
    );
  }
  /**
   * **تحصيلٌ متمِّم على الطرود المختومة سلفاً** (Codex P1 #3 — ٢٢/٨): كشفٌ لاحقٌ يقول
   * «حُصِّل الباقي 8k» على طردٍ سبق ختمُه بكشفٍ سابق بـ12k. `confirmConsignmentDelivery`
   * ترتدّ `alreadyDelivered` بلا مساس ⇒ الفاتورة تبقى مدفوعةً جزئياً والعهدةُ لا ترتفع.
   * مبلغ السطر يورد أولا ما ثبت قبضه ولم يورد بعد؛ الزيادة وحدها تحصيل جديد
   * تسجله `recordSupplementaryStatementCollection` على الفاتورة والعهدة.
   */
  for (const id of alreadyDeliveredIds) {
    const plan = plans.get(id)!;
    const additional = round2(Decimal.max(0, plan.declared.minus(plan.proven)));
    const transfer = plan.responsibility === "DELIVERY_PARTY" ? plan.unprovenRemaining : money(0);
    if (additional.isZero() && transfer.isZero()) continue;
    const cn = byId.get(id)!;
    if (additional.gt(0)) await recordSupplementaryStatementCollection(
      {
        consignmentId: id,
        additionalCollectedAmount: additional.toFixed(2),
        statementNumber,
        clientRequestId: `stmt-supp:${input.partyId}:${statementNumber}:${id}`,
      },
      { userId: actor.userId },
      tx,
    );
    if (transfer.gt(0)) {
      await assignDeliveredStatementShortfallTx(tx, {
        id, partyId: Number(cn.partyId), branchId: Number(cn.branchId),
        invoiceId: cn.invoiceId == null ? null : Number(cn.invoiceId),
        fulfillmentRequestId: cn.fulfillmentRequestId == null ? null : Number(cn.fulfillmentRequestId),
      }, transfer, plan.reason!, `${input.partyId}:${statementNumber}:${input.clientRequestId ?? ""}`, actor);
      if (plan.declared.isZero() && plan.custodyRemaining.isZero()) {
        if (cn.status !== "DISPATCHED" && cn.status !== "PARTIAL") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
            what: `تعذر إغلاق عجز الإرسالية ${id}`,
            why: "حالة الإرسالية لا تسمح بإغلاق العجز",
            doThis: "راجع حالة الإرسالية وتسوياتها السابقة قبل تسجيل إغلاق جديد",
          }) });
        }
        await tx.update(deliveryConsignments).set({ status: "DELIVERED", moneyStatus: "SETTLED", settledAt: new Date() })
          .where(eq(deliveryConsignments.id, id));
        await appendDeliveryEvent(tx, {
          eventKey: `CN:${id}:MONEY:STMT_SHORT:${idempotencyHash({ partyId: input.partyId, statementNumber, requestId: input.clientRequestId ?? null }).slice(0, 24)}`,
          consignmentId: id, eventType: "MONEY_SETTLED", fromMoneyStatus: cn.moneyStatus,
          toMoneyStatus: "SETTLED", actorUserId: actor.userId,
          payload: { source: "COMPANY_STATEMENT", statementNumber, shortfallAssigned: toDbMoney(transfer) },
        });
      }
    }
  }

  const recordDifferences = async (remittanceId: number | null) => {
    for (const id of ids) {
      const plan = plans.get(id)!;
      if (!plan.declared.lt(plan.due) && !proofOnly) continue;
      const eventSuffix = idempotencyHash({ partyId: input.partyId, statementNumber,
        requestId: input.clientRequestId ?? null, id }).slice(0, 32);
      await appendDeliveryEvent(tx, {
        eventKey: `CN:${id}:STATEMENT_DIFFERENCE:${eventSuffix}`, consignmentId: id,
        eventType: "STATEMENT_DIFFERENCE", actorUserId: actor.userId,
        payload: { source: "COMPANY_STATEMENT", statementNumber, remittanceId,
          statementDate: input.statementDate ?? null, attachmentUrl: input.attachmentUrl ?? null,
          notes: input.notes ?? null, cashSourceUsed: !proofOnly,
          requestedShiftType: input.shiftType ?? "RECEPTION", requestedTargetShiftId: input.targetShiftId ?? null,
          dueBefore: toDbMoney(plan.due),
          provenBefore: toDbMoney(plan.proven), remitted: toDbMoney(plan.declared),
          custodyRemaining: toDbMoney(plan.custodyRemaining),
          customerRemaining: toDbMoney(plan.responsibility === "CUSTOMER" ? plan.unprovenRemaining : 0),
          partyShortfall: toDbMoney(plan.responsibility === "DELIVERY_PARTY" ? plan.unprovenRemaining : 0),
          shortfallResponsibility: plan.responsibility, shortfallReason: plan.reason },
      });
    }
  };

  if (proofOnly) {
    // لا مرحلةَ ②: لا سند توريد ولا إيصال درج — الكشفُ أدّى وظيفتَه المستندية كاملةً.
    // ملاحظة مقصودة: رقمُ الكشف لم يُحجَز (القيد الفريد على سندات التوريد) — إدخالُه لاحقاً
    // كاملاً بنفس الرقم لتوريد نقده مشروع، والمرحلة ① سترتدّ فيه بلا أثر.
    await recordDifferences(null);
    await recordIdempotencyKey(tx, "delivery.companyStatementProof", proofKey, ids[0], proofHash);
    await recordStatementRequestTx(tx, input.clientRequestId, ids[0], proofHash);
    return {
      remittanceId: null,
      remittanceNumber: null,
      statementNumber,
      deliveriesConfirmed: needConfirm.length,
      collectedTotal: "0.00",
      netRemitted: "0.00",
      proofOnly: true,
    };
  }

  // ── المرحلة ②: التوريد بالآلة القائمة كاملةً بحرّاسها — **بأسطر المال وحدها** ──
  // سطرُ الإثبات لا يُمرَّر: طردُه الصفريّ أُغلق `status=DELIVERED` في المرحلة ① فيرفضه حارس
  // «غير قابلة للتسوية»، وغيرُ المحصَّل ليس توريداً أصلاً (متبقّيه ذمّةُ عميلٍ تُقبض كاونترياً).
  if (!remittanceInput || !cashSourceLock) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "تعذّر تهيئة قفل درج كشف شركة التوصيل",
    });
  }

  let res: Awaited<ReturnType<typeof recordDeliveryRemittanceInTx>>;
  try {
    res = await recordDeliveryRemittanceInTx(tx, remittanceInput, actor, cashSourceLock,
      { allowPartialCompanyStatement: true });
  } catch (e) {
    // سباقٌ على نفس الكشف من جلستين: القيد الفريد يفصل — نُترجمه لرسالةٍ مفهومة.
    if (isDupEntry(e)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `كشف الشركة «${statementNumber}» سُجِّل للتوّ من جلسةٍ أخرى — راجعه قبل إعادة الإدخال`,
      });
    }
    throw e;
  }
  if (statementBatch) await tx.insert(deliveryCompanyStatementBatches).values({
    statementId: statementBatch.statementId, remittanceId: res.remittanceId,
  });
  await recordDifferences(res.remittanceId);
  await recordStatementRequestTx(tx, input.clientRequestId, res.remittanceId, proofHash);

  return {
    remittanceId: res.remittanceId,
    remittanceNumber: res.remittanceNumber,
    statementNumber,
    deliveriesConfirmed: needConfirm.length,
    collectedTotal: res.collectedTotal,
    netRemitted: res.netRemitted,
    idempotentReplay: (res as { idempotentReplay?: boolean }).idempotentReplay,
  };
  });
}

export interface DeliveryProofInput {
  branchId: number;
  partyId: number;
  statementNumber: string;
  statementDate?: string | null;
  attachmentUrl?: string | null;
  notes?: string | null;
  lines: CompanyStatementLineInput[];
  clientRequestId: string;
}

export interface DeliveryProofResult {
  /** أسطرٌ أثبتنا تسليمها الآن (لم تكن مختومة). */
  deliveriesConfirmed: number;
  /** أسطرٌ كانت مختومةً سلفاً (بوّابة مندوب أو كشفٌ/إثباتٌ سابق) — مرّت بلا مساس. */
  alreadyDelivered: number;
  statementNumber: string;
}

/**
 * **إثباتُ تسليمٍ مستنديّ مستقلّ — بلا نقدٍ الآن** (٢١/٨): المرحلة ① وحدها لكل سطر.
 *
 * لماذا وُجد: الفعلُ الواقعيّ ينفصل زمنياً — الشركة تُبلغ «سُلِّم» اليومَ وتورّد نقدَها بعد
 * أيام، والانتظارُ كان يترك الطرود جامدةً «مُسنَد — لم يخرج» أسابيع (٧٩/٨٤ طرداً في الفحص
 * الجنائيّ). المالُ المُعلَن هنا يرفع **عهدة الجهة** كما هو مصمَّم (النقد بيدها لا بالدرج)،
 * ويُورَّد لاحقاً بالتوريد العاديّ أو بإدخال الكشف كاملاً.
 *
 * ⚠️ **عمداً لا فحصَ تفرّدٍ لرقم الكشف هنا**: التفرّد قيدُ **سندات التوريد** — والكشفُ نفسه
 * قد يُدخَل لاحقاً كاملاً بنفس الرقم لتوريد نقده، فحجزُ الرقم الآن كان سيسدّ ذلك الباب.
 * والحمايةُ من التكرار قائمة بطبقتَيها: مفتاح idempotency المشتقّ (الكشف × الإرسالية) —
 * نفسُ مفتاح المرحلة ① في `recordCompanyStatement` فيصير الإثباتُ ثمّ الكشفُ الكامل
 * **عمليةً واحدةً متّصلة** — وختمُ `parcelStatus` نفسُه (المختوم يمرّ بلا مساس).
 *
 * `statementDate`/`attachmentUrl`/`notes` تُقبل للتوثيق في سجلّ تدقيق الراوتر؛ لا صفَّ
 * مستندياً هنا يُخزّنها (تُخزَّن على سند التوريد حين يُدخَل الكشف بنقده).
 */
export async function recordDeliveryProof(
  input: DeliveryProofInput,
  actor: DeliveryTxActor,
): Promise<DeliveryProofResult> {
  const statementNumber = input.statementNumber.trim();
  if (statementNumber.length < 2) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "رقم كشف الشركة مطلوب" });
  }
  if (!input.lines.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الكشف بلا أسطر" });
  }
  const { collectedByLine, reasonByLine } = splitStatementLines(input.lines);
  const { ids, byId } = await loadStatementConsignments(input);
  await preValidateStatementLines(input, ids, byId);

  const needConfirm = ids.filter((id) => byId.get(id)!.parcelStatus !== "DELIVERED");
  let deliveriesConfirmed = 0;
  // المختوم سلفاً + ما سبقنا غيرُنا إلى ختمه بين القراءة والتأكيد (سباقٌ يمتصّه idempotency).
  let alreadyDelivered = ids.length - needConfirm.length;
  for (const id of needConfirm) {
    const res = await confirmConsignmentDelivery(
      {
        consignmentId: id,
        clientRequestId: `stmt:${input.partyId}:${statementNumber}:${id}`,
        statementWitness: {
          partyId: Number(input.partyId),
          statementNumber,
          collectedAmount: collectedByLine.get(id),
          shortfallReason: reasonByLine.get(id),
        },
      },
      { userId: actor.userId },
    );
    if (res.alreadyDelivered) alreadyDelivered += 1;
    else deliveriesConfirmed += 1;
  }
  return { deliveriesConfirmed, alreadyDelivered, statementNumber };
}

export interface ManualDeliveryProofInput {
  consignmentId: number;
  /** ما ثبت تحصيله فعلاً عند التسليم (قد يكون صفراً — طردٌ وصل بلا قبض). */
  collectedAmount: string;
  /** الدليل المكتوب (رسالة الزبون/شاهد/مرجع صورة) — نصّ المالك: «يحتاج دليلاً». */
  evidence: string;
  clientRequestId: string;
  /**
   * Slice DFP1 (٣٠/٨/٢٦): سببُ العجز إن كان `collectedAmount < invoiceRemaining`.
   * قيمةٌ من enum `shared/shortfallReason.ts`. لزوماً حين يقع عجز؛ يُرفض بدونه من الخدمة.
   * يمرّ بلا تحقّق حين لا يوجد عجز (المسار العاديّ للتحصيل الكامل بلا حاجة لسبب).
   */
  shortfallReason?: string;
}

/**
 * **الإثبات اليدويّ الاستثنائيّ** (٢١/٨) — نصّ المالك: «يحتاج دليلاً وموافقة مدير».
 *
 * لطردٍ ثبت تسليمُه بغير الكشف وبغير البوّابة (اتصال زبون، صورة، شاهد): يمرّ على **نفس
 * المسار الماليّ** حرفياً (`confirmConsignmentDelivery`) بشاهدٍ نوعُه `MANUAL_PROOF` —
 * فالفارق كلُّه في مصدر السلطة المدوَّن في حدث التسليم، لا في دينارٍ واحد.
 * بوّابةُ موافقة المدير تُفرَض في الراوتر (شأنُ طبقة التفويض لا الخدمة).
 */
/**
 * **تأكيد التسليم بيد الكاشير — «تم التسليم»** (٢٣/٨): البديل الأدنى سلطةً لـ`recordManualDeliveryProof`.
 *
 * السيناريو اليوميّ الشائع: يتّصل المندوب/الشركة ويقول «سلّمتُ CN-…، قبضتُ X» — الكاشير
 * يحتاج زرّاً واحداً يُثبِتُها بلا انتظار وصول الكشف الورقيّ ولا انتظار المدير. نفس المسار
 * الماليّ (`confirmConsignmentDelivery`) بمصدر سلطة `STAFF_CONFIRMED` مدوَّن — والفارقُ عن
 * الإثبات المديريّ في مستوى التوثيق: هنا ملاحظةٌ قصيرة (اسم متّصل/رقم رسالة/إشارة موجزة)،
 * هناك دليلٌ مكتوبٌ أطول (رابط صورة/شاهد).
 *
 * ⚠️ الحد الأدنى ٣ حروف (ملاحظة موجزة تسمّي المصدر) — أقصر من `MANUAL_PROOF` (٤ حروف بدليل).
 * الاسم يظهر في `deliveryEvents.actorUserId` وسجلّ التدقيق، فلا مجهوليّة رغم البساطة.
 */
export async function recordStaffDeliveryConfirmation(
  input: ManualDeliveryProofInput,
  actor: DeliveryTxActor,
  options: { requireFullCollection?: boolean } = {},
): Promise<ConfirmConsignmentResult> {
  const evidence = input.evidence.trim();
  if (evidence.length < 3) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "أدخل ملاحظةً موجزة عن مصدر التأكيد (اتصال المندوب/رسالة واتساب/اسم مستلم)",
    });
  }
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const cn = (
    await db
      .select({ id: deliveryConsignments.id, partyId: deliveryConsignments.partyId, branchId: deliveryConsignments.branchId })
      .from(deliveryConsignments)
      .where(eq(deliveryConsignments.id, Number(input.consignmentId)))
      .limit(1)
  )[0];
  if (!cn) throw new TRPCError({ code: "NOT_FOUND", message: "الإرسالية غير موجودة" });
  // عزل الفرع (نفس نمط `recordManualDeliveryProof`).
  const actorBranchId = actor.branchId != null ? Number(actor.branchId) : null;
  const isAdmin = actor.role === "admin";
  if (!isAdmin && actorBranchId != null && Number(cn.branchId) !== actorBranchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الإرسالية تخصّ فرعاً آخر" });
  }
  const statementNumber = `STAFF:${evidence}`.slice(0, STATEMENT_NUMBER_MAX);
  return confirmConsignmentDelivery(
    {
      consignmentId: Number(cn.id),
      clientRequestId: input.clientRequestId,
      statementWitness: {
        partyId: Number(cn.partyId),
        statementNumber,
        collectedAmount: round2(money(input.collectedAmount)).toFixed(2),
        kind: "STAFF_CONFIRMED",
        shortfallReason: input.shortfallReason,
      },
    },
    { userId: actor.userId },
    undefined,
    { requireFullCollection: options.requireFullCollection },
  );
}

export async function recordManualDeliveryProof(
  input: ManualDeliveryProofInput,
  actor: DeliveryTxActor,
): Promise<ConfirmConsignmentResult> {
  const evidence = input.evidence.trim();
  if (evidence.length < 2) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "الإثبات اليدوي يحتاج دليلاً مكتوباً — اذكر مصدر التأكيد (اتصال الزبون/صورة/شاهد)",
    });
  }
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  // جهةُ الشاهد هي جهةُ الإرسالية نفسها — تُقرأ لا تُستلَم من المستدعي (لا انتحال جهة).
  const cn = (
    await db
      .select({ id: deliveryConsignments.id, partyId: deliveryConsignments.partyId, branchId: deliveryConsignments.branchId })
      .from(deliveryConsignments)
      .where(eq(deliveryConsignments.id, Number(input.consignmentId)))
      .limit(1)
  )[0];
  if (!cn) throw new TRPCError({ code: "NOT_FOUND", message: "الإرسالية غير موجودة" });
  /**
   * **عزل الفرع** (Codex P1 #1 — ٢٢/٨): `storeManagerProcedure` يفرض وجود فرعٍ للمستخدم
   * لكن **لا يقارنه** بفرع الإرسالية — مديرُ فرعٍ يستطيع تمريرَ رقمِ إرساليةٍ لفرعٍ آخر
   * فيمرّ الطلبُ على `confirmConsignmentDelivery` ويُعدّل فاتورةً وذمّةَ عميلٍ وعهدةَ جهةٍ
   * ليست فرعَه. الأدمن وحدَه يعبر (`role='admin'` — نمط `deliveryRouter.effectiveBranch`).
   */
  const actorBranchId = actor.branchId != null ? Number(actor.branchId) : null;
  const isAdmin = actor.role === "admin";
  if (!isAdmin && actorBranchId != null && Number(cn.branchId) !== actorBranchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الإرسالية تخصّ فرعاً آخر" });
  }
  // الدليل يُدوَّن مكانَ رقم الكشف بصيغةٍ مميّزة، مقتطعاً لسقف عمود رقم الكشف — يبقى صالحاً
  // للتخزين لو ربطته شاشةٌ لاحقة بسند توريد.
  const statementNumber = `MANUAL:${evidence}`.slice(0, STATEMENT_NUMBER_MAX);
  return confirmConsignmentDelivery(
    {
      consignmentId: Number(cn.id),
      clientRequestId: input.clientRequestId,
      statementWitness: {
        partyId: Number(cn.partyId),
        statementNumber,
        collectedAmount: round2(money(input.collectedAmount)).toFixed(2),
        kind: "MANUAL_PROOF",
        shortfallReason: input.shortfallReason,
      },
    },
    { userId: actor.userId },
  );
}
