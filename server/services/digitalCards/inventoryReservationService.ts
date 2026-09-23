import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import Decimal from "decimal.js";

import {
  digitalIntentInventoryReservations,
  productUnits,
  productVariants,
  products,
  reservationStock,
} from "../../../drizzle/schema";
import type {
  DigitalCheckoutInventoryReservationSnapshot,
  DigitalCheckoutSnapshot,
} from "../../../shared/digitalSale";
import { appErrorMessage } from "../../../shared/errors";
import type { Tx } from "../../db";
import { getBundleDefinitions } from "../bundleService";
import { loadVariantAvailability } from "../catalog/variantAvailability";
import {
  discoverServiceRecipeDefinitions,
  exactRecipeMaterialQuantity,
} from "../serviceRecipeConsumption";

type TerminalStatus = "CONSUMED" | "RELEASED";

interface LockedCatalogVariant {
  id: number;
  productId: number;
  variantActive: boolean | null;
  productActive: boolean | null;
  isService: boolean | null;
  isBundle: boolean | null;
  isConsignment: boolean | null;
  allowBackorder: boolean | null;
  productType: string | null;
}

function reservationError(why: string): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "تعذّر تثبيت مخزون السلة الرقمية",
      why,
      doThis:
        "أوقف الإصدار وحدّث السلة ثم أعد المحاولة؛ إذا صدر كرت بالفعل فانتقل إلى مراجعة العملية ولا تكرر الإصدار",
    }),
  });
}

function normalizeSnapshotRows(
  snapshot: DigitalCheckoutSnapshot,
): DigitalCheckoutInventoryReservationSnapshot[] {
  const rows = snapshot.inventoryReservations ?? [];
  if (snapshot.regularLines.length > 0 && rows.length === 0) {
    reservationError("لقطة السلة العادية لا تحمل عقد حجز المخزون والكتالوج");
  }
  const seen = new Set<string>();
  const normalized = rows.map((row) => {
    const sourceVariantId = Number(row.sourceVariantId);
    const stockVariantId = Number(row.stockVariantId);
    const demandedBase = Number(row.demandedBase);
    const reservedBase = Number(row.reservedBase);
    if (
      !Number.isSafeInteger(sourceVariantId) ||
      sourceVariantId <= 0 ||
      !Number.isSafeInteger(stockVariantId) ||
      stockVariantId <= 0 ||
      !Number.isSafeInteger(demandedBase) ||
      demandedBase < 0 ||
      !Number.isSafeInteger(reservedBase) ||
      reservedBase < 0 ||
      reservedBase > demandedBase ||
      (reservedBase !== 0 && reservedBase !== demandedBase)
    ) {
      reservationError("لقطة حجز المخزون تحتوي معرّفاً أو كمية غير صالحة");
    }
    const key = `${sourceVariantId}:${stockVariantId}`;
    if (seen.has(key)) reservationError("لقطة حجز المخزون تحتوي سطراً مكرراً");
    seen.add(key);
    return { sourceVariantId, stockVariantId, demandedBase, reservedBase };
  });
  return normalized.sort(
    (a, b) =>
      a.sourceVariantId - b.sourceVariantId ||
      a.stockVariantId - b.stockVariantId,
  );
}

async function lockCatalogScope(
  tx: Tx,
  variantIds: readonly number[],
): Promise<Map<number, LockedCatalogVariant>> {
  const ids = Array.from(new Set(variantIds.map(Number))).sort((a, b) => a - b);
  if (!ids.length) return new Map();
  const refs = await tx
    .select({ id: productVariants.id, productId: productVariants.productId })
    .from(productVariants)
    .where(inArray(productVariants.id, ids))
    .orderBy(asc(productVariants.id));
  const refByVariant = new Map(
    refs.map((row) => [Number(row.id), Number(row.productId)]),
  );
  if (refByVariant.size !== ids.length) {
    reservationError("صنف في نطاق السلة حُذف قبل اكتمال الحجز");
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
      allowBackorder: products.allowBackorder,
      productType: products.productType,
    })
    .from(products)
    .where(inArray(products.id, productIds))
    .orderBy(asc(products.id))
    .for("update");
  const productById = new Map(
    lockedProducts.map((product) => [Number(product.id), product]),
  );
  const lockedVariants = await tx
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      isActive: productVariants.isActive,
    })
    .from(productVariants)
    .where(inArray(productVariants.id, ids))
    .orderBy(asc(productVariants.id))
    .for("update");

  const out = new Map<number, LockedCatalogVariant>();
  for (const variant of lockedVariants) {
    const id = Number(variant.id);
    const productId = Number(variant.productId);
    if (refByVariant.get(id) !== productId) {
      reservationError(`تغيّر ربط الصنف #${id} بمنتجه أثناء الحجز`);
    }
    const product = productById.get(productId);
    if (!product) reservationError(`منتج الصنف #${id} لم يعد موجوداً`);
    out.set(id, {
      id,
      productId,
      variantActive: variant.isActive,
      productActive: product.isActive,
      isService: product.isService,
      isBundle: product.isBundle,
      isConsignment: product.isConsignment,
      allowBackorder: product.allowBackorder,
      productType: product.productType,
    });
  }
  if (out.size !== ids.length) {
    reservationError("تغيّر نطاق أصناف السلة أثناء الحجز");
  }
  return out;
}

