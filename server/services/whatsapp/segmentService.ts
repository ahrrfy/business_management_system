/**
 * باني شرائح البث التسويقي (S5، T5.1) — يحلّ معايير `SegmentCriteria` إلى جمهور مستهدَف من
 * `customers` بمقاييس RFM حيّة محسوبة من `invoices` وقت الاستعلام (لا جدول مُلخَّص مُخزَّن —
 * الرصيد/تاريخ الفواتير يتغيّران باستمرار، والحملات نادرة نسبياً فالحساب الحيّ مقبول أداءً).
 *
 * **القاعدة الحاكمة — استبعاد حتميّ دائم بلا استثناء واحد:**
 *  1. `waConsent = 'OPTED_OUT'` — عميل رفض التسويق صراحةً (أو التقط كلمة إلغاء اشتراك تلقائياً،
 *     `contactsConsent`) يُستبعَد من **كل** استعلام شريحة، بلا قابلية تجاوز عبر أي معيار آخر.
 *  2. هاتف فارغ أو غير صالح (أقل من ٧ أرقام بعد تجريد غير الأرقام) — نفس عتبة `phoneMatchSuffix`
 *     (`server/lib/similarMatch.ts`) المُستعمَلة في كاشف تشابه الأطراف وربط مُرسِل واتساب، لاتّساق
 *     معنى «رقم صالح» عبر النظام.
 *  3. `isActive = false` — عميل مُعطَّل لا يستقبل تسويقاً (قرار هندسي محلّي، غير مذكور صراحةً في
 *     التكليف؛ منطقي بما أن تعطيل العميل يعني إيقاف كل تفاعل نشط معه).
 *
 * **`requireOptIn` (اختياري، افتراضي `false`):** الوثيقة الحاكمة `docs/whatsapp-hub-design-2026-07-23.md`
 * §٢-٣/§٣-٦ تنصّ على أن سياسة Meta نفسها تشترط `OPTED_IN` صراحةً لأي قالب Marketing — أي أن
 * الوضع الصارم يجب أن يكون الافتراضي فعلياً وقت **الإرسال الحقيقي**. تكليف هذه الشريحة (T5.1)
 * ينصّ صراحةً على افتراضٍ أكثر تساهلاً (يشمل `UNKNOWN`) لمرحلة **معاينة/بناء الشريحة** فقط — لا
 * إرسال فعلي يحدث في T5.1 (التقطير الفعلي عبر waOutbox مؤجَّل إلى T5.2). **تعارض موثَّق بين
 * الوثيقتين — يجب حسمه صراحةً قبل تفعيل الإرسال الفعلي في T5.2/T5.3**: إمّا بجعل الإطلاق الفعلي
 * يفرض `requireOptIn=true` دائماً بصرف النظر عن معايير المُنشئ، أو بجعله الافتراضي في واجهة T5.3.
 * راجع التقرير الختامي لهذه الشريحة لتفصيل القرار المطلوب من المالك/القائد.
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { customers, invoices } from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { requireDb } from "../tx";

type DbOrTx = DB | Tx;

export type CustomerTypeValue = "فرد" | "تاجر" | "مؤسسة" | "شركة" | "حكومي";
export type PriceTierValue = "RETAIL" | "WHOLESALE" | "GOVERNMENT";
export type RfmPreset = "VIP" | "AT_RISK" | "DORMANT" | "NEW";

/**
 * معايير RFM حرّة (بلا `preset`) أو مُعرَّفة سلفاً (`preset`) — قابلة للجمع مع بقية `SegmentCriteria`
 * (نوع العميل/فئة السعر/الرصيد/الفرع) دائماً بعملية AND.
 *
 * `recencyDays` معناها الوحيد هنا: **«اشترى مرّة على الأقل خلال آخر N يوماً»** (recency ≤ N) — هذا
 * هو التفسير الحرفي الوحيد القابل للتنفيذ دون حقل اتجاه إضافي لم يطلبه التكليف. الخمول («أقدم من
 * X يوماً») يُعبَّر عنه حصراً عبر `preset: 'AT_RISK'|'DORMANT'` (عتباتهما ثوابت مسمّاة أدناه) — لا
 * تستعمل `recencyDays` لهذا الغرض، فهو لا يفعل ذلك.
 */
export interface RfmCriteria {
  /** آخر شراء خلال N يوماً (recency ≤ N). للخمول استعمل preset بدلاً من هذا الحقل — راجع التعليق أعلاه. */
  recencyDays?: number;
  /** عدد الفواتير غير الملغاة/المرتجعة (frequency) ≥ هذه القيمة. */
  minInvoices?: number;
  /** إجمالي الشراء (monetary) ≥ هذه القيمة — سلسلة عشرية (decimal). */
  minSpend?: string;
  /** رتبة جاهزة (تُغني عن التوليف اليدوي أعلاه؛ تُجمَع بـAND مع أي حقل آخر مُمرَّر معها). */
  preset?: RfmPreset;
}

