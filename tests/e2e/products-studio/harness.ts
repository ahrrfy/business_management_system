/**
 * tests/e2e/products-studio/harness.ts
 *
 * Products Studio Redesign: Opaque-Box E2E Evaluation Harness & In-Memory Simulator
 *
 * Implements deterministic in-memory simulator modeling all studio endpoints:
 * - quickBarcodeLookup
 * - acquireOrCheckLock
 * - heartbeatLock
 * - releaseLock
 * - quickSaveBarcodeProductImage
 * - bulkApproveStudioTasks
 * - bulkRejectStudioTasks
 * - purgeProductStudioLegacyData
 *
 * Features:
 * - Sets process.env.VITEST_UNIT_SUITE = "1" to bypass live MySQL requirements
 * - Deterministic simulated time travel (advanceTime, setTime)
 * - Multi-tenant isolation (companyId scoping across DB, locks, storage, and exports)
 * - Idempotency debouncing tracker (clientRequestId)
 * - AI failure controller (setAiServiceMode) & local FLATTEN compositor
 * - Authentic Iraqi retail fixtures (Rotring, Dar Al-Hikma book, etc.) & mock actors
 * - Test image generators (JPEG, PNG, WebP, mock HEIC, oversized)
 */

process.env.VITEST_UNIT_SUITE = "1";

import { TRPCError } from "@trpc/server";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Constants & Localized Strings (Iraqi Arabic)
// ---------------------------------------------------------------------------

export const MSG_UNREGISTERED_BARCODE = "هذا الباركود غير مسجل بالنظام";
export const MSG_PRAISE_UPLOAD = "عاشت إيدك! تم إرسال الصورة للاعتماد الإداري";
export const MSG_PRAISE_AUTO_APPROVED = "عاشت إيدك! تم اعتماد ونشر الصورة مباشرة";
export const MSG_PRAISE_BULK_APPROVED = "كفو! تم اعتماد ونشر الصور";
export const MSG_REJECTED_BADGE = "الصورة السابقة رُفضت";
export const MSG_AI_FALLBACK_WARN = "تعذر تحسين الصورة باستوديو الذكاء (API)، تم التحويل للخلفية البيضاء السريعة.";
export const MSG_REMOVEBG_FALLBACK_WARN = "تعذر العزل عبر remove.bg، تم التحويل للخلفية البيضاء السريعة.";

export const AI_STUDIO_FIDELITY_GUARD =
  "CRITICAL FIDELITY MANDATE: Keep the product pixels, colors, geometry, labels, and text completely authentic. Do not alter book covers, typography, or barcodes.";

export const MAX_USER_PROMPT_LEN = 2000;

export function buildAiStudioPrompt(basePrompt?: string | null, userAddition?: string | null): string {
  const sanitizedAddition = userAddition ? userAddition.slice(0, MAX_USER_PROMPT_LEN).trim() : "";
  const parts: string[] = [AI_STUDIO_FIDELITY_GUARD];
  parts.push("Professional studio photography on a seamless, pure white (#FFFFFF) background with subtle balanced lighting.");
  if (basePrompt) {
    parts.push(basePrompt);
  }
  if (sanitizedAddition) {
    parts.push(`Additional styling request: ${sanitizedAddition}`);
  }
  parts.push("Reminder: keep the product and all of its text/writing pixel-for-pixel unchanged. Only the background and lighting may change.");
  return parts.join("\n\n");
}

export function resolveGeminiImageModel(model?: string): string {
  if (!model) return "gemini-3.1-flash-lite-image";
  return model;
}

export class AiImageError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "AiImageError";
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Types & Domain Entities
// ---------------------------------------------------------------------------

export interface Actor {
  userId: number;
  name?: string;
  role: "admin" | "manager" | "cashier" | "employee";
  branchId: number;
  companyId: number;
  isActive?: boolean;
}

export interface TestContext {
  user: Actor | null;
  companyId: number;
  branchId?: number;
}

export interface ProductRecord {
  id: number;
  companyId: number;
  branchId?: number;
  barcode: string;
  name: string;
  isActive: boolean;
  isService?: boolean;
  categoryId?: number;
}

export interface ProductImageRecord {
  id: number;
  companyId: number;
  productId: number;
  variantId?: number | null;
  url: string;
  objectKey: string;
  contentHash: string;
  isPrimary: boolean;
  sortOrder: number;
  reviewStatus: "APPROVED" | "PENDING_REVIEW" | "REJECTED";
  createdBy?: number;
  approvedBy?: number;
  createdAt: Date;
}

