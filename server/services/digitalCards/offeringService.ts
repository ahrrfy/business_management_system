/**
 * CRUD for digitalOfferings + digitalOfferingBranches.
 * Auto-creates a service product (isService, productType=DIGITAL_CARD) when no productId is supplied.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  digitalProviders,
  digitalOfferings,
  digitalOfferingBranches,
  digitalWallets,
  products,
  productVariants,
  productUnits,
  productPrices,
  branches,
  suppliers,
  auditLogs,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { money, toDbMoney } from "../money";
import type { Actor } from "../tx";
import { redactAuditValue } from "../auditService";

/* ────────── Enum validation ────────── */
const OFFERING_TYPES = ["TELECOM_CARD", "GLOBAL_CARD", "EDUCATIONAL_SUBSCRIPTION", "OTHER"] as const;
const PRICING_MODES = ["FIXED_MARGIN", "PERCENT_MARGIN", "FIXED_PLUS_PERCENT", "FIXED_SELL_PRICE"] as const;

function assertEnum<T extends string>(val: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(val as T)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `${label} غير صالح: ${val}` });
  }
  return val as T;
}

/* ────────── Types ────────── */
export interface OfferingBranchInput {
  branchId: number;
  walletId?: number | null;
  isFavorite?: boolean;
  displayOrder?: number;
}

export interface CreateOfferingInput {
  providerId: number;
  offeringType: string;
  name: string;
  requiresStudentData?: boolean;
  subscriptionDurationDays?: number | null;
  faceValue?: string | null;
  faceCurrency?: string | null;
  pricingMode: string;
  fixedMargin?: string | null;
  marginPercent?: string | null;
  minimumMargin?: string | null;
  roundingStep?: string | null;
  priceValidityHours?: number | null;
  cardColorToken?: string | null;
  categoryId?: number | null;
  productId?: number | null;
  branches: OfferingBranchInput[];
}

export interface UpdateOfferingInput {
  id: number;
  /** اسم العرض يعيش في `products.name` (لا عمود اسم في digitalOfferings) ⇒ يُحدَّث هناك. */
  name?: string;
  offeringType?: string;
  requiresStudentData?: boolean;
  subscriptionDurationDays?: number | null;
  faceValue?: string | null;
  faceCurrency?: string | null;
  pricingMode?: string;
  fixedMargin?: string | null;
  marginPercent?: string | null;
  minimumMargin?: string | null;
  roundingStep?: string | null;
  priceValidityHours?: number | null;
  cardColorToken?: string | null;
  isActive?: boolean;
  branches?: OfferingBranchInput[];
}

export interface OfferingFilters {
  providerId?: number;
  offeringType?: string;
  isActive?: boolean;
  branchId?: number;
}

/* ────────── Audit helper ────────── */
async function auditLog(
  tx: Tx,
  actor: Actor,
  action: string,
  entityId: number,
  details: unknown,
): Promise<void> {
  try {
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: actor.branchId,
      action,
      entityType: "digitalOffering",
      entityId: String(entityId),
      newValue: redactAuditValue(details),
    });
  } catch {
    // best-effort
  }
}

/* ────────── Auto-create product ────────── */
/**
 * Creates a minimal service product for a digital offering.
 * Direct Drizzle inserts to avoid coupling with the complex product creation pipeline.
 */
async function autoCreateProduct(
  tx: Tx,
  name: string,
  categoryId: number | null | undefined,
  actor: Actor,
): Promise<{ productId: number; variantId: number; productUnitId: number }> {
  // Insert product
  const prodResult = await tx.insert(products).values({
    name,
    productType: "DIGITAL_CARD",
    isService: true,
    isBundle: false,
    isConsignment: false,
    isFeatured: false,
    showInStore: false,
    showInReception: false,
    categoryId: categoryId ?? null,
    isActive: true,
  });
  const productId = extractInsertId(prodResult);

  // Insert default variant
  const varResult = await tx.insert(productVariants).values({
    productId,
    sku: `DC-${productId}`,
    variantName: "الافتراضي", // "الافتراضي"
    costPrice: "0",
    isActive: true,
  });
  const variantId = extractInsertId(varResult);

  // Insert base unit
  const unitResult = await tx.insert(productUnits).values({
    variantId,
    unitName: "بطاقة", // "بطاقة"
    conversionFactor: "1",
    isBaseUnit: true,
    isActive: true,
  });
  const productUnitId = extractInsertId(unitResult);

  // Insert placeholder RETAIL price (real price comes from digital pricing)
  await tx.insert(productPrices).values({
    productUnitId,
    priceTier: "RETAIL",
    price: "0",
  });

  return { productId, variantId, productUnitId };
}

