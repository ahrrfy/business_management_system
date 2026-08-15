import { TRPCError } from "@trpc/server";
import { getDb, type DB, type Tx } from "../db";
import {
  lockCompanyMonthCloseGate,
  lockFinancialPostingGate,
} from "./reports/monthCloseGate";

/** Resolve the DB or throw a uniform tRPC error when DATABASE_URL is unset. */
export function requireDb(): DB {
  const db = getDb();
  if (!db) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "قاعدة البيانات غير متاحة",
    });
  }
  return db;
}

export type TransactionGate = "FINANCIAL_WRITER" | "GOVERNANCE" | "NONE";

/**
 * Wrap a unit of work in an atomic transaction. Any throw ⇒ full ROLLBACK.
 *
 * The default gate is deliberately acquired before the callback can lock any
 * domain row. This gives every application transaction one global lock order:
 * company gate -> domain rows. Month/year-close governance asks for the
 * exclusive form at transaction entry, so it can never hold the gate while a
 * writer waits on a domain lock that governance later needs.
 */
export async function withTx<T>(
  fn: (tx: Tx) => Promise<T>,
  options: { gate?: TransactionGate } = {},
): Promise<T> {
  return requireDb().transaction(async (tx) => {
    const gate = options.gate ?? "FINANCIAL_WRITER";
    if (gate === "GOVERNANCE") await lockCompanyMonthCloseGate(tx);
    else if (gate === "FINANCIAL_WRITER") await lockFinancialPostingGate(tx);
    return fn(tx);
  });
}

/** Governance transaction with the exclusive close gate acquired at entry. */
export function withGovernanceTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTx(fn, { gate: "GOVERNANCE" });
}

/**
 * Actor يُمثّل المستخدم المُنفِّذ للعملية. يُمرَّر إلى كل خدمة كتابة:
 * - userId: معرّف المستخدم (users.id) — للتدقيق + ملكية الوردية.
 * - branchId: معرّف الفرع الذي يَنتمي إليه المستخدم (users.branchId) — لعزل الفروع.
 * - role: دور المستخدم (admin/manager/cashier/warehouse) — للـRBAC على cross-branch وكشف التكلفة.
 * تأكَّد من تَمرير role من ctx.user.role في كل الراوترات.
 *
 * ملاحظة: role اختياري حفاظاً على التوافق الخلفي، لكن الخدمات التي تَفحص الصلاحية
 * على مستوى الخدمة (مثل productionService.assertProductionBranch، عزل الفروع لغير
 * admin، حجب التكلفة عن الكاشير) تَعتمد عليه — تَمريره من ctx.user.role إلزامي عملياً.
 */
export type Actor = {
  userId: number;
  branchId: number;
  role?: string;
  isOwner?: boolean;
};
