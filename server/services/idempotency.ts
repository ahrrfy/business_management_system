// مساعد Idempotency للعمليات المالية الحسّاسة (دفعات/مرتجعات/استلام).
// النمط: داخل withTx، فحص (operation, clientRequestId) — إن وُجد ⇒ نُعيد refId المخزّن (replay)؛
// وإلّا فالعملية تكتب البيانات الفعلية ثم تسجّل المفتاح. القيد الفريد على (operation, key) يمنع
// تسابق طلبَين متزامنين بنفس المفتاح (الثاني يتلقّى ER_DUP_ENTRY فيراه المستدعي).
//
// #٥ (تدقيق ١٧/٧ — توحيد idempotency): أُضيف **hash الحمولة**. المعيار الموحّد: مفتاحٌ ثابتٌ لكل
// عملية، لا يُدوَّر إلا بعد نجاحٍ كامل، وhash حمولةٍ يُفحَص خادمياً ⇒ **CONFLICT عند نفس المفتاح
// بحمولةٍ مختلفة** (كان يُعيد النتيجة القديمة صامتاً — خطأ عميل/إعادة إرسالٍ ملوَّثة). الـhash قانونيّ
// (مفاتيح مرتّبة) فإعادةُ الإرسال بنفس المدخل تُنتج نفس الـhash على أي جهاز/ترتيب.
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { idempotencyKeys } from "../../drizzle/schema";
import type { Tx } from "../db";

/** تسلسل JSON قانونيّ (مفاتيح كائناتٍ مرتّبةٌ تعاوديّاً) ⇒ نفس المدخل ⇒ نفس النصّ دائماً. */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

/** hash حمولة قانونيّ (sha256 hex، ٦٤ محرفاً) — ثابتٌ عبر إعادة الإرسال، مستقلٌّ عن ترتيب المفاتيح. */
export function idempotencyHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/** إن كان clientRequestId مُستهلَكاً سابقاً يُرجع refId الأول؛ وإلّا null. (توافقٌ خلفيّ — بلا فحص hash.) */
export async function findIdempotentRefId(
  tx: Tx,
  operation: string,
  clientRequestId: string | null | undefined,
): Promise<number | null> {
  return checkIdempotency(tx, operation, clientRequestId, undefined);
}

/**
 * يفحص المفتاح (operation, clientRequestId): إن وُجد يعيد refId المخزّن؛ وإلّا null.
 * إن مُرِّر payloadHash واختلف عن الـhash المخزّن (وكلاهما غير فارغ) ⇒ **CONFLICT** —
 * «نفس المفتاح بحمولةٍ مختلفة» (خطأ عميلٍ أو إعادة إرسالٍ ملوَّثة، لا إعادة محاولةٍ بريئة).
 */
export async function checkIdempotency(
  tx: Tx,
  operation: string,
  clientRequestId: string | null | undefined,
  payloadHash?: string | null,
): Promise<number | null> {
  if (!clientRequestId) return null;
  const rows = await tx
    .select({ refId: idempotencyKeys.refId, payloadHash: idempotencyKeys.payloadHash })
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.operation, operation), eq(idempotencyKeys.clientRequestId, clientRequestId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (payloadHash != null && row.payloadHash != null && row.payloadHash !== payloadHash) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "طلبٌ بنفس المعرّف لكن بحمولةٍ مختلفة — تحقّق من العملية ثم أعد المحاولة بمعرّفٍ جديد",
    });
  }
  return Number(row.refId);
}

/** يسجّل مفتاح الـidempotency بعد نجاح الكتابة (مع hash الحمولة اختيارياً). يرمي ER_DUP_ENTRY عند سباق طلبَين متزامنين. */
export async function recordIdempotencyKey(
  tx: Tx,
  operation: string,
  clientRequestId: string,
  refId: number,
  payloadHash?: string | null,
): Promise<void> {
  await tx.insert(idempotencyKeys).values({ operation, clientRequestId, refId, payloadHash: payloadHash ?? null });
}

/**
 * الغلاف الموحّد (المعيار الموصى به للكود الجديد، #٥): يفحص → يُعيد replay أو يُشغّل → يسجّل المفتاح +
 * hash الحمولة، كلّه داخل معاملةٍ واحدة. `run()` تُنفّذ العملية وتعيد refId الناتج (والنتيجة اختيارياً).
 * الإرجاع: replay=true ⇒ العملية مُستهلَكةٌ سابقاً (result=null، refId المخزّن)؛ وإلّا النتيجة الطازجة.
 */
export async function withIdempotency<T>(
  tx: Tx,
  args: { operation: string; clientRequestId: string | null | undefined; payload?: unknown },
  run: () => Promise<{ refId: number; result?: T }>,
): Promise<{ refId: number; result: T | null; replay: boolean }> {
  const hash = args.payload !== undefined ? idempotencyHash(args.payload) : null;
  const existing = await checkIdempotency(tx, args.operation, args.clientRequestId, hash);
  if (existing != null) return { refId: existing, result: null, replay: true };
  const { refId, result } = await run();
  if (args.clientRequestId) await recordIdempotencyKey(tx, args.operation, args.clientRequestId, refId, hash);
  return { refId, result: result ?? null, replay: false };
}
