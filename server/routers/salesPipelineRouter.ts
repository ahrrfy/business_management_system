import { z } from "zod";
import {
  SALES_LEAD_SOURCES,
  SALES_LEAD_STATUSES,
  SALES_OPPORTUNITY_STAGES,
} from "@shared/salesPipeline";
import { nonNegMoneyString, percentString, ymdDate } from "../lib/schemas";
import { logAudit } from "../services/auditService";
import {
  convertLeadToOpportunity,
  createSalesLead,
  createSalesOpportunity,
  getSalesLeadDetail,
  getSalesOpportunityDetail,
  getSalesPipelineDashboard,
  getSalesPipelineOptions,
  listSalesLeads,
  listSalesOpportunities,
  transitionSalesLead,
  transitionSalesOpportunity,
  updateSalesLead,
  updateSalesOpportunity,
} from "../services/salesPipeline";
import { crmReadProcedure, crmWriteProcedure, router } from "../trpc";
import type { TrpcContext } from "../context";

const id = z.number().int().positive();
const requestKey = z.string().trim().min(8).max(120);
const reason = z.string().trim().min(3).max(500);
const cursor = z.object({ updatedAt: z.coerce.date(), id });
const nullableText = (max: number) =>
  z.string().trim().max(max).nullable().optional();

function actorOf(ctx: { user: NonNullable<TrpcContext["user"]> }) {
  return {
    userId: ctx.user.id,
    branchId: ctx.user.branchId ?? 0,
    role: ctx.user.role,
    isOwner: ctx.user.isOwner === true,
  };
}

function scopeOf(ctx: {
  scopedBranchId: number | null;
  scopedOwnerId: number | null;
}) {
  return {
    scopedBranchId: ctx.scopedBranchId,
    scopedOwnerId: ctx.scopedOwnerId,
  };
}

const leadCreateInput = z.object({
  branchId: id.nullish(),
  source: z.enum(SALES_LEAD_SOURCES),
  contactName: z.string().trim().min(1).max(255),
  companyName: nullableText(255),
  phone: nullableText(20),
  email: z.string().trim().email().max(320).nullable().optional(),
  customerId: id.nullish(),
  ownerId: id.nullish(),
  nextFollowUpAt: z.coerce.date().nullable().optional(),
  clientRequestId: requestKey,
});

const opportunityDraft = z.object({
  branchId: id.nullish(),
  customerId: id,
  ownerId: id.nullish(),
  title: z.string().trim().min(1).max(255),
  expectedValue: nonNegMoneyString,
  probability: percentString,
  expectedCloseDate: ymdDate,
  quotationId: id.nullish(),
});