/* ────────── Create ────────── */
export async function createOffering(
  tx: Tx,
  input: CreateOfferingInput,
  actor: Actor,
): Promise<{ offeringId: number; productId: number; variantId: number; productUnitId: number }> {
  const offeringType = assertEnum(input.offeringType, OFFERING_TYPES, "نوع العرض");
  const pricingMode = assertEnum(input.pricingMode, PRICING_MODES, "نمط التسعير");
  const name = input.name?.trim();
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم العرض مطلوب" });

  if (!input.branches?.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "يجب تحديد فرع واحد على الأقل" });
  }
  if (offeringType === "EDUCATIONAL_SUBSCRIPTION") {
    if (!input.requiresStudentData) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "الاشتراك التعليمي يحتاج اسم الطالب وهاتفه عند البيع",
      });
    }
  }

  // 1. Verify provider exists and is active
  const [provider] = await tx
    .select({
      id: digitalProviders.id,
      isActive: digitalProviders.isActive,
      settlementMode: digitalProviders.settlementMode,
    })
    .from(digitalProviders)
    .where(eq(digitalProviders.id, input.providerId))
    .limit(1);
  if (!provider) {
    throw new TRPCError({ code: "NOT_FOUND", message: "المزوّد غير موجود" });
  }
  if (!provider.isActive) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "المزوّد معطَّل" });
  }

  // 2. Product: auto-create or link existing
  let productId: number;
  let variantId: number;
  let productUnitId: number;

  if (input.productId != null) {
    // Link to existing product — verify it's a service product
    const [prod] = await tx
      .select({
        id: products.id,
        isService: products.isService,
        productType: products.productType,
        isConsignment: products.isConsignment,
        consignorId: products.consignorId,
      })
      .from(products)
      .where(eq(products.id, input.productId))
      .limit(1);
    if (!prod) {
      throw new TRPCError({ code: "NOT_FOUND", message: "المنتج غير موجود" });
    }
    if (!prod.isService) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "المنتج يجب أن يكون خدمياً (isService)" });
    }
    if (prod.isConsignment || prod.consignorId != null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن ربط عرض رقمي بمنتج أمانة؛ تسوية المزوّد الرقمي هي المصدر المالي الوحيد لهذا البيع",
      });
    }
    productId = prod.id;

    // Get the first variant
    const [variant] = await tx
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(eq(productVariants.productId, productId))
      .limit(1);
    if (!variant) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "المنتج بلا متغيّرات" });
    }
    variantId = variant.id;

    // Get the base unit
    const [unit] = await tx
      .select({ id: productUnits.id })
      .from(productUnits)
      .where(and(eq(productUnits.variantId, variantId), eq(productUnits.isBaseUnit, true)))
      .limit(1);
    if (!unit) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "المنتج بلا وحدة أساس" });
    }
    productUnitId = unit.id;
  } else {
    // Auto-create product
    const created = await autoCreateProduct(tx, name, input.categoryId, actor);
    productId = created.productId;
    variantId = created.variantId;
    productUnitId = created.productUnitId;
  }

  // Validate money fields
  const faceValue = input.faceValue != null ? toDbMoney(money(input.faceValue)) : null;
  const fixedMargin = toDbMoney(money(input.fixedMargin ?? "0"));
  const marginPercent = toDbMoney(money(input.marginPercent ?? "0"));
  const minimumMargin = toDbMoney(money(input.minimumMargin ?? "0"));
  const roundingStep = toDbMoney(money(input.roundingStep ?? "250"));

  // 3. Insert digitalOfferings row
  const offeringResult = await tx.insert(digitalOfferings).values({
    providerId: input.providerId,
    productId,
    variantId,
    productUnitId,
    offeringType,
    requiresStudentData: input.requiresStudentData ?? false,
    // نحن نبيع الاشتراك فقط؛ مدة المنصة وانتهاؤها ليست التزاماً تشغيلياً على نظامنا.
    subscriptionDurationDays: null,
    faceValue,
    faceCurrency: input.faceCurrency?.trim() || null,
    pricingMode,
    fixedMargin,
    marginPercent,
    minimumMargin,
    roundingStep,
    priceValidityHours: input.priceValidityHours ?? null,
    cardColorToken: input.cardColorToken?.trim() || null,
    isActive: true,
  });
  const offeringId = extractInsertId(offeringResult);

  // 4. Insert digitalOfferingBranches rows
  await insertOfferingBranches(tx, offeringId, input.providerId, input.branches, provider.settlementMode);

  // 5. Audit
  await auditLog(tx, actor, "digitalCards.offering.create", offeringId, {
    providerId: input.providerId,
    productId,
    offeringType,
    name,
    branchCount: input.branches.length,
  });

  return { offeringId, productId, variantId, productUnitId };
}

