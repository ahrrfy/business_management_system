// أهلية الصنف للجرد الافتتاحي: أي متغيّر ارتبط بقائمة مشتريات غير ملغاة في الفرع
// لم يعد رصيداً بلا مصدر شرائي، ولذلك لا يجوز تأسيسه مرّة أخرى عبر OPENING.
import { and, asc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import {
  branchStock,
  inventoryMovements,
  products,
  productVariants,
  purchaseOrderItems,
  purchaseOrders,
  stocktakeAssignments,
  stocktakeCountOperations,
  stocktakeCounts,
  stocktakeDecisions,
  stocktakeItemReviewEvents,
  stocktakeItems,
  stocktakeSessions,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { toDbMoney } from "../money";
import { chunk, type DbLike } from "./internal";

/**
 * يعيد المتغيّرات المرتبطة بأي قائمة مشتريات غير ملغاة في الفرع المحدد.
 * يشمل الارتباط كل حالات القائمة (DRAFT/SENT/CONFIRMED/RECEIVED) عدا CANCELLED؛
 * فمجرد إدراج الصنف في مسار المشتريات يمنع إدخاله في رصيد افتتاحي مستقل.
 */
export async function loadOpeningPurchaseLinkedVariantIds(
  db: DbLike,
  branchId: number,
  variantIds: number[],
): Promise<Set<number>> {
  const ids = Array.from(
    new Set(
      variantIds.map(Number).filter((id) => Number.isInteger(id) && id > 0),
    ),
  );
  const linked = new Set<number>();
  if (!ids.length) return linked;

  for (const part of chunk(ids)) {
    const rows = await db
      .select({ variantId: purchaseOrderItems.variantId })
      .from(purchaseOrderItems)
      .innerJoin(
        purchaseOrders,
        eq(purchaseOrderItems.purchaseOrderId, purchaseOrders.id),
      )
      .where(
        and(
          eq(purchaseOrders.branchId, branchId),
          ne(purchaseOrders.status, "CANCELLED"),
          inArray(purchaseOrderItems.variantId, part),
        ),
      );
    for (const row of rows) linked.add(Number(row.variantId));
  }

  return linked;
}

/**
 * يزيل أصناف أمر شراء جديد من جلسات الجرد الافتتاحي النشطة في الفرع نفسه.
 *
 * هذا هو دفاع السباق المكمل لفلاتر الإنشاء: قد تُنشأ قائمة المشتريات بعد أن التقطت جلسة FULL
 * نطاقها، وحينها لا يكفي منع الإلحاق اللاحق لأن stocktakeItems موجود فعلاً. الحذف يقع داخل معاملة
 * إنشاء أمر الشراء، ويقفل الجلسة والعناصر قبل تنظيف كل الآثار التابعة بالترتيب نفسه لهجرة التنظيف.
 */
export async function removeVariantsFromActiveOpeningStocktakes(
  tx: Tx,
  branchId: number,
  variantIds: number[],
): Promise<number> {
  const ids = Array.from(
    new Set(
      variantIds.map(Number).filter((id) => Number.isInteger(id) && id > 0),
    ),
  );
  if (!ids.length) return 0;

  const activeSessions = await tx
    .select({ id: stocktakeSessions.id, status: stocktakeSessions.status })
    .from(stocktakeSessions)
    .where(
      and(
        eq(stocktakeSessions.branchId, branchId),
        eq(stocktakeSessions.sessionType, "OPENING"),
        inArray(stocktakeSessions.status, ["COUNTING", "REVIEW"]),
      ),
    )
    .for("update");
  const sessionIds = activeSessions.map((row) => Number(row.id));
  if (!sessionIds.length) return 0;
  const reviewSessionIds = new Set(
    activeSessions
      .filter((row) => row.status === "REVIEW")
      .map((row) => Number(row.id)),
  );

  let removed = 0;
  for (const part of chunk(ids)) {
    const lockedItems = await tx
      .select({
        id: stocktakeItems.id,
        sessionId: stocktakeItems.sessionId,
        variantId: stocktakeItems.variantId,
      })
      .from(stocktakeItems)
      .where(
        and(
          inArray(stocktakeItems.sessionId, sessionIds),
          inArray(stocktakeItems.variantId, part),
        ),
      )
      .for("update");
    if (!lockedItems.length) continue;

    const presentIds = Array.from(
      new Set(lockedItems.map((item) => Number(item.variantId))),
    );
    const affectedReviewSessionIds = Array.from(
      new Set(
        lockedItems
          .map((item) => Number(item.sessionId))
          .filter((sessionId) => reviewSessionIds.has(sessionId)),
      ),
    );

    // توقيع OPENING الأول يثبت نطاق المراجعة كما كان لحظة التوقيع. حذف عنصر منه يغيّر
    // المستند الموقّع، لذلك يجب طلب توقيع أول جديد قبل الاعتماد النهائي.
    if (affectedReviewSessionIds.length) {
      await tx
        .update(stocktakeSessions)
        .set({ firstSignBy: null, firstSignAt: null })
        .where(inArray(stocktakeSessions.id, affectedReviewSessionIds));
    }

    await tx
      .delete(stocktakeItemReviewEvents)
      .where(
        and(
          inArray(stocktakeItemReviewEvents.sessionId, sessionIds),
          inArray(stocktakeItemReviewEvents.variantId, presentIds),
        ),
      );
    await tx
      .delete(stocktakeDecisions)
      .where(
        and(
          inArray(stocktakeDecisions.sessionId, sessionIds),
          inArray(stocktakeDecisions.variantId, presentIds),
        ),
      );
    await tx
      .delete(stocktakeCounts)
      .where(
        and(
          inArray(stocktakeCounts.sessionId, sessionIds),
          inArray(stocktakeCounts.variantId, presentIds),
        ),
      );
    // حذف العنصر يحرر reviewApprovedOperationId بـ SET NULL، ثم نحذف سجل idempotency التابع.
    await tx
      .delete(stocktakeItems)
      .where(
        and(
          inArray(stocktakeItems.sessionId, sessionIds),
          inArray(stocktakeItems.variantId, presentIds),
        ),
      );
    await tx
      .delete(stocktakeCountOperations)
      .where(
        and(
          inArray(stocktakeCountOperations.sessionId, sessionIds),
          inArray(stocktakeCountOperations.variantId, presentIds),
        ),
      );
    removed += lockedItems.length;
  }

  return removed;
}

type OpeningScopeDetail = {
  variantIds?: unknown;
  categoryIds?: unknown;
  days?: unknown;
};

type RestorableVariant = {
  variantId: number;
  categoryId: number | null;
  expectedQty: number;
  unitCost: string;
};

function parseOpeningScopeDetail(raw: string | null): OpeningScopeDetail | null {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as OpeningScopeDetail)
      : null;
  } catch {
    // Fail closed: a malformed historical scope must never gain products outside
    // the scope that was explicitly approved when the session was created.
    return null;
  }
}