export interface SegmentCriteria {
  /** قيم `customers.customerType` (فرد/تاجر/مؤسسة/شركة/حكومي) — IN، فارغ/محذوف = بلا فلترة. */
  customerTypes?: string[];
  /** قيم `customers.defaultPriceTier` (RETAIL/WHOLESALE/GOVERNMENT) — IN. */
  priceTiers?: string[];
  /** عزل الفرع: يُطبَّق على `invoices.branchId` (شرط انضمام RFM)، لا على `customers` (لا عمود
   *  فرع للعميل — الشريحة تبقى عامة عبر العملاء، فقط نشاطهم الشرائي يُقاس ضمن هذا الفرع). */
  branchId?: number | null;
  /** `customers.currentBalance` ≥ هذه القيمة (سلسلة decimal). */
  balanceMin?: string;
  /** `customers.currentBalance` ≤ هذه القيمة (سلسلة decimal). */
  balanceMax?: string;
  rfm?: RfmCriteria;
  /** true ⇒ يستبعد أيضاً waConsent='UNKNOWN' (يبقى OPTED_IN فقط). افتراضياً false — راجع تعليق
   *  الرأس أعلاه بخصوص التعارض الموثَّق مع سياسة Meta الفعلية وقت الإرسال. */
  requireOptIn?: boolean;
}

// ── ثوابت رتب RFM (presets) — مركزية وقابلة للتعديل؛ اقتراحية بقرار المالك لاحقاً ──────────────
export const RFM_VIP_MIN_FREQUENCY = 10;
/** د.ع — عتبة إجمالي شراء تُصنِّف العميل VIP بديلاً عن عتبة التكرار (أيّهما تحقّق). تقديرية. */
export const RFM_VIP_MIN_SPEND = "500000";
export const RFM_AT_RISK_MIN_FREQUENCY = 3;
export const RFM_AT_RISK_RECENCY_DAYS = 60;
export const RFM_DORMANT_RECENCY_DAYS = 180;
export const RFM_NEW_WITHIN_DAYS = 30;
/** أدنى عدد أرقام صالحة للهاتف (يطرح غير الأرقام أولاً) — يطابق عتبة `phoneMatchSuffix`. */
const MIN_PHONE_DIGITS = 7;

export interface SegmentRecipient {
  customerId: number;
  phoneE164: string;
  name: string;
}

// ── بناء شروط WHERE/JOIN/HAVING المشتركة بين count وlist (يضمن count===list.length) ──────────

function baseWhereConditions(criteria: SegmentCriteria): SQL[] {
  const conds: SQL[] = [
    // (١) استبعاد حتميّ دائم — لا استثناء (راجع رأس الملف).
    sql`${customers.waConsent} != 'OPTED_OUT'`,
    // (٢) هاتف صالح: غير فارغ وطوله بعد تجريد غير الأرقام ≥ MIN_PHONE_DIGITS. دالة على كل صفّ ⇒
    // مسح كامل جدول customers بلا فهرس (نفس المفاضلة الموثَّقة في contactResolver.ts) — مقبول هنا
    // لأن هذا استعلام معاينة/إطلاق حملة نادر التكرار على حجم بيانات محدود، لا مسار ساخن كالويبهوك.
    sql`${customers.phone} IS NOT NULL AND CHAR_LENGTH(REGEXP_REPLACE(${customers.phone}, '[^0-9]', '')) >= ${MIN_PHONE_DIGITS}`,
    // (٣) عميل مُعطَّل لا يستقبل تسويقاً (قرار هندسي محلّي — راجع رأس الملف).
    eq(customers.isActive, true),
  ];
  if (criteria.requireOptIn) conds.push(eq(customers.waConsent, "OPTED_IN"));
  if (criteria.customerTypes?.length) conds.push(inArray(customers.customerType, criteria.customerTypes as CustomerTypeValue[]));
  if (criteria.priceTiers?.length) conds.push(inArray(customers.defaultPriceTier, criteria.priceTiers as PriceTierValue[]));
  if (criteria.balanceMin != null) conds.push(sql`${customers.currentBalance} >= ${criteria.balanceMin}`);
  if (criteria.balanceMax != null) conds.push(sql`${customers.currentBalance} <= ${criteria.balanceMax}`);
  return conds;
}

/** شرط JOIN الفواتير المُساهِمة في RFM: غير ملغاة/مرتجعة، ومُقيَّدة بالفرع إن طُلب. */
function invoiceJoinCondition(criteria: SegmentCriteria) {
  const parts = [
    eq(invoices.customerId, customers.id),
    sql`${invoices.status} NOT IN ('CANCELLED','RETURNED')`,
  ];
  if (criteria.branchId != null) parts.push(eq(invoices.branchId, criteria.branchId));
  return and(...parts);
}

