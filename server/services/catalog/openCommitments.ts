import { and, eq, inArray, sql } from "drizzle-orm";
import {
  bundleComponents,
  onlineOrderItems,
  onlineOrders,
  productUnits,
  productVariants,
  products,
  productionRecipeLines,
  productionRecipes,
  purchaseRequisitionItems,
  purchaseRequisitions,
  quotationItems,
  quotations,
  receptionDraftLines,
  receptionDrafts,
  reservationLines,
  reservations,
  workOrderMaterials,
  workOrders,
} from "../../../drizzle/schema";
import { requireDb } from "../tx";

export interface OpenCommitmentCategory {
  key: string;
  label: string;
  count: number;
  affectedWhenNotSellable: boolean;
  affectedWhenNotMaterial: boolean;
}

export interface ProductOpenCommitmentsSummary {
  productId: number;
  total: number;
  categories: OpenCommitmentCategory[];
}

export async function getProductOpenCommitments(
  productId: number,
): Promise<ProductOpenCommitmentsSummary> {
  const db = requireDb();
  const variantRows = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(eq(productVariants.productId, productId));
  const variantIds = variantRows.map((r) => Number(r.id));
  if (!variantIds.length) {
    return { productId, total: 0, categories: [] };
  }
  const unitRows = await db
    .select({ id: productUnits.id })
    .from(productUnits)
    .where(inArray(productUnits.variantId, variantIds));
  const unitIds = unitRows.map((r) => Number(r.id));

  const [
    quoteRow,
    resRow,
    onlineRow,
    draftRow,
    bundleRow,
    recipeInputRow,
    woRow,
    reqRow,
  ] = await Promise.all([
    db
      .select({ n: sql<number>`count(distinct ${quotations.id})` })
      .from(quotationItems)
      .innerJoin(quotations, eq(quotationItems.quotationId, quotations.id))
      .where(
        and(
          inArray(quotationItems.variantId, variantIds),
          inArray(quotations.status, ["DRAFT", "SENT", "ACCEPTED"]),
        ),
      ),
    db
      .select({ n: sql<number>`count(distinct ${reservations.id})` })
      .from(reservationLines)
      .innerJoin(reservations, eq(reservationLines.reservationId, reservations.id))
      .where(
        and(
          inArray(reservationLines.variantId, variantIds),
          eq(reservations.status, "ACTIVE"),
        ),
      ),
    db
      .select({ n: sql<number>`count(distinct ${onlineOrders.id})` })
      .from(onlineOrderItems)
      .innerJoin(onlineOrders, eq(onlineOrderItems.onlineOrderId, onlineOrders.id))
      .where(
        and(
          inArray(onlineOrderItems.variantId, variantIds),
          inArray(onlineOrders.status, ["PENDING", "CONFIRMED", "PROCESSING"]),
        ),
      ),
    db
      .select({ n: sql<number>`count(distinct ${receptionDrafts.id})` })
      .from(receptionDraftLines)
      .innerJoin(receptionDrafts, eq(receptionDraftLines.draftId, receptionDrafts.id))
      .where(
        and(
          unitIds.length
            ? sql`(${inArray(receptionDraftLines.variantId, variantIds)} OR ${inArray(receptionDraftLines.productUnitId, unitIds)})`
            : inArray(receptionDraftLines.variantId, variantIds),
          eq(receptionDrafts.status, "OPEN"),
        ),
      ),
    db
      .select({ n: sql<number>`count(distinct ${bundleComponents.bundleVariantId})` })
      .from(bundleComponents)
      .innerJoin(productVariants, eq(bundleComponents.bundleVariantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(
        and(
          inArray(bundleComponents.componentVariantId, variantIds),
          eq(productVariants.isActive, true),
          eq(products.isActive, true),
        ),
      ),
    db
      .select({ n: sql<number>`count(distinct ${productionRecipes.id})` })
      .from(productionRecipeLines)
      .innerJoin(productionRecipes, eq(productionRecipeLines.recipeId, productionRecipes.id))
      .where(
        and(
          inArray(productionRecipeLines.inputVariantId, variantIds),
          eq(productionRecipes.isActive, true),
        ),
      ),
    db
      .select({ n: sql<number>`count(distinct ${workOrders.id})` })
      .from(workOrderMaterials)
      .innerJoin(workOrders, eq(workOrderMaterials.workOrderId, workOrders.id))
      .where(
        and(
          inArray(workOrderMaterials.variantId, variantIds),
          inArray(workOrders.status, ["RECEIVED", "IN_PROGRESS", "READY"]),
        ),
      ),
    db
      .select({ n: sql<number>`count(distinct ${purchaseRequisitions.id})` })
      .from(purchaseRequisitionItems)
      .innerJoin(
        purchaseRequisitions,
        eq(purchaseRequisitionItems.requisitionId, purchaseRequisitions.id),
      )
      .where(
        and(
          inArray(purchaseRequisitionItems.variantId, variantIds),
          inArray(purchaseRequisitions.status, [
            "DRAFT",
            "SUBMITTED",
            "APPROVED",
            "PARTIALLY_ORDERED",
          ]),
        ),
      ),
  ]);

  const categories: OpenCommitmentCategory[] = [
    {
      key: "openQuotations",
      label: "عروض أسعار مفتوحة (مسودة/مرسلة/مقبولة)",
      count: Number(quoteRow[0]?.n ?? 0),
      affectedWhenNotSellable: true,
      affectedWhenNotMaterial: false,
    },
    {
      key: "activeReservations",
      label: "حجوزات عملاء نشطة",
      count: Number(resRow[0]?.n ?? 0),
      affectedWhenNotSellable: true,
      affectedWhenNotMaterial: false,
    },
    {
      key: "activeOnlineOrders",
      label: "طلبات متجر إلكتروني قيد التنفيذ",
      count: Number(onlineRow[0]?.n ?? 0),
      affectedWhenNotSellable: true,
      affectedWhenNotMaterial: false,
    },
    {
      key: "openReceptionDrafts",
      label: "مسوّدات استقبال مفتوحة",
      count: Number(draftRow[0]?.n ?? 0),
      affectedWhenNotSellable: true,
      affectedWhenNotMaterial: true,
    },
    {
      key: "activeBundles",
      label: "بكجات نشطة تعتمد عليه كمكوّن",
      count: Number(bundleRow[0]?.n ?? 0),
      affectedWhenNotSellable: true,
      affectedWhenNotMaterial: false,
    },
    {
      key: "activeRecipesInput",
      label: "وصفات إنتاج/خدمة نشطة تعتمد عليه كمادة",
      count: Number(recipeInputRow[0]?.n ?? 0),
      affectedWhenNotSellable: false,
      affectedWhenNotMaterial: true,
    },
    {
      key: "openWorkOrders",
      label: "أوامر شغل مفتوحة تستهلكه كمادة",
      count: Number(woRow[0]?.n ?? 0),
      affectedWhenNotSellable: false,
      affectedWhenNotMaterial: true,
    },
    {
      key: "openRequisitions",
      label: "طلبات شراء مفتوحة",
      count: Number(reqRow[0]?.n ?? 0),
      affectedWhenNotSellable: false,
      affectedWhenNotMaterial: false,
    },
  ].filter((c) => c.count > 0);

  const total = categories.reduce((sum, c) => sum + c.count, 0);
  return { productId, total, categories };
}
