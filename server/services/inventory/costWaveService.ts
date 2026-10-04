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
  like,
  lt,
  ne,
  notExists,
  or,
  sql,
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
import { costRevaluationApprovalTrigger } from "../../../shared/approvalTriggers";
import {
  COST_WAVE_MAX_CHANGE_VALUE,
  COST_WAVE_MAX_ITEMS,
  COST_WAVE_MAX_PERCENT,
  COST_WAVE_MAX_REASON_LENGTH,
  COST_WAVE_MAX_SELECTED_ITEMS,
  COST_WAVE_MIN_REASON_LENGTH,
  COST_WAVE_REQUIRED_APPROVALS,
  COST_WAVE_SKIP_REASONS,
  applyCostWaveRule,
  type CostWaveEventStage,
  type CostWavePurpose,
  type CostWaveRuleType,
  type CostWaveSkipReason,
  type CostWaveScope,
  type CostWaveStatus,
} from "../../../shared/costWave";
import { appErrorMessage } from "../../../shared/errors";
import {
  moduleAccessAllowed,
  type PermissionMap,
  type RoleKey,
} from "../../../shared/permissions";
import { variantDescriptor } from "../../../shared/variantDisplay";
import { isRolloutOn } from "../../config/rolloutFlags";
import { getDb, type Tx } from "../../db";
import { canCrossBranches } from "../../lib/branchAuthority";
import { extractInsertId } from "../../lib/insertId";
import { createAppNotification } from "../appNotificationService";
import { assertApprover, resolveApprovalActor } from "../approval/ownerGate";
import { buildVariantCatalogSearchWhere } from "../catalog/search";
import { money, round2, toDbMoney } from "../money";
import { enqueuePostCommit, type Actor, withTx } from "../tx";
import {
  assertCostRevaluationBranchAuthority,
  lockAndCheckCostRevaluationSnapshots,
  parseBranchQuantitySnapshot,
  postLockedCostRevaluation,
  totalBranchQuantity,
  type BranchQuantitySnapshot,
  type CostRevaluationSnapshotCheck,
} from "./costRevaluationPosting";

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
  if (
    !canCrossBranches(actor) &&
    (!Number.isInteger(actor.branchId) || actor.branchId <= 0)
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر فتح موجات التكلفة",
        why: "لا يوجد فرع صالح للمستخدم",
        doThis: "اسند فرعاً للمستخدم ثم أعد المحاولة",
      }),
    });
  }
}

function assertCreationBranch(actor: Actor): void {
  if (!Number.isInteger(actor.branchId) || actor.branchId <= 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر إنشاء معاينة موجة التكلفة",
        why: "فرع المستند غير محدد",
        doThis: "حدد الفرع ثم أعد المعاينة",
      }),
    });
  }
}

function assertScope(filters: CostWaveFilters): void {
  const hasCategory = filters.categoryId != null && filters.categoryId > 0;
  const hasSearch = !!filters.productSearch?.trim();
  const hasIds =
    Array.isArray(filters.variantIds) && filters.variantIds.length > 0;
  if (filters.scope === "FILTERED") {
    if (!hasCategory && !hasSearch) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تحديد نطاق الموجة",
          why: "نطاق الفلاتر بلا فئة أو عبارة بحث",
          doThis: "حدد فئة أو بحثاً أو اختر كل الأصناف المؤهلة",
        }),
      });
    }
    if (hasIds) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تحديد نطاق الموجة",
          why: "لا تجمع الاختيار اليدوي مع نطاق الفلاتر",
          doThis: "استخدم نطاقاً واحداً فقط",
        }),
      });
    }
    return;
  }
  if (filters.scope === "SELECTED") {
    if (!hasIds) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تحديد نطاق الموجة",
          why: "لم تحدد أي صنف للاختيار اليدوي",
          doThis: "اختر صنفاً واحداً على الأقل",
        }),
      });
    }
    const uniqueIds = new Set(filters.variantIds!.map(Number));
    if (
      uniqueIds.size !== filters.variantIds!.length ||
      uniqueIds.size > COST_WAVE_MAX_SELECTED_ITEMS
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر قبول الاختيار اليدوي",
          why: `القائمة مكررة أو تتجاوز ${COST_WAVE_MAX_SELECTED_ITEMS} صنفاً`,
          doThis: "أزل التكرار أو قسم الأصناف إلى موجات أصغر",
        }),
      });
    }
    if (hasCategory || hasSearch) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تحديد نطاق الموجة",
          why: "لا تجمع الاختيار اليدوي مع نطاق الفلاتر",
          doThis: "استخدم نطاقاً واحداً فقط",
        }),
      });
    }
    return;
  }
  if (hasCategory || hasSearch || hasIds) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تحديد نطاق الموجة",
        why: "نطاق كل الأصناف يحتوي فلاتر مرافقة",
        doThis: "امسح الفلاتر أو اختر نطاق الفلاتر",
      }),
    });
  }
}

