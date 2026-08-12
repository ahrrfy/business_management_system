// خطّاف الظلّ (P2 — الشريحة ١، خطة docs/double-entry-p2-plan-2026-08-11.md).
//
// نقطة الحقن الوحيدة بين الدفتر المبسّط والدفتر المزدوج: يُستدعى من `postEntry` بعد إدراج القيد
// المبسّط، **داخل معاملته نفسها** (س٤: لا حالةَ جزئيةٌ ممكنة — تراجعُ البيع يتراجع معه القيد).
//
// ⚠️ الثابت الحاكم (س٣): **لا يرمي أبداً.** أيّ فشلٍ هنا — نوعٌ غير مُخطَّط، حالةٌ ملتبسة، خللٌ في
// المحرّك — يُسجَّل صفَّ فجوةٍ مرئياً ثم يمضي. سببه أنّ هذه الشِفرة تجري داخل معاملة بيعٍ حقيقية:
// رميةٌ واحدة = ROLLBACK للفاتورة = كاشيرٌ متوقّف. سلامةُ عملية الأعمال تسبق سلامة القيد، والفجوة
// ليست خسارة: عدّادها صفراً شرطُ الانتقال إلى ACTIVE (س٧)، فلا يُعتمَد دفترٌ ناقص.
import type { EntryInput } from "../ledgerService"; // نوعٌ فقط ⇒ لا دورة استيراد وقت التشغيل
import {
  dropJournal,
  getDoubleEntryMode,
  writeJournal,
  writeJournalGap,
  writeJournalNoEntry,
} from "./journalStore";
import { MAPPED_ENTRY_TYPES, postingLinesFor } from "./postingEngine";
import type { Tx } from "../../db";

/** أنواعٌ يتحدّد دلو نقدها من طريقة الدفع ⇒ غيابُها التباسٌ لا افتراض. */
const CASH_BUCKET_TYPES = new Set(["PAYMENT_IN", "PAYMENT_OUT"]);

/**
 * طريقة الدفع (enum `receipts.paymentMethod`) ← دلو النقد المحاسبيّ.
 *
 * `null` تعني **«لا أعرف، ولن أخمّن»**: `WALLET`/`EXCHANGE`/`TELECOM` ليست نقداً ولا بنكاً — هي
 * أصولٌ مستقلّة (محفظة رقمية، محفظة صيرفة، رصيد اتصالات)، والكود نفسه يقرّ بذلك: الصيرفة «لا تمسّ
 * الخزينة»، ورصيد زين «لا يلمس الدرج أبداً» (schema.ts). حشرُها في CASH يضع رصيد كروت الشحن في درج
 * الكاشير، وفي CARD_BANK يضعه في البنك — كلاهما إفسادٌ صامتٌ لميزان المراجعة. تصير فجوةً حتى
 * تُخصَّص لها أدوارُها في الدفعة ٢أ.
 */
export function cashRoleFor(method: string | null | undefined): "CASH" | "CARD_BANK" | null {
  switch (method) {
    case "CASH":
      return "CASH";
    // تحويل/بطاقة/صكّ ⇒ أصلٌ بنكيّ. (الصكوك غير مستعملة في هذا النشاط بقرار المالك، وتُترك
    // مُخطَّطةً لأنّ الأداة بنكيّةٌ بطبيعتها فلا التباس فيها.)
    case "CARD":
    case "TRANSFER":
    case "CHECK":
      return "CARD_BANK";
    default:
      return null;
  }
}

/** الطرف المقابل كما يفهمه المحرّك. أولوية العميل: قيود القبض/البيع تحمل عميلاً حين تخصّه. */
function partyOf(e: EntryInput): "CUSTOMER" | "SUPPLIER" | null {
  if (e.customerId != null) return "CUSTOMER";
  if (e.supplierId != null) return "SUPPLIER";
  return null;
}

/**
 * يكتب القيد المزدوج ظلّاً لحدثٍ ماليٍّ أُدرِج للتوّ. آمنٌ للاستدعاء من أيّ مسار كتابةٍ ماليّ.
 *
 * @param entryId معرّف الصفّ في `accountingEntries` (الرابط الفريد — س٥).
 */
