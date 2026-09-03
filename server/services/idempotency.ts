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
import { AsyncLocalStorage } from "node:async_hooks";
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
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") +
    "}"
  );
}

/**
 * يُطبّع القيمة إلى **وثيقة JSON** — أي ما سيُخزَّن فعلاً في عمود `json()` ويُقرأ منه.
 *
 * ⭐ الجذر (٣/٩/٢٦، بلاغ الإنتاج «حمولة الطلب لا تطابق بصمتها المحفوظة»): كلّ مستهلكٍ يحسب
 * البصمة على كائن JS الخامّ ثمّ يخزّن الحمولة بـ`JSON.stringify` ويتحقّق لاحقاً على ما قرأه.
 * تلك الرحلة **تُسقط المفاتيح ذات `undefined`** وتحوّل `Date` إلى نصّ ISO، بينما كان
 * `canonicalJson` يُصدر `"key":null` للمفتاح `undefined` — و`undefined` يصل من الواجهة كما هو
 * عبر superjson ويبقى بعد zod (`resolution: undefined` في كلّ مرتجع بيعٍ لعميلٍ مسجَّل، أو
 * `refund: undefined` للعابر) ⇒ بصمةُ الإنشاء ≠ بصمةُ المخزَّن، فالطلب يُرفض عند الاعتماد بلا
 * مخرج. التطبيع أوّلاً يضمن `hash(x) ≡ hash(parse(stringify(x)))` **بالبناء**، ولا يغيّر بصمة
 * أيّ قيمة JSON خالصة (بلا undefined ولا Date) — فالبصمات المخزَّنة للحمولات السليمة تبقى صالحة
 * (يحرسه متّجهٌ مثبَّت في `idempotencyFramework.test.ts`). الصفوف المعلَّقة التي خُتمت قبل
 * الإصلاح تُعاد ختمها مرّةً عند النشر: `scripts/repair-control-request-payload-hashes.ts`.
 */
