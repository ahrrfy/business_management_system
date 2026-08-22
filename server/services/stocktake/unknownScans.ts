// طابور «الباركود المجهول» — جانب المشرف (وثيقة «الجرد بالباركود» ٢٢/٨، ب-٤).
//
// المشرف يرى ما التقطه الميدان من باركوداتٍ خارج نطاق الجلسة، فيقرّر لكلٍّ:
//   - ADD_TO_SCOPE: صنفٌ معروفٌ خارج النطاق ⇒ يُحلّ الباركود إلى متغيّره ويُلحق بالجلسة (لقطة رصيد/تكلفة).
//   - DISMISS: صنفٌ مجهولٌ تماماً أو غير ذي صلة ⇒ يُغلق بملاحظة (يبقى في السجل append-only).
// الحلّ يعبُر الأساسيّ والبديل معاً (نفس منطق resolveBarcodeOwner)، ويُرفض الخدميّ/البكج.
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  branchStock,
  products,
  productUnitBarcodes,
  productUnits,
  productVariants,
  stocktakeAssignments,
  stocktakeItems,
  stocktakeSessions,
  stocktakeUnknownScans,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { toDbMoney } from "../money";
import { requireDb, withTx } from "../tx";
import type { StkActor } from "./types";

export type UnknownScanRow = {
  barcode: string;
  occurrences: number;
  lastScannedBy: string;
  lastAt: Date;
  /** يُحلّ إلى متغيّرٍ مخزنيّ قابلٍ للإلحاق (لا خدميّ/بكج ولا مضاف سلفاً). */
  resolvable: boolean;
  /** اسم المتغيّر إن حُلّ (للعرض) — null إن كان مجهولاً تماماً. */
  resolvedName: string | null;
  /** المتغيّر مُدرَجٌ في الجلسة سلفاً (فالإلحاق لا-أثر — مجرّد إغلاق). */
  alreadyInScope: boolean;
};

/** يحلّ باركوداً (أساسيّ أو بديل) إلى متغيّره + أعلام المنتج + التكلفة. للاستعمال الداخليّ. */
async function resolveBarcodesToVariants(
  tx: Tx,
  barcodes: string[],
): Promise<
  Map<
    string,
    {
      variantId: number;
      productName: string;
      isService: boolean;
      isBundle: boolean;
      costPrice: string;
    }
  >
> {
  const out = new Map<
    string,
    { variantId: number; productName: string; isService: boolean; isBundle: boolean; costPrice: string }
  >();
  if (!barcodes.length) return out;
  const primary = await tx
    .select({
      barcode: productUnits.barcode,
      variantId: productVariants.id,
      productName: products.name,
      isService: products.isService,
      isBundle: products.isBundle,
      costPrice: productVariants.costPrice,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(inArray(productUnits.barcode, barcodes));
  for (const r of primary) {
    if (r.barcode && !out.has(r.barcode))
      out.set(r.barcode, {
        variantId: Number(r.variantId),
        productName: r.productName,
        isService: !!r.isService,
        isBundle: !!r.isBundle,
        costPrice: String(r.costPrice ?? "0"),
      });
  }
  const remaining = barcodes.filter((b) => !out.has(b));
  if (remaining.length) {
    const alias = await tx
      .select({
        barcode: productUnitBarcodes.barcode,
        variantId: productVariants.id,
        productName: products.name,
        isService: products.isService,
        isBundle: products.isBundle,
        costPrice: productVariants.costPrice,
      })
      .from(productUnitBarcodes)
      .innerJoin(productUnits, eq(productUnitBarcodes.productUnitId, productUnits.id))
      .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productUnitBarcodes.barcode, remaining));
    for (const r of alias) {
      if (r.barcode && !out.has(r.barcode))
        out.set(r.barcode, {
          variantId: Number(r.variantId),
          productName: r.productName,
          isService: !!r.isService,
          isBundle: !!r.isBundle,
          costPrice: String(r.costPrice ?? "0"),
        });
    }
  }
  return out;
}