/* ────────── Insert offering-branch rows ────────── */
async function insertOfferingBranches(
  tx: Tx,
  offeringId: number,
  providerId: number,
  branchInputs: OfferingBranchInput[],
  providerSettlementMode: string,
): Promise<void> {
  for (const b of branchInputs) {
    // Verify branch exists
    const [branch] = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(eq(branches.id, b.branchId))
      .limit(1);
    if (!branch) {
      throw new TRPCError({ code: "NOT_FOUND", message: `الفرع ${b.branchId} غير موجود` });
    }

    if (providerSettlementMode === "PREPAID" && b.walletId == null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `اختر محفظة المزوّد للفرع ${b.branchId}؛ البيع المسبق لا يعمل بلا محفظة`,
      });
    }

    // If walletId provided, verify it belongs to the right provider/branch and is usable.
    let walletId: number | null = null;
    if (b.walletId != null) {
      if (providerSettlementMode !== "PREPAID") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "لا يمكن ربط محفظة بعرض لمزوّد غير مسبق الدفع",
        });
      }
      const [wallet] = await tx
        .select({
          id: digitalWallets.id,
          providerId: digitalWallets.providerId,
          branchId: digitalWallets.branchId,
          isActive: digitalWallets.isActive,
        })
        .from(digitalWallets)
        .where(eq(digitalWallets.id, b.walletId))
        .limit(1);
      if (!wallet) {
        throw new TRPCError({ code: "NOT_FOUND", message: `المحفظة ${b.walletId} غير موجودة` });
      }
      if (Number(wallet.branchId) !== b.branchId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `المحفظة ${b.walletId} لا تنتمي للفرع ${b.branchId}`,
        });
      }
      if (Number(wallet.providerId) !== providerId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `المحفظة ${b.walletId} لا تتبع المزوّد المحدد`,
        });
      }
      if (!wallet.isActive) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `المحفظة ${b.walletId} معطّلة؛ فعّلها أو اختر محفظة أخرى`,
        });
      }
      walletId = b.walletId;
    }

    await tx.insert(digitalOfferingBranches).values({
      offeringId,
      branchId: b.branchId,
      walletId,
      isActive: true,
      isFavorite: b.isFavorite ?? false,
      displayOrder: b.displayOrder ?? 0,
    });
  }
}

