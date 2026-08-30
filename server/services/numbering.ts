import { desc, like, sql } from "drizzle-orm";
import { consignmentNotes, invoices } from "../../drizzle/schema";
import type { Tx } from "../db";
import { toDateStr } from "./money";

/**
 * أرضيّة كل عدّاد — أوّل رقمٍ يُنتَج هو `floor + 1`. النطاقان متباعدان عمداً كي يُميَّز نوع
 * المستند بالنظر: الفواتير من ١٠٠٠١، وأوامر الشغل من ٥٠٠١.
 */
const COUNTER_FLOORS: Record<string, number> = {
  invoice: 10000,
  workOrder: 5000,
};

/**
 * حجزٌ ذرّيّ لرقمٍ تسلسليّ من عدّاد المستندات (هجرة 0211).
 *
 * عمليةٌ واحدة: `INSERT … ON DUPLICATE KEY UPDATE lastValue = LAST_INSERT_ID(lastValue + 1)`
 * — MySQL يضبط `LAST_INSERT_ID` للجلسة بالقيمة الجديدة، فنقرؤها بلا مسحٍ ولا قفلٍ صريح.
 * ⚠️ الرقم مُستهلَكٌ فور الحجز: تراجعُ المعاملة **لا** يعيده (سلوك العدّادات المتعارف عليه في
 * MySQL وPostgres معاً). أثرُه ثغرةٌ في التسلسل عند فشلٍ نادر — وهو مقبولٌ ومقصود: البديل
 * (إعادة استعمال الأرقام) يخلق رقمَين لمستندَين مختلفين عبر الزمن وهو أخطر بكثير محاسبياً.
 */
export async function nextCounterValue(tx: Tx, counterKey: string): Promise<number> {
  // أرضيّة البدء تعيش في الكود لا في الهجرة وحدها: قاعدةٌ تُبنى بـ`db:push` (الاختبارات وأيّ
  // بيئةٍ جديدة) لا تمرّ بسطور البذر في SQL، فكانت تبدأ من ١ بينما الإنتاج من ١٠٠٠١ — سلوكان
  // مختلفان لنفس الشيفرة. الآن الأرضيّة تُطبَّق في مسار الإدراج نفسه فيتطابق كل البيئات.
  const floor = COUNTER_FLOORS[counterKey] ?? 0;
  // `LAST_INSERT_ID(expr)` تضبط قيمة الجلسة **وتُعيدها** — فالفرعان (إدراجٌ أوّل / زيادةٌ على
  // قائم) يضبطانها معاً في عبارةٍ ذرّيّةٍ واحدة، بلا قراءةٍ سابقة ولا قفلٍ صريح.
  await tx.execute(sql`
    INSERT INTO documentCounters (counterKey, lastValue)
    VALUES (${counterKey}, LAST_INSERT_ID(${floor + 1}))
    ON DUPLICATE KEY UPDATE lastValue = LAST_INSERT_ID(lastValue + 1)
  `);
  const res: any = await tx.execute(sql`SELECT LAST_INSERT_ID() AS v`);
  const row = Array.isArray(res) ? res[0]?.[0] : res?.rows?.[0];
  const value = Number(row?.v ?? 0);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`document counter "${counterKey}" returned an invalid value`);
  }
  return value;
}

/**
 * رقم الفاتورة — **عددٌ تسلسليّ قصير** يبدأ من 10001 (طلب المالك ١٨/٨).
 *
 * كان `INV-{فرع}-{YYYYMMDD}-{تسلسل}`: يُملى هاتفياً بصعوبة ويُكتب يدوياً بخطأ. الرقم الجديد
 * يُقرأ ويُملى بلا لبس، والفرعُ والتاريخ حقلان معروضان على المستند لا جزءٌ من الرقم.
 *
 * الباركود يبقى **بادئياً** (`INV-10023` في Code128 وفي حمولة QR) — بهذا يفصل النظام رقمَ
 * العرض عن رمز الآلة: العين ترى رقماً قصيراً، والماسح يعرف نوع المستند من بادئته فيوجّهه
 * صحيحاً. الأرقام التاريخية تبقى كما هي وتبقى قابلة للبحث.
 *
 * `branchId` يبقى في التوقيع (مستدعون كثر يمرّرونه) وإن لم يعد يدخل الرقم: العدّاد عالميّ
 * لأنّ `invoices.invoiceNumber` قيدُه الفريد عالميّ أصلاً — عدّادٌ لكل فرعٍ كان سيتصادم.
 *
 * ⚠️ **ترتيب الأقفال القانوني (فحص الحمل ٣٠/٨/٢٦):** صفّ العدّاد قفلٌ X **عالميّ مشترك** بين
 * كل مسارات الترقيم ويبقى محجوزاً حتى COMMIT. لذلك أيّ مسارٍ سيقفل/يحدّث صفّ `customers`
 * (أو أيّ صفٍّ مشتركٍ آخر) في نفس المعاملة يجب أن يقفله **قبل** استدعاء هذه الدالة، لا بعدها —
 * قلبُ الترتيب أنتج ABBA deadlock فعلياً بين البيع (عميل ← عدّاد) وتوزيع التوصيل (عدّاد ← عميل).
 * المواضع المُقوَّمة: sale/create.ts وprintSaleService.ts (أصلاً صحيحة: وردية ← عميل ← عدّاد)،
 * وworkOrder/deliver.ts (أُعيد ترتيبه كاملاً على نفس النظام)، وdelivery/dispatch.ts
 * (قفل عميلٍ صريحٍ قبل الترقيم؛ ورديته تُقرأ بلا قفل أصلاً).
 */
export async function nextInvoiceNumber(tx: Tx, _branchId: number): Promise<string> {
  return String(await nextCounterValue(tx, "invoice"));
}

/**
 * بضاعة الأمانة (ش٢): رقم سند حركة أمانة يوميّ لكل فرع — CSN-{branchId}-{YYYYMMDD}-{seq}.
 * نفس حماية السباق (GET_LOCK + قيد فريد uq_consign_note_number يبقى الحارس الأخير + إعادة محاولة الراوتر).
 */
export async function nextConsignmentNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `CSN-${branchId}-${ymd}-`;
  const lockName = `numbering:consign:${branchId}:${ymd}`;
  const lockRes: any = await tx.execute(sql`SELECT GET_LOCK(${lockName}, 5) AS locked`);
  const lockedRow = Array.isArray(lockRes) ? lockRes[0]?.[0] : lockRes?.rows?.[0];
  if (!lockedRow || Number(lockedRow.locked) !== 1) {
    throw new Error(`numbering lock timeout for ${lockName}`);
  }
  try {
    const rows = await tx
      .select({ n: consignmentNotes.noteNumber })
      .from(consignmentNotes)
      .where(like(consignmentNotes.noteNumber, `${prefix}%`))
      .orderBy(desc(consignmentNotes.id))
      .for("update")
      .limit(1);
    const last = rows[0]?.n;
    const seq = last ? parseInt(last.slice(prefix.length), 10) + 1 : 1;
    return prefix + String(seq).padStart(5, "0");
  } finally {
    await tx.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
  }
}