function assertRule(input: PreviewCostWaveInput): Decimal {
  assertScope(input.filters);
  const value = money(input.changeValue);
  if (value.gt(COST_WAVE_MAX_CHANGE_VALUE)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر قبول قيمة تغيير التكلفة",
        why: "القيمة تتجاوز حد التخزين " + COST_WAVE_MAX_CHANGE_VALUE,
        doThis: "اخفض القيمة ثم أعد المعاينة",
      }),
    });
  }
  if (value.isNegative() || (input.ruleType !== "SET_COST" && !value.gt(0))) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تطبيق قاعدة التكلفة",
        why:
          input.ruleType === "SET_COST"
            ? "التكلفة المستهدفة سالبة"
            : "قيمة التغيير ليست أكبر من صفر",
        doThis: "أدخل قيمة موجبة أو صفراً عند تعيين تكلفة ثابتة",
      }),
    });
  }
  const isPercentRule =
    input.ruleType === "INCREASE_PERCENT" ||
    input.ruleType === "DECREASE_PERCENT";
  if (isPercentRule && value.gt(COST_WAVE_MAX_PERCENT)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تطبيق نسبة التكلفة",
        why: `النسبة تتجاوز الحد الأقصى ${COST_WAVE_MAX_PERCENT}%`,
        doThis: "اخفض النسبة ثم أعد المعاينة",
      }),
    });
  }
  if (input.ruleType === "DECREASE_PERCENT" && value.gt(100)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر خفض التكلفة",
        why: "النسبة تتجاوز 100% وستنتج تكلفة سالبة",
        doThis: "أدخل نسبة بين 0 و100",
      }),
    });
  }
  if (
    input.purpose === "IMPAIRMENT" &&
    (input.ruleType === "INCREASE_PERCENT" ||
      input.ruleType === "INCREASE_AMOUNT")
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تطبيق هبوط القيمة",
        why: "هبوط القيمة لا يرفع التكلفة والقاعدة المختارة ترفعها",
        doThis: "اختر تعييناً أقل أو قاعدة خفض",
      }),
    });
  }
  return value;
}

async function categoryIdsWithChildren(
  tx: Tx,
  categoryId: number,
): Promise<number[]> {
  const categoriesSnapshot = await tx
    .select({ id: categories.id, parentId: categories.parentId })
    .from(categories);
  const childrenByParent = new Map<number, number[]>();
  for (const row of categoriesSnapshot) {
    if (row.parentId == null) continue;
    const parentId = Number(row.parentId);
    const children = childrenByParent.get(parentId) ?? [];
    children.push(Number(row.id));
    childrenByParent.set(parentId, children);
  }
  const visited = new Set<number>();
  const queue = [categoryId];
  while (queue.length) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...(childrenByParent.get(current) ?? []));
  }
  return Array.from(visited);
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function costWaveDocumentFingerprint(
  previewFingerprint: string,
  input: {
    branchId: number;
    isCrossBranch: boolean;
    name: string;
    description: string | null;
    reason: string;
  },
): string {
  return stableHash({
    version: 1,
    previewFingerprint,
    branchId: input.branchId,
    isCrossBranch: input.isCrossBranch,
    name: input.name,
    description: input.description,
    reason: input.reason,
  });
}

export function costWaveFingerprint(
  input: PreviewCostWaveInput,
  rows: Array<
    Pick<
      CostWavePreviewRow,
      | "variantId"
      | "productName"
      | "variantLabel"
      | "sku"
      | "categoryName"
      | "oldCost"
      | "newCost"
      | "branchQuantities"
      | "expectedQuantity"
      | "inventoryValueBefore"
      | "inventoryValueAfter"
      | "expectedValueDelta"
    >
  >,
  skipped: CostWaveSkippedRow[] = [],
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
      productName: row.productName,
      variantLabel: row.variantLabel,
      sku: row.sku,
      categoryName: row.categoryName,
      oldCost: row.oldCost,
      newCost: row.newCost,
      branchQuantities: row.branchQuantities,
      expectedQuantity: row.expectedQuantity,
      inventoryValueBefore: row.inventoryValueBefore,
      inventoryValueAfter: row.inventoryValueAfter,
      expectedValueDelta: row.expectedValueDelta,
    })),
    skipped: skipped.map((row) => ({
      variantId: row.variantId,
      productName: row.productName,
      variantLabel: row.variantLabel,
      sku: row.sku,
      oldCost: row.oldCost,
      reason: row.reason,
    })),
  });
}

function parseSkippedSnapshot(raw: unknown): CostWaveSkippedRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const row = value as Partial<CostWaveSkippedRow>;
    const reason = row.reason;
    if (
      !Number.isInteger(Number(row.variantId)) ||
      typeof row.productName !== "string" ||
      typeof row.variantLabel !== "string" ||
      typeof row.sku !== "string" ||
      typeof row.oldCost !== "string" ||
      !(COST_WAVE_SKIP_REASONS as readonly string[]).includes(String(reason))
    ) {
      return [];
    }
    return [
      {
        variantId: Number(row.variantId),
        productName: row.productName,
        variantLabel: row.variantLabel,
        sku: row.sku,
        oldCost: row.oldCost,
        reason: reason as CostWaveSkipReason,
      },
    ];
  });
}