const leadsRouter = router({
  list: crmReadProcedure
    .input(
      z
        .object({
          q: z.string().trim().max(200).optional(),
          status: z.enum(SALES_LEAD_STATUSES).optional(),
          ownerId: id.optional(),
          overdueOnly: z.boolean().optional(),
          limit: z.number().int().min(1).max(200).optional(),
          cursor: cursor.optional(),
        })
        .optional(),
    )
    .query(({ input, ctx }) => listSalesLeads(input ?? {}, scopeOf(ctx))),

  get: crmReadProcedure
    .input(z.object({ leadId: id }))
    .query(({ input, ctx }) => getSalesLeadDetail(input.leadId, scopeOf(ctx))),

  create: crmWriteProcedure
    .input(leadCreateInput)
    .mutation(async ({ input, ctx }) => {
      const result = await createSalesLead(input, actorOf(ctx));
      if (!result.replayed) {
        await logAudit(ctx, {
          action: "salesPipeline.leadCreate",
          entityType: "salesLead",
          entityId: result.leadId,
          newValue: {
            leadNumber: result.leadNumber,
            source: input.source,
            ownerId: input.ownerId ?? ctx.user.id,
          },
        });
      }
      return result;
    }),

  update: crmWriteProcedure
    .input(
      z.object({
        leadId: id,
        expectedVersion: z.number().int().positive(),
        requestKey,
        reason,
        source: z.enum(SALES_LEAD_SOURCES).optional(),
        contactName: z.string().trim().min(1).max(255).optional(),
        companyName: nullableText(255),
        phone: nullableText(20),
        email: z.string().trim().email().max(320).nullable().optional(),
        customerId: id.nullable().optional(),
        ownerId: id.optional(),
        nextFollowUpAt: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const result = await updateSalesLead(input, actorOf(ctx));
      if (!result.replayed) {
        await logAudit(ctx, {
          action: "salesPipeline.leadUpdate",
          entityType: "salesLead",
          entityId: input.leadId,
          newValue: { version: result.version, reason: input.reason },
        });
      }
      return result;
    }),

  transition: crmWriteProcedure
    .input(
      z.object({
        leadId: id,
        expectedVersion: z.number().int().positive(),
        requestKey,
        toStatus: z.enum(SALES_LEAD_STATUSES),
        reason,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const result = await transitionSalesLead(input, actorOf(ctx));
      if (!result.replayed) {
        await logAudit(ctx, {
          action: "salesPipeline.leadTransition",
          entityType: "salesLead",
          entityId: input.leadId,
          newValue: {
            toStatus: input.toStatus,
            version: result.version,
            reason: input.reason,
          },
        });
      }
      return result;
    }),

  convert: crmWriteProcedure
    .input(
      opportunityDraft.omit({ branchId: true, customerId: true }).extend({
        leadId: id,
        expectedVersion: z.number().int().positive(),
        customerId: id.nullish(),
        requestKey,
        reason,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const result = await convertLeadToOpportunity(input, actorOf(ctx));
      if (!result.replayed) {
        await logAudit(ctx, {
          action: "salesPipeline.leadConvert",
          entityType: "salesLead",
          entityId: input.leadId,
          newValue: {
            opportunityId: result.opportunityId,
            reason: input.reason,
          },
        });
      }
      return result;
    }),
});

const opportunitiesRouter = router({
  list: crmReadProcedure
    .input(
      z
        .object({
          q: z.string().trim().max(200).optional(),
          stage: z.enum(SALES_OPPORTUNITY_STAGES).optional(),
          ownerId: id.optional(),
          overdueOnly: z.boolean().optional(),
          limit: z.number().int().min(1).max(200).optional(),
          cursor: cursor.optional(),
        })
        .optional(),
    )
    .query(({ input, ctx }) =>
      listSalesOpportunities(input ?? {}, scopeOf(ctx)),
    ),

  get: crmReadProcedure
    .input(z.object({ opportunityId: id }))
    .query(({ input, ctx }) =>
      getSalesOpportunityDetail(input.opportunityId, scopeOf(ctx)),
    ),

  create: crmWriteProcedure
    .input(opportunityDraft.extend({ clientRequestId: requestKey }))
    .mutation(async ({ input, ctx }) => {
      const result = await createSalesOpportunity(input, actorOf(ctx));
      if (!result.replayed) {
        await logAudit(ctx, {
          action: "salesPipeline.opportunityCreate",
          entityType: "salesOpportunity",
          entityId: result.opportunityId,
          newValue: {
            opportunityNumber: result.opportunityNumber,
            customerId: input.customerId,
          },
        });
      }
      return result;
    }),

  update: crmWriteProcedure
    .input(
      z.object({
        opportunityId: id,
        expectedVersion: z.number().int().positive(),
        requestKey,
        reason,
        customerId: id.nullable().optional(),
        ownerId: id.optional(),
        title: z.string().trim().min(1).max(255).optional(),
        expectedValue: nonNegMoneyString.optional(),
        probability: percentString.optional(),
        expectedCloseDate: ymdDate.optional(),
        quotationId: id.nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const result = await updateSalesOpportunity(input, actorOf(ctx));
      if (!result.replayed) {
        await logAudit(ctx, {
          action: "salesPipeline.opportunityUpdate",
          entityType: "salesOpportunity",
          entityId: input.opportunityId,
          newValue: { version: result.version, reason: input.reason },
        });
      }
      return result;
    }),

  transition: crmWriteProcedure
    .input(
      z.object({
        opportunityId: id,
        expectedVersion: z.number().int().positive(),
        requestKey,
        toStage: z.enum(SALES_OPPORTUNITY_STAGES),
        reason,
        invoiceId: id.nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const result = await transitionSalesOpportunity(input, actorOf(ctx));
      if (!result.replayed) {
        await logAudit(ctx, {
          action: "salesPipeline.opportunityTransition",
          entityType: "salesOpportunity",
          entityId: input.opportunityId,
          newValue: {
            toStage: input.toStage,
            invoiceId: input.invoiceId ?? null,
            reason: input.reason,
          },
        });
      }
      return result;
    }),
});

export const salesPipelineRouter = router({
  dashboard: crmReadProcedure.query(({ ctx }) =>
    getSalesPipelineDashboard(scopeOf(ctx)),
  ),
  options: crmReadProcedure
    .input(z.object({ branchId: id.nullish() }).optional())
    .query(({ input, ctx }) =>
      getSalesPipelineOptions(input?.branchId, actorOf(ctx)),
    ),
  leads: leadsRouter,
  opportunities: opportunitiesRouter,
});
