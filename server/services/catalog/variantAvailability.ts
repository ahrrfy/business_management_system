import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
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
  /** للبكج وحده: تفسير الطاقة المشتقّة — من يحدّها وهل يمنع البيع. `null` لغير البكج. */
  bundleCapacity: BundleCapacity | null;
}

/**
 * سبب طاقة البكج كما تُعرَض للمستخدم. صفرٌ بلا سبب كان يجعل البكج يبدو معطوباً وهو يعمل:
 * لا فرق بصرياً بين «بكج بلا وصفة» (بيانات معطوبة) و«مكوّن نافد» (حالة تشغيلية عادية).
 */
export type BundleCapacityStatus =
  /** الوصفة سليمة ومكوّناتها تكفي لبكجٍ واحد على الأقل. */
  | "OK"
  /** منتجٌ موسومٌ بكجاً بلا مكوّنات — بيانات معطوبة تمنع البيع (حارس createSale نفسه). */
  | "NO_RECIPE"
  /** مكوّنٌ معطَّل (منتجه أو متغيّره) — البيع مرفوض حتى لو توفّر رصيده. */
  | "COMPONENT_INACTIVE"
  /** مكوّنٌ محذوف/بكجٌ متداخل — لا يمكن اشتقاق الطاقة أصلاً. */
  | "COMPONENT_UNRESOLVED"
  /** الوصفة سليمة لكن أضعف مكوّن لا يكفي لبكجٍ واحد. */
  | "COMPONENT_OUT_OF_STOCK";