async function loadSessionForManager(
  tx: Tx,
  sessionId: number,
  restrictBranchId: number | null,
): Promise<{ id: number; branchId: number; status: string }> {
  const [session] = await tx
    .select({
      id: stocktakeSessions.id,
      branchId: stocktakeSessions.branchId,
      status: stocktakeSessions.status,
    })
    .from(stocktakeSessions)
    .where(eq(stocktakeSessions.id, sessionId))
    .for("update")
    .limit(1);
  if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "جلسة الجرد غير موجودة." });
  if (restrictBranchId != null && Number(session.branchId) !== restrictBranchId) {
    // لا تُسرّب وجود جلسةٍ في فرعٍ آخر — نفس رسالة عدم الوجود (عزل الفرع).
    throw new TRPCError({ code: "NOT_FOUND", message: "جلسة الجرد غير موجودة." });
  }
  return { id: Number(session.id), branchId: Number(session.branchId), status: session.status };
}

/** طابور الباركودات المجهولة المعلّقة، مُجمَّعاً بالباركود (occurrences) مع قابلية الحلّ. */
export async function listUnknownScans(
  sessionId: number,
  opts: { restrictBranchId: number | null } = { restrictBranchId: null },
): Promise<UnknownScanRow[]> {
  const db = requireDb();
  // تحقّق الفرع دون قفل (قراءة).
  const [session] = await db
    .select({ branchId: stocktakeSessions.branchId })
    .from(stocktakeSessions)
    .where(eq(stocktakeSessions.id, sessionId))
    .limit(1);
  if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "جلسة الجرد غير موجودة." });
  if (opts.restrictBranchId != null && Number(session.branchId) !== opts.restrictBranchId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "جلسة الجرد غير موجودة." });
  }

  const rows = await db
    .select({
      barcode: stocktakeUnknownScans.barcode,
      occurrences: sql<number>`COUNT(*)`,
      lastAt: sql<Date>`MAX(${stocktakeUnknownScans.createdAt})`,
      lastScannedBy: sql<string>`SUBSTRING_INDEX(GROUP_CONCAT(${stocktakeUnknownScans.scannedByName} ORDER BY ${stocktakeUnknownScans.createdAt} DESC SEPARATOR 0x1f), 0x1f, 1)`,
    })
    .from(stocktakeUnknownScans)
    .where(
      and(
        eq(stocktakeUnknownScans.sessionId, sessionId),
        eq(stocktakeUnknownScans.status, "PENDING"),
      ),
    )
    .groupBy(stocktakeUnknownScans.barcode)
    .orderBy(sql`MAX(${stocktakeUnknownScans.createdAt}) DESC`);

  if (!rows.length) return [];

  const barcodes = rows.map((r) => r.barcode);
  const resolved = await withTx((tx) => resolveBarcodesToVariants(tx, barcodes));
  const variantIds = Array.from(new Set(Array.from(resolved.values()).map((v) => v.variantId)));
  const inScope = new Set<number>();
  if (variantIds.length) {
    const scopeRows = await db
      .select({ variantId: stocktakeItems.variantId })
      .from(stocktakeItems)
      .where(
        and(
          eq(stocktakeItems.sessionId, sessionId),
          inArray(stocktakeItems.variantId, variantIds),
        ),
      );
    for (const r of scopeRows) inScope.add(Number(r.variantId));
  }

  return rows.map((r) => {
    const hit = resolved.get(r.barcode);
    const already = hit ? inScope.has(hit.variantId) : false;
    const resolvable = !!hit && !hit.isService && !hit.isBundle && !already;
    return {
      barcode: r.barcode,
      occurrences: Number(r.occurrences),
      lastScannedBy: r.lastScannedBy ?? "",
      lastAt: r.lastAt,
      resolvable,
      resolvedName: hit ? hit.productName : null,
      alreadyInScope: already,
    };
  });
}

export type ResolveUnknownScanResult = {
  resolvedRows: number;
  action: "ADD_TO_SCOPE" | "DISMISS";
  addedVariantId: number | null;
  alreadyInScope: boolean;
};

/**
 * حسم باركودٍ مجهول: يعالج كل صفوفه المعلّقة في الجلسة دفعةً.
 * ADD_TO_SCOPE يلزمه COUNTING (لا تُوسَّع جلسةٌ في المراجعة) وباركودٌ يُحلّ إلى متغيّر مخزنيّ.
 */
