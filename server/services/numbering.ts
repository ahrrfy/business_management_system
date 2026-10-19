import { sql } from "drizzle-orm";
import type { Tx } from "../db";
import { toDateStr } from "./money";

/**
 * أرضيّة كل عدّاد — أوّل رقمٍ يُنتَج هو `floor + 1`. النطاقان متباعدان عمداً كي يُميَّز نوع
 * المستند بالنظر: الفواتير من ١٠٠٠١، وأوامر الشغل من ٥٠٠١.
 */
const COUNTER_FLOORS: Record<string, number> = {
  invoice: 10000,
  workOrder: 5000,
  unified_transaction: 100000,
  online_order: 100000,
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
 * كل مسارات الترقيم ويبقى محجوزاً حتى COMMIT. الترتيب الواجب على كل مسارٍ يُرقّم مستنداً هو:
 *
 *     وردية (shifts) ← عميل (customers) ← عدّاد (documentCounters) ← بقيّة المستند
 *
 * فأيّ صفٍّ مشتركٍ يُقفَل أو يُحدَّث في المعاملة يجب أن يُقفَل **قبل** استدعاء هذه الدالة، وبهذا
 * الترتيب بين الصفوف المشتركة نفسها. قلبُ أيّ زوجٍ منه أنتج ABBA فعلياً: البيع (عميل ← عدّاد)
 * مقابل توزيع التوصيل (عدّاد ← عميل)، والبيع (وردية ← عميل) مقابل التسليم (عميل ← وردية).
 *
 * ⚠️ **`assertCreditLimit` يقفل صفّ العميل** — فهو نقطة قفلٍ لا مجرّد تحقّق، ويجب أن يقع بعد
 * قفل الوردية. هذه بالذات فاتت في التقويم الأوّل وأمسكها Codex على #901.
 *
 * المواضع المُقوَّمة: sale/create.ts وprintSaleService.ts (أصلاً صحيحة)، وworkOrder/deliver.ts
 * (أُعيد ترتيبه كاملاً)، وdelivery/dispatch.ts (قفل عميلٍ صريحٍ قبل الترقيم؛ ورديته تُقرأ
 * بلا قفل أصلاً فلا زوجَ {وردية،عميل} فيه).
 */
export async function nextInvoiceNumber(tx: Tx, _branchId: number): Promise<string> {
  return String(await nextCounterValue(tx, "invoice"));
}

/**
 * حجزٌ ذرّيّ لرقم المعاملة الموحّد (R1).
 * يبدأ من 100001 (أرضية 100000) من عدّاد `unified_transaction` العالمي في `documentCounters`.
 * يُورَّث الرقم الأساسي تلقائياً لجميع المستندات والحركات الناتجة عنها.
 */
export async function nextTransactionTrackingNumber(tx: Tx): Promise<string> {
  const floorCheck: any = await tx.execute(sql`
    SELECT lastValue FROM documentCounters WHERE counterKey = 'unified_transaction_floor' LIMIT 1
  `);
  const floorRow = Array.isArray(floorCheck) ? floorCheck[0]?.[0] : floorCheck?.rows?.[0];
  if (!floorRow) {
    await tx.execute(sql`
      INSERT INTO documentCounters (counterKey, lastValue)
      SELECT 'unified_transaction_floor', 100000 + COALESCE(MAX(id), 0)
      FROM onlineOrders
      ON DUPLICATE KEY UPDATE lastValue = lastValue
    `);
    await tx.execute(sql`
      INSERT INTO documentCounters (counterKey, lastValue)
      SELECT 'unified_transaction', 100000 + COALESCE(MAX(id), 0)
      FROM onlineOrders
      ON DUPLICATE KEY UPDATE lastValue = GREATEST(lastValue, VALUES(lastValue))
    `);
  }
  return String(await nextCounterValue(tx, "unified_transaction"));
}

export { formatDocumentNumber } from "../../shared/documentNumber";

/**
 * بضاعة الأمانة (ش٢): رقم سند حركة أمانة يوميّ لكل فرع — CSN-{branchId}-{YYYYMMDD}-{seq}.
 * حجز ذرّي عبر عدّاد documentCounters لمنع سباقات التزامن.
 */
export async function nextConsignmentNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `CSN-${branchId}-${ymd}-`;
  const counterKey = `consign_note_${branchId}_${ymd}`;
  const seq = await nextCounterValue(tx, counterKey);
  return prefix + String(seq).padStart(5, "0");
}
