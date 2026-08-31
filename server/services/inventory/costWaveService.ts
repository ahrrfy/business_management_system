/**
 * موجات التكلفة: مستند جماعيّ بمعاينة موقّعة، اعتمادين مستقلين، وتطبيق مالي ذري.
 * لا توجد هنا «موافقة إدارية استثنائية»: المنشئ لا يعتمد ولو كان admin، والمعتمدان مختلفان.
 */
import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  ne,
  notExists,
  type SQL,
} from "drizzle-orm";
import {
  branchStock,
  branches,
  categories,
  costRevaluationRequests,
  costUpdateWaveApprovals,
  costUpdateWaveEvents,
  costUpdateWaveItems,
  costUpdateWaves,
  productVariants,
  products,
  users,
} from "../../../drizzle/schema";
import {
  COST_WAVE_MAX_ITEMS,
  COST_WAVE_MAX_PERCENT,
  COST_WAVE_MIN_REASON_LENGTH,
  COST_WAVE_REQUIRED_APPROVALS,
  applyCostWaveRule,
  type CostWaveEventStage,
  type CostWavePurpose,
  type CostWaveRuleType,
  type CostWaveScope,
  type CostWaveStatus,
} from "../../../shared/costWave";
import type { Tx } from "../../db";
import { canCrossBranches } from "../../lib/branchAuthority";
import { extractInsertId } from "../../lib/insertId";
import { buildVariantCatalogSearchWhere } from "../catalog/search";
import { money, round2, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import {
  assertCostRevaluationBranchAuthority,
  lockAndCheckCostRevaluationSnapshots,
  parseBranchQuantitySnapshot,
  postLockedCostRevaluation,
  totalBranchQuantity,
  type BranchQuantitySnapshot,
  type CostRevaluationSnapshotCheck,
} from "./costRevaluationPosting";

export type CostWaveSkipReason =
  | "UNCHANGED"
  | "SERVICE"
  | "BUNDLE"
  | "CONSIGNMENT"
  | "NEGATIVE_STOCK"
  | "IMPAIRMENT_INCREASE"
  | "OPEN_GOVERNED_CHANGE";

export interface CostWaveFilters {
  scope: CostWaveScope;
  categoryId?: number | null;
  productSearch?: string | null;
  variantIds?: number[] | null;
}

export interface PreviewCostWaveInput {
  purpose: CostWavePurpose;
  ruleType: CostWaveRuleType;
  changeValue: string;
  filters: CostWaveFilters;
}

export interface SubmitCostWaveInput extends PreviewCostWaveInput {
  name: string;
  description?: string | null;
  reason: string;
  previewFingerprint: string;
}

export interface CostWavePreviewRow {
  variantId: number;
  productId: number;
  productName: string;
  variantLabel: string;
  sku: string;
  categoryName: string | null;
  oldCost: string;
  newCost: string;
  branchQuantities: BranchQuantitySnapshot[];
  expectedQuantity: number;
  inventoryValueBefore: string;
  inventoryValueAfter: string;
  expectedValueDelta: string;
}

export interface CostWaveSkippedRow {
  variantId: number;
  productName: string;
  variantLabel: string;
  sku: string;
  oldCost: string;
  reason: CostWaveSkipReason;
}

export interface CostWavePreview {
  rows: CostWavePreviewRow[];
  skipped: CostWaveSkippedRow[];
  fingerprint: string;
  totals: {
    itemCount: number;
    skippedCount: number;
    expectedQuantity: number;
    inventoryValueBefore: string;
    inventoryValueAfter: string;
    expectedValueDelta: string;
  };
}

function assertManagerActor(actor: Actor): void {
  if (actor.role !== "admin" && actor.role !== "manager") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "موجات التكلفة متاحة للمديرين والإدارة فقط",
    });
  }
  if (!Number.isInteger(actor.branchId) || actor.branchId <= 0) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يوجد فرع صالح للمستخدم" });
  }
}

function assertScope(filters: CostWaveFilters): void {
  const hasCategory = filters.categoryId != null && filters.categoryId > 0;
  const hasSearch = !!filters.productSearch?.trim();
  const hasIds = Array.isArray(filters.variantIds) && filters.variantIds.length > 0;
  if (filters.scope === "FILTERED") {
    if (!hasCategory && !hasSearch) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "حدّد فئةً أو بحثاً، أو اختر «كل الأصناف المؤهلة» صراحةً",
      });
    }
    if (hasIds) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا تجمع الاختيار اليدوي مع نطاق الفلاتر" });
    }
    return;
  }
  if (filters.scope === "SELECTED") {
    if (!hasIds) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لم تحدّد أيّ صنف للموجة" });
    }
    const uniqueIds = new Set(filters.variantIds!.map(Number));
    if (uniqueIds.size !== filters.variantIds!.length || uniqueIds.size > 500) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "الاختيار اليدوي لا يقبل التكرار وحدّه الأقصى ٥٠٠ صنف",
      });
    }
    return;
  }
  if (hasCategory || hasSearch || hasIds) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "نطاق «الكل» لا يقبل فلاتر مرافقة؛ اختر النطاق المقصود بوضوح",
    });
  }
}

