// أدوات مشتركة: التسجيل والملخّص وتعريب رسائل الفشل — لا تُصدَّر من نقطة الدخول العامة
// (عدا writeErrorMessage المُصدَّرة عمداً للاختبار).
import { mysqlCodeFrom, toArabicMessage } from "@shared/errorMap.ar";
import { importBatches } from "../../../drizzle/schema";
import { logger } from "../../logger";
import { extractInsertId } from "../../lib/insertId";
import { type Actor, requireDb } from "../tx";
import type { ImportOptions, ImportRowResult, ImportSummary, ImportType } from "./types";

const norm = (s?: string | null): string | null => {
  const t = s?.trim();
  return t || null;
};
const uniq = <T>(arr: (T | null | undefined)[]): T[] =>
  Array.from(new Set(arr.filter((x): x is T => x != null && x !== "")));
const insertId = extractInsertId;

function tally(rows: ImportRowResult[]) {
  return {
    created: rows.filter((r) => r.status === "created").length,
    updated: rows.filter((r) => r.status === "updated").length,
    skipped: rows.filter((r) => r.status === "skipped").length,
    failed: rows.filter((r) => r.status === "failed").length,
  };
}

/** يبني الملخّص ويسجّل الدفعة في importBatches (best-effort، لا يرمي). */
async function finalize(
  importType: ImportType,
  total: number,
  rows: ImportRowResult[],
  committed: boolean,
  options: ImportOptions,
  actor: Actor,
): Promise<ImportSummary> {
  const counts = tally(rows);
  const summary: ImportSummary = {
    total,
    ...counts,
    committed,
    rows: [...rows].sort((a, b) => a.rowNumber - b.rowNumber),
  };

  // تسجيل الدفعة للمساءلة (لا نسجّل المعاينة dry-run؛ لا تغيير حالة).
  if (!options.dryRun) {
    try {
      const db = requireDb();
      await db.insert(importBatches).values({
        batchName: options.fileName?.slice(0, 255) || `استيراد ${importType}`,
        importType,
        fileName: options.fileName?.slice(0, 255) ?? null,
        totalRows: total,
        // عند عدم الالتزام (rollback) لم يُكتب شيء ⇒ صفّر الناجح كي لا يناقض الحالة FAILED.
        successfulRows: committed ? counts.created + counts.updated : 0,
        failedRows: counts.failed,
        // FAILED فقط حين فشلت صفوف فعلاً بلا التزام (rollback «الكل أو لا شيء») — دفعة كلّها
        // «متجاوَز» (إعادة استيراد ملف مستورَد: لا كتابة ولا فشل) تُسجَّل COMPLETED لا فشلاً زائفاً.
        status: committed || counts.failed === 0 ? "COMPLETED" : "FAILED",
        errorLog: summary.rows.filter((r) => r.status === "failed" || r.status === "skipped"),
        createdBy: actor.userId,
        completedAt: new Date(),
      });
    } catch (e) {
      logger.warn({ err: e, importType }, "تعذّر تسجيل دفعة الاستيراد");
    }
  }

  return summary;
}

function markWriteError(rows: ImportRowResult[], message: string): ImportRowResult[] {
  return rows.map((r) =>
    r.status === "created" || r.status === "updated" ? { ...r, status: "failed", message } : r,
  );
}

/** يستخرج sqlMessage من سلسلة الأسباب (DrizzleQueryError يلفّ خطأ mysql2 في cause). */
function sqlMessageFrom(err: unknown): string | null {
  let e: any = err;
  for (let i = 0; i < 5 && e; i++) {
    if (typeof e?.sqlMessage === "string") return e.sqlMessage;
    e = e?.cause;
  }
  return null;
}

/** رسالة فشل الكتابة المعروضة في عمود «السبب»: عربية قابلة للفعل دائماً.
 *  رسالة القاعدة الخام (إنجليزية، تكشف نصّ الاستعلام وقيم الصفوف وأسماء القيود الداخلية)
 *  لا تصل الواجهة أبداً — تُسجَّل في اللوغ للتشخيص فقط. أخطاء الأعمال العربية من خدماتنا
 *  (داخل withTx، كرسائل setStock) تمرّ كما هي. مُصدَّرة للاختبار. */
export function writeErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : "";
  // رسالة drizzle الخام تبدأ بـ«Failed query:» وقد تحوي نصاً عربياً ضمن قيم الصفوف —
  // تُستبعد ولو «بدت» عربية (تسرّب استعلام وبيانات).
  if (raw && /[؀-ۿ]/.test(raw) && !raw.startsWith("Failed query:")) return raw;
  if (mysqlCodeFrom(e) === "ER_DUP_ENTRY") {
    const m = /Duplicate entry '(.*)' for key '([^']+)'/.exec(sqlMessageFrom(e) ?? "");
    const value = m?.[1] ?? "؟";
    const key = (m?.[2] ?? "").toLowerCase();
    // اصطدام حارس السباق البنيوي uq_*_legacy (§٥.٢): استيرادان متزامنان — التعافي بإعادة التشغيل.
    if (key.includes("legacy")) {
      return `تعارض استيراد متزامن — الرقم القديم «${value}» أُدرج للتوّ من عملية أخرى؛ أعد تشغيل الاستيراد (الموجود يُتخطّى).`;
    }
    if (key.includes("barcode")) {
      return `الباركود «${value}» أُدرج للتوّ من عملية أخرى — أعد تشغيل الاستيراد (الموجود يُتخطّى).`;
    }
  }
  // بقية الرموز (ER_DATA_TOO_LONG باسم الحقل العربي، أقفال، اتصال…) تُعرَّب عبر الخريطة المشتركة.
  return toArabicMessage({ cause: e });
}


// تصدير داخلي للحزمة فقط (يستهلكه customers/suppliers/products) — لا يُعاد تصديره من البرميل
// importService.ts (عدا writeErrorMessage المُصدَّرة صراحةً أعلاه بـexport function).
export { norm, uniq, insertId, tally, finalize, markWriteError, sqlMessageFrom };
