/**
 * النواة المالية المشتركة لإعادة تقييم التكلفة (طلب مفرد أو موجة جماعية).
 *
 * الترتيب إلزامي: قفل المتغيّر ← قفل أرصدة فروعه ← مقارنة اللقطة ← تحديث التكلفة
 * ← أثر التدقيق ← قيد ADJUST لكل فرع. لا تستعمل هذه الدوال خارج معاملة `withTx`.
 */
import Decimal from "decimal.js";
import { TRPCError } from "@trpc/server";
import { asc, eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  branchStock,
  productVariants,
  products,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { canCrossBranches } from "../../lib/branchAuthority";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import type { Actor } from "../tx";

export type CostRevaluationPurpose = "CORRECTION" | "IMPAIRMENT";

export interface BranchQuantitySnapshot {
  branchId: number;
  quantity: number;
}

export interface LockedCostRevaluationTarget {
  variantId: number;
  oldCost: Decimal;
  branchQuantities: BranchQuantitySnapshot[];
}

export type CostRevaluationSnapshotCheck =
  | { ok: true; target: LockedCostRevaluationTarget }
  | {
    ok: false;
    variantId: number;
    reason: "COST_DRIFT" | "QUANTITY_DRIFT" | "INELIGIBLE";
    message: string;
    actual?: {
      cost: string;
      branchQuantities: BranchQuantitySnapshot[];
    };
  };

export async function loadBranchQuantitySnapshot(
  tx: Tx,
  variantId: number,
  lock: boolean,
): Promise<BranchQuantitySnapshot[]> {
  const base = tx
    .select({ branchId: branchStock.branchId, quantity: branchStock.quantity })
    .from(branchStock)
    .where(eq(branchStock.variantId, variantId));
  const rows = lock ? await base.for("update") : await base;
  return rows
    .map((row) => ({
      branchId: Number(row.branchId),
      quantity: Number(row.quantity ?? 0),
    }))
    .filter((row) => row.quantity !== 0)
    .sort((a, b) => a.branchId - b.branchId);
}

export function totalBranchQuantity(rows: BranchQuantitySnapshot[]): number {
  return rows.reduce((sum, row) => sum + row.quantity, 0);
}

export function parseBranchQuantitySnapshot(raw: unknown): BranchQuantitySnapshot[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => ({
      branchId: Number((row as BranchQuantitySnapshot)?.branchId),
      quantity: Number((row as BranchQuantitySnapshot)?.quantity),
    }))
    .filter((row) => Number.isFinite(row.branchId) && Number.isFinite(row.quantity))
    .sort((a, b) => a.branchId - b.branchId);
}

export function sameBranchQuantitySnapshot(
  expected: BranchQuantitySnapshot[],
  live: BranchQuantitySnapshot[],
): boolean {
  if (expected.length !== live.length) return false;
  return expected.every(
    (row, index) =>
      row.branchId === live[index].branchId && row.quantity === live[index].quantity,
  );
}

export function assertCostRevaluationBranchAuthority(
  rows: BranchQuantitySnapshot[],
  actor: Actor & { isOwner?: boolean | null },
  verb: string,
): void {
  if (canCrossBranches(actor)) return;
  const hasForeignStock = rows.some(
    (row) => Number(row.branchId) !== Number(actor.branchId),
  );
  if (hasForeignStock) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `التكلفة عامّة لكل الفروع، ولهذا الصنف رصيدٌ في فرعٍ آخر — لا يمكن ${verb} إعادة تقييمه إلّا من الإدارة.`,
    });
  }
}

/** يقفل الهدف ويعيد نتيجةً بدلاً من الرمي كي تستطيع الموجة تسجيل CONFLICTED داخل معاملتها. */
export async function lockAndCheckCostRevaluationSnapshot(
  tx: Tx,
  input: {
    variantId: number;
    expectedOldCost: string;
    expectedBranchQuantities: BranchQuantitySnapshot[];
    actor: Actor & { isOwner?: boolean | null };
    authorityVerb: string;
  },
): Promise<CostRevaluationSnapshotCheck> {
  return (
    await lockAndCheckCostRevaluationSnapshots(tx, [input])
  )[0];
}

