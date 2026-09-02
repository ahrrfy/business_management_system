import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  branches,
  customers,
  invoices,
  quotations,
  salesLeads,
  salesOpportunities,
  users,
} from "../../../drizzle/schema";
import { money, round2, toDateStr, toDbMoney } from "../money";
import { requireDb, type Actor } from "../tx";
import { leadConditions } from "./leads";
import { opportunityConditions } from "./opportunities";
import {
  canPipelineCrossBranches,
  isPipelineSupervisor,
  resolvePipelineBranch,
} from "./scope";
import type { PipelineReadScope } from "./types";
import {
  SALES_LEAD_STATUSES,
  SALES_OPPORTUNITY_STAGES,
  type SalesLeadStatus,
  type SalesOpportunityStage,
} from "@shared/salesPipeline";

function leadCountsSeed(): Record<SalesLeadStatus, number> {
  return Object.fromEntries(
    SALES_LEAD_STATUSES.map((status) => [status, 0]),
  ) as Record<SalesLeadStatus, number>;
}

function opportunityCountsSeed(): Record<SalesOpportunityStage, number> {
  return Object.fromEntries(
    SALES_OPPORTUNITY_STAGES.map((stage) => [stage, 0]),
  ) as Record<SalesOpportunityStage, number>;
}

export async function getSalesPipelineDashboard(scope: PipelineReadScope) {
  const db = requireDb();
  const leadWhere = leadConditions({}, scope);
  const opportunityWhere = opportunityConditions({}, scope);
  const today = toDateStr();
  const horizon = new Date(`${today}T00:00:00.000Z`);
  horizon.setUTCDate(horizon.getUTCDate() + 30);
  const horizonDate = toDateStr(horizon);
  const leadRows = await db
    .select({ status: salesLeads.status, count: sql<number>`COUNT(*)` })
    .from(salesLeads)
    .where(leadWhere.length ? and(...leadWhere) : undefined)
    .groupBy(salesLeads.status);
  const opportunityRows = await db
    .select({
      stage: salesOpportunities.stage,
      count: sql<number>`COUNT(*)`,
      openValue: sql<string>`COALESCE(SUM(CASE WHEN ${salesOpportunities.stage} NOT IN ('WON','LOST') THEN ${salesOpportunities.expectedValue} ELSE 0 END),0)`,
      weightedForecast: sql<string>`COALESCE(SUM(CASE WHEN ${salesOpportunities.stage} NOT IN ('WON','LOST') THEN ${salesOpportunities.expectedValue} * ${salesOpportunities.probability} / 100 ELSE 0 END),0)`,
      closingNext30Days: sql<string>`COALESCE(SUM(CASE WHEN ${salesOpportunities.stage} NOT IN ('WON','LOST') AND ${salesOpportunities.expectedCloseDate} BETWEEN ${today} AND ${horizonDate} THEN ${salesOpportunities.expectedValue} ELSE 0 END),0)`,
    })
    .from(salesOpportunities)
    .where(opportunityWhere.length ? and(...opportunityWhere) : undefined)
    .groupBy(salesOpportunities.stage);

  const leadCounts = leadCountsSeed();
  for (const row of leadRows)
    leadCounts[row.status as SalesLeadStatus] = Number(row.count);
  const opportunityCounts = opportunityCountsSeed();
  let openValue = money(0);
  let weightedForecast = money(0);
  let closingNext30Days = money(0);
  for (const row of opportunityRows) {
    opportunityCounts[row.stage as SalesOpportunityStage] = Number(row.count);
    openValue = openValue.plus(money(row.openValue));
    weightedForecast = weightedForecast.plus(money(row.weightedForecast));
    closingNext30Days = closingNext30Days.plus(money(row.closingNext30Days));
  }

  const overdueLeadConditions = [
    ...leadWhere,
    inArray(salesLeads.status, ["NEW", "CONTACTED", "QUALIFIED"]),
    lt(salesLeads.nextFollowUpAt, new Date()),
  ];
  const overdueOpportunityConditions = [
    ...opportunityWhere,
    inArray(salesOpportunities.stage, ["DISCOVERY", "PROPOSAL", "NEGOTIATION"]),
    lt(salesOpportunities.expectedCloseDate, today),
  ];
  const overdueLeads = await db
    .select({
      id: salesLeads.id,
      leadNumber: salesLeads.leadNumber,
      contactName: salesLeads.contactName,
      ownerId: salesLeads.ownerId,
      nextFollowUpAt: salesLeads.nextFollowUpAt,
    })
    .from(salesLeads)
    .where(and(...overdueLeadConditions))
    .orderBy(asc(salesLeads.nextFollowUpAt))
    .limit(12);
  const overdueOpportunities = await db
    .select({
      id: salesOpportunities.id,
      opportunityNumber: salesOpportunities.opportunityNumber,
      title: salesOpportunities.title,
      ownerId: salesOpportunities.ownerId,
      expectedValue: salesOpportunities.expectedValue,
      expectedCloseDate: salesOpportunities.expectedCloseDate,
    })
    .from(salesOpportunities)
    .where(and(...overdueOpportunityConditions))
    .orderBy(asc(salesOpportunities.expectedCloseDate))
    .limit(12);

  return {
    leadCounts,
    opportunityCounts,
    forecast: {
      openValue: toDbMoney(round2(openValue)),
      weightedForecast: toDbMoney(round2(weightedForecast)),
      closingNext30Days: toDbMoney(round2(closingNext30Days)),
    },
    overdueLeads,
    overdueOpportunities,
  };
}

