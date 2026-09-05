import type {
  SalesLeadSource,
  SalesLeadStatus,
  SalesOpportunityStage,
} from "@shared/salesPipeline";

export type PipelineReadScope = {
  scopedBranchId: number | null;
  scopedOwnerId: number | null;
};

export type PipelineCursor = { updatedAt: Date; id: number };

export type CreateLeadInput = {
  branchId?: number | null;
  source: SalesLeadSource;
  contactName: string;
  companyName?: string | null;
  phone?: string | null;
  email?: string | null;
  customerId?: number | null;
  ownerId?: number | null;
  nextFollowUpAt?: Date | null;
  clientRequestId: string;
};

export type UpdateLeadInput = {
  leadId: number;
  expectedVersion: number;
  requestKey: string;
  reason: string;
  source?: SalesLeadSource;
  contactName?: string;
  companyName?: string | null;
  phone?: string | null;
  email?: string | null;
  customerId?: number | null;
  ownerId?: number;
  nextFollowUpAt?: Date | null;
};

export type TransitionLeadInput = {
  leadId: number;
  expectedVersion: number;
  requestKey: string;
  toStatus: SalesLeadStatus;
  reason: string;
};

export type OpportunityDraft = {
  branchId?: number | null;
  customerId: number;
  ownerId?: number | null;
  title: string;
  expectedValue: string;
  probability: string;
  expectedCloseDate: string;
  quotationId?: number | null;
};

export type CreateOpportunityInput = OpportunityDraft & {
  clientRequestId: string;
};

export type ConvertLeadInput = Omit<
  OpportunityDraft,
  "branchId" | "customerId"
> & {
  leadId: number;
  expectedVersion: number;
  customerId?: number | null;
  requestKey: string;
  reason: string;
};

export type UpdateOpportunityInput = {
  opportunityId: number;
  expectedVersion: number;
  requestKey: string;
  reason: string;
  customerId?: number | null;
  ownerId?: number;
  title?: string;
  expectedValue?: string;
  probability?: string;
  expectedCloseDate?: string;
  quotationId?: number | null;
};

export type TransitionOpportunityInput = {
  opportunityId: number;
  expectedVersion: number;
  requestKey: string;
  toStage: SalesOpportunityStage;
  reason: string;
  invoiceId?: number | null;
};

export type LeadFilters = {
  q?: string;
  status?: SalesLeadStatus;
  ownerId?: number;
  overdueOnly?: boolean;
  limit?: number;
  cursor?: PipelineCursor;
};

export type OpportunityFilters = {
  q?: string;
  stage?: SalesOpportunityStage;
  ownerId?: number;
  overdueOnly?: boolean;
  limit?: number;
  cursor?: PipelineCursor;
};