function canonicalDemand(
  rows: readonly Pick<
    DigitalCheckoutInventoryReservationSnapshot,
    "sourceVariantId" | "stockVariantId" | "demandedBase"
  >[],
): string {
  return JSON.stringify(
    [...rows]
      .map((row) => ({
        sourceVariantId: Number(row.sourceVariantId),
        stockVariantId: Number(row.stockVariantId),
        demandedBase: Number(row.demandedBase),
      }))
      .sort(
        (a, b) =>
          a.sourceVariantId - b.sourceVariantId ||
          a.stockVariantId - b.stockVariantId,
      ),
  );
}

/** يعيد اشتقاق الطلب من الوحدات/الوصفات الحالية تحت الأقفال ويقارنه باللقطة. */
async function assertCurrentBinding(
  tx: Tx,
  snapshot: DigitalCheckoutSnapshot,
  snapshotRows: DigitalCheckoutInventoryReservationSnapshot[],
): Promise<void> {
  if (!snapshot.regularLines.length) return;
  const sourceIds = Array.from(
    new Set(snapshot.regularLines.map((line) => Number(line.variantId))),
  ).sort((a, b) => a - b);
  const scopeIds = Array.from(
    new Set([
      ...sourceIds,
      ...snapshotRows.map((row) => row.stockVariantId),
    ]),
  ).sort((a, b) => a - b);
  const catalog = await lockCatalogScope(tx, scopeIds);

  const unitIds = Array.from(
    new Set(snapshot.regularLines.map((line) => Number(line.productUnitId))),
  ).sort((a, b) => a - b);
  const units = await tx
    .select({
      id: productUnits.id,
      variantId: productUnits.variantId,
      conversionFactor: productUnits.conversionFactor,
      isActive: productUnits.isActive,
    })
    .from(productUnits)
    .where(inArray(productUnits.id, unitIds))
    .orderBy(asc(productUnits.id))
    .for("update");
  const unitById = new Map(units.map((unit) => [Number(unit.id), unit]));
  if (unitById.size !== unitIds.length) {
    reservationError("وحدة بيع في السلة حُذفت قبل اكتمال الحجز");
  }

  const bundleIds: number[] = [];
  const serviceIds: number[] = [];
  for (const sourceId of sourceIds) {
    const source = catalog.get(sourceId);
    if (
      !source ||
      source.productActive !== true ||
      source.variantActive !== true ||
      source.productType === "DIGITAL_CARD"
    ) {
      reservationError(`الصنف العادي #${sourceId} لم يعد صالحاً للبيع`);
    }
    if (source.isBundle === true) bundleIds.push(sourceId);
    else if (source.isService === true) serviceIds.push(sourceId);
  }

  // الصفوف نفسها تُقفل بعد قفل نطاق المتغيّرات؛ كاتب التعريف يتبع الترتيب نفسه.
  const bundleDefinitions = await getBundleDefinitions(tx, bundleIds, {
    lock: true,
  });
  const serviceDefinitions = await discoverServiceRecipeDefinitions(
    tx,
    serviceIds,
    { lock: true },
  );
  const expected = new Map<string, DigitalCheckoutInventoryReservationSnapshot>();
  const add = (sourceVariantId: number, stockVariantId: number, qty: number) => {
    if (!Number.isSafeInteger(qty) || qty < 0) {
      reservationError(`طلب المخزون للصنف #${sourceVariantId} غير قابل للتتبع`);
    }
    const key = `${sourceVariantId}:${stockVariantId}`;
    const old = expected.get(key);
    const demandedBase = (old?.demandedBase ?? 0) + qty;
    if (!Number.isSafeInteger(demandedBase)) {
      reservationError(`إجمالي طلب المخزون للصنف #${sourceVariantId} يتجاوز الحد الآمن`);
    }
    expected.set(key, {
      sourceVariantId,
      stockVariantId,
      demandedBase,
      reservedBase: 0,
    });
  };
  for (const sourceId of sourceIds) add(sourceId, sourceId, 0);

  for (const line of snapshot.regularLines) {
    const sourceId = Number(line.variantId);
    const source = catalog.get(sourceId)!;
    const unit = unitById.get(Number(line.productUnitId));
    if (
      !unit ||
      Number(unit.variantId) !== sourceId ||
      unit.isActive !== true
    ) {
      reservationError(`وحدة بيع الصنف #${sourceId} تغيّرت أو تعطّلت`);
    }
    const base = new Decimal(line.quantity).times(unit.conversionFactor);
    if (!base.isInteger() || base.lte(0) || base.gt(Number.MAX_SAFE_INTEGER)) {
      reservationError(`كمية الصنف #${sourceId} لم تعد تنتج وحدة أساس صحيحة`);
    }
    const baseQuantity = base.toNumber();
    if (source.isBundle === true) {
      const components = bundleDefinitions.get(sourceId) ?? [];
      if (!components.length) reservationError(`البكج #${sourceId} بلا مكوّنات`);
      for (const component of components) {
        add(
          sourceId,
          component.componentVariantId,
          component.componentBaseQuantity * baseQuantity,
        );
      }
    } else if (source.isService === true) {
      for (const recipeLine of serviceDefinitions.get(sourceId)?.lines ?? []) {
        add(
          sourceId,
          recipeLine.inputVariantId,
          exactRecipeMaterialQuantity(
            recipeLine.qtyPerOutputBase,
            baseQuantity,
            `مادة الخدمة #${recipeLine.inputVariantId}`,
          ),
        );
      }
    } else {
      add(sourceId, sourceId, baseQuantity);
    }
  }

  const expectedRows = Array.from(expected.values());
  if (canonicalDemand(snapshotRows) !== canonicalDemand(expectedRows)) {
    reservationError(
      "تغيّر تعريف وحدة أو وصفة خدمة أو مكوّنات بكج منذ إعداد السلة",
    );
  }
  for (const row of expectedRows) {
    if (row.demandedBase <= 0) continue;
    const stock = catalog.get(row.stockVariantId);
    const source = catalog.get(row.sourceVariantId);
    if (
      !stock ||
      stock.productActive !== true ||
      stock.variantActive !== true ||
      (row.sourceVariantId !== row.stockVariantId &&
        (stock.isService === true ||
          stock.isBundle === true ||
          stock.isConsignment === true))
    ) {
      reservationError(`المادة المخزنية #${row.stockVariantId} لم تعد مؤهلة`);
    }
    const explicitBackorder =
      row.sourceVariantId === row.stockVariantId &&
      source?.isService !== true &&
      source?.isBundle !== true &&
      source?.allowBackorder === true;
    const snapshotted = snapshotRows.find(
      (candidate) =>
        candidate.sourceVariantId === row.sourceVariantId &&
        candidate.stockVariantId === row.stockVariantId,
    );
    if (
      snapshotted?.reservedBase !== row.demandedBase &&
      !explicitBackorder
    ) {
      reservationError(
        `طلب المخزون للصنف #${row.stockVariantId} بلا حجز كامل؛ نافذة الرصيد الافتتاحي لا تعفي البيع الرقمي المختلط`,
      );
    }
  }
}