function presetHaving(preset: RfmPreset): SQL {
  switch (preset) {
    case "VIP":
      // تكرارٌ عالٍ أو إنفاقٌ كبير (أيّهما) — VIP لا يشترط الاثنين معاً.
      return sql`(COUNT(${invoices.id}) >= ${RFM_VIP_MIN_FREQUENCY} OR COALESCE(SUM(${invoices.total}), 0) >= ${RFM_VIP_MIN_SPEND})`;
    case "AT_RISK":
      // كان نشطاً (تكرار كافٍ) لكن لم يشترِ مؤخراً — عكس ذلك: أحدث فاتورة أقدم من العتبة.
      return sql`(COUNT(${invoices.id}) >= ${RFM_AT_RISK_MIN_FREQUENCY} AND MAX(${invoices.invoiceDate}) < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${RFM_AT_RISK_RECENCY_DAYS} DAY))`;
    case "DORMANT":
      // خامل: اشترى مرّة واحدة على الأقل (وإلا فهو «لم يشترِ قط» لا «توقّف عن الشراء») وأحدث
      // فاتورة أقدم من عتبة الخمول. (قرار توثيقي: عميل بلا أي فاتورة إطلاقاً لا يُعدّ DORMANT.)
      return sql`(COUNT(${invoices.id}) >= 1 AND MAX(${invoices.invoiceDate}) < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${RFM_DORMANT_RECENCY_DAYS} DAY))`;
    case "NEW":
      // أول شراء خلال النافذة — MIN(invoiceDate) يستبعد تلقائياً من لا فاتورة له (MIN=NULL).
      return sql`MIN(${invoices.invoiceDate}) >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${RFM_NEW_WITHIN_DAYS} DAY)`;
  }
}

function buildHavingCondition(rfm: RfmCriteria | undefined): SQL {
  if (!rfm) return sql`1=1`;
  const parts: SQL[] = [];
  if (rfm.minInvoices != null) parts.push(sql`COUNT(${invoices.id}) >= ${rfm.minInvoices}`);
  if (rfm.minSpend != null) parts.push(sql`COALESCE(SUM(${invoices.total}), 0) >= ${rfm.minSpend}`);
  if (rfm.recencyDays != null) parts.push(sql`MAX(${invoices.invoiceDate}) >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${rfm.recencyDays} DAY)`);
  if (rfm.preset) parts.push(presetHaving(rfm.preset));
  if (!parts.length) return sql`1=1`;
  return and(...parts) as SQL;
}

// ── الواجهة العامة: count (رخيص، للمعاينة) وlist (للإدراج وقت الإطلاق/التقطير) ──────────────────

/** عدد العملاء المطابقين للشريحة — بلا جلب صفوف (COUNT فقط، رخيص للمعاينة الحيّة). */
export async function resolveSegmentCount(criteria: SegmentCriteria, runner: DbOrTx = requireDb()): Promise<number> {
  const having = buildHavingCondition(criteria.rfm);
  const sub = runner
    .select({ id: customers.id })
    .from(customers)
    .leftJoin(invoices, invoiceJoinCondition(criteria))
    .where(and(...baseWhereConditions(criteria)))
    .groupBy(customers.id)
    .having(having)
    .as("seg");
  const rows = await runner.select({ cnt: sql<number>`COUNT(*)` }).from(sub);
  return Number(rows[0]?.cnt ?? 0);
}

/** قائمة المستلمين المطابقين — لإدراج `waBroadcastRecipients` وقت التقطير (T5.2) أو المعاينة
 *  التفصيلية. `limit`/`offset` بسيطان (لا keyset — أعداد الجمهور المتوقّعة هنا آلاف لا ملايين؛
 *  التقطير الفعلي في T5.2 يستهلكها دفعة-دفعة فلا حاجة لترقيم متقدّم في هذه الشريحة). */
export async function resolveSegmentList(
  criteria: SegmentCriteria,
  opts: { limit?: number; offset?: number } = {},
  runner: DbOrTx = requireDb(),
): Promise<SegmentRecipient[]> {
  const having = buildHavingCondition(criteria.rfm);
  const limit = Math.max(1, Math.min(opts.limit ?? 5000, 20000));
  const offset = Math.max(0, opts.offset ?? 0);
  const rows = await runner
    .select({ customerId: customers.id, phoneE164: customers.phone, name: customers.name })
    .from(customers)
    .leftJoin(invoices, invoiceJoinCondition(criteria))
    .where(and(...baseWhereConditions(criteria)))
    .groupBy(customers.id, customers.phone, customers.name)
    .having(having)
    .orderBy(customers.id)
    .limit(limit)
    .offset(offset);
  return rows.map((r) => ({ customerId: Number(r.customerId), phoneE164: String(r.phoneE164), name: r.name }));
}
