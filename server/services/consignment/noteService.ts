// بضاعة الأمانة — ش٢: خدمة سندات الإيداع/السحب/الاستبدال. راجع docs/consignment-design-2026-07-20.md §٢-أ/د.
// إيداع/سحب/استبدال = حركات مخزون بصفر أثر ماليّ (الالتزام يُلتقَط لحظة البيع في ش٣). ذرّيّ + idempotent.
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { isDupEntry } from "@shared/errorMap.ar";
import { consignmentNoteLines, consignmentNotes, productUnits, productVariants, products, suppliers } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { applyMovement, convertToBaseQuantity } from "../inventoryService";
import { money, round2 } from "../money";
import { nextConsignmentNumber } from "../numbering";
import { withTx, type Actor } from "../tx";

export type ConsignmentNoteType = "DEPOSIT" | "WITHDRAW" | "EXCHANGE";
export interface ConsignmentNoteLineInput {
  lineDirection: "IN" | "OUT";
  variantId: number;
  productUnitId: number;
  quantity: string;
  notes?: string | null;
}
export interface CreateConsignmentNoteInput {
  noteType: ConsignmentNoteType;
  consignorId: number;
  branchId: number;
  clientRequestId?: string | null;
  notes?: string | null;
  attachmentUrl?: string | null;
  lines: ConsignmentNoteLineInput[];
}

const norm = (s: string | null | undefined): string | null => {
  const t = s?.trim();
  return t || null;
};

/**
 * إنشاء سند حركة أمانة (ذرّيّ + idempotent + قفل المودِع FOR UPDATE).
 * الحراس: المودِع CONSIGNOR نشِط؛ كل سطر صنفه isConsignment ومودِعه = مودِع السند؛ اتجاه الأسطر يطابق
 * نوع السند؛ مرفق صورة السند الموقَّع إلزاميّ للسحب/الاستبدال. الحركات بترتيب variantId (منع deadlock).
 */
export async function createConsignmentNote(input: CreateConsignmentNoteInput, actor: Actor) {
  const clientRequestId = norm(input.clientRequestId);
  try {
    return await createConsignmentNoteTx(input, clientRequestId, actor);
  } catch (e) {
    // سباق متزامن على نفس المفتاح: الفائز ملتزم ⇒ اقرأه (نمط createSupplier).
    if (clientRequestId && isDupEntry(e)) {
      const db = getDb();
      const prior = db
        ? (await db.select({ id: consignmentNotes.id }).from(consignmentNotes)
            .where(eq(consignmentNotes.clientRequestId, clientRequestId)).limit(1))[0]
        : undefined;
      if (prior) return { noteId: prior.id, idempotentReplay: true };
    }
    throw e;
  }
}