export async function resolveUnknownScan(
  input: {
    sessionId: number;
    barcode: string;
    action: "ADD_TO_SCOPE" | "DISMISS";
    note?: string;
  },
  actor: StkActor,
  opts: { restrictBranchId: number | null } = { restrictBranchId: null },
): Promise<ResolveUnknownScanResult> {
  const barcode = input.barcode.trim();
  if (!barcode) throw new TRPCError({ code: "BAD_REQUEST", message: "باركود غير صالح." });

  return withTx(async (tx) => {
    const session = await loadSessionForManager(tx, input.sessionId, opts.restrictBranchId);

    const pending = await tx
      .select({ id: stocktakeUnknownScans.id })
      .from(stocktakeUnknownScans)
      .where(
        and(
          eq(stocktakeUnknownScans.sessionId, session.id),
          eq(stocktakeUnknownScans.barcode, barcode),
          eq(stocktakeUnknownScans.status, "PENDING"),
        ),
      )
      .for("update");
    if (!pending.length) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "لا يوجد مسحٌ معلّقٌ بهذا الباركود — ربما عولج للتوّ. حدّث القائمة.",
      });
    }
    const pendingIds = pending.map((p) => Number(p.id));

    let addedVariantId: number | null = null;
    let alreadyInScope = false;
    let resolvedVariantId: number | null = null;

    if (input.action === "ADD_TO_SCOPE") {
      if (session.status !== "COUNTING") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "لا يُضاف صنفٌ للنطاق إلا والجلسة قيد العدّ — أعِد فتح العدّ أو تجاهل الباركود.",
        });
      }
      const resolved = await resolveBarcodesToVariants(tx, [barcode]);
      const hit = resolved.get(barcode);
      if (!hit) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "الباركود لا يُحلّ إلى صنفٍ مسجّل — سجّله في الكتالوج أولاً، أو تجاهله.",
        });
      }
      if (hit.isService || hit.isBundle) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `لا يُجرَد هذا النوع: «${hit.productName}» (خدميّ أو بكج) — لا يُضاف لنطاق الجرد.`,
        });
      }
      resolvedVariantId = hit.variantId;

      const [existing] = await tx
        .select({ id: stocktakeItems.id })
        .from(stocktakeItems)
        .where(
          and(
            eq(stocktakeItems.sessionId, session.id),
            eq(stocktakeItems.variantId, hit.variantId),
          ),
        )
        .limit(1);
      if (existing) {
        alreadyInScope = true;
      } else {
        // assignmentId حقلٌ تقنيّ (القائمة مشتركة) — نأخذ أوّل تكليفٍ للجلسة كما في liveScope.
        const [assignment] = await tx
          .select({ id: stocktakeAssignments.id })
          .from(stocktakeAssignments)
          .where(eq(stocktakeAssignments.sessionId, session.id))
          .limit(1);
        if (!assignment) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا تكليفَ في الجلسة." });
        }
        const [stock] = await tx
          .select({ quantity: branchStock.quantity })
          .from(branchStock)
          .where(
            and(
              eq(branchStock.variantId, hit.variantId),
              eq(branchStock.branchId, session.branchId),
            ),
          )
          .limit(1);
        await tx
          .insert(stocktakeItems)
          .values({
            sessionId: session.id,
            assignmentId: Number(assignment.id),
            variantId: hit.variantId,
            branchId: session.branchId,
            expectedQty: stock?.quantity ?? 0,
            unitCost: toDbMoney(hit.costPrice),
          })
          // الدفاع الأخير ضد سباق مزامنة النطاق الحيّ — لا تُستبدل لقطةُ عنصرٍ قائم.
          .onDuplicateKeyUpdate({ set: { sessionId: sql`${stocktakeItems.sessionId}` } });
        addedVariantId = hit.variantId;
      }
    }

    const newStatus = input.action === "ADD_TO_SCOPE" ? "RESOLVED" : "DISMISSED";
    await tx
      .update(stocktakeUnknownScans)
      .set({
        status: newStatus,
        resolvedBy: actor.userId,
        resolvedAt: new Date(),
        resolvedVariantId,
        resolutionNote: input.note?.trim() || null,
      })
      .where(inArray(stocktakeUnknownScans.id, pendingIds));

    return {
      resolvedRows: pendingIds.length,
      action: input.action,
      addedVariantId,
      alreadyInScope,
    };
  });
}
