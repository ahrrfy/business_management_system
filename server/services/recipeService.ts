/**
 * recipeService — وصفات/معايير الإنتاج: تعريف ثابت لمنتج متكرّر (ملزمة/كتاب).
 *
 * المكوّنات تُعرّف **لكل وحدة ناتج أساس واحدة** (مثلاً 30 ورقة/ملزمة). عند طلب إنتاج كمية Q:
 *   outputBase = convertToBaseQuantity(outputUnit, Q)
 *   inputBase  = qtyPerOutputBase × outputBase   (يجب أن يكون عدداً صحيحاً)
 * `recipePreview` يحسب الأسطر الجاهزة (مدخلات + مخرَج) + الكلفة الحيّة ⇒ يملأ نموذج الإنتاج.
 * الترحيل يمرّ بـ`createProduction` نفسه (مسار طفرة واحد آمن) مع linkedRecipeId.
 */
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  branchStock,
  productUnits,
  productVariants,
  products,
  productionOrders,
  productionRecipeLines,
  productionRecipes,
  type ProductUnit,
} from "../../drizzle/schema";
import type { Tx } from "../db";
import { convertToBaseQuantity } from "./inventoryService";
import { assertStockedOwnedMaterials } from "./inventory/materialEligibility";
import { money, round2 } from "./money";
import { withTx, type Actor } from "./tx";
import { extractInsertId } from "../lib/insertId";
import { assertNoActiveDigitalInventoryBinding } from "./digitalCards/inventoryBindingGuard";

export interface RecipeLineInput {
  inputVariantId: number;
  inputProductUnitId?: number | null;
  qtyPerOutputBase: string;
  notes?: string | null;
}

export interface CreateRecipeInput {
  name: string;
  outputVariantId: number;
  outputProductUnitId: number;
  laborPerOutputBase?: string | null;
  /** الهدر المعياري المتوقّع (كسر 0–1، مثل "0.05"). يُمتَص في كلفة الوحدة السليمة. */
  wasteStdPct?: string | null;
  notes?: string | null;
  /** الإنشاء الإداري المعتاد فعّال؛ النسخ/المسودّة يمرّران false صراحةً. */
  isActive?: boolean;
  lines: RecipeLineInput[];
}

export interface CreateRecipeOptions {
  /** يتقدّم على input.isActive للمستدعي الداخلي الذي يملك معاملةً قائمة. */
  active?: boolean;
}

export type RecipeExecutionKind =
  | "INVENTORY_PRODUCTION"
  | "SERVICE_CONSUMPTION"
  | "UNSUPPORTED";

interface LockedRecipeVariant {
  id: number;
  productId: number;
  variantActive: boolean;
  productActive: boolean;
  isService: boolean;
  isBundle: boolean;
  isConsignment: boolean;
}

interface RecipeMutationSnapshot {
  head: {
    id: number;
    name: string;
    outputVariantId: number;
    outputProductUnitId: number;
    laborPerOutputBase: string;
    wasteStdPct: string;
    notes: string | null;
    isActive: boolean;
    updatedAt: Date;
  };
  lines: Array<{
    id: number;
    inputVariantId: number;
    inputProductUnitId: number | null;
    qtyPerOutputBase: string;
    notes: string | null;
  }>;
}

function validateRecipeShape(input: CreateRecipeInput) {
  const name = String(input.name ?? "").trim();
  if (!name)
    throw new TRPCError({ code: "BAD_REQUEST", message: "اسم الوصفة مطلوب" });
  if (!input.outputVariantId || !input.outputProductUnitId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "حدّد المنتج الناتج ووحدته",
    });
  }
  if (!input.lines?.length)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "حدّد مكوّناً واحداً على الأقل",
    });
  const labor = round2(money(input.laborPerOutputBase ?? "0"));
  if (labor.isNegative()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حفظ الوصفة",
        why: "كلفة العمالة لا تكون سالبة",
        doThis: "أدخل صفراً أو كلفة عمالة موجبة",
      }),
    });
  }
  if (input.wasteStdPct != null && String(input.wasteStdPct).trim() !== "") {
    const w = round2(money(input.wasteStdPct));
    if (w.isNegative() || w.gte(1))
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "الهدر المعياري يجب أن يكون بين 0% وأقل من 100%",
      });
  }
  const seenInputVariantIds = new Set<number>();
  for (const l of input.lines) {
    if (!l.inputVariantId)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "صنف مكوّن غير صالح",
      });
    if (l.inputVariantId === input.outputVariantId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "المنتج الناتج لا يكون مكوّناً من نفسه",
      });
    }
    if (seenInputVariantIds.has(l.inputVariantId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر حفظ الوصفة",
          why: "صنف المكوّن مكرر داخل الوصفة",
          doThis: "اجمع كميته في سطر واحد ثم أعد الحفظ",
        }),
      });
    }
    seenInputVariantIds.add(l.inputVariantId);
    const quantity = money(l.qtyPerOutputBase);
    if (quantity.decimalPlaces() > 4) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر حفظ الوصفة",
          why: "كمية المكوّن تتجاوز دقة التخزين ذات الأربع منازل العشرية",
          doThis: "أدخل كمية بأربع منازل عشرية أو أقل بلا اعتماد على التقريب",
        }),
      });
    }
    if (quantity.lte(0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "كمية المكوّن لكل وحدة يجب أن تكون موجبة",
      });
    }
  }
  return name;
}