async function createConsignmentNoteTx(input: CreateConsignmentNoteInput, clientRequestId: string | null, actor: Actor) {
  if (!input.lines.length) throw new TRPCError({ code: "BAD_REQUEST", message: "السند بلا أصناف" });

  // اتساق اتجاه الأسطر مع نوع السند.
  const dirs = new Set(input.lines.map((l) => l.lineDirection));
  if (input.noteType === "DEPOSIT" && (dirs.size !== 1 || !dirs.has("IN")))
    throw new TRPCError({ code: "BAD_REQUEST", message: "سند الإيداع: كل الأسطر إيداع (IN)" });
  if (input.noteType === "WITHDRAW" && (dirs.size !== 1 || !dirs.has("OUT")))
    throw new TRPCError({ code: "BAD_REQUEST", message: "سند السحب: كل الأسطر سحب (OUT)" });
  if (input.noteType === "EXCHANGE" && !(dirs.has("IN") && dirs.has("OUT")))
    throw new TRPCError({ code: "BAD_REQUEST", message: "سند الاستبدال: يلزمه سحبٌ وإيداعٌ معاً" });

  // مرفق صورة السند الموقَّع إلزاميّ للسحب/الاستبدال (لا عتبة — §٥-أ الضابط التعويضيّ).
  if (input.noteType !== "DEPOSIT" && !norm(input.attachmentUrl))
    throw new TRPCError({ code: "BAD_REQUEST", message: "سند السحب/الاستبدال يلزمه إرفاق صورة السند الموقَّع" });

  return withTx(async (tx) => {
    // idempotency: إعادة إرسال بنفس المفتاح ⇒ أعد السند القائم.
    if (clientRequestId) {
      const prior = (await tx.select({ id: consignmentNotes.id }).from(consignmentNotes)
        .where(eq(consignmentNotes.clientRequestId, clientRequestId)).limit(1))[0];
      if (prior) return { noteId: prior.id, idempotentReplay: true };
    }

    // قفل المودِع FOR UPDATE (يتسلسل مع التعطيل/تغيير الربط — منع check-then-act).
    const [consignor] = await tx.select({ id: suppliers.id, kind: suppliers.supplierKind, active: suppliers.isActive })
      .from(suppliers).where(eq(suppliers.id, input.consignorId)).for("update").limit(1);
    if (!consignor) throw new TRPCError({ code: "NOT_FOUND", message: "المودِع غير موجود" });
    if (consignor.kind !== "CONSIGNOR") throw new TRPCError({ code: "BAD_REQUEST", message: "الطرف ليس مودِع أمانة" });
    if (!consignor.active) throw new TRPCError({ code: "BAD_REQUEST", message: "المودِع معطَّل" });

    // كل صنف: isConsignment + مودِعه = مودِع السند (منع خلط بضاعة مودِعين). + حصة الأساس للقطة.
    const variantIds = Array.from(new Set(input.lines.map((l) => l.variantId)));
    const vrows = await tx
      .select({ vid: productVariants.id, cost: productVariants.costPrice, isConsign: products.isConsignment, cId: products.consignorId, pname: products.name, sku: productVariants.sku })
      .from(productVariants).innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productVariants.id, variantIds));
    const vmap = new Map(vrows.map((r) => [Number(r.vid), r]));
    for (const vid of variantIds) {
      const v = vmap.get(vid);
      if (!v) throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر #${vid} غير موجود` });
      if (!v.isConsign || Number(v.cId) !== input.consignorId)
        throw new TRPCError({ code: "BAD_REQUEST", message: `«${v.pname} — ${v.sku}» ليس بضاعة أمانة لهذا المودِع` });
    }

    const noteNumber = await nextConsignmentNumber(tx, input.branchId);
    const noteRes = await tx.insert(consignmentNotes).values({
      noteNumber,
      noteType: input.noteType,
      consignorId: input.consignorId,
      branchId: input.branchId,
      clientRequestId,
      notes: norm(input.notes),
      attachmentUrl: norm(input.attachmentUrl),
      createdBy: actor.userId,
    });
    const noteId = extractInsertId(noteRes);

    // الأسطر بترتيب variantId تصاعدياً (منع deadlock مع حركات متزامنة).
    const ordered = [...input.lines].sort((a, b) => a.variantId - b.variantId);
    for (const l of ordered) {
      const { baseQuantity } = await convertToBaseQuantity(tx, l.productUnitId, l.quantity, l.variantId);
      const share = vmap.get(l.variantId)!.cost;
      await tx.insert(consignmentNoteLines).values({
        noteId,
        lineDirection: l.lineDirection,
        variantId: l.variantId,
        productUnitId: l.productUnitId,
        quantity: String(l.quantity),
        baseQuantity,
        unitShareSnapshot: String(share ?? "0"),
        notes: norm(l.notes),
      });
      if (l.lineDirection === "IN") {
        // إيداع: حركة IN + ختم openedAt (الإيداع افتتاحٌ للرصيد بكمية موثَّقة).
        await applyMovement(tx, {
          variantId: l.variantId, branchId: input.branchId, baseQuantity, movementType: "IN",
          referenceType: "CONSIGN_IN", referenceId: noteId, notes: `إيداع أمانة ${noteNumber}`,
          createdBy: actor.userId, stampOpened: true,
        });
      } else {
        // سحب: حركة OUT — فحص كفاية الرصيد تحت القفل مجاناً (لا سحب أكثر من المتبقي).
        await applyMovement(tx, {
          variantId: l.variantId, branchId: input.branchId, baseQuantity, movementType: "OUT",
          referenceType: "CONSIGN_OUT", referenceId: noteId, notes: `سحب أمانة ${noteNumber}`,
          createdBy: actor.userId,
        });
      }
    }

    return { noteId, noteNumber, idempotentReplay: false };
  });
}