function assertRule(input: PreviewCostWaveInput): Decimal {
  assertScope(input.filters);
  const value = money(input.changeValue);
  if (value.isNegative() || (input.ruleType !== "SET_COST" && !value.gt(0))) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: input.ruleType === "SET_COST" ? "التكلفة المستهدفة لا تكون سالبة" : "نسبة التغيير يجب أن تكون أكبر من صفر",
    });
  }
  if (input.ruleType !== "SET_COST" && value.gt(COST_WAVE_MAX_PERCENT)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `النسبة تتجاوز الحد الأقصى (${COST_WAVE_MAX_PERCENT}%)`,
    });
  }
  if (input.ruleType === "DECREASE_PERCENT" && value.gt(100)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "خفضٌ يتجاوز ١٠٠٪ ينتج تكلفةً سالبة" });
  }
  if (input.purpose === "IMPAIRMENT" && input.ruleType === "INCREASE_PERCENT") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "هبوط القيمة لا يرفع التكلفة" });
  }
  return value;
}

async function categoryIdsWithChildren(tx: Tx, categoryId: number): Promise<number[]> {
  const children = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.parentId, categoryId));
  return [categoryId, ...children.map((row) => Number(row.id))];
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function costWaveFingerprint(
  input: PreviewCostWaveInput,
  rows: Array<
    Pick<
      CostWavePreviewRow,
      "variantId" | "oldCost" | "newCost" | "branchQuantities" | "expectedValueDelta"
    >
  >,
): string {
  return stableHash({
    version: 1,
    purpose: input.purpose,
    ruleType: input.ruleType,
    changeValue: new Decimal(input.changeValue).toDecimalPlaces(4).toFixed(4),
    filters: {
      scope: input.filters.scope,
      categoryId: input.filters.categoryId ?? null,
      productSearch: input.filters.productSearch?.trim() || null,
      variantIds: input.filters.variantIds
        ? [...input.filters.variantIds].map(Number).sort((a, b) => a - b)
        : [],
    },
    rows: rows.map((row) => ({
      variantId: row.variantId,
      oldCost: row.oldCost,
      newCost: row.newCost,
      branchQuantities: row.branchQuantities,
      expectedValueDelta: row.expectedValueDelta,
    })),
  });
}