/** Validates unit ownership and preserves the runner's base-output-unit contract. */
async function validateRecipeUnits(
  tx: Tx,
  input: CreateRecipeInput,
): Promise<void> {
  const unitIds = [
    input.outputProductUnitId,
    ...input.lines
      .map((l) => l.inputProductUnitId)
      .filter((id): id is number => id != null),
  ];
  type CheckedUnit = Pick<
    ProductUnit,
    "id" | "variantId" | "isBaseUnit" | "isActive"
  >;
  const units = (await tx
    .select({
      id: productUnits.id,
      variantId: productUnits.variantId,
      isBaseUnit: productUnits.isBaseUnit,
      isActive: productUnits.isActive,
    })
    .from(productUnits)
    .where(inArray(productUnits.id, Array.from(new Set(unitIds))))
    .orderBy(productUnits.id)
    .for("update")) as CheckedUnit[];
  const byId = new Map<number, CheckedUnit>(
    units.map((u) => [Number(u.id), u]),
  );
  const output = byId.get(input.outputProductUnitId);
  if (!output || Number(output.variantId) !== input.outputVariantId)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "وحدة الناتج لا تخص الصنف الناتج",
    });
  if (!output.isActive)
    throw new TRPCError({ code: "BAD_REQUEST", message: "وحدة الناتج معطّلة" });
  if (!output.isBaseUnit)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "وصفة الإنتاج تُعرّف لكل وحدة ناتج أساسية؛ اختر الوحدة الأساسية للناتج",
    });
  for (const line of input.lines) {
    if (line.inputProductUnitId == null) continue;
    const unit = byId.get(line.inputProductUnitId);
    if (!unit || Number(unit.variantId) !== line.inputVariantId)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "وحدة المكوّن لا تخص صنف المكوّن",
      });
    if (!unit.isActive)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "وحدة أحد المكوّنات معطّلة",
      });
  }
}

/**
 * صف productVariants هو mutex ثابت لمجال الوصفة. نقفل الناتج وكل المواد بترتيب id واحد؛
 * قفل «صف وصفة موجود» وحده لا يحمي create/create لأن الصف المنافس لم يولد بعد.
 */
async function lockRecipeVariantScope(
  tx: Tx,
  variantIds: readonly number[],
): Promise<Map<number, LockedRecipeVariant>> {
  const ids = Array.from(new Set(variantIds.map(Number))).sort((a, b) => a - b);
  const refs = await tx
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
    })
    .from(productVariants)
    .where(inArray(productVariants.id, ids))
    .orderBy(asc(productVariants.id));
  const refByVariant = new Map(
    refs.map((row) => [Number(row.id), Number(row.productId)]),
  );
  const missing = ids.filter((id) => !refByVariant.has(id));
  if (missing.length) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر حفظ الوصفة",
        why: `الأصناف غير موجودة: ${missing.map((id) => `#${id}`).join("، ")}`,
        doThis: "حدّث الصفحة واختر أصنافاً موجودة ثم أعد الحفظ",
      }),
    });
  }

  const productIds = Array.from(new Set(refByVariant.values())).sort(
    (a, b) => a - b,
  );
  const lockedProducts = await tx
    .select({
      id: products.id,
      isActive: products.isActive,
      isService: products.isService,
      isBundle: products.isBundle,
      isConsignment: products.isConsignment,
    })
    .from(products)
    .where(inArray(products.id, productIds))
    .orderBy(asc(products.id))
    .for("update");
  const productById = new Map(
    lockedProducts.map((product) => [Number(product.id), product]),
  );

  const rows = await tx
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      variantActive: productVariants.isActive,
    })
    .from(productVariants)
    .where(inArray(productVariants.id, ids))
    .orderBy(asc(productVariants.id))
    .for("update");
  const byId = new Map<number, LockedRecipeVariant>();
  for (const row of rows) {
    const id = Number(row.id);
    const productId = Number(row.productId);
    if (refByVariant.get(id) !== productId) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر حفظ الوصفة",
          why: `تغيّر ربط الصنف #${id} أثناء تثبيت الوصفة`,
          doThis: "حدّث الصفحة وراجع الأصناف ثم أعد الحفظ",
        }),
      });
    }
    const product = productById.get(productId);
    if (!product) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر حفظ الوصفة",
          why: `لم يعد منتج الصنف #${id} ضمن نطاق الأقفال`,
          doThis: "حدّث الصفحة وراجع الأصناف ثم أعد الحفظ",
        }),
      });
    }
    byId.set(id, {
      id,
      productId,
      variantActive: row.variantActive === true,
      productActive: product.isActive === true,
      isService: Boolean(product.isService),
      isBundle: Boolean(product.isBundle),
      isConsignment: Boolean(product.isConsignment),
    });
  }
  const missingAfterLock = ids.filter((id) => !byId.has(id));
  if (missingAfterLock.length) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر حفظ الوصفة",
        why: `الأصناف لم تعد موجودة: ${missingAfterLock.map((id) => `#${id}`).join("، ")}`,
        doThis: "حدّث الصفحة واختر أصنافاً موجودة ثم أعد الحفظ",
      }),
    });
  }
  return byId;
}

