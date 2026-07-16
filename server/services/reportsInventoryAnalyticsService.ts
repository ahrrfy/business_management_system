// خدمة تحليلات المخزون (للقراءة فقط) — تُغذّي مركز التقارير بتقريرين:
//   ١) بطاقة الصنف (Kardex): حركات متغيّر واحد زمنياً مع رصيد متحرّك.
//   ٢) تحليل ABC: تصنيف المنتجات حسب الإيراد (باريتو) إلى فئات A/B/C.
//
// المصدر: جدول حركات المخزون inventoryMovements (الكمية بالوحدة الأساس، موجبة دائماً؛ الاتجاه من النوع)
// + جدول بنود الفواتير invoiceItems ← invoices للإيراد. لا تخمين — أسماء الأعمدة من المخطّط الحرفي:
//   • inventoryMovements: variantId, branchId, movementType, quantity, referenceType, referenceId, createdAt.
//   • invoices: status ← اسم عمود DB **invoiceStatus**، invoiceDate (عمود DATE/timestamp).
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { signedMoveQty } from "./inventoryService";
import { money, toDbMoney } from "./money";

/** فكّ نتيجة mysql2 (الصفوف في الفهرس 0). */
function rowsOf(res: unknown): any[] {
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

/* ============================ بطاقة الصنف (Kardex) ============================ */

// INV-001: إشارة الحركات (بما فيها ADJUST من علامة النص) وُحِّدت في inventoryService.signedMoveQty
// — مصدر واحد يَستعمله الكاردكس والجرد ⇒ لا تَباعُد في حساب الرصيد.

export interface ItemLedgerRow {
  id: number;
  date: string; // YYYY-MM-DD
  type: string; // movementType الخام (IN/OUT/…)
  signedQty: number; // الكمية بإشارتها (الوحدة الأساس)
  balance: number; // الرصيد المتحرّك التراكمي بعد هذه الحركة
  reference: string | null; // "referenceType #referenceId" أو null
}

export interface ItemLedgerResult {
  variant: { variantId: number; productName: string; label: string; sku: string } | null;
  rows: ItemLedgerRow[];
  openingBalance: number; // الرصيد قبل أول حركة في النطاق (= مجموع الحركات قبل from)
  closingBalance: number; // الرصيد بعد آخر حركة **في النطاق كلّه** (لا آخر صفحة معروضة)
  total: number; // عدد حركات النطاق كلّه (للترقيم) — قد يفوق rows.length
}

/**
 * صافي الحركات المُوقَّع لمجموعة صفوف — بحمولة صغيرة.
 * الأنواع الموجَّهة إشارتها معروفة بـSQL (IN/RETURN/TRANSFER_IN=+، OUT/TRANSFER_OUT=−) فتُجمَع في
 * القاعدة؛ وADJUST وحده يُخزَّن مطلقاً واتجاهه في نصّ الملاحظة (INV-001) ⇒ صفوفه فقط تُسحَب
 * وتُجمَع بـsignedMoveQty. المجموع مطابق عددياً للجمع الكامل في JS.
 * `scope` = جملة FROM كاملة تُسمّي الصفوف باسم im (جدولاً مباشرةً أو استعلاماً فرعياً محدوداً).
 */
async function netSignedOver(db: NonNullable<ReturnType<typeof getDb>>, scope: ReturnType<typeof sql>) {
  const directionalRow = rowsOf(
    await db.execute(sql`
      SELECT COALESCE(SUM(CASE
        WHEN im.movementType IN ('IN','RETURN','TRANSFER_IN') THEN im.quantity
        WHEN im.movementType IN ('OUT','TRANSFER_OUT')        THEN -im.quantity
        ELSE 0 END), 0) AS signedQty
      FROM ${scope}
      WHERE im.movementType <> 'ADJUST'
    `),
  )[0];
  let net = Number(directionalRow?.signedQty ?? 0);

  const adjustRows = rowsOf(
    await db.execute(sql`
      SELECT im.movementType AS movementType, im.quantity AS quantity, im.notes AS notes
      FROM ${scope}
      WHERE im.movementType = 'ADJUST'
    `),
  );
  for (const r of adjustRows) {
    net += signedMoveQty(String(r.movementType), Number(r.quantity ?? 0), r.notes != null ? String(r.notes) : null);
  }
  return net;
}

/**
 * بطاقة الصنف لمتغيّر واحد — حركاته زمنياً مع رصيد متحرّك.
 * - branchId اختياري ⇒ بلا تحديده يُجمَع عبر كل الفروع (بطاقة على مستوى الشركة).
 * - from/to (YYYY-MM-DD) اختياريان ⇒ يُرشِّحان النطاق المعروض. الرصيد الافتتاحي = صافي كل حركة
 *   **قبل** from (لتظلّ البطاقة متّسقة حين تُحدَّد فترة)؛ بلا from يكون الافتتاحي صفراً.
 * - الترتيب createdAt ASC ثم id ASC (id يفكّ تعادل نفس الطابع الزمني).
 * - **مُرقَّم** (limit/offset): كان يُعيد كل حركات المتغيّر مدى الحياة في حمولة واحدة (صنف قديم
 *   كثير الحركة = عشرات الآلاف من الصفوف ⇒ تجمّد الشاشة). الرصيد المتحرّك تراكميّ فلا يصحّ قصّه
 *   بـLIMIT وحده: رصيد أول صفّ في صفحةٍ ما يعتمد كلَّ ما قبله ⇒ نحسب «افتتاحيّ الصفحة» =
 *   الافتتاحيّ + صافي صفوف النطاق السابقة لها (netSignedOver على استعلام فرعيّ محدود بـoffset).
 *   وopeningBalance/closingBalance/total تبقى مقاييسَ **للنطاق كلّه** لا للصفحة (وإلا كذبت البطاقة).
 */
export async function getItemLedger(opts: {
  variantId: number;
  branchId?: number;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}): Promise<ItemLedgerResult> {
  const db = getDb();
  const empty: ItemLedgerResult = { variant: null, rows: [], openingBalance: 0, closingBalance: 0, total: 0 };
  if (!db) return empty;

  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);

  // ترويسة المتغيّر (الاسم + وصف مركّب لون/قياس + sku).
  const head = rowsOf(
    await db.execute(sql`
      SELECT
        pv.id AS variantId,
        p.name AS productName,
        pv.variantName AS variantName,
        pv.color AS color,
        pv.size AS size,
        pv.sku AS sku
      FROM productVariants pv
      JOIN products p ON p.id = pv.productId
      WHERE pv.id = ${opts.variantId}
      LIMIT 1
    `),
  )[0];
  if (!head) return empty;
  const detail = [head.variantName, head.color, head.size].filter(Boolean).join(" / ");
  const label = detail ? `${head.productName} — ${detail}` : head.productName;
  const variant = {
    variantId: Number(head.variantId),
    productName: String(head.productName),
    label,
    sku: String(head.sku ?? ""),
  };

  const branchCond = opts.branchId ? sql`AND im0.branchId = ${opts.branchId}` : sql``;
  const dateFrom = opts.from ? sql`AND DATE(im0.createdAt) >= ${opts.from}` : sql``;
  const dateTo = opts.to ? sql`AND DATE(im0.createdAt) <= ${opts.to}` : sql``;

  /** الحقول التي يحتاجها الجمع المُوقَّع فقط — حمولة صغيرة مهما كبر النطاق. */
  const signFields = sql`im0.movementType AS movementType, im0.quantity AS quantity, im0.notes AS notes`;

  // الرصيد الافتتاحي: صافي كل الحركات قبل from (DATE(createdAt) < from). بلا from ⇒ صفر.
  // REP-09: الجمع هجين (موجَّه بـSQL + ADJUST بـJS) عبر netSignedOver — انظر تعليقه.
  const openingBalance = opts.from
    ? await netSignedOver(
        db,
        sql`(SELECT ${signFields} FROM inventoryMovements im0
             WHERE im0.variantId = ${opts.variantId} AND DATE(im0.createdAt) < ${opts.from} ${branchCond}) im`,
      )
    : 0;

  // نطاق العرض (بين from وto) — يُعاد استعماله للعدّ والإغلاق والصفحة.
  const rangeWhere = sql`WHERE im0.variantId = ${opts.variantId} ${branchCond} ${dateFrom} ${dateTo}`;

  // إجمالي حركات النطاق (للترقيم) — COUNT لا يَسحب صفوفاً.
  const totalRow = rowsOf(
    await db.execute(sql`SELECT COUNT(*) AS n FROM inventoryMovements im0 ${rangeWhere}`),
  )[0];
  const total = Number(totalRow?.n ?? 0);

  // الرصيد الختامي = افتتاحيّ النطاق + صافي النطاق كلّه (مستقلّ عن الصفحة المعروضة).
  const closingBalance =
    openingBalance +
    (await netSignedOver(db, sql`(SELECT ${signFields} FROM inventoryMovements im0 ${rangeWhere}) im`));

  // افتتاحيّ الصفحة = افتتاحيّ النطاق + صافي صفوف النطاق **السابقة** لهذه الصفحة.
  // نستعمل استعلاماً فرعياً بنفس ترتيب الصفحة محدوداً بـoffset (لا مقارنة tuple على createdAt —
  // تفادياً لفخّ المناطق الزمنية في mysql2 عند إعادة تمرير Date وسيطاً).
  const pageOpening =
    offset > 0
      ? openingBalance +
        (await netSignedOver(
          db,
          sql`(SELECT ${signFields} FROM inventoryMovements im0 ${rangeWhere}
               ORDER BY im0.createdAt ASC, im0.id ASC LIMIT ${offset}) im`,
        ))
      : openingBalance;

  // صفوف الصفحة المعروضة وحدها.
  const moveRows = rowsOf(
    await db.execute(sql`
      SELECT
        im0.id AS id,
        DATE_FORMAT(im0.createdAt, '%Y-%m-%d') AS date,
        im0.movementType AS movementType,
        im0.quantity AS quantity,
        im0.notes AS notes,
        im0.referenceType AS referenceType,
        im0.referenceId AS referenceId
      FROM inventoryMovements im0
      ${rangeWhere}
      ORDER BY im0.createdAt ASC, im0.id ASC
      LIMIT ${limit} OFFSET ${offset}
    `),
  );

  let running = pageOpening;
  const rows: ItemLedgerRow[] = moveRows.map((r) => {
    const signed = signedMoveQty(String(r.movementType), Number(r.quantity ?? 0), r.notes != null ? String(r.notes) : null);
    running += signed;
    const refType = r.referenceType ? String(r.referenceType) : null;
    const refId = r.referenceId == null ? null : Number(r.referenceId);
    const reference = refType ? (refId ? `${refType} #${refId}` : refType) : null;
    return {
      id: Number(r.id),
      date: String(r.date),
      type: String(r.movementType),
      signedQty: signed,
      balance: running,
      reference,
    };
  });

  return {
    variant,
    rows,
    openingBalance,
    closingBalance,
    total,
  };
}

