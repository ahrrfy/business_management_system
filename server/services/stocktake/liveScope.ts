// مزامنة «النطاق الحي» للجرد الشامل.
//
// الجرد الشامل يلتقط لقطة عند الإنشاء لأجل تدقيق الرصيد/الكلفة، لكنه يبقى قيد العد أحياناً
// بينما ينشئ فريق آخر أصنافاً أو متغيّرات جديدة. هذه المزامنة تُلحق الجديد فقط بالجلسات
// FULL التي ما زالت COUNTING؛ لا تمس جلسة REVIEW أو APPROVED ولا تغيّر أي عنصر موجود.
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  branchStock,
  products,
  productVariants,
  stocktakeAssignments,
  stocktakeItems,
  stocktakeSessions,
} from "../../../drizzle/schema";
import { toDbMoney } from "../money";
import { withTx } from "../tx";
import { chunk } from "./internal";
import { loadOpeningPurchaseLinkedVariantIds } from "./openingEligibility";

export interface LiveScopeSyncResult {
  sessionsChecked: number;
  itemsAdded: number;
}

/**
 * يلحق كل متغيّر مؤهل لم يدخل بعد بجلسة FULL نشطة.
 *
 * OPENING: لا بكج/أمانة، ولا صنف خُتم openedAt له، ولا صنف مرتبط بمشتريات الفرع.
 * NORMAL: يطابق تماماً نطاق FULL الأصلي (كل منتج/متغيّر نشط عدا البكج).
 *
 * قفل صف الجلسة يحمي سباق «إنهاء العد → المراجعة»؛ وقيد
 * uq_stkitem_session_variant يبقى الحارس الأخير ضد أي مزامنة متزامنة.
 */
export async function syncActiveFullStocktakeScopes(): Promise<LiveScopeSyncResult> {
  return withTx(async (tx) => {
    const sessions = await tx
      .select({ id: stocktakeSessions.id })
      .from(stocktakeSessions)
      .where(and(eq(stocktakeSessions.status, "COUNTING"), eq(stocktakeSessions.scopeType, "FULL")));

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
      if (!locked || locked.status !== "COUNTING" || locked.scopeType !== "FULL") continue;

      // assignmentId حقل تقني متبقٍ من بنية التكليف القديمة؛ قائمة العد مشتركة لجميع العمال.
      const assignment = (
        await tx
          .select({ id: stocktakeAssignments.id })
          .from(stocktakeAssignments)
          .where(eq(stocktakeAssignments.sessionId, sessionId))
          .limit(1)
      )[0];
      if (!assignment) continue;

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
          and(eq(branchStock.variantId, productVariants.id), eq(branchStock.branchId, locked.branchId)),
        )
        .leftJoin(
          stocktakeItems,
          and(eq(stocktakeItems.sessionId, sessionId), eq(stocktakeItems.variantId, productVariants.id)),
        )
        .where(
          and(
            eq(products.isActive, true),
            eq(productVariants.isActive, true),
            eq(products.isService, false),
            eq(products.isBundle, false),
            isNull(stocktakeItems.id),
            ...(isOpening ? [eq(products.isConsignment, false), isNull(branchStock.openedAt)] : []),
          ),
        );

      if (!candidates.length) continue;
      const purchasedSet = isOpening
        ? await loadOpeningPurchaseLinkedVariantIds(
            tx,
            Number(locked.branchId),
            candidates.map((candidate) => Number(candidate.variantId)),
          )
        : new Set<number>();
      const eligibleCandidates = candidates.filter(
        (candidate) => !purchasedSet.has(Number(candidate.variantId)),
      );
      if (!eligibleCandidates.length) continue;

      const items = eligibleCandidates.map((candidate) => ({
        sessionId,
        assignmentId: Number(assignment.id),
        variantId: Number(candidate.variantId),
        branchId: Number(locked.branchId),
        expectedQty: candidate.stockQty ?? 0,
        unitCost: toDbMoney(String(candidate.unitCost ?? "0")),
      }));
      for (const part of chunk(items)) {
        await tx
          .insert(stocktakeItems)
          .values(part)
          // الدفاع النهائي عن التكرار في سباق اتصالين؛ لا تُستبدل لقطة عنصر قائم أبداً.
          .onDuplicateKeyUpdate({ set: { sessionId: sql`${stocktakeItems.sessionId}` } });
      }
      itemsAdded += items.length;
    }

    return { sessionsChecked: sessions.length, itemsAdded };
  });
}
