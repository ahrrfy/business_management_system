import { TRPCError } from "@trpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  accountingEntries,
  commissionRunLines,
  commissionRuns,
  digitalSaleDetails,
  employees,
  invoiceAttributions,
  invoices,
  payrollRuns,
  users,
  workOrders,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { appErrorMessage } from "../../../shared/errors";
import { money, toDbMoney } from "../money";
import { computeNetSalesByUser, type UserMonthBase } from "./base";
import { assertPeriod, periodDateRange } from "./period";

export interface DigitalCommissionReviewInput {
  period: string;
  actorUserId: number;
  /** Filters immutable employee-home-branch snapshots, NOT source sale branches. */
  branchId?: number;
  userId?: number;
}

const sellerId = sql<number>`COALESCE(${invoiceAttributions.userId},
  CASE WHEN ${invoices.sourceType} = 'WORKORDER' THEN ${workOrders.createdBy} END,
  ${invoices.createdBy})`;
const digitalReturn = sql`(COALESCE(${accountingEntries.postingProfile}, '') = 'RETURN_SALE_DIGITAL'
  OR COALESCE(${accountingEntries.dedupeKey}, '') LIKE 'DIGITAL:REV:%')`;

async function readDigitalSources(tx: Tx, period: string, userIds: number[]) {
  if (!userIds.length) return [];
  const { from, toExclusive } = periodDateRange(period);
  // Match the base reader's event date, beneficiary and original-share semantics.
  // Do not join details here: that would multiply multi-card invoice amounts.
  const events = await tx
    .select({
      entryId: accountingEntries.id,
      invoiceId: invoices.id,
      branchId: accountingEntries.branchId,
      entryDate: accountingEntries.entryDate,
      entryType: accountingEntries.entryType,
      revenue: accountingEntries.revenue,
      amount: accountingEntries.amount,
      userId: sellerId,
      share: sql<string>`COALESCE(${invoiceAttributions.sharePct}, 1)`,
    })
    .from(accountingEntries)
    .innerJoin(invoices, eq(invoices.id, accountingEntries.invoiceId))
    .leftJoin(
      invoiceAttributions,
      eq(invoiceAttributions.invoiceId, invoices.id),
    )
    .leftJoin(workOrders, eq(workOrders.invoiceId, invoices.id))
    .where(
      and(
        sql`${accountingEntries.entryDate} >= ${from}`,
        sql`${accountingEntries.entryDate} < ${toExclusive}`,
        inArray(sellerId, userIds),
        sql`((
        ${accountingEntries.entryType} = 'SALE' AND ${accountingEntries.supplierId} IS NULL
        AND EXISTS (SELECT 1 FROM ${digitalSaleDetails} WHERE ${digitalSaleDetails.invoiceId} = ${invoices.id})
      ) OR (
        ${accountingEntries.entryType} = 'RETURN' AND ${accountingEntries.supplierId} IS NULL AND ${digitalReturn}
      ) OR (
        ${accountingEntries.entryType} = 'PURCHASE' AND ${accountingEntries.supplierId} IS NOT NULL
        AND COALESCE(${accountingEntries.dedupeKey}, '') LIKE 'DIGITAL:%'
      ))`,
      ),
    )
    .orderBy(accountingEntries.id);
  if (!events.length) return [];
  const details = await tx
    .select({
      id: digitalSaleDetails.id,
      invoiceId: digitalSaleDetails.invoiceId,
      settlementMode: digitalSaleDetails.settlementModeSnapshot,
      sellPrice: digitalSaleDetails.sellPriceSnapshot,
    })
    .from(digitalSaleDetails)
    .where(
      inArray(
        digitalSaleDetails.invoiceId,
        Array.from(new Set(events.map((e) => e.invoiceId))),
      ),
    )
    .orderBy(digitalSaleDetails.id);
  const byInvoice = new Map<number, typeof details>();
  for (const detail of details) {
    const group = byInvoice.get(detail.invoiceId) ?? [];
    group.push(detail);
    byInvoice.set(detail.invoiceId, group);
  }
  // One beneficiary can hold several attribution roles on the same invoice.
  const grouped = new Map<
    string,
    { event: (typeof events)[number]; share: ReturnType<typeof money> }
  >();
  for (const event of events) {
    const key = `${event.entryId}:${event.userId}`;
    const previous = grouped.get(key);
    grouped.set(key, {
      event,
      share: (previous?.share ?? money(0)).plus(event.share),
    });
  }
  return Array.from(grouped.values()).map(({ event, share }) => {
    const invoiceDetails = byInvoice.get(event.invoiceId) ?? [];
    const digitalSales = invoiceDetails.reduce(
      (sum, d) => sum.plus(d.sellPrice),
      money(0),
    );
    return {
      entryId: event.entryId,
      invoiceId: event.invoiceId,
      sourceBranchId: event.branchId,
      eventDate: event.entryDate.toISOString().slice(0, 10),
      userId: event.userId,
      kind:
        event.entryType === "SALE"
          ? ("DIGITAL_SALE" as const)
          : event.entryType === "RETURN"
            ? ("DIGITAL_RETURN" as const)
            : ("DIGITAL_SUPPLIER_ACCRUAL" as const),
      attributionShare: share.toFixed(4),
      attributedSourceAmount: toDbMoney(
        (event.entryType === "SALE"
          ? digitalSales
          : money(event.entryType === "RETURN" ? event.revenue : event.amount)
        ).times(share),
      ),
      // Return journals identify an invoice, not an exact subset of its details.
      detailRelation:
        event.entryType === "SALE"
          ? ("SOLD_DETAILS" as const)
          : ("INVOICE_DETAILS_ONLY" as const),
      digitalDetails: invoiceDetails,
    };
  });
}