async function computeCostWave(
  tx: Tx,
  input: PreviewCostWaveInput,
  actor: Actor,
  lock: boolean,
): Promise<CostWavePreview> {
  assertRule(input);
  const conditions: SQL[] = [];
  if (input.filters.scope !== "SELECTED") {
    conditions.push(
      eq(products.isActive, true),
      eq(productVariants.isActive, true),
    );
  }
  if (input.filters.categoryId != null && input.filters.categoryId > 0) {
    const ids = await categoryIdsWithChildren(tx, input.filters.categoryId);
    conditions.push(
      ids.length > 1
        ? inArray(products.categoryId, ids)
        : eq(products.categoryId, ids[0]),
    );
  }
  const search = buildVariantCatalogSearchWhere(
    input.filters.productSearch ?? undefined,
  );
  if (search) conditions.push(search);
  if (input.filters.scope === "SELECTED") {
    conditions.push(
      inArray(productVariants.id, input.filters.variantIds!.map(Number)),
    );
  }

  const baseQuery = tx
    .select({
      variantId: productVariants.id,
      productId: products.id,
      productName: products.name,
      variantName: productVariants.variantName,
      variantKind: productVariants.variantKind,
      color: productVariants.color,
      size: productVariants.size,
      sku: productVariants.sku,
      oldCost: productVariants.costPrice,
      categoryName: categories.name,
      productActive: products.isActive,
      variantActive: productVariants.isActive,
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
      message: appErrorMessage({
        what: "تعذّر إنشاء موجة التكلفة",
        why: `النطاق يتجاوز ${COST_WAVE_MAX_ITEMS.toLocaleString("en-US")} صنفاً`,
        doThis: "قسم النطاق إلى موجات أصغر",
      }),
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
  const stock = stockBase
    ? lock
      ? await stockBase.for("update")
      : await stockBase
    : [];
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
    const pendingRequestsQuery = tx
      .select({ variantId: costRevaluationRequests.variantId })
      .from(costRevaluationRequests)
      .where(
        and(
          eq(costRevaluationRequests.status, "PENDING_APPROVAL"),
          inArray(costRevaluationRequests.variantId, variantIds),
        ),
      );
    const pendingRequests = lock
      ? await pendingRequestsQuery.for("update")
      : await pendingRequestsQuery;
    for (const row of pendingRequests)
      pendingRequestIds.add(Number(row.variantId));
    const pendingItemsQuery = tx
      .select({ variantId: costUpdateWaveItems.variantId })
      .from(costUpdateWaveItems)
      .innerJoin(
        costUpdateWaves,
        eq(costUpdateWaves.id, costUpdateWaveItems.waveId),
      )
      .where(
        and(
          eq(costUpdateWaves.status, "PENDING_APPROVAL"),
          inArray(costUpdateWaveItems.variantId, variantIds),
        ),
      );
    const pendingItems = lock
      ? await pendingItemsQuery.for("update")
      : await pendingItemsQuery;
    for (const row of pendingItems) pendingWaveIds.add(Number(row.variantId));
  }

  const rows: CostWavePreviewRow[] = [];
  const skipped: CostWaveSkippedRow[] = [];
  const foundVariantIds = new Set<number>();
  for (const row of raw) {
    const variantId = Number(row.variantId);
    foundVariantIds.add(variantId);
    const branchQuantities = stockByVariant.get(variantId) ?? [];
    const variantLabel = variantDescriptor(row) || row.sku;
    const oldCost = round2(money(row.oldCost ?? "0"));
    const baseSkipped = {
      variantId,
      productName: row.productName,
      variantLabel,
      sku: row.sku,
      oldCost: oldCost.toFixed(2),
    };
    let skipReason: CostWaveSkipReason | null =
      !row.productActive || !row.variantActive
        ? "INACTIVE"
        : row.isService
          ? "SERVICE"
          : row.isBundle
            ? "BUNDLE"
            : row.isConsignment
              ? "CONSIGNMENT"
              : branchQuantities.some((entry) => entry.quantity < 0)
                ? "NEGATIVE_STOCK"
                : pendingRequestIds.has(variantId) ||
                    pendingWaveIds.has(variantId)
                  ? "OPEN_GOVERNED_CHANGE"
                  : null;
    if (!skipReason) {
      assertCostRevaluationBranchAuthority(
        branchQuantities,
        actor,
        "إنشاء موجة",
      );
    }
    const outcome = skipReason
      ? null
      : applyCostWaveRule(oldCost, {
          ruleType: input.ruleType,
          changeValue: input.changeValue,
        });
    if (!skipReason && outcome?.newCost == null) {
      skipReason =
        outcome?.skipReason === "NEGATIVE_RESULT"
          ? "NEGATIVE_RESULT"
          : "UNCHANGED";
    }
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

  if (input.filters.scope === "SELECTED") {
    for (const variantId of input.filters.variantIds!) {
      if (foundVariantIds.has(Number(variantId))) continue;
      skipped.push({
        variantId: Number(variantId),
        productName: "صنف غير موجود",
        variantLabel: "—",
        sku: "—",
        oldCost: "0.00",
        reason: "NOT_FOUND",
      });
    }
  }

  const beforeTotal = rows.reduce(
    (sum, row) => sum.plus(row.inventoryValueBefore),
    new Decimal(0),
  );
  const afterTotal = rows.reduce(
    (sum, row) => sum.plus(row.inventoryValueAfter),
    new Decimal(0),
  );
  const fingerprint = costWaveFingerprint(input, rows, skipped);
  return {
    rows,
    skipped,
    fingerprint,
    totals: {
      itemCount: rows.length,
      skippedCount: skipped.length,
      expectedQuantity: rows.reduce(
        (sum, row) => sum + row.expectedQuantity,
        0,
      ),
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
  assertCreationBranch(actor);
  return withTx((tx) => computeCostWave(tx, input, actor, false), {
    gate: "NONE",
  });
}

function waveSnapshot(
  preview: CostWavePreview,
  extra: Record<string, unknown> = {},
) {
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
  const eventFingerprint = stableHash({
    version: 1,
    waveId: input.waveId,
    stage: input.stage,
    actorUserId: input.actorUserId,
    documentFingerprint: input.fingerprint,
    snapshot: input.snapshot,
  });
  await tx.insert(costUpdateWaveEvents).values({
    waveId: input.waveId,
    stage: input.stage,
    actorUserId: input.actorUserId,
    snapshotFingerprint: eventFingerprint,
    snapshotJson: input.snapshot,
  });
}

function assertWaveAuthority(
  wave: { branchId: number; isCrossBranch: boolean },
  actor: Actor,
): void {
  if (canCrossBranches(actor)) return;
  if (wave.isCrossBranch) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر فتح موجة التكلفة",
        why: "الموجة تشمل أرصدة في أكثر من فرع",
        doThis: "اطلب من الإدارة العامة مراجعة الموجة",
      }),
    });
  }
  if (Number(wave.branchId) !== actor.branchId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر فتح موجة التكلفة",
        why: "الموجة تتبع فرعاً آخر",
        doThis: "افتح موجة فرعك أو اطلب من الإدارة العامة مراجعتها",
      }),
    });
  }
}