async function validateRecipeDefinition(
  tx: Tx,
  input: CreateRecipeInput,
  lockedVariants: Map<number, LockedRecipeVariant>,
): Promise<void> {
  const output = lockedVariants.get(Number(input.outputVariantId));
  if (!output) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر حفظ الوصفة",
        why: "صنف الناتج غير موجود",
        doThis: "حدّث الصفحة واختر ناتجاً موجوداً ثم أعد الحفظ",
      }),
    });
  }
  if (!output.productActive || !output.variantActive) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر حفظ الوصفة",
        why: "منتج الناتج أو متغيّره معطّل",
        doThis: "فعّل المنتج ومتغيّره أولاً، أو اختر ناتجاً نشطاً",
      }),
    });
  }
  if (output.isBundle) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر حفظ الوصفة",
        why: "البكج بلا رصيد ذاتي وتُدار مكوّناته من تعريف البكج لا من وصفة إنتاج",
        doThis: "استخدم مكوّنات البكج، أو اختر ناتجاً مخزنياً أو خدمة",
      }),
    });
  }
  if (output.isConsignment) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر حفظ الوصفة",
        why: "بضاعة الأمانة أصل غير مملوك للمنشأة ولا يصلح ناتجاً لوصفة إنتاج أو WAVG مملوك",
        doThis: "اختر ناتجاً مخزنياً مملوكاً أو خدمة",
      }),
    });
  }
  await validateRecipeUnits(tx, input);
  await assertStockedOwnedMaterials(
    tx,
    input.lines.map((line) => line.inputVariantId),
    "مكوّن الوصفة",
  );
}

async function readRecipeMutationSnapshot(
  tx: Tx,
  id: number,
  lock: boolean,
): Promise<RecipeMutationSnapshot | null> {
  const headQuery = tx
    .select({
      id: productionRecipes.id,
      name: productionRecipes.name,
      outputVariantId: productionRecipes.outputVariantId,
      outputProductUnitId: productionRecipes.outputProductUnitId,
      laborPerOutputBase: productionRecipes.laborPerOutputBase,
      wasteStdPct: productionRecipes.wasteStdPct,
      notes: productionRecipes.notes,
      isActive: productionRecipes.isActive,
      updatedAt: productionRecipes.updatedAt,
    })
    .from(productionRecipes)
    .where(eq(productionRecipes.id, id))
    .limit(1);
  const headRows = lock ? await headQuery.for("update") : await headQuery;
  const head = headRows[0];
  if (!head) return null;

  const linesQuery = tx
    .select({
      id: productionRecipeLines.id,
      inputVariantId: productionRecipeLines.inputVariantId,
      inputProductUnitId: productionRecipeLines.inputProductUnitId,
      qtyPerOutputBase: productionRecipeLines.qtyPerOutputBase,
      notes: productionRecipeLines.notes,
    })
    .from(productionRecipeLines)
    .where(eq(productionRecipeLines.recipeId, id))
    .orderBy(productionRecipeLines.id);
  const lineRows = lock ? await linesQuery.for("update") : await linesQuery;
  return {
    head: {
      id: Number(head.id),
      name: head.name,
      outputVariantId: Number(head.outputVariantId),
      outputProductUnitId: Number(head.outputProductUnitId),
      laborPerOutputBase: String(head.laborPerOutputBase),
      wasteStdPct: String(head.wasteStdPct),
      notes: head.notes ?? null,
      isActive: head.isActive === true,
      updatedAt: head.updatedAt,
    },
    lines: lineRows.map((line) => ({
      id: Number(line.id),
      inputVariantId: Number(line.inputVariantId),
      inputProductUnitId:
        line.inputProductUnitId == null
          ? null
          : Number(line.inputProductUnitId),
      qtyPerOutputBase: String(line.qtyPerOutputBase),
      notes: line.notes ?? null,
    })),
  };
}

function recipeSnapshotFingerprint(snapshot: RecipeMutationSnapshot): string {
  return JSON.stringify({
    ...snapshot.head,
    updatedAt: snapshot.head.updatedAt.getTime(),
    lines: snapshot.lines,
  });
}

function recipeSnapshotAsInput(
  snapshot: RecipeMutationSnapshot,
): CreateRecipeInput {
  return {
    name: snapshot.head.name,
    outputVariantId: snapshot.head.outputVariantId,
    outputProductUnitId: snapshot.head.outputProductUnitId,
    laborPerOutputBase: snapshot.head.laborPerOutputBase,
    wasteStdPct: snapshot.head.wasteStdPct,
    notes: snapshot.head.notes,
    isActive: snapshot.head.isActive,
    lines: snapshot.lines.map((line) => ({
      inputVariantId: line.inputVariantId,
      inputProductUnitId: line.inputProductUnitId,
      qtyPerOutputBase: line.qtyPerOutputBase,
      notes: line.notes,
    })),
  };
}

function throwConcurrentRecipeChange(): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "لم تُحفَظ الوصفة",
      why: "تغيّرت الوصفة في جلسة أخرى أثناء العملية",
      doThis: "حدّث الصفحة وراجع القيم الجديدة ثم أعد المحاولة",
    }),
  });
}

