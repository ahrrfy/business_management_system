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
  closingBalance: number; // الرصيد بعد آخر حركة معروضة
}

/**
 * بطاقة الصنف لمتغيّر واحد — حركاته زمنياً مع رصيد متحرّك.
 * - branchId اختياري ⇒ بلا تحديده يُجمَع عبر كل الفروع (بطاقة على مستوى الشركة).
 * - from/to (YYYY-MM-DD) اختياريان ⇒ يُرشِّحان النطاق المعروض. الرصيد الافتتاحي = صافي كل حركة
 *   **قبل** from (لتظلّ البطاقة متّسقة حين تُحدَّد فترة)؛ بلا from يكون الافتتاحي صفراً.
 * - الترتيب createdAt ASC ثم id ASC (id يفكّ تعادل نفس الطابع الزمني).
 */
export async function getItemLedger(opts: {
  variantId: number;
  branchId?: number;
  from?: string;
  to?: string;
}): Promise<ItemLedgerResult> {
  const db = getDb();
  const empty: ItemLedgerResult = { variant: null, rows: [], openingBalance: 0, closingBalance: 0 };
  if (!db) return empty;

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

  const branchCond = opts.branchId ? sql`AND im.branchId = ${opts.branchId}` : sql``;

  // الرصيد الافتتاحي: صافي كل الحركات قبل from (DATE(createdAt) < from).
  // REP-09: لتقليل الحمولة لا نَسحب كل الحركات السابقة إلى JS. الإشارة معروفة بـSQL لكل الأنواع
  // الموجَّهة (IN/RETURN/TRANSFER_IN=+، OUT/TRANSFER_OUT=−) ⇒ نجمعها مُوقَّعةً في القاعدة. ADJUST
  // وحده يحتاج إشارةً من نصّ الملاحظة (signedMoveQty/«(فرق ±D)») ⇒ نَسحب صفوفه فقط ونجمعها في JS.
  // المجموع مطابق عددياً للجمع الكامل في JS (الكمية بالوحدة الأساس عدد صحيح؛ الأنواع غير المعروفة = 0
  // في كلا المسارين). [⚠️ صفوف ADJUST السابقة لا تزال تُسحَب كاملةً — عادةً قليلة جداً.]
  let openingBalance = 0;
  if (opts.from) {
    const directionalRow = rowsOf(
      await db.execute(sql`
        SELECT COALESCE(SUM(CASE
          WHEN im.movementType IN ('IN','RETURN','TRANSFER_IN') THEN im.quantity
          WHEN im.movementType IN ('OUT','TRANSFER_OUT')        THEN -im.quantity
          ELSE 0 END), 0) AS signedQty
        FROM inventoryMovements im
        WHERE im.variantId = ${opts.variantId}
          AND im.movementType <> 'ADJUST'
          AND DATE(im.createdAt) < ${opts.from}
          ${branchCond}
      `),
    )[0];
    openingBalance += Number(directionalRow?.signedQty ?? 0);

    const adjustRows = rowsOf(
      await db.execute(sql`
        SELECT im.movementType AS movementType, im.quantity AS quantity, im.notes AS notes
        FROM inventoryMovements im
        WHERE im.variantId = ${opts.variantId}
          AND im.movementType = 'ADJUST'
          AND DATE(im.createdAt) < ${opts.from}
          ${branchCond}
      `),
    );
    for (const r of adjustRows) {
      // INV-001: ADJUST يُخزَّن مطلقاً والاتجاه في النص ⇒ نستعيد إشارته من «(فرق ±D)» عبر signedMoveQty.
      openingBalance += signedMoveQty(String(r.movementType), Number(r.quantity ?? 0), r.notes != null ? String(r.notes) : null);
    }
  }

  // الحركات في النطاق المعروض.
  const dateFrom = opts.from ? sql`AND DATE(im.createdAt) >= ${opts.from}` : sql``;
  const dateTo = opts.to ? sql`AND DATE(im.createdAt) <= ${opts.to}` : sql``;
  const moveRows = rowsOf(
    await db.execute(sql`
      SELECT
        im.id AS id,
        DATE_FORMAT(im.createdAt, '%Y-%m-%d') AS date,
        im.movementType AS movementType,
        im.quantity AS quantity,
        im.notes AS notes,
        im.referenceType AS referenceType,
        im.referenceId AS referenceId
      FROM inventoryMovements im
      WHERE im.variantId = ${opts.variantId}
        ${branchCond}
        ${dateFrom}
        ${dateTo}
      ORDER BY im.createdAt ASC, im.id ASC
    `),
  );

  let running = openingBalance;
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
    closingBalance: running,
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
