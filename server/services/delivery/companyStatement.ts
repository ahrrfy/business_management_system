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
 * ═══ الذرّية: لماذا مرحلتان لا معاملةٌ واحدة ═══
 * `withTx` = `db.transaction(fn)` **غير قابلة لإعادة الدخول**، و`confirmConsignmentDelivery`
 * تفتح معاملتها بنفسها. فبدل تفكيكها (٣٠٠ سطرٍ من منطقٍ ماليّ مُختبَر) نُنسّق مرحلتين:
 *   ① إثبات تسليم كل سطرٍ غير مختوم — كلٌّ في معاملته، **idempotent بمفتاحٍ مشتقٍّ من رقم
 *      الكشف والإرسالية** ⇒ إعادة المحاولة تُعيد النتيجة بلا تكرار قيد.
 *   ② التوريد كاملاً في معاملةٍ واحدة (الآلة القائمة بحرّاسها كلّها).
 * الانقطاع بين المرحلتين يترك حالةً **مشروعةً وواقعية**: طرودٌ سُلّمت ونقدُها لم يُستلَم بعد
 * — وهي بالضبط ما يقع في العالم الحقيقيّ بين تسليم الشركة وتوريدها. وإعادةُ إدخال الكشف
 * تُكمل من حيث توقّفت: المرحلة ① تُعاد بلا أثر، والمرحلة ② تقع.
 * ⚠️ الترتيب مقصود: لو ورّدنا أوّلاً لكان النقد في الدرج قبل إثبات ما يقابله.
 *
 * ═══ أسطر الصفر = إثبات تسليمٍ بلا نقد (٢١/٨) ═══
 * الكشف الواقعيّ يحمل نوعَي سطر: **سطرُ مالٍ** (`collectedAmount > 0`) يمرّ بالمرحلتين، و**سطرُ
 * إثباتٍ** (`= 0`) يمرّ بالمرحلة ① وحدها — طردٌ سلّمته الشركةُ بلا تحصيل (COD=0 مدفوعٌ سلفاً،
 * أو زبونٌ لم يدفع). تمريرُه للمرحلة ② كان يُفجّرها: الطرد الصفريّ يُغلَق `status=DELIVERED`
 * عند الختم فيرفضه حارسُ «غير قابلة للتسوية» ويُسقط الكشفَ المختلط كلَّه.
 * ⚠️ مقصودٌ بقرار المالك: سطرُ إثباتٍ لطردٍ COD>0 (الشركةُ سلّمته والزبون لم يدفع شيئاً)
 * يختم `parcelStatus=DELIVERED` **ويُبقي المتبقّي ذمّةَ عميلٍ حيّة** تُقبض كاونترياً لاحقاً
 * (تُدوَّن عندها في `counterSettledAmount`) — «المتبقّي يبقى على العميل» لا يُمحى ولا يُنسى.
 *
 * ═══ عدم التكرار ═══
 * طبقتان: `clientRequestId` (تقنيّة، تمتصّ النقر المزدوج) + **رقم الكشف الفريد لكل جهة**
 * (قيدٌ في القاعدة — هجرة 0230) الذي يمنع إدخال الكشف نفسه مرّتين ولو من جهازٍ وجلسةٍ أخرى.
 * ⚠️ القيدُ على **سندات التوريد**: كشفُ إثباتٍ محض (`proofOnly`) لا يُنشئ سنداً فلا يحجز
 * رقمَه — مقصود، فقد يُعاد إدخال الكشف نفسه لاحقاً كاملاً لتوريد نقده.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { deliveryConsignments, deliveryRemittances } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { isDupEntry } from "@shared/errorMap.ar";
import { money, round2 } from "../money";
import { confirmConsignmentDelivery, recordSupplementaryStatementCollection, type ConfirmConsignmentResult } from "./courier";
import { recordDeliveryRemittance, type RemittanceInput } from "./remittance";
import type { DeliveryTxActor } from "./types";

