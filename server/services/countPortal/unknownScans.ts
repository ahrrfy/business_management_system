// التقاط «الباركود المجهول» من بوابة العدّ (وثيقة «الجرد بالباركود» ٢٢/٨، ب-٤).
//
// حين يمسح العامل باركوداً لا يُحلّ داخل نطاق الجلسة (بضاعةٌ على الرفّ لا يعرفها النظام أو صنفٌ
// خارج النطاق) نلتقطه بدل أن يضيع — يعالجه المشرف لاحقاً (إضافة للنطاق/تجاهل). يُطوى في إجراء
// `count.submit` القائم عمداً: أيّ publicProcedure جديد = انتهاكٌ يرفضه حارس الصلاحيات (سلطته none).
import { TRPCError } from "@trpc/server";
import { mysqlCodeFrom } from "@shared/errorMap.ar";
import { and, eq } from "drizzle-orm";
import { stocktakeSessions, stocktakeUnknownScans } from "../../../drizzle/schema";
import { requireDb, withTx } from "../tx";
import type { PortalIdentity } from "./identity";

export type RecordUnknownScanResult = {
  ok: true;
  /** true عند إعادة إرسال نفس clientRequestId (مزامنة مكرّرة) — نجاح بلا أثر. */
  idempotent: boolean;
  /** false إذا لم يُسجَّل (الجلسة ليست قيد العدّ) — نجاحٌ صامتٌ بلا رمي. */
  recorded: boolean;
};

/**
 * يسجّل باركوداً مجهولاً في طابور الجلسة (append-only). idempotent عبر
 * uq_stkunknown_request(sessionId, clientRequestId) — تكرار المسح لا يكرّر الصفّ.
 * لا يُسجَّل إلا أثناء COUNTING (الطابور أداةُ عدٍّ ميدانيّ لا تدقيقٍ بعديّ).
 */
export async function recordUnknownScan(
  identity: PortalIdentity,
  input: { barcode: string; clientRequestId: string },
): Promise<RecordUnknownScanResult> {
  const barcode = input.barcode.trim();
  if (!barcode || barcode.length > 64) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "باركود غير صالح." });
  }
  try {
    return await withTx(async (tx) => {
      // مراجعة Codex #9: نقفل صفّ الجلسة (كـ submit) فيتسلسل التسجيل مع الانتقال إلى REVIEW —
      // بلا القفل قد تُقرأ حالةٌ قديمة فيُدرَج مسحٌ بعد التحوّل، تاركاً صنفاً معلّقاً لا يُضاف ولا يُعدّ.
      const [session] = await tx
        .select({ status: stocktakeSessions.status })
        .from(stocktakeSessions)
        .where(eq(stocktakeSessions.id, identity.session.id))
        .for("update")
        .limit(1);
      if (!session || session.status !== "COUNTING") {
        return { ok: true as const, idempotent: false, recorded: false };
      }
      await tx.insert(stocktakeUnknownScans).values({
        sessionId: identity.session.id,
        assignmentId: identity.assignment.id,
        barcode,
        scannedByName: identity.countedByName,
        scannedByUserId: identity.countedByUserId,
        clientRequestId: input.clientRequestId,
      });
      return { ok: true as const, idempotent: false, recorded: true };
    });
  } catch (e) {
    // نفس clientRequestId داخل الجلسة ⇒ القيد الفريد يرفض الثاني. لا نعدّه إعادةً آمنة إلا إن
    // طابقت الحمولة الأصلية؛ قبول المفتاح نفسه لباركود آخر يبتلع تصادم/عطب عميل صامتاً.
    if (mysqlCodeFrom(e) === "ER_DUP_ENTRY") {
      const db = requireDb();
      const [dup] = await db
        .select({
          id: stocktakeUnknownScans.id,
          barcode: stocktakeUnknownScans.barcode,
        })
        .from(stocktakeUnknownScans)
        .where(
          and(
            eq(stocktakeUnknownScans.sessionId, identity.session.id),
            eq(stocktakeUnknownScans.clientRequestId, input.clientRequestId),
          ),
        )
        .limit(1);
      if (dup) {
        if (dup.barcode !== barcode) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "أُعيد معرّف الطلب نفسه بباركود مختلف — لم يُسجّل المسح الجديد.",
          });
        }
        return { ok: true, idempotent: true, recorded: true };
      }
    }
    throw e;
  }
}