async function computeCostWave(
  tx: Tx,
  input: PreviewCostWaveInput,
  actor: Actor,
  lock: boolean,
): Promise<CostWavePreview> {
  assertRule(input);
  const conditions: SQL[] = [eq(products.isActive, true), eq(productVariants.isActive, true)];
  if (input.filters.categoryId != null && input.filters.categoryId > 0) {
    const ids = await categoryIdsWithChildren(tx, input.filters.categoryId);
    conditions.push(ids.length > 1 ? inArray(products.categoryId, ids) : eq(products.categoryId, ids[0]));
  }
  const search = buildVariantCatalogSearchWhere(input.filters.productSearch ?? undefined);
  if (search) conditions.push(search);
  if (input.filters.scope === "SELECTED") {
    conditions.push(inArray(productVariants.id, input.filters.variantIds!.map(Number)));
  }

  const baseQuery = tx
    .select({
      variantId: productVariants.id,
      productId: products.id,
      productName: products.name,
      variantName: productVariants.variantName,
      color: productVariants.color,
      size: productVariants.size,
      sku: productVariants.sku,
      oldCost: productVariants.costPrice,
      categoryName: categories.name,
      isService: products.isService,
      isBundle: products.isBundle,
      isConsignment: products.isConsignment,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(and(...conditions))
    .orderBy(asc(productVariants.id))
    .limit(COST_WAVE_MAX_ITEMS + 1);
  const raw = lock ? await baseQuery.for("update") : await baseQuery;
  if (raw.length > COST_WAVE_MAX_ITEMS) {
    throw new TRPCError({
      code: "PAYLOAD_TOO_LARGE",
      message: `النطاق يتجاوز ${COST_WAVE_MAX_ITEMS.toLocaleString("en-US")} صنف؛ قسّمه إلى موجات أصغر`,
    });
  }
  const variantIds = raw.map((row) => Number(row.variantId));
  const stockBase = variantIds.length
    ? tx
      .select({
        variantId: branchStock.variantId,
        branchId: branchStock.branchId,
        quantity: branchStock.quantity,
      })
      .from(branchStock)
      .where(inArray(branchStock.variantId, variantIds))
      .orderBy(asc(branchStock.variantId), asc(branchStock.branchId))
    : null;
  const stock = stockBase ? (lock ? await stockBase.for("update") : await stockBase) : [];
  const stockByVariant = new Map<number, BranchQuantitySnapshot[]>();
  for (const row of stock) {
    const quantity = Number(row.quantity ?? 0);
    if (quantity === 0) continue;
    const variantId = Number(row.variantId);
    const list = stockByVariant.get(variantId) ?? [];
    list.push({ branchId: Number(row.branchId), quantity });
    stockByVariant.set(variantId, list);
  }

  const pendingRequestIds = new Set<number>();
  const pendingWaveIds = new Set<number>();
  if (variantIds.length) {
    const pendingRequests = await tx
      .select({ variantId: costRevaluationRequests.variantId })
      .from(costRevaluationRequests)
      .where(
        and(
          eq(costRevaluationRequests.status, "PENDING_APPROVAL"),
          inArray(costRevaluationRequests.variantId, variantIds),
        ),
      );
    for (const row of pendingRequests) pendingRequestIds.add(Number(row.variantId));
    const pendingItems = await tx
      .select({ variantId: costUpdateWaveItems.variantId })
      .from(costUpdateWaveItems)
      .innerJoin(costUpdateWaves, eq(costUpdateWaves.id, costUpdateWaveItems.waveId))
      .where(
        and(
          eq(costUpdateWaves.status, "PENDING_APPROVAL"),
          inArray(costUpdateWaveItems.variantId, variantIds),
        ),
      );
    for (const row of pendingItems) pendingWaveIds.add(Number(row.variantId));
  }

  const rows: CostWavePreviewRow[] = [];
  const skipped: CostWaveSkippedRow[] = [];
  for (const row of raw) {
    const variantId = Number(row.variantId);
    const branchQuantities = stockByVariant.get(variantId) ?? [];
    assertCostRevaluationBranchAuthority(branchQuantities, actor, "إنشاء موجة");
    const variantLabel = row.variantName || [row.color, row.size].filter(Boolean).join(" / ") || row.sku;
    const oldCost = round2(money(row.oldCost ?? "0"));
    const baseSkipped = {
      variantId,
      productName: row.productName,
      variantLabel,
      sku: row.sku,
      oldCost: oldCost.toFixed(2),
    };
    let skipReason: CostWaveSkipReason | null = row.isService
      ? "SERVICE"
      : row.isBundle
        ? "BUNDLE"
        : row.isConsignment
          ? "CONSIGNMENT"
          : branchQuantities.some((entry) => entry.quantity < 0)
            ? "NEGATIVE_STOCK"
            : pendingRequestIds.has(variantId) || pendingWaveIds.has(variantId)
              ? "OPEN_GOVERNED_CHANGE"
              : null;
    const outcome = skipReason
      ? null
      : applyCostWaveRule(oldCost, { ruleType: input.ruleType, changeValue: input.changeValue });
    if (!skipReason && outcome?.newCost == null) skipReason = "UNCHANGED";
    if (
      !skipReason &&
      input.purpose === "IMPAIRMENT" &&
      money(outcome!.newCost!).gt(oldCost)
    ) {
      skipReason = "IMPAIRMENT_INCREASE";
    }
    if (skipReason) {
      skipped.push({ ...baseSkipped, reason: skipReason });
      continue;
    }

    const newCost = round2(money(outcome!.newCost!));
    const quantity = totalBranchQuantity(branchQuantities);
    const before = round2(oldCost.times(quantity));
    const after = round2(newCost.times(quantity));
    rows.push({
      variantId,
      productId: Number(row.productId),
      productName: row.productName,
      variantLabel,
      sku: row.sku,
      categoryName: row.categoryName ?? null,
      oldCost: oldCost.toFixed(2),
      newCost: newCost.toFixed(2),
      branchQuantities,
      expectedQuantity: quantity,
      inventoryValueBefore: before.toFixed(2),
      inventoryValueAfter: after.toFixed(2),
      expectedValueDelta: after.minus(before).toFixed(2),
    });
  }

  const beforeTotal = rows.reduce((sum, row) => sum.plus(row.inventoryValueBefore), new Decimal(0));
  const afterTotal = rows.reduce((sum, row) => sum.plus(row.inventoryValueAfter), new Decimal(0));
  const fingerprint = costWaveFingerprint(input, rows);
  return {
    rows,
    skipped,
    fingerprint,
    totals: {
      itemCount: rows.length,
      skippedCount: skipped.length,
      expectedQuantity: rows.reduce((sum, row) => sum + row.expectedQuantity, 0),
      inventoryValueBefore: round2(beforeTotal).toFixed(2),
      inventoryValueAfter: round2(afterTotal).toFixed(2),
      expectedValueDelta: round2(afterTotal.minus(beforeTotal)).toFixed(2),
    },
  };
}

export async function previewCostWave(
  input: PreviewCostWaveInput,
  actor: Actor,
): Promise<CostWavePreview> {
  assertManagerActor(actor);
  return withTx((tx) => computeCostWave(tx, input, actor, false), { gate: "NONE" });
}

function waveSnapshot(preview: CostWavePreview, extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    fingerprint: preview.fingerprint,
    ...preview.totals,
    ...extra,
  };
}

async function insertEvent(
  tx: Tx,
  input: {
    waveId: number;
    stage: CostWaveEventStage;
    actorUserId: number;
    fingerprint: string;
    snapshot: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(costUpdateWaveEvents).values({
    waveId: input.waveId,
    stage: input.stage,
    actorUserId: input.actorUserId,
    snapshotFingerprint: input.fingerprint,
    snapshotJson: input.snapshot,
  });
}

export async function submitCostWave(
  input: SubmitCostWaveInput,
  actor: Actor,
): Promise<{ waveId: number; status: "PENDING_APPROVAL"; approvalCount: 0 }> {
  assertManagerActor(actor);
  const name = input.name.trim();
  const reason = input.reason.trim();
  if (name.length < 3) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "اسم الموجة يجب أن يكون ثلاثة محارف على الأقل" });
  }
  if (reason.length < COST_WAVE_MIN_REASON_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `سبب التغيير إلزامي (${COST_WAVE_MIN_REASON_LENGTH} محارف على الأقل)`,
    });
  }

  return withTx(async (tx) => {
    const preview = await computeCostWave(tx, input, actor, true);
    if (preview.rows.length === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا توجد أصناف مؤهلة في نطاق الموجة" });
    }
    if (preview.fingerprint !== input.previewFingerprint) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّرت بيانات المعاينة؛ أعد المعاينة قبل إرسال الموجة للاعتماد",
      });
    }

    const insert = await tx.insert(costUpdateWaves).values({
      branchId: actor.branchId,
      name,
      description: input.description?.trim() || null,
      reason,
      purpose: input.purpose,
      ruleType: input.ruleType,
      changeValue: new Decimal(input.changeValue).toDecimalPlaces(4).toFixed(4),
      scopeJson: {
        version: 1,
        scope: input.filters.scope,
        categoryId: input.filters.categoryId ?? null,
        productSearch: input.filters.productSearch?.trim() || null,
        variantIds: input.filters.variantIds?.map(Number) ?? [],
      },
      previewFingerprint: preview.fingerprint,
      itemCount: preview.totals.itemCount,
      skippedCount: preview.totals.skippedCount,
      expectedQuantity: preview.totals.expectedQuantity,
      inventoryValueBefore: preview.totals.inventoryValueBefore,
      inventoryValueAfter: preview.totals.inventoryValueAfter,
      expectedValueDelta: preview.totals.expectedValueDelta,
      requiredApprovals: COST_WAVE_REQUIRED_APPROVALS,
      approvalCount: 0,
      status: "PENDING_APPROVAL",
      createdBy: actor.userId,
    });
    const waveId = extractInsertId(insert);
    for (let offset = 0; offset < preview.rows.length; offset += 250) {
      const chunk = preview.rows.slice(offset, offset + 250);
      await tx.insert(costUpdateWaveItems).values(
        chunk.map((row) => ({
          waveId,
          variantId: row.variantId,
          productNameSnapshot: row.productName,
          variantLabelSnapshot: row.variantLabel,
          skuSnapshot: row.sku,
          categoryNameSnapshot: row.categoryName,
          oldCost: row.oldCost,
          newCost: row.newCost,
          expectedQuantity: row.expectedQuantity,
          branchQuantities: row.branchQuantities,
          inventoryValueBefore: row.inventoryValueBefore,
          inventoryValueAfter: row.inventoryValueAfter,
          expectedValueDelta: row.expectedValueDelta,
        })),
      );
    }
    await insertEvent(tx, {
      waveId,
      stage: "SUBMITTED",
      actorUserId: actor.userId,
      fingerprint: preview.fingerprint,
      snapshot: waveSnapshot(preview, {
        name,
        purpose: input.purpose,
        ruleType: input.ruleType,
        changeValue: new Decimal(input.changeValue).toDecimalPlaces(4).toFixed(4),
        reason,
      }),
    });
    return { waveId, status: "PENDING_APPROVAL" as const, approvalCount: 0 as const };
  });
}

