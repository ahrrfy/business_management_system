/** أسعار بداية اليوم (ش٤) — بلاغ «السعر لدى الجهاز مختلف» (§٧.٥ من وثيقة التصميم). */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  branches,
  digitalCurrentPrices,
  digitalOfferings,
  digitalPriceBatches,
  digitalPriceChangeReports,
  digitalPriceVersions,
  digitalProviders,
  products,
  suppliers,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { money, toDbMoney } from "../money";
import type { Actor } from "../tx";
import { auditLog, lockPublishedScope, type SheetScope } from "./pricingShared";
import { copyPrevious, saveDraft } from "./pricingDraft";
import { publish } from "./pricingPublish";

export async function reportMismatch(
  tx: Tx,
  input: { branchId: number; offeringId: number; reportedProviderShare: string; notes?: string | null },
  actor: Actor,
): Promise<{ reportId: number }> {
  const [row] = await tx
    .select({
      providerId: digitalOfferings.providerId,
      priceVersionId: digitalCurrentPrices.priceVersionId,
    })
    .from(digitalOfferings)
    .innerJoin(
      digitalCurrentPrices,
      and(
        eq(digitalCurrentPrices.offeringId, digitalOfferings.id),
        eq(digitalCurrentPrices.branchId, input.branchId),
      ),
    )
    .where(eq(digitalOfferings.id, input.offeringId))
    .limit(1);
  if (!row) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا سعر نافذ لهذه البطاقة في هذا الفرع — لا معنى لبلاغ تغيّر",
    });
  }

  const share = money(input.reportedProviderShare);
  if (share.lt(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "التكلفة المُبلَّغة لا تكون سالبة" });
  }

  const res = await tx.insert(digitalPriceChangeReports).values({
    branchId: input.branchId,
    offeringId: input.offeringId,
    providerId: Number(row.providerId),
    currentPriceVersionId: Number(row.priceVersionId),
    reportedProviderShare: toDbMoney(share),
    status: "OPEN",
    reportedBy: actor.userId,
    notes: input.notes?.trim() || null,
  });
  const reportId = extractInsertId(res);
  await auditLog(tx, actor, "digitalCards.pricing.mismatchReported", reportId, {
    offeringId: input.offeringId,
    branchId: input.branchId,
  });
  return { reportId };
}

export async function listMismatchReports(
  db: DB,
  filters: { branchId?: number | null; status?: "OPEN" | "APPROVED" | "REJECTED" | "RESOLVED" },
) {
  const conds = [];
  if (filters.branchId != null) conds.push(eq(digitalPriceChangeReports.branchId, filters.branchId));
  if (filters.status) conds.push(eq(digitalPriceChangeReports.status, filters.status));

  return db
    .select({
      id: digitalPriceChangeReports.id,
      branchId: digitalPriceChangeReports.branchId,
      branchName: branches.name,
      offeringId: digitalPriceChangeReports.offeringId,
      offeringName: products.name,
      providerId: digitalPriceChangeReports.providerId,
      providerName: suppliers.name,
      reportedProviderShare: digitalPriceChangeReports.reportedProviderShare,
      currentProviderShare: digitalPriceVersions.providerShare,
      currentSellPrice: digitalPriceVersions.sellPrice,
      status: digitalPriceChangeReports.status,
      notes: digitalPriceChangeReports.notes,
      reportedBy: digitalPriceChangeReports.reportedBy,
      createdAt: digitalPriceChangeReports.createdAt,
      resolvedAt: digitalPriceChangeReports.resolvedAt,
    })
    .from(digitalPriceChangeReports)
    .innerJoin(branches, eq(digitalPriceChangeReports.branchId, branches.id))
    .innerJoin(digitalOfferings, eq(digitalPriceChangeReports.offeringId, digitalOfferings.id))
    .innerJoin(products, eq(digitalOfferings.productId, products.id))
    .innerJoin(digitalProviders, eq(digitalPriceChangeReports.providerId, digitalProviders.id))
    .innerJoin(suppliers, eq(digitalProviders.supplierId, suppliers.id))
    .innerJoin(
      digitalPriceVersions,
      eq(digitalPriceChangeReports.currentPriceVersionId, digitalPriceVersions.id),
    )
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(digitalPriceChangeReports.id))
    .limit(200);
}

/** رفض البلاغ (لا يمسّ أيّ سعر). */
export async function rejectMismatch(
  tx: Tx,
  input: { reportId: number; notes?: string | null },
  actor: Actor,
): Promise<void> {
  const [report] = await tx
    .select()
    .from(digitalPriceChangeReports)
    .where(eq(digitalPriceChangeReports.id, input.reportId))
    .for("update");
  if (!report) throw new TRPCError({ code: "NOT_FOUND", message: "البلاغ غير موجود" });
  if (report.status !== "OPEN") {
    throw new TRPCError({ code: "CONFLICT", message: "البلاغ عولِج مسبقاً" });
  }
  await tx
    .update(digitalPriceChangeReports)
    .set({
      status: "REJECTED",
      resolvedBy: actor.userId,
      resolvedAt: new Date(),
      notes: input.notes?.trim() || report.notes,
    })
    .where(eq(digitalPriceChangeReports.id, input.reportId));
  await auditLog(tx, actor, "digitalCards.pricing.mismatchRejected", input.reportId, {});
}

