import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import {
  branchStock,
  bundleComponents,
  onlineOrderItems,
  onlineOrders,
  products,
  productUnits,
  productVariants,
  reservationStock,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";

/**
 * لقطة المخزون الحاكمة لكل (variant × branch).
 *
 * - `onHandBase` موقّع عمداً: لا نخفي العجز المخزني التاريخي.
 * - `availableBase` هو ATP التشغيلي، لذلك لا ينزل عن الصفر.
 * - `reservedBase` يجمع الحجز الرسمي وتخصيص طلبات المتجر النشطة. الطلب الإلكتروني
 *   نفسه هو سجل التخصيص القابل للتدقيق؛ CANCELLED/SHIPPED/DELIVERED تحرّره بحالته.
 * - البكج لا يملك رصيداً مستقلاً؛ تُشتق طاقته من مكوّناته مرة واحدة، ولا يُطرح
 *   أي صف legacy في reservationStock خاص بالـbundle مرةً ثانية.
 */
export interface VariantAvailability {
  onHandBase: number;
  /** صف reservationStock الرسمي وحده؛ يُفصل داخلياً لحسم تحويل صاحب الحجز. */
  formalReservationBase: number;
  reservedBase: number;
  availableBase: number;
  hasStockRow: boolean;
  isBundle: boolean;
  isService: boolean;
}

type QueryDb = DB | Tx;

export interface LoadVariantAvailabilityOptions {
  /**
   * قراءة حاليّة مع قفل حتمي للمتغيّرات. تستعملها كتابة الطلب الإلكتروني كي تتسلسل
   * محاولتان على آخر قطعة حتى لو بدأت كلتاهما قبل التزام الأخرى تحت REPEATABLE READ.
   */
  lock?: boolean;
  /** الطلب الجاري إدراجه يخصّص مخزونه في صفوفه؛ نستثنيه عند فحصه الذاتي فقط. */
  excludeOnlineOrderId?: number;
}

const ACTIVE_ONLINE_ALLOCATION_STATUSES = ["PENDING", "CONFIRMED", "PROCESSING"] as const;

export interface LockedProductUnit {
  id: number;
  variantId: number;
  unitName: string;
  conversionFactor: string;
  isActive: boolean;
}

/**
 * قفل وحدات المنتج هو mutex معنى الكمية في طلب المتجر. يجب أخذه بعد قفل العميل
 * وقبل variant/branchStock ثم صفوف الطلبات، كي لا يتغيّر conversionFactor بين
 * لقطة السلة وتثبيت تخصيصها، وكي يشترك الإنشاء والتعديل في ترتيب أقفال واحد.
 */
export async function lockProductUnitsForOnlineAllocation(
  db: QueryDb,
  productUnitIds: number[],
): Promise<LockedProductUnit[]> {
  const ids = Array.from(new Set(productUnitIds.map(Number).filter((id) =>
    Number.isSafeInteger(id) && id > 0))).sort((a, b) => a - b);
  if (!ids.length) return [];
  const rows = await db
    .select({
      id: productUnits.id,
      variantId: productUnits.variantId,
      unitName: productUnits.unitName,
      conversionFactor: productUnits.conversionFactor,
      isActive: productUnits.isActive,
    })
    .from(productUnits)
    .where(inArray(productUnits.id, ids))
    .orderBy(asc(productUnits.id))
    .for("update");
  return rows.map((row) => ({
    id: Number(row.id),
    variantId: Number(row.variantId),
    unitName: row.unitName,
    conversionFactor: String(row.conversionFactor),
    isActive: row.isActive === true,
  }));
}

/** يمنع تغيير معنى وحدة طلب نشط؛ وإلا يحجز الطلب عاملاً ثم يشحن عاملاً آخر. */
export async function assertNoActiveOnlineOrderUnitChanges(
  db: QueryDb,
  productUnitIds: number[],
): Promise<void> {
  const ids = Array.from(new Set(productUnitIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)));
  if (!ids.length) return;
  // لا يكفي قفل onlineOrderItems: قد يرى التعديل «لا طلب» ثم ينتظر وحدةً قفلها
  // إنشاء الطلب، وبعد التزامه يغيّر العامل. الوحدة أولاً تجعل الفحص Current Read صحيحاً.
  await lockProductUnitsForOnlineAllocation(db, ids);
  const active = (
    await db
      .select({ productUnitId: onlineOrderItems.productUnitId })
      .from(onlineOrderItems)
      .innerJoin(onlineOrders, eq(onlineOrderItems.onlineOrderId, onlineOrders.id))
      .where(and(
        inArray(onlineOrders.status, [...ACTIVE_ONLINE_ALLOCATION_STATUSES]),
        inArray(onlineOrderItems.productUnitId, ids),
      ))
      .for("update")
      .limit(1)
  )[0];
  if (active) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "لا يمكن تغيير معامل/حالة وحدة مرتبطة بطلب متجر نشط — ألغِ الطلب أو أرسله أولاً",
    });
  }
}

