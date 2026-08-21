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

/** أطول نصٍّ نحتفظ به من أيّ حقلٍ نصّيّ — يكفي للتشخيص ولا يُغرق السجلّ بحمولةٍ كاملة. */
const MAX_TEXT_CHARS = 2000;
/** عمق سلسلة `cause` الذي نمشيه — نفس حدّ `mysqlCodeFrom` في `shared/errorMap.ar.ts`. */
const MAX_CAUSE_DEPTH = 5;

type ErrorLike = {
  message?: unknown; name?: unknown; code?: unknown; errno?: unknown;
  sqlState?: unknown; sqlMessage?: unknown; sql?: unknown;
  query?: unknown; cause?: unknown;
};

const clip = (value: unknown): string | undefined =>
  typeof value === "string" ? value.slice(0, MAX_TEXT_CHARS) : undefined;
const clippedLength = (value: unknown): number | undefined =>
  typeof value === "string" && value.length > MAX_TEXT_CHARS ? value.length : undefined;

/** هل يحمل هذا الإطار علامات خطأ mysql2 الحقيقيّة؟ */
function looksLikeMysqlError(e: ErrorLike): boolean {
  return typeof e.sqlMessage === "string"
    || typeof e.errno === "number"
    || (typeof e.code === "string" && /^ER_|^E[A-Z]+$/.test(e.code));
}

/**
 * حقول الخطأ التي تكشف السبب فعلاً. خطأ `mysql2` يحمل `code`/`errno`/`sqlMessage`/`sql`
 * (مثلاً `ER_BAD_FIELD_ERROR` + «Unknown column …»)، وهي بالضبط ما ضاع في حادثة ٢١/٨.
 * نمرّرها ككائنٍ صريح لا نرمي الخطأ كما هو: `logger` يُعقّم بالمفاتيح، والكائنُ الخام قد
 * يجرّ حمولةً ضخمة أو مراجعَ دائرية.
 *
 * ⚠️ **الإطار الأعلى ليس خطأ mysql2** (مراجعة Codex على PR #695): drizzle 0.45 يلفّ خطأ
 * القاعدة داخل `DrizzleQueryError`، فتكون `code`/`errno`/`sqlMessage` على `cause` (أو أعمق)
 * و`undefined` في الأعلى — وهو نفس الفخّ الموثَّق في `isDupEntry` بـ`shared/errorMap.ar.ts`.
 * قراءةُ الأعلى وحده كانت ستُبقي العطبَ الذي وُلد هذا المُساعد لأجله بلا تشخيص. لذلك نمشي
 * سلسلةَ `cause` بعمقٍ محدود (وبحارس دورةٍ) ونأخذ حقول mysql2 من أوّل إطارٍ يحملها.
 *
 * ونحتفظ برسالة الغلاف أيضاً — لكن **مقتطَعة**: رسالة `DrizzleQueryError` هي
 * `Failed query: <الاستعلام كاملاً>\nparams: <القيم>` ⇒ بلا اقتطاعٍ تُغرق السجلّ.
 */
export function rootCauseFields(error: unknown): Record<string, unknown> {
  if (error == null || typeof error !== "object") return { message: String(error) };
  const top = error as ErrorLike;

  let mysql: ErrorLike | undefined;
  let causeDepth: number | undefined;
  const seen = new Set<object>();
  let frame: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && frame != null; depth++) {
    if (typeof frame !== "object" || seen.has(frame)) break;  // حارس الدورة
    seen.add(frame);
    if (looksLikeMysqlError(frame as ErrorLike)) {
      mysql = frame as ErrorLike;
      causeDepth = depth;
      break;
    }
    frame = (frame as ErrorLike).cause;
  }

  // نصّ الاستعلام: من خطأ mysql2 إن وُجد، وإلّا من `DrizzleQueryError.query`.
  const sqlSource = mysql?.sql ?? top.query;
  return {
    name: typeof top.name === "string" ? top.name : undefined,
    message: clip(top.message),
    messageTruncated: clippedLength(top.message),
    code: mysql?.code,
    errno: mysql?.errno,
    sqlState: mysql?.sqlState,
    sqlMessage: clip(mysql?.sqlMessage),
    sql: clip(sqlSource),
    sqlTruncated: clippedLength(sqlSource),
    // 0 = الخطأ نفسه، 1+ = كان ملفوفاً (DrizzleQueryError)، undefined = ليس خطأ قاعدة.
    causeDepth,
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