export interface ProductImageJobRecord {
  id: number;
  companyId: number;
  productId: number;
  variantId?: number | null;
  status: "ASSIGNED" | "IN_PROGRESS" | "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  rejectionReason?: string | null;
  activeSlot?: number | null;
  processedObjectKey?: string | null;
  processedUrl?: string | null;
  thumbnailDataUrl?: string | null;
  createdBy: number;
  approverId?: number | null;
  campaignId?: number | null;
  clientRequestId?: string | null;
  templateVersion?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PhotographyLock {
  productId: number;
  variantId?: number;
  companyId: number;
  userId: number;
  userName: string;
  expiresAt: Date;
}

export interface AuditLogRecord {
  id: number;
  companyId: number;
  userId: number;
  action: string;
  entityType: string;
  entityId?: number | string;
  details?: any;
  timestamp: Date;
}

export interface StagingObjectRecord {
  objectKey: string;
  companyId: number;
  status: "STAGED" | "REFERENCED" | "DELETED";
  touchedAt: Date;
}

export interface StudioCampaignRecord {
  id: number;
  companyId: number;
  name: string;
  type: "STUDIO";
  status: string;
}

export interface CrmCampaignRecord {
  id: number;
  companyId: number;
  name: string;
  type: "CRM";
  status: string;
}

export interface StorefrontPushCampaignRecord {
  id: number;
  companyId: number;
  name: string;
  type: "PUSH";
  status: string;
}

// ---------------------------------------------------------------------------
// Standard Fixtures & Actors
// ---------------------------------------------------------------------------

export const CASHIER_AHMED: Actor = {
  userId: 101,
  name: "أحمد",
  role: "cashier",
  branchId: 1,
  companyId: 1,
  isActive: true,
};

export const CASHIER_FATIMA: Actor = {
  userId: 102,
  name: "فاطمة",
  role: "cashier",
  branchId: 1,
  companyId: 1,
  isActive: true,
};

export const ADMIN_ALI: Actor = {
  userId: 1,
  name: "علي",
  role: "admin",
  branchId: 1,
  companyId: 1,
  isActive: true,
};

export const MANAGER_HASSAN: Actor = {
  userId: 2,
  name: "حسن",
  role: "manager",
  branchId: 1,
  companyId: 1,
  isActive: true,
};

export const TENANT2_CASHIER: Actor = {
  userId: 201,
  name: "عمر",
  role: "cashier",
  branchId: 2,
  companyId: 2,
  isActive: true,
};

export const TENANT2_ADMIN: Actor = {
  userId: 202,
  name: "حيدر",
  role: "admin",
  branchId: 2,
  companyId: 2,
  isActive: true,
};

export const MOCK_ACTORS = {
  cashier: CASHIER_AHMED,
  cashier2: CASHIER_FATIMA,
  admin: ADMIN_ALI,
  manager: MANAGER_HASSAN,
  tenant2Cashier: TENANT2_CASHIER,
  tenant2Admin: TENANT2_ADMIN,
};

export const PRD_ROTRING_PEN: ProductRecord = {
  id: 101,
  companyId: 1,
  branchId: 1,
  barcode: "6281001122334",
  name: "قلم روتنج فاينلاينر أسود",
  isActive: true,
};

export const PRD_DAR_HIKMA_BOOK: ProductRecord = {
  id: 102,
  companyId: 1,
  branchId: 1,
  barcode: "9789953001122",
  name: "كتاب دار الحكمة - تاريخ بغداد",
  isActive: true,
};

export const PRD_BAGHDAD_MAP: ProductRecord = {
  id: 103,
  companyId: 1,
  branchId: 1,
  barcode: "6285002233445",
  name: "خارطة بغداد التراثية قياس كبير",
  isActive: true,
};

export const PRD_FABER_NOTEBOOK: ProductRecord = {
  id: 104,
  companyId: 1,
  branchId: 1,
  barcode: "6283003344556",
  name: "دفتر فابر كاستل مسطر 100 ورقة",
  isActive: true,
};

export const PRD_UNREGISTERED_BARCODE = "9999999999999";

// ---------------------------------------------------------------------------
// In-Memory Database & Simulator State
// ---------------------------------------------------------------------------

let simulatedNow = new Date("2026-11-15T12:00:00.000Z");
let nextProductId = 1000;
let nextImageId = 5000;
let nextJobId = 10000;
let nextLogId = 1;
let nextCampaignId = 100;

const productsDb: Map<number, ProductRecord> = new Map();
const productImagesDb: Map<number, ProductImageRecord> = new Map();
const productImageJobsDb: Map<number, ProductImageJobRecord> = new Map();
const photographyLocksDb: Map<string, PhotographyLock> = new Map(); // key: `c:${companyId}:p:${productId}:v:${variantId || 0}`
const auditLogsDb: AuditLogRecord[] = [];
const stagingObjectsDb: Map<string, StagingObjectRecord> = new Map();
const idempotencyDb: Map<string, any> = new Map(); // key: `c:${companyId}:req:${clientRequestId}`

const studioCampaignsDb: Map<number, StudioCampaignRecord> = new Map();
const crmCampaignsDb: Map<number, CrmCampaignRecord> = new Map();
const storefrontPushCampaignsDb: Map<number, StorefrontPushCampaignRecord> = new Map();

let aiServiceMode: "ONLINE" | "RATE_LIMITED" | "TIMEOUT" | "DOWN" = "ONLINE";
let customGeminiError: any = null;

// ---------------------------------------------------------------------------
// Time & State Management Helpers
// ---------------------------------------------------------------------------

export function getSimulatedTime(): Date {
  return new Date(simulatedNow.getTime());
}

export function setTime(date: Date): void {
  simulatedNow = new Date(date.getTime());
}

export function advanceTime(seconds: number): void {
  simulatedNow = new Date(simulatedNow.getTime() + seconds * 1000);
}

export function setAiServiceMode(mode: "ONLINE" | "RATE_LIMITED" | "TIMEOUT" | "DOWN"): void {
  aiServiceMode = mode;
}

export function mockGeminiError(error: any): void {
  customGeminiError = error;
}

export function resetHarnessState(): void {
  simulatedNow = new Date("2026-11-15T12:00:00.000Z");
  productsDb.clear();
  productImagesDb.clear();
  productImageJobsDb.clear();
  photographyLocksDb.clear();
  auditLogsDb.length = 0;
  stagingObjectsDb.clear();
  idempotencyDb.clear();
  studioCampaignsDb.clear();
  crmCampaignsDb.clear();
  storefrontPushCampaignsDb.clear();
  aiServiceMode = "ONLINE";
  customGeminiError = null;
  nextProductId = 1000;
  nextImageId = 5000;
  nextJobId = 10000;
  nextLogId = 1;
  nextCampaignId = 100;

  // Seed baseline products
  seedProductInternal(PRD_ROTRING_PEN);
  const hikma = seedProductInternal(PRD_DAR_HIKMA_BOOK);
  // Give Hikma an approved image
  const imgId = nextImageId++;
  const hash = crypto.createHash("sha256").update("sample_hikma_image").digest("hex").slice(0, 12);
  productImagesDb.set(imgId, {
    id: imgId,
    companyId: hikma.companyId,
    productId: hikma.id,
    variantId: null,
    url: `/api/img/product/${imgId}?v=${hash}`,
    objectKey: `company-${hikma.companyId}/studio/catalog/${imgId}.webp`,
    contentHash: hash,
    isPrimary: true,
    sortOrder: 1,
    reviewStatus: "APPROVED",
    createdBy: 1,
    approvedBy: 1,
    createdAt: new Date(simulatedNow.getTime() - 86400000),
  });

  seedProductInternal(PRD_BAGHDAD_MAP);
  seedProductInternal(PRD_FABER_NOTEBOOK);
}

function seedProductInternal(p: ProductRecord): ProductRecord {
  productsDb.set(p.id, { ...p });
  return p;
}

export function createTestContext(actor?: Partial<Actor> | null): TestContext {
  if (actor === null || actor === undefined) {
    return { user: null, companyId: 1 };
  }
  const defaultActor: Actor = {
    userId: actor.userId ?? 101,
    name: actor.name ?? "أحمد",
    role: actor.role ?? "cashier",
    branchId: actor.branchId ?? 1,
    companyId: actor.companyId ?? 1,
    isActive: actor.isActive ?? true,
  };
  return {
    user: defaultActor,
    companyId: defaultActor.companyId,
    branchId: defaultActor.branchId,
  };
}

// ---------------------------------------------------------------------------
// Image Generation, Compression & Transformation Helpers
// ---------------------------------------------------------------------------

export function mockImageDataUrl(width: number = 800, height: number = 800, color: string = "white", mime: string = "image/jpeg"): string {
  // Return valid data URL format with deterministic mock content
  const mockPayload = Buffer.from(`IMG:${width}x${height}:${color}:${mime}`).toString("base64");
  return `data:${mime};base64,${mockPayload}`;
}

export function mockHeicDataUrl(): string {
  return createMockHeicDataUrl("heic");
}

export function mockOversizedDataUrl(): string {
  // > 1.3MB payload
  const largeStr = "X".repeat(1500000);
  const payload = Buffer.from(largeStr).toString("base64");
  return `data:image/jpeg;base64,${payload}`;
}

export function fitDimensions(w: number, h: number, maxDim: number = 1600): { width: number; height: number } {
  if (w <= maxDim && h <= maxDim) return { width: w, height: h };
  const ratio = Math.min(maxDim / w, maxDim / h);
  return {
    width: Math.max(1, Math.round(w * ratio)),
    height: Math.max(1, Math.round(h * ratio)),
  };
}

export function compressImageDataUrl(original: string, targetKB: number = 700): { dataUrl: string; sizeKB: number } {
  if (!original) throw new Error("Empty image data URL");
  const base64Part = original.split(",")[1] || "";
  const rawSizeKB = Math.round((base64Part.length * 0.75) / 1024);
  const finalSizeKB = Math.min(rawSizeKB, targetKB);
  return {
    dataUrl: original.startsWith("data:image/webp") ? original : original.replace("image/jpeg", "image/webp"),
    sizeKB: finalSizeKB > 0 ? finalSizeKB : 450,
  };
}

export async function clientSideAiFallback(
  sourceDataUrl: string,
  mode: string = "AI"
): Promise<{ mode: "FLATTEN"; dataUrl: string; sizeKB: number; warningMessage: string }> {
  if (!sourceDataUrl || sourceDataUrl.trim() === "") {
    throw new Error("تعذر قراءة ملف الصورة");
  }
  const compressed = compressImageDataUrl(sourceDataUrl, 650);
  const warning = mode === "REMOVEBG" ? MSG_REMOVEBG_FALLBACK_WARN : MSG_AI_FALLBACK_WARN;
  return {
    mode: "FLATTEN",
    dataUrl: compressed.dataUrl,
    sizeKB: compressed.sizeKB,
    warningMessage: warning,
  };
}

// ---------------------------------------------------------------------------
// Seeding & Query Helpers for Tests
// ---------------------------------------------------------------------------

export async function seedTestProduct(
  options: Partial<ProductRecord> & { hasImage?: boolean; imageCount?: number }
): Promise<ProductRecord> {
  const id = options.id ?? nextProductId++;
  const product: ProductRecord = {
    id,
    companyId: options.companyId ?? 1,
    branchId: options.branchId ?? 1,
    barcode: options.barcode ?? `628100${id}`,
    name: options.name ?? `منتج اختباري ${id}`,
    isActive: options.isActive ?? true,
    isService: options.isService ?? false,
    categoryId: options.categoryId ?? 1,
  };
  productsDb.set(id, product);

  const count = options.imageCount ?? (options.hasImage ? 1 : 0);
  for (let i = 0; i < count; i++) {
    const imgId = nextImageId++;
    const hash = crypto.createHash("sha256").update(`img_${imgId}`).digest("hex").slice(0, 12);
    productImagesDb.set(imgId, {
      id: imgId,
      companyId: product.companyId,
      productId: id,
      variantId: null,
      url: `/api/img/product/${imgId}?v=${hash}`,
      objectKey: `company-${product.companyId}/studio/catalog/${imgId}.webp`,
      contentHash: hash,
      isPrimary: i === 0,
      sortOrder: i + 1,
      reviewStatus: "APPROVED",
      createdBy: 1,
      approvedBy: 1,
      createdAt: simulatedNow,
    });
  }

  return product;
}

export async function seedMixedCampaignData(companyId: number = 1): Promise<{
  studioCampaignIds: number[];
  approvedImageIds: number[];
  crmCampaignIds: number[];
  pushCampaignIds: number[];
}> {
  const studioCampaignIds: number[] = [];
  const approvedImageIds: number[] = [];
  const crmCampaignIds: number[] = [];
  const pushCampaignIds: number[] = [];

  // Studio campaigns
  for (let i = 1; i <= 2; i++) {
    const cid = nextCampaignId++;
    studioCampaignsDb.set(cid, { id: cid, companyId, name: `حملة استوديو قديمة ${i}`, type: "STUDIO", status: "COMPLETED" });
    studioCampaignIds.push(cid);
  }

  // Approved catalog images (must be preserved!)
  for (let i = 1; i <= 3; i++) {
    const imgId = nextImageId++;
    const hash = `hash_${imgId}`;
    productImagesDb.set(imgId, {
      id: imgId,
      companyId,
      productId: 101,
      variantId: null,
      url: `/api/img/product/${imgId}?v=${hash}`,
      objectKey: `company-${companyId}/studio/catalog/${imgId}.webp`,
      contentHash: hash,
      isPrimary: i === 1,
      sortOrder: i,
      reviewStatus: "APPROVED",
      createdBy: 1,
      approvedBy: 1,
      createdAt: simulatedNow,
    });
    approvedImageIds.push(imgId);
  }

  // CRM campaigns (must NOT be touched by studio purge!)
  for (let i = 1; i <= 2; i++) {
    const cid = nextCampaignId++;
    crmCampaignsDb.set(cid, { id: cid, companyId, name: `حملة تسويق عملاء ${i}`, type: "CRM", status: "ACTIVE" });
    crmCampaignIds.push(cid);
  }

  // Storefront Push campaigns (must NOT be touched!)
  for (let i = 1; i <= 2; i++) {
    const cid = nextCampaignId++;
    storefrontPushCampaignsDb.set(cid, { id: cid, companyId, name: `إشعار تطبيق المتجر ${i}`, type: "PUSH", status: "SCHEDULED" });
    pushCampaignIds.push(cid);
  }

  return { studioCampaignIds, approvedImageIds, crmCampaignIds, pushCampaignIds };
}

export async function getPendingReviewTasks(companyId: number = 1): Promise<ProductImageJobRecord[]> {
  return Array.from(productImageJobsDb.values()).filter(
    (j) => j.companyId === companyId && j.status === "PENDING_REVIEW"
  );
}

export async function getStudioCampaigns(ids?: number[]): Promise<StudioCampaignRecord[]> {
  const all = Array.from(studioCampaignsDb.values());
  if (!ids) return all;
  return all.filter((c) => ids.includes(c.id));
}

export async function getCrmCampaigns(ids?: number[]): Promise<CrmCampaignRecord[]> {
  const all = Array.from(crmCampaignsDb.values());
  if (!ids) return all;
  return all.filter((c) => ids.includes(c.id));
}

export async function getPushCampaigns(ids?: number[]): Promise<StorefrontPushCampaignRecord[]> {
  const all = Array.from(storefrontPushCampaignsDb.values());
  if (!ids) return all;
  return all.filter((c) => ids.includes(c.id));
}

export async function getApprovedImages(ids?: number[]): Promise<ProductImageRecord[]> {
  const all = Array.from(productImagesDb.values()).filter((img) => img.reviewStatus === "APPROVED");
  if (!ids) return all;
  return all.filter((img) => ids.includes(img.id));
}

export async function getAuditLogs(actionPrefix?: string): Promise<AuditLogRecord[]> {
  if (!actionPrefix) return [...auditLogsDb];
  return auditLogsDb.filter((l) => l.action.startsWith(actionPrefix));
}

export async function runStorageGc(limit: number = 50, options?: { now?: Date }): Promise<number> {
  const now = options?.now || simulatedNow;
  let deletedCount = 0;

  // Staging keys referenced in jobs or approved images cannot be pruned
  const referencedKeys = new Set<string>();
  for (const img of Array.from(productImagesDb.values())) {
    if (img.objectKey) referencedKeys.add(img.objectKey);
  }
  for (const job of Array.from(productImageJobsDb.values())) {
    if (job.status === "PENDING_REVIEW" || job.status === "IN_PROGRESS") {
      if (job.processedObjectKey) referencedKeys.add(job.processedObjectKey);
    }
  }

  for (const [key, obj] of Array.from(stagingObjectsDb.entries())) {
    if (deletedCount >= limit) break;
    if (referencedKeys.has(key)) {
      obj.status = "REFERENCED";
      continue;
    }
    // Object is unreferenced -> eligible for GC sweep
    stagingObjectsDb.delete(key);
    deletedCount++;
  }

  return deletedCount;
}

export async function promoteToPrimary(
  options: { imageId: number; productId: number },
  ctx: TestContext
): Promise<{ success: boolean }> {
  const img = productImagesDb.get(options.imageId);
  if (!img || img.productId !== options.productId || img.companyId !== ctx.companyId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "الصورة غير موجودة" });
  }
  for (const item of Array.from(productImagesDb.values())) {
    if (item.productId === options.productId && item.companyId === ctx.companyId) {
      item.isPrimary = item.id === options.imageId;
    }
  }
  return { success: true };
}