async function assertActiveRecipeSlotAvailable(
  tx: Tx,
  outputVariantId: number,
  exceptRecipeId?: number,
): Promise<void> {
  const where =
    exceptRecipeId == null
      ? and(
          eq(productionRecipes.outputVariantId, outputVariantId),
          eq(productionRecipes.isActive, true),
        )
      : and(
          eq(productionRecipes.outputVariantId, outputVariantId),
          eq(productionRecipes.isActive, true),
          ne(productionRecipes.id, exceptRecipeId),
        );
  const existing = (
    await tx
      .select({ id: productionRecipes.id, name: productionRecipes.name })
      .from(productionRecipes)
      .where(where)
      .limit(1)
      .for("update")
  )[0];
  if (!existing) return;
  throw new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "تعذّر تفعيل الوصفة",
      why: `الناتج مرتبط بوصفة فعّالة أخرى: «${existing.name}» (#${Number(existing.id)})`,
      doThis: "عطّل الوصفة الفعّالة الحالية أولاً، ثم فعّل الوصفة المطلوبة",
    }),
  });
}

function isActiveRecipeUniqueError(error: unknown): boolean {
  let cursor: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; cursor != null && depth < 12; depth += 1) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const candidate = cursor as {
      message?: unknown;
      sqlMessage?: unknown;
      cause?: unknown;
    };
    if (
      `${String(candidate.message ?? "")} ${String(candidate.sqlMessage ?? "")}`.includes(
        "uq_recipe_active_output",
      )
    ) {
      return true;
    }
    cursor = candidate.cause;
  }
  return false;
}

function rethrowRecipeWriteError(error: unknown): never {
  if (isActiveRecipeUniqueError(error)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر تفعيل الوصفة",
        why: "أصبحت لهذا الناتج وصفة فعّالة أخرى بالتزامن",
        doThis: "حدّث قائمة الوصفات، وعطّل الوصفة الحالية قبل إعادة المحاولة",
      }),
    });
  }
  throw error;
}

function executionKindFor(row: {
  outputIsService: unknown;
  outputIsBundle: unknown;
  outputIsConsignment: unknown;
}): RecipeExecutionKind {
  if (Boolean(row.outputIsConsignment)) return "UNSUPPORTED";
  if (Boolean(row.outputIsBundle)) return "UNSUPPORTED";
  if (Boolean(row.outputIsService)) return "SERVICE_CONSUMPTION";
  return "INVENTORY_PRODUCTION";
}

function canRunProductionFor(row: {
  outputVariantId: unknown;
  outputUnitVariantId: unknown;
  outputProductActive: unknown;
  outputVariantActive: unknown;
  outputUnitActive: unknown;
  outputUnitIsBase: unknown;
  outputIsService: unknown;
  outputIsBundle: unknown;
  outputIsConsignment: unknown;
  isActive: unknown;
}): boolean {
  return (
    executionKindFor(row) === "INVENTORY_PRODUCTION" &&
    row.isActive === true &&
    row.outputProductActive === true &&
    row.outputVariantActive === true &&
    row.outputUnitActive === true &&
    row.outputUnitIsBase === true &&
    Number(row.outputUnitVariantId) === Number(row.outputVariantId)
  );
}

async function listRecipesInTx(
  tx: Tx,
  opts: { activeOnly?: boolean; runnableOnly?: boolean },
) {
  const where = opts.runnableOnly
    ? and(
        eq(productionRecipes.isActive, true),
        eq(products.isActive, true),
        eq(products.isService, false),
        eq(products.isBundle, false),
        eq(products.isConsignment, false),
        eq(productVariants.isActive, true),
        eq(productUnits.isActive, true),
        eq(productUnits.isBaseUnit, true),
        eq(productUnits.variantId, productionRecipes.outputVariantId),
      )
    : opts.activeOnly
      ? eq(productionRecipes.isActive, true)
      : undefined;
  const rows = await tx
    .select({
      id: productionRecipes.id,
      name: productionRecipes.name,
      outputVariantId: productionRecipes.outputVariantId,
      outputProductName: products.name,
      outputSku: productVariants.sku,
      outputUnitName: productUnits.unitName,
      laborPerOutputBase: productionRecipes.laborPerOutputBase,
      wasteStdPct: productionRecipes.wasteStdPct,
      outputCostPrice: productVariants.costPrice,
      outputIsService: products.isService,
      outputIsBundle: products.isBundle,
      outputIsConsignment: products.isConsignment,
      outputProductActive: products.isActive,
      outputVariantActive: productVariants.isActive,
      outputUnitActive: productUnits.isActive,
      outputUnitIsBase: productUnits.isBaseUnit,
      outputUnitVariantId: productUnits.variantId,
      isActive: productionRecipes.isActive,
      createdAt: productionRecipes.createdAt,
    })
    .from(productionRecipes)
    .leftJoin(
      productVariants,
      eq(productionRecipes.outputVariantId, productVariants.id),
    )
    .leftJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(
      productUnits,
      eq(productionRecipes.outputProductUnitId, productUnits.id),
    )
    .where(where)
    .orderBy(desc(productionRecipes.id));
  if (!rows.length) return [];
  // عدّاد المكوّنات لكل وصفة (استعلام مُجمَّع واحد).
  const ids = rows.map((row) => Number(row.id));
  const cntRows = await tx
    .select({
      recipeId: productionRecipeLines.recipeId,
      n: sql<string>`COUNT(*)`,
    })
    .from(productionRecipeLines)
    .where(inArray(productionRecipeLines.recipeId, ids))
    .groupBy(productionRecipeLines.recipeId);
  const cntMap = new Map(
    cntRows.map((row) => [Number(row.recipeId), Number(row.n)]),
  );
  const decorated = rows.map((row) => {
    const executionKind = executionKindFor(row);
    const linesCount = cntMap.get(Number(row.id)) ?? 0;
    return {
      ...row,
      outputIsService: Boolean(row.outputIsService),
      outputIsBundle: Boolean(row.outputIsBundle),
      outputIsConsignment: Boolean(row.outputIsConsignment),
      executionKind,
      canRunProduction: canRunProductionFor(row) && linesCount > 0,
      isActive: row.isActive === true,
      linesCount,
    };
  });
  return opts.runnableOnly
    ? decorated.filter((row) => row.canRunProduction)
    : decorated;
}

