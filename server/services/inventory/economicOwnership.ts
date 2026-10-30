import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { asc, eq, inArray } from "drizzle-orm";
import {
  branchStock,
  inventoryProjectionState,
  products,
  productVariants,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { assertFinancialWriterGateHeld } from "../tx";
import { lockInventoryVariants, hasInventoryVariantLocks } from "./stockLock";
import {
  baseInteger,
  changeTransitProjection,
  INVENTORY_PROJECTION_VERSION,
  parseTransitProjection,
  positiveId,
} from "./transitProjection";

type ProductMetadata = Pick<
  typeof products.$inferSelect,
  | "id"
  | "name"
  | "isActive"
  | "isService"
  | "isBundle"
  | "isConsignment"
  | "consignorId"
  | "productType"
>;
export interface EconomicInventoryScope {
  readonly variantIds: readonly number[];
}
const scopes = new WeakMap<
  Tx,
  {
    token: EconomicInventoryScope;
    productByVariant: Map<number, ProductMetadata>;
    productLock: "share" | "update";
  }
>();
function conflict(
  why: string,
  code: "PRECONDITION_FAILED" | "CONFLICT" = "PRECONDITION_FAILED",
): TRPCError {
  return new TRPCError({
    code,
    message: appErrorMessage({
      what: "تعذّر تثبيت ملكية المخزون والإسقاط بالطريق",
      why,
      doThis:
        "حدّث العملية وأعد المحاولة؛ إن استمر التعارض أوقف الكتابة وراجع تفعيل إسقاط المخزون",
    }),
  });
}
function validateScope(
  tx: Tx,
  scope: EconomicInventoryScope,
  ids: readonly number[],
) {
  assertFinancialWriterGateHeld(tx);
  const current = scopes.get(tx);
  if (
    !current ||
    current.token !== scope ||
    ids.some((id) => !current.productByVariant.has(id))
  )
    throw conflict(
      "نطاق معاملة المخزون غير مكتمل أو لا ينتمي إلى المعاملة الحالية",
    );
  return current;
}
const readyTransactions = new WeakSet<Tx>();
/** Existing marker proof only: never creates a scope or repairs runtime state. */
export async function assertEconomicInventoryReady(tx: Tx): Promise<void> {
  assertFinancialWriterGateHeld(tx);
  if (readyTransactions.has(tx)) return;
  const [state] = await tx
    .select()
    .from(inventoryProjectionState)
    .where(eq(inventoryProjectionState.id, 1))
    .for("share")
    .limit(1);
  if (!state || state.readyVersion !== INVENTORY_PROJECTION_VERSION)
    throw conflict("إسقاط المخزون غير مهيأ أو إصداره غير مدعوم");
  readyTransactions.add(tx);
}
/** Must precede any variant mutex. A nested call may reuse a subset, never expand it. */
export async function lockEconomicInventoryScope(
  tx: Tx,
  variantIds: readonly number[],
  options: { productLock?: "share" | "update" } = {},
): Promise<EconomicInventoryScope> {
  assertFinancialWriterGateHeld(tx);
  const ids = Array.from(new Set(variantIds.map(positiveId))).sort(
    (a, b) => a - b,
  );
  const existing = scopes.get(tx);
  if (existing) {
    validateScope(tx, existing.token, ids);
    if (options.productLock === "update" && existing.productLock !== "update")
      throw conflict("لا يمكن ترقية أقفال المنتجات بعد تثبيت نطاق المخزون", "CONFLICT");
    return existing.token;
  }
  if (hasInventoryVariantLocks(tx))
    throw conflict(
      "يجب تثبيت النطاق الكامل قبل أقفال الأصناف، ولا يُسمح بتوسيعه لاحقاً",
    );
  await assertEconomicInventoryReady(tx);
  const refs = ids.length
    ? await tx
        .select({
          id: productVariants.id,
          productId: productVariants.productId,
        })
        .from(productVariants)
        .where(inArray(productVariants.id, ids))
    : [];
  if (refs.length !== ids.length) throw conflict("أحد الأصناف غير موجود");
  const productById = new Map<number, ProductMetadata>();
  for (const productId of Array.from(
    new Set(refs.map((r) => r.productId)),
  ).sort((a, b) => a - b)) {
    const [row] = await tx
      .select({
        id: products.id,
        name: products.name,
        isActive: products.isActive,
        isService: products.isService,
        isBundle: products.isBundle,
        isConsignment: products.isConsignment,
        consignorId: products.consignorId,
        productType: products.productType,
      })
      .from(products)
      .where(eq(products.id, productId))
      .for(options.productLock ?? "share")
      .limit(1);
    if (!row) throw conflict("تغيّر المنتج أثناء تثبيت نطاق الأقفال");
    productById.set(productId, row);
  }
  await lockInventoryVariants(tx, ids);
  const productByVariant = new Map<number, ProductMetadata>();
  for (const ref of refs) {
    const [row] = await tx
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, ref.id))
      .for("update")
      .limit(1);
    const product = productById.get(ref.productId);
    if (!row || row.productId !== ref.productId || !product)
      throw conflict("تغيّرت هوية الصنف أثناء انتظار الأقفال", "CONFLICT");
    try {
      parseTransitProjection(row.transitBaseBySourceBranch);
    } catch {
      throw conflict(`الإسقاط بالطريق للصنف #${ref.id} غير مهيأ أو معطوب`);
    }
    productByVariant.set(ref.id, product);
  }
  const token = Object.freeze({ variantIds: Object.freeze(ids) });
  scopes.set(tx, { token, productByVariant, productLock: options.productLock ?? "share" });
  return token;
}
/** Reposting may reuse an exclusive scope, but cannot expand or upgrade after variant locks. */
export function assertEconomicInventoryRepostScope(tx: Tx, variantIds: readonly number[]): void {
  const existing = scopes.get(tx);
  if (!existing) return;
  validateScope(tx, existing.token, variantIds);
  if (existing.productLock !== "update")
    throw conflict("يجب تثبيت أقفال المنتجات الحصرية قبل عكس الفاتورة وإعادة إصدارها", "CONFLICT");
}
/** Always refresh the locked PK; repeated cost/quantity mutations must see their own writes. */
export async function readEconomicVariant(
  tx: Tx,
  scope: EconomicInventoryScope,
  variantId: number,
) {
  const current = validateScope(tx, scope, [variantId]);
  const [variant] = await tx
    .select()
    .from(productVariants)
    .where(eq(productVariants.id, variantId))
    .for("update")
    .limit(1);
  if (
    !variant ||
    variant.productId !== current.productByVariant.get(variantId)!.id
  )
    throw conflict("تغيّرت هوية الصنف داخل النطاق", "CONFLICT");
  return {
    ...variant,
    product: current.productByVariant.get(variantId)!,
    transitBaseBySourceBranch: parseTransitProjection(
      variant.transitBaseBySourceBranch,
    ),
  };
}
export async function changeEconomicTransit(
  tx: Tx,
  scope: EconomicInventoryScope,
  sourceBranchId: number,
  quantities: ReadonlyMap<number, number>,
  direction: 1 | -1,
): Promise<void> {
  validateScope(tx, scope, Array.from(quantities.keys()));
  for (const [id, quantity] of Array.from(quantities).sort(
    ([a], [b]) => a - b,
  )) {
    const row = await readEconomicVariant(tx, scope, id);
    if (row.product.isBundle || row.product.isService)
      throw conflict(`الصنف #${id} ليس مخزوناً فعلياً`);
    let next;
    try {
      next = changeTransitProjection(
        row.transitBaseBySourceBranch,
        sourceBranchId,
        baseInteger(quantity) * direction,
      );
    } catch {
      throw conflict(
        `لا يطابق الإسقاط بالطريق للصنف #${id} الكمية الموثقة؛ منع نقص أو تجاوز الإسقاط`,
      );
    }
    await tx
      .update(productVariants)
      .set({ transitBaseBySourceBranch: next })
      .where(eq(productVariants.id, id));
  }
}
export async function readEconomicOwnedPositions(
  tx: Tx,
  scope: EconomicInventoryScope,
  variantId: number,
) {
  const variant = await readEconomicVariant(tx, scope, variantId);
  const shelf = await tx
    .select({ branchId: branchStock.branchId, quantity: branchStock.quantity })
    .from(branchStock)
    .where(eq(branchStock.variantId, variantId))
    .orderBy(asc(branchStock.id))
    .for("share");
  const byBranch = new Map<
    number,
    {
      variantId: number;
      branchId: number;
      shelfQuantity: number;
      inTransitQuantity: number;
      ownedQuantity: number;
    }
  >();
  for (const row of shelf)
    byBranch.set(row.branchId, {
      variantId,
      branchId: row.branchId,
      shelfQuantity: row.quantity,
      inTransitQuantity: 0,
      ownedQuantity: row.quantity,
    });
  for (const [branch, raw] of Object.entries(
    variant.transitBaseBySourceBranch,
  )) {
    const branchId = Number(branch),
      quantity = Number(raw);
    const position = byBranch.get(branchId) ?? {
      variantId,
      branchId,
      shelfQuantity: 0,
      inTransitQuantity: 0,
      ownedQuantity: 0,
    };
    position.inTransitQuantity = quantity;
    position.ownedQuantity = position.shelfQuantity + quantity;
    if (!Number.isSafeInteger(position.ownedQuantity))
      throw conflict("تجاوز كمية المخزون المسموح");
    byBranch.set(branchId, position);
  }
  const owned =
    !variant.product.isConsignment &&
    !variant.product.isService &&
    !variant.product.isBundle;
  return {
    variant,
    positions: owned
      ? Array.from(byBranch.values()).sort((a, b) => a.branchId - b.branchId)
      : [],
  };
}
