// أدوات مشتركة خاصة بحزمة الجرد (لا تُصدَّر من نقطة الدخول العامة): تقطيع الدفعات، ترويسة الجلسة،
// حارس صلاحية الفرع، وقفل صفّ الجلسة. مصدر واحد يستعمله بقية الوحدات ⇒ لا تكرار ولا تباعد.
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import {
  branches,
  products,
  productVariants,
  stocktakeCounts,
  stocktakeItems,
  stocktakeSessions,
  users,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";

/** قراءة تعمل على القاعدة أو داخل معاملة (الاعتماد يعيد الحساب داخل tx). */
export type DbLike = DB | Tx;

function chunk<T>(arr: T[], size = 1000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** ترويسة الجلسة (مع أسماء المنشئ/الموقّعَين) — بلا pinHash أبداً. */
async function loadSessionHeader(db: DbLike, sessionId: number) {
  const creator = alias(users, "stkCreator");
  const signer = alias(users, "stkSigner");
  const approver = alias(users, "stkApprover");
  const canceller = alias(users, "stkCanceller");
  const rows = await db
    .select({
      id: stocktakeSessions.id,
      code: stocktakeSessions.code,
      name: stocktakeSessions.name,
      branchId: stocktakeSessions.branchId,
      branchName: branches.name,
      scopeType: stocktakeSessions.scopeType,
      scopeDetail: stocktakeSessions.scopeDetail,
      sessionType: stocktakeSessions.sessionType,
      status: stocktakeSessions.status,
      blind: stocktakeSessions.blind,
      thresholdPct: stocktakeSessions.thresholdPct,
      thresholdValue: stocktakeSessions.thresholdValue,
      dualThreshold: stocktakeSessions.dualThreshold,
      directUnderThreshold: stocktakeSessions.directUnderThreshold,
      waNotify: stocktakeSessions.waNotify,
      dupPolicy: stocktakeSessions.dupPolicy,
      notes: stocktakeSessions.notes,
      createdAt: stocktakeSessions.createdAt,
      createdBy: stocktakeSessions.createdBy,
      createdByName: creator.name,
      submittedAt: stocktakeSessions.submittedAt,
      firstSignBy: stocktakeSessions.firstSignBy,
      firstSignAt: stocktakeSessions.firstSignAt,
      firstSignByName: signer.name,
      approvedBy: stocktakeSessions.approvedBy,
      approvedAt: stocktakeSessions.approvedAt,
      approvedByName: approver.name,
      cancelledAt: stocktakeSessions.cancelledAt,
      cancelledByName: canceller.name,
    })
    .from(stocktakeSessions)
    .leftJoin(branches, eq(stocktakeSessions.branchId, branches.id))
    .leftJoin(creator, eq(stocktakeSessions.createdBy, creator.id))
    .leftJoin(signer, eq(stocktakeSessions.firstSignBy, signer.id))
    .leftJoin(approver, eq(stocktakeSessions.approvedBy, approver.id))
    .leftJoin(canceller, eq(stocktakeSessions.cancelledBy, canceller.id))
    .where(eq(stocktakeSessions.id, sessionId))
    .limit(1);
  const s = rows[0];
  if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "جلسة الجرد غير موجودة" });
  return s;
}

function assertBranchAccess(sessionBranchId: number, restrictBranchId: number | null | undefined) {
  if (restrictBranchId != null && Number(sessionBranchId) !== Number(restrictBranchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا صلاحية على جلسات فرع آخر" });
  }
}

/** قفل صف الجلسة داخل المعاملة — يسلسل الاعتماد/القرارات المتزامنة. */
async function lockSession(tx: Tx, sessionId: number) {
  const rows = await tx.select().from(stocktakeSessions).where(eq(stocktakeSessions.id, sessionId)).for("update").limit(1);
  const s = rows[0];
  if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "جلسة الجرد غير موجودة" });
  return s;
}

export type StocktakeProgress = { total: number; counted: number };

/**
 * تعريف التقدم المركزي لكل مسارات الجرد: صنف داخل stocktakeItems وله FIRST/RECOUNT.
 * البدء من النطاق يمنع العدّات الشاذة خارجه، والـJOIN الصريح يتجنب انحراف EXISTS
 * المترابط الذي ظهر في خطة MySQL الإنتاجية.
 */
async function loadStocktakeProgressMap(db: DbLike, sessionIds: number[]): Promise<Map<number, StocktakeProgress>> {
  const ids = Array.from(new Set(sessionIds.map(Number).filter((id) => Number.isFinite(id) && id > 0)));
  const out = new Map<number, StocktakeProgress>();
  if (!ids.length) return out;
  const rows = await db
    .select({
      sessionId: stocktakeItems.sessionId,
      total: sql<number>`COUNT(DISTINCT ${stocktakeItems.id})`,
      counted: sql<number>`COUNT(DISTINCT CASE WHEN ${stocktakeCounts.id} IS NOT NULL THEN ${stocktakeItems.id} END)`,
    })
    .from(stocktakeItems)
    .leftJoin(
      stocktakeCounts,
      and(
        eq(stocktakeCounts.sessionId, stocktakeItems.sessionId),
        eq(stocktakeCounts.variantId, stocktakeItems.variantId),
        inArray(stocktakeCounts.kind, ["FIRST", "RECOUNT"]),
      ),
    )
    .innerJoin(productVariants, eq(stocktakeItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(and(inArray(stocktakeItems.sessionId, ids), eq(products.isService, false)))
    .groupBy(stocktakeItems.sessionId);
  for (const row of rows) {
    const total = Number(row.total);
    out.set(Number(row.sessionId), { total, counted: Math.min(total, Number(row.counted)) });
  }
  return out;
}

async function loadStocktakeProgress(db: DbLike, sessionId: number): Promise<StocktakeProgress> {
  return (await loadStocktakeProgressMap(db, [sessionId])).get(sessionId) ?? { total: 0, counted: 0 };
}


// تصدير داخلي للحزمة فقط (تستهلكه بقية وحدات stocktake) — لا يُعاد تصديره من البرميل
// stocktakeService.ts ⇒ يبقى خارج الواجهة العامة.
export {
  chunk,
  loadSessionHeader,
  assertBranchAccess,
  lockSession,
  loadStocktakeProgress,
  loadStocktakeProgressMap,
};