/* ────────── Update ────────── */
export async function updateOffering(
  tx: Tx,
  input: UpdateOfferingInput,
  actor: Actor,
): Promise<void> {
  const [existing] = await tx
    .select({
      id: digitalOfferings.id,
      providerId: digitalOfferings.providerId,
      productId: digitalOfferings.productId,
      offeringType: digitalOfferings.offeringType,
      requiresStudentData: digitalOfferings.requiresStudentData,
      subscriptionDurationDays: digitalOfferings.subscriptionDurationDays,
    })
    .from(digitalOfferings)
    .where(eq(digitalOfferings.id, input.id))
    .limit(1);
  if (!existing) {
    throw new TRPCError({ code: "NOT_FOUND", message: "العرض غير موجود" });
  }

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم العرض مطلوب" });
    await tx.update(products).set({ name }).where(eq(products.id, existing.productId));
  }

  // Fulfilment semantics are immutable. Existing intents/contracts depend on these
  // values and the current schema has no per-intent snapshot columns for them.
  // To change the kind or duration, create a new offering and deactivate this one.
  if (input.offeringType !== undefined) {
    const requested = assertEnum(input.offeringType, OFFERING_TYPES, "نوع العرض");
    if (requested !== existing.offeringType) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "لا يمكن تغيير نوع عرض منشأ؛ أنشئ عرضاً جديداً وعطّل القديم لحماية المبيعات السابقة",
      });
    }
  }
  if (input.requiresStudentData !== undefined && input.requiresStudentData !== existing.requiresStudentData) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "لا يمكن تغيير اشتراط بيانات الطالب بعد إنشاء العرض؛ أنشئ عرضاً جديداً",
    });
  }
  if (input.subscriptionDurationDays !== undefined) {
    const requestedDuration = input.subscriptionDurationDays == null ? null : Number(input.subscriptionDurationDays);
    const storedDuration = existing.subscriptionDurationDays == null ? null : Number(existing.subscriptionDurationDays);
    if (requestedDuration !== storedDuration) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "لا يمكن تغيير مدة اشتراك عرض منشأ؛ أنشئ عرضاً جديداً وعطّل القديم",
      });
    }
  }

  // Build update set — identity and fulfilment semantics are immutable.
  const set: Record<string, unknown> = {};
  if (input.faceValue !== undefined) {
    set.faceValue = input.faceValue != null ? toDbMoney(money(input.faceValue)) : null;
  }
  if (input.faceCurrency !== undefined) {
    set.faceCurrency = input.faceCurrency?.trim() || null;
  }
  if (input.pricingMode !== undefined) {
    set.pricingMode = assertEnum(input.pricingMode, PRICING_MODES, "نمط التسعير");
  }
  if (input.fixedMargin !== undefined) {
    set.fixedMargin = toDbMoney(money(input.fixedMargin ?? "0"));
  }
  if (input.marginPercent !== undefined) {
    set.marginPercent = toDbMoney(money(input.marginPercent ?? "0"));
  }
  if (input.minimumMargin !== undefined) {
    set.minimumMargin = toDbMoney(money(input.minimumMargin ?? "0"));
  }
  if (input.roundingStep !== undefined) {
    set.roundingStep = toDbMoney(money(input.roundingStep ?? "250"));
  }
  if (input.priceValidityHours !== undefined) {
    set.priceValidityHours = input.priceValidityHours;
  }
  if (input.cardColorToken !== undefined) {
    set.cardColorToken = input.cardColorToken?.trim() || null;
  }
  if (input.isActive !== undefined) {
    set.isActive = input.isActive;
  }

  if (Object.keys(set).length > 0) {
    await tx.update(digitalOfferings).set(set).where(eq(digitalOfferings.id, input.id));
  }

  // Update branches if provided — full replace strategy
  if (input.branches !== undefined) {
    // Get provider settlement mode for validation
    const [provider] = await tx
      .select({ settlementMode: digitalProviders.settlementMode })
      .from(digitalProviders)
      .where(eq(digitalProviders.id, existing.providerId))
      .limit(1);
    const settlementMode = provider?.settlementMode ?? "POSTPAID";

    // Delete existing branch rows, insert new ones
    await tx
      .delete(digitalOfferingBranches)
      .where(eq(digitalOfferingBranches.offeringId, input.id));

    if (input.branches.length > 0) {
      await insertOfferingBranches(tx, input.id, existing.providerId, input.branches, settlementMode);
    }
  }

  await auditLog(tx, actor, "digitalCards.offering.update", input.id, {
    changes: set,
    nameChanged: input.name !== undefined,
    branchesReplaced: input.branches !== undefined,
  });
}