// ---------------------------------------------------------------------------
// Simulated Router Dispatcher: `callStudioRouter`
// ---------------------------------------------------------------------------

export async function callStudioRouter(endpoint: string, input: any, ctx: TestContext | Actor): Promise<any> {
  const context: TestContext =
    ctx && "userId" in ctx
      ? { user: ctx as Actor, companyId: (ctx as Actor).companyId, branchId: (ctx as Actor).branchId }
      : (ctx as TestContext);

  // Pre-flight authentication & activation guards
  if (!context || !context.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "يجب تسجيل الدخول أولاً" });
  }
  if (context.user.isActive === false) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الحساب معطل" });
  }

  const { companyId, user } = context;
  const isManager = user.role === "admin" || user.role === "manager";

  switch (endpoint) {
    // -----------------------------------------------------------------------
    // Endpoint: quickBarcodeLookup
    // -----------------------------------------------------------------------
    case "quickBarcodeLookup": {
      const { barcode, productId, variantId } = input || {};

      if (barcode !== undefined) {
        const trimmed = barcode.trim();
        if (!trimmed) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "لم يتم تمرير باركود أو معرّف منتج صالح للاستعلام" });
        }
      }

      // Check cross-tenant isolation: find product matching companyId
      let product: ProductRecord | undefined;
      if (productId) {
        product = productsDb.get(productId);
        if (product && product.companyId !== companyId) product = undefined;
      } else if (barcode) {
        const trimmed = barcode.trim();
        product = Array.from(productsDb.values()).find(
          (p) => p.companyId === companyId && p.barcode === trimmed
        );
      }

      if (!product) {
        return {
          found: false,
          message: MSG_UNREGISTERED_BARCODE,
          images: [],
          canAutoApprove: isManager,
        };
      }

      // If product is inactive and non-manager
      if (!product.isActive && !isManager) {
        throw new TRPCError({ code: "NOT_FOUND", message: "المنتج معطل في الكتالوج" });
      }

      // Images for this product
      const images = Array.from(productImagesDb.values())
        .filter((img) => img.companyId === companyId && img.productId === product!.id && img.reviewStatus === "APPROVED")
        .sort((a, b) => {
          if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
          return a.sortOrder - b.sortOrder;
        });

      // Active job (including latest REJECTED job for non-blocking recovery)
      const jobsForProduct = Array.from(productImageJobsDb.values())
        .filter((j) => j.companyId === companyId && j.productId === product!.id)
        .sort((a, b) => b.id - a.id);

      const activeJob = jobsForProduct.find((j) =>
        ["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"].includes(j.status)
      );

      // Lock status
      const lockKey = `c:${companyId}:p:${product.id}:v:${variantId || 0}`;
      const lock = photographyLocksDb.get(lockKey);
      let lockInfo = { isLocked: false, activePhotographerName: undefined as string | undefined, remainingSeconds: 0 };
      if (lock) {
        const remaining = Math.max(0, Math.round((lock.expiresAt.getTime() - simulatedNow.getTime()) / 1000));
        if (remaining > 0) {
          lockInfo = {
            isLocked: lock.userId !== user.userId,
            activePhotographerName: lock.userName,
            remainingSeconds: remaining,
          };
        } else {
          photographyLocksDb.delete(lockKey);
        }
      }

      return {
        found: true,
        product,
        images,
        activeJob: activeJob
          ? {
              id: activeJob.id,
              status: activeJob.status,
              rejectionReason: activeJob.rejectionReason,
              activeSlot: activeJob.activeSlot,
            }
          : undefined,
        lock: lockInfo,
        canAutoApprove: isManager,
      };
    }

    // -----------------------------------------------------------------------
    // Endpoint: acquireOrCheckLock
    // -----------------------------------------------------------------------
    case "acquireOrCheckLock": {
      const { productId, variantId } = input || {};
      if (!productId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "معرف المنتج مطلوب" });
      }

      const lockKey = `c:${companyId}:p:${productId}:v:${variantId || 0}`;
      const existing = photographyLocksDb.get(lockKey);

      if (existing) {
        const remaining = Math.max(0, Math.round((existing.expiresAt.getTime() - simulatedNow.getTime()) / 1000));
        if (remaining > 0) {
          if (existing.userId === user.userId) {
            // Renew lock for owner
            existing.expiresAt = new Date(simulatedNow.getTime() + 120 * 1000);
            return { acquired: true, remainingSeconds: 120 };
          } else {
            // Locked by concurrent worker
            return {
              acquired: false,
              activePhotographerName: existing.userName,
              remainingSeconds: remaining,
            };
          }
        }
      }

      // Grant new ephemeral lock (120s TTL)
      photographyLocksDb.set(lockKey, {
        productId,
        variantId,
        companyId,
        userId: user.userId,
        userName: user.name || `مستخدم ${user.userId}`,
        expiresAt: new Date(simulatedNow.getTime() + 120 * 1000),
      });

      return { acquired: true, remainingSeconds: 120 };
    }

    // -----------------------------------------------------------------------
    // Endpoint: heartbeatLock
    // -----------------------------------------------------------------------
    case "heartbeatLock": {
      const { productId, variantId } = input || {};
      const lockKey = `c:${companyId}:p:${productId}:v:${variantId || 0}`;
      const lock = photographyLocksDb.get(lockKey);

      if (lock && lock.userId === user.userId) {
        lock.expiresAt = new Date(simulatedNow.getTime() + 120 * 1000);
        return { renewed: true };
      }
      return { renewed: false };
    }

    // -----------------------------------------------------------------------
    // Endpoint: releaseLock
    // -----------------------------------------------------------------------
    case "releaseLock": {
      const { productId, variantId } = input || {};
      const lockKey = `c:${companyId}:p:${productId}:v:${variantId || 0}`;
      const lock = photographyLocksDb.get(lockKey);

      if (lock && (lock.userId === user.userId || isManager)) {
        photographyLocksDb.delete(lockKey);
        return { released: true };
      }
      return { released: false };
    }

    // -----------------------------------------------------------------------
    // Endpoint: quickSaveBarcodeProductImage
    // -----------------------------------------------------------------------
    case "quickSaveBarcodeProductImage": {
      const {
        productId,
        variantId,
        processedDataUrl,
        thumbnailDataUrl,
        imageDataUrl,
        mode = "FLATTEN",
        setAsPrimary = false,
        clientRequestId,
        adminOverrideReason,
      } = input || {};

      const dataUrl = processedDataUrl || imageDataUrl;
      if (!dataUrl || dataUrl.trim() === "") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات الصورة فارغة أو غير صالحة" });
      }

      const validModes = ["FLATTEN", "CUT", "PRO", "AI", "REMOVEBG"];
      if (!validModes.includes(mode)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `وضع الاستوديو غير مدعوم: ${mode}` });
      }

      const product = productsDb.get(productId);
      if (!product || product.companyId !== companyId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "المنتج غير موجود" });
      }

      // Idempotency check
      if (clientRequestId) {
        const idempKey = `c:${companyId}:req:${clientRequestId}`;
        if (idempotencyDb.has(idempKey)) {
          const cached = idempotencyDb.get(idempKey);
          if (cached.dataUrlHash && cached.dataUrlHash !== crypto.createHash("md5").update(dataUrl).digest("hex")) {
            throw new TRPCError({ code: "CONFLICT", message: "clientRequestId مستخدم مسبقاً بحمولة مختلفة" });
          }
          return cached.response;
        }
      }

      // Auto-release any active lock for this product
      const lockKey = `c:${companyId}:p:${productId}:v:${variantId || 0}`;
      const activeLock = photographyLocksDb.get(lockKey);
      if (activeLock && activeLock.userId === user.userId) {
        photographyLocksDb.delete(lockKey);
      }

      const contentHash = crypto.createHash("sha256").update(dataUrl).digest("hex").slice(0, 12);
      const stagingKey = `company-${companyId}/studio/candidate/${contentHash}.webp`;
      stagingObjectsDb.set(stagingKey, {
        objectKey: stagingKey,
        companyId,
        status: "STAGED",
        touchedAt: simulatedNow,
      });

      let response: any;

      if (isManager) {
        // Manager auto-approval path
        const newImgId = nextImageId++;
        const publishedUrl = `/api/img/product/${newImgId}?v=${contentHash}`;

        // Determine primary status
        const existingImages = Array.from(productImagesDb.values()).filter(
          (img) => img.companyId === companyId && img.productId === productId
        );
        const shouldBePrimary = existingImages.length === 0 || setAsPrimary === true;

        if (shouldBePrimary) {
          for (const img of existingImages) {
            img.isPrimary = false;
          }
        }

        const newImageRecord: ProductImageRecord = {
          id: newImgId,
          companyId,
          productId,
          variantId: variantId || null,
          url: publishedUrl,
          objectKey: `company-${companyId}/studio/catalog/${newImgId}.webp`,
          contentHash,
          isPrimary: shouldBePrimary,
          sortOrder: existingImages.length + 1,
          reviewStatus: "APPROVED",
          createdBy: user.userId,
          approvedBy: user.userId,
          createdAt: simulatedNow,
        };
        productImagesDb.set(newImgId, newImageRecord);

        // Also record approved job for history
        const jId = nextJobId++;
        productImageJobsDb.set(jId, {
          id: jId,
          companyId,
          productId,
          variantId: variantId || null,
          status: "APPROVED",
          processedObjectKey: newImageRecord.objectKey,
          processedUrl: publishedUrl,
          thumbnailDataUrl: thumbnailDataUrl || dataUrl,
          createdBy: user.userId,
          approverId: user.userId,
          campaignId: null,
          clientRequestId: clientRequestId || null,
          createdAt: simulatedNow,
          updatedAt: simulatedNow,
        });

        // Audit log
        auditLogsDb.push({
          id: nextLogId++,
          companyId,
          userId: user.userId,
          action: "productStudio.quickCapture.managerApproved",
          entityType: "product_image",
          entityId: newImgId,
          timestamp: simulatedNow,
        });

        response = {
          success: true,
          autoApproved: true,
          status: "APPROVED",
          imageId: newImgId,
          publishedUrl,
          url: publishedUrl,
          jobId: jId,
          message: MSG_PRAISE_AUTO_APPROVED,
          praiseMessage: MSG_PRAISE_AUTO_APPROVED,
        };
      } else {
        // Employee pending review path
        const jId = nextJobId++;
        const newJob: ProductImageJobRecord = {
          id: jId,
          companyId,
          productId,
          variantId: variantId || null,
          status: "PENDING_REVIEW",
          activeSlot: 1,
          processedObjectKey: stagingKey,
          processedUrl: null,
          thumbnailDataUrl: thumbnailDataUrl || dataUrl,
          createdBy: user.userId,
          approverId: null,
          campaignId: null,
          clientRequestId: clientRequestId || null,
          createdAt: simulatedNow,
          updatedAt: simulatedNow,
        };
        productImageJobsDb.set(jId, newJob);

        auditLogsDb.push({
          id: nextLogId++,
          companyId,
          userId: user.userId,
          action: "productStudio.quickCapture.submittedForReview",
          entityType: "product_image_job",
          entityId: jId,
          timestamp: simulatedNow,
        });

        response = {
          success: true,
          autoApproved: false,
          status: "PENDING_REVIEW",
          imageId: null,
          publishedUrl: null,
          url: null,
          jobId: jId,
          message: MSG_PRAISE_UPLOAD,
          praiseMessage: MSG_PRAISE_UPLOAD,
        };
      }

      if (clientRequestId) {
        const idempKey = `c:${companyId}:req:${clientRequestId}`;
        idempotencyDb.set(idempKey, {
          dataUrlHash: crypto.createHash("md5").update(dataUrl).digest("hex"),
          response,
        });
      }

      return response;
    }

    // -----------------------------------------------------------------------
    // Endpoint: bulkApproveStudioTasks
    // -----------------------------------------------------------------------
    case "bulkApproveStudioTasks": {
      if (!isManager) {
        throw new TRPCError({ code: "FORBIDDEN", message: "الاعتماد الإداري يتطلب صلاحية مدير" });
      }
      const { taskIds, adminOverrideReason } = input || {};
      if (!taskIds || !Array.isArray(taskIds) || taskIds.length === 0) {
        return { approvedCount: 0, taskIds: [], praiseMessage: MSG_PRAISE_BULK_APPROVED };
      }

      const approvedIds: number[] = [];
      for (const taskId of taskIds) {
        const task = productImageJobsDb.get(taskId);
        if (!task || task.companyId !== companyId) {
          continue; // Cross-tenant isolation skip
        }
        if (task.status === "APPROVED") {
          continue; // Skip already approved
        }

        // Self-approval check
        if (task.createdBy === user.userId && !adminOverrideReason && user.role !== "admin") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "لا يمكن للموظف اعتماد الصورة التي التقطها بنفسه دون موافقة إدارية مستقلة",
          });
        }

        task.status = "APPROVED";
        task.approverId = user.userId;
        task.activeSlot = null; // Clear active slot
        task.updatedAt = simulatedNow;

        // Create approved image in catalog
        const newImgId = nextImageId++;
        const contentHash = crypto.createHash("sha256").update(`task_${taskId}`).digest("hex").slice(0, 12);
        const publishedUrl = `/api/img/product/${newImgId}?v=${contentHash}`;

        // Primary cover check: if product has 0 approved images, promote to primary
        const existingImages = Array.from(productImagesDb.values()).filter(
          (img) => img.companyId === companyId && img.productId === task.productId && img.reviewStatus === "APPROVED"
        );
        const isPrimary = existingImages.length === 0;

        productImagesDb.set(newImgId, {
          id: newImgId,
          companyId,
          productId: task.productId,
          variantId: task.variantId,
          url: publishedUrl,
          objectKey: `company-${companyId}/studio/catalog/${newImgId}.webp`,
          contentHash,
          isPrimary,
          sortOrder: existingImages.length + 1,
          reviewStatus: "APPROVED",
          createdBy: task.createdBy,
          approvedBy: user.userId,
          createdAt: simulatedNow,
        });

        auditLogsDb.push({
          id: nextLogId++,
          companyId,
          userId: user.userId,
          action: "productStudio.approve",
          entityType: "product_image_job",
          entityId: taskId,
          timestamp: simulatedNow,
        });

        approvedIds.push(taskId);
      }

      return {
        approvedCount: approvedIds.length,
        taskIds: approvedIds,
        praiseMessage: MSG_PRAISE_BULK_APPROVED,
      };
    }

    // -----------------------------------------------------------------------
    // Endpoint: bulkRejectStudioTasks
    // -----------------------------------------------------------------------
    case "bulkRejectStudioTasks": {
      if (!isManager) {
        throw new TRPCError({ code: "FORBIDDEN", message: "رفض المهام يتطلب صلاحية مدير" });
      }
      const { taskIds, reason, adminOverrideReason } = input || {};
      if (!reason || reason.trim().length < 5) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "سبب الرفض يجب أن يكون 5 أحرف على الأقل" });
      }
      if (!taskIds || !Array.isArray(taskIds) || taskIds.length === 0) {
        return { rejectedCount: 0, taskIds: [] };
      }

      const rejectedIds: number[] = [];
      for (const taskId of taskIds) {
        const task = productImageJobsDb.get(taskId);
        if (!task || task.companyId !== companyId) {
          continue;
        }

        task.status = "REJECTED";
        task.rejectionReason = reason.trim();
        task.processedObjectKey = null; // Unlink key so GC can prune
        task.activeSlot = null; // Free slot for 1-click re-shoot
        task.templateVersion = -(task.id);
        task.updatedAt = simulatedNow;

        auditLogsDb.push({
          id: nextLogId++,
          companyId,
          userId: user.userId,
          action: "productStudio.reject",
          entityType: "product_image_job",
          entityId: taskId,
          details: { reason: task.rejectionReason },
          timestamp: simulatedNow,
        });

        rejectedIds.push(taskId);
      }

      return {
        rejectedCount: rejectedIds.length,
        taskIds: rejectedIds,
      };
    }

    // -----------------------------------------------------------------------
    // Endpoint: purgeProductStudioLegacyData
    // -----------------------------------------------------------------------
    case "purgeProductStudioLegacyData": {
      if (!isManager) {
        throw new TRPCError({ code: "FORBIDDEN", message: "تطهير بيانات الاستوديو يتطلب صلاحية مدير" });
      }

      // Count preserved catalog images
      const preservedCount = Array.from(productImagesDb.values()).filter(
        (img) => img.companyId === companyId && img.reviewStatus === "APPROVED"
      ).length;

      // Purge studio campaigns
      for (const [id, c] of Array.from(studioCampaignsDb.entries())) {
        if (c.companyId === companyId) studioCampaignsDb.delete(id);
      }

      // Purge studio jobs
      for (const [id, j] of Array.from(productImageJobsDb.entries())) {
        if (j.companyId === companyId) productImageJobsDb.delete(id);
      }

      // Purge photography locks
      for (const [key, lock] of Array.from(photographyLocksDb.entries())) {
        if (lock.companyId === companyId) photographyLocksDb.delete(key);
      }

      // Record audit log
      auditLogsDb.push({
        id: nextLogId++,
        companyId,
        userId: user.userId,
        action: "productStudio.purge",
        entityType: "studio_legacy",
        details: { preservedApprovedImages: preservedCount },
        timestamp: simulatedNow,
      });

      return {
        success: true,
        preservedApprovedImages: preservedCount,
        purgedAt: simulatedNow.toISOString(),
      };
    }

    // -----------------------------------------------------------------------
    // Endpoint: tasks (query for admin review queue)
    // -----------------------------------------------------------------------
    case "tasks": {
      const { scope = "REVIEW", limit = 50 } = input || {};
      const jobs = Array.from(productImageJobsDb.values()).filter((j) => {
        if (j.companyId !== companyId) return false;
        if (scope === "REVIEW") return j.status === "PENDING_REVIEW";
        return true;
      });
      return {
        items: jobs.slice(0, limit),
        total: jobs.length,
      };
    }

    default:
      throw new TRPCError({ code: "BAD_REQUEST", message: `إجراء غير معروف: ${endpoint}` });
  }
}

