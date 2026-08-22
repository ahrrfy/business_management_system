import { and, desc, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

import { customers, loyaltyAccounts, loyaltyLedgerEntries, loyaltyPrograms } from "../../../drizzle/schema";
import { getDb, type Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { money, toDbMoney } from "../money";
import { withTx } from "../tx";

export type LoyaltyRulesInput = {
  name: string;
  status: "DRAFT" | "ACTIVE" | "PAUSED";
  pointsPerIqd: string;
  iqdDiscountPerPoint: string;
  minRedeemPoints: number;
  maxRedeemPercent: number;
  expiresAfterDays: number | null;
};

function validateRules(input: LoyaltyRulesInput) {
  const earn = money(input.pointsPerIqd);
  const discount = money(input.iqdDiscountPerPoint);
  if (earn.isNegative() || discount.isNegative()) throw new TRPCError({ code: "BAD_REQUEST", message: "قواعد النقاط والخصم لا تقبل قيماً سالبة" });
  if (input.minRedeemPoints < 0 || input.maxRedeemPercent < 0 || input.maxRedeemPercent > 100) throw new TRPCError({ code: "BAD_REQUEST", message: "حدود استبدال النقاط غير صحيحة" });
  if (input.expiresAfterDays != null && input.expiresAfterDays < 1) throw new TRPCError({ code: "BAD_REQUEST", message: "مدة انتهاء النقاط يجب أن تكون يوماً واحداً على الأقل" });
  return { earn, discount };
}

export async function listLoyaltyPrograms() {
  const db = getDb();
  if (!db) return [];
  return db.select().from(loyaltyPrograms).orderBy(desc(loyaltyPrograms.updatedAt));
}

export async function saveLoyaltyProgram(input: LoyaltyRulesInput & { id?: number }, actorUserId: number) {
  const { earn, discount } = validateRules(input);
  return withTx(async (tx) => {
    const values = {
      name: input.name.trim(), status: input.status,
      pointsPerIqd: earn.toFixed(6), iqdDiscountPerPoint: toDbMoney(discount),
      minRedeemPoints: input.minRedeemPoints, maxRedeemPercent: input.maxRedeemPercent,
      expiresAfterDays: input.expiresAfterDays,
    };
    if (input.id) {
      const exists = (await tx.select({ id: loyaltyPrograms.id }).from(loyaltyPrograms).where(eq(loyaltyPrograms.id, input.id)).for("update").limit(1))[0];
      if (!exists) throw new TRPCError({ code: "NOT_FOUND", message: "برنامج الولاء غير موجود" });
      await tx.update(loyaltyPrograms).set(values).where(eq(loyaltyPrograms.id, input.id));
      return { id: input.id, ...values };
    }
    const result = await tx.insert(loyaltyPrograms).values({ ...values, createdBy: actorUserId });
    return { id: extractInsertId(result), ...values };
  });
}

/** يُستدعى داخل معاملة تسليم الطلب فقط؛ فهرس فريد يمنع المنح المكرر حتى عند إعادة محاولة العملية. */
export async function awardDeliveredOnlineOrderPoints(tx: Tx, input: { onlineOrderId: number; customerId: number; total: string }) {
  const program = (await tx.select().from(loyaltyPrograms).where(eq(loyaltyPrograms.status, "ACTIVE")).orderBy(desc(loyaltyPrograms.updatedAt)).for("update").limit(1))[0];
  if (!program) return null;
  const already = (await tx.select({ id: loyaltyLedgerEntries.id }).from(loyaltyLedgerEntries).where(and(eq(loyaltyLedgerEntries.onlineOrderId, input.onlineOrderId), eq(loyaltyLedgerEntries.entryType, "ORDER_EARN"))).limit(1))[0];
  if (already) return null;
  const points = money(input.total).times(money(program.pointsPerIqd));
  if (!points.gt(0)) return null;
  let account = (await tx.select().from(loyaltyAccounts).where(and(eq(loyaltyAccounts.programId, Number(program.id)), eq(loyaltyAccounts.customerId, input.customerId))).for("update").limit(1))[0];
  if (!account) {
    const created = await tx.insert(loyaltyAccounts).values({ programId: Number(program.id), customerId: input.customerId, pointsBalance: "0" });
    const accountId = extractInsertId(created);
    account = (await tx.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.id, accountId)).for("update").limit(1))[0]!;
  }
  const nextBalance = money(account.pointsBalance).plus(points);
  await tx.update(loyaltyAccounts).set({ pointsBalance: toDbMoney(nextBalance) }).where(eq(loyaltyAccounts.id, Number(account.id)));
  await tx.insert(loyaltyLedgerEntries).values({ accountId: Number(account.id), customerId: input.customerId, onlineOrderId: input.onlineOrderId, entryType: "ORDER_EARN", pointsDelta: toDbMoney(points), balanceAfter: toDbMoney(nextBalance), note: "نقاط طلب مكتمل" });
  return { accountId: Number(account.id), awarded: toDbMoney(points), balance: toDbMoney(nextBalance) };
}

export async function loyaltyOverview(limit = 30) {
  const db = getDb();
  if (!db) return { accounts: [], totalPoints: "0" };
  const accounts = await db.select({ customerId: customers.id, customerName: customers.name, pointsBalance: loyaltyAccounts.pointsBalance, programName: loyaltyPrograms.name, updatedAt: loyaltyAccounts.updatedAt }).from(loyaltyAccounts).innerJoin(customers, eq(loyaltyAccounts.customerId, customers.id)).innerJoin(loyaltyPrograms, eq(loyaltyAccounts.programId, loyaltyPrograms.id)).orderBy(desc(loyaltyAccounts.pointsBalance)).limit(limit);
  const total = (await db.select({ value: sql<string>`COALESCE(SUM(${loyaltyAccounts.pointsBalance}), 0)` }).from(loyaltyAccounts))[0];
  return { accounts, totalPoints: String(total?.value ?? "0") };
}
