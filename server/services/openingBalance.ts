// دلالات الرصيد الافتتاحي المشتركة (إدخال يدوي + استيراد) — مصدر حقيقة واحد لقيد OPENING.
//
// اتجاه الدين (توحيد المسمّيات §terminology-canon):
//   - "OWED_TO_US"  = «لنا» على الطرف (الطرف مَدين لنا).
//   - "OWED_BY_US"  = «علينا» للطرف (نحن مَدينون للطرف).
//
// دلالة عمود currentBalance تختلف بين الطرفين (CLAUDE.md §٥):
//   - العميل: موجب = «لنا على العميل» (ذمّة مدينة AR).
//   - المورّد: موجب = «علينا للمورّد» (ذمّة دائنة AP).
// لذا الاتجاه نفسه يُنتج إشارتين متعاكستين بين العميل والمورّد.
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { accountingEntries } from "../../drizzle/schema";
import type { Tx } from "../db";
import { getDoubleEntryRuntime } from "./accounting/journalStore";
import { localTodayDate } from "./dateRange";
import { postEntry } from "./ledgerService";
import {
  createPostingIntent,
  signedPostingLines,
} from "./accounting/postingEngine";
import { money, round2, toDbMoney } from "./money";
import { assertPeriodOpen } from "./periodLockService";

export type OpeningDirection = "OWED_TO_US" | "OWED_BY_US";

/**
 * الأرصدة الافتتاحية مرجع قطعٍ تاريخي، وليست أداة تصحيح بعد بدء الدفتر المزدوج.
 * القفل المشترك يسبق أي قراءة/تعديل للمصدر كي ينتظر انتقال OFF → SHADOW العملية
 * الجارية، والعكس. بعد القطع يجب تسجيل الفرق بقيدٍ مصنف جديد يحفظ التاريخ.
 */
export async function assertLegacyOpeningMutable(tx: Tx): Promise<void> {
  const runtime = await getDoubleEntryRuntime(tx);
  if (runtime.mode !== "OFF") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "لا يمكن إنشاء أو تعديل أو حذف رصيد افتتاحي بعد بدء SHADOW/ACTIVE. سجّل التصحيح بقيد فرقٍ جديد ومصنف يحفظ لقطة القطع والتاريخ المحاسبي.",
    });
  }
}

/** تحقّق من صيغة المبلغ (غير سالب، منزلتان عشريتان). يرمي TRPCError عند الفساد (تصل رسالته للواجهة). */
export function assertValidMagnitude(magnitude: string): void {
  const m = magnitude.trim();
  if (m && !/^\d+(\.\d{1,2})?$/.test(m))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "قيمة الرصيد الافتتاحي غير صالحة (رقم غير سالب، منزلتان عشريتان).",
    });
}
/**
 * القيمة الموقَّعة المخزَّنة في currentBalance وفق دلالة الطرف.
 *  - العميل: OWED_TO_US ⇒ موجب، OWED_BY_US ⇒ سالب.
 *  - المورّد: OWED_BY_US ⇒ موجب، OWED_TO_US ⇒ سالب (الإشارة منقلبة).
 *  - المبلغ صفر/فارغ ⇒ "0.00" (لا رصيد افتتاحي).
 */
export function signedOpeningBalance(
  party: "CUSTOMER" | "SUPPLIER",
  magnitude: string | null | undefined,
  direction: OpeningDirection,
): string {
  if (magnitude == null) return "0.00";
  const trimmed = magnitude.trim();
  if (!trimmed) return "0.00"; // فارغ ⇒ لا رصيد (money("") يرمي في decimal.js).
  assertValidMagnitude(trimmed);
  const m = round2(money(trimmed));
  if (m.lte(0)) return "0.00";
  const owedToUs = direction === "OWED_TO_US";
  // العميل موجب=لنا عليه؛ المورّد موجب=علينا له ⇒ تنقلب الإشارة للمورّد.
  const positive = party === "CUSTOMER" ? owedToUs : !owedToUs;
  return toDbMoney(positive ? m : m.negated());
}

/**
 * قيد OPENING المرجعي — نفس آلية الاستيراد بالضبط.
 *  - `amount` = القيمة الموقَّعة (نظير currentBalance المخزَّن) ⇒ كشف الحساب/الأعمار/reconcile متّسقة.
 *  - `dedupeKey = OPENING:<party>:<id>` فريد على مستوى القاعدة ⇒ قيد افتتاحي واحد لكل طرف
 *    (يمنع ازدواج الإدخال اليدوي مع استيراد لاحق للطرف نفسه بنيوياً).
 *  - يفرض فتح الفترة المحاسبية لليوم قبل الكتابة.
 */