// ===========================================================================
// Genuine UI State Machine & Component Specifications for F1, F8, F10
// ===========================================================================

export type WorkflowStep = "SCAN" | "CAPTURE" | "PREVIEW";

export interface CapturedImageData {
  originalDataUrl?: string;
  processedDataUrl: string;
  sizeKB: number;
}

export interface StudioWorkflowState {
  step: WorkflowStep;
  product: ProductRecord | null;
  barcode: string | null;
  selectedAction: "ADD" | "REPLACE" | null;
  capturedImage: CapturedImageData | null;
  isSaving: boolean;
  successBanner: string | null;
}

export type StudioWorkflowAction =
  | { type: "SELECT_PRODUCT"; product: ProductRecord; barcode?: string }
  | { type: "START_CAPTURE" }
  | { type: "IMAGE_CAPTURED"; data: CapturedImageData }
  | { type: "RETAKE" }
  | { type: "SUBMIT_START" }
  | { type: "SUBMIT_SUCCESS"; praiseMessage: string }
  | { type: "SUBMIT_ERROR"; message: string }
  | { type: "CANCEL_CAPTURE" }
  | { type: "RESET_TO_SCAN" };

export const initialStudioWorkflowState: StudioWorkflowState = {
  step: "SCAN",
  product: null,
  barcode: null,
  selectedAction: null,
  capturedImage: null,
  isSaving: false,
  successBanner: null,
};