/** يمنع تبديل وصفة بكج طلبه زبون ولم يُحسم بعد. */
export async function assertNoActiveOnlineOrderBundleChange(
  db: QueryDb,
  bundleVariantId: number,
): Promise<void> {
  const active = (
    await db
      .select({ id: onlineOrderItems.id })
      .from(onlineOrderItems)
      .innerJoin(onlineOrders, eq(onlineOrderItems.onlineOrderId, onlineOrders.id))
      .where(and(
        inArray(onlineOrders.status, [...ACTIVE_ONLINE_ALLOCATION_STATUSES]),
        eq(onlineOrderItems.variantId, bundleVariantId),
      ))
      .for("update")
      .limit(1)
  )[0];
  if (active) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "لا يمكن تغيير مكوّنات بكج مرتبط بطلب متجر نشط — ألغِ الطلب أو أرسله أولاً",
    });
  }
}

async function loadOnlineAllocatedBase(
  db: QueryDb,
  branchId: number,
  variantIds: number[],
  options: LoadVariantAvailabilityOptions,
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (!variantIds.length) return result;

  const orderConditions = [
    eq(onlineOrders.branchId, branchId),
    inArray(onlineOrders.status, [...ACTIVE_ONLINE_ALLOCATION_STATUSES]),
  ];
  if (options.excludeOnlineOrderId != null) {
    orderConditions.push(ne(onlineOrders.id, options.excludeOnlineOrderId));
  }

  // البنود المباشرة فقط. بند البكج لا يُخصَّص على variant وهمي بل يُوسَّع أدناه.
  const directQuery = db
    .select({
      variantId: onlineOrderItems.variantId,
      baseQuantity: onlineOrderItems.baseQuantity,
    })
    .from(onlineOrderItems)
    .innerJoin(onlineOrders, eq(onlineOrderItems.onlineOrderId, onlineOrders.id))
    .innerJoin(productVariants, eq(onlineOrderItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(and(
      ...orderConditions,
      eq(products.isBundle, false),
      inArray(onlineOrderItems.variantId, variantIds),
    ))
    .orderBy(asc(onlineOrderItems.variantId), asc(onlineOrderItems.id));
  const directRows = options.lock ? await directQuery.for("update") : await directQuery;
  for (const row of directRows) {
    const variantId = Number(row.variantId);
    result.set(variantId, (result.get(variantId) ?? 0) + Math.max(0, Number(row.baseQuantity)));
  }

  // تخصيص البكج = كمية البكج الأساس × كمية المكوّن في الوصفة. لا نضيف تخصيصاً
  // للبكج نفسه، وبذلك لا يحدث double subtraction عند اشتراك بكج وبند مباشر بمكوّن واحد.
  const bundleQuery = db
    .select({
      orderItemId: onlineOrderItems.id,
      baseQuantity: onlineOrderItems.baseQuantity,
      componentVariantId: bundleComponents.componentVariantId,
      componentBaseQuantity: bundleComponents.componentBaseQuantity,
    })
    .from(onlineOrderItems)
    .innerJoin(onlineOrders, eq(onlineOrderItems.onlineOrderId, onlineOrders.id))
    .innerJoin(productVariants, eq(onlineOrderItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .innerJoin(bundleComponents, eq(bundleComponents.bundleVariantId, onlineOrderItems.variantId))
    .where(and(
      ...orderConditions,
      eq(products.isBundle, true),
      inArray(bundleComponents.componentVariantId, variantIds),
    ))
    .orderBy(asc(bundleComponents.componentVariantId), asc(onlineOrderItems.id));
  const bundleRows = options.lock ? await bundleQuery.for("update") : await bundleQuery;
  for (const row of bundleRows) {
    const variantId = Number(row.componentVariantId);
    const allocated = Math.max(0, Number(row.baseQuantity)) * Math.max(0, Number(row.componentBaseQuantity));
    result.set(variantId, (result.get(variantId) ?? 0) + allocated);
  }
  return result;
}

export async function loadVariantAvailability(
  db: QueryDb,
  branchId: number,
  variantIds: number[],
  options: LoadVariantAvailabilityOptions = {},
  ancestry: ReadonlySet<number> = new Set(),
): Promise<Map<number, VariantAvailability>> {
  const ids = Array.from(new Set(variantIds.map(Number).filter((id) =>
    Number.isSafeInteger(id) && id > 0 && !ancestry.has(id))));
  if (!ids.length) return new Map();

  const directQuery = db
    .select({
      variantId: productVariants.id,
      isBundle: products.isBundle,
      isService: products.isService,
      onHandBase: branchStock.quantity,
      reservedBase: reservationStock.reservedBase,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(
      branchStock,
      and(eq(branchStock.variantId, productVariants.id), eq(branchStock.branchId, branchId)),
    )
    .leftJoin(
      reservationStock,
      and(eq(reservationStock.variantId, productVariants.id), eq(reservationStock.branchId, branchId)),
    )
    .where(inArray(productVariants.id, ids))
    .orderBy(asc(productVariants.id));
  // قفل productVariants المضمون الوجود بترتيب id هو mutex الحتمي لكل محاولات
  // تخصيص المتجر، حتى عندما لا يوجد branchStock بعد. القراءة القافلة Current Read.
  const directRows = options.lock ? await directQuery.for("update") : await directQuery;
  const onlineAllocated = await loadOnlineAllocatedBase(db, branchId, ids, options);

  const result = new Map<number, VariantAvailability>();
  const bundleIds: number[] = [];
  for (const row of directRows) {
    const variantId = Number(row.variantId);
    const onHandBase = Number(row.onHandBase ?? 0);
    const formalReservationBase = Math.max(0, Number(row.reservedBase ?? 0));
    const reservedBase = formalReservationBase + Math.max(0, onlineAllocated.get(variantId) ?? 0);
    const isBundle = row.isBundle === true;
    result.set(variantId, {
      onHandBase,
      formalReservationBase,
      reservedBase,
      availableBase: Math.max(0, onHandBase - reservedBase),
      hasStockRow: row.onHandBase != null,
      isBundle,
      isService: row.isService === true,
    });
    if (isBundle) bundleIds.push(variantId);
  }

  if (!bundleIds.length) return result;
  const componentRows = await db
    .select({
      bundleVariantId: bundleComponents.bundleVariantId,
      componentVariantId: bundleComponents.componentVariantId,
      componentBaseQuantity: bundleComponents.componentBaseQuantity,
    })
    .from(bundleComponents)
    .where(inArray(bundleComponents.bundleVariantId, bundleIds));
  const componentIds = Array.from(new Set(componentRows.map((row) => Number(row.componentVariantId))));
  const nextAncestry = new Set(ancestry);
  for (const bundleId of bundleIds) nextAncestry.add(bundleId);
  const componentAvailability = componentIds.length
    ? await loadVariantAvailability(db, branchId, componentIds, options, nextAncestry)
    : new Map<number, VariantAvailability>();

  for (const bundleId of bundleIds) {
    const components = componentRows.filter((row) => Number(row.bundleVariantId) === bundleId);
    if (!components.length) {
      result.set(bundleId, {
        onHandBase: 0,
        formalReservationBase: 0,
        reservedBase: 0,
        availableBase: 0,
        hasStockRow: false,
        isBundle: true,
        isService: false,
      });
      continue;
    }

    let onHandCapacity = Number.POSITIVE_INFINITY;
    let availableCapacity = Number.POSITIVE_INFINITY;
    let complete = true;
    for (const component of components) {
      const quantity = Number(component.componentBaseQuantity);
      const availability = componentAvailability.get(Number(component.componentVariantId));
      if (!availability || !Number.isFinite(quantity) || quantity <= 0 || availability.isBundle) {
        complete = false;
        break;
      }
      if (availability.isService) continue;
      onHandCapacity = Math.min(onHandCapacity, Math.floor(availability.onHandBase / quantity));
      availableCapacity = Math.min(availableCapacity, Math.floor(availability.availableBase / quantity));
    }

    if (!complete || onHandCapacity === Number.POSITIVE_INFINITY || availableCapacity === Number.POSITIVE_INFINITY) {
      result.set(bundleId, {
        onHandBase: 0,
        formalReservationBase: 0,
        reservedBase: 0,
        availableBase: 0,
        hasStockRow: false,
        isBundle: true,
        isService: false,
      });
      continue;
    }

    const availableBase = Math.max(0, availableCapacity);
    result.set(bundleId, {
      onHandBase: onHandCapacity,
      // لا يوجد صف حجز للبكج نفسه؛ السعة مشتقة من المكونات ولا تُستعمل لحركة مباشرة.
      formalReservationBase: 0,
      reservedBase: Math.max(0, onHandCapacity - availableBase),
      availableBase,
      hasStockRow: components.every((component) =>
        componentAvailability.get(Number(component.componentVariantId))?.isService === true
          || componentAvailability.get(Number(component.componentVariantId))?.hasStockRow === true),
      isBundle: true,
      isService: false,
    });
  }

  return result;
}