async function notifyCostWaveApprovers(input: {
  waveId: number;
  waveName: string;
  branchId: number;
  isCrossBranch: boolean;
  excludeUserIds: number[];
  approvalNumber: number;
}): Promise<void> {
  const db = getDb();
  if (!db) return;
  const candidates = await db
    .select({
      id: users.id,
      role: users.role,
      branchId: users.branchId,
      isOwner: users.isOwner,
      permissionsOverride: users.permissionsOverride,
    })
    .from(users)
    .where(eq(users.isActive, true));
  const excluded = new Set(input.excludeUserIds);
  await Promise.all(
    candidates
      .filter((candidate) => {
        if (excluded.has(Number(candidate.id))) return false;
        const candidateActor = {
          userId: Number(candidate.id),
          branchId: Number(candidate.branchId ?? 0),
          role: candidate.role,
          isOwner: candidate.isOwner === true,
        };
        if (input.isCrossBranch && !canCrossBranches(candidateActor)) return false;
        if (
          !input.isCrossBranch &&
          !canCrossBranches(candidateActor) &&
          Number(candidate.branchId ?? 0) !== input.branchId
        )
          return false;
        return moduleAccessAllowed(
          candidate.role,
          (candidate.permissionsOverride ?? null) as PermissionMap | null,
          "inventory",
          "FULL",
          ["manager"],
        );
      })
      .map((candidate) =>
        createAppNotification({
          userId: Number(candidate.id),
          kind: "APPROVAL_REQUIRED",
          title: "موجة تكلفة بانتظار الاعتماد",
          body:
            input.approvalNumber === 0
              ? input.waveName
              : `${input.waveName} · اكتمل الاعتماد الأول ويلزم اعتماد ثان مستقل`,
          route: `/inventory?tab=cost-waves&wave=${input.waveId}`,
          eventKey: `cost-wave:${input.waveId}:approval:${input.approvalNumber}:${candidate.id}`,
          entityType: "costUpdateWave",
          entityId: input.waveId,
          requiresAction: true,
        }),
      ),
  );
}

