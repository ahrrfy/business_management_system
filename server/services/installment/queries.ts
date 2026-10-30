// قوائم واستعلامات القراءة: صفحات الخطط + تفاصيل خطة + طابور التحصيل القريب الاستحقاق.
import { TRPCError } from "@trpc/server";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  inArray,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  customers,
  installmentLines,
  installmentPlans,
  receipts,
} from "../../../drizzle/schema";
import {
  installmentLineViews,
  installmentPlanViews,
} from "./receiptAllocations";
import { money, toDateStr, toDbMoney } from "../money";
import { requireDb } from "../tx";
import { escLike } from "../../lib/sqlLike";
import { utcDayStart, utcNextDayStart } from "../businessDay";
import {
  assertPlanBranch,
  type BranchRestriction,
  type InstallmentKind,
  type ListPlansFilter,
  type PlanStatus,
} from "./types";

export async function listPlans(filter: ListPlansFilter) {
  return requireDb().transaction(async (db) => {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);

    const wheres = [];
    if (filter.branchId != null)
      wheres.push(eq(installmentPlans.branchId, filter.branchId));
    if (filter.customerId != null)
      wheres.push(eq(installmentPlans.customerId, filter.customerId));
    if (filter.status) wheres.push(eq(installmentPlans.status, filter.status));
    if (filter.from)
      wheres.push(gte(installmentPlans.createdAt, utcDayStart(filter.from)));
    if (filter.to)
      wheres.push(lt(installmentPlans.createdAt, utcNextDayStart(filter.to)));
    const q = filter.q?.trim();
    if (q) {
      const pattern = `%${escLike(q)}%`;
      wheres.push(
        or(
          sql`CAST(${installmentPlans.id} AS CHAR) LIKE ${pattern} ESCAPE '!'`,
          sql`${customers.name} LIKE ${pattern} ESCAPE '!'`,
          exists(
            db
              .select({ id: installmentLines.id })
              .from(installmentLines)
              .where(
                and(
                  eq(installmentLines.planId, installmentPlans.id),
                  sql`${installmentLines.checkNumber} LIKE ${pattern} ESCAPE '!'`,
                ),
              ),
          ),
        ),
      );
    }

    // limit+1 ⇒ hasMore بلا COUNT (نمط حملة الأداء).
    const rows = await db
      .select({
        plan: installmentPlans,
        customerName: customers.name,
        customerPhone: sql<
          string | null
        >`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
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

    const pageLines = planIds.length
      ? await db
          .select()
          .from(installmentLines)
          .where(inArray(installmentLines.planId, planIds))
      : [];
    const views = await installmentLineViews(db, pageLines);
    const scopeViews = await installmentPlanViews(
      db,
      page.map((row) => row.plan),
      pageLines,
      views,
    );
    const aggMap = new Map(
      planIds.map((id) => {
        const lines = pageLines.filter((line) => line.planId === id);
        const paidAmount = toDbMoney(
          lines.reduce(
            (sum, line) => sum.plus(views.get(line.id)!.paidAmount),
            money(0),
          ),
        );
        const remainingAmount = toDbMoney(
          lines.reduce(
            (sum, line) => sum.plus(views.get(line.id)!.remainingAmount),
            money(0),
          ),
        );
        return [
          id,
          {
            totalLines: lines.length,
            paidLines: lines.filter((line) =>
              money(views.get(line.id)!.remainingAmount).eq(0),
            ).length,
            paidAmount,
            remainingAmount,
            reconciliationRequired: lines.some(
              (line) => views.get(line.id)!.reconciliationRequired,
            ),
            nextDueDate:
              lines
                .filter((line) =>
                  money(views.get(line.id)!.remainingAmount).gt(0),
                )
                .map((line) => line.dueDate)
                .sort()[0] ?? null,
          },
        ] as const;
      }),
    );

    return {
      rows: page.map((r) => {
        const agg = aggMap.get(Number(r.plan.id)) ?? {
          totalLines: 0,
          paidLines: 0,
          paidAmount: "0.00",
          remainingAmount: "0.00",
          reconciliationRequired: true,
          nextDueDate: null,
        };
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
          ...scopeViews.get(r.plan.id)!,
        };
      }),
      hasMore,
    };
  });
}

/** تفاصيل خطة بأقساطها (مرتّبة seq) — للراوتر get مع عزل الفرع. */
export async function getPlan(
  planId: number,
  restrictToBranchId: BranchRestriction = null,
) {
  return requireDb().transaction(async (db) => {
    const row = (
      await db
        .select({
          plan: installmentPlans,
          customerName: customers.name,
          customerPhone: sql<
            string | null
          >`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
        })
        .from(installmentPlans)
        .innerJoin(customers, eq(installmentPlans.customerId, customers.id))
        .where(eq(installmentPlans.id, planId))
        .limit(1)
    )[0];
    if (!row)
      throw new TRPCError({ code: "NOT_FOUND", message: "الخطة غير موجودة" });
    assertPlanBranch(Number(row.plan.branchId), restrictToBranchId);
    const lines = await db
      .select({
        line: installmentLines,
        receiptPaymentMethod: receipts.paymentMethod,
      })
      .from(installmentLines)
      .leftJoin(receipts, eq(installmentLines.receiptId, receipts.id))
      .where(eq(installmentLines.planId, planId))
      .orderBy(asc(installmentLines.seq));
    const views = await installmentLineViews(
      db,
      lines.map((row) => row.line),
    );
    const scopeView = (
      await installmentPlanViews(
        db,
        [row.plan],
        lines.map((row) => row.line),
        views,
      )
    ).get(planId)!;
    return {
      ...row.plan,
      ...scopeView,
      id: Number(row.plan.id),
      customerId: Number(row.plan.customerId),
      branchId: Number(row.plan.branchId),
      invoiceId: row.plan.invoiceId != null ? Number(row.plan.invoiceId) : null,
      customerName: row.customerName,
      customerPhone: row.customerPhone,
      lines: lines.map(({ line, receiptPaymentMethod }) => {
        const {
          allocationHeadId,
          pendingAllocationClaimId,
          allocationHistoryReady,
          ...safeLine
        } = line;
        return {
          ...safeLine,
          ...views.get(line.id)!,
          reconciliationRequired:
            scopeView.reconciliationRequired ||
            views.get(line.id)!.reconciliationRequired,
          id: Number(line.id),
          planId: Number(line.planId),
          receiptId: line.receiptId != null ? Number(line.receiptId) : null,
          receiptPaymentMethod: receiptPaymentMethod ?? null,
        };
      }),
    };
  });
}