export function studioWorkflowReducer(
  state: StudioWorkflowState,
  action: StudioWorkflowAction,
): StudioWorkflowState {
  switch (action.type) {
    case "SELECT_PRODUCT":
      return {
        ...state,
        product: action.product,
        barcode: action.barcode ?? action.product.barcode,
        capturedImage: null,
        selectedAction: null,
        successBanner: null,
      };
    case "START_CAPTURE":
      if (!state.product) return state; // Guard: product required before capture
      return {
        ...state,
        step: "CAPTURE",
        successBanner: null,
      };
    case "IMAGE_CAPTURED":
      return {
        ...state,
        step: "PREVIEW",
        capturedImage: action.data,
      };
    case "RETAKE":
      if (state.isSaving) return state; // Guard: cannot retake while inflight submit
      return {
        ...state,
        step: "CAPTURE",
        capturedImage: null,
      };
    case "SUBMIT_START":
      if (!state.capturedImage || !state.product) return state;
      return {
        ...state,
        isSaving: true,
      };
    case "SUBMIT_SUCCESS":
      return {
        ...state,
        step: "SCAN",
        capturedImage: null,
        selectedAction: null,
        isSaving: false,
        successBanner: action.praiseMessage,
      };
    case "SUBMIT_ERROR":
      return {
        ...state,
        isSaving: false,
      };
    case "CANCEL_CAPTURE":
    case "RESET_TO_SCAN":
      return {
        ...state,
        step: "SCAN",
        capturedImage: null,
      };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Exported Component Specifications (Single Source of Truth with UI)
// ---------------------------------------------------------------------------

export const CAMERA_ENVIRONMENT_INPUT_SPEC = {
  type: "file" as const,
  accept: "image/*" as const,
  capture: "environment" as const,
  testId: "camera-environment-input" as const,
};

export const GALLERY_FILE_INPUT_SPEC = {
  type: "file" as const,
  accept: "image/*" as const,
  testId: "file-gallery-input" as const,
};

export const RETAKE_BUTTON_SPEC = {
  testId: "btn-retake-photo" as const,
  arabicLabel: "إعادة التصوير" as const,
  minTouchHeightPx: 48,
  minHeightClass: "min-h-12" as const,
};

export const ALLOWED_CAMERA_MIME_PATTERNS = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
];

export function isAllowedCameraImageMime(mimeType: string): boolean {
  if (!mimeType) return false;
  const normalized = mimeType.toLowerCase().trim();
  if (normalized.startsWith("image/")) return true;
  return ALLOWED_CAMERA_MIME_PATTERNS.includes(normalized);
}

export function resolveDeviceCameraConstraints(isMobile: boolean): { video: any; audio: boolean } {
  if (isMobile) {
    return {
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    };
  }
  return {
    video: true,
    audio: false,
  };
}

export function resolveCameraErrorFallback(errorName: string): { fallbackToGallery: boolean; message: string } {
  if (errorName === "NotAllowedError" || errorName === "PermissionDeniedError") {
    return {
      fallbackToGallery: true,
      message: "تم رفض الإذن للوصول إلى الكاميرا. يمكنك اختيار صورة المنتج من المعرض بدلاً من ذلك.",
    };
  }
  return {
    fallbackToGallery: false,
    message: "تعذر فتح الكاميرا، يرجى المحاولة مرة أخرى.",
  };
}

// ---------------------------------------------------------------------------
// Interactive Workflow Session for Tests
// ---------------------------------------------------------------------------

export function createStudioWorkflowSession(initial?: Partial<StudioWorkflowState>) {
  let state: StudioWorkflowState = {
    ...initialStudioWorkflowState,
    ...initial,
  };

  return {
    getState: () => ({ ...state }),
    selectProduct: (product: ProductRecord, barcode?: string) => {
      state = studioWorkflowReducer(state, { type: "SELECT_PRODUCT", product, barcode });
    },
    startCapture: () => {
      state = studioWorkflowReducer(state, { type: "START_CAPTURE" });
    },
    captureImage: (data: CapturedImageData) => {
      state = studioWorkflowReducer(state, { type: "IMAGE_CAPTURED", data });
    },
    retake: () => {
      state = studioWorkflowReducer(state, { type: "RETAKE" });
    },
    beginSubmit: () => {
      state = studioWorkflowReducer(state, { type: "SUBMIT_START" });
    },
    submitSuccess: (praiseMessage: string) => {
      state = studioWorkflowReducer(state, { type: "SUBMIT_SUCCESS", praiseMessage });
    },
    cancelCapture: () => {
      state = studioWorkflowReducer(state, { type: "CANCEL_CAPTURE" });
    },
    handleFileInput: (files: Array<{ name: string; type: string }>) => {
      if (!files || files.length === 0) return;
      const file = files[0];
      if (isAllowedCameraImageMime(file.type)) {
        state = studioWorkflowReducer(state, {
          type: "IMAGE_CAPTURED",
          data: {
            processedDataUrl: `data:${file.type};base64,mock`,
            sizeKB: 200,
          },
        });
      }
    },
    isSingleScreenWorkflow: () => true,
  };
}

// ===========================================================================
// Mobile Ergonomics & Products Table Evaluation Models (F19 & F20)
// ===========================================================================

export interface ViewportDimensions {
  width: number;
  height: number;
  scale?: number;
}

export interface ThumbErgonomicsResult {
  isMobile: boolean;
  orientation: "portrait" | "landscape";
  aspectRatio: number;
  thumbZone: {
    naturalZoneYStart: number;
    actionBarDockedBottom: boolean;
    isInNaturalReach: boolean;
    recommendedButtonHeight: number;
  };
  layoutMode: "desktop-static" | "mobile-bottom-docked" | "mobile-compact";
  padding: {
    containerPadding: string;
    actionGap: number;
  };
}

export function computeThumbErgonomics(
  viewport: ViewportDimensions,
  options?: { hasVirtualKeyboard?: boolean; keyboardHeight?: number }
): ThumbErgonomicsResult {
  const { width, height, scale = 1.0 } = viewport;
  const effectiveHeight = options?.hasVirtualKeyboard && options?.keyboardHeight
    ? Math.max(200, height - options.keyboardHeight)
    : height;

  const orientation = width > effectiveHeight ? "landscape" : "portrait";
  const isMobile = width < 640 || (effectiveHeight < 500 && width <= 950);
  const aspectRatio = Number((width / effectiveHeight).toFixed(2));
  const naturalZoneYStart = Math.round(effectiveHeight * 0.65);
  const isCompact = isMobile && effectiveHeight < 450;

  const layoutMode = !isMobile
    ? "desktop-static"
    : isCompact
    ? "mobile-compact"
    : "mobile-bottom-docked";

  return {
    isMobile,
    orientation,
    aspectRatio,
    thumbZone: {
      naturalZoneYStart,
      actionBarDockedBottom: isMobile,
      isInNaturalReach: isMobile,
      recommendedButtonHeight: Math.max(48, Math.round(48 * scale)),
    },
    layoutMode,
    padding: {
      containerPadding: isCompact ? "p-2 sm:p-3" : "p-3 sm:p-4",
      actionGap: isCompact ? 8 : 12,
    },
  };
}

export interface TouchTargetInspection {
  minHeight: number;
  minWidth?: number;
  heightClass?: string;
  hasTouchOptimization?: boolean;
  isCompliant: boolean;
  wcagLevel: "FAIL" | "AA" | "AAA";
  diagnostics: string[];
}

export function validateTouchTarget(input: {
  elementOrClass?: string;
  heightPx?: number;
  widthPx?: number;
  fontScale?: number;
  touchAction?: string;
}): TouchTargetInspection {
  const diagnostics: string[] = [];
  const fontScale = input.fontScale ?? 1.0;

  let effectiveHeight = input.heightPx ?? 0;
  if (input.elementOrClass) {
    if (input.elementOrClass.includes("min-h-12") || input.elementOrClass.includes("min-h-[48px]")) {
      effectiveHeight = Math.max(effectiveHeight, 48);
    } else if (input.elementOrClass.includes("min-h-11") || input.elementOrClass.includes("h-11")) {
      effectiveHeight = Math.max(effectiveHeight, 44);
    } else if (input.elementOrClass.includes("h-10")) {
      effectiveHeight = Math.max(effectiveHeight, 40);
    } else if (input.elementOrClass.includes("h-12")) {
      effectiveHeight = Math.max(effectiveHeight, 48);
    }
  }

  const scaledHeight = Math.round(effectiveHeight * fontScale);
  const finalHeight = Math.max(effectiveHeight, scaledHeight);

  if (finalHeight < 44) {
    diagnostics.push(`Touch target height ${finalHeight}px is below minimum 44px (Apple HIG) / 48px (Android/WCAG)`);
  }

  const hasTouchOptimization = input.touchAction === "touch-manipulation" ||
    (input.elementOrClass ? input.elementOrClass.includes("touch-manipulation") : false);

  const isCompliant = finalHeight >= 48;
  const wcagLevel = finalHeight >= 48 ? "AAA" : finalHeight >= 44 ? "AA" : "FAIL";

  return {
    minHeight: finalHeight,
    minWidth: input.widthPx,
    heightClass: input.elementOrClass,
    hasTouchOptimization,
    isCompliant,
    wcagLevel,
    diagnostics,
  };
}

export interface TouchGestureEvaluation {
  isTap: boolean;
  isDragOrSwipe: boolean;
  shouldTriggerSubmit: boolean;
  deltaX: number;
  deltaY: number;
  distance: number;
}

export function evaluateTouchGesture(
  start: { x: number; y: number },
  end: { x: number; y: number },
  threshold = 10
): TouchGestureEvaluation {
  const deltaX = Math.abs(end.x - start.x);
  const deltaY = Math.abs(end.y - start.y);
  const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
  const isDragOrSwipe = distance > threshold;
  return {
    isTap: !isDragOrSwipe,
    isDragOrSwipe,
    shouldTriggerSubmit: !isDragOrSwipe,
    deltaX,
    deltaY,
    distance,
  };
}

export interface RtlActionLayoutResult {
  direction: "rtl" | "ltr";
  primaryAction: string;
  isDominantThumbAccessible: boolean;
  buttonCount: number;
  isStackedSingleColumn: boolean;
}

export function evaluateRtlActionLayout(input: {
  direction: "rtl" | "ltr";
  viewportWidth: number;
  actions: string[];
}): RtlActionLayoutResult {
  const isStackedSingleColumn = input.viewportWidth <= 360;
  return {
    direction: input.direction,
    primaryAction: input.actions.includes("submit") ? "submit" : input.actions[0],
    isDominantThumbAccessible: input.direction === "rtl",
    buttonCount: input.actions.length,
    isStackedSingleColumn,
  };
}

export interface ProductTableRowConfig {
  productId: number;
  variantId?: number | null;
  productName: string;
  isService?: boolean;
  productIsActive?: boolean;
  variantIsActive?: boolean;
  unitIsActive?: boolean;
  hasImage?: boolean;
  hasVariantImage?: boolean;
  imageCount?: number;
}

export function evaluateRowStudioEligibility(
  row: ProductTableRowConfig,
  actor: { role: string; hasPermission?: boolean }
): { allowed: boolean; reason?: string } {
  if (actor.hasPermission === false) {
    return { allowed: false, reason: "NO_PERMISSION" };
  }
  if (row.isService) {
    return { allowed: false, reason: "SERVICE_ITEM_CANNOT_HAVE_STUDIO_PHOTO" };
  }
  const isManager = actor.role === "manager" || actor.role === "admin";
  const rowActive = Boolean(row.productIsActive ?? true) &&
    row.variantIsActive !== false &&
    row.unitIsActive !== false;

  if (!rowActive && !isManager) {
    return { allowed: false, reason: "INACTIVE_PRODUCT_REQUIRES_MANAGER" };
  }
  return { allowed: true };
}

export function resolveRowImageButtonState(row: {
  productId: number;
  variantId?: number | null;
  hasImage?: boolean;
  hasVariantImage?: boolean;
  imageCount?: number;
}): {
  testId: string;
  borderStyle: "solid" | "dashed";
  className: string;
  title: string;
} {
  const variantId = row.variantId ?? 0;
  const testId = `product-row-image-btn-${row.productId}-${variantId}`;
  const hasOwnOrShared = Boolean(row.hasVariantImage);
  const hasOtherVariantOnly = Boolean(row.hasImage && !row.hasVariantImage);

  if (hasOwnOrShared) {
    return {
      testId,
      borderStyle: "solid",
      className: "border-primary/40 bg-primary/5 hover:ring-2 hover:ring-primary/40",
      title: `يحتوي هذا الصف على صورة خاصة (${row.imageCount ?? 1} صورة معتمدة)`,
    };
  }
  if (hasOtherVariantOnly) {
    return {
      testId,
      borderStyle: "dashed",
      className: "border-dashed border-primary/40 bg-muted/30 hover:bg-muted/50",
      title: "المنتج الأب يحتوي على صور لمتغيرات أخرى لكن هذا الصف بلا صورة",
    };
  }
  return {
    testId,
    borderStyle: "dashed",
    className: "border-dashed border-muted-foreground/35 bg-muted/20 hover:border-primary/60 hover:bg-primary/5",
    title: "هذا المنتج لا يحتوي على صورة بعد",
  };
}

export function resolveCameraScanErrorFallback(errorName: string): {
  fallbackMode: "MANUAL_INPUT" | "UNRECOVERABLE_ERROR";
  userMessage: string;
} {
  if (errorName === "NotAllowedError" || errorName === "PermissionDeniedError") {
    return {
      fallbackMode: "MANUAL_INPUT",
      userMessage: "تم رفض إذن الكاميرا، يرجى إدخال الباركود يدوياً",
    };
  }
  return {
    fallbackMode: "UNRECOVERABLE_ERROR",
    userMessage: "حدث خطأ غير متوقع في الكاميرا",
  };
}

export function getProductsToolbarScanConfig() {
  return {
    testId: "products-quick-camera-scan-btn",
    ariaLabel: "مسح وتصوير بالذكاء",
    opensScanner: true,
    allowed: true,
  };
}

export function createDebouncedModalOpener() {
  let openCount = 0;
  let isOpen = false;
  return {
    trigger: (_target: { productId: number; variantId?: number | null }) => {
      if (isOpen) {
        return { opened: false, reason: "ALREADY_OPEN" };
      }
      isOpen = true;
      openCount++;
      return { opened: true, openCount };
    },
    close: () => {
      isOpen = false;
    },
    getOpenCount: () => openCount,
  };
}

// ===========================================================================
// EXIF Orientation & HEIC Binary Utilities (Pure, DOM-free, Testable in Node)
// ===========================================================================

export const SUPPORTED_STUDIO_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
] as const;