export interface CompanyStatementLineInput {
  consignmentId: number;
  /** المُحصَّل فعلاً على هذا الطرد حسب الكشف (قد يقلّ عن COD — فرقٌ يبقى على العميل). */
  collectedAmount: string;
  /**
   * م١ (PR-4) — **اختياريّ على مستوى السطر**: سببُ العجز من `shared/shortfallReason.ts` حين تقرّ
   * الشركةُ بأنّ الفرق عليها (قبضته ولم تُعلنه، ضاع بيد مندوبها…). بوجوده يُقيَّد
   * `SHORTFALL_ASSIGNED` ذمّةً فوريّة على الجهة كمسارَي الكاشير؛ وبغيابه يبقى قرارُ المالك (٢١/٨):
   * المتبقّي ذمّةُ عميلٍ حيّة تُقبض كاونترياً. لا يُطبَّق على الأسطر المختومة سلفاً (التحصيل المتمِّم).
   */
  shortfallReason?: string | null;
}

export interface CompanyStatementInput {
  branchId: number;
  partyId: number;
  statementNumber: string;
  statementDate?: string | null;
  attachmentUrl?: string | null;
  /** استقطاعات الشركة (أجور توصيل حسمتها من الحصيلة) — إفصاحٌ على المستند. */
  deductionsTotal?: string | null;
  notes?: string | null;
  lines: CompanyStatementLineInput[];
  /** النقد المعدود فعلاً — تفرض آلةُ التوريد مطابقتَه لصافي الكشف بالضبط. */
  countedCash: string;
  shiftType?: "RECEPTION" | "RETAIL";
  clientRequestId?: string | null;
}

export interface CompanyStatementResult {
  /** `null` = كشفُ إثباتٍ محض (كل أسطره صفرية) — لا سند توريد أُنشئ ولا نقد دخل. */
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

/** طول عمود `deliveryRemittances.companyStatementNumber` (varchar 64) — سقفُ أيّ رقم كشفٍ مشتقّ. */
const STATEMENT_NUMBER_MAX = 64;

/** يرتدّ بخطأٍ مفهوم بدل خطأ قاعدةٍ خامّ حين يُعاد إدخال كشفٍ مسجَّل. */
async function assertStatementNotUsed(partyId: number, statementNumber: string) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const existing = (
    await db
      .select({ id: deliveryRemittances.id, number: deliveryRemittances.remittanceNumber })
      .from(deliveryRemittances)
      .where(and(
        eq(deliveryRemittances.partyId, partyId),
        eq(deliveryRemittances.companyStatementNumber, statementNumber),
      ))
      .limit(1)
  )[0];
  if (existing) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `كشف الشركة «${statementNumber}» مُسجَّلٌ سلفاً على سند التوريد ${existing.number} — لا يُدخَل مرّتين`,
    });
  }
}

/**
 * قراءةُ أسطر الكشف والتحقّق من ملكيّتها **قبل أيّ كتابة**: كل إرساليةٍ موجودةٌ وتخصّ الجهةَ
 * والفرعَ المذكورَين. مشتركة بين الكشف الكامل وإثبات التسليم المستنديّ كي لا ينجرف تحقّقان.
 */
