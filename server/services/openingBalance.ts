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
import { accountingEntries } from "../../drizzle/schema";
import type { Tx } from "../db";
import { localTodayDate } from "./dateRange";
import { money, round2, toDbMoney } from "./money";
import { assertPeriodOpen } from "./periodLockService";

export type OpeningDirection = "OWED_TO_US" | "OWED_BY_US";

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
  await assertPeriodOpen(tx, localTodayDate());
  await tx.insert(accountingEntries).values({
    entryType: "OPENING",
    customerId: party === "CUSTOMER" ? partyId : null,
    supplierId: party === "SUPPLIER" ? partyId : null,
    revenue: toDbMoney("0"),
    cost: toDbMoney("0"),
    profit: toDbMoney("0"),
    taxAmount: toDbMoney("0"),
    amount,
    // localTodayDate() يمنع انزياح OPENING ليوم سابق (عمود DATE على توقيت بغداد +٣).
    entryDate: localTodayDate(),
    notes,
    dedupeKey: `OPENING:${party}:${partyId}`,
  });
}