/** قائمة السندات (فلاتر مودِع/نوع/فترة) — لتبويب سندات الأمانة. */
export async function listConsignmentNotes(input: {
  consignorId?: number; noteType?: ConsignmentNoteType; branchId?: number; limit?: number; offset?: number;
}) {
  const db = getDb();
  if (!db) return { rows: [], total: 0 };
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
  const offset = Math.max(input.offset ?? 0, 0);
  const conds = [] as any[];
  if (input.consignorId) conds.push(eq(consignmentNotes.consignorId, input.consignorId));
  if (input.noteType) conds.push(eq(consignmentNotes.noteType, input.noteType));
  if (input.branchId) conds.push(eq(consignmentNotes.branchId, input.branchId));
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db
    .select({
      id: consignmentNotes.id, noteNumber: consignmentNotes.noteNumber, noteType: consignmentNotes.noteType,
      consignorId: consignmentNotes.consignorId, consignorName: suppliers.name, branchId: consignmentNotes.branchId,
      hasAttachment: sql<number>`CASE WHEN ${consignmentNotes.attachmentUrl} IS NULL THEN 0 ELSE 1 END`,
      createdAt: consignmentNotes.createdAt,
    })
    .from(consignmentNotes).innerJoin(suppliers, eq(suppliers.id, consignmentNotes.consignorId))
    .where(where as any).orderBy(desc(consignmentNotes.id)).limit(limit).offset(offset);
  const totalRow = (await db.select({ n: sql<number>`COUNT(*)` }).from(consignmentNotes).where(where as any))[0];
  return { rows, total: Number(totalRow?.n ?? 0) };
}