function assertChecker(wave: { createdBy: number }, actor: Actor): void {
  if (Number(wave.createdBy) === actor.userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "منشئ الموجة لا يملك اعتمادها أو رفضها، حتى بصلاحية الإدارة",
    });
  }
}

async function loadWaveItems(tx: Tx, waveId: number) {
  return tx
    .select()
    .from(costUpdateWaveItems)
    .where(eq(costUpdateWaveItems.waveId, waveId))
    .orderBy(asc(costUpdateWaveItems.variantId));
}

function fingerprintPersistedWave(
  wave: typeof costUpdateWaves.$inferSelect,
  items: Awaited<ReturnType<typeof loadWaveItems>>,
): string | null {
  const scope = wave.scopeJson as {
    scope?: CostWaveScope;
    categoryId?: number | null;
    productSearch?: string | null;
    variantIds?: number[] | null;
  } | null;
  if (!scope?.scope || !["FILTERED", "SELECTED", "ALL"].includes(scope.scope)) return null;
  return costWaveFingerprint(
    {
      purpose: wave.purpose as CostWavePurpose,
      ruleType: wave.ruleType as CostWaveRuleType,
      changeValue: new Decimal(wave.changeValue).toDecimalPlaces(4).toFixed(4),
      filters: {
        scope: scope.scope,
        categoryId: scope.categoryId ?? null,
        productSearch: scope.productSearch ?? null,
        variantIds: scope.variantIds ?? [],
      },
    },
    items.map((item) => ({
      variantId: Number(item.variantId),
      oldCost: money(item.oldCost).toFixed(2),
      newCost: money(item.newCost).toFixed(2),
      branchQuantities: parseBranchQuantitySnapshot(item.branchQuantities),
      expectedValueDelta: money(item.expectedValueDelta).toFixed(2),
    })),
  );
}