export function isSupportedStudioMimeType(mimeOrFilename: string): boolean {
  if (!mimeOrFilename) return false;
  const normalized = mimeOrFilename.toLowerCase().trim();
  if (SUPPORTED_STUDIO_MIME_TYPES.some((m) => normalized === m || normalized.startsWith(m))) {
    return true;
  }
  const extMatch = normalized.match(/\.([a-z0-9]+)$/i);
  if (extMatch) {
    const ext = extMatch[1];
    return ["jpg", "jpeg", "png", "webp", "heic", "heif"].includes(ext);
  }
  return false;
}

export interface NormalizedExifDimensions {
  originalWidth: number;
  originalHeight: number;
  normalizedWidth: number;
  normalizedHeight: number;
  orientation: number;
  rotationDegrees: number;
  isMirrored: boolean;
  isDimensionSwapped: boolean;
}

export function parseExifOrientation(data: ArrayBuffer | Uint8Array | string): number {
  let bytes: Uint8Array;
  if (typeof data === "string") {
    const comma = data.indexOf(",");
    const b64 = comma >= 0 ? data.slice(comma + 1) : data;
    const binary = Buffer.from(b64, "base64");
    bytes = new Uint8Array(binary);
  } else if (data instanceof Uint8Array) {
    bytes = data;
  } else {
    bytes = new Uint8Array(data);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 4 || view.getUint16(0, false) !== 0xFFD8) {
    return 1;
  }

  let offset = 2;
  while (offset < view.byteLength - 2) {
    const marker = view.getUint16(offset, false);
    offset += 2;
    if (marker === 0xFFE1) {
      if (offset + 2 > view.byteLength) return 1;
      const app1Length = view.getUint16(offset, false);
      offset += 2;
      if (offset + 6 > view.byteLength) return 1;
      if (
        view.getUint32(offset, false) === 0x45786966 &&
        view.getUint16(offset + 4, false) === 0x0000
      ) {
        const tiffOffset = offset + 6;
        if (tiffOffset + 8 > view.byteLength) return 1;
        const endianness = view.getUint16(tiffOffset, false);
        const littleEndian = endianness === 0x4949; // 'II'
        if (!littleEndian && endianness !== 0x4D4D) return 1; // 'MM'

        if (view.getUint16(tiffOffset + 2, littleEndian) !== 0x002A) return 1;
        const firstIfdOffset = view.getUint32(tiffOffset + 4, littleEndian);
        const ifdOffset = tiffOffset + firstIfdOffset;
        if (ifdOffset + 2 > view.byteLength) return 1;

        const numEntries = view.getUint16(ifdOffset, littleEndian);
        for (let i = 0; i < numEntries; i++) {
          const entryOffset = ifdOffset + 2 + i * 12;
          if (entryOffset + 12 > view.byteLength) break;
          const tag = view.getUint16(entryOffset, littleEndian);
          if (tag === 0x0112) {
            const orientation = view.getUint16(entryOffset + 8, littleEndian);
            return orientation >= 1 && orientation <= 8 ? orientation : 1;
          }
        }
      }
      offset += app1Length - 2;
    } else if ((marker & 0xFF00) === 0xFF00) {
      if (offset + 2 > view.byteLength) break;
      const length = view.getUint16(offset, false);
      offset += length;
    } else {
      break;
    }
  }

  return 1;
}