/** قفل وفحص مجموعةٍ كاملة باستعلامين مرتّبين؛ هذا هو مسار الموجة عالي الأداء. */
export async function lockAndCheckCostRevaluationSnapshots(
  tx: Tx,
  inputs: Array<{
    variantId: number;
    expectedOldCost: string;
    expectedBranchQuantities: BranchQuantitySnapshot[];
    actor: Actor & { isOwner?: boolean | null };
    authorityVerb: string;
  }>,
): Promise<CostRevaluationSnapshotCheck[]> {
  if (inputs.length === 0) return [];
  const ordered = [...inputs].sort((a, b) => a.variantId - b.variantId);
  const variantIds = ordered.map((row) => row.variantId);
  const variants = await tx
    .select({
      id: productVariants.id,
      costPrice: productVariants.costPrice,
      isConsignment: products.isConsignment,
      isBundle: products.isBundle,
      isService: products.isService,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(inArray(productVariants.id, variantIds))
    .orderBy(asc(productVariants.id))
    .for("update");
  const stockRows = await tx
    .select({
      variantId: branchStock.variantId,
      branchId: branchStock.branchId,
      quantity: branchStock.quantity,
    })
    .from(branchStock)
    .where(inArray(branchStock.variantId, variantIds))
    .orderBy(asc(branchStock.variantId), asc(branchStock.branchId))
    .for("update");

  const variantById = new Map(variants.map((row) => [Number(row.id), row]));
  const stockByVariant = new Map<number, BranchQuantitySnapshot[]>();
  for (const row of stockRows) {
    const variantId = Number(row.variantId);
    const quantity = Number(row.quantity ?? 0);
    if (quantity === 0) continue;
    const list = stockByVariant.get(variantId) ?? [];
    list.push({ branchId: Number(row.branchId), quantity });
    stockByVariant.set(variantId, list);
  }

  return ordered.map((input): CostRevaluationSnapshotCheck => {
    const variant = variantById.get(input.variantId);
    const liveRows = stockByVariant.get(input.variantId) ?? [];
    if (!variant) {
      return {
        ok: false,
        variantId: input.variantId,
        reason: "INELIGIBLE",
        message: "المتغيّر لم يعد موجوداً",
      };
    }
    const liveCost = round2(money(variant.costPrice ?? "0"));
    const actual = { cost: liveCost.toFixed(2), branchQuantities: liveRows };
    if (variant.isConsignment || variant.isBundle || variant.isService) {
      const kind = variant.isConsignment
        ? "بضاعة أمانة"
        : variant.isBundle
          ? "بكجاً وتكلفته مشتقة من مكوّناته"
          : "منتجاً خدمياً";
      return {
        ok: false,
        variantId: input.variantId,
        reason: "INELIGIBLE",
        message: `صار الصنف ${kind} بعد إنشاء المستند`,
        actual,
      };
    }
    try {
      assertCostRevaluationBranchAuthority(liveRows, input.actor, input.authorityVerb);
    } catch (error) {
      return {
        ok: false,
        variantId: input.variantId,
        reason: "INELIGIBLE",
        message: error instanceof Error ? error.message : "لا توجد صلاحية على أرصدة الفروع",
        actual,
      };
    }

    const expectedCost = round2(money(input.expectedOldCost));
    if (!liveCost.equals(expectedCost)) {
      return {
        ok: false,
        variantId: input.variantId,
        reason: "COST_DRIFT",
        message: `تغيّرت تكلفة الصنف منذ إنشاء المستند (كانت ${expectedCost.toFixed(2)}، الآن ${liveCost.toFixed(2)})`,
        actual,
      };
    }
    if (!sameBranchQuantitySnapshot(input.expectedBranchQuantities, liveRows)) {
      return {
        ok: false,
        variantId: input.variantId,
        reason: "QUANTITY_DRIFT",
        message: `تغيّرت كميّات الصنف منذ إنشاء المستند (كانت ${totalBranchQuantity(input.expectedBranchQuantities)}، الآن ${totalBranchQuantity(liveRows)})`,
        actual,
      };
    }

    return {
      ok: true,
      target: { variantId: input.variantId, oldCost: liveCost, branchQuantities: liveRows },
    };
  });
}

export async function postLockedCostRevaluation(
  tx: Tx,
  target: LockedCostRevaluationTarget,
  input: {
    newCost: string;
    purpose: CostRevaluationPurpose;
    reason: string;
    actor: Actor;
    requestedBy: number | null;
    sourceType: "REQUEST" | "WAVE";
    sourceId: number;
    waveItemId?: number | null;
  },
): Promise<{ postedEntries: number; totalValueDelta: string }> {
  const newCost = round2(money(input.newCost));
  const perUnitDelta = round2(newCost.minus(target.oldCost));

  await tx
    .update(productVariants)
    .set({ costPrice: toDbMoney(newCost) })
    .where(eq(productVariants.id, target.variantId));

  await tx.insert(auditLogs).values({
    userId: input.actor.userId,
    branchId: input.actor.branchId ?? null,
    action:
      input.sourceType === "WAVE"
        ? "product.costWaveRevaluation"
        : "product.costRevaluation",
    entityType: "productVariant",
    entityId: String(target.variantId),
    oldValue: { costPrice: target.oldCost.toFixed(2) },
    newValue: {
      costPrice: newCost.toFixed(2),
      purpose: input.purpose,
      reason: input.reason,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      waveItemId: input.waveItemId ?? null,
      requestedBy: input.requestedBy,
    },
  });

  let postedEntries = 0;
  let totalDelta = new Decimal(0);
  for (const row of target.branchQuantities) {
    const delta = round2(perUnitDelta.times(row.quantity));
    if (delta.isZero()) continue;
    const gain = delta.isPositive();
    const absoluteDelta = delta.abs();
    const sourceComponents = gain
      ? { roleDebits: { INVENTORY: absoluteDelta }, roleCredits: { OTHER_REVENUE: absoluteDelta } }
      : { roleDebits: { LOSSES: absoluteDelta }, roleCredits: { INVENTORY: absoluteDelta } };
    const sourceLabel = input.sourceType === "WAVE" ? "موجة تكلفة" : "طلب";
    const dedupePrefix = input.sourceType === "WAVE" ? "COST_WAVE" : "COST_REVAL";
    const dedupeKey =
      input.sourceType === "WAVE"
        ? `${dedupePrefix}:${input.sourceId}:${target.variantId}:${row.branchId}`
        : `${dedupePrefix}:${input.sourceId}:${row.branchId}`;

    await postEntry(tx, {
      entryType: "ADJUST",
      branchId: row.branchId,
      cost: delta.neg(),
      profit: delta,
      amount: money(0),
      dedupeKey,
      notes: `إعادة تقييم تكلفة (${sourceLabel} #${input.sourceId}، ${input.purpose === "IMPAIRMENT" ? "هبوط قيمة" : "تصحيح تكلفة"}) — ${input.reason}`,
      postingIntent: gain
        ? createPostingIntent(
          "ADJUST_INVENTORY_GAIN",
          "ADJUST",
          [debitLine("INVENTORY", absoluteDelta), creditLine("OTHER_REVENUE", absoluteDelta)],
          sourceComponents,
        )
        : createPostingIntent(
          "ADJUST_INVENTORY_LOSS",
          "ADJUST",
          [debitLine("LOSSES", absoluteDelta), creditLine("INVENTORY", absoluteDelta)],
          sourceComponents,
        ),
      postingSourceComponents: sourceComponents,
    });
    postedEntries += 1;
    totalDelta = totalDelta.plus(delta);
  }

  return {
    postedEntries,
    totalValueDelta: round2(totalDelta).toFixed(2),
  };
}