/** قائمة الإدارة: لا تُخفى وصفات الخدمات ولا وصفات الإرث غير المدعومة. */
export async function listRecipes(opts: { activeOnly?: boolean } = {}) {
  return withTx((tx) => listRecipesInTx(tx, opts));
}

/** قائمة تشغيل الإنتاج المخزني فقط؛ بيع الخدمات يستهلك وصفاتها في مسار البيع. */
export async function listRunnableRecipes() {
  return withTx((tx) => listRecipesInTx(tx, { runnableOnly: true }));
}

/** تفاصيل وصفة + مكوّناتها بأسماء الأصناف. */
export async function getRecipe(id: number) {
  return withTx(async (tx) => {
    const head = (
      await tx
        .select({
          id: productionRecipes.id,
          name: productionRecipes.name,
          outputVariantId: productionRecipes.outputVariantId,
          outputProductUnitId: productionRecipes.outputProductUnitId,
          outputProductName: products.name,
          outputSku: productVariants.sku,
          outputUnitName: productUnits.unitName,
          laborPerOutputBase: productionRecipes.laborPerOutputBase,
          wasteStdPct: productionRecipes.wasteStdPct,
          outputCostPrice: productVariants.costPrice,
          outputIsService: products.isService,
          outputIsBundle: products.isBundle,
          outputIsConsignment: products.isConsignment,
          outputProductActive: products.isActive,
          outputVariantActive: productVariants.isActive,
          outputUnitActive: productUnits.isActive,
          outputUnitIsBase: productUnits.isBaseUnit,
          outputUnitVariantId: productUnits.variantId,
          notes: productionRecipes.notes,
          isActive: productionRecipes.isActive,
        })
        .from(productionRecipes)
        .leftJoin(
          productVariants,
          eq(productionRecipes.outputVariantId, productVariants.id),
        )
        .leftJoin(products, eq(productVariants.productId, products.id))
        .leftJoin(
          productUnits,
          eq(productionRecipes.outputProductUnitId, productUnits.id),
        )
        .where(eq(productionRecipes.id, id))
        .limit(1)
    )[0];
    if (!head)
      throw new TRPCError({ code: "NOT_FOUND", message: "الوصفة غير موجودة" });
    const lines = await tx
      .select({
        id: productionRecipeLines.id,
        inputVariantId: productionRecipeLines.inputVariantId,
        inputProductUnitId: productionRecipeLines.inputProductUnitId,
        inputProductName: products.name,
        inputSku: productVariants.sku,
        inputCostPrice: productVariants.costPrice,
        qtyPerOutputBase: productionRecipeLines.qtyPerOutputBase,
        notes: productionRecipeLines.notes,
      })
      .from(productionRecipeLines)
      .leftJoin(
        productVariants,
        eq(productionRecipeLines.inputVariantId, productVariants.id),
      )
      .leftJoin(products, eq(productVariants.productId, products.id))
      .where(eq(productionRecipeLines.recipeId, id))
      .orderBy(productionRecipeLines.id);

    // وحدات كل صنف مكوّن (لمنتقي الوحدة في نموذج التعديل) — استعلام مُجمَّع واحد.
    const varIds = Array.from(
      new Set(lines.map((l: any) => Number(l.inputVariantId))),
    );
    const unitsByVariant = new Map<
      number,
      Array<{
        productUnitId: number;
        unitName: string;
        conversionFactor: string;
        isBaseUnit: boolean;
      }>
    >();
    if (varIds.length) {
      const unitRows = await tx
        .select({
          variantId: productUnits.variantId,
          id: productUnits.id,
          unitName: productUnits.unitName,
          conversionFactor: productUnits.conversionFactor,
          isBaseUnit: productUnits.isBaseUnit,
        })
        .from(productUnits)
        .where(inArray(productUnits.variantId, varIds));
      for (const u of unitRows) {
        const vid = Number(u.variantId);
        if (!unitsByVariant.has(vid)) unitsByVariant.set(vid, []);
        unitsByVariant.get(vid)!.push({
          productUnitId: Number(u.id),
          unitName: u.unitName,
          conversionFactor: String(u.conversionFactor),
          isBaseUnit: Boolean(u.isBaseUnit),
        });
      }
    }
    const linesOut = lines.map((l: any) => ({
      ...l,
      units: unitsByVariant.get(Number(l.inputVariantId)) ?? [],
    }));
    const executionKind = executionKindFor(head);
    return {
      ...head,
      outputIsService: Boolean(head.outputIsService),
      outputIsBundle: Boolean(head.outputIsBundle),
      outputIsConsignment: Boolean(head.outputIsConsignment),
      executionKind,
      canRunProduction: canRunProductionFor(head) && linesOut.length > 0,
      isActive: head.isActive === true,
      lines: linesOut,
    };
  });
}