function approvalSnapshot(
  wave: typeof costUpdateWaves.$inferSelect,
  approvalNumber: number,
  extra: Record<string, unknown> = {},
) {
  return {
    version: 1,
    fingerprint: wave.previewFingerprint,
    itemCount: Number(wave.itemCount),
    expectedQuantity: Number(wave.expectedQuantity),
    inventoryValueBefore: money(wave.inventoryValueBefore).toFixed(2),
    inventoryValueAfter: money(wave.inventoryValueAfter).toFixed(2),
    expectedValueDelta: money(wave.expectedValueDelta).toFixed(2),
    approvalNumber,
    ...extra,
  };
}

async function checkWaveItems(
  tx: Tx,
  items: Awaited<ReturnType<typeof loadWaveItems>>,
  actor: Actor,
): Promise<CostRevaluationSnapshotCheck[]> {
  return lockAndCheckCostRevaluationSnapshots(
    tx,
    items.map((item) => ({
      variantId: Number(item.variantId),
      expectedOldCost: money(item.oldCost).toFixed(2),
      expectedBranchQuantities: parseBranchQuantitySnapshot(item.branchQuantities),
      actor,
      authorityVerb: "اعتماد موجة",
    })),
  );
}

async function markWaveConflicted(
  tx: Tx,
  wave: typeof costUpdateWaves.$inferSelect,
  actor: Actor,
  failures: Extract<CostRevaluationSnapshotCheck, { ok: false }>[],
): Promise<{ waveId: number; status: "CONFLICTED"; approvalCount: number; appliedItems: 0 }> {
  const reason = failures.length === 1
    ? failures[0].message
    : `${failures[0].message}، و${failures.length - 1} تعارض إضافي`;
  const snapshot = approvalSnapshot(wave, Number(wave.approvalCount), {
    conflicts: failures.map((failure) => ({
      variantId: failure.variantId,
      reason: failure.reason,
      message: failure.message,
      actual: failure.actual ?? null,
    })),
  });
  const fingerprint = stableHash(snapshot);
  await tx
    .update(costUpdateWaves)
    .set({ status: "CONFLICTED", conflictReason: reason })
    .where(eq(costUpdateWaves.id, wave.id));
  await insertEvent(tx, {
    waveId: Number(wave.id),
    stage: "CONFLICTED",
    actorUserId: actor.userId,
    fingerprint,
    snapshot,
  });
  return {
    waveId: Number(wave.id),
    status: "CONFLICTED",
    approvalCount: Number(wave.approvalCount),
    appliedItems: 0,
  };
}

