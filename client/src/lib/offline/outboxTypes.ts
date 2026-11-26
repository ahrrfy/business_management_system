import type { RecipeLineSelection } from "@shared/recipeVariantSelection";

export const OFFLINE_QUEUE_CAP_IQD = 5_000_000;
export const OFFLINE_CACHE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const OFFLINE_SHIFT_GRANT_TTL_MS = OFFLINE_CACHE_MAX_AGE_MS;
export const ENCRYPTED_SHIFT_GRANT_META_KEY = "encryptedShiftCaptureGrant";
export const LEGACY_DEVICE_CODE_META_KEY = "legacyDeviceCode";
export const PREFLIGHT_INTENTS_META_KEY = "preflightSaleIntentsV4";
export const PREFLIGHT_INTENT_IDB_KEY_PREFIX = "preflightIntentV4:";
export const PREFLIGHT_INTENT_LS_KEY_PREFIX = "alroya.preflightIntent.v4:";
export const PREFLIGHT_LOCK_IDB_KEY_PREFIX = "preflightLockV4:";
export const PREFLIGHT_LOCK_LS_KEY_PREFIX = "alroya.preflightLock.v4:";
export const PREFLIGHT_LIVE_LEASE_TTL_MS = 15_000;
export const PREFLIGHT_TOMBSTONE_RETENTION_MS = 72 * 60 * 60 * 1000;
export const OFFLINE_LOCAL_ONLY_STATUS_LABEL =
  "محفوظ على هذا الجهاز وبانتظار المزامنة";

export class OfflineCounterCorruptError extends Error {
  readonly code = "OFFLINE_COUNTER_CORRUPT";
  constructor(message: string) {
    super(message);
    this.name = "OfflineCounterCorruptError";
  }
}

export class OfflineIdentityTamperError extends Error {
  readonly code = "OFFLINE_OUTBOX_IDENTITY_TAMPERED";
  constructor(message: string) {
    super(message);
    this.name = "OfflineIdentityTamperError";
  }
}

export class PreflightCrossTabLockContentionError extends Error {
  readonly code = "PREFLIGHT_CROSS_TAB_LOCK_CONTENTION";
  constructor(message: string) {
    super(message);
    this.name = "PreflightCrossTabLockContentionError";
  }
}

export interface CaptureGrantCheckContext {
  branchId?: number | null;
  shiftId?: number | null;
  capturedByUserId?: number | null;
  enforceOfflinePermPolicy?: boolean;
}

export interface PreflightSaleIntentV4 {
  clientRequestId: string;
  tabId: number;
  branchId: number;
  shiftId: number;
  capturedByUserId: number;
  total: string;
  hadManagerApprovalAtSubmit: boolean;
  semanticPayloadSha256: string;
  saleInput: Record<string, unknown>;
  receiptContext?: Record<string, unknown> | null;
  ownerTabInstanceId?: string;
  liveLeaseUntilMs?: number | null;
  commercialPayloadUnavailable?: boolean;
  createdAtIso: string;
  updatedAtMs: number;
  revision: number;
  status: "IN_FLIGHT" | "UNCONFIRMED_SERVER_OUTCOME" | "CLEARED";
  clearedAtMs?: number | null;
  failureReason?: string | null;
}

export interface RecoverablePreflightIntentsResult {
  intents: PreflightSaleIntentV4[];
  foreignOwnerPendingCount: number;
  activeInOtherTabCount: number;
  earliestOtherTabLeaseExpiryMs?: number | null;
}

export interface PreUpgradeOutboxAuditReport {
  totalRows: number;
  unsentLegacyWithoutProofCount: number;
  unsentLegacyClientRequestIds: string[];
  unsentVerifiedV4Count: number;
  parkedCount: number;
  sentCount: number;
  safeForCleanUpgradeWithoutQuarantine: boolean;
}

export interface OfflineSaleLine {
  variantId: number;
  productUnitId: number;
  quantity: string;
  unitPriceOverride: string;
  discountPercent?: string;
  discountAmount?: string;
  promotionId?: number;
  promotionDiscount?: string;
  cashierDiscountAmount?: string;
  recipeSelections?: RecipeLineSelection[];
}

export interface OfflineSalePayload {
  branchId: number;
  shiftId: number;
  customerId?: number;
  priceTier?: "RETAIL" | "WHOLESALE" | "GOVERNMENT";
  lines: OfflineSaleLine[];
  invoiceDiscount?: string;
  payment: { amount: string; method: "CASH" };
  clientRequestId: string;
  cashRoundIQD?: boolean;
  notes?: string;
  salesRepId?: number;
  attribution?: { repId?: number | null; mode?: "DIRECT" | "SPLIT" | "POOL" };
}

export interface OfflinePrintSalePayload {
  branchId: number;
  shiftId: number;
  customerId?: number;
  contactName?: string;
  contactPhone?: string;
  priceTier?: "RETAIL" | "WHOLESALE" | "GOVERNMENT";
  lines: Array<{
    variantId: number;
    productUnitId: number;
    quantity: string;
    unitPriceOverride: string;
    recipeSelections?: RecipeLineSelection[];
  }>;
  invoiceDiscount?: string;
  payment: { amount: string; method: "CASH" };
  clientRequestId: string;
  cashRoundIQD?: boolean;
  notes?: string;
}

export interface OfflineReceptionPayload {
  branchId: number;
  shiftId: number;
  customerId?: number;
  contactName?: string;
  contactPhone?: string;
  priceTier?: "RETAIL" | "WHOLESALE" | "GOVERNMENT";
  paymentMethod: "CASH";
  paidAmount: string;
  regularSale?: {
    lines: OfflineSaleLine[];
    amount: string;
    invoiceDiscount?: string;
  } | null;
  printSale?: {
    lines: Array<{
      variantId: number;
      productUnitId: number;
      quantity: string;
      unitPriceOverride: string;
      recipeSelections?: RecipeLineSelection[];
    }>;
    amount: string;
    invoiceDiscount?: string;
  } | null;
  clientRequestId: string;
}

export interface OfflineReturnPayload {
  branchId: number;
  shiftId: number | null;
  invoiceId: number;
  lines: Array<{ invoiceItemId: number; baseQuantity: number }>;
  refund: { amount: string; method: "CASH"; shiftId?: number | null };
  restock: boolean;
  reason: string;
  clientRequestId: string;
}

export type OfflinePayload =
  | OfflineSalePayload
  | OfflinePrintSalePayload
  | OfflineReceptionPayload
  | OfflineReturnPayload;