/**
 * نواة إنشاء قابلة لإعادة الاستخدام داخل معاملة الكتالوج؛ لا تفتح معاملةً متداخلة.
 * قفل outputVariant يمنع create/create، والقيد الفريد في 0359 يبقى الصمام البنيوي الأخير.
 */
export async function createRecipeInTx(
  tx: Tx,
  input: CreateRecipeInput,
  actor: Actor,
  options: CreateRecipeOptions = {},
) {
  const name = validateRecipeShape(input);
  const active = options.active ?? input.isActive ?? true;
  const scopedIds = [
    input.outputVariantId,
    ...input.lines.map((line) => line.inputVariantId),
  ];
  const lockedVariants = await lockRecipeVariantScope(tx, scopedIds);
  await assertNoActiveDigitalInventoryBinding(
    tx,
    scopedIds,
    "تغيير الوصفة أثناء إصدار سلة رقمية",
  );
  await validateRecipeDefinition(tx, input, lockedVariants);
  if (active) {
    await assertActiveRecipeSlotAvailable(tx, input.outputVariantId);
  }

  try {
    const insRes = await tx.insert(productionRecipes).values({
      name,
      outputVariantId: input.outputVariantId,
      outputProductUnitId: input.outputProductUnitId,
      laborPerOutputBase: round2(
        money(input.laborPerOutputBase ?? "0"),
      ).toFixed(2),
      wasteStdPct: round2(money(input.wasteStdPct ?? "0")).toFixed(2),
      notes: input.notes?.trim() || null,
      isActive: active,
      createdBy: actor.userId,
    });
    const recipeId = extractInsertId(insRes);
    if (input.lines.length > 0) {
      await tx.insert(productionRecipeLines).values(
        input.lines.map((line) => ({
          recipeId,
          inputVariantId: line.inputVariantId,
          inputProductUnitId: line.inputProductUnitId ?? null,
          qtyPerOutputBase: money(line.qtyPerOutputBase)
            .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
            .toFixed(4),
          notes: line.notes?.trim() || null,
        })),
      );
    }
    return { recipeId, isActive: active };
  } catch (error) {
    rethrowRecipeWriteError(error);
  }
}

/** إنشاء وصفة؛ النسخ يمرّر input.isActive=false كي لا يبدّل وصفة التنفيذ ضمناً. */
export async function createRecipe(
  input: CreateRecipeInput,
  actor: Actor,
  options: CreateRecipeOptions = {},
) {
  return withTx((tx) => createRecipeInTx(tx, input, actor, options));
}

/** تحديث تعريف الوصفة مع قفل نطاقها ومنع محو هوية الناتج التاريخية. */
export async function updateRecipe(id: number, input: CreateRecipeInput) {
  return withTx(async (tx) => {
    const name = validateRecipeShape(input);
    const initial = await readRecipeMutationSnapshot(tx, id, false);
    if (!initial)
      throw new TRPCError({ code: "NOT_FOUND", message: "الوصفة غير موجودة" });

    const lockedVariants = await lockRecipeVariantScope(tx, [
      initial.head.outputVariantId,
      ...initial.lines.map((line) => line.inputVariantId),
      input.outputVariantId,
      ...input.lines.map((line) => line.inputVariantId),
    ]);
    await assertNoActiveDigitalInventoryBinding(
      tx,
      Array.from(lockedVariants.keys()),
      "تعديل الوصفة أثناء إصدار سلة رقمية",
    );
    const current = await readRecipeMutationSnapshot(tx, id, true);
    if (!current) throwConcurrentRecipeChange();
    if (
      recipeSnapshotFingerprint(initial) !== recipeSnapshotFingerprint(current)
    ) {
      throwConcurrentRecipeChange();
    }
    if (current.head.outputVariantId !== input.outputVariantId) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "لم تُحفَظ الوصفة",
          why: "صنف الناتج هو هوية الوصفة ولا يتغيّر بعد إنشائها لأن العمليات السابقة تعتمد عليه",
          doThis:
            "أنشئ وصفة جديدة للناتج الآخر، وعطّل هذه الوصفة إن لم تعد مطلوبة",
        }),
      });
    }
    await validateRecipeDefinition(tx, input, lockedVariants);
    if (current.head.isActive) {
      await assertActiveRecipeSlotAvailable(tx, input.outputVariantId, id);
    }

    try {
      await tx
        .update(productionRecipes)
        .set({
          name,
          outputProductUnitId: input.outputProductUnitId,
          laborPerOutputBase: round2(
            money(input.laborPerOutputBase ?? "0"),
          ).toFixed(2),
          wasteStdPct: round2(money(input.wasteStdPct ?? "0")).toFixed(2),
          notes: input.notes?.trim() || null,
        })
        .where(eq(productionRecipes.id, id));
      await tx
        .delete(productionRecipeLines)
        .where(eq(productionRecipeLines.recipeId, id));
      if (input.lines.length > 0) {
        await tx.insert(productionRecipeLines).values(
          input.lines.map((line) => ({
            recipeId: id,
            inputVariantId: line.inputVariantId,
            inputProductUnitId: line.inputProductUnitId ?? null,
            qtyPerOutputBase: money(line.qtyPerOutputBase)
              .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
              .toFixed(4),
            notes: line.notes?.trim() || null,
          })),
        );
      }
      return { recipeId: id };
    } catch (error) {
      rethrowRecipeWriteError(error);
    }
  });
}