/**
 * اعتماد البلاغ: **لا يعدّل الإصدار القديم**؛ ينشئ دُفعة سعر جديدة لهذه البطاقة وينشرها،
 * ثم يربط النسخة الناتجة بالبلاغ (§٧.٥). البطاقات الأخرى تحتفظ بأسعارها الحالية.
 */
export async function approveMismatch(
  tx: Tx,
  input: { reportId: number; businessDate: string; sellPrice: string; notes?: string | null },
  actor: Actor,
): Promise<{ reportId: number; batchId: number; priceVersionId: number }> {
  const [report] = await tx
    .select()
    .from(digitalPriceChangeReports)
    .where(eq(digitalPriceChangeReports.id, input.reportId))
    .for("update");
  if (!report) throw new TRPCError({ code: "NOT_FOUND", message: "البلاغ غير موجود" });
  if (report.status !== "OPEN") {
    throw new TRPCError({ code: "CONFLICT", message: "البلاغ عولِج مسبقاً" });
  }

  const branchId = Number(report.branchId);
  const providerId = Number(report.providerId);
  const scope: SheetScope = { branchId, providerId, businessDate: input.businessDate };
  await lockPublishedScope(tx, branchId, providerId);

  const [priceState] = await tx
    .select({
      priceVersionId: digitalCurrentPrices.priceVersionId,
      sellPrice: digitalPriceVersions.sellPrice,
    })
    .from(digitalCurrentPrices)
    .innerJoin(digitalPriceVersions, eq(digitalCurrentPrices.priceVersionId, digitalPriceVersions.id))
    .where(
      and(
        eq(digitalCurrentPrices.branchId, branchId),
        eq(digitalCurrentPrices.offeringId, Number(report.offeringId)),
      ),
    )
    .for("update");
  if (!priceState || Number(priceState.priceVersionId) !== Number(report.currentPriceVersionId)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "تغيّر السعر النافذ منذ تسجيل البلاغ — راجع السعر الجديد وأنشئ بلاغاً حديثاً عند الحاجة",
    });
  }
  if (!money(input.sellPrice).eq(money(priceState.sellPrice))) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "سعر البيع المرسل لا يطابق سعر العميل النافذ — أعد تحميل البلاغ قبل الاعتماد",
    });
  }

  // حارس فقد بيانات: الاعتماد ينسخ الأسعار النافذة فوق سطور المسودّة، فلو كان مديرٌ آخر
  // في منتصف إدخال مسودّة لهذا اليوم لطُمس عملُه صامتاً. نرفض ونطلب حسمها أوّلاً.
  const [openDraft] = await tx
    .select({ id: digitalPriceBatches.id })
    .from(digitalPriceBatches)
    .where(
      and(
        eq(digitalPriceBatches.branchId, branchId),
        eq(digitalPriceBatches.providerId, providerId),
        eq(digitalPriceBatches.businessDate, input.businessDate),
        eq(digitalPriceBatches.status, "DRAFT"),
      ),
    )
    .limit(1);
  if (openDraft) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "توجد مسودّة أسعار مفتوحة لهذا اليوم — انشرها أو ألغِها قبل اعتماد البلاغ " +
        "(الاعتماد ينشر دُفعةً كاملة فيطمس المسودّة).",
    });
  }

  // دُفعة جديدة تحمل الأسعار النافذة كما هي، والبطاقة المُبلَّغ عنها بالحصة الجديدة.
  const { batchId } = await copyPrevious(tx, scope, actor);
  await saveDraft(
    tx,
    {
      batchId,
      lines: [{
        offeringId: Number(report.offeringId),
        providerShare: report.reportedProviderShare,
        sellPrice: priceState.sellPrice,
      }],
    },
    actor,
  );
  const batchVersions = await tx
    .select({ offeringId: digitalPriceVersions.offeringId })
    .from(digitalPriceVersions)
    .where(eq(digitalPriceVersions.batchId, batchId));
  await publish(
    tx,
    { batchId, expectedOfferingIds: batchVersions.map((line) => Number(line.offeringId)) },
    actor,
  );

  const [newVersion] = await tx
    .select({ id: digitalPriceVersions.id })
    .from(digitalPriceVersions)
    .where(
      and(
        eq(digitalPriceVersions.batchId, batchId),
        eq(digitalPriceVersions.offeringId, Number(report.offeringId)),
      ),
    )
    .limit(1);

  await tx
    .update(digitalPriceChangeReports)
    .set({
      status: "RESOLVED",
      resolvedBy: actor.userId,
      resolvedAt: new Date(),
      resolutionPriceVersionId: newVersion ? Number(newVersion.id) : null,
      notes: input.notes?.trim() || report.notes,
    })
    .where(eq(digitalPriceChangeReports.id, input.reportId));

  await auditLog(tx, actor, "digitalCards.pricing.mismatchApproved", input.reportId, {
    batchId,
    offeringId: Number(report.offeringId),
  });

  return { reportId: input.reportId, batchId, priceVersionId: newVersion ? Number(newVersion.id) : 0 };
}

/** عدد البلاغات المفتوحة — شارة للمدير. */
export async function openMismatchCount(db: DB, branchId: number | null): Promise<number> {
  const conds = [eq(digitalPriceChangeReports.status, "OPEN" as const)];
  if (branchId != null) conds.push(eq(digitalPriceChangeReports.branchId, branchId));
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(digitalPriceChangeReports)
    .where(and(...conds));
  return Number(row?.n ?? 0);
}
