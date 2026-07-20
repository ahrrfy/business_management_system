// بضاعة الأمانة — ش٢: خدمة سندات الإيداع/السحب/الاستبدال. راجع docs/consignment-design-2026-07-20.md §٢-أ/د.
// إيداع/سحب/استبدال = حركات مخزون بصفر أثر ماليّ (الالتزام يُلتقَط لحظة البيع في ش٣). ذرّيّ + idempotent.
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { isDupEntry } from "@shared/errorMap.ar";
import { consignmentNoteLines, consignmentNotes, productUnits, productVariants, products, suppliers } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { applyMovement, convertToBaseQuantity } from "../inventoryService";
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