export async function setRecipeActive(id: number, active: boolean) {
  return withTx(async (tx) => {
    const initial = await readRecipeMutationSnapshot(tx, id, false);
    if (!initial)
      throw new TRPCError({ code: "NOT_FOUND", message: "الوصفة غير موجودة" });
    const lockedVariants = await lockRecipeVariantScope(tx, [
      initial.head.outputVariantId,
      ...initial.lines.map((line) => line.inputVariantId),
    ]);
    await assertNoActiveDigitalInventoryBinding(
      tx,
      Array.from(lockedVariants.keys()),
      "تغيير حالة الوصفة أثناء إصدار سلة رقمية",
    );
    const current = await readRecipeMutationSnapshot(tx, id, true);
    if (!current) throwConcurrentRecipeChange();
    if (
      recipeSnapshotFingerprint(initial) !== recipeSnapshotFingerprint(current)
    ) {
      throwConcurrentRecipeChange();
    }
    if (current.head.isActive === active) return { ok: true as const };

    if (active) {
      const definition = recipeSnapshotAsInput(current);
      validateRecipeShape(definition);
      await validateRecipeDefinition(tx, definition, lockedVariants);
      await assertActiveRecipeSlotAvailable(
        tx,
        current.head.outputVariantId,
        id,
      );
    }
    try {
      await tx
        .update(productionRecipes)
        .set({ isActive: active })
        .where(eq(productionRecipes.id, id));
      return { ok: true as const };
    } catch (error) {
      rethrowRecipeWriteError(error);
    }
  });
}

export async function deleteRecipe(id: number) {
  return withTx(async (tx) => {
    const initial = await readRecipeMutationSnapshot(tx, id, false);
    if (!initial)
      throw new TRPCError({ code: "NOT_FOUND", message: "الوصفة غير موجودة" });
    const lockedVariants = await lockRecipeVariantScope(tx, [
      initial.head.outputVariantId,
      ...initial.lines.map((line) => line.inputVariantId),
    ]);
    await assertNoActiveDigitalInventoryBinding(
      tx,
      Array.from(lockedVariants.keys()),
      "حذف الوصفة أثناء إصدار سلة رقمية",
    );
    const current = await readRecipeMutationSnapshot(tx, id, true);
    if (!current) throwConcurrentRecipeChange();
    if (
      recipeSnapshotFingerprint(initial) !== recipeSnapshotFingerprint(current)
    ) {
      throwConcurrentRecipeChange();
    }
    if (current.head.isActive) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر حذف الوصفة",
          why: "الوصفة فعّالة وقد تكون مسار الاستهلاك الحالي",
          doThis: "عطّل الوصفة أولاً، ثم راجع ارتباطاتها قبل الحذف",
        }),
      });
    }
    if (lockedVariants.get(current.head.outputVariantId)?.isService) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر حذف وصفة الخدمة",
          why: "مبيعات الخدمة لا تحمل رابط وصفة تاريخياً، وحذف آخر تعريف يحوّل البيع اللاحق إلى كلفة صفر",
          doThis:
            "اترك الوصفة معطّلة للاحتفاظ بالتاريخ، وأنشئ وصفة بديلة عند الحاجة",
        }),
      });
    }
    const linkedOrder = (
      await tx
        .select({ id: productionOrders.id })
        .from(productionOrders)
        .where(eq(productionOrders.linkedRecipeId, id))
        .limit(1)
        .for("update")
    )[0];
    if (linkedOrder) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر حذف الوصفة",
          why: `الوصفة مرتبطة بمستند إنتاج #${Number(linkedOrder.id)} ويجب أن يبقى تاريخه قابلاً للتدقيق`,
          doThis: "اترك الوصفة معطّلة بدلاً من حذفها",
        }),
      });
    }
    await tx.delete(productionRecipes).where(eq(productionRecipes.id, id));
    return { ok: true as const };
  });
}

export interface RecipePreviewResult {
  recipeId: number;
  outputVariantId: number;
  outputProductUnitId: number;
  outputName: string | null;
  outputBase: number;
  laborCost: string;
  materialsCost: string;
  totalCost: string;
  inputs: Array<{
    variantId: number;
    productName: string | null;
    sku: string | null;
    baseQuantity: number;
    unitCost: string;
    lineCost: string;
    available: number | null;
  }>;
}