/** Read-only review of frozen approved runs. Never evaluates a mutable plan or
 * propagates corrected carry into another period. One explicit month per call. */
export async function reviewDigitalCommissionDifferences(
  db: DB,
  input: DigitalCommissionReviewInput,
) {
  const period = assertPeriod(input.period);
  for (const id of [input.actorUserId, input.branchId, input.userId]) {
    if (id != null && (!Number.isSafeInteger(id) || id <= 0))
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذر تحديد نطاق المراجعة",
          why: "المعرّف غير صالح",
          doThis: "أدخل معرّفاً صحيحاً موجباً",
        }),
      });
  }
  return db.transaction(
    async (tx) => {
      const [actor] = await tx
        .select({
          role: users.role,
          isOwner: users.isOwner,
          isActive: users.isActive,
        })
        .from(users)
        .where(eq(users.id, input.actorUserId))
        .limit(1);
      if (!actor?.isActive || (actor.role !== "admin" && !actor.isOwner))
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذرت مراجعة العمولات",
            why: "يلزم مدير أو مالك فعّال مسجل",
            doThis: "استخدم حساباً مخولاً للمراجعة",
          }),
        });
      const frozen = await tx
        .select({
          line: commissionRunLines,
          runId: commissionRuns.id,
          runVersion: commissionRuns.version,
          approvedAt: commissionRuns.approvedAt,
          payrollRunId: commissionRuns.payrollRunId,
          payrollStatus: payrollRuns.status,
          firstName: employees.firstName,
          lastName: employees.lastName,
        })
        .from(commissionRuns)
        .innerJoin(
          commissionRunLines,
          eq(commissionRunLines.runId, commissionRuns.id),
        )
        .leftJoin(payrollRuns, eq(payrollRuns.id, commissionRuns.payrollRunId))
        .leftJoin(employees, eq(employees.id, commissionRunLines.employeeId))
        .where(
          and(
            eq(commissionRuns.period, period),
            eq(commissionRuns.status, "approved"),
            input.branchId == null
              ? undefined
              : eq(commissionRunLines.branchId, input.branchId),
            input.userId == null
              ? undefined
              : eq(commissionRunLines.userId, input.userId),
          ),
        )
        .orderBy(commissionRunLines.id);
      // engine.ts deliberately reads company-wide user activity, even for a
      // branch-filtered run. Preserve that meaning when comparing frozen bases.
      const currentByUser = frozen.length
        ? await computeNetSalesByUser(tx, period, undefined, input.userId)
        : new Map<number, UserMonthBase>();
      const sources = await readDigitalSources(
        tx,
        period,
        Array.from(new Set(frozen.map((r) => r.line.userId))),
      );
      const rows = frozen.map(({ line, ...run }) => {
        const base = currentByUser.get(line.userId);
        const sales = base?.sales ?? money(0);
        const returns = base?.returns ?? money(0);
        const deduction = base?.consigDeduction ?? money(0);
        const netBase = sales.minus(returns).minus(deduction);
        const originalNet = money(line.baseSales)
          .minus(line.baseReturns)
          .minus(line.baseConsignDeduction);
        const delta = {
          baseSales: toDbMoney(sales.minus(line.baseSales)),
          baseReturns: toDbMoney(returns.minus(line.baseReturns)),
          baseConsignDeduction: toDbMoney(
            deduction.minus(line.baseConsignDeduction),
          ),
          netBase: toDbMoney(netBase.minus(originalNet)),
        };
        const hasBaseDifference = Object.values(delta).some(
          (v) => !money(v).isZero(),
        );
        const digitalSources = sources.filter((s) => s.userId === line.userId);
        return {
          runId: run.runId,
          runVersion: run.runVersion,
          lineId: line.id,
          employeeId: line.employeeId,
          employeeName: [run.firstName, run.lastName].filter(Boolean).join(" "),
          userId: line.userId,
          frozenBranchId: line.branchId,
          approvedAt: run.approvedAt,
          payrollRunId: run.payrollRunId,
          payrollStatus: run.payrollStatus,
          paymentEvidence:
            run.payrollStatus === "paid"
              ? ("LINKED_PAYROLL_PAID" as const)
              : ("APPROVED_COMMISSION_ONLY" as const),
          original: {
            baseSales: line.baseSales,
            baseReturns: line.baseReturns,
            baseConsignDeduction: line.baseConsignDeduction,
            netBase: toDbMoney(originalNet),
            carryIn: line.carryIn,
            effectiveBase: line.effectiveBase,
            carryOut: line.carryOut,
            commissionAmount: line.commissionAmount,
            targetAmount: line.targetAmount,
            achievementPct: line.achievementPct,
            planId: line.planId,
            tierIndex: line.tierIndex,
            ratePct: line.ratePct,
            fixedBonus: line.fixedBonus,
          },
          current: {
            baseSales: toDbMoney(sales),
            baseReturns: toDbMoney(returns),
            baseConsignDeduction: toDbMoney(deduction),
            netBase: toDbMoney(netBase),
          },
          delta,
          hasBaseDifference,
          assessment: !hasBaseDifference
            ? ("UNCHANGED" as const)
            : digitalSources.length
              ? ("BASE_DIFFERENCE_WITH_DIGITAL_SOURCES_REQUIRES_REVIEW" as const)
              : ("BASE_DIFFERENCE_CAUSE_UNPROVEN" as const),
          digitalSources,
          payoutDifference: null,
          payoutAssessment: "REQUIRES_REVIEW" as const,
          payoutReason:
            "Historical full tier schedule and incentive options are not frozen; the selected tier alone cannot prove a corrected payout.",
        };
      });
      return {
        period,
        readOnly: true as const,
        scope: {
          frozenBranchId: input.branchId ?? null,
          userId: input.userId ?? null,
          baseScope: "COMPANY_WIDE_USER_ACTIVITY" as const,
        },
        semantics: {
          delta:
            "current minus original; returns and consignment deductions are positive deductions",
          cause:
            "Digital sources are review evidence, not proof that every historical difference was caused by digital exclusion.",
          carry:
            "Original carry and effective base stay frozen; current net base excludes carry and no corrected carry is propagated.",
        },
        rows,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
