// خطّاف الظلّ (P2 — الشريحة ١، خطة docs/double-entry-p2-plan-2026-08-11.md).
//
// نقطة الحقن الوحيدة بين الدفتر المبسّط والدفتر المزدوج: يُستدعى من `postEntry` بعد إدراج القيد
// المبسّط، **داخل معاملته نفسها** (س٤: لا حالةَ جزئيةٌ ممكنة — تراجعُ البيع يتراجع معه القيد).
//
// سياسة الفشل مرتبطة بالوضع:
// - SHADOW: أفضل جهد؛ تُسجَّل الفجوة إن أمكن ولا تتوقف عملية الأعمال.
// - ACTIVE: fail-closed؛ أي نقص خريطة/بيانات أو فشل كتابة يرمي داخل المعاملة نفسها فيرجع الحدث المالي.
// - OFF: صفر أثر.
import type { EntryInput } from "../ledgerService"; // نوعٌ فقط ⇒ لا دورة استيراد وقت التشغيل
import {
  type DoubleEntryRuntime,
  writeJournal,
  writeJournalGap,
  writeJournalMemo,
} from "./journalStore";
import { postingLinesFor } from "./postingEngine";
import type { Tx } from "../../db";
import { rethrowIfTransactionFatal } from "../../lib/txFatalError";

/**
 * يكتب القيد المزدوج ظلّاً لحدثٍ ماليٍّ أُدرِج للتوّ. آمنٌ للاستدعاء من أيّ مسار كتابةٍ ماليّ.
 *
 * @param entryId معرّف الصفّ في `accountingEntries` (الرابط الفريد — س٥).
 */
export async function shadowPost(
  tx: Tx,
  entryId: number,
  e: EntryInput,
  options: {
    runtime: DoubleEntryRuntime;
    postingValidationError?: unknown;
  },
): Promise<void> {
  const entryDate = e.entryDate ?? new Date();
  const branchId = e.branchId ?? null;
  const runtime = options.runtime;
  const { mode, cycleId } = runtime;
  if (mode === "OFF") return;

  // كل دورة ظل/اعتماد معزولة ببصمة. صف إعدادات قديم أو منجرف بلا دورة لا يجوز أن يكتب
  // تاريخاً غير قابل للنطاق؛ SHADOW يبقى أفضل جهد، أما ACTIVE فيفشل مغلقاً.
  if (!cycleId) {
    if (mode === "ACTIVE") {
      throw new Error(
        `تعذّر القيد المزدوج في وضع ACTIVE للحدث ${entryId}: دورة الدفتر غير محددة`,
      );
    }
    return;
  }

  const postingProfile = e.postingIntent?.profile ?? null;

  const gapOrThrow = async (reason: string): Promise<void> => {
    if (mode === "ACTIVE") {
      throw new Error(
        `تعذّر القيد المزدوج في وضع ACTIVE للحدث ${entryId}: ${reason}`,
      );
    }
    try {
      await writeJournalGap(tx, entryId, entryDate, branchId, reason, {
        cycleId,
        postingProfile,
      });
    } catch (gapErr) {
      rethrowIfTransactionFatal(gapErr);
      // SHADOW أفضل جهد: ستظهر محاولة الفجوة الفاشلة كقيد مفقود في المطابقة.
    }
  };

  if (options.postingValidationError) {
    await gapOrThrow(
      options.postingValidationError instanceof Error
        ? options.postingValidationError.message
        : "تعذّر التحقق من دليل نية القيد",
    );
    return;
  }
  if (!e.postingIntent) {
    await gapOrThrow(
      `لا يوجد دليل نية قيد canonical للحدث ${e.entryType}`,
    );
    return;
  }

  try {
    // PostingIntent هو العقد الصريح للمسارات الجديدة. عند وجوده لا نعيد اشتقاق الطرف أو دلو
    // النقد من الحقول القديمة؛ فالأسطر الموثقة فيه هي التي اختارها مصدر الحدث وحققها المحرك.
    const lines = postingLinesFor({
      entryType: e.entryType,
      intent: e.postingIntent,
      amount: e.amount?.toString(),
      revenue: e.revenue?.toString(),
      cost: e.cost?.toString(),
      profit: e.profit?.toString(),
      taxAmount: e.taxAmount?.toString(),
      ...(e.postingSourceComponents ?? {}),
    });
    if (lines.length === 0) {
      await writeJournalMemo(
        tx,
        entryId,
        entryDate,
        branchId,
        cycleId,
        e.postingIntent.profile,
      );
      return;
    }
    await writeJournal(tx, entryId, entryDate, branchId, lines, {
      cycleId,
      postingProfile: e.postingIntent.profile,
    });
  } catch (err) {
    rethrowIfTransactionFatal(err);
    if (mode === "ACTIVE") throw err;
    await gapOrThrow(
      err instanceof Error
        ? err.message
        : "خطأٌ غير معروف في خطّاف الدفتر المزدوج",
    );
  }
}
