// ═══ سبب جذريّ في السجلّ، رسالةٌ عامّة للمستخدم ═══
//
// عشرةُ إجراءاتٍ ماليّة في الراوترات تنتهي بالكتلة نفسها حرفياً:
//
//     } catch (e: any) {
//       if (isDupEntry(e) && attempt < 2) continue;
//       if (e instanceof TRPCError) throw e;
//       throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر …" });
//     }
//
// الرسالةُ العامّة صحيحةٌ للمستخدم (لا نُسرّب SQL إلى شاشة الكاشير)، لكنّ رميَها **بلا
// تسجيل** يمحو السبب الجذريّ نهائياً: لا الواجهة تعرفه ولا السجلّ. `saleRouter.create`
// وحده كان يُسجّله، بتعليقٍ يشرح الدرس (١٢/٦: عمودُ مخطّطٍ ناقص ظهر «تعذّر إتمام البيع»
// بلا أثر) — والتسعةُ الباقيةُ نُسخٌ من الكتلة **بلا** ذلك السطر.
//
// وكلّف ذلك يوماً كاملاً في ٢١/٨/٢٦: `Unknown column 'purchaseReturnSettlement'` كان يُعطّل
// **كلّ** مرتجع شراء على الإنتاج، ووصل المالكَ «تعذّر إتمام مرتجع الشراء» وحدها؛ فلزم
// استنتاجُ العمود ببناء قاعدتين ومقارنتهما بدل قراءة سطرٍ في السجلّ.
//
// هذا المُساعد يجعل التسجيل **جزءاً من الرمي** لا خطوةً تُنسى: من يكتب الكتلة القادمة
// يستدعي دالّةً واحدة فيحصل على الاثنين معاً.
import { TRPCError } from "@trpc/server";
import { logger } from "../logger";

/** أطول نصٍّ نحتفظ به من الاستعلام — يكفي للتشخيص ولا يُغرق السجلّ بحمولةٍ كاملة. */
const MAX_SQL_CHARS = 2000;

/**
 * حقول الخطأ التي تكشف السبب فعلاً. خطأ `mysql2` يحمل `code`/`errno`/`sqlMessage`/`sql`
 * (مثلاً `ER_BAD_FIELD_ERROR` + «Unknown column …»)، وهي بالضبط ما ضاع في حادثة ٢١/٨.
 * نمرّرها ككائنٍ صريح لا نرمي الخطأ كما هو: `logger` يُعقّم بالمفاتيح، والكائنُ الخام قد
 * يجرّ حمولةً ضخمة أو مراجعَ دائرية.
 */
export function rootCauseFields(error: unknown): Record<string, unknown> {
  const e = error as {
    message?: unknown; name?: unknown; code?: unknown; errno?: unknown;
    sqlState?: unknown; sqlMessage?: unknown; sql?: unknown;
  } | null | undefined;
  if (e == null || typeof e !== "object") return { message: String(error) };
  const sql = typeof e.sql === "string" ? e.sql.slice(0, MAX_SQL_CHARS) : undefined;
  return {
    name: typeof e.name === "string" ? e.name : undefined,
    message: typeof e.message === "string" ? e.message : undefined,
    code: e.code,
    errno: e.errno,
    sqlState: e.sqlState,
    sqlMessage: e.sqlMessage,
    sql,
    sqlTruncated: typeof e.sql === "string" && e.sql.length > MAX_SQL_CHARS ? e.sql.length : undefined,
  };
}

/**
 * يُسجّل السبب الجذريّ ثمّ يرمي `INTERNAL_SERVER_ERROR` برسالةٍ عربيّةٍ موجَّهة للمستخدم.
 *
 * ⚠️ للخطأ **غير المتوقَّع** وحده. الخطأ المقصود (رصيدٌ غير كافٍ، صلاحية، تحقّق) يبقى
 * `TRPCError` برسالته الخاصّة ويُرمى كما هو — فالمستدعي يفحص `instanceof TRPCError` قبله.
 *
 * @param op اسم الإجراء كما يظهر في السجلّ (`purchaseReturns.create`).
 * @param userMessage الرسالة العربيّة التي تصل الشاشة — لا تتغيّر عن السابق.
 * @param context حقولٌ تُضيّق البحث (المستخدم/الفرع/المستند)، بلا حمولةٍ حسّاسة.
 */
export function failOpaque(
  error: unknown,
  { op, userMessage, context }: {
    op: string;
    userMessage: string;
    context?: Record<string, unknown>;
  },
): never {
  logger.error(
    { err: rootCauseFields(error), op, ...(context ?? {}) },
    `${op} فشل بخطأ غير متوقّع (السبب الجذريّ في err)`,
  );
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: userMessage });
}