export async function approveCostWave(
  waveId: number,
  actor: Actor,
): Promise<{
  waveId: number;
  status: "PENDING_APPROVAL" | "APPLIED" | "CONFLICTED";
  approvalCount: number;
  appliedItems: number;
  postedEntries?: number;
}> {
  assertManagerActor(actor);
  return withTx(async (tx) => {
    const wave = (
      await tx
        .select()
        .from(costUpdateWaves)
        .where(eq(costUpdateWaves.id, waveId))
        .for("update")
        .limit(1)
    )[0];
    if (!wave) throw new TRPCError({ code: "NOT_FOUND", message: "موجة التكلفة غير موجودة" });
    if (!canCrossBranches(actor) && Number(wave.branchId) !== actor.branchId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الموجة تتبع فرعاً آخر" });
    }
    if (wave.status !== "PENDING_APPROVAL") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الموجة ليست في انتظار الاعتماد" });
    }
    assertChecker({ createdBy: Number(wave.createdBy) }, actor);
    const prior = (
      await tx
        .select({ id: costUpdateWaveApprovals.id })
        .from(costUpdateWaveApprovals)
        .where(
          and(
            eq(costUpdateWaveApprovals.waveId, waveId),
            eq(costUpdateWaveApprovals.approverId, actor.userId),
          ),
        )
        .limit(1)
    )[0];
    if (prior) {
      throw new TRPCError({ code: "CONFLICT", message: "سجّلت قرارك على هذه الموجة مسبقاً" });
    }

    const items = await loadWaveItems(tx, waveId);
    if (items.length !== Number(wave.itemCount)) {
      return markWaveConflicted(tx, wave, actor, [{
        ok: false,
        variantId: 0,
        reason: "INELIGIBLE",
        message: "عدد أصناف المستند لا يطابق رأس الموجة",
      }]);
    }
    const persistedFingerprint = fingerprintPersistedWave(wave, items);
    if (persistedFingerprint !== wave.previewFingerprint) {
      return markWaveConflicted(tx, wave, actor, [{
        ok: false,
        variantId: 0,
        reason: "INELIGIBLE",
        message: "بصمة تفاصيل الموجة لا تطابق البصمة الموقعة عند الإرسال",
      }]);
    }
    const recordedApprovals = await tx
      .select({ id: costUpdateWaveApprovals.id })
      .from(costUpdateWaveApprovals)
      .where(
        and(
          eq(costUpdateWaveApprovals.waveId, waveId),
          eq(costUpdateWaveApprovals.decision, "APPROVED"),
        ),
      );
    if (recordedApprovals.length !== Number(wave.approvalCount)) {
      return markWaveConflicted(tx, wave, actor, [{
        ok: false,
        variantId: 0,
        reason: "INELIGIBLE",
        message: "عدد قرارات الاعتماد لا يطابق عداد رأس الموجة",
      }]);
    }
    const checks = await checkWaveItems(tx, items, actor);
    const failures = checks.filter(
      (check): check is Extract<CostRevaluationSnapshotCheck, { ok: false }> => !check.ok,
    );
    if (failures.length) return markWaveConflicted(tx, wave, actor, failures);

    const approvalNumber = Number(wave.approvalCount) + 1;
    if (approvalNumber > COST_WAVE_REQUIRED_APPROVALS) {
      throw new TRPCError({ code: "CONFLICT", message: "اكتمل عدد الاعتمادات المطلوب مسبقاً" });
    }
    await tx.insert(costUpdateWaveApprovals).values({
      waveId,
      approverId: actor.userId,
      decision: "APPROVED",
      snapshotFingerprint: wave.previewFingerprint,
    });
    await insertEvent(tx, {
      waveId,
      stage: approvalNumber === 1 ? "APPROVAL_1" : "APPROVAL_2",
      actorUserId: actor.userId,
      fingerprint: wave.previewFingerprint,
      snapshot: approvalSnapshot(wave, approvalNumber),
    });

    if (approvalNumber < COST_WAVE_REQUIRED_APPROVALS) {
      await tx
        .update(costUpdateWaves)
        .set({ approvalCount: approvalNumber })
        .where(eq(costUpdateWaves.id, waveId));
      return { waveId, status: "PENDING_APPROVAL", approvalCount: approvalNumber, appliedItems: 0 };
    }

    const targetByVariant = new Map(
      checks.filter((check) => check.ok).map((check) => [check.target.variantId, check.target]),
    );
    let postedEntries = 0;
    for (const item of items) {
      const target = targetByVariant.get(Number(item.variantId));
      if (!target) throw new Error(`missing locked target for variant ${item.variantId}`);
      const posted = await postLockedCostRevaluation(tx, target, {
        newCost: money(item.newCost).toFixed(2),
        purpose: wave.purpose as CostWavePurpose,
        reason: wave.reason,
        actor,
        requestedBy: Number(wave.createdBy),
        sourceType: "WAVE",
        sourceId: waveId,
        waveItemId: Number(item.id),
      });
      postedEntries += posted.postedEntries;
    }
    const now = new Date();
    await tx
      .update(costUpdateWaves)
      .set({
        status: "APPLIED",
        approvalCount: COST_WAVE_REQUIRED_APPROVALS,
        appliedBy: actor.userId,
        appliedAt: now,
      })
      .where(eq(costUpdateWaves.id, waveId));
    await insertEvent(tx, {
      waveId,
      stage: "APPLIED",
      actorUserId: actor.userId,
      fingerprint: wave.previewFingerprint,
      snapshot: approvalSnapshot(wave, approvalNumber, {
        appliedItems: items.length,
        postedEntries,
        appliedAt: now.toISOString(),
      }),
    });
    return {
      waveId,
      status: "APPLIED",
      approvalCount: COST_WAVE_REQUIRED_APPROVALS,
      appliedItems: items.length,
      postedEntries,
    };
  });
}

export async function rejectCostWave(
  waveId: number,
  reasonInput: string,
  actor: Actor,
): Promise<{ waveId: number; status: "REJECTED" }> {
  assertManagerActor(actor);
  const reason = reasonInput.trim();
  if (reason.length < COST_WAVE_MIN_REASON_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `سبب الرفض يجب أن يكون ${COST_WAVE_MIN_REASON_LENGTH} محارف على الأقل`,
    });
  }
  return withTx(async (tx) => {
    const wave = (
      await tx
        .select()
        .from(costUpdateWaves)
        .where(eq(costUpdateWaves.id, waveId))
        .for("update")
        .limit(1)
    )[0];
    if (!wave) throw new TRPCError({ code: "NOT_FOUND", message: "موجة التكلفة غير موجودة" });
    if (!canCrossBranches(actor) && Number(wave.branchId) !== actor.branchId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الموجة تتبع فرعاً آخر" });
    }
    if (wave.status !== "PENDING_APPROVAL") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الموجة ليست في انتظار قرار" });
    }
    assertChecker({ createdBy: Number(wave.createdBy) }, actor);
    const prior = (
      await tx
        .select({ id: costUpdateWaveApprovals.id })
        .from(costUpdateWaveApprovals)
        .where(
          and(
            eq(costUpdateWaveApprovals.waveId, waveId),
            eq(costUpdateWaveApprovals.approverId, actor.userId),
          ),
        )
        .limit(1)
    )[0];
    if (prior) throw new TRPCError({ code: "CONFLICT", message: "سجّلت قرارك مسبقاً" });

    await tx.insert(costUpdateWaveApprovals).values({
      waveId,
      approverId: actor.userId,
      decision: "REJECTED",
      reason,
      snapshotFingerprint: wave.previewFingerprint,
    });
    const now = new Date();
    await tx
      .update(costUpdateWaves)
      .set({ status: "REJECTED", rejectedBy: actor.userId, rejectedAt: now, rejectionReason: reason })
      .where(eq(costUpdateWaves.id, waveId));
    await insertEvent(tx, {
      waveId,
      stage: "REJECTED",
      actorUserId: actor.userId,
      fingerprint: wave.previewFingerprint,
      snapshot: approvalSnapshot(wave, Number(wave.approvalCount), {
        rejectionReason: reason,
        rejectedAt: now.toISOString(),
      }),
    });
    return { waveId, status: "REJECTED" };
  });
}