function toJsonDocument(value: unknown): unknown {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  return text === undefined ? null : JSON.parse(text);
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * جسرُ انتقالٍ للمفاتيح المسجَّلة **قبل** إصلاح ٣/٩/٢٦ (مراجعة Codex على #956، P1): صفوف
 * `idempotencyKeys` لا تحتفظ بالحمولة، فبصمتُها القديمة (undefined ⇒ null، وDate ⇒ `{}`)
 * لا تُعاد حسابها من القاعدة. إعادةُ محاولةٍ بعد النشر لطلبٍ التزم قبله (استجابةٌ ضاعت عبر
 * النشر — حالةُ الكاشير الأوفلاينيّ الطبيعية: `POS.tsx` يرسل `deviceId`/`customerId` بـ
 * `undefined` صراحةً) كانت ستُرفض CONFLICT بدل replay، فيُعيد الكاشير البيعَ بمفتاحٍ جديد
 * ⇒ فاتورةٌ مكرَّرة. الحلّ: `idempotencyHash` تحسب البصمة القديمة أيضاً حين تختلف، وتحفظها
 * في خريطةٍ محدودة داخل العملية؛ و`checkIdempotency` عند عدم التطابق تقبل المفتاح إن ساوت
 * البصمةُ المخزَّنة البصمةَ القديمة **لنفس الحمولة** — فحمايةُ «نفس المفتاح بحمولةٍ مختلفة»
 * تبقى كاملة (المساواة مع البصمة القديمة إثباتٌ رياضيّ على تطابق الحمولة بصيغتها القديمة).
 * الحسابُ والفحصُ يقعان في الطلب نفسه وفي العملية نفسها، فالخريطةُ لا تفوت إلّا عند طفحٍ
 * غير واقعيّ (٤٠٩٦ بصمة بين الحساب والفحص) — وحينها يعود السلوك إلى CONFLICT الصريح لا
 * إلى قبولٍ صامت.
 */
const LEGACY_HASH_CACHE_LIMIT = 4096;
/**
 * كلُّ البصمات القديمة المحتملة لكلّ بصمةٍ حالية — **مجموعةٌ لا قيمةٌ واحدة** (Codex، جولة ٢): حمولتان
 * مختلفتان قد تتشاركان البصمة الحالية وتختلفان في القديمة (`{a: undefined}` و`{b: undefined}` كلتاهما
 * `{}` بعد التطبيع)، فقيمةٌ واحدة قابلة للاستبدال كانت تُسقط مفتاحاً صالحاً تحت طلبين متزامنين.
 *
 * **محلّيةٌ للطلب** (Codex، جولة ٤): المخزنُ الحيّ هو خريطةُ الطلب الجاري (AsyncLocalStorage يفتحها
 * وسيط Express مبكراً — `runWithLegacyHashScope`)، فلا يستطيع طلبٌ متزامن أن يطرح مرشّح طلبٍ آخر
 * مهما بلغ التزامن؛ وتموت مع الطلب. الخريطةُ العامّة المحدودة **احتياطٌ** لما يجري خارج طلبٍ
 * (سكربتات/اختبارات/وظائف الخلفية) فقط.
 */
const legacyHashScope = new AsyncLocalStorage<Map<string, Set<string>>>();
const globalLegacyHashesByCurrent = new Map<string, Set<string>>();
function legacyHashesByCurrentStore(): Map<string, Set<string>> {
  return legacyHashScope.getStore() ?? globalLegacyHashesByCurrent;
}
/** يفتح نطاقَ مرشّحاتٍ خاصّاً بالطلب الجاري — يُستدعى من وسيط Express لكلّ طلب. */
export function runWithLegacyHashScope<T>(fn: () => T): T {
  return legacyHashScope.run(new Map(), fn);
}
/**
 * سقفُ المرشّحات لكلّ بصمةٍ حالية (Codex، جولة ٣): حمولاتٌ متطابقة JSON تختلف في مواضع
 * `undefined` (عقد طلب الشراء: ثلاثة حقول nullish × ٢٠٠ سطر) كانت تُنمّي مجموعةً واحدة بلا حدّ.
 * الأقدم يُطرَح أوّلاً؛ الاستعمال الفعليّ قراءةٌ في الطلب نفسه، فالسقف الصغير كافٍ.
 */
const LEGACY_CANDIDATES_PER_HASH = 8;
function rememberLegacyHash(current: string, legacy: string): void {
  if (current === legacy) return;
  const legacyHashesByCurrent = legacyHashesByCurrentStore();
  const existing = legacyHashesByCurrent.get(current);
  if (existing) {
    if (existing.has(legacy)) return;
    if (existing.size >= LEGACY_CANDIDATES_PER_HASH) {
      const oldest = existing.values().next().value;
      if (oldest !== undefined) existing.delete(oldest);
    }
    existing.add(legacy);
    return;
  }
  if (legacyHashesByCurrent.size >= LEGACY_HASH_CACHE_LIMIT) {
    const oldest = legacyHashesByCurrent.keys().next().value;
    if (oldest !== undefined) legacyHashesByCurrent.delete(oldest);
  }
  legacyHashesByCurrent.set(current, new Set([legacy]));
}
/** البصمة بالصيغة القديمة (قبل ٣/٩/٢٦) — للاختبارات ولتوثيق الجسر؛ لا يستعملها مسارٌ حيّ للكتابة. */
export function legacyIdempotencyHash(payload: unknown): string {
  return sha256(canonicalJson(payload));
}
/**
 * المقارنة الموحَّدة لبصمة حمولةٍ مخزَّنة مع البصمة الحالية لنفس الطلب: تطابقٌ مباشر، أو بصمةٌ قديمة
 * (ما قبل ٣/٩/٢٦) **لنفس الحمولة**. تُستعمل في `checkIdempotency` وفي كلّ موضع replay يقارن
 * `payloadHash` مباشرةً (طلبات التحكّم/المشتريات/الأنبوب البيعيّ…) — وإلّا رُفض بعد النشر
 * تكرارُ طلبٍ التزم قبله بحمولةٍ فيها undefined/Date، بـCONFLICT بدل replay.
 */
export function payloadHashMatches(currentHash: string, storedHash: string | null | undefined): boolean {
  if (storedHash == null) return false;
  if (currentHash === storedHash) return true;
  return legacyHashesByCurrentStore().get(currentHash)?.has(storedHash) ?? false;
}

/**
 * hash حمولة قانونيّ (sha256 hex، ٦٤ محرفاً) — ثابتٌ عبر إعادة الإرسال، مستقلٌّ عن ترتيب المفاتيح،
 * **ومستقرٌّ عبر رحلة التخزين في عمود JSON** (انظر `toJsonDocument`).
 */
export function idempotencyHash(payload: unknown): string {
  const current = sha256(canonicalJson(toJsonDocument(payload)));
  rememberLegacyHash(current, legacyIdempotencyHash(payload));
  return current;
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
  options?: { requireStoredHash?: boolean; forUpdate?: boolean },
): Promise<number | null> {
  if (!clientRequestId) return null;
  const query = tx
    .select({
      refId: idempotencyKeys.refId,
      payloadHash: idempotencyKeys.payloadHash,
    })
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.operation, operation),
        eq(idempotencyKeys.clientRequestId, clientRequestId),
      ),
    );
  // `FOR UPDATE` هو current read في InnoDB: يفيد عند إعادة الفحص بعد انتظار قفل المصدر، لأن
  // القراءة العادية داخل REPEATABLE READ قد تبقى على snapshot يسبق التزام الطلب المتزامن الأول.
  const rows = options?.forUpdate
    ? await query.for("update").limit(1)
    : await query.limit(1);
  const row = rows[0];
  if (!row) return null;
  if (
    options?.requireStoredHash === true &&
    payloadHash != null &&
    row.payloadHash == null
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "معرّف الطلب قديم ولا يملك بصمة حمولة قابلة للتحقق؛ راجع العملية ثم استخدم معرّفاً جديداً",
    });
  }
  if (
    payloadHash != null &&
    row.payloadHash != null &&
    !payloadHashMatches(payloadHash, row.payloadHash)
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "طلبٌ بنفس المعرّف لكن بحمولةٍ مختلفة — تحقّق من العملية ثم أعد المحاولة بمعرّفٍ جديد",
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
  await tx
    .insert(idempotencyKeys)
    .values({
      operation,
      clientRequestId,
      refId,
      payloadHash: payloadHash ?? null,
    });
}

