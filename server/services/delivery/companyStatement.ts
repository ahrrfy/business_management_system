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
 * ═══ عدم التكرار ═══
 * طبقتان: `clientRequestId` (تقنيّة، تمتصّ النقر المزدوج) + **رقم الكشف الفريد لكل جهة**
 * (قيدٌ في القاعدة — هجرة 0229) الذي يمنع إدخال الكشف نفسه مرّتين ولو من جهازٍ وجلسةٍ أخرى.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { deliveryConsignments, deliveryRemittances } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { isDupEntry } from "@shared/errorMap.ar";
import { money, round2 } from "../money";
import { confirmConsignmentDelivery } from "./courier";
import { recordDeliveryRemittance, type RemittanceInput } from "./remittance";
import type { DeliveryTxActor } from "./types";

export interface CompanyStatementLineInput {
  consignmentId: number;
  /** المُحصَّل فعلاً على هذا الطرد حسب الكشف (قد يقلّ عن COD — فرقٌ يبقى على العميل). */
  collectedAmount: string;
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
  remittanceId: number;
  remittanceNumber: string;
  statementNumber: string;
  /** عدد الأسطر التي أثبت الكشفُ تسليمها الآن (لم تكن مختومة) — أثرٌ يُعرَض للمستخدم. */
  deliveriesConfirmed: number;
  collectedTotal: string;
  netRemitted: string;
  idempotentReplay?: boolean;
}

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

  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });

  // ── المرحلة ①: إثبات التسليم لكل سطرٍ غير مختوم ──
  // القراءة قبل الكتابة تحدّد **ما يحتاج إثباتاً فعلاً**؛ الأسطر المختومة سلفاً (بوّابة مندوب
  // أو كشفٌ سابق) تمرّ بلا مساس، فالكشف الجزئيّ المتمِّم لا يعيد ختم ما خُتم.
  const ids = input.lines.map((l) => Number(l.consignmentId));
  const rows = await db
    .select({
      id: deliveryConsignments.id,
      partyId: deliveryConsignments.partyId,
      branchId: deliveryConsignments.branchId,
      parcelStatus: deliveryConsignments.parcelStatus,
      status: deliveryConsignments.status,
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

  const collectedByLine = new Map(
    input.lines.map((l) => [Number(l.consignmentId), round2(money(l.collectedAmount)).toFixed(2)]),
  );
  const needConfirm = ids.filter((id) => byId.get(id)!.parcelStatus !== "DELIVERED");
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
        },
      },
      { userId: actor.userId },
    );
  }

  // ── المرحلة ②: التوريد بالآلة القائمة كاملةً بحرّاسها ──
  const remittanceInput: RemittanceInput = {
    branchId: input.branchId,
    partyId: input.partyId,
    lines: input.lines.map((l) => ({
      consignmentId: Number(l.consignmentId),
      collectedAmount: round2(money(l.collectedAmount)).toFixed(2),
    })),
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
