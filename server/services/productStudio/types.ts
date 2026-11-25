import type {
  productImageJobs,
  productStudioCampaigns,
} from "../../../drizzle/schema";
import type { ServiceOperationAuthority } from "../authorization/operationAuthority";

export const MAX_STUDIO_THUMBNAIL_BYTES = 128 * 1024;
export const MAX_STUDIO_THUMBNAIL_DIMENSION = 320;
export const MAX_PREVIEW_BYTES = 1_000_000;
export const UPLOAD_LEASE_MS = 2 * 60_000;
export const PROCESSING_AUTHORIZATION_MS = 2 * 60_000;
export const PROCESSING_PROOF_MS = 15 * 60_000;
export const STAGING_AUDIT_INTERVAL_MS = 24 * 60 * 60_000;
export const BACKLOG_BATCH_LIMIT = 500;
export const MAX_REQUIRED_IMAGES = 10;
export const MAX_CAMPAIGN_PRODUCTS = 5000;
export const DUE_REMINDER_SCAN_LIMIT = 500;
export const CYCLE_WINDOW_DAYS = 90;
export const CYCLE_SAMPLE_LIMIT = 500;

export interface ProductStudioActor {
  userId: number;
  branchId: number | null;
  role: string;
  isOwner?: boolean;
  name?: string;
  email?: string;
  operationAuthority?: ServiceOperationAuthority;
  managementAuthority?: ServiceOperationAuthority;
  scopedOwnerId?: number | null;
}

export type StudioStatus = typeof productImageJobs.$inferSelect.status;
export type StudioPriority = typeof productImageJobs.$inferSelect.priority;
export type StudioCampaignStatus =
  typeof productStudioCampaigns.$inferSelect.status;