async function notifyCostWaveCreator(input: {
  waveId: number;
  createdBy: number;
  title: string;
  body: string;
  eventSuffix: string;
}): Promise<void> {
  await createAppNotification({
    userId: input.createdBy,
    kind: "APPROVAL_REQUIRED",
    title: input.title,
    body: input.body,
    route: `/inventory?tab=cost-waves&wave=${input.waveId}`,
    eventKey: `cost-wave:${input.waveId}:${input.eventSuffix}`,
    entityType: "costUpdateWave",
    entityId: input.waveId,
    push: false,
  });
}

export async function submitCostWave(
  input: SubmitCostWaveInput,
  actor: Actor,
): Promise<{ waveId: number; status: "PENDING_APPROVAL"; approvalCount: 0 }> {
  assertManagerActor(actor);
  assertCreationBranch(actor);
  const name = input.name.trim();
  const reason = input.reason.trim();
  if (name.length < 3) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إرسال موجة التكلفة",
        why: "اسم الموجة أقصر من 3 محارف",
        doThis: "اكتب اسماً واضحاً من 3 محارف على الأقل",
      }),
    });
  }
  if (reason.length < COST_WAVE_MIN_REASON_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إرسال موجة التكلفة",
        why: `سبب التغيير أقصر من ${COST_WAVE_MIN_REASON_LENGTH} محارف`,
        doThis: "اكتب سبباً عملياً يبرر التغيير",
      }),
    });
  }
  if (reason.length > COST_WAVE_MAX_REASON_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إرسال موجة التكلفة",
        why: `سبب التغيير يتجاوز ${COST_WAVE_MAX_REASON_LENGTH} محرف`,
        doThis: "اختصر السبب مع إبقاء مرجع المستند الداعم",
      }),
    });
  }

  return withTx(async (tx) => {
    const preview = await computeCostWave(tx, input, actor, true);
    if (preview.rows.length === 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إرسال موجة التكلفة",
          why: "لا توجد أصناف مؤهلة في النطاق المختار",
          doThis: "راجع قائمة المستبعدات أو غيّر النطاق",
        }),
      });
    }
    if (preview.fingerprint !== input.previewFingerprint) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر إرسال موجة التكلفة",
          why: "بيانات التكلفة أو الكميات تغيرت بعد المعاينة",
          doThis: "أعد المعاينة ثم راجعها قبل الإرسال",
        }),
      });
    }
    const description = input.description?.trim() || null;
    const isCrossBranch = preview.rows.some((row) =>
      row.branchQuantities.some(
        (quantity) => quantity.branchId !== actor.branchId,
      ),
    );
    const documentFingerprint = costWaveDocumentFingerprint(
      preview.fingerprint,
      {
        branchId: actor.branchId,
        isCrossBranch,
        name,
        description,
        reason,
      },
    );

    const insert = await tx.insert(costUpdateWaves).values({
      branchId: actor.branchId,
      name,
      description,
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
      skippedJson: preview.skipped,
      previewFingerprint: documentFingerprint,
      itemCount: preview.totals.itemCount,
      skippedCount: preview.totals.skippedCount,
      expectedQuantity: preview.totals.expectedQuantity,
      inventoryValueBefore: preview.totals.inventoryValueBefore,
      inventoryValueAfter: preview.totals.inventoryValueAfter,
      expectedValueDelta: preview.totals.expectedValueDelta,
      isCrossBranch,
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
      fingerprint: documentFingerprint,
      snapshot: waveSnapshot(preview, {
        documentFingerprint,
        name,
        purpose: input.purpose,
        ruleType: input.ruleType,
        changeValue: new Decimal(input.changeValue)
          .toDecimalPlaces(4)
          .toFixed(4),
        reason,
      }),
    });
    enqueuePostCommit(tx, () =>
      notifyCostWaveApprovers({
        waveId,
        waveName: name,
        branchId: actor.branchId,
        isCrossBranch,
        excludeUserIds: [actor.userId],
        approvalNumber: 0,
      }),
    );
    return {
      waveId,
      status: "PENDING_APPROVAL" as const,
      approvalCount: 0 as const,
    };
  });
}

function assertChecker(wave: { createdBy: number }, actor: Actor): void {
  if (Number(wave.createdBy) === actor.userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر تسجيل القرار",
        why: "منشئ الموجة لا يعتمدها أو يرفضها بنفسه",
        doThis: "اطلب قرار مستخدم مستقل مخول بالاعتماد",
      }),
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
  if (!scope?.scope || !["FILTERED", "SELECTED", "ALL"].includes(scope.scope))
    return null;
  const previewFingerprint = costWaveFingerprint(
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
      productName: item.productNameSnapshot,
      variantLabel: item.variantLabelSnapshot ?? "",
      sku: item.skuSnapshot ?? "",
      categoryName: item.categoryNameSnapshot ?? null,
      oldCost: money(item.oldCost).toFixed(2),
      newCost: money(item.newCost).toFixed(2),
      branchQuantities: parseBranchQuantitySnapshot(item.branchQuantities),
      expectedQuantity: Number(item.expectedQuantity),
      inventoryValueBefore: money(item.inventoryValueBefore).toFixed(2),
      inventoryValueAfter: money(item.inventoryValueAfter).toFixed(2),
      expectedValueDelta: money(item.expectedValueDelta).toFixed(2),
    })),
    parseSkippedSnapshot(wave.skippedJson),
  );
  return costWaveDocumentFingerprint(previewFingerprint, {
    branchId: Number(wave.branchId),
    isCrossBranch: wave.isCrossBranch,
    name: wave.name,
    description: wave.description ?? null,
    reason: wave.reason,
  });
}