export type CostWaveListView = "AWAITING_MINE" | "MY_REQUESTS" | "HISTORY";

export async function listCostWaves(
  filter: { view?: CostWaveListView; status?: CostWaveStatus; limit?: number },
  actor: Actor,
) {
  assertManagerActor(actor);
  return withTx(async (tx) => {
    const conditions: SQL[] = [];
    if (!canCrossBranches(actor)) conditions.push(eq(costUpdateWaves.branchId, actor.branchId));
    if (filter.status) conditions.push(eq(costUpdateWaves.status, filter.status));
    if (filter.view === "MY_REQUESTS") conditions.push(eq(costUpdateWaves.createdBy, actor.userId));
    if (filter.view === "AWAITING_MINE") {
      conditions.push(
        eq(costUpdateWaves.status, "PENDING_APPROVAL"),
        ne(costUpdateWaves.createdBy, actor.userId),
        notExists(
          tx
            .select({ id: costUpdateWaveApprovals.id })
            .from(costUpdateWaveApprovals)
            .where(
              and(
                eq(costUpdateWaveApprovals.waveId, costUpdateWaves.id),
                eq(costUpdateWaveApprovals.approverId, actor.userId),
              ),
            ),
        ),
      );
    }
    const rows = await tx
      .select({
        id: costUpdateWaves.id,
        name: costUpdateWaves.name,
        purpose: costUpdateWaves.purpose,
        ruleType: costUpdateWaves.ruleType,
        changeValue: costUpdateWaves.changeValue,
        itemCount: costUpdateWaves.itemCount,
        skippedCount: costUpdateWaves.skippedCount,
        expectedQuantity: costUpdateWaves.expectedQuantity,
        inventoryValueBefore: costUpdateWaves.inventoryValueBefore,
        inventoryValueAfter: costUpdateWaves.inventoryValueAfter,
        expectedValueDelta: costUpdateWaves.expectedValueDelta,
        requiredApprovals: costUpdateWaves.requiredApprovals,
        approvalCount: costUpdateWaves.approvalCount,
        status: costUpdateWaves.status,
        createdBy: costUpdateWaves.createdBy,
        createdByName: users.name,
        createdAt: costUpdateWaves.createdAt,
        appliedAt: costUpdateWaves.appliedAt,
        rejectionReason: costUpdateWaves.rejectionReason,
        conflictReason: costUpdateWaves.conflictReason,
      })
      .from(costUpdateWaves)
      .leftJoin(users, eq(users.id, costUpdateWaves.createdBy))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(costUpdateWaves.id))
      .limit(Math.min(Math.max(filter.limit ?? 100, 1), 200));
    return rows.map((row) => ({
      ...row,
      id: Number(row.id),
      changeValue: new Decimal(row.changeValue).toDecimalPlaces(4).toFixed(4),
      itemCount: Number(row.itemCount),
      skippedCount: Number(row.skippedCount),
      expectedQuantity: Number(row.expectedQuantity),
      inventoryValueBefore: money(row.inventoryValueBefore).toFixed(2),
      inventoryValueAfter: money(row.inventoryValueAfter).toFixed(2),
      expectedValueDelta: money(row.expectedValueDelta).toFixed(2),
      requiredApprovals: Number(row.requiredApprovals),
      approvalCount: Number(row.approvalCount),
    }));
  }, { gate: "NONE" });
}

