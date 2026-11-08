// مزامنة «النطاق الحي» للجرد الشامل.
//
// الجرد الشامل يلتقط لقطة عند الإنشاء لأجل تدقيق الرصيد/الكلفة، لكنه يبقى قيد العد أحياناً
// بينما ينشئ فريق آخر أصنافاً أو متغيّرات جديدة. هذه المزامنة تُلحق الجديد فقط بالجلسات
// FULL التي ما زالت COUNTING؛ لا تمس جلسة REVIEW أو APPROVED ولا تغيّر أي عنصر موجود.
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import {
  branchStock,
  products,
  productVariants,
  stocktakeAssignments,
  stocktakeItems,
  stocktakeSessions,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { logger } from "../../logger";
import { toDbMoney } from "../money";
import { requireDb, withTx } from "../tx";
import {
  loadActiveStocktakeOverlaps,
  lockStocktakeBranch,
} from "./overlapGuard";
import { chunk } from "./internal";
import { loadOpeningPurchaseLinkedVariantIds } from "./openingEligibility";

export const STOCKTAKE_SYNC_PENDING_WARNING = "STOCKTAKE_SYNC_PENDING" as const;

export interface LiveScopeSyncResult {
  sessionsChecked: number;
  itemsAdded: number;
}

/**
 * يزامن جلسة جرد شامل واحدة داخل معاملة يملك المستدعي فيها قفل الفرع (`lockStocktakeBranch`)
 * وقفل صفّ الجلسة (`stocktakeSessions FOR UPDATE`). يستخدم قراءة حديثة (`FOR SHARE`) لرؤية
 * الأصناف الملتزمة حديثاً تحت REPEATABLE READ.
 */
export async function syncSingleFullStocktakeSessionTx(
  tx: Tx,
  locked: {
    id: number;
    branchId: number;
    sessionType: string;
    status: string;
    scopeType: string;
  },
): Promise<number> {
  if (locked.status !== "COUNTING" || locked.scopeType !== "FULL") return 0;
  const sessionId = Number(locked.id);

  const activeAssignment = (
    await tx
      .select({ id: stocktakeAssignments.id })
      .from(stocktakeAssignments)
      .where(
        and(
          eq(stocktakeAssignments.sessionId, sessionId),
          eq(stocktakeAssignments.status, "ACTIVE"),
        ),
      )
      .orderBy(asc(stocktakeAssignments.id))
      .limit(1)
  )[0];
  const fallbackAssignment = activeAssignment ?? (
    await tx
      .select({ id: stocktakeAssignments.id })
      .from(stocktakeAssignments)
      .where(eq(stocktakeAssignments.sessionId, sessionId))
      .orderBy(asc(stocktakeAssignments.id))
      .limit(1)
  )[0];
  if (!fallbackAssignment) return 0;

  const isOpening = locked.sessionType === "OPENING";
  const candidates = await tx
    .select({
      variantId: productVariants.id,
      unitCost: productVariants.costPrice,
      stockQty: branchStock.quantity,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(
      branchStock,
      and(
        eq(branchStock.variantId, productVariants.id),
        eq(branchStock.branchId, locked.branchId),
      ),
    )
    .leftJoin(
      stocktakeItems,
      and(
        eq(stocktakeItems.sessionId, sessionId),
        eq(stocktakeItems.variantId, productVariants.id),
      ),
    )
    .where(
      and(
        or(
          and(
            eq(products.isActive, true),
            eq(productVariants.isActive, true),
          ),
          or(
            sql`COALESCE(${branchStock.quantity}, 0) > 0`,
            and(
              sql`COALESCE(${branchStock.quantity}, 0) < 0`,
              eq(products.allowBackorder, false),
            ),
          ),
        ),
        or(
          eq(products.allowBackorder, false),
          sql`COALESCE(${branchStock.quantity}, 0) >= 0`,
        ),
        eq(products.isService, false),
        eq(products.isBundle, false),
        isNull(stocktakeItems.id),
        ...(isOpening
          ? [
              eq(products.isConsignment, false),
              isNull(branchStock.openedAt),
            ]
          : []),
      ),
    )
    .for("share");

  if (!candidates.length) return 0;
  const purchasedSet = isOpening
    ? await loadOpeningPurchaseLinkedVariantIds(
        tx,
        Number(locked.branchId),
        candidates.map((candidate) => Number(candidate.variantId)),
      )
    : new Set<number>();
  const overlaps = await loadActiveStocktakeOverlaps(
    tx,
    Number(locked.branchId),
    candidates.map((c) => Number(c.variantId)),
    sessionId,
    true,
  );
  const eligibleCandidates = candidates.filter(
    (candidate) =>
      !purchasedSet.has(Number(candidate.variantId)) &&
      !overlaps.has(Number(candidate.variantId)),
  );
  if (!eligibleCandidates.length) return 0;

  const items = eligibleCandidates.map((candidate) => ({
    sessionId,
    assignmentId: Number(fallbackAssignment.id),
    variantId: Number(candidate.variantId),
    branchId: Number(locked.branchId),
    expectedQty: candidate.stockQty ?? 0,
    unitCost: toDbMoney(String(candidate.unitCost ?? "0")),
  }));
  for (const part of chunk(items)) {
    await tx
      .insert(stocktakeItems)
      .values(part)
      .onDuplicateKeyUpdate({
        set: { sessionId: sql`${stocktakeItems.sessionId}` },
      });
  }
  return items.length;
}

/**
 * يلحق كل متغيّر مؤهل لم يدخل بعد بجلسة FULL نشطة.
 */
export async function syncActiveFullStocktakeScopes(): Promise<LiveScopeSyncResult> {
  const sessions = await requireDb()
    .select({ id: stocktakeSessions.id, branchId: stocktakeSessions.branchId })
    .from(stocktakeSessions)
    .where(
      and(
        eq(stocktakeSessions.status, "COUNTING"),
        eq(stocktakeSessions.scopeType, "FULL"),
      ),
    )
    .orderBy(asc(stocktakeSessions.branchId), asc(stocktakeSessions.id));
  if (!sessions.length) return { sessionsChecked: 0, itemsAdded: 0 };
  return withTx(async (tx) => {
    for (const branchId of Array.from(
      new Set(sessions.map((s) => Number(s.branchId))),
    )) {
      await lockStocktakeBranch(tx, branchId);
    }

    let itemsAdded = 0;
    for (const row of sessions) {
      const sessionId = Number(row.id);
      const locked = (
        await tx
          .select({
            id: stocktakeSessions.id,
            branchId: stocktakeSessions.branchId,
            sessionType: stocktakeSessions.sessionType,
            status: stocktakeSessions.status,
            scopeType: stocktakeSessions.scopeType,
          })
          .from(stocktakeSessions)
          .where(eq(stocktakeSessions.id, sessionId))
          .for("update")
          .limit(1)
      )[0];
      if (!locked) continue;
      itemsAdded += await syncSingleFullStocktakeSessionTx(tx, locked);
    }

    return { sessionsChecked: sessions.length, itemsAdded };
  });
}

/**
 * مزامنة غير حاجزة لحفظ الكتالوج: إذا تعثّرت المزامنة (مثلاً بسبب قفل جلسة جرد نشطة)،
 * لا نفشل حفظ الصنف الملتزم بل نعيد تحذير `STOCKTAKE_SYNC_PENDING`، ويستدرك إقفال العد
 * النطاق تحت أقفال الجلسة قبل فحص الاكتمال.
 */
export async function trySyncActiveFullStocktakeScopes(): Promise<{
  stocktakeSyncPending: boolean;
  warnings: string[];
}> {
  try {
    await syncActiveFullStocktakeScopes();
    return { stocktakeSyncPending: false, warnings: [] };
  } catch (err) {
    logger.warn(
      { err },
      "تعذّرت مزامنة النطاق الحي للجرد الشامل بعد تعديل الكتالوج؛ ستُستدرك عند إقفال العد",
    );
    return {
      stocktakeSyncPending: true,
      warnings: [STOCKTAKE_SYNC_PENDING_WARNING],
    };
  }
}