/** طابور التحصيل: أقساط PENDING مستحقّة خلال N أيام أو متأخّرة — الأشد تأخّراً أولاً. */
export async function dueSoon(filter: {
  branchId?: number | null;
  days?: number;
  limit?: number;
  offset?: number;
}) {
  return requireDb().transaction(async (db) => {
    const days = Math.min(Math.max(filter.days ?? 7, 0), 90);
    const today = toDateStr();
    const horizon = toDateStr(new Date(Date.now() + days * 86_400_000));

    const wheres = [
      eq(installmentLines.status, "PENDING"),
      eq(installmentPlans.status, "ACTIVE"),
      lte(installmentLines.dueDate, horizon),
    ];
    if (filter.branchId != null)
      wheres.push(eq(installmentPlans.branchId, filter.branchId));

    const limitVal =
      filter.limit != null ? Math.min(Math.max(filter.limit, 1), 5000) : 200;
    const offsetVal = Math.max(filter.offset ?? 0, 0);

    const rows = await db
      .select({
        line: installmentLines,
        planId: installmentPlans.id,
        branchId: installmentPlans.branchId,
        customerId: installmentPlans.customerId,
        customerName: customers.name,
        customerPhone: sql<
          string | null
        >`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
      })
      .from(installmentLines)
      .innerJoin(
        installmentPlans,
        eq(installmentLines.planId, installmentPlans.id),
      )
      .innerJoin(customers, eq(installmentPlans.customerId, customers.id))
      .where(and(...wheres))
      .orderBy(asc(installmentLines.dueDate), asc(installmentLines.id))
      .limit(limitVal)
      .offset(offsetVal);

    const planIds = Array.from(new Set(rows.map((row) => row.planId)));
    const plans = planIds.length
      ? await db
          .select()
          .from(installmentPlans)
          .where(inArray(installmentPlans.id, planIds))
      : [];
    const planLines = planIds.length
      ? await db
          .select()
          .from(installmentLines)
          .where(inArray(installmentLines.planId, planIds))
      : [];
    const views = await installmentLineViews(db, planLines);
    const scopeViews = await installmentPlanViews(db, plans, planLines, views);
    return rows.map((r) => {
      const overdueMs =
        new Date(`${today}T00:00:00Z`).getTime() -
        new Date(`${r.line.dueDate}T00:00:00Z`).getTime();
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
        ...views.get(r.line.id)!,
        ...scopeViews.get(r.planId)!,
        kind: r.line.kind as InstallmentKind,
        checkNumber: r.line.checkNumber,
        bankName: r.line.bankName,
        daysOverdue,
      };
    });
  });
}