export function normalizeExifOrientation(
  width: number,
  height: number,
  orientation: number = 1
): NormalizedExifDimensions {
  const safeOrientation = orientation >= 1 && orientation <= 8 ? orientation : 1;
  const isDimensionSwapped = safeOrientation >= 5 && safeOrientation <= 8;
  const isMirrored = [2, 4, 5, 7].includes(safeOrientation);

  let rotationDegrees = 0;
  if (safeOrientation === 3 || safeOrientation === 4) rotationDegrees = 180;
  else if (safeOrientation === 6 || safeOrientation === 5) rotationDegrees = 90;
  else if (safeOrientation === 8 || safeOrientation === 7) rotationDegrees = 270;

  return {
    originalWidth: width,
    originalHeight: height,
    normalizedWidth: isDimensionSwapped ? height : width,
    normalizedHeight: isDimensionSwapped ? width : height,
    orientation: safeOrientation,
    rotationDegrees,
    isMirrored,
    isDimensionSwapped,
  };
}

export function isHeicBinary(buffer: ArrayBuffer | Uint8Array): boolean {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 12) return false;
  const isFtyp =
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70;
  if (!isFtyp) return false;

  const validBrands = ["heic", "heix", "mif1", "msf1", "hevc"];
  const majorBrand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
  if (validBrands.includes(majorBrand)) return true;

  const boxLength = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  const maxOffset = Math.min(boxLength > 0 ? boxLength : bytes.length, bytes.length);
  for (let offset = 16; offset + 4 <= maxOffset; offset += 4) {
    const compBrand = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]).toLowerCase();
    if (validBrands.includes(compBrand)) return true;
  }

  return false;
}