export interface BundleCapacity {
  status: BundleCapacityStatus;
  /** المكوّن الذي يحدّ الطاقة (الأشحّ) — مصدرُ الرقم المعروض، و«ماذا أشتري» عملياً. */
  limiting: {
    variantId: number;
    productName: string;
    sku: string | null;
    /** كم وحدة أساس من المكوّن يحتاجها بكجٌ واحد. */
    requiredPerBundle: number;
    componentOnHandBase: number;
    componentAvailableBase: number;
  } | null;
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

// PENDING يحجز حتى لقطته الزمنية فقط. NULL إرثي fail-safe يبقى حاجزاً حتى تُرحّله الهجرة.
const activeOnlineAllocationCondition = sql`
  (
    ${onlineOrders.status} IN ('CONFIRMED', 'PROCESSING')
    OR (
      ${onlineOrders.status} = 'PENDING'
      AND (
        \`onlineOrders\`.\`reservationExpiresAt\` IS NULL
        OR \`onlineOrders\`.\`reservationExpiresAt\` > CURRENT_TIMESTAMP(3)
      )
    )
  )
`;

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
        activeOnlineAllocationCondition,
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
        activeOnlineAllocationCondition,
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
    activeOnlineAllocationCondition,
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
      bundleCapacity: null,
    });
    if (isBundle) bundleIds.push(variantId);
  }

  if (!bundleIds.length) return result;
  const componentRows = await db
    .select({
      bundleVariantId: bundleComponents.bundleVariantId,
      componentVariantId: bundleComponents.componentVariantId,
      componentBaseQuantity: bundleComponents.componentBaseQuantity,
      sortOrder: bundleComponents.sortOrder,
    })
    .from(bundleComponents)
    .where(inArray(bundleComponents.bundleVariantId, bundleIds))
    .orderBy(asc(bundleComponents.bundleVariantId), asc(bundleComponents.sortOrder), asc(bundleComponents.componentVariantId));
  const componentIds = Array.from(new Set(componentRows.map((row) => Number(row.componentVariantId))));
  const nextAncestry = new Set(ancestry);
  for (const bundleId of bundleIds) nextAncestry.add(bundleId);
  const componentAvailability = componentIds.length
    ? await loadVariantAvailability(db, branchId, componentIds, options, nextAncestry)
    : new Map<number, VariantAvailability>();
  // بطاقة تعريف المكوّن: تُقرأ مرّةً واحدةً لكل الصفحة (لا N+1) كي يقول التفسير **أيّ صنفٍ**
  // يحدّ البكج — الرقم وحده لا يخبر الموظّف بماذا يشتري ليُطلق البكج.
  const componentMeta = new Map<number, { productName: string; sku: string | null; isActive: boolean }>();
  if (componentIds.length) {
    const metaRows = await db
      .select({
        variantId: productVariants.id,
        sku: productVariants.sku,
        variantActive: productVariants.isActive,
        productName: products.name,
        productActive: products.isActive,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productVariants.id, componentIds));
    for (const row of metaRows) {
      componentMeta.set(Number(row.variantId), {
        productName: row.productName,
        sku: row.sku ?? null,
        isActive: row.variantActive !== false && row.productActive !== false,
      });
    }
  }

  const blockedBundle = (status: BundleCapacityStatus, limiting: BundleCapacity["limiting"]): VariantAvailability => ({
    onHandBase: 0,
    formalReservationBase: 0,
    reservedBase: 0,
    availableBase: 0,
    hasStockRow: false,
    isBundle: true,
    isService: false,
    bundleCapacity: { status, limiting },
  });

  for (const bundleId of bundleIds) {
    const components = componentRows.filter((row) => Number(row.bundleVariantId) === bundleId);
    if (!components.length) {
      // منتجٌ موسومٌ بكجاً بلا وصفة: `createSale` يرفض بيعه صراحةً، فلا يجوز أن تعرضه
      // الشاشة كـ«نافد» — السبب بيانات لا مخزون، وعلاجه إضافة المكوّنات لا الشراء.
      result.set(bundleId, blockedBundle("NO_RECIPE", null));
      continue;
    }

    const describe = (component: (typeof components)[number], availability: VariantAvailability | undefined) => {
      const variantId = Number(component.componentVariantId);
      const meta = componentMeta.get(variantId);
      return {
        variantId,
        productName: meta?.productName ?? `المكوّن #${variantId}`,
        sku: meta?.sku ?? null,
        requiredPerBundle: Number(component.componentBaseQuantity),
        componentOnHandBase: availability?.onHandBase ?? 0,
        componentAvailableBase: availability?.availableBase ?? 0,
      };
    };

    // أسبقية التفسير: المعطَّل يمنع البيع مهما كان رصيده (حارس createSale)، ثم المتعذّر حلّه،
    // ثم شحّ الرصيد. الترتيب يضمن أن يرى الموظّف السبب **القابل للعلاج أوّلاً**.
    const inactive = components.find((component) => {
      const meta = componentMeta.get(Number(component.componentVariantId));
      return meta != null && !meta.isActive;
    });
    if (inactive) {
      result.set(
        bundleId,
        blockedBundle("COMPONENT_INACTIVE", describe(inactive, componentAvailability.get(Number(inactive.componentVariantId)))),
      );
      continue;
    }

    let onHandCapacity = Number.POSITIVE_INFINITY;
    let availableCapacity = Number.POSITIVE_INFINITY;
    let limitingComponent: (typeof components)[number] | null = null;
    let unresolved: (typeof components)[number] | null = null;
    for (const component of components) {
      const quantity = Number(component.componentBaseQuantity);
      const availability = componentAvailability.get(Number(component.componentVariantId));
      if (!availability || !Number.isFinite(quantity) || quantity <= 0 || availability.isBundle) {
        unresolved = component;
        break;
      }
      if (availability.isService) continue;
      onHandCapacity = Math.min(onHandCapacity, Math.floor(availability.onHandBase / quantity));
      const componentCapacity = Math.floor(availability.availableBase / quantity);
      if (componentCapacity < availableCapacity) {
        availableCapacity = componentCapacity;
        limitingComponent = component;
      }
    }

    if (unresolved) {
      result.set(
        bundleId,
        blockedBundle("COMPONENT_UNRESOLVED", describe(unresolved, componentAvailability.get(Number(unresolved.componentVariantId)))),
      );
      continue;
    }
    if (onHandCapacity === Number.POSITIVE_INFINITY || availableCapacity === Number.POSITIVE_INFINITY) {
      // وصفةٌ بلا مكوّنٍ مخزَّن واحد (خدمات فقط) — لا طاقة قابلة للاشتقاق.
      result.set(bundleId, blockedBundle("COMPONENT_UNRESOLVED", null));
      continue;
    }

    const availableBase = Math.max(0, availableCapacity);
    const limiting = limitingComponent
      ? describe(limitingComponent, componentAvailability.get(Number(limitingComponent.componentVariantId)))
      : null;
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
      bundleCapacity: { status: availableBase > 0 ? "OK" : "COMPONENT_OUT_OF_STOCK", limiting },
    });
  }

  return result;
}