/**
 * الغلاف الموحّد (المعيار الموصى به للكود الجديد، #٥): يفحص → يُعيد replay أو يُشغّل → يسجّل المفتاح +
 * hash الحمولة، كلّه داخل معاملةٍ واحدة. `run()` تُنفّذ العملية وتعيد refId الناتج (والنتيجة اختيارياً).
 * الإرجاع: replay=true ⇒ العملية مُستهلَكةٌ سابقاً (result=null، refId المخزّن)؛ وإلّا النتيجة الطازجة.
 */
export async function withIdempotency<T>(
  tx: Tx,
  args: {
    operation: string;
    clientRequestId: string | null | undefined;
    payload?: unknown;
  },
  run: () => Promise<{ refId: number; result?: T }>,
): Promise<{ refId: number; result: T | null; replay: boolean }> {
  const hash =
    args.payload !== undefined ? idempotencyHash(args.payload) : null;
  const existing = await checkIdempotency(
    tx,
    args.operation,
    args.clientRequestId,
    hash,
  );
  if (existing != null) return { refId: existing, result: null, replay: true };
  const { refId, result } = await run();
  if (args.clientRequestId)
    await recordIdempotencyKey(
      tx,
      args.operation,
      args.clientRequestId,
      refId,
      hash,
    );
  return { refId, result: result ?? null, replay: false };
}
