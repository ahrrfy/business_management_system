import type {
  SalesLeadSource,
  SalesLeadStatus,
  SalesOpportunityStage,
} from "@shared/salesPipeline";

export type PipelineOwnerOption = {
  id: number;
  name: string | null;
  role: string;
};
export type PipelineCustomerOption = {
  id: number;
  name: string;
  phone: string | null;
};
export type PipelineBranchOption = { id: number; name: string };
export type PipelineQuotationOption = {
  id: number;
  quoteNumber: string;
  customerId: number | null;
  total: string;
  status: string;
};
export type PipelineInvoiceOption = {
  id: number;
  invoiceNumber: string;
  customerId: number | null;
  total: string;
  status: string;
};

export type PipelineOptions = {
  selectedBranchId: number | null;
  branches: PipelineBranchOption[];
  owners: PipelineOwnerOption[];
  customers: PipelineCustomerOption[];
  quotations: PipelineQuotationOption[];
  invoices: PipelineInvoiceOption[];
};

export type LeadRow = {
  id: number;
  leadNumber: string;
  branchId: number;
  source: SalesLeadSource;
  contactName: string;
  companyName: string | null;
  phone: string | null;
  email: string | null;
  customerId: number | null;
  customerName: string | null;
  ownerId: number;
  ownerName: string | null;
  nextFollowUpAt: Date | string | null;
  status: SalesLeadStatus;
  lastReason: string | null;
  version: number;
};

export type OpportunityRow = {
  id: number;
  opportunityNumber: string;
  branchId: number;
  leadId: number | null;
  leadName: string | null;
  customerId: number | null;
  customerName: string | null;
  ownerId: number;
  ownerName: string | null;
  title: string;
  stage: SalesOpportunityStage;
  expectedValue: string;
  probability: string;
  expectedCloseDate: Date | string;
  quotationId: number | null;
  invoiceId: number | null;
  lastReason: string | null;
  version: number;
};

export type DashboardData = {
  leadCounts: Record<SalesLeadStatus, number>;
  opportunityCounts: Record<SalesOpportunityStage, number>;
  forecast: {
    openValue: string;
    weightedForecast: string;
    closingNext30Days: string;
  };
  overdueLeads: Array<{
    id: number;
    leadNumber: string;
    contactName: string;
    ownerId: number;
    nextFollowUpAt: Date | string | null;
  }>;
  overdueOpportunities: Array<{
    id: number;
    opportunityNumber: string;
    title: string;
    ownerId: number;
    expectedValue: string;
    expectedCloseDate: Date | string;
  }>;
};