async function ensureAggregateRow(
  tx: Tx,
  variantId: number,
  branchId: number,
): Promise<void> {
  await tx
    .insert(reservationStock)
    .values({ variantId, branchId, reservedBase: 0 })
    .onDuplicateKeyUpdate({
      set: { variantId: sql`${reservationStock.variantId}` },
    });
}

/** يحجز المخزون ويكتب أقفال الكتالوج بعد إنشاء intent وفي المعاملة نفسها. */
export async function reserveIntentInventory(
  tx: Tx,
  args: {
    intentId: number;
    branchId: number;
    snapshot: DigitalCheckoutSnapshot;
  },
): Promise<void> {
  const rows = normalizeSnapshotRows(args.snapshot);
  if (!rows.length) return;
  await assertCurrentBinding(tx, args.snapshot, rows);

  const reservedByStock = new Map<number, number>();
  for (const row of rows) {
    if (row.reservedBase <= 0) continue;
    reservedByStock.set(
      row.stockVariantId,
      (reservedByStock.get(row.stockVariantId) ?? 0) + row.reservedBase,
    );
  }
  const stockIds = Array.from(reservedByStock.keys()).sort((a, b) => a - b);
  if (stockIds.length) {
    const availability = await loadVariantAvailability(
      tx,
      args.branchId,
      stockIds,
      { lock: true },
    );
    for (const variantId of stockIds) {
      const quantity = reservedByStock.get(variantId)!;
      const state = availability.get(variantId);
      if (!state?.hasStockRow || state.availableBase < quantity) {
        reservationError(
          `المخزون المتاح للصنف #${variantId} أصبح ${state?.availableBase ?? 0} والمطلوب حجز ${quantity}`,
        );
      }
      await ensureAggregateRow(tx, variantId, args.branchId);
      await tx
        .update(reservationStock)
        .set({
          reservedBase: sql`${reservationStock.reservedBase} + ${quantity}`,
        })
        .where(
          and(
            eq(reservationStock.variantId, variantId),
            eq(reservationStock.branchId, args.branchId),
          ),
        );
    }
  }
  await tx.insert(digitalIntentInventoryReservations).values(
    rows.map((row) => ({
      intentId: args.intentId,
      branchId: args.branchId,
      sourceVariantId: row.sourceVariantId,
      stockVariantId: row.stockVariantId,
      reservedBase: row.reservedBase,
    })),
  );
}