/** تفاصيل سند + أسطره (للطباعة والعرض). */
export async function getConsignmentNote(noteId: number) {
  const db = getDb();
  if (!db) return null;
  const [note] = await db
    .select({
      id: consignmentNotes.id, noteNumber: consignmentNotes.noteNumber, noteType: consignmentNotes.noteType,
      consignorId: consignmentNotes.consignorId, consignorName: suppliers.name, consignorPhone: suppliers.phone,
      branchId: consignmentNotes.branchId, notes: consignmentNotes.notes, attachmentUrl: consignmentNotes.attachmentUrl,
      createdAt: consignmentNotes.createdAt,
    })
    .from(consignmentNotes).innerJoin(suppliers, eq(suppliers.id, consignmentNotes.consignorId))
    .where(eq(consignmentNotes.id, noteId)).limit(1);
  if (!note) return null;
  const lines = await db
    .select({
      id: consignmentNoteLines.id, lineDirection: consignmentNoteLines.lineDirection,
      variantId: consignmentNoteLines.variantId, productName: products.name, sku: productVariants.sku,
      quantity: consignmentNoteLines.quantity, baseQuantity: consignmentNoteLines.baseQuantity,
      unitShareSnapshot: consignmentNoteLines.unitShareSnapshot, notes: consignmentNoteLines.notes,
    })
    .from(consignmentNoteLines)
    .innerJoin(productVariants, eq(productVariants.id, consignmentNoteLines.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(consignmentNoteLines.noteId, noteId))
    .orderBy(asc(consignmentNoteLines.id));
  return { ...note, lines };
}

/**
 * تقرير أرصدة بضاعة الأمانة (ش٤): لكل مودِع — عدد الأصناف والكمية المتبقية على الرف + قيمتها بالحصة،
 * والمستحق الحاليّ (currentBalance = AP). خلف بوّابة التقارير الحمراء (قيمة بالتكلفة). §١١.
 */
export async function consignmentBalancesReport(branchId?: number) {
  const db = getDb();
  if (!db) return [];
  const branchCond = branchId ? sql`AND bs.branchId = ${branchId}` : sql``;
  const rows: any = await db.execute(sql`
    SELECT
      s.id AS consignorId, s.name AS consignorName, s.currentBalance AS owed,
      COUNT(DISTINCT bs.variantId) AS variantCount,
      CAST(COALESCE(SUM(bs.quantity), 0) AS CHAR) AS remainingQty,
      CAST(COALESCE(SUM(bs.quantity * pv.costPrice), 0) AS CHAR) AS remainingValueByShare
    FROM suppliers s
      JOIN products p ON p.consignorId = s.id AND p.isConsignment = true
      JOIN productVariants pv ON pv.productId = p.id
      LEFT JOIN branchStock bs ON bs.variantId = pv.id ${branchCond}
    WHERE s.supplierKind = 'CONSIGNOR'
    GROUP BY s.id, s.name, s.currentBalance
    ORDER BY s.name
  `);
  const list = Array.isArray(rows) ? (rows[0] ?? rows) : rows?.rows ?? [];
  return (list as any[]).map((r) => ({
    consignorId: Number(r.consignorId),
    consignorName: String(r.consignorName),
    owed: String(r.owed ?? "0"),
    variantCount: Number(r.variantCount ?? 0),
    remainingQty: Number(r.remainingQty ?? 0),
    remainingValueByShare: String(r.remainingValueByShare ?? "0"),
  }));
}

export interface ConsignmentMarginRow {
  consignorId: number;
  consignorName: string;
  soldQty: number;
  soldValue: string;
  consignorShare: string;
  libraryMargin: string;
  marginPct: string;
}

/**
 * تقرير هوامش الأمانة (ش٤، قراءةٌ فقط خلف بوّابة التقارير): ربح المكتبة المُحقَّق من بيع بضاعة كل
 * مودِع خلال فترة. لكل مودِع: القيمة المُباعة (صافية) − حصّته (صافية) = هامش المكتبة.
 *
 * نموذج البيانات (طريقة الإجمالي، §٣): سطر بيع أمانة في `invoiceItems` يحمل `total` (إيراد السطر)
 * و`unitCost` (حصّة المودِع لكل وحدة أساس — لقطة عند البيع، مطابقةٌ لِـ`share = unitCost×baseQty` في
 * التقاط البيع). المرتجعات تُتتبَّع لكل سطر في `returnedBaseQuantity` (returnService)، فالصافي دقيقٌ
 * ومُراعٍ للمرتجع من الجدول نفسه بلا اعتمادٍ على قيود الدفتر:
 *   netBase = baseQuantity − returnedBaseQuantity
 *   netRevenue = total × netBase / baseQuantity   (تناسبيّ — مرآة returnService)
 *   netShare   = unitCost × netBase
 *   margin     = netRevenue − netShare
 * التجميع بالقسمة يتمّ في MySQL (DECIMAL)، والطرح النهائيّ للهامش بـdecimal.js (قاعدة الأموال §٥).
 * لا يمسّ أي حالة (SELECT صرف). نطاق التاريخ sargable ([start، endDate+1) — نمط S2).
 */
export async function consignmentMarginsReport(input: { startDate: string; endDate: string; branchId?: number }) {
  const db = getDb();
  const empty = { rows: [] as ConsignmentMarginRow[], totals: { soldValue: "0.00", consignorShare: "0.00", libraryMargin: "0.00", marginPct: "0.00" } };
  if (!db) return empty;
  const branchCond = input.branchId ? sql`AND inv.branchId = ${input.branchId}` : sql``;
  const rows: any = await db.execute(sql`
    SELECT
      s.id AS consignorId, s.name AS consignorName,
      CAST(COALESCE(SUM(ii.baseQuantity - ii.returnedBaseQuantity), 0) AS CHAR) AS soldQty,
      CAST(COALESCE(SUM(ii.total * (ii.baseQuantity - ii.returnedBaseQuantity) / ii.baseQuantity), 0) AS CHAR) AS soldValue,
      CAST(COALESCE(SUM(ii.unitCost * (ii.baseQuantity - ii.returnedBaseQuantity)), 0) AS CHAR) AS consignorShare
    FROM invoiceItems ii
      JOIN invoices inv ON inv.id = ii.invoiceId
      JOIN productVariants pv ON pv.id = ii.variantId
      JOIN products p ON p.id = pv.productId AND p.isConsignment = true
      JOIN suppliers s ON s.id = p.consignorId AND s.supplierKind = 'CONSIGNOR'
    WHERE ii.baseQuantity > 0
      AND inv.invoiceDate >= ${input.startDate} AND inv.invoiceDate < DATE_ADD(${input.endDate}, INTERVAL 1 DAY)
      ${branchCond}
    GROUP BY s.id, s.name
    HAVING SUM(ii.baseQuantity - ii.returnedBaseQuantity) <> 0
    ORDER BY SUM(ii.total * (ii.baseQuantity - ii.returnedBaseQuantity) / ii.baseQuantity) DESC
  `);
  const list = Array.isArray(rows) ? (rows[0] ?? rows) : rows?.rows ?? [];
  let tSold = money(0), tShare = money(0);
  const mapped: ConsignmentMarginRow[] = (list as any[]).map((r) => {
    const soldValue = round2(money(r.soldValue ?? "0"));
    const share = round2(money(r.consignorShare ?? "0"));
    const margin = round2(soldValue.minus(share));
    const marginPct = soldValue.gt(0) ? round2(margin.dividedBy(soldValue).times(100)) : money(0);
    tSold = tSold.plus(soldValue);
    tShare = tShare.plus(share);
    return {
      consignorId: Number(r.consignorId),
      consignorName: String(r.consignorName),
      soldQty: Number(r.soldQty ?? 0),
      soldValue: soldValue.toFixed(2),
      consignorShare: share.toFixed(2),
      libraryMargin: margin.toFixed(2),
      marginPct: marginPct.toFixed(2),
    };
  });
  const totalMargin = round2(tSold.minus(tShare));
  const totalPct = tSold.gt(0) ? round2(totalMargin.dividedBy(tSold).times(100)) : money(0);
  return {
    rows: mapped,
    totals: {
      soldValue: round2(tSold).toFixed(2),
      consignorShare: round2(tShare).toFixed(2),
      libraryMargin: totalMargin.toFixed(2),
      marginPct: totalPct.toFixed(2),
    },
  };
}

export interface ConsignmentStatementLine {
  productId: number;
  variantId: number;
  productName: string;
  sku: string;
  soldQty: number;
  soldValue: string;
  share: string;
  margin: string;
  marginPct: string;
}
export interface ConsignmentSettlementStatement {
  consignorId: number;
  consignorName: string;
  currentOwed: string;
  period: { startDate: string; endDate: string; soldQty: number; soldValue: string; share: string; margin: string; marginPct: string };
  lines: ConsignmentStatementLine[];
  remaining: { qty: number; valueByShare: string };
}

/**
 * كشف تسوية مودِع (ش٥، قراءةٌ فقط للمعاينة/الطباعة — لا جدول مقفول ولا مسّ تدفّق المال): تفصيل نشاط
 * مودِعٍ خلال فترة لتحرير سند التسوية القائم (voucher-with-cap). الترويسة: المستحقّ الحاليّ
 * (`suppliers.currentBalance` — كامل المدى، AP) + إجماليات الفترة (net). الأسطر: لكل صنف بيعٌ
 * (net المرتجعات، نفس نموذج تقرير الهوامش). المتبقّي: بضاعته الحيّة بالحصّة (نفس تقرير الأرصدة).
 * الجزء «المقفول» من تصميم 0093 (أسطر مرتبطة بقيود الدفتر + uq_cstl_entry أساساً للتسوية) مؤجَّلٌ
 * صراحةً — يمسّ حوكمة المال. هذا الكشف مستندٌ استرشاديّ يرافق التسوية القائمة، لا يستبدلها.
 */
export async function consignmentSettlementStatement(input: {
  consignorId: number; startDate: string; endDate: string; branchId?: number;
}): Promise<ConsignmentSettlementStatement | null> {
  const db = getDb();
  if (!db) return null;
  const [sup] = await db
    .select({ id: suppliers.id, name: suppliers.name, owed: suppliers.currentBalance, kind: suppliers.supplierKind })
    .from(suppliers).where(eq(suppliers.id, input.consignorId)).limit(1);
  if (!sup || sup.kind !== "CONSIGNOR") return null;

  const branchCond = input.branchId ? sql`AND inv.branchId = ${input.branchId}` : sql``;
  const lineRows: any = await db.execute(sql`
    SELECT
      p.id AS productId, pv.id AS variantId, p.name AS productName, pv.sku AS sku,
      CAST(COALESCE(SUM(ii.baseQuantity - ii.returnedBaseQuantity), 0) AS CHAR) AS soldQty,
      CAST(COALESCE(SUM(ii.total * (ii.baseQuantity - ii.returnedBaseQuantity) / ii.baseQuantity), 0) AS CHAR) AS soldValue,
      CAST(COALESCE(SUM(ii.unitCost * (ii.baseQuantity - ii.returnedBaseQuantity)), 0) AS CHAR) AS share
    FROM invoiceItems ii
      JOIN invoices inv ON inv.id = ii.invoiceId
      JOIN productVariants pv ON pv.id = ii.variantId
      JOIN products p ON p.id = pv.productId AND p.isConsignment = true AND p.consignorId = ${input.consignorId}
    WHERE ii.baseQuantity > 0
      AND inv.invoiceDate >= ${input.startDate} AND inv.invoiceDate < DATE_ADD(${input.endDate}, INTERVAL 1 DAY)
      ${branchCond}
    GROUP BY p.id, pv.id, p.name, pv.sku
    HAVING SUM(ii.baseQuantity - ii.returnedBaseQuantity) <> 0
    ORDER BY SUM(ii.total * (ii.baseQuantity - ii.returnedBaseQuantity) / ii.baseQuantity) DESC
  `);
  const rawLines = Array.isArray(lineRows) ? (lineRows[0] ?? lineRows) : lineRows?.rows ?? [];
  let pSold = money(0), pShare = money(0), pQty = 0;
  const lines: ConsignmentStatementLine[] = (rawLines as any[]).map((r) => {
    const soldValue = round2(money(r.soldValue ?? "0"));
    const share = round2(money(r.share ?? "0"));
    const margin = round2(soldValue.minus(share));
    const marginPct = soldValue.gt(0) ? round2(margin.dividedBy(soldValue).times(100)) : money(0);
    pSold = pSold.plus(soldValue); pShare = pShare.plus(share); pQty += Number(r.soldQty ?? 0);
    return {
      productId: Number(r.productId), variantId: Number(r.variantId),
      productName: String(r.productName), sku: String(r.sku ?? ""),
      soldQty: Number(r.soldQty ?? 0), soldValue: soldValue.toFixed(2), share: share.toFixed(2),
      margin: margin.toFixed(2), marginPct: marginPct.toFixed(2),
    };
  });
  const pMargin = round2(pSold.minus(pShare));
  const pPct = pSold.gt(0) ? round2(pMargin.dividedBy(pSold).times(100)) : money(0);

  // المتبقّي الحيّ بالحصّة (نفس نموذج تقرير الأرصدة).
  const branchCondBs = input.branchId ? sql`AND bs.branchId = ${input.branchId}` : sql``;
  const remRows: any = await db.execute(sql`
    SELECT
      CAST(COALESCE(SUM(bs.quantity), 0) AS CHAR) AS qty,
      CAST(COALESCE(SUM(bs.quantity * pv.costPrice), 0) AS CHAR) AS valueByShare
    FROM products p
      JOIN productVariants pv ON pv.productId = p.id
      LEFT JOIN branchStock bs ON bs.variantId = pv.id ${branchCondBs}
    WHERE p.isConsignment = true AND p.consignorId = ${input.consignorId}
  `);
  const rem = (Array.isArray(remRows) ? (remRows[0] ?? remRows) : remRows?.rows ?? [])[0] ?? {};

  return {
    consignorId: Number(sup.id),
    consignorName: String(sup.name),
    currentOwed: round2(money(sup.owed ?? "0")).toFixed(2),
    period: {
      startDate: input.startDate, endDate: input.endDate, soldQty: pQty,
      soldValue: round2(pSold).toFixed(2), share: round2(pShare).toFixed(2),
      margin: pMargin.toFixed(2), marginPct: pPct.toFixed(2),
    },
    lines,
    remaining: { qty: Number(rem.qty ?? 0), valueByShare: round2(money(rem.valueByShare ?? "0")).toFixed(2) },
  };
}

/** أصناف مودِع بعينه — لمنتقي أصناف سند الإيداع/السحب (أصناف هذا المودِع فقط + وحدة الأساس). */
export async function listConsignorProducts(consignorId: number, _branchId: number) {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({
      variantId: productVariants.id, productName: products.name, sku: productVariants.sku,
      color: productVariants.color, share: productVariants.costPrice,
      productUnitId: productUnits.id, unitName: productUnits.unitName,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(productUnits, and(eq(productUnits.variantId, productVariants.id), eq(productUnits.isBaseUnit, true)))
    .where(and(eq(products.consignorId, consignorId), eq(products.isConsignment, true), eq(productVariants.isActive, true)))
    .orderBy(asc(products.name)).limit(500);
  return rows.map((r) => ({ ...r, variantId: Number(r.variantId), productUnitId: Number(r.productUnitId) }));
}