/**
 * معاينة وصفة لكمية ناتج معيّنة ⇒ أسطر جاهزة لنموذج الإنتاج (بلا أي حركة مخزون).
 * يفرض أن استهلاك كل مكوّن المُحجَّم عدد صحيح، ويلتقط الكلفة الحيّة من costPrice،
 * والمتاح من رصيد الفرع (إن مُرِّر branchId) لتحذير «المتاح N» اللّيّن في الواجهة.
 */
export async function recipePreview(args: {
  recipeId: number;
  outputQuantity: string;
  branchId?: number | null;
}): Promise<RecipePreviewResult> {
  return withTx(async (tx) => {
    const head = (
      await tx
        .select({
          id: productionRecipes.id,
          name: productionRecipes.name,
          outputVariantId: productionRecipes.outputVariantId,
          outputProductUnitId: productionRecipes.outputProductUnitId,
          outputName: products.name,
          laborPerOutputBase: productionRecipes.laborPerOutputBase,
          isActive: productionRecipes.isActive,
        })
        .from(productionRecipes)
        .leftJoin(
          productVariants,
          eq(productionRecipes.outputVariantId, productVariants.id),
        )
        .leftJoin(products, eq(productVariants.productId, products.id))
        .where(eq(productionRecipes.id, args.recipeId))
        .limit(1)
    )[0];
    if (!head)
      throw new TRPCError({ code: "NOT_FOUND", message: "الوصفة غير موجودة" });
    if (!head.isActive)
      throw new TRPCError({ code: "BAD_REQUEST", message: "الوصفة معطّلة" });

    const conv = await convertToBaseQuantity(
      tx,
      Number(head.outputProductUnitId),
      args.outputQuantity,
      Number(head.outputVariantId),
    );
    const outputBase = conv.baseQuantity;

    const recLines = await tx
      .select({
        inputVariantId: productionRecipeLines.inputVariantId,
        qtyPerOutputBase: productionRecipeLines.qtyPerOutputBase,
        productName: products.name,
        sku: productVariants.sku,
      })
      .from(productionRecipeLines)
      .leftJoin(
        productVariants,
        eq(productionRecipeLines.inputVariantId, productVariants.id),
      )
      .leftJoin(products, eq(productVariants.productId, products.id))
      .where(eq(productionRecipeLines.recipeId, args.recipeId))
      .orderBy(productionRecipeLines.id);
    if (!recLines.length)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "الوصفة بلا مكوّنات",
      });

    const inVarIds = Array.from(
      new Set(recLines.map((l: any) => Number(l.inputVariantId))),
    );
    const costRows = await tx
      .select({ id: productVariants.id, costPrice: productVariants.costPrice })
      .from(productVariants)
      .where(inArray(productVariants.id, inVarIds));
    const costMap = new Map(
      costRows.map((v: any) => [Number(v.id), v.costPrice]),
    );

    // المتاح بالفرع (إن وُجد) للتحذير اللّيّن.
    const availMap = new Map<number, number>();
    if (args.branchId) {
      const stockRows = await tx
        .select({ variantId: branchStock.variantId, qty: branchStock.quantity })
        .from(branchStock)
        .where(
          and(
            inArray(branchStock.variantId, inVarIds),
            eq(branchStock.branchId, args.branchId),
          ),
        );
      for (const s of stockRows)
        availMap.set(Number(s.variantId), Number(s.qty));
    }

    let materialsCost = new Decimal(0);
    const inputs = recLines.map((l: any) => {
      const perOut = new Decimal(l.qtyPerOutputBase);
      const baseDec = perOut.times(outputBase);
      if (!baseDec.isInteger()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `استهلاك المكوّن «${l.productName ?? l.inputVariantId}» الناتج (${baseDec.toString()}) ليس عدداً صحيحاً — عدّل الكمية أو الوصفة`,
        });
      }
      const baseQuantity = baseDec.toNumber();
      const unitCost = round2(
        money(costMap.get(Number(l.inputVariantId)) ?? "0"),
      );
      const lineCost = round2(unitCost.times(baseQuantity));
      materialsCost = materialsCost.plus(lineCost);
      return {
        variantId: Number(l.inputVariantId),
        productName: l.productName ?? null,
        sku: l.sku ?? null,
        baseQuantity,
        unitCost: unitCost.toFixed(2),
        lineCost: lineCost.toFixed(2),
        available: availMap.has(Number(l.inputVariantId))
          ? availMap.get(Number(l.inputVariantId))!
          : null,
      };
    });

    materialsCost = round2(materialsCost);
    const laborCost = round2(
      money(head.laborPerOutputBase ?? "0").times(outputBase),
    );
    const totalCost = round2(materialsCost.plus(laborCost));

    return {
      recipeId: Number(head.id),
      outputVariantId: Number(head.outputVariantId),
      outputProductUnitId: Number(head.outputProductUnitId),
      outputName: head.outputName ?? null,
      outputBase,
      laborCost: laborCost.toFixed(2),
      materialsCost: materialsCost.toFixed(2),
      totalCost: totalCost.toFixed(2),
      inputs,
    };
  });
}
