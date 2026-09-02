import {
  isOpenLeadStatus,
  isOpenOpportunityStage,
  type SalesLeadStatus,
  type SalesOpportunityStage,
} from "@shared/salesPipeline";

export function pipelineDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("ar-IQ-u-nu-latn");
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
