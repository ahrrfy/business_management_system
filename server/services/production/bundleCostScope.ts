import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import Decimal from "decimal.js";
import { asc, eq, inArray } from "drizzle-orm";
import { bundleComponents, productVariants } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import {
  bundleDefinitionsFingerprint,
  getBundleDefinitions,
  type BundleComponentRow,
} from "../bundleService";
import {
  lockEconomicInventoryScope,
  type EconomicInventoryScope,
} from "../inventory/economicOwnership";
import { money, toDbMoney } from "../money";

interface ProductionCostScope {
  scope: EconomicInventoryScope;
  changedIds: Set<number>;
  definitions: Map<number, BundleComponentRow[]>;
}
const scopes = new WeakMap<Tx, ProductionCostScope>();
function changed(): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "تغيّر نطاق تكلفة بكجات الإنتاج",
      why: "تغيّرت مكوّنات البكج أو نطاق الأصناف أثناء تثبيت الأقفال",
      doThis: "حدّث العملية وأعد المحاولة لتثبيت التعريف الحالي كاملاً",
    }),
  });
}

/** Discover before locks; never extend an existing production/economic capability. */
export async function lockProductionInventoryScope(
  tx: Tx,
  physicalIds: number[],
  changedIds: number[],
): Promise<EconomicInventoryScope> {
  const existing = scopes.get(tx);
  if (existing) {
    if (changedIds.some((id) => !existing.changedIds.has(id))) changed();
    return lockEconomicInventoryScope(tx, physicalIds);
  }
  const ids = Array.from(new Set(changedIds)).sort((a, b) => a - b);
  const references = () =>
    tx
      .select({ bundleVariantId: bundleComponents.bundleVariantId })
      .from(bundleComponents)
      .where(inArray(bundleComponents.componentVariantId, ids))
      .orderBy(asc(bundleComponents.bundleVariantId));
  const bundleIdsOf = (rows: { bundleVariantId: number }[]) =>
    Array.from(new Set(rows.map((r) => r.bundleVariantId))).sort(
      (a, b) => a - b,
    );
  const bundleIds = ids.length ? bundleIdsOf(await references()) : [];
  const discovered = await getBundleDefinitions(tx, bundleIds);
  const closure = Array.from(
    new Set([
      ...physicalIds,
      ...ids,
      ...bundleIds,
      ...Array.from(discovered.values()).flatMap((rows) =>
        rows.map((row) => row.componentVariantId),
      ),
    ]),
  );
  const scope = await lockEconomicInventoryScope(tx, closure);
  // Native definition writers lock products of the header and ALL old/new components
  // before changing references (replaceBundleComponents/lockBundleVariantScope).
  // Our product-S locks fence those writers. Current reads detect commits that won
  // before the fence, even if discovery used an old RR snapshot. Never add late IDs.
  const currentIds = ids.length
    ? bundleIdsOf(await references().for("share"))
    : [];
  if (JSON.stringify(currentIds) !== JSON.stringify(bundleIds)) changed();
  const current = await getBundleDefinitions(tx, bundleIds, { lock: true });
  if (
    bundleDefinitionsFingerprint(discovered) !==
    bundleDefinitionsFingerprint(current)
  )
    changed();
  scopes.set(tx, { scope, changedIds: new Set(ids), definitions: current });
  return scope;
}

/** Refresh costs in one CURRENT bulk read; every read/update PK was declared up front. */
export async function syncProductionBundleCosts(
  tx: Tx,
  changedIds: number[],
): Promise<Map<number, string>> {
  const state = scopes.get(tx);
  if (!state || changedIds.some((id) => !state.changedIds.has(id))) changed();
  // Revalidate gate/transaction capability, including callers after an awaited nested operation.
  await lockEconomicInventoryScope(tx, [...state.scope.variantIds]);
  const definitions = state.definitions;
  const componentIds = Array.from(
    new Set(
      Array.from(definitions.values()).flatMap((rows) =>
        rows.map((row) => row.componentVariantId),
      ),
    ),
  ).sort((a, b) => a - b);
  const rows = componentIds.length
    ? await tx
        .select({
          id: productVariants.id,
          costPrice: productVariants.costPrice,
        })
        .from(productVariants)
        .where(inArray(productVariants.id, componentIds))
        .orderBy(asc(productVariants.id))
        .for("share")
    : [];
  const costs = new Map(rows.map((row) => [row.id, row.costPrice]));
  if (costs.size !== componentIds.length) changed();
  const result = new Map<number, string>();
  for (const [id, components] of Array.from(definitions.entries()).sort(
    ([a], [b]) => a - b,
  )) {
    const cost = toDbMoney(
      components.reduce(
        (sum, row) =>
          sum.plus(
            money(costs.get(row.componentVariantId)!).times(
              row.componentBaseQuantity,
            ),
          ),
        new Decimal(0),
      ),
    );
    await tx
      .update(productVariants)
      .set({ costPrice: cost })
      .where(eq(productVariants.id, id));
    result.set(id, cost);
  }
  return result;
}