async function loadStatementConsignments(input: {
  branchId: number;
  partyId: number;
  lines: CompanyStatementLineInput[];
}) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const ids = input.lines.map((l) => Number(l.consignmentId));
  const rows = await db
    .select({
      id: deliveryConsignments.id,
      partyId: deliveryConsignments.partyId,
      branchId: deliveryConsignments.branchId,
      parcelStatus: deliveryConsignments.parcelStatus,
      status: deliveryConsignments.status,
      codAmount: deliveryConsignments.codAmount,
      collectedAmount: deliveryConsignments.collectedAmount,
      invoiceId: deliveryConsignments.invoiceId,
      returnDeclaredAt: deliveryConsignments.returnDeclaredAt,
    })
    .from(deliveryConsignments)
    .where(inArray(deliveryConsignments.id, ids));
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
 * **تحقّقٌ مسبقٌ ذرّيّ لأسطر الكشف** (Codex P1 #5 — ٢٢/٨): `confirmConsignmentDelivery` تفتح
 * معاملتها بنفسها، فحلقةُ الأسطر ليست عمليةً ذرّيّةً واحدة — سطرٌ يفشل بعد سطرٍ نجح يترك حالةً
 * مقسّمة. `withTx` غير قابلة لإعادة الدخول (رأس الملف)، لذلك نحقّق كل شروط الفشل الشائعة
 * **قبل** الحلقة بلا كتابة: تجاوز COD، تجاوز متبقّي الفاتورة، رجوعٌ مُعلَن. لا يقضي على
 * السباقات (فاتورةٌ تُدفع بين التحقّق والكتابة) لكنه يمسك الأخطاء التصريحيّة قبل أن تُنتج
 * حالةً جزئية. الأسطر المرتدّة `alreadyDelivered` مسموحةٌ (تُصبح تحصيلاً متمِّماً).
 */
async function preValidateStatementLines(
  input: { partyId: number; lines: CompanyStatementLineInput[] },
  ids: number[],
  byId: Map<number, {
    codAmount: string; collectedAmount: string; invoiceId: number | null;
    parcelStatus: string; returnDeclaredAt: unknown;
  }>,
) {
  const db = getDb();
  if (!db) return;
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
    const codAmount = round2(money(cn.codAmount));
    const currentCollected = round2(money(cn.collectedAmount ?? "0"));
    if (declared.gt(codAmount)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `الإرسالية ${l.consignmentId}: المُعلَن ${declared.toFixed(2)} أكثر من مبلغ COD (${codAmount.toFixed(2)})`,
      });
    }
    // للأسطر المختومة سلفاً: الدلتا سيقيسها `recordSupplementaryStatementCollection` — نتحقّق
    // فقط من رفض الانحسار (declared < ما سبق تحصيله في كشفٍ آخر).
    if (cn.parcelStatus === "DELIVERED" && declared.lt(currentCollected)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `الإرسالية ${l.consignmentId}: المُعلَن ${declared.toFixed(2)} أقلّ ممّا سبق تحصيله (${currentCollected.toFixed(2)}) — إلغاءُ تحصيلٍ سابقٍ ممنوع`,
      });
    }
  }
  // ⚠️ متبقّي الفاتورة يُفحَص داخل `confirmConsignmentDelivery` و`recordSupplementaryStatementCollection`
  // تحت قفل .for("update") — وهو المرجعُ الحاسمُ. فحصُه هنا استرشادياً بلا قفل يُنتج **إنذاراتٍ
  // كاذبة** حين تسدَّد الفاتورة بمسارٍ مشروعٍ سابقاً (عربونٌ عند الاستقبال أو دفعةٌ متجرية) فيبقى
  // `paidAmount>0` عند القراءة قبل الإثبات ⇒ نرفضُ تحصيلاً سيمرّ فعلاً داخل المعاملة (invoiceRemaining
  // يُحسَب من `collectedAmount + counterSettled + الأصل` لا paidAmount وحده). نتركُ الفحصَ لموقعه
  // الأصليّ ونكتفي هنا بالسطور المحلّية (رجوعٌ مُعلَن، تجاوز COD، انحسار).
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
    // التكرار يُرفض هنا لا في آلة التوريد وحدها: سطرا (صفر + مال) لنفس الطرد كانا سيندمجان
    // صامتَين قبل أن تراهما — والمرحلة ① تسبقها فلا يحميها حارسُها.
    if (collectedByLine.has(Number(l.consignmentId))) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `الإرسالية ${l.consignmentId} مكرّرة في أسطر الكشف — سطرٌ واحد لكل طرد`,
      });
    }
    collectedByLine.set(Number(l.consignmentId), amt.toFixed(2));
    if (l.shortfallReason) reasonByLine.set(Number(l.consignmentId), l.shortfallReason);
    if (amt.gt(0)) {
      moneyLines.push({ consignmentId: Number(l.consignmentId), collectedAmount: amt.toFixed(2) });
    }
  }
  return { collectedByLine, reasonByLine, moneyLines };
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
  await assertStatementNotUsed(input.partyId, statementNumber);

  const { collectedByLine, reasonByLine, moneyLines } = splitStatementLines(input.lines);
  const proofOnly = moneyLines.length === 0;
  if (proofOnly) {
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

  // ── المرحلة ①: إثبات التسليم لكل سطرٍ غير مختوم — **بنوعَي السطر معاً** ──
  // القراءة قبل الكتابة تحدّد **ما يحتاج إثباتاً فعلاً**؛ الأسطر المختومة سلفاً (بوّابة مندوب
  // أو كشفٌ سابق) تمرّ بلا مساس، فالكشف الجزئيّ المتمِّم لا يعيد ختم ما خُتم.
  // سطرُ الإثبات (declared=0) يقبله الخادم أصلاً: يختم الطردَ الصفريّ ويُغلقه، ويُبقي متبقّي
  // طرد COD>0 ذمّةً حيّة على العميل (رأس الملف — قرار المالك).
  const { ids, byId } = await loadStatementConsignments(input);
  // فحصٌ مسبقٌ لكل شروط الرفض المُنتظَرة قبل أيّ كتابة (Codex P1 #5).
  await preValidateStatementLines(input, ids, byId);
  const needConfirm = ids.filter((id) => byId.get(id)!.parcelStatus !== "DELIVERED");
  const alreadyDeliveredIds = ids.filter((id) => byId.get(id)!.parcelStatus === "DELIVERED");
  for (const id of needConfirm) {
    // مفتاحٌ مشتقٌّ من (الكشف × الإرسالية): إعادة إدخال الكشف تُعيد النتيجة نفسها بلا قيدٍ ثانٍ.
    // ويُمرَّر **المُعلَن على الكشف** لا COD كاملاً: تحصيلٌ جزئيّ يُسجَّل كما وقع.
    await confirmConsignmentDelivery(
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
  }
  /**
   * **تحصيلٌ متمِّم على الطرود المختومة سلفاً** (Codex P1 #3 — ٢٢/٨): كشفٌ لاحقٌ يقول
   * «حُصِّل الباقي 8k» على طردٍ سبق ختمُه بكشفٍ سابق بـ12k. `confirmConsignmentDelivery`
   * ترتدّ `alreadyDelivered` بلا مساس ⇒ الفاتورة تبقى مدفوعةً جزئياً والعهدةُ لا ترتفع.
   * ندعو `recordSupplementaryStatementCollection` بالمُعلَن الجديد؛ الدالّة تقيس الدلتا
   * وترفض ما لا يزيد. `noChange` صامتٌ — لا يُعدّ في `deliveriesConfirmed`.
   */
  for (const id of alreadyDeliveredIds) {
    const declared = collectedByLine.get(id);
    if (declared == null) continue;
    await recordSupplementaryStatementCollection(
      {
        consignmentId: id,
        newCollectedTotal: declared,
        statementNumber,
        clientRequestId: `stmt-supp:${input.partyId}:${statementNumber}:${id}`,
      },
      { userId: actor.userId },
    );
  }

  if (proofOnly) {
    // لا مرحلةَ ②: لا سند توريد ولا إيصال درج — الكشفُ أدّى وظيفتَه المستندية كاملةً.
    // ملاحظة مقصودة: رقمُ الكشف لم يُحجَز (القيد الفريد على سندات التوريد) — إدخالُه لاحقاً
    // كاملاً بنفس الرقم لتوريد نقده مشروع، والمرحلة ① سترتدّ فيه بلا أثر.
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
  const remittanceInput: RemittanceInput = {
    branchId: input.branchId,
    partyId: input.partyId,
    lines: moneyLines,
    countedCash: round2(money(input.countedCash)).toFixed(2),
    shiftType: input.shiftType,
    clientRequestId: input.clientRequestId ?? `stmt:${input.partyId}:${statementNumber}`,
    companyStatement: {
      statementNumber,
      statementDate: input.statementDate ?? null,
      attachmentUrl: input.attachmentUrl ?? null,
      deductionsTotal: input.deductionsTotal ?? null,
      notes: input.notes ?? null,
    },
  };

  let res: Awaited<ReturnType<typeof recordDeliveryRemittance>>;
  try {
    res = await recordDeliveryRemittance(remittanceInput, actor);
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

  return {
    remittanceId: res.remittanceId,
    remittanceNumber: res.remittanceNumber,
    statementNumber,
    deliveriesConfirmed: needConfirm.length,
    collectedTotal: res.collectedTotal,
    netRemitted: res.netRemitted,
    idempotentReplay: (res as { idempotentReplay?: boolean }).idempotentReplay,
  };
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