/* ────────── Reorder (ترتيب العرض داخل شبكة الكاشير لفرع بعينه) ────────── */
export async function reorderOfferings(
  tx: Tx,
  input: { branchId: number; order: { offeringId: number; displayOrder: number }[] },
  actor: Actor,
): Promise<void> {
  for (const item of input.order) {
    await tx
      .update(digitalOfferingBranches)
      .set({ displayOrder: item.displayOrder })
      .where(
        and(
          eq(digitalOfferingBranches.offeringId, item.offeringId),
          eq(digitalOfferingBranches.branchId, input.branchId),
        ),
      );
  }
  await auditLog(tx, actor, "digitalCards.offering.reorder", input.branchId, {
    branchId: input.branchId,
    count: input.order.length,
  });
}

/* ────────── List ────────── */
export async function listOfferings(db: DB, filters?: OfferingFilters) {
  const conds = [];
  if (filters?.providerId != null) {
    conds.push(eq(digitalOfferings.providerId, filters.providerId));
  }
  if (filters?.offeringType != null) {
    conds.push(eq(digitalOfferings.offeringType, assertEnum(filters.offeringType, OFFERING_TYPES, "نوع العرض")));
  }
  if (filters?.isActive != null) {
    conds.push(eq(digitalOfferings.isActive, filters.isActive));
  }

  const rows = await db
    .select({
      id: digitalOfferings.id,
      providerId: digitalOfferings.providerId,
      providerType: digitalProviders.providerType,
      settlementMode: digitalProviders.settlementMode,
      supplierName: suppliers.name,
      productId: digitalOfferings.productId,
      productName: products.name,
      variantId: digitalOfferings.variantId,
      productUnitId: digitalOfferings.productUnitId,
      offeringType: digitalOfferings.offeringType,
      requiresStudentData: digitalOfferings.requiresStudentData,
      subscriptionDurationDays: digitalOfferings.subscriptionDurationDays,
      faceValue: digitalOfferings.faceValue,
      faceCurrency: digitalOfferings.faceCurrency,
      pricingMode: digitalOfferings.pricingMode,
      fixedMargin: digitalOfferings.fixedMargin,
      marginPercent: digitalOfferings.marginPercent,
      minimumMargin: digitalOfferings.minimumMargin,
      roundingStep: digitalOfferings.roundingStep,
      priceValidityHours: digitalOfferings.priceValidityHours,
      cardColorToken: digitalOfferings.cardColorToken,
      isActive: digitalOfferings.isActive,
      createdAt: digitalOfferings.createdAt,
      updatedAt: digitalOfferings.updatedAt,
    })
    .from(digitalOfferings)
    .innerJoin(digitalProviders, eq(digitalOfferings.providerId, digitalProviders.id))
    .innerJoin(suppliers, eq(digitalProviders.supplierId, suppliers.id))
    .innerJoin(products, eq(digitalOfferings.productId, products.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(digitalOfferings.id);

  const offeringIds = rows.map((r) => r.id);
  if (offeringIds.length === 0) return [];

  // The wallet code identifies the provider device/account, while its name is
  // the operator-facing wallet label. Return both with the branch so the list
  // can show every assignment without issuing one request per offering.
  const assignmentConds = [inArray(digitalOfferingBranches.offeringId, offeringIds)];
  if (filters?.branchId != null) {
    assignmentConds.push(eq(digitalOfferingBranches.branchId, filters.branchId));
  }
  const assignmentRows = await db
    .select({
      offeringId: digitalOfferingBranches.offeringId,
      branchId: digitalOfferingBranches.branchId,
      branchName: branches.name,
      walletId: digitalOfferingBranches.walletId,
      deviceCode: digitalWallets.code,
      walletName: digitalWallets.name,
      walletIsActive: digitalWallets.isActive,
    })
    .from(digitalOfferingBranches)
    .innerJoin(branches, eq(digitalOfferingBranches.branchId, branches.id))
    .leftJoin(digitalWallets, eq(digitalOfferingBranches.walletId, digitalWallets.id))
    .where(and(...assignmentConds))
    .orderBy(asc(digitalOfferingBranches.branchId));

  const assignmentsByOffering = new Map<number, typeof assignmentRows>();
  for (const assignment of assignmentRows) {
    const assignments = assignmentsByOffering.get(assignment.offeringId) ?? [];
    assignments.push(assignment);
    assignmentsByOffering.set(assignment.offeringId, assignments);
  }

  const withAssignments = rows.map((row) => ({
    ...row,
    assignments: assignmentsByOffering.get(row.id) ?? [],
  }));

  // A scoped branch must not learn that an offering exists only in another branch.
  return filters?.branchId == null
    ? withAssignments
    : withAssignments.filter((row) => row.assignments.length > 0);
}

/* ────────── Get single ────────── */
export async function getOffering(db: DB, id: number, branchId?: number | null) {
  const [row] = await db
    .select({
      id: digitalOfferings.id,
      providerId: digitalOfferings.providerId,
      providerType: digitalProviders.providerType,
      settlementMode: digitalProviders.settlementMode,
      supplierName: suppliers.name,
      productId: digitalOfferings.productId,
      productName: products.name,
      variantId: digitalOfferings.variantId,
      productUnitId: digitalOfferings.productUnitId,
      offeringType: digitalOfferings.offeringType,
      requiresStudentData: digitalOfferings.requiresStudentData,
      subscriptionDurationDays: digitalOfferings.subscriptionDurationDays,
      faceValue: digitalOfferings.faceValue,
      faceCurrency: digitalOfferings.faceCurrency,
      pricingMode: digitalOfferings.pricingMode,
      fixedMargin: digitalOfferings.fixedMargin,
      marginPercent: digitalOfferings.marginPercent,
      minimumMargin: digitalOfferings.minimumMargin,
      roundingStep: digitalOfferings.roundingStep,
      priceValidityHours: digitalOfferings.priceValidityHours,
      cardColorToken: digitalOfferings.cardColorToken,
      isActive: digitalOfferings.isActive,
      createdAt: digitalOfferings.createdAt,
      updatedAt: digitalOfferings.updatedAt,
    })
    .from(digitalOfferings)
    .innerJoin(digitalProviders, eq(digitalOfferings.providerId, digitalProviders.id))
    .innerJoin(suppliers, eq(digitalProviders.supplierId, suppliers.id))
    .innerJoin(products, eq(digitalOfferings.productId, products.id))
    .where(eq(digitalOfferings.id, id))
    .limit(1);
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "العرض غير موجود" });
  }

  if (branchId != null) {
    const [linked] = await db
      .select({ offeringId: digitalOfferingBranches.offeringId })
      .from(digitalOfferingBranches)
      .where(and(
        eq(digitalOfferingBranches.offeringId, id),
        eq(digitalOfferingBranches.branchId, branchId),
      ))
      .limit(1);
    if (!linked) {
      throw new TRPCError({ code: "FORBIDDEN", message: "العرض غير متاح في فرع المستخدم" });
    }
  }

  // Fetch branches with details
  const offeringBranches = await db
    .select({
      branchId: digitalOfferingBranches.branchId,
      branchName: branches.name,
      walletId: digitalOfferingBranches.walletId,
      walletName: digitalWallets.name,
      isActive: digitalOfferingBranches.isActive,
      isFavorite: digitalOfferingBranches.isFavorite,
      displayOrder: digitalOfferingBranches.displayOrder,
    })
    .from(digitalOfferingBranches)
    .innerJoin(branches, eq(digitalOfferingBranches.branchId, branches.id))
    .leftJoin(digitalWallets, eq(digitalOfferingBranches.walletId, digitalWallets.id))
    .where(and(
      eq(digitalOfferingBranches.offeringId, id),
      ...(branchId == null ? [] : [eq(digitalOfferingBranches.branchId, branchId)]),
    ))
    .orderBy(digitalOfferingBranches.displayOrder);

  return { ...row, branches: offeringBranches };
}