export async function getSalesPipelineOptions(
  requestedBranchId: number | null | undefined,
  actor: Actor,
) {
  const db = requireDb();
  const crossBranch = canPipelineCrossBranches(actor);
  const availableBranches = await db
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(
      and(
        eq(branches.isActive, true),
        crossBranch ? undefined : eq(branches.id, actor.branchId),
      ),
    )
    .orderBy(asc(branches.name));

  const branchId =
    crossBranch && requestedBranchId == null && !(actor.branchId > 0)
      ? null
      : resolvePipelineBranch(requestedBranchId, actor);
  const owners =
    branchId == null
      ? []
      : await db
          .select({ id: users.id, name: users.name, role: users.role })
          .from(users)
          .where(
            and(
              eq(users.isActive, true),
              eq(users.branchId, branchId),
              isPipelineSupervisor(actor)
                ? undefined
                : eq(users.id, actor.userId),
            ),
          )
          .orderBy(asc(users.name));
  const customerRows = await db
    .select({ id: customers.id, name: customers.name, phone: customers.phone })
    .from(customers)
    .where(eq(customers.isActive, true))
    .orderBy(desc(customers.updatedAt))
    .limit(300);
  const quotationRows =
    branchId == null
      ? []
      : await db
          .select({
            id: quotations.id,
            quoteNumber: quotations.quoteNumber,
            customerId: quotations.customerId,
            total: quotations.total,
            status: quotations.status,
          })
          .from(quotations)
          .where(
            and(
              eq(quotations.branchId, branchId),
              inArray(quotations.status, [
                "DRAFT",
                "SENT",
                "ACCEPTED",
                "CONVERTED",
              ]),
            ),
          )
          .orderBy(desc(quotations.id))
          .limit(200);
  const invoiceRows =
    branchId == null
      ? []
      : await db
          .select({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            customerId: invoices.customerId,
            total: invoices.total,
            status: invoices.status,
          })
          .from(invoices)
          .where(
            and(
              eq(invoices.branchId, branchId),
              inArray(invoices.status, [
                "PENDING",
                "CONFIRMED",
                "PAID",
                "PARTIALLY_PAID",
              ]),
            ),
          )
          .orderBy(desc(invoices.id))
          .limit(200);
  return {
    selectedBranchId: branchId,
    branches: availableBranches,
    owners,
    customers: customerRows,
    quotations: quotationRows,
    invoices: invoiceRows,
  };
}