async function lockActiveRows(tx: Tx, intentId: number) {
  return tx
    .select()
    .from(digitalIntentInventoryReservations)
    .where(
      and(
        eq(digitalIntentInventoryReservations.intentId, intentId),
        eq(digitalIntentInventoryReservations.status, "ACTIVE"),
      ),
    )
    .orderBy(
      asc(digitalIntentInventoryReservations.stockVariantId),
      asc(digitalIntentInventoryReservations.sourceVariantId),
    )
    .for("update");
}

/** إعفاء الحجز الرسمي الذي يخص النية نفسها؛ لا يحرر العداد قبل نجاح الفاتورة. */
export async function intentInventoryExemptions(
  tx: Tx,
  intentId: number,
  snapshot: DigitalCheckoutSnapshot | null,
): Promise<Readonly<Record<number, number>>> {
  const rows = await lockActiveRows(tx, intentId);
  if ((snapshot?.regularLines.length ?? 0) > 0 && !rows.length) {
    reservationError("حجز مخزون النية مفقود؛ لا يمكن إنشاء فاتورة بعد الإصدار بأمان");
  }
  const out: Record<number, number> = {};
  for (const row of rows) {
    const quantity = Number(row.reservedBase);
    if (quantity <= 0) continue;
    const variantId = Number(row.stockVariantId);
    out[variantId] = (out[variantId] ?? 0) + quantity;
  }
  return out;
}

async function closeIntentInventoryRows(
  tx: Tx,
  intentId: number,
  status: TerminalStatus,
): Promise<void> {
  const rows = await lockActiveRows(tx, intentId);
  if (!rows.length) return;
  const branchIds = new Set(rows.map((row) => Number(row.branchId)));
  if (branchIds.size !== 1) reservationError("حجز النية موزع على أكثر من فرع");
  const branchId = Number(rows[0].branchId);
  const byStock = new Map<number, number>();
  for (const row of rows) {
    const quantity = Number(row.reservedBase);
    if (quantity <= 0) continue;
    const variantId = Number(row.stockVariantId);
    byStock.set(variantId, (byStock.get(variantId) ?? 0) + quantity);
  }
  for (const variantId of Array.from(byStock.keys()).sort((a, b) => a - b)) {
    const quantity = byStock.get(variantId)!;
    await ensureAggregateRow(tx, variantId, branchId);
    const [aggregate] = await tx
      .select({ reservedBase: reservationStock.reservedBase })
      .from(reservationStock)
      .where(
        and(
          eq(reservationStock.variantId, variantId),
          eq(reservationStock.branchId, branchId),
        ),
      )
      .for("update")
      .limit(1);
    if (!aggregate || Number(aggregate.reservedBase) < quantity) {
      reservationError(
        `عداد الحجز للصنف #${variantId} أقل من حجز النية؛ يلزم إصلاح اتساق المخزون`,
      );
    }
    await tx
      .update(reservationStock)
      .set({ reservedBase: sql`${reservationStock.reservedBase} - ${quantity}` })
      .where(
        and(
          eq(reservationStock.variantId, variantId),
          eq(reservationStock.branchId, branchId),
        ),
      );
  }
  await tx
    .update(digitalIntentInventoryReservations)
    .set(
      status === "CONSUMED"
        ? { status, consumedAt: new Date() }
        : { status, releasedAt: new Date() },
    )
    .where(
      and(
        eq(digitalIntentInventoryReservations.intentId, intentId),
        eq(digitalIntentInventoryReservations.status, "ACTIVE"),
      ),
    );
}

export async function consumeIntentInventory(
  tx: Tx,
  intentId: number,
): Promise<void> {
  await closeIntentInventoryRows(tx, intentId, "CONSUMED");
}

export async function releaseIntentInventory(
  tx: Tx,
  intentId: number,
): Promise<void> {
  await closeIntentInventoryRows(tx, intentId, "RELEASED");
}