export async function postOpeningEntry(
  tx: Tx,
  party: "CUSTOMER" | "SUPPLIER",
  partyId: number,
  amount: string,
  notes = "رصيد افتتاحي",
): Promise<void> {
  await assertLegacyOpeningMutable(tx);
  const signedAmount = money(amount);
  // يمرّ عبر postEntry (منفذ الدفتر الوحيد) لا بإدراجٍ مباشر: الإدراج المباشر كان يتجاوز
  // نقطةَ الحقن المركزية — حارس الفترة الموحَّد وخطّاف الدفتر المزدوج (P2) — فيسقط الرصيد
  // الافتتاحيّ من ميزان المراجعة بصمت. القيم أدناه مطابقةٌ حرفياً للإدراج السابق.
  await postEntry(tx, {
    entryType: "OPENING",
    customerId: party === "CUSTOMER" ? partyId : null,
    supplierId: party === "SUPPLIER" ? partyId : null,
    revenue: money("0"),
    cost: money("0"),
    profit: money("0"),
    taxAmount: money("0"),
    amount: signedAmount,
    postingIntent: createPostingIntent(
      party === "CUSTOMER" ? "OPENING_CUSTOMER" : "OPENING_SUPPLIER",
      "OPENING",
      party === "CUSTOMER"
        ? signedPostingLines("AR", "OPENING_EQUITY", signedAmount)
        : signedPostingLines("OPENING_EQUITY", "AP", signedAmount),
    ),
    // localTodayDate() يمنع انزياح OPENING ليوم سابق (عمود DATE على توقيت بغداد +٣).
    entryDate: localTodayDate(),
    notes,
    dedupeKey: `OPENING:${party}:${partyId}`,
  });
}

/** المبلغ الموقَّع لقيد OPENING الحالي للطرف ("0.00" إن لم يوجد) — لعرضه في شاشة التعديل. */
export async function getOpeningEntryAmount(
  tx: Tx,
  party: "CUSTOMER" | "SUPPLIER",
  partyId: number,
): Promise<string> {
  const col = party === "CUSTOMER" ? accountingEntries.customerId : accountingEntries.supplierId;
  const row = (
    await tx
      .select({ amount: accountingEntries.amount })
      .from(accountingEntries)
      .where(and(eq(accountingEntries.entryType, "OPENING"), eq(col, partyId)))
      .limit(1)
  )[0];
  return toDbMoney(money(row?.amount ?? "0"));
}

/**
 * تصحيح الرصيد الافتتاحي لطرفٍ قائم (إدخال أوّليّ خاطئ) — مصدر حقيقة واحد لتعديل قيد OPENING.
 * يجعل قيد OPENING المرجعيّ يطابق `newSigned` (قيمة موقَّعة، نظير currentBalance المخزَّن):
 *  - لا قيد سابق + هدف ≠ 0 ⇒ يُنشئ قيداً (postOpeningEntry، يفحص فترة اليوم).
 *  - قيد قائم + هدف ≠ 0 ⇒ يُحدّث مبلغه (يفحص فترة القيد نفسه — لا تُعدَّل فترة مُقفَلة).
 *  - قيد قائم + هدف = 0 ⇒ يحذف القيد (إزالة الرصيد الافتتاحي).
 * يعيد **الفارق الموقَّع** (newSigned − oldOpening) لتطبيقه على currentBalance بزيادة نسبية ذرّية
 * تصون أثر النشاط اللاحق (لا يُعاد بناء الرصيد من الصفر). أموال بدقّة decimal.js (§٥).
 */
export async function upsertOpeningEntry(
  tx: Tx,
  party: "CUSTOMER" | "SUPPLIER",
  partyId: number,
  newSigned: string,
  notes = "رصيد افتتاحي",
): Promise<{ delta: string }> {
  await assertLegacyOpeningMutable(tx);
  const col = party === "CUSTOMER" ? accountingEntries.customerId : accountingEntries.supplierId;
  const existing = (
    await tx
      .select({ id: accountingEntries.id, amount: accountingEntries.amount, entryDate: accountingEntries.entryDate })
      .from(accountingEntries)
      .where(and(eq(accountingEntries.entryType, "OPENING"), eq(col, partyId)))
      .limit(1)
  )[0];
  const oldSigned = money(existing?.amount ?? "0");
  const target = round2(money(newSigned));
  const delta = round2(target.minus(oldSigned));
  if (delta.isZero()) return { delta: "0.00" }; // لا تغيير فعليّ.

  if (existing) {
    // تعديل/حذف قيدٍ قائم ⇒ افحص فترة القيد نفسه (لا اليوم): لا يُمسّ رصيدٌ افتتاحيّ في فترة مُقفَلة.
    await assertPeriodOpen(tx, new Date(existing.entryDate as unknown as string));
    if (target.isZero()) {
      // القيد المزدوج (P2) يُجرَف معه بـON DELETE CASCADE ⇒ لا شيء إضافيّ هنا.
      await tx.delete(accountingEntries).where(eq(accountingEntries.id, existing.id));
    } else {
      await tx.update(accountingEntries).set({ amount: toDbMoney(target) }).where(eq(accountingEntries.id, existing.id));
      // في OFF لا تُنشأ يومية جديدة ولا يُعاد بناء يومية دورة تاريخية. عند بدء دورة
      // لاحقة تلتقط شهادة القطع الرصيد التشغيلي المحدّث، مع بقاء كل دورة قديمة كما أُقرت.
    }
  } else {
    // لا قيد سابق ⇒ أنشئ (postOpeningEntry يفحص فترة اليوم بنفسه).
    await postOpeningEntry(tx, party, partyId, toDbMoney(target), notes);
  }
  return { delta: toDbMoney(delta) };
}
