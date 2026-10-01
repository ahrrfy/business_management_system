import {
  isOpenLeadStatus,
  isOpenOpportunityStage,
  type SalesLeadStatus,
  type SalesOpportunityStage,
} from "@shared/salesPipeline";
import { fmtDate } from "@/lib/date";

export function pipelineDate(value: Date | string | null | undefined): string {
  return fmtDate(value);
}

export function isPastPipelineDate(
  value: Date | string | null | undefined,
): boolean {
  if (!value) return false;
  const date = value instanceof Date ? value : new Date(value);
  return !Number.isNaN(date.getTime()) && date.getTime() < Date.now();
}

export function isLeadOverdue(
  status: SalesLeadStatus,
  value: Date | string | null | undefined,
): boolean {
  return isOpenLeadStatus(status) && isPastPipelineDate(value);
}

export function isOpportunityOverdue(
  stage: SalesOpportunityStage,
  value: Date | string | null | undefined,
): boolean {
  return isOpenOpportunityStage(stage) && isPastPipelineDate(value);
}