/* ============================ تحليل ABC (باريتو حسب الإيراد) ============================ */

export interface AbcRow {
  productId: number;
  productName: string;
  revenue: string; // إيراد المنتج في الفترة (نصّ مالي 2dp)
  cumulativePct: string; // النسبة التراكمية من إجمالي الإيراد (نصّ بمنزلتين)
  class: "A" | "B" | "C";
}

export interface AbcResult {
  rows: AbcRow[];
  totals: { revenue: string; aCount: number; bCount: number; cCount: number };
}

/**
 * تحليل ABC — يصنّف المنتجات حسب مساهمتها في الإيراد (مبدأ باريتو):
 *   - يُجمَع إيراد كل منتج من بنود الفواتير (مجموع invoiceItems.total) عبر invoices
 *     ضمن [from,to] (DATE(invoiceDate) BETWEEN) باستثناء الفواتير الملغاة/المرتجعة بالكامل.
 *   - يُرتَّب تنازلياً، تُحسب النسبة التراكمية من الإجمالي.
 *   - الفئة A: التراكمي ≤ 80٪ | B: ≤ 95٪ | C: الباقي.
 *   - الإيراد بالإجمالي (total البند) — يطابق منطق التقارير القائمة (لا يُطرَح خصم/يُضاف ضريبة هنا).
 *
 * ملاحظة: status على invoices اسمُه في DB **invoiceStatus** (راجع المخطّط) ⇒ يُستعمل الاسم الحرفي في SQL الخام.
 */