function positiveIdSet(value: unknown): Set<number> {
  if (!Array.isArray(value)) return new Set<number>();
  return new Set(
    value
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0),
  );
}

async function loadRestorableVariants(
  tx: Tx,
  branchId: number,
  variantIds: number[],
): Promise<RestorableVariant[]> {
  const rows: RestorableVariant[] = [];
  for (const part of chunk(variantIds)) {
    const candidates = await tx
      .select({
        variantId: productVariants.id,
        categoryId: products.categoryId,
        stockQty: branchStock.quantity,
        unitCost: productVariants.costPrice,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .leftJoin(
        branchStock,
        and(
          eq(branchStock.variantId, productVariants.id),
          eq(branchStock.branchId, branchId),
        ),
      )
      .where(
        and(
          inArray(productVariants.id, part),
          eq(productVariants.isActive, true),
          eq(products.isActive, true),
          eq(products.isService, false),
          eq(products.isBundle, false),
          eq(products.isConsignment, false),
          isNull(branchStock.openedAt),
        ),
      );
    rows.push(
      ...candidates.map((row) => ({
        variantId: Number(row.variantId),
        categoryId: row.categoryId == null ? null : Number(row.categoryId),
        expectedQty: row.stockQty ?? 0,
        unitCost: toDbMoney(String(row.unitCost ?? "0")),
      })),
    );
  }
  return rows;
}

async function filterVariantsForStoredScope(
  tx: Tx,
  branchId: number,
  scopeType: "FULL" | "MOVING" | "CATEGORY" | "MANUAL",
  scopeDetailRaw: string | null,
  candidates: RestorableVariant[],
): Promise<RestorableVariant[]> {
  if (scopeType === "FULL") return candidates;

  const detail = parseOpeningScopeDetail(scopeDetailRaw);
  if (!detail) return [];

  if (scopeType === "MANUAL") {
    const wanted = positiveIdSet(detail.variantIds);
    return candidates.filter((row) => wanted.has(row.variantId));
  }

  if (scopeType === "CATEGORY") {
    const categories = positiveIdSet(detail.categoryIds);
    return candidates.filter(
      (row) => row.categoryId != null && categories.has(row.categoryId),
    );
  }

  // MOVING mirrors scope creation: membership is evaluated from movements in
  // this branch during the stored rolling window, as of the cancellation.
  const parsedDays = detail.days == null ? 30 : Number(detail.days);
  if (!Number.isFinite(parsedDays) || parsedDays <= 0) return [];
  const since = new Date(Date.now() - parsedDays * 86_400_000);
  const moved = new Set<number>();
  for (const part of chunk(candidates.map((row) => row.variantId))) {
    const rows = await tx
      .selectDistinct({ variantId: inventoryMovements.variantId })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.branchId, branchId),
          gte(inventoryMovements.createdAt, since),
          inArray(inventoryMovements.variantId, part),
        ),
      );
    for (const row of rows) moved.add(Number(row.variantId));
  }
  return candidates.filter((row) => moved.has(row.variantId));
}