export async function shadowPost(tx: Tx, entryId: number, e: EntryInput): Promise<void> {
  const entryDate = e.entryDate ?? new Date();
  const branchId = e.branchId ?? null;
  try {
    if ((await getDoubleEntryMode(tx)) === "OFF") return; // س٢: صفر أثرٍ افتراضاً

    if (!MAPPED_ENTRY_TYPES.has(e.entryType)) {
      await writeJournalGap(tx, entryId, entryDate, branchId, `نوعُ قيدٍ غير مُخطَّط بعد: ${e.entryType}`);
      return;
    }

    // دلو النقد لا يُخمَّن: موضعُ قبضٍ/صرفٍ لم يمرّر طريقته يصير فجوةً صارخة بدل تصنيفٍ خاطئٍ صامت.
    // يُستثنى تحصيل المندوب: لا نقد عندنا أصلاً (ذمّة ← عهدة)، فلا دلوَ يُحدَّد.
    const viaCourier = e.deliveryPartyId != null;
    let cashRole: "CASH" | "CARD_BANK" | undefined;
    if (CASH_BUCKET_TYPES.has(e.entryType) && !viaCourier) {
      const resolved = cashRoleFor(e.paymentMethod);
      if (resolved === null) {
        await writeJournalGap(
          tx, entryId, entryDate, branchId,
          `دلو نقدٍ غير محدَّد لـ${e.entryType} (طريقة الدفع: ${e.paymentMethod ?? "غير مُمرَّرة"})`,
        );
        return;
      }
      cashRole = resolved;
    }

    const lines = postingLinesFor({
      entryType: e.entryType,
      revenue: e.revenue?.toString(),
      cost: e.cost?.toString(),
      amount: e.amount?.toString(),
      taxAmount: e.taxAmount?.toString(),
      party: partyOf(e),
      cashRole,
      hasDeliveryParty: viaCourier,
    });
    // خريطةٌ تُعيد صفر أسطر = قرارٌ محاسبيّ بأن الحدث لا يستحقّ قيداً (لا عجزٌ عنه) ⇒ NO_ENTRY.
    if (lines.length === 0) {
      await writeJournalNoEntry(tx, entryId, entryDate, branchId, `لا قيدَ مزدوجاً لهذا الحدث عمداً: ${e.entryType}`);
      return;
    }
    await writeJournal(tx, entryId, entryDate, branchId, lines);
  } catch (err) {
    // الفجوة هي شبكة الأمان: تُسجَّل بدل الرمية. وإن فشل تسجيلُها أيضاً ⇒ صمتٌ تامّ، فالبديل
    // الوحيد المتبقّي هو إسقاط معاملة أعمالٍ حقيقية بسبب دفترٍ ظلّيٍّ لم يُعتمَد بعد.
    try {
      await writeJournalGap(
        tx, entryId, entryDate, branchId,
        err instanceof Error ? err.message : "خطأٌ غير معروف في خطّاف الدفتر المزدوج",
      );
    } catch {
      /* لا شيء يُفشِل عملية أعمال. */
    }
  }
}

/**
 * يعيد بناء القيد المزدوج لحدثٍ **تغيّر مبلغُه بعد إدراجه**. مسارٌ نادرٌ لكنه حقيقيّ:
 * `upsertOpeningEntry` يُحدّث مبلغ قيد OPENING قائم؛ بلا إعادة البناء يبقى القيد المزدوج على
 * المبلغ القديم فيخالف الدفتر بصمت. (الحذف يتكفّل به `ON DELETE CASCADE`.)
 */
export async function shadowRepost(tx: Tx, entryId: number, e: EntryInput): Promise<void> {
  try {
    if ((await getDoubleEntryMode(tx)) === "OFF") return;
    await dropJournal(tx, entryId);
  } catch {
    return; // فشلُ الحذف ⇒ لا تُضِف قيداً ثانياً (uq_journal_entry يمنعه أصلاً).
  }
  await shadowPost(tx, entryId, e);
}