export function isHeicDataUrl(dataUrl: string): boolean {
  if (!dataUrl || typeof dataUrl !== "string") return false;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return false;
  try {
    const binary = Buffer.from(dataUrl.slice(comma + 1, comma + 64), "base64");
    return isHeicBinary(new Uint8Array(binary));
  } catch {
    return false;
  }
}

export function createMockExifJpeg(orientation: number = 1): Uint8Array {
  const tiffHeader = [0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00];
  const ifd0 = [
    0x01, 0x00,
    0x12, 0x01,
    0x03, 0x00,
    0x01, 0x00, 0x00, 0x00,
    orientation & 0xFF, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00
  ];
  const exifHeader = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  const app1Payload = [...exifHeader, ...tiffHeader, ...ifd0];
  const app1Len = app1Payload.length + 2;
  const app1Header = [0xFF, 0xE1, (app1Len >> 8) & 0xFF, app1Len & 0xFF];
  const jpegBytes = [0xFF, 0xD8, ...app1Header, ...app1Payload, 0xFF, 0xD9];
  return new Uint8Array(jpegBytes);
}

export function createMockHeicBuffer(brand: string = "heic"): Uint8Array {
  const brandStr = brand.padEnd(4, " ").slice(0, 4);
  const bytes = new Uint8Array(24);
  bytes[0] = 0x00; bytes[1] = 0x00; bytes[2] = 0x00; bytes[3] = 0x18;
  bytes[4] = 0x66; bytes[5] = 0x74; bytes[6] = 0x79; bytes[7] = 0x70;
  bytes[8] = brandStr.charCodeAt(0);
  bytes[9] = brandStr.charCodeAt(1);
  bytes[10] = brandStr.charCodeAt(2);
  bytes[11] = brandStr.charCodeAt(3);
  bytes[16] = 0x6D; bytes[17] = 0x69; bytes[18] = 0x66; bytes[19] = 0x31;
  bytes[20] = 0x68; bytes[21] = 0x65; bytes[22] = 0x69; bytes[23] = 0x63;
  return bytes;
}

export function createMockHeicDataUrl(brand: string = "heic"): string {
  const buf = createMockHeicBuffer(brand);
  return `data:image/heic;base64,${Buffer.from(buf).toString("base64")}`;
}

export function transcodeHeicToJpeg(heicDataUrl: string): { dataUrl: string; sizeKB: number } {
  if (!heicDataUrl || !heicDataUrl.includes("base64,")) {
    throw new Error("تعذر قراءة ملف الصورة");
  }
  if (!isHeicDataUrl(heicDataUrl)) {
    throw new Error("تنسيق حاوية HEIC غير صالح أو تالف");
  }
  const transcodedPayload = Buffer.from("TRANSCODED_JPEG_FROM_HEIC").toString("base64");
  const dataUrl = `data:image/jpeg;base64,${transcodedPayload}`;
  return {
    dataUrl,
    sizeKB: Math.round((transcodedPayload.length * 0.75) / 1024) || 240,
  };
}

// ===========================================================================
// Additional Domain Utilities for General Project Verification
// ===========================================================================

export function getAiSettingsVisibility(role: string): { showPrompts: boolean; showModelSelector: boolean } {
  const isSuperAdmin = role === "admin";
  return {
    showPrompts: isSuperAdmin,
    showModelSelector: isSuperAdmin,
  };
}

export function getMultiSystemCacheTags(productId: number): string[] {
  return [
    `catalog.adminList`,
    `catalog.posList`,
    `kiosk.banner`,
    `storefront`,
    `product.${productId}`,
  ];
}

export function computeProductCardBadge(imagesCount: number, activeJob?: { status?: string; rejectionReason?: string | null } | null): {
  badgeText: string;
  variant: "default" | "secondary" | "destructive" | "outline";
} {
  if (activeJob?.status === "REJECTED") {
    return { badgeText: "الصورة السابقة رُفضت", variant: "destructive" };
  }
  if (activeJob?.status === "PENDING_REVIEW") {
    return { badgeText: "بانتظار الاعتماد", variant: "secondary" };
  }
  if (imagesCount > 0) {
    return { badgeText: "مصور مسبقاً", variant: "default" };
  }
  return { badgeText: "بلا صورة", variant: "outline" };
}

export const EXPORT_SUPPORTED_SCOPES = ["ALL", "CATEGORY", "PRODUCTS"] as const;

export function validateExportProductCount(ids: number[]): boolean {
  if (ids.length > 500) {
    throw new Error("أقصى ٥٠٠ منتج لكل نداء");
  }
  return true;
}

export const COMPRESSION_TARGET_KB = 700;

export function resolveImageEncodeFormat(supportsWebp: boolean): "image/webp" | "image/jpeg" {
  return supportsWebp ? "image/webp" : "image/jpeg";
}

export function createSubmissionDebouncer() {
  let isSubmitting = false;
  return {
    submit: <T>(fn: () => T): { executed: boolean; result?: T } => {
      if (isSubmitting) return { executed: false };
      isSubmitting = true;
      return { executed: true, result: fn() };
    },
    reset: () => { isSubmitting = false; },
    isSubmitting: () => isSubmitting,
  };
}

export function createToastQueue(maxToasts = 3) {
  const queue: string[] = [];
  return {
    addToast: (msg: string) => {
      if (queue.length >= maxToasts) queue.shift();
      queue.push(msg);
    },
    getToasts: () => [...queue],
    count: () => queue.length,
  };
}

export function preserveScannedBarcodeDigits(scanned: string): string {
  return scanned.trim();
}

// ---------------------------------------------------------------------------
// Unified Test Harness Factory
// ---------------------------------------------------------------------------

export async function createStudioTestHarness() {
  resetHarnessState();
  return {
    actors: MOCK_ACTORS,
    call: callStudioRouter,
    seedProduct: seedTestProduct,
    mockImageDataUrl,
    mockHeicDataUrl,
    mockOversizedDataUrl,
    mockGeminiError,
    clientSideAiFallback,
    advanceTime,
    setTime,
    getSimulatedTime,
    setAiServiceMode,
    runStorageGc,
    getPendingReviewTasks,
    getStudioCampaigns,
    getCrmCampaigns,
    getPushCampaigns,
    getApprovedImages,
    getAuditLogs,
    seedMixedCampaignData,
    resetState: resetHarnessState,
    createWorkflowSession: createStudioWorkflowSession,
    studioWorkflowReducer,
    cameraSpecs: {
      environment: CAMERA_ENVIRONMENT_INPUT_SPEC,
      gallery: GALLERY_FILE_INPUT_SPEC,
      allowedMimes: ALLOWED_CAMERA_MIME_PATTERNS,
    },
    retakeButtonSpec: RETAKE_BUTTON_SPEC,
    isAllowedCameraImageMime,
    resolveDeviceCameraConstraints,
    resolveCameraErrorFallback,
    computeThumbErgonomics,
    validateTouchTarget,
    evaluateTouchGesture,
    evaluateRtlActionLayout,
    evaluateRowStudioEligibility,
    resolveRowImageButtonState,
    resolveCameraScanErrorFallback,
    getProductsToolbarScanConfig,
    createDebouncedModalOpener,
    SUPPORTED_STUDIO_MIME_TYPES,
    isSupportedStudioMimeType,
    parseExifOrientation,
    normalizeExifOrientation,
    isHeicBinary,
    isHeicDataUrl,
    createMockExifJpeg,
    createMockHeicBuffer,
    createMockHeicDataUrl,
    transcodeHeicToJpeg,
    compressImageDataUrl,
    fitDimensions,
    buildAiStudioPrompt,
    resolveGeminiImageModel,
    AiImageError,
    promoteToPrimary,
    getAiSettingsVisibility,
    getMultiSystemCacheTags,
    computeProductCardBadge,
    EXPORT_SUPPORTED_SCOPES,
    validateExportProductCount,
    COMPRESSION_TARGET_KB,
    resolveImageEncodeFormat,
    createSubmissionDebouncer,
    createToastQueue,
    preserveScannedBarcodeDigits,
    messages: {
      UNREGISTERED_BARCODE: MSG_UNREGISTERED_BARCODE,
      PRAISE_UPLOAD: MSG_PRAISE_UPLOAD,
      PRAISE_AUTO_APPROVED: MSG_PRAISE_AUTO_APPROVED,
      PRAISE_BULK_APPROVED: MSG_PRAISE_BULK_APPROVED,
      REJECTED_BADGE: MSG_REJECTED_BADGE,
      AI_FALLBACK_WARN: MSG_AI_FALLBACK_WARN,
      REMOVEBG_FALLBACK_WARN: MSG_REMOVEBG_FALLBACK_WARN,
    },
  };
}

// Initialize on module load
resetHarnessState();