function waveTotalsMatch(
  wave: typeof costUpdateWaves.$inferSelect,
  items: Awaited<ReturnType<typeof loadWaveItems>>,
  skipped: CostWaveSkippedRow[],
): boolean {
  const expectedQuantity = items.reduce(
    (sum, item) => sum + Number(item.expectedQuantity),
    0,
  );
  const before = items.reduce(
    (sum, item) => sum.plus(item.inventoryValueBefore),
    new Decimal(0),
  );
  const after = items.reduce(
    (sum, item) => sum.plus(item.inventoryValueAfter),
    new Decimal(0),
  );
  const delta = items.reduce(
    (sum, item) => sum.plus(item.expectedValueDelta),
    new Decimal(0),
  );
  return (
    items.length === Number(wave.itemCount) &&
    skipped.length === Number(wave.skippedCount) &&
    expectedQuantity === Number(wave.expectedQuantity) &&
    round2(before).equals(money(wave.inventoryValueBefore)) &&
    round2(after).equals(money(wave.inventoryValueAfter)) &&
    round2(delta).equals(money(wave.expectedValueDelta)) &&
    round2(after.minus(before)).equals(round2(delta))
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
      expectedBranchQuantities: parseBranchQuantitySnapshot(
        item.branchQuantities,
      ),
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
): Promise<{
  waveId: number;
  status: "CONFLICTED";
  approvalCount: number;
  appliedItems: 0;
}> {
  const reason =
    failures.length === 1
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
  enqueuePostCommit(tx, () =>
    notifyCostWaveCreator({
      waveId: Number(wave.id),
      createdBy: Number(wave.createdBy),
      title: "تعارضت موجة التكلفة",
      body: `الموجة #${wave.id} لم تطبق لأن لقطة التكلفة أو الكمية تغيرت`,
      eventSuffix: "conflicted",
    }),
  );
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
    if (!wave)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر اعتماد موجة التكلفة",
          why: "الموجة غير موجودة",
          doThis: "حدّث القائمة واختر موجة موجودة",
        }),
      });
    assertWaveAuthority(wave, actor);
    if (wave.status !== "PENDING_APPROVAL") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر اعتماد موجة التكلفة",
          why: "الموجة ليست في انتظار الاعتماد",
          doThis: "حدّث القائمة وراجع حالتها الحالية",
        }),
      });
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
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر تسجيل الاعتماد",
          why: "سجلت قرارك على هذه الموجة مسبقاً",
          doThis: "انتظر قرار مستخدم مستقل آخر",
        }),
      });
    }

    const items = await loadWaveItems(tx, waveId);
    const skipped = parseSkippedSnapshot(wave.skippedJson);
    if (!waveTotalsMatch(wave, items, skipped)) {
      return markWaveConflicted(tx, wave, actor, [
        {
          ok: false,
          variantId: 0,
          reason: "INELIGIBLE",
          message: "تفاصيل المستند أو إجمالياته لا تطابق رأس الموجة",
        },
      ]);
    }
    const persistedFingerprint = fingerprintPersistedWave(wave, items);
    if (persistedFingerprint !== wave.previewFingerprint) {
      return markWaveConflicted(tx, wave, actor, [
        {
          ok: false,
          variantId: 0,
          reason: "INELIGIBLE",
          message: "بصمة تفاصيل الموجة لا تطابق البصمة الموقعة عند الإرسال",
        },
      ]);
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
      return markWaveConflicted(tx, wave, actor, [
        {
          ok: false,
          variantId: 0,
          reason: "INELIGIBLE",
          message: "عدد قرارات الاعتماد لا يطابق عداد رأس الموجة",
        },
      ]);
    }
    const checks = await checkWaveItems(tx, items, actor);
    const failures = checks.filter(
      (check): check is Extract<CostRevaluationSnapshotCheck, { ok: false }> =>
        !check.ok,
    );
    if (failures.length) return markWaveConflicted(tx, wave, actor, failures);

    const approvalNumber = Number(wave.approvalCount) + 1;
    if (approvalNumber > COST_WAVE_REQUIRED_APPROVALS) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر تسجيل الاعتماد",
          why: "اكتمل عدد الاعتمادات المطلوب مسبقاً",
          doThis: "حدّث القائمة وراجع الحالة النهائية",
        }),
      });
    }
    const resolvedActor = await resolveApprovalActor(tx, actor);
    const isFinalApproval = approvalNumber === COST_WAVE_REQUIRED_APPROVALS;
    // الاعتماد الأول مراجعة بلا أثر مالي. عند تشغيل سياسة المالك يُحجز المالك
    // للخطوة النهائية التي تطبق الموجة، فيبقى الفصل بين شخصين قابلاً للتنفيذ
    // حتى في المنشآت ذات المالك الواحد.
    if (
      isRolloutOn("ownerOnlyApproval") &&
      !isFinalApproval &&
      resolvedActor.isOwner
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر تسجيل اعتماد المالك أولاً",
          why: "اعتماد المالك محجوز للخطوة النهائية التي تطبّق موجة التكلفة",
          doThis: "ليُسجّل مدير مخوّل المراجعة الأولى، ثم يعتمد المالك التطبيق النهائي",
        }),
      });
    }
    assertApprover({
      // resolvedActor مصدره resolveApprovalActor(tx, actor) أعلاه، لا حمولة الطلب.
      actor: resolvedActor,
      trigger: isFinalApproval
        ? costRevaluationApprovalTrigger("APPROVE")
        : null,
      subject: "موجة تكلفة رقم " + waveId,
      legacy: () => {},
    });
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
      enqueuePostCommit(tx, () =>
        notifyCostWaveApprovers({
          waveId,
          waveName: wave.name,
          branchId: Number(wave.branchId),
          isCrossBranch: wave.isCrossBranch,
          excludeUserIds: [Number(wave.createdBy), actor.userId],
          approvalNumber,
        }),
      );
      return {
        waveId,
        status: "PENDING_APPROVAL",
        approvalCount: approvalNumber,
        appliedItems: 0,
      };
    }

    const targetByVariant = new Map(
      checks
        .filter((check) => check.ok)
        .map((check) => [check.target.variantId, check.target]),
    );
    let postedEntries = 0;
    for (const item of items) {
      const target = targetByVariant.get(Number(item.variantId));
      if (!target)
        throw new Error(`missing locked target for variant ${item.variantId}`);
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
    enqueuePostCommit(tx, () =>
      notifyCostWaveCreator({
        waveId,
        createdBy: Number(wave.createdBy),
        title: "تم تطبيق موجة التكلفة",
        body: `الموجة #${waveId} طبقت بعد اعتمادين مستقلين`,
        eventSuffix: "applied",
      }),
    );
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
      message: appErrorMessage({
        what: "تعذّر رفض موجة التكلفة",
        why: `سبب الرفض أقصر من ${COST_WAVE_MIN_REASON_LENGTH} محارف`,
        doThis: "اكتب سبباً واضحاً يمكن مراجعته لاحقاً",
      }),
    });
  }
  if (reason.length > COST_WAVE_MAX_REASON_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر رفض موجة التكلفة",
        why: `سبب الرفض يتجاوز ${COST_WAVE_MAX_REASON_LENGTH} محرف`,
        doThis: "اختصر السبب مع إبقاء المرجع الداعم",
      }),
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
    if (!wave)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر رفض موجة التكلفة",
          why: "الموجة غير موجودة",
          doThis: "حدّث القائمة واختر موجة موجودة",
        }),
      });
    assertWaveAuthority(wave, actor);
    if (wave.status !== "PENDING_APPROVAL") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر رفض موجة التكلفة",
          why: "الموجة ليست في انتظار قرار",
          doThis: "حدّث القائمة وراجع حالتها الحالية",
        }),
      });
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
    if (prior)
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر تسجيل الرفض",
          why: "سجلت قرارك على الموجة مسبقاً",
          doThis: "حدّث القائمة وراجع القرار المسجل",
        }),
      });

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
      .set({
        status: "REJECTED",
        rejectedBy: actor.userId,
        rejectedAt: now,
        rejectionReason: reason,
      })
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
    enqueuePostCommit(tx, () =>
      notifyCostWaveCreator({
        waveId,
        createdBy: Number(wave.createdBy),
        title: "رفضت موجة التكلفة",
        body: `الموجة #${waveId} · ${reason}`,
        eventSuffix: "rejected",
      }),
    );
    return { waveId, status: "REJECTED" };
  });
}