export async function getCostWave(waveId: number, actor: Actor) {
  assertManagerActor(actor);
  return withTx(async (tx) => {
    const wave = (
      await tx
        .select({
          id: costUpdateWaves.id,
          branchId: costUpdateWaves.branchId,
          name: costUpdateWaves.name,
          description: costUpdateWaves.description,
          reason: costUpdateWaves.reason,
          purpose: costUpdateWaves.purpose,
          ruleType: costUpdateWaves.ruleType,
          changeValue: costUpdateWaves.changeValue,
          scopeJson: costUpdateWaves.scopeJson,
          previewFingerprint: costUpdateWaves.previewFingerprint,
          itemCount: costUpdateWaves.itemCount,
          skippedCount: costUpdateWaves.skippedCount,
          expectedQuantity: costUpdateWaves.expectedQuantity,
          inventoryValueBefore: costUpdateWaves.inventoryValueBefore,
          inventoryValueAfter: costUpdateWaves.inventoryValueAfter,
          expectedValueDelta: costUpdateWaves.expectedValueDelta,
          requiredApprovals: costUpdateWaves.requiredApprovals,
          approvalCount: costUpdateWaves.approvalCount,
          status: costUpdateWaves.status,
          createdBy: costUpdateWaves.createdBy,
          createdByName: users.name,
          createdAt: costUpdateWaves.createdAt,
          appliedAt: costUpdateWaves.appliedAt,
          rejectedAt: costUpdateWaves.rejectedAt,
          rejectionReason: costUpdateWaves.rejectionReason,
          conflictReason: costUpdateWaves.conflictReason,
        })
        .from(costUpdateWaves)
        .leftJoin(users, eq(users.id, costUpdateWaves.createdBy))
        .where(eq(costUpdateWaves.id, waveId))
        .limit(1)
    )[0];
    if (!wave) throw new TRPCError({ code: "NOT_FOUND", message: "موجة التكلفة غير موجودة" });
    if (!canCrossBranches(actor) && Number(wave.branchId) !== actor.branchId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الموجة تتبع فرعاً آخر" });
    }
    const [items, approvals, events] = await Promise.all([
      tx
        .select()
        .from(costUpdateWaveItems)
        .where(eq(costUpdateWaveItems.waveId, waveId))
        .orderBy(asc(costUpdateWaveItems.variantId)),
      tx
        .select({
          id: costUpdateWaveApprovals.id,
          approverId: costUpdateWaveApprovals.approverId,
          approverName: users.name,
          decision: costUpdateWaveApprovals.decision,
          reason: costUpdateWaveApprovals.reason,
          snapshotFingerprint: costUpdateWaveApprovals.snapshotFingerprint,
          decidedAt: costUpdateWaveApprovals.decidedAt,
        })
        .from(costUpdateWaveApprovals)
        .leftJoin(users, eq(users.id, costUpdateWaveApprovals.approverId))
        .where(eq(costUpdateWaveApprovals.waveId, waveId))
        .orderBy(asc(costUpdateWaveApprovals.id)),
      tx
        .select({
          id: costUpdateWaveEvents.id,
          stage: costUpdateWaveEvents.stage,
          actorUserId: costUpdateWaveEvents.actorUserId,
          actorName: users.name,
          snapshotFingerprint: costUpdateWaveEvents.snapshotFingerprint,
          snapshotJson: costUpdateWaveEvents.snapshotJson,
          createdAt: costUpdateWaveEvents.createdAt,
        })
        .from(costUpdateWaveEvents)
        .leftJoin(users, eq(users.id, costUpdateWaveEvents.actorUserId))
        .where(eq(costUpdateWaveEvents.waveId, waveId))
        .orderBy(asc(costUpdateWaveEvents.id)),
    ]);
    const branchIds = Array.from(
      new Set(
        items.flatMap((item) =>
          parseBranchQuantitySnapshot(item.branchQuantities).map((row) => row.branchId),
        ),
      ),
    );
    const branchRows = branchIds.length
      ? await tx
        .select({ id: branches.id, name: branches.name })
        .from(branches)
        .where(inArray(branches.id, branchIds))
      : [];
    const branchNameById = new Map(
      branchRows.map((branch) => [Number(branch.id), branch.name ?? null]),
    );
    return {
      wave: {
        ...wave,
        id: Number(wave.id),
        branchId: Number(wave.branchId),
        itemCount: Number(wave.itemCount),
        skippedCount: Number(wave.skippedCount),
        expectedQuantity: Number(wave.expectedQuantity),
        requiredApprovals: Number(wave.requiredApprovals),
        approvalCount: Number(wave.approvalCount),
        changeValue: new Decimal(wave.changeValue).toDecimalPlaces(4).toFixed(4),
        inventoryValueBefore: money(wave.inventoryValueBefore).toFixed(2),
        inventoryValueAfter: money(wave.inventoryValueAfter).toFixed(2),
        expectedValueDelta: money(wave.expectedValueDelta).toFixed(2),
      },
      items: items.map((item) => ({
        ...item,
        id: Number(item.id),
        waveId: Number(item.waveId),
        variantId: Number(item.variantId),
        expectedQuantity: Number(item.expectedQuantity),
        oldCost: money(item.oldCost).toFixed(2),
        newCost: money(item.newCost).toFixed(2),
        inventoryValueBefore: money(item.inventoryValueBefore).toFixed(2),
        inventoryValueAfter: money(item.inventoryValueAfter).toFixed(2),
        expectedValueDelta: money(item.expectedValueDelta).toFixed(2),
        branchQuantities: parseBranchQuantitySnapshot(item.branchQuantities).map((row) => ({
          ...row,
          branchName: branchNameById.get(row.branchId) ?? null,
        })),
      })),
      approvals: approvals.map((approval) => ({
        ...approval,
        id: Number(approval.id),
        approverId: Number(approval.approverId),
      })),
      events: events.map((event) => ({
        ...event,
        id: Number(event.id),
        actorUserId: Number(event.actorUserId),
      })),
    };
  }, { gate: "NONE" });
}