export async function getAbcAnalysis(opts: {
  from: string;
  to: string;
  branchId?: number;
}): Promise<AbcResult> {
  const db = getDb();
  const empty: AbcResult = { rows: [], totals: { revenue: "0.00", aCount: 0, bCount: 0, cCount: 0 } };
  if (!db) return empty;

  const branchCond = opts.branchId ? sql`AND i.branchId = ${opts.branchId}` : sql``;

  // تجميع الإيراد لكل منتج. invoiceStatus هو اسم عمود الحالة في DB.
  const aggRows = rowsOf(
    await db.execute(sql`
      SELECT
        p.id AS productId,
        p.name AS productName,
        CAST(COALESCE(SUM(ii.total), 0) AS CHAR) AS revenue
      FROM invoiceItems ii
      JOIN invoices i ON i.id = ii.invoiceId
      JOIN productVariants pv ON pv.id = ii.variantId
      JOIN products p ON p.id = pv.productId
      WHERE i.invoiceStatus NOT IN ('CANCELLED', 'RETURNED')
        AND DATE(i.invoiceDate) BETWEEN ${opts.from} AND ${opts.to}
        ${branchCond}
      GROUP BY p.id, p.name
      HAVING SUM(ii.total) > 0
      ORDER BY SUM(ii.total) DESC
    `),
  );

  // §٥: المال عبر decimal.js (الإيراد قيمة مالية). النسبة التراكمية تُحسَب بـdecimal أيضاً (REP-08)
  // لإزالة اضطراب الفاصلة العائمة عند حدّي ٨٠/٩٥ (تصنيف A/B/C على حافّة قد يختلف بفعل float).
  const totalRevenue = aggRows.reduce((acc, r) => acc.add(money(r.revenue ?? 0)), money(0));

  let cumulative = money(0);
  let aCount = 0;
  let bCount = 0;
  let cCount = 0;
  const rows: AbcRow[] = aggRows.map((r) => {
    const rev = money(r.revenue ?? 0);
    cumulative = cumulative.add(rev);
    const cumPct = totalRevenue.isZero() ? money(0) : money(cumulative).div(totalRevenue).mul(100);
    let cls: "A" | "B" | "C";
    if (cumPct.lte(80)) cls = "A";
    else if (cumPct.lte(95)) cls = "B";
    else cls = "C";
    if (cls === "A") aCount++;
    else if (cls === "B") bCount++;
    else cCount++;
    return {
      productId: Number(r.productId),
      productName: String(r.productName),
      revenue: toDbMoney(rev),
      cumulativePct: cumPct.toFixed(2),
      class: cls,
    };
  });

  return {
    rows,
    totals: {
      revenue: toDbMoney(totalRevenue),
      aCount,
      bCount,
      cCount,
    },
  };
}