/**
 * Re-adds variants made eligible by cancelling a purchase order to active
 * opening stocktakes in the same branch. The caller must already hold the
 * branch lock and must update the purchase order to CANCELLED first, so the
 * "other non-cancelled purchase" check observes the final policy state.
 */
export async function restoreVariantsToActiveOpeningStocktakes(
  tx: Tx,
  branchId: number,
  variantIds: number[],
): Promise<number> {
  const ids = Array.from(
    new Set(
      variantIds.map(Number).filter((id) => Number.isInteger(id) && id > 0),
    ),
  );
  if (!ids.length) return 0;

  const stillPurchased = await loadOpeningPurchaseLinkedVariantIds(
    tx,
    branchId,
    ids,
  );
  const noPurchaseSource = ids.filter((id) => !stillPurchased.has(id));
  if (!noPurchaseSource.length) return 0;

  const candidates = await loadRestorableVariants(
    tx,
    branchId,
    noPurchaseSource,
  );
  if (!candidates.length) return 0;

  const sessions = await tx
    .select({
      id: stocktakeSessions.id,
      status: stocktakeSessions.status,
      scopeType: stocktakeSessions.scopeType,
      scopeDetail: stocktakeSessions.scopeDetail,
    })
    .from(stocktakeSessions)
    .where(
      and(
        eq(stocktakeSessions.branchId, branchId),
        eq(stocktakeSessions.sessionType, "OPENING"),
        inArray(stocktakeSessions.status, ["COUNTING", "REVIEW"]),
      ),
    )
    .orderBy(asc(stocktakeSessions.id))
    .for("update");

  let restored = 0;
  for (const session of sessions) {
    const sessionId = Number(session.id);
    const scopedCandidates = await filterVariantsForStoredScope(
      tx,
      branchId,
      session.scopeType,
      session.scopeDetail,
      candidates,
    );
    if (!scopedCandidates.length) continue;

    const existingIds = new Set<number>();
    for (const part of chunk(scopedCandidates.map((row) => row.variantId))) {
      const rows = await tx
        .select({ variantId: stocktakeItems.variantId })
        .from(stocktakeItems)
        .where(
          and(
            eq(stocktakeItems.sessionId, sessionId),
            inArray(stocktakeItems.variantId, part),
          ),
        )
        .for("update");
      for (const row of rows) existingIds.add(Number(row.variantId));
    }
    const missing = scopedCandidates.filter(
      (row) => !existingIds.has(row.variantId),
    );
    if (!missing.length) continue;

    // assignmentId is technical compatibility storage; the list is shared by
    // every worker. Reuse the first non-removed assignment, matching creation.
    const assignment = (
      await tx
        .select({ id: stocktakeAssignments.id })
        .from(stocktakeAssignments)
        .where(
          and(
            eq(stocktakeAssignments.sessionId, sessionId),
            ne(stocktakeAssignments.status, "REMOVED"),
          ),
        )
        .orderBy(asc(stocktakeAssignments.id))
        .for("update")
        .limit(1)
    )[0];
    if (!assignment) continue;

    const itemRows = missing.map((row) => ({
      sessionId,
      assignmentId: Number(assignment.id),
      variantId: row.variantId,
      branchId,
      expectedQty: row.expectedQty,
      unitCost: row.unitCost,
    }));
    for (const part of chunk(itemRows)) {
      await tx.insert(stocktakeItems).values(part);
    }
    restored += itemRows.length;

    if (session.status === "REVIEW") {
      await tx
        .update(stocktakeSessions)
        .set({
          status: "COUNTING",
          submittedAt: null,
          firstSignBy: null,
          firstSignAt: null,
        })
        .where(eq(stocktakeSessions.id, sessionId));
      await tx
        .update(stocktakeAssignments)
        .set({ status: "ACTIVE", submittedAt: null })
        .where(
          and(
            eq(stocktakeAssignments.sessionId, sessionId),
            eq(stocktakeAssignments.status, "SUBMITTED"),
          ),
        );
    }
  }

  return restored;
}