export type CostWaveListView = "AWAITING_MINE" | "MY_REQUESTS" | "HISTORY";

export async function listCostWaves(
  filter: {
    view?: CostWaveListView;
    status?: CostWaveStatus;
    branchId?: number | null;
    limit?: number;
    cursor?: number | null;
    search?: string | null;
  },
  actor: Actor,
) {
  assertManagerActor(actor);
  return withTx(
    async (tx) => {
      const conditions: SQL[] = [];
      if (!canCrossBranches(actor)) {
        conditions.push(
          eq(costUpdateWaves.branchId, actor.branchId),
          eq(costUpdateWaves.isCrossBranch, false),
        );
      }
      if (filter.branchId != null) {
        conditions.push(eq(costUpdateWaves.branchId, filter.branchId));
      }
      if (filter.status)
        conditions.push(eq(costUpdateWaves.status, filter.status));
      if (filter.view === "MY_REQUESTS")
        conditions.push(eq(costUpdateWaves.createdBy, actor.userId));
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
      if (filter.cursor != null)
        conditions.push(lt(costUpdateWaves.id, filter.cursor));
      const search = filter.search?.trim();
      if (search) {
        const escaped = search.replace(/[!%_]/g, "!$&");
        const pattern = `%${escaped}%`;
        conditions.push(
          or(
            sql`${costUpdateWaves.name} LIKE ${pattern} ESCAPE '!'`,
            sql`${users.name} LIKE ${pattern} ESCAPE '!'`,
          )!,
        );
      }
      const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);
      const fetched = await tx
        .select({
          id: costUpdateWaves.id,
          branchId: costUpdateWaves.branchId,
          name: costUpdateWaves.name,
          reason: costUpdateWaves.reason,
          purpose: costUpdateWaves.purpose,
          ruleType: costUpdateWaves.ruleType,
          changeValue: costUpdateWaves.changeValue,
          itemCount: costUpdateWaves.itemCount,
          skippedCount: costUpdateWaves.skippedCount,
          expectedQuantity: costUpdateWaves.expectedQuantity,
          inventoryValueBefore: costUpdateWaves.inventoryValueBefore,
          inventoryValueAfter: costUpdateWaves.inventoryValueAfter,
          expectedValueDelta: costUpdateWaves.expectedValueDelta,
          approvalCount: costUpdateWaves.approvalCount,
          isCrossBranch: costUpdateWaves.isCrossBranch,
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
        .limit(limit + 1);
      const hasMore = fetched.length > limit;
      const pageRows = hasMore ? fetched.slice(0, limit) : fetched;
      const rows = pageRows.map((row) => ({
        ...row,
        id: Number(row.id),
        changeValue: new Decimal(row.changeValue).toDecimalPlaces(4).toFixed(4),
        itemCount: Number(row.itemCount),
        skippedCount: Number(row.skippedCount),
        expectedQuantity: Number(row.expectedQuantity),
        inventoryValueBefore: money(row.inventoryValueBefore).toFixed(2),
        inventoryValueAfter: money(row.inventoryValueAfter).toFixed(2),
        expectedValueDelta: money(row.expectedValueDelta).toFixed(2),
        requiredApprovals: COST_WAVE_REQUIRED_APPROVALS,
        approvalCount: Number(row.approvalCount),
      }));
      return {
        rows,
        hasMore,
        nextCursor: hasMore ? rows.at(-1)?.id ?? null : null,
      };
    },
    { gate: "NONE" },
  );
}

export async function getCostWave(waveId: number, actor: Actor) {
  assertManagerActor(actor);
  return withTx(
    async (tx) => {
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
            skippedJson: costUpdateWaves.skippedJson,
            previewFingerprint: costUpdateWaves.previewFingerprint,
            itemCount: costUpdateWaves.itemCount,
            skippedCount: costUpdateWaves.skippedCount,
            expectedQuantity: costUpdateWaves.expectedQuantity,
            inventoryValueBefore: costUpdateWaves.inventoryValueBefore,
            inventoryValueAfter: costUpdateWaves.inventoryValueAfter,
            expectedValueDelta: costUpdateWaves.expectedValueDelta,
            isCrossBranch: costUpdateWaves.isCrossBranch,
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
      if (!wave)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "تعذّر فتح تفاصيل موجة التكلفة",
            why: "الموجة غير موجودة",
            doThis: "حدّث القائمة واختر موجة موجودة",
          }),
        });
      assertWaveAuthority(wave, actor);
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
            parseBranchQuantitySnapshot(item.branchQuantities).map(
              (row) => row.branchId,
            ),
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
      const { skippedJson, ...waveWithoutSkippedJson } = wave;
      return {
        wave: {
          ...waveWithoutSkippedJson,
          id: Number(wave.id),
          branchId: Number(wave.branchId),
          itemCount: Number(wave.itemCount),
          skippedCount: Number(wave.skippedCount),
          expectedQuantity: Number(wave.expectedQuantity),
          requiredApprovals: COST_WAVE_REQUIRED_APPROVALS,
          approvalCount: Number(wave.approvalCount),
          changeValue: new Decimal(wave.changeValue)
            .toDecimalPlaces(4)
            .toFixed(4),
          inventoryValueBefore: money(wave.inventoryValueBefore).toFixed(2),
          inventoryValueAfter: money(wave.inventoryValueAfter).toFixed(2),
          expectedValueDelta: money(wave.expectedValueDelta).toFixed(2),
        },
        skipped: parseSkippedSnapshot(skippedJson),
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
          branchQuantities: parseBranchQuantitySnapshot(
            item.branchQuantities,
          ).map((row) => ({
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
    },
    { gate: "NONE" },
  );
}
