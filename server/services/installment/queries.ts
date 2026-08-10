// قوائم واستعلامات القراءة: صفحات الخطط + تفاصيل خطة + طابور التحصيل القريب الاستحقاق.
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { customers, installmentLines, installmentPlans } from "../../../drizzle/schema";
import { toDateStr, toDbMoney } from "../money";
import { requireDb } from "../tx";
import { assertPlanBranch, type BranchRestriction, type InstallmentKind, type ListPlansFilter, type PlanStatus } from "./types";

export async function listPlans(filter: ListPlansFilter) {
  const db = requireDb();
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);

  const wheres = [];
  if (filter.branchId != null) wheres.push(eq(installmentPlans.branchId, filter.branchId));
  if (filter.customerId != null) wheres.push(eq(installmentPlans.customerId, filter.customerId));
  if (filter.status) wheres.push(eq(installmentPlans.status, filter.status));

  // limit+1 ⇒ hasMore بلا COUNT (نمط حملة الأداء).
  const rows = await db
    .select({
      plan: installmentPlans,
      customerName: customers.name,
      customerPhone: sql<string | null>`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
    })
    .from(installmentPlans)
    .innerJoin(customers, eq(installmentPlans.customerId, customers.id))
    .where(wheres.length ? and(...wheres) : undefined)
    .orderBy(desc(installmentPlans.id))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const planIds = page.map((r) => Number(r.plan.id));

  // تجميع تقدّم الأقساط لخطط الصفحة فقط.
  const aggMap = new Map<number, { totalLines: number; paidLines: number; paidAmount: string; nextDueDate: string | null }>();
  if (planIds.length > 0) {
    const aggs = await db
      .select({
        planId: installmentLines.planId,
        totalLines: sql<number>`COUNT(*)`,
        paidLines: sql<number>`SUM(CASE WHEN ${installmentLines.status} = 'PAID' THEN 1 ELSE 0 END)`,
        paidAmount: sql<string>`COALESCE(SUM(CASE WHEN ${installmentLines.status} = 'PAID' THEN ${installmentLines.amount} ELSE 0 END), 0)`,
        // DATE_FORMAT ⇒ سلسلة YYYY-MM-DD حتمياً (raw sql يتجاوز mapping عمود date mode:"string").
        nextDueDate: sql<string | null>`DATE_FORMAT(MIN(CASE WHEN ${installmentLines.status} IN ('PENDING','BOUNCED') THEN ${installmentLines.dueDate} END), '%Y-%m-%d')`,
      })
      .from(installmentLines)
      .where(inArray(installmentLines.planId, planIds))
      .groupBy(installmentLines.planId);
    for (const a of aggs) {
      aggMap.set(Number(a.planId), {
        totalLines: Number(a.totalLines),
        paidLines: Number(a.paidLines ?? 0),
        paidAmount: toDbMoney(a.paidAmount ?? "0"),
        nextDueDate: a.nextDueDate ?? null,
      });
    }
  }

  return {
    rows: page.map((r) => {
      const agg = aggMap.get(Number(r.plan.id)) ?? { totalLines: 0, paidLines: 0, paidAmount: "0.00", nextDueDate: null };
      return {
        id: Number(r.plan.id),
        customerId: Number(r.plan.customerId),
        customerName: r.customerName,
        customerPhone: r.customerPhone,
        invoiceId: r.plan.invoiceId != null ? Number(r.plan.invoiceId) : null,
        branchId: Number(r.plan.branchId),
        totalAmount: r.plan.totalAmount,
        downPayment: r.plan.downPayment,
        status: r.plan.status as PlanStatus,
        notes: r.plan.notes,
        createdAt: r.plan.createdAt,
        ...agg,
      };
    }),
    hasMore,
  };
}

/** تفاصيل خطة بأقساطها (مرتّبة seq) — للراوتر get مع عزل الفرع. */
export async function getPlan(planId: number, restrictToBranchId: BranchRestriction = null) {
  const db = requireDb();
  const row = (
    await db
      .select({
        plan: installmentPlans,
        customerName: customers.name,
        customerPhone: sql<string | null>`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
      })
      .from(installmentPlans)
      .innerJoin(customers, eq(installmentPlans.customerId, customers.id))
      .where(eq(installmentPlans.id, planId))
      .limit(1)
  )[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "الخطة غير موجودة" });
  assertPlanBranch(Number(row.plan.branchId), restrictToBranchId);
  const lines = await db
    .select()
    .from(installmentLines)
    .where(eq(installmentLines.planId, planId))
    .orderBy(asc(installmentLines.seq));
  return {
    ...row.plan,
    id: Number(row.plan.id),
    customerId: Number(row.plan.customerId),
    branchId: Number(row.plan.branchId),
    invoiceId: row.plan.invoiceId != null ? Number(row.plan.invoiceId) : null,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    lines: lines.map((l) => ({ ...l, id: Number(l.id), planId: Number(l.planId), receiptId: l.receiptId != null ? Number(l.receiptId) : null })),
  };
}

/** طابور التحصيل: أقساط PENDING مستحقّة خلال N أيام أو متأخّرة — الأشد تأخّراً أولاً. */
export async function dueSoon(filter: { branchId?: number | null; days?: number }) {
  const db = requireDb();
  const days = Math.min(Math.max(filter.days ?? 7, 0), 90);
  const today = toDateStr();
  const horizon = toDateStr(new Date(Date.now() + days * 86_400_000));

  const wheres = [
    eq(installmentLines.status, "PENDING"),
    eq(installmentPlans.status, "ACTIVE"),
    lte(installmentLines.dueDate, horizon),
  ];
  if (filter.branchId != null) wheres.push(eq(installmentPlans.branchId, filter.branchId));

  const rows = await db
    .select({
      line: installmentLines,
      planId: installmentPlans.id,
      branchId: installmentPlans.branchId,
      customerId: installmentPlans.customerId,
      customerName: customers.name,
      customerPhone: sql<string | null>`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
    })
    .from(installmentLines)
    .innerJoin(installmentPlans, eq(installmentLines.planId, installmentPlans.id))
    .innerJoin(customers, eq(installmentPlans.customerId, customers.id))
    .where(and(...wheres))
    .orderBy(asc(installmentLines.dueDate), asc(installmentLines.id))
    .limit(200);

  return rows.map((r) => {
    const overdueMs = new Date(`${today}T00:00:00Z`).getTime() - new Date(`${r.line.dueDate}T00:00:00Z`).getTime();
    const daysOverdue = Math.max(0, Math.round(overdueMs / 86_400_000));
    return {
      lineId: Number(r.line.id),
      planId: Number(r.planId),
      branchId: Number(r.branchId),
      customerId: Number(r.customerId),
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      seq: r.line.seq,
      dueDate: r.line.dueDate,
      amount: r.line.amount,
      kind: r.line.kind as InstallmentKind,
      checkNumber: r.line.checkNumber,
      bankName: r.line.bankName,
      daysOverdue,
    };
  });
}
