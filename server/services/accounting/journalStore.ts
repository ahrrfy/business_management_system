// مخزن القيود المزدوجة (P2 — الشريحة ٠، خطة docs/double-entry-p2-plan-2026-08-11.md).
//
// طبقةُ كتابةٍ رقيقةٌ فوق `journalEntries`/`journalLines` **لا تقرّر شيئاً**: الترجمة من حدثٍ ماليّ
// إلى أسطر مدين/دائن مسؤوليةُ `postingEngine` (وحدةٌ نقيّة)، وقرارُ الكتابة من عدمها مسؤوليةُ
// خطّاف الظلّ (الشريحة ١).
//
// **حدٌّ مقصود:** هذا المخزن **يرمي** عند الخلل (قيدٌ غير متوازن، ازدواج). ابتلاعُ الرمية مسؤوليةُ
// الخطّاف وحده — فهو الذي يعرف أنّه في وضع الظلّ وأنّ سلامة عملية الأعمال تسبق سلامة القيد.
// لو ابتلع المخزنُ الأخطاءَ لصار الخللُ غيرَ مرئيٍّ في وضع ACTIVE أيضاً، وهو ما لا يُقبَل.
import { eq } from "drizzle-orm";
import { doubleEntrySettings, journalEntries, journalLines } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { assertBalanced, type JournalLine } from "./postingEngine";

export type DoubleEntryMode = "OFF" | "SHADOW" | "ACTIVE";

/**
 * وضع الدفتر المزدوج. **غياب صفّ الإعدادات ⇒ `OFF`** (فشلٌ آمن، بوّابة س٢): قاعدةٌ لم تُهيَّأ
 * بعد، أو صفٌّ حُذف، لا يجوز أن يُفعّل كتابةً لم يطلبها أحد.
 */
export async function getDoubleEntryMode(tx: Tx): Promise<DoubleEntryMode> {
  const row = (
    await tx
      .select({ mode: doubleEntrySettings.mode })
      .from(doubleEntrySettings)
      .where(eq(doubleEntrySettings.id, 1))
      .limit(1)
  )[0];
  return (row?.mode as DoubleEntryMode | undefined) ?? "OFF";
}

/**
 * يكتب قيداً مزدوجاً متوازناً لحدثٍ ماليّ. يرمي إن اختلّ التوازن (س٦) أو خلت الأسطر أو تكرّر
 * الحدث (`uq_journal_entry` — س٥). يستعمل **نفس المعاملة** المُمرَّرة ⇒ لا حالةَ جزئيةٌ ممكنة (س٤).
 */
export async function writeJournal(
  tx: Tx,
  entryId: number,
  entryDate: Date,
  branchId: number | null,
  lines: JournalLine[],
): Promise<void> {
  // رأسٌ POSTED بلا أسطر يُخفي مبلغاً عن ميزان المراجعة بصمت ⇒ خللٌ لا فجوة. استعمل
  // writeJournalGap للحالة المشروعة (نوعٌ غير مُخطَّط).
  if (lines.length === 0) {
    throw new Error(`قيدٌ مزدوجٌ بلا أسطر (الحدث ${entryId}) — استعمل writeJournalGap للفجوة.`);
  }
  assertBalanced(lines, `الحدث ${entryId}`);

  const res = await tx.insert(journalEntries).values({
    entryId,
    entryDate,
    branchId,
    status: "POSTED",
  });
  const journalId = extractInsertId(res);

  await tx.insert(journalLines).values(
    lines.map((l) => ({ journalId, role: l.role, debit: l.debit, credit: l.credit })),
  );
}

/**
 * يسجّل **فجوة**: حدثٌ ماليٌّ لم تُكتَب خريطته بعد (أو تعذّرت ترجمته). رأسٌ `UNMAPPED` بلا أسطر
 * ⇒ لا يدخل ميزان المراجعة، لكنه **مرئيٌّ ومعدود**: عدّاده صفراً شرطُ الانتقال إلى ACTIVE (س٧).
 */
export async function writeJournalGap(
  tx: Tx,
  entryId: number,
  entryDate: Date,
  branchId: number | null,
  reason: string,
): Promise<void> {
  await tx.insert(journalEntries).values({
    entryId,
    entryDate,
    branchId,
    status: "UNMAPPED",
    unmappedReason: reason.slice(0, 255),
  });
}

/**
 * يحذف القيد المزدوج لحدثٍ ماليّ (أسطرُه تُجرَف بـ`ON DELETE CASCADE`). يصمت إن لم يوجد قيد.
 * يُستعمل قبل إعادة كتابة قيدٍ تغيّر مبلغُه — `upsertOpeningEntry` يُعدّل مبالغ قيودٍ قائمة،
 * فلولا الحذف-ثمّ-الكتابة لبقي القيد المزدوج بائتاً يخالف الدفتر.
 */
export async function dropJournal(tx: Tx, entryId: number): Promise<void> {
  await tx.delete(journalEntries).where(eq(journalEntries.entryId, entryId));
}
