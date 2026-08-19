import { TRPCError } from "@trpc/server";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, like, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { auditLogs, categories, productImageObjectStaging, productImageJobs, productImages, productStudioCampaigns, productUnitBarcodes, productUnits, productVariants, products, users } from "../../drizzle/schema";
import type { PermissionMap } from "@shared/permissions";
import { hasModuleAccess } from "@shared/permissions";
import { ARABIC_FOLD_PAIRS, normalizeSearchText } from "@shared/searchNormalize";
import { foldDigitsSql } from "../lib/similarMatch";
import { escLike } from "../lib/sqlLike";
import { requireDb, withTx } from "./tx";
import { assertValidImageDataUrl, parseImageDimensions } from "../lib/imageValidation";
import { assertImageStoreOperationalConfiguration, contentHash, getImageStore, isImageStoreOperational, MAX_PUBLISHED_PRODUCT_IMAGE_BYTES, objectKeyFor, shortHash, studioObjectPrefix } from "../lib/imageStore";
import { logger } from "../logger";
import { getCurrentCompanyId } from "../tenancy/context";
import { isMultiTenantModeActive } from "../db";
import { resolveCompanyById } from "../tenancy/registry";
import { evaluateStagingRetention, loadR2GcDeletionAuthorization, resolveR2GcMode } from "../lib/imageStore/r2RetentionPolicy";
import { studioObjectRoot } from "../lib/imageStore/tenantNamespace";
import { utcDayStart, utcNextDayStart } from "./businessDay";
import { createAppNotification } from "./appNotificationService";

const MAX_STUDIO_THUMBNAIL_BYTES = 128 * 1024;
const MAX_STUDIO_THUMBNAIL_DIMENSION = 320;
const MAX_PREVIEW_BYTES = 1_000_000;
const UPLOAD_LEASE_MS = 2 * 60_000;
const PROCESSING_AUTHORIZATION_MS = 2 * 60_000;
const PROCESSING_PROOF_MS = 15 * 60_000;
const STAGING_AUDIT_INTERVAL_MS = 24 * 60 * 60_000;

export interface ProductStudioActor {
  userId: number;
  branchId: number | null;
  role: string;
  isOwner?: boolean;
}

type StudioStatus = typeof productImageJobs.$inferSelect.status;
export type StudioPriority = typeof productImageJobs.$inferSelect.priority;
export type StudioCampaignStatus = typeof productStudioCampaigns.$inferSelect.status;

function isManager(actor: ProductStudioActor): boolean {
  return actor.role === "admin" || actor.role === "manager" || actor.isOwner === true;
}

function canCrossBranches(actor: ProductStudioActor): boolean {
  return actor.role === "admin" || actor.isOwner === true;
}

function isAdminActor(actor: ProductStudioActor): boolean {
  return actor.role === "admin" || actor.isOwner === true;
}

function cleanAdminOverrideReason(reason: string | null | undefined): string | null {
  const clean = reason?.trim() ?? "";
  return clean.length >= 5 ? clean : null;
}

function productContentHash(value: { name: string; description: string | null }): string {
  return createHash("sha256")
    .update(JSON.stringify([value.name, value.description ?? null]))
    .digest("hex");
}

async function publishedImageUrl(imageId: number, hash: string): Promise<string> {
  if (!isMultiTenantModeActive()) return `/api/img/product/${imageId}?v=${shortHash(hash)}`;
  const companyId = getCurrentCompanyId();
  if (companyId == null)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "سياق الشركة مطلوب لنشر الصورة",
    });
  const company = await resolveCompanyById(companyId);
  if (!company)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "تعذّر تحديد رابط الشركة العام",
    });
  return `/api/img/company/${encodeURIComponent(company.code)}/product/${imageId}?v=${shortHash(hash)}`;
}

function auditValues(actor: ProductStudioActor, action: string, taskId: number, value: unknown) {
  return {
    userId: actor.userId,
    branchId: actor.branchId,
    action,
    entityType: "productImageJob",
    entityId: String(taskId),
    newValue: value,
  } as const;
}

function assertTaskAccess(actor: ProductStudioActor, task: { assignedTo: number | null; branchId: number | null }, managerOnly = false, auditorRead = false): void {
  if (canCrossBranches(actor)) return;
  if (actor.branchId == null || Number(task.branchId) !== Number(actor.branchId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "المهمة تتبع فرعاً آخر",
    });
  }
  if (actor.role === "manager") return;
  if (auditorRead && actor.role === "auditor") return;
  if (managerOnly || Number(task.assignedTo) !== actor.userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "هذه المهمة ليست مسندة إليك",
    });
  }
}

function processingAuthorizationHash(authorization: string, mode: "PRO" | "AI"): string {
  return contentHash(Buffer.from(`${mode}:${authorization}`, "utf8"));
}

function assertTaskWriteAccess(actor: ProductStudioActor, task: { assignedTo: number | null; branchId: number | null }, adminOverrideReason?: string | null): string | null {
  if (!canCrossBranches(actor) && (actor.branchId == null || Number(task.branchId) !== Number(actor.branchId))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "المهمة تتبع فرعاً آخر",
    });
  }
  if (Number(task.assignedTo) === actor.userId) return null;
  const reason = cleanAdminOverrideReason(adminOverrideReason);
  if (!isAdminActor(actor) || !reason) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: isAdminActor(actor) ? "يلزم سبب تصحيح إداري واضح للعمل نيابة عن مالك المهمة" : "لا يجوز للمدير تعديل مهمة عامل آخر",
    });
  }
  return reason;
}

function assertIndependentReviewer(actor: ProductStudioActor, task: { assignedTo: number | null; submittedBy: number | null }, adminOverrideReason?: string | null): string | null {
  const lastSubmitter = task.submittedBy ?? task.assignedTo;
  if (Number(task.assignedTo) !== actor.userId && Number(lastSubmitter) !== actor.userId) return null;
  const reason = cleanAdminOverrideReason(adminOverrideReason);
  if (!isAdminActor(actor) || !reason) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "يلزم مراجع مستقل عن منفذ المهمة",
    });
  }
  return reason;
}

type StudioTx = Parameters<Parameters<typeof withTx>[0]>[0];

async function recordAdminOverride(tx: StudioTx, actor: ProductStudioActor, taskId: number, action: string, reason: string | null, assignedTo: number | null): Promise<void> {
  if (!reason) return;
  await tx.insert(auditLogs).values(
    auditValues(actor, `productStudio.adminOverride.${action}`, taskId, {
      reason,
      assignedTo,
    }),
  );
}

function decodeStudioImage(dataUrl: string): {
  bytes: Buffer;
  mime: string;
  width: number | null;
  height: number | null;
  hash: string;
} {
  assertValidImageDataUrl(dataUrl, MAX_PUBLISHED_PRODUCT_IMAGE_BYTES, true);
  const comma = dataUrl.indexOf(",");
  const mime = dataUrl.slice(5, dataUrl.indexOf(";"));
  const bytes = Buffer.from(dataUrl.slice(comma + 1), "base64");
  const dims = parseImageDimensions(bytes, mime);
  const structurallyComplete = mime === "image/png" ? bytes.length >= 20 && bytes.readUInt32BE(bytes.length - 12) === 0 && bytes.toString("ascii", bytes.length - 8, bytes.length - 4) === "IEND" : mime === "image/jpeg" || mime === "image/jpg" ? bytes.length >= 4 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9 : mime === "image/webp" ? bytes.length >= 12 && bytes.readUInt32LE(4) + 8 === bytes.length : false;
  if (!dims || dims.width < 1 || dims.height < 1 || !structurallyComplete) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "تعذّر التحقق من أبعاد الصورة",
    });
  }
  return {
    bytes,
    mime,
    width: dims.width,
    height: dims.height,
    hash: contentHash(bytes),
  };
}

function fittedThumbnailDimensions(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_STUDIO_THUMBNAIL_DIMENSION / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * يفك base64 فعلياً ويتحقق من WebP/RIFF والأبعاد والحجم، ثم يربط أبعاد المصغرة بالمرشح.
 * لا نثق ببادئة MIME وحدها ولا نقبل SVG/GIF/PNG في شبكة العرض الاحتياطية.
 */
export function decodeStudioThumbnail(
  dataUrl: string,
  processed: { width: number | null; height: number | null },
): {
  dataUrl: string;
  bytes: Buffer;
  width: number;
  height: number;
  hash: string;
} {
  if (!dataUrl.startsWith("data:image/webp;base64,")) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مصغّرة العرض يجب أن تكون WebP",
    });
  }
  assertValidImageDataUrl(dataUrl, MAX_STUDIO_THUMBNAIL_BYTES, true, MAX_STUDIO_THUMBNAIL_DIMENSION);
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  const dimensions = parseImageDimensions(bytes, "image/webp");
  const fourcc = bytes.length >= 20 ? bytes.toString("ascii", 12, 16) : "";
  const chunkBytes = bytes.length >= 20 ? bytes.readUInt32LE(16) : -1;
  const completeSingleChunk = chunkBytes >= 0 && 20 + chunkBytes + (chunkBytes % 2) === bytes.length;
  const validFrameHeader = fourcc === "VP8 " ? bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a : fourcc === "VP8L" ? bytes.length >= 25 && bytes[20] === 0x2f : false;
  if (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length || !completeSingleChunk || !validFrameHeader || !dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > MAX_STUDIO_THUMBNAIL_DIMENSION || dimensions.height > MAX_STUDIO_THUMBNAIL_DIMENSION) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "بنية/إطار مصغّرة WebP غير مكتمل",
    });
  }
  if (!processed.width || !processed.height) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "تعذّر ربط المصغّرة بأبعاد المرشح",
    });
  }
  const expected = fittedThumbnailDimensions(processed.width, processed.height);
  if (dimensions.width !== expected.width || dimensions.height !== expected.height) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "أبعاد المصغّرة لا تطابق المرشح النهائي",
    });
  }
  return { dataUrl, bytes, ...dimensions, hash: contentHash(bytes) };
}

function assertStoragePolicy(): void {
  try {
    assertImageStoreOperationalConfiguration();
  } catch {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "عمليات الاستوديو متوقفة حتى تهيئة مخزن R2 الخاص",
    });
  }
}

async function lockTask(tx: Parameters<Parameters<typeof withTx>[0]>[0], taskId: number) {
  const task = (await tx.select().from(productImageJobs).where(eq(productImageJobs.id, taskId)).limit(1).for("update"))[0];
  if (!task)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "مهمة الاستوديو غير موجودة",
    });
  return task;
}

export type StudioProductSearchInput = {
  search?: string;
  cursor?: string | null;
  includeInactive?: boolean;
};

type StudioProductCursor = {
  q: string;
  rank: number;
  name: string;
  id: number;
  includeInactive: boolean;
};

const STUDIO_PRODUCT_PAGE_SIZE = 20;

function encodeStudioProductCursor(cursor: StudioProductCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function assertExpectedRevision(task: { revision: number }, expectedRevision?: number): void {
  if (expectedRevision !== undefined && task.revision !== expectedRevision) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "تغيّرت المهمة منذ فتحها؛ حدّثها قبل إعادة المحاولة",
    });
  }
}

function nextRevision(task: { revision: number }): number {
  return task.revision + 1;
}

function decodeStudioProductCursor(value: string, query: string, includeInactive: boolean): StudioProductCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<StudioProductCursor>;
    const { q, rank, name, id, includeInactive: cursorIncludeInactive } = parsed;
    if (typeof q !== "string" || q !== query || typeof rank !== "number" || !Number.isInteger(rank) || typeof name !== "string" || typeof id !== "number" || !Number.isSafeInteger(id) || typeof cursorIncludeInactive !== "boolean" || cursorIncludeInactive !== includeInactive) throw new Error("invalid cursor");
    if (id < 1) throw new Error("invalid cursor");
    return { q, rank, name, id, includeInactive: cursorIncludeInactive };
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مؤشر نتائج المنتجات غير صالح",
    });
  }
}

type StudioProductMatchKind = "BARCODE_PRIMARY" | "BARCODE_ALIAS" | "SKU" | "PRODUCT_ID" | "NAME_PREFIX" | "NAME_CONTAINS";

function normalizedStudioVariantNameSql() {
  let normalized = sql`lower(coalesce(${productVariants.variantName}, ''))`;
  normalized = sql`regexp_replace(${normalized}, '[ً-ٰٟ]', '')`;
  for (const [from, to] of ARABIC_FOLD_PAIRS) normalized = sql`replace(${normalized}, ${from}, ${to})`;
  return foldDigitsSql(normalized);
}

export async function listStudioProducts(actor: ProductStudioActor, input: StudioProductSearchInput = {}) {
  const db = requireDb();
  const q = normalizeSearchText(input.search ?? "").slice(0, 80);
  const showInactive = input.includeInactive === true && isManager(actor);
  const cursor = input.cursor ? decodeStudioProductCursor(input.cursor, q, showInactive) : null;
  const numericId = /^\d+$/.test(q) ? Number(q) : 0;
  const contains = `%${escLike(q)}%`;
  const prefix = `${escLike(q)}%`;
  const productName = sql<string>`coalesce(${products.searchNorm}, lower(${products.name}))`;
  const variantName = normalizedStudioVariantNameSql();
  const exactBarcode = q ? or(eq(productUnits.barcode, q), eq(productUnitBarcodes.barcode, q)) : undefined;
  const exactSku = q ? sql`lower(${productVariants.sku}) = ${q}` : undefined;
  const exactProductId = numericId > 0 ? eq(products.id, numericId) : undefined;
  const namePrefix = q ? or(like(productName, prefix), like(variantName, prefix)) : undefined;
  const nameContains = q ? or(like(productName, contains), like(variantName, contains)) : undefined;
  const matches = q ? or(exactBarcode, exactSku, exactProductId, nameContains) : undefined;
  const rank = sql<number>`min(case
    when ${exactBarcode ?? sql`false`} then 1
    when ${exactSku ?? sql`false`} or ${exactProductId ?? sql`false`} then 2
    when ${namePrefix ?? sql`false`} then 3
    else 4
  end)`;
  const baseWhere = and(showInactive ? undefined : eq(products.isActive, true), matches);
  const afterCursor = cursor ? sql`(${rank} > ${cursor.rank} or (${rank} = ${cursor.rank} and (${products.name} > ${cursor.name} or (${products.name} = ${cursor.name} and ${products.id} > ${cursor.id}))))` : undefined;
  const productsPage = await db
    .select({
      id: products.id,
      name: products.name,
      isActive: products.isActive,
      rank,
    })
    .from(products)
    .leftJoin(productVariants, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, eq(productUnits.variantId, productVariants.id))
    .leftJoin(productUnitBarcodes, eq(productUnitBarcodes.productUnitId, productUnits.id))
    .where(baseWhere)
    .groupBy(products.id, products.name, products.isActive)
    .having(afterCursor)
    .orderBy(asc(rank), asc(products.name), asc(products.id))
    .limit(STUDIO_PRODUCT_PAGE_SIZE + 1);
  const hasMore = productsPage.length > STUDIO_PRODUCT_PAGE_SIZE;
  const page = hasMore ? productsPage.slice(0, STUDIO_PRODUCT_PAGE_SIZE) : productsPage;
  if (!page.length) return { rows: [], nextCursor: null };

  const pageIds = page.map((row) => Number(row.id));
  const contexts = await db
    .select({
      productId: products.id,
      productName: products.name,
      isActive: products.isActive,
      variantId: productVariants.id,
      variantName: productVariants.variantName,
      sku: productVariants.sku,
      unitId: productUnits.id,
      unitName: productUnits.unitName,
      primaryBarcode: productUnits.barcode,
      aliasBarcode: productUnitBarcodes.barcode,
    })
    .from(products)
    .leftJoin(productVariants, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, eq(productUnits.variantId, productVariants.id))
    .leftJoin(productUnitBarcodes, eq(productUnitBarcodes.productUnitId, productUnits.id))
    .where(inArray(products.id, pageIds));

  const contextFor = (row: (typeof contexts)[number]) => {
    const productNorm = normalizeSearchText(row.productName);
    const variantNorm = normalizeSearchText(row.variantName ?? "");
    if (q && row.primaryBarcode === q) return { rank: 1, kind: "BARCODE_PRIMARY" as const, barcode: q };
    if (q && row.aliasBarcode === q) return { rank: 1, kind: "BARCODE_ALIAS" as const, barcode: q };
    if (q && normalizeSearchText(row.sku ?? "") === q) return { rank: 2, kind: "SKU" as const, barcode: null };
    if (q && numericId > 0 && Number(row.productId) === numericId) return { rank: 2, kind: "PRODUCT_ID" as const, barcode: null };
    if (q && (productNorm.startsWith(q) || variantNorm.startsWith(q))) return { rank: 3, kind: "NAME_PREFIX" as const, barcode: null };
    return { rank: 4, kind: "NAME_CONTAINS" as const, barcode: null };
  };
  const rows = page.map((product) => {
    const candidates = contexts
      .filter((context) => Number(context.productId) === Number(product.id))
      .map((context) => ({ context, match: contextFor(context) }))
      .sort((a, b) => a.match.rank - b.match.rank || Number(a.context.variantId ?? 0) - Number(b.context.variantId ?? 0) || Number(a.context.unitId ?? 0) - Number(b.context.unitId ?? 0));
    const selected = candidates[0];
    return {
      productId: Number(product.id),
      productName: product.name,
      isActive: Boolean(product.isActive),
      variantId: selected?.context.variantId == null ? null : Number(selected.context.variantId),
      variantName: selected?.context.variantName ?? null,
      unitId: selected?.context.unitId == null ? null : Number(selected.context.unitId),
      unitName: selected?.context.unitName ?? null,
      matchKind: selected?.match.kind ?? ("NAME_CONTAINS" as StudioProductMatchKind),
      matchedBarcode: selected?.match.barcode ?? null,
    };
  });
  const last = page[page.length - 1];
  return {
    rows,
    nextCursor:
      hasMore && last
        ? encodeStudioProductCursor({
            q,
            rank: Number(last.rank),
            name: last.name,
            id: Number(last.id),
            includeInactive: showInactive,
          })
        : null,
  };
}

export async function resolveStudioBarcode(actor: ProductStudioActor, barcode: string) {
  const result = await listStudioProducts(actor, {
    search: barcode,
    includeInactive: isManager(actor),
  });
  const match = result.rows.find((row) => row.matchKind === "BARCODE_PRIMARY" || row.matchKind === "BARCODE_ALIAS");
  if (!match) throw new TRPCError({ code: "NOT_FOUND", message: "الباركود غير معروف" });
  return {
    productId: match.productId,
    productName: match.productName,
    variantId: match.variantId,
    variantName: match.variantName,
    unitId: match.unitId,
    unitName: match.unitName,
    isActive: match.isActive,
    matchKind: match.matchKind,
  };
}

export async function listStudioAssignees(actor: ProductStudioActor) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const rows = await requireDb()
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      branchId: users.branchId,
      permissionsOverride: users.permissionsOverride,
    })
    .from(users)
    .where(eq(users.isActive, true))
    .orderBy(asc(users.name));
  return rows
    .filter((u) => {
      if (actor.role !== "admin" && !actor.isOwner && Number(u.branchId) !== Number(actor.branchId)) return false;
      return hasModuleAccess(u.role, u.permissionsOverride as PermissionMap | null, "productStudio", "FULL");
    })
    .map(({ id, name, role, branchId }) => ({
      id,
      name: name || `مستخدم ${id}`,
      role,
      branchId,
    }));
}

type StudioCampaignRow = typeof productStudioCampaigns.$inferSelect;

function assertCampaignAccess(actor: ProductStudioActor, campaign: Pick<StudioCampaignRow, "branchId">): void {
  if (canCrossBranches(actor)) return;
  if (actor.branchId == null || Number(campaign.branchId) !== Number(actor.branchId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "الحملة تتبع فرعاً آخر",
    });
  }
}

function campaignBranchId(actor: ProductStudioActor, requested?: number): number {
  const branchId = requested ?? actor.branchId;
  if (branchId == null || !Number.isSafeInteger(Number(branchId)) || Number(branchId) < 1) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "اختر فرع الحملة" });
  }
  if (!canCrossBranches(actor) && Number(branchId) !== Number(actor.branchId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا يمكن إنشاء حملة لفرع آخر",
    });
  }
  return Number(branchId);
}

export async function createStudioCampaign(
  actor: ProductStudioActor,
  input: {
    name: string;
    branchId?: number;
    status?: "DRAFT" | "ACTIVE";
    startsAt?: Date | null;
    dueAt?: Date | null;
  },
) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const name = input.name.trim();
  if (name.length < 3 || name.length > 180) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "اسم الحملة يجب أن يكون بين 3 و180 حرفاً",
    });
  }
  if (input.startsAt && input.dueAt && input.dueAt <= input.startsAt) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "موعد الحملة يجب أن يكون بعد بدايتها",
    });
  }
  const branchId = campaignBranchId(actor, input.branchId);
  return withTx(async (tx) => {
    const [created] = await tx
      .insert(productStudioCampaigns)
      .values({
        name,
        branchId,
        status: input.status ?? "DRAFT",
        startsAt: input.startsAt ?? null,
        dueAt: input.dueAt ?? null,
        createdBy: actor.userId,
      })
      .$returningId();
    const campaignId = Number(created.id);
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId,
      action: "productStudio.campaign.create",
      entityType: "productStudioCampaign",
      entityId: String(campaignId),
      newValue: { name, status: input.status ?? "DRAFT" },
    });
    return {
      campaignId,
      name,
      branchId,
      status: input.status ?? "DRAFT",
      startsAt: input.startsAt ?? null,
      dueAt: input.dueAt ?? null,
    };
  });
}

export async function listStudioCampaigns(actor: ProductStudioActor) {
  if (!isManager(actor) && actor.role !== "auditor") throw new TRPCError({ code: "FORBIDDEN" });
  const conditions = canCrossBranches(actor) ? undefined : eq(productStudioCampaigns.branchId, Number(actor.branchId));
  return requireDb()
    .select({
      id: productStudioCampaigns.id,
      name: productStudioCampaigns.name,
      branchId: productStudioCampaigns.branchId,
      status: productStudioCampaigns.status,
      startsAt: productStudioCampaigns.startsAt,
      dueAt: productStudioCampaigns.dueAt,
      createdAt: productStudioCampaigns.createdAt,
    })
    .from(productStudioCampaigns)
    .where(conditions)
    .orderBy(desc(productStudioCampaigns.createdAt), desc(productStudioCampaigns.id));
}

async function loadCampaign(actor: ProductStudioActor, campaignId: number): Promise<StudioCampaignRow> {
  if (!isManager(actor) && actor.role !== "auditor") throw new TRPCError({ code: "FORBIDDEN" });
  const campaign = (await requireDb().select().from(productStudioCampaigns).where(eq(productStudioCampaigns.id, campaignId)).limit(1))[0];
  if (!campaign)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "حملة الاستوديو غير موجودة",
    });
  assertCampaignAccess(actor, campaign);
  return campaign;
}

async function missingStudioProducts(db: ReturnType<typeof requireDb> | StudioTx) {
  const activeProducts = await db
    .select({
      id: products.id,
      name: products.name,
      description: products.description,
    })
    .from(products)
    .where(eq(products.isActive, true))
    .orderBy(asc(products.id));
  if (activeProducts.length === 0) return [];
  const productIds = activeProducts.map((product) => Number(product.id));
  const [approvedImages, activeTasks] = await Promise.all([
    db
      .select({ productId: productImages.productId })
      .from(productImages)
      .where(and(inArray(productImages.productId, productIds), eq(productImages.reviewStatus, "APPROVED"))),
    db
      .select({ productId: productImageJobs.productId })
      .from(productImageJobs)
      .where(and(inArray(productImageJobs.productId, productIds), eq(productImageJobs.activeSlot, 1))),
  ]);
  const excluded = new Set<number>([...approvedImages.map((row) => Number(row.productId)), ...activeTasks.map((row) => Number(row.productId))]);
  return activeProducts.filter((product) => !excluded.has(Number(product.id)));
}

export async function previewStudioCampaignBacklog(actor: ProductStudioActor, campaignId: number) {
  const campaign = await loadCampaign(actor, campaignId);
  const missing = await missingStudioProducts(requireDb());
  return {
    campaignId: Number(campaign.id),
    count: missing.length,
    productIds: missing.map((product) => Number(product.id)),
    items: missing.slice(0, 100).map((product) => ({ id: Number(product.id), name: product.name })),
    truncated: missing.length > 100,
  };
}

export async function createStudioCampaignBacklog(actor: ProductStudioActor, campaignId: number) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  return withTx(async (tx) => {
    const campaign = (await tx.select().from(productStudioCampaigns).where(eq(productStudioCampaigns.id, campaignId)).limit(1).for("update"))[0];
    if (!campaign)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "حملة الاستوديو غير موجودة",
      });
    assertCampaignAccess(actor, campaign);
    if (campaign.status !== "ACTIVE") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "فعّل الحملة قبل توليد المهام",
      });
    }

    const initial = await missingStudioProducts(tx);
    if (initial.length === 0) return { createdCount: 0 };
    const ids = initial.map((product) => Number(product.id));
    await tx.select({ id: products.id }).from(products).where(inArray(products.id, ids)).for("update");
    const [approvedImages, activeTasks] = await Promise.all([
      tx
        .select({ productId: productImages.productId })
        .from(productImages)
        .where(and(inArray(productImages.productId, ids), eq(productImages.reviewStatus, "APPROVED"))),
      tx
        .select({ productId: productImageJobs.productId })
        .from(productImageJobs)
        .where(and(inArray(productImageJobs.productId, ids), eq(productImageJobs.activeSlot, 1))),
    ]);
    const excluded = new Set<number>([...approvedImages.map((row) => Number(row.productId)), ...activeTasks.map((row) => Number(row.productId))]);
    const missing = initial.filter((product) => !excluded.has(Number(product.id)));
    for (let offset = 0; offset < missing.length; offset += 500) {
      const batch = missing.slice(offset, offset + 500);
      if (batch.length === 0) continue;
      await tx.insert(productImageJobs).values(
        batch.map((product) => ({
          productId: Number(product.id),
          campaignId,
          branchId: Number(campaign.branchId),
          sourceProductHash: productContentHash(product),
          mode: "FLATTEN" as const,
          status: "ASSIGNED" as const,
          priority: "NORMAL" as const,
          dueAt: campaign.dueAt,
          revision: 1,
          assignedTo: null,
          assignedBy: null,
          createdBy: actor.userId,
          activeSlot: 1,
          templateVersion: 1,
        })),
      );
    }
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: Number(campaign.branchId),
      action: "productStudio.campaign.createBacklog",
      entityType: "productStudioCampaign",
      entityId: String(campaignId),
      newValue: { createdCount: missing.length },
    });
    return { createdCount: missing.length };
  });
}

export async function getStudioCampaignAnalytics(actor: ProductStudioActor, campaignId: number) {
  const campaign = await loadCampaign(actor, campaignId);
  const jobs = await requireDb()
    .select({
      id: productImageJobs.id,
      status: productImageJobs.status,
      rejectionReason: productImageJobs.rejectionReason,
      createdAt: productImageJobs.createdAt,
      reviewedAt: productImageJobs.reviewedAt,
    })
    .from(productImageJobs)
    .where(and(eq(productImageJobs.campaignId, campaignId), eq(productImageJobs.branchId, Number(campaign.branchId))));
  const ids = jobs.map((job) => String(job.id));
  const rejects =
    ids.length === 0
      ? []
      : await requireDb()
          .select({
            entityId: auditLogs.entityId,
            newValue: auditLogs.newValue,
          })
          .from(auditLogs)
          .where(and(eq(auditLogs.action, "productStudio.reject"), inArray(auditLogs.entityId, ids)));
  const rejectedIds = new Set(rejects.map((row) => row.entityId));
  const reasonCounts = new Map<string, number>();
  for (const row of rejects) {
    const reason = (row.newValue as { reason?: unknown } | null)?.reason;
    if (typeof reason === "string" && reason.trim()) {
      const clean = reason.trim();
      reasonCounts.set(clean, (reasonCounts.get(clean) ?? 0) + 1);
    }
  }
  for (const job of jobs) {
    const reason = job.rejectionReason?.trim();
    if (reason && !rejectedIds.has(String(job.id))) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
  }
  const approvedJobs = jobs.filter((job) => job.status === "APPROVED");
  const cycleMinutes = jobs
    .filter((job): job is typeof job & { reviewedAt: Date } => job.reviewedAt != null)
    .map((job) => Math.max(0, Math.round((job.reviewedAt.getTime() - job.createdAt.getTime()) / 60_000)))
    .sort((a, b) => a - b);
  const middle = Math.floor(cycleMinutes.length / 2);
  const medianCycleMinutes = cycleMinutes.length === 0 ? null : cycleMinutes.length % 2 === 1 ? cycleMinutes[middle] : Math.round(((cycleMinutes[middle - 1] ?? 0) + (cycleMinutes[middle] ?? 0)) / 2);
  const firstPassApproved = approvedJobs.filter((job) => !rejectedIds.has(String(job.id))).length;
  return {
    campaignId,
    total: jobs.length,
    approved: approvedJobs.length,
    rejected: jobs.filter((job) => job.status === "REJECTED").length,
    pendingReview: jobs.filter((job) => job.status === "PENDING_REVIEW").length,
    unassigned: jobs.filter((job) => job.status === "ASSIGNED").length,
    completionPercent: jobs.length === 0 ? 0 : Math.round((approvedJobs.length / jobs.length) * 100),
    firstPassApprovalRate: approvedJobs.length === 0 ? null : Math.round((firstPassApproved / approvedJobs.length) * 100),
    medianCycleMinutes,
    rejectionReasons: Array.from(reasonCounts, ([reason, count]) => ({
      reason,
      count,
    })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, "ar")),
  };
}

export async function sendStudioDueNotifications(actor: ProductStudioActor, now = new Date(), horizonHours = 24) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const horizon = new Date(now.getTime() + Math.max(1, Math.min(horizonHours, 168)) * 60 * 60_000);
  const branchScope = canCrossBranches(actor) ? undefined : eq(productImageJobs.branchId, Number(actor.branchId));
  const jobs = await requireDb()
    .select({
      id: productImageJobs.id,
      branchId: productImageJobs.branchId,
      assignedTo: productImageJobs.assignedTo,
      dueAt: productImageJobs.dueAt,
      assigneeRole: users.role,
    })
    .from(productImageJobs)
    .leftJoin(users, eq(users.id, productImageJobs.assignedTo))
    .where(and(branchScope, inArray(productImageJobs.status, ["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"]), lte(productImageJobs.dueAt, horizon)));
  const managerRows = await requireDb()
    .select({
      id: users.id,
      branchId: users.branchId,
      role: users.role,
      permissionsOverride: users.permissionsOverride,
    })
    .from(users)
    .where(eq(users.isActive, true));
  const managersByBranch = new Map<number, number[]>();
  for (const user of managerRows) {
    if (user.branchId == null || (user.role !== "manager" && user.role !== "admin")) continue;
    if (!hasModuleAccess(user.role, user.permissionsOverride as PermissionMap | null, "productStudio", "FULL")) continue;
    const branchId = Number(user.branchId);
    managersByBranch.set(branchId, [...(managersByBranch.get(branchId) ?? []), Number(user.id)]);
  }
  let createdCount = 0;
  for (const job of jobs) {
    if (!job.dueAt) continue;
    const dueKey = job.dueAt.toISOString();
    if (job.dueAt >= now && job.assignedTo != null && job.assigneeRole !== "manager" && job.assigneeRole !== "admin") {
      const result = await createAppNotification({
        userId: Number(job.assignedTo),
        kind: "TASK_ASSIGNED",
        title: "موعد مهمة الاستوديو قريب",
        body: `اقترب موعد مهمة الاستوديو رقم ${job.id}.`,
        route: `/catalog/image-studio?task=${job.id}`,
        eventKey: `product-studio:${job.id}:due:${dueKey}:user:${job.assignedTo}`,
        entityType: "productImageJob",
        entityId: Number(job.id),
        requiresAction: true,
      });
      if (result.created) createdCount++;
    }
    if (job.dueAt < now && job.branchId != null) {
      for (const managerId of managersByBranch.get(Number(job.branchId)) ?? []) {
        const result = await createAppNotification({
          userId: managerId,
          kind: "APPROVAL_REQUIRED",
          title: "استثناء: مهمة استوديو متأخرة",
          body: `تجاوزت مهمة الاستوديو رقم ${job.id} موعدها.`,
          route: `/catalog/image-studio?task=${job.id}`,
          eventKey: `product-studio:${job.id}:overdue:${dueKey}:manager:${managerId}`,
          entityType: "productImageJob",
          entityId: Number(job.id),
          requiresAction: true,
        });
        if (result.created) createdCount++;
      }
    }
  }
  return { createdCount };
}

export async function getStudioDashboard(actor: ProductStudioActor, now = new Date()) {
  const scope = canCrossBranches(actor) ? undefined : actor.role === "manager" || actor.role === "auditor" ? eq(productImageJobs.branchId, Number(actor.branchId)) : and(eq(productImageJobs.branchId, Number(actor.branchId)), eq(productImageJobs.assignedTo, actor.userId));
  const rows = await requireDb()
    .select({ status: productImageJobs.status, count: sql<number>`count(*)` })
    .from(productImageJobs)
    .where(scope)
    .groupBy(productImageJobs.status);
  const counts: Record<StudioStatus, number> = {
    ASSIGNED: 0,
    IN_PROGRESS: 0,
    PENDING_REVIEW: 0,
    APPROVED: 0,
    REJECTED: 0,
    FAILED: 0,
    REVERTED: 0,
  };
  for (const row of rows) counts[row.status] = Number(row.count);
  const activeStatuses: StudioStatus[] = ["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"];
  const day = now.toISOString().slice(0, 10);
  const todayStart = utcDayStart(day);
  const tomorrowStart = utcNextDayStart(day);
  const metricScope = scope;
  const [exceptionMetrics] = await requireDb()
    .select({
      unassigned: sql<number>`sum(case when ${productImageJobs.status} in (${sql.join(
        activeStatuses.map((status) => sql`${status}`),
        sql`, `,
      )}) and ${productImageJobs.assignedTo} is null then 1 else 0 end)`,
      overdue: sql<number>`sum(case when ${productImageJobs.status} in (${sql.join(
        activeStatuses.map((status) => sql`${status}`),
        sql`, `,
      )}) and ${productImageJobs.dueAt} is not null and ${productImageJobs.dueAt} < ${now} then 1 else 0 end)`,
      completedToday: sql<number>`sum(case when ${productImageJobs.status} = 'APPROVED' and ${productImageJobs.reviewedAt} >= ${todayStart} and ${productImageJobs.reviewedAt} < ${tomorrowStart} then 1 else 0 end)`,
    })
    .from(productImageJobs)
    .where(metricScope);
  const cycleRows = await requireDb()
    .select({
      createdAt: productImageJobs.createdAt,
      reviewedAt: productImageJobs.reviewedAt,
    })
    .from(productImageJobs)
    .where(and(metricScope, eq(productImageJobs.status, "APPROVED"), sql`${productImageJobs.reviewedAt} is not null`));
  const cycleMinutes = cycleRows
    .filter((row): row is { createdAt: Date; reviewedAt: Date } => row.reviewedAt != null)
    .map((row) => Math.max(0, Math.round((row.reviewedAt.getTime() - row.createdAt.getTime()) / 60_000)))
    .sort((a, b) => a - b);
  const middle = Math.floor(cycleMinutes.length / 2);
  const medianCycleMinutes = cycleMinutes.length === 0 ? null : cycleMinutes.length % 2 === 1 ? cycleMinutes[middle] : Math.round(((cycleMinutes[middle - 1] ?? 0) + (cycleMinutes[middle] ?? 0)) / 2);
  return {
    counts,
    active: counts.ASSIGNED + counts.IN_PROGRESS + counts.PENDING_REVIEW + counts.REJECTED,
    unassigned: Number(exceptionMetrics?.unassigned ?? 0),
    overdue: Number(exceptionMetrics?.overdue ?? 0),
    completedToday: Number(exceptionMetrics?.completedToday ?? 0),
    medianCycleMinutes,
    canManage: isManager(actor),
    canAudit: actor.role === "auditor",
    storageReady: isImageStoreOperational(),
  };
}

type StudioTaskScope = "QUEUE" | "MINE" | "REVIEW" | "HISTORY";
type StudioTaskCursor = {
  scope: StudioTaskScope;
  statuses: StudioStatus[];
  priorities: StudioPriority[];
  overdue: boolean | null;
  assigneeId: number | null;
  campaignId: number | null;
  unassigned: boolean;
  updatedAt: string;
  id: number;
};

function encodeStudioTaskCursor(cursor: StudioTaskCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeStudioTaskCursor(value: string, expected: Omit<StudioTaskCursor, "updatedAt" | "id">): StudioTaskCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as StudioTaskCursor;
    if (parsed.scope !== expected.scope || JSON.stringify(parsed.statuses) !== JSON.stringify(expected.statuses) || JSON.stringify(parsed.priorities) !== JSON.stringify(expected.priorities) || parsed.overdue !== expected.overdue || parsed.assigneeId !== expected.assigneeId || parsed.campaignId !== expected.campaignId || parsed.unassigned !== expected.unassigned || typeof parsed.updatedAt !== "string" || Number.isNaN(Date.parse(parsed.updatedAt)) || !Number.isSafeInteger(parsed.id) || parsed.id < 1) throw new Error("invalid cursor");
    return parsed;
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مؤشر مهام الاستوديو غير صالح",
    });
  }
}

export async function listStudioTasks(
  actor: ProductStudioActor,
  input: {
    scope: StudioTaskScope;
    limit?: number;
    cursor?: string | null;
    statuses?: StudioStatus[];
    priority?: StudioPriority[];
    overdue?: boolean;
    assigneeId?: number;
    campaignId?: number;
    unassigned?: boolean;
    now?: Date;
  },
) {
  const conds = [];
  const limit = Math.min(input.limit ?? 50, 100);
  const priorities = Array.from(new Set(input.priority ?? [])).sort();
  const statuses = Array.from(new Set(input.statuses ?? [])).sort();
  const assigneeId = input.assigneeId ?? null;
  const campaignId = input.campaignId ?? null;
  const cursorScope = {
    scope: input.scope,
    statuses,
    priorities,
    overdue: input.overdue ?? null,
    assigneeId,
    campaignId,
    unassigned: input.unassigned === true,
  };
  const cursor = input.cursor ? decodeStudioTaskCursor(input.cursor, cursorScope) : null;
  const now = input.now ?? new Date();
  if (!canCrossBranches(actor)) conds.push(eq(productImageJobs.branchId, Number(actor.branchId)));
  const branchAuditHistory = actor.role === "auditor" && input.scope === "HISTORY";
  if ((!isManager(actor) && !branchAuditHistory) || input.scope === "MINE") {
    conds.push(eq(productImageJobs.assignedTo, actor.userId));
  }
  if (input.scope === "QUEUE") conds.push(inArray(productImageJobs.status, ["ASSIGNED", "IN_PROGRESS", "REJECTED"]));
  if (input.scope === "REVIEW") conds.push(eq(productImageJobs.status, "PENDING_REVIEW"));
  if (input.scope === "HISTORY") conds.push(inArray(productImageJobs.status, ["APPROVED", "FAILED", "REVERTED"]));
  if (statuses.length) conds.push(inArray(productImageJobs.status, statuses));
  if (priorities.length) conds.push(inArray(productImageJobs.priority, priorities));
  if (assigneeId != null) {
    if (!isManager(actor) && assigneeId !== actor.userId) throw new TRPCError({ code: "FORBIDDEN" });
    conds.push(eq(productImageJobs.assignedTo, assigneeId));
  }
  if (campaignId != null) conds.push(eq(productImageJobs.campaignId, campaignId));
  if (input.unassigned === true) conds.push(isNull(productImageJobs.assignedTo));
  if (input.overdue === true) {
    conds.push(lt(productImageJobs.dueAt, now));
    conds.push(inArray(productImageJobs.status, ["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"]));
  } else if (input.overdue === false) {
    conds.push(or(isNull(productImageJobs.dueAt), gte(productImageJobs.dueAt, now), notInArray(productImageJobs.status, ["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"]))!);
  }
  if (cursor) {
    const updatedAt = new Date(cursor.updatedAt);
    conds.push(or(lt(productImageJobs.updatedAt, updatedAt), and(eq(productImageJobs.updatedAt, updatedAt), lt(productImageJobs.id, cursor.id)))!);
  }
  const rows = await requireDb()
    .select({
      id: productImageJobs.id,
      productId: productImageJobs.productId,
      campaignId: productImageJobs.campaignId,
      branchId: productImageJobs.branchId,
      productName: products.name,
      currentDescription: products.description,
      status: productImageJobs.status,
      mode: productImageJobs.mode,
      assignedTo: productImageJobs.assignedTo,
      assigneeName: users.name,
      proposedName: productImageJobs.proposedName,
      proposedDescription: productImageJobs.proposedDescription,
      proposedMarketingCopy: productImageJobs.proposedMarketingCopy,
      rejectionReason: productImageJobs.rejectionReason,
      sourceImageId: productImageJobs.sourceImageId,
      hasOriginal: sql<boolean>`${productImageJobs.originalObjectKey} is not null`,
      hasCandidate: sql<boolean>`${productImageJobs.processedObjectKey} is not null`,
      createdAt: productImageJobs.createdAt,
      updatedAt: productImageJobs.updatedAt,
      submittedAt: productImageJobs.submittedAt,
      submittedBy: productImageJobs.submittedBy,
      reviewedAt: productImageJobs.reviewedAt,
      priority: productImageJobs.priority,
      dueAt: productImageJobs.dueAt,
      revision: productImageJobs.revision,
      overdue: sql<boolean>`${productImageJobs.dueAt} is not null and ${productImageJobs.dueAt} < ${now} and ${productImageJobs.status} in ('ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW', 'REJECTED')`,
    })
    .from(productImageJobs)
    .innerJoin(products, eq(products.id, productImageJobs.productId))
    .leftJoin(users, eq(users.id, productImageJobs.assignedTo))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(productImageJobs.updatedAt), desc(productImageJobs.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map((row) => ({
    ...row,
    hasOriginal: Boolean(row.hasOriginal),
    hasCandidate: Boolean(row.hasCandidate),
    overdue: Boolean(row.overdue),
  }));
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeStudioTaskCursor({
            ...cursorScope,
            updatedAt: last.updatedAt.toISOString(),
            id: Number(last.id),
          })
        : null,
  };
}

export async function listStudioProductImages(productId: number) {
  const product = (
    await requireDb()
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.id, productId), eq(products.isActive, true)))
      .limit(1)
  )[0];
  if (!product) throw new TRPCError({ code: "NOT_FOUND", message: "المنتج غير موجود" });
  return requireDb()
    .select({
      id: productImages.id,
      isPrimary: productImages.isPrimary,
      sortOrder: productImages.sortOrder,
      origin: productImages.origin,
    })
    .from(productImages)
    .where(and(eq(productImages.productId, productId), eq(productImages.reviewStatus, "APPROVED")))
    .orderBy(desc(productImages.isPrimary), asc(productImages.sortOrder), asc(productImages.id));
}

async function stageStudioObject(objectKey: string): Promise<void> {
  await requireDb()
    .insert(productImageObjectStaging)
    .values({ objectKey, state: "PENDING" })
    .onDuplicateKeyUpdate({
      set: { touchedAt: new Date() },
    });
}

/**
 * مكنسة الرفع الفاشل: تقفل سجل المفتاح قبل الحذف. upsert لرفعٍ جديد على المفتاح نفسه ينتظر القفل،
 * ثم يعيد PUT بعد الحذف؛ فلا يقطع الكنس مرجعاً جديداً قيد الإنشاء عبر worker آخر.
 */
export async function cleanupStudioStaging(
  limit = 5,
  options: {
    now?: Date;
    loadDeletionAuthorization?: typeof loadR2GcDeletionAuthorization;
  } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - STAGING_AUDIT_INTERVAL_MS);
  const gcMode = resolveR2GcMode(process.env);
  const loadDeletionAuthorization = options.loadDeletionAuthorization ?? loadR2GcDeletionAuthorization;
  const deletionAuthorization = gcMode === "delete" ? await loadDeletionAuthorization(process.env, now, studioObjectRoot()) : null;
  const candidates = await requireDb()
    .select({ objectKey: productImageObjectStaging.objectKey })
    .from(productImageObjectStaging)
    // REFERENCED ليست نهائية: إعادة الإرسال تستبدل processedObjectKey، وحذف المهمة/الصورة يزيل آخر مرجع.
    // نفحص الحالتين بعد TTL ونحذف فقط بعد إثبات غياب أي مرجع داخل معاملة مقفلة.
    .where(sql`${productImageObjectStaging.touchedAt} < ${cutoff}`)
    .orderBy(asc(productImageObjectStaging.touchedAt))
    .limit(Math.max(1, Math.min(limit, 25)));
  let removed = 0;
  for (const candidate of candidates) {
    const deleted = await withTx(async (tx) => {
      const staging = (await tx.select().from(productImageObjectStaging).where(eq(productImageObjectStaging.objectKey, candidate.objectKey)).limit(1).for("update"))[0];
      if (!staging || staging.touchedAt >= cutoff) return false;
      const jobRef = await tx
        .select({ id: productImageJobs.id })
        .from(productImageJobs)
        .where(or(eq(productImageJobs.originalObjectKey, candidate.objectKey), eq(productImageJobs.processedObjectKey, candidate.objectKey)))
        .limit(1);
      const imageRef = await tx
        .select({ id: productImages.id })
        .from(productImages)
        .where(or(eq(productImages.objectKey, candidate.objectKey), eq(productImages.originalKey, candidate.objectKey)))
        .limit(1);
      const decision = evaluateStagingRetention({
        state: staging.state,
        touchedAt: staging.touchedAt,
        referencedAt: staging.referencedAt,
        hasReference: jobRef.length > 0 || imageRef.length > 0,
        now,
        deleteRequested: deletionAuthorization !== null,
      });
      if (decision.action === "MARK_REFERENCED") {
        await tx.update(productImageObjectStaging).set({ state: "REFERENCED", referencedAt: now, touchedAt: now }).where(eq(productImageObjectStaging.objectKey, candidate.objectKey));
        return false;
      }
      if (decision.action === "MARK_UNREFERENCED") {
        await tx
          .update(productImageObjectStaging)
          .set({
            state: "PENDING",
            referencedAt: decision.retentionStartedAt,
            touchedAt: now,
          })
          .where(eq(productImageObjectStaging.objectKey, candidate.objectKey));
        return false;
      }
      if (decision.action === "DEFER" || decision.action === "AUDIT_ELIGIBLE") {
        // referencedAt يحمل هنا بداية نافذة الاحتفاظ (أو وقت الرفع إن لم يوجد مرجع قط).
        // تحديث touchedAt يمنع صفاً مؤهلاً من احتكار كل دفعة audit صغيرة، من دون تصفير الـ90 يوماً.
        await tx
          .update(productImageObjectStaging)
          .set({
            state: "PENDING",
            referencedAt: decision.retentionStartedAt,
            touchedAt: now,
          })
          .where(eq(productImageObjectStaging.objectKey, candidate.objectKey));
        return false;
      }
      if (!deletionAuthorization) throw new Error("R2_GC_DELETE_AUTHORIZATION_REQUIRED");
      deletionAuthorization.authorize(candidate.objectKey);
      await getImageStore().delete(candidate.objectKey);
      await tx.delete(productImageObjectStaging).where(eq(productImageObjectStaging.objectKey, candidate.objectKey));
      return true;
    });
    if (deleted) removed++;
  }
  return removed;
}

async function prepareSourceSnapshot(productId: number, requested: number | null | undefined) {
  if (requested === null) return null; // إضافة صورة جديدة باختيارٍ صريح.
  const db = requireDb();
  const conditions = [eq(productImages.productId, productId), eq(productImages.reviewStatus, "APPROVED")];
  if (requested != null) conditions.push(eq(productImages.id, requested));
  else conditions.push(eq(productImages.isPrimary, true));
  const source = (
    await db
      .select({
        id: productImages.id,
        url: productImages.url,
        objectKey: productImages.objectKey,
        contentHash: productImages.contentHash,
        mime: productImages.mime,
      })
      .from(productImages)
      .where(and(...conditions))
      .orderBy(desc(productImages.id))
      .limit(1)
  )[0];
  if (!source) {
    if (requested != null)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "صورة المصدر لا تخص المنتج أو غير معتمدة",
      });
    return null;
  }

  if (source.objectKey && source.contentHash && source.mime) {
    if (!/^[0-9a-f]{64}$/i.test(source.contentHash) || !["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(source.mime)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "بيانات صورة المصدر المخزنة غير صالحة",
      });
    }
    if (!(await getImageStore().head(source.objectKey)).exists) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "صورة المصدر غير موجودة في المخزن الخاص",
      });
    }
    await stageStudioObject(source.objectKey);
    return {
      sourceImageId: Number(source.id),
      originalObjectKey: source.objectKey,
      sourceContentHash: source.contentHash,
      originalMime: source.mime,
      expected: source,
    };
  }
  const decoded = decodeStudioImage(source.url);
  const originalObjectKey = objectKeyFor(decoded.hash, decoded.mime, studioObjectPrefix("original"));
  await stageStudioObject(originalObjectKey);
  await getImageStore().put(originalObjectKey, decoded.bytes, decoded.mime);
  return {
    sourceImageId: Number(source.id),
    originalObjectKey,
    sourceContentHash: decoded.hash,
    originalMime: decoded.mime,
    expected: source,
  };
}

async function notifyStudioAssignment(taskId: number, assigneeId: number): Promise<void> {
  try {
    await createAppNotification({
      userId: assigneeId,
      kind: "TASK_ASSIGNED",
      title: "مهمة جديدة في استوديو المنتجات",
      body: `أُسندت إليك مهمة الاستوديو رقم ${taskId}.`,
      route: `/catalog/image-studio?task=${taskId}`,
      eventKey: `product-studio:${taskId}:assigned:${assigneeId}`,
      entityType: "productImageJob",
      entityId: taskId,
      requiresAction: true,
    });
  } catch (error) {
    logger.warn({ err: error, taskId, assigneeId }, "تعذّر إنشاء إشعار إسناد الاستوديو");
  }
}

async function notifyStudioRejection(taskId: number, assigneeId: number, revision: number): Promise<void> {
  try {
    await createAppNotification({
      userId: assigneeId,
      kind: "TASK_ASSIGNED",
      title: "مهمة استوديو تحتاج تعديلاً",
      body: `أُعيدت مهمة الاستوديو رقم ${taskId} للتعديل.`,
      route: `/catalog/image-studio?task=${taskId}`,
      eventKey: `product-studio:${taskId}:rejected:r${revision}`,
      entityType: "productImageJob",
      entityId: taskId,
      requiresAction: true,
    });
  } catch (error) {
    logger.warn({ err: error, taskId, assigneeId }, "تعذّر إنشاء إشعار رفض الاستوديو");
  }
}

export async function assignStudioTask(
  actor: ProductStudioActor,
  input: {
    productId: number;
    assigneeId: number;
    sourceImageId?: number | null;
    priority?: StudioPriority;
    dueAt?: Date | null;
  },
) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  assertStoragePolicy();
  const snapshot = await prepareSourceSnapshot(input.productId, input.sourceImageId);
  const result = await withTx(async (tx) => {
    const product = (
      await tx
        .select({
          id: products.id,
          name: products.name,
          description: products.description,
        })
        .from(products)
        .where(and(eq(products.id, input.productId), eq(products.isActive, true)))
        .limit(1)
        .for("update")
    )[0];
    if (!product)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "المنتج غير موجود أو معطل",
      });
    const assignee = (
      await tx
        .select({
          id: users.id,
          role: users.role,
          branchId: users.branchId,
          permissionsOverride: users.permissionsOverride,
        })
        .from(users)
        .where(and(eq(users.id, input.assigneeId), eq(users.isActive, true)))
        .limit(1)
        .for("update")
    )[0];
    if (!assignee) throw new TRPCError({ code: "BAD_REQUEST", message: "الموظف غير متاح" });
    if (actor.role !== "admin" && !actor.isOwner && Number(assignee.branchId) !== Number(actor.branchId)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "لا يمكن الإسناد إلى فرع آخر",
      });
    }
    if (!hasModuleAccess(assignee.role, assignee.permissionsOverride as PermissionMap | null, "productStudio", "FULL")) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "الموظف لا يملك صلاحية استوديو المنتجات",
      });
    }
    const activeTask = (
      await tx
        .select({
          id: productImageJobs.id,
          branchId: productImageJobs.branchId,
          assignedTo: productImageJobs.assignedTo,
          priority: productImageJobs.priority,
          dueAt: productImageJobs.dueAt,
          revision: productImageJobs.revision,
        })
        .from(productImageJobs)
        .where(and(eq(productImageJobs.productId, input.productId), eq(productImageJobs.activeSlot, 1)))
        .limit(1)
        .for("update")
    )[0];
    if (activeTask) {
      if (activeTask.assignedTo != null) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "للمنتج مهمة استوديو نشطة بالفعل",
        });
      }
      if (Number(activeTask.branchId) !== Number(assignee.branchId)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "المهمة غير المسندة تتبع فرعاً آخر",
        });
      }
      await tx
        .update(productImageJobs)
        .set({
          assignedTo: input.assigneeId,
          assignedBy: actor.userId,
          priority: input.priority ?? activeTask.priority,
          dueAt: input.dueAt === undefined ? activeTask.dueAt : input.dueAt,
          revision: sql`${productImageJobs.revision} + 1`,
        })
        .where(eq(productImageJobs.id, activeTask.id));
      await tx.insert(auditLogs).values(
        auditValues(actor, "productStudio.assignBacklog", Number(activeTask.id), {
          productId: input.productId,
          assigneeId: input.assigneeId,
          priority: input.priority ?? activeTask.priority,
          dueAt: input.dueAt === undefined ? (activeTask.dueAt?.toISOString() ?? null) : (input.dueAt?.toISOString() ?? null),
        }),
      );
      return {
        taskId: Number(activeTask.id),
        revision: Number(activeTask.revision) + 1,
      };
    }
    if (snapshot) {
      const current = (
        await tx
          .select({
            id: productImages.id,
            url: productImages.url,
            objectKey: productImages.objectKey,
            contentHash: productImages.contentHash,
            mime: productImages.mime,
            reviewStatus: productImages.reviewStatus,
          })
          .from(productImages)
          .where(and(eq(productImages.id, snapshot.sourceImageId), eq(productImages.productId, input.productId)))
          .limit(1)
          .for("update")
      )[0];
      if (!current || current.reviewStatus !== "APPROVED" || current.url !== snapshot.expected.url || current.objectKey !== snapshot.expected.objectKey || current.contentHash !== snapshot.expected.contentHash || current.mime !== snapshot.expected.mime) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تغيّرت صورة المصدر أثناء الإسناد",
        });
      }
    }
    try {
      const [created] = await tx
        .insert(productImageJobs)
        .values({
          productId: input.productId,
          branchId: assignee.branchId,
          sourceImageId: snapshot?.sourceImageId ?? null,
          originalObjectKey: snapshot?.originalObjectKey ?? null,
          sourceContentHash: snapshot?.sourceContentHash ?? null,
          originalMime: snapshot?.originalMime ?? null,
          sourceProductHash: productContentHash(product),
          mode: "FLATTEN",
          status: "ASSIGNED",
          priority: input.priority ?? "NORMAL",
          dueAt: input.dueAt ?? null,
          revision: 1,
          assignedTo: input.assigneeId,
          assignedBy: actor.userId,
          createdBy: actor.userId,
          activeSlot: 1,
          templateVersion: 1,
        })
        .$returningId();
      const taskId = Number(created.id);
      await tx.insert(auditLogs).values(
        auditValues(actor, "productStudio.assign", taskId, {
          productId: input.productId,
          assigneeId: input.assigneeId,
          sourceImageId: snapshot?.sourceImageId ?? null,
          priority: input.priority ?? "NORMAL",
          dueAt: input.dueAt?.toISOString() ?? null,
        }),
      );
      if (snapshot) {
        await tx.update(productImageObjectStaging).set({ state: "REFERENCED", referencedAt: new Date() }).where(eq(productImageObjectStaging.objectKey, snapshot.originalObjectKey));
      }
      return { taskId, revision: 1 };
    } catch (error) {
      if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "للمنتج مهمة استوديو نشطة بالفعل",
        });
      }
      throw error;
    }
  });
  await notifyStudioAssignment(result.taskId, input.assigneeId);
  return result;
}

export async function bulkAssignStudioTasks(
  actor: ProductStudioActor,
  input: {
    productIds: number[];
    assigneeId: number;
    priority?: StudioPriority;
    dueAt?: Date | null;
  },
) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const productIds = Array.from(new Set(input.productIds.map(Number)));
  if (productIds.length === 0 || productIds.length > 100 || productIds.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "اختر من منتج واحد إلى 100 منتج",
    });
  }
  if (productIds.length !== input.productIds.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "قائمة المنتجات تحتوي تكراراً",
    });
  }
  assertStoragePolicy();
  const result = await withTx(async (tx) => {
    const assignee = (
      await tx
        .select({
          id: users.id,
          role: users.role,
          branchId: users.branchId,
          permissionsOverride: users.permissionsOverride,
        })
        .from(users)
        .where(and(eq(users.id, input.assigneeId), eq(users.isActive, true)))
        .limit(1)
        .for("update")
    )[0];
    if (!assignee) throw new TRPCError({ code: "BAD_REQUEST", message: "الموظف غير متاح" });
    if (!canCrossBranches(actor) && Number(assignee.branchId) !== Number(actor.branchId)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "لا يمكن الإسناد إلى فرع آخر",
      });
    }
    if (!hasModuleAccess(assignee.role, assignee.permissionsOverride as PermissionMap | null, "productStudio", "FULL")) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "الموظف لا يملك صلاحية استوديو المنتجات",
      });
    }
    const selectedProducts = await tx
      .select({
        id: products.id,
        name: products.name,
        description: products.description,
      })
      .from(products)
      .where(and(inArray(products.id, productIds), eq(products.isActive, true)))
      .for("update");
    if (selectedProducts.length !== productIds.length) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "أحد المنتجات غير موجود أو معطل",
      });
    }
    const active = await tx
      .select({
        id: productImageJobs.id,
        productId: productImageJobs.productId,
        branchId: productImageJobs.branchId,
        assignedTo: productImageJobs.assignedTo,
      })
      .from(productImageJobs)
      .where(and(inArray(productImageJobs.productId, productIds), eq(productImageJobs.activeSlot, 1)))
      .for("update");
    if (
      active.some(
        (task) =>
          task.assignedTo != null ||
          Number(task.branchId) !== Number(assignee.branchId),
      )
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "أحد المنتجات لديه مهمة استوديو نشطة بالفعل",
      });
    }
    const productById = new Map(selectedProducts.map((product) => [Number(product.id), product]));
    const unassignedByProduct = new Map(
      active.map((task) => [Number(task.productId), Number(task.id)]),
    );
    const newProductIds = productIds.filter(
      (productId) => !unassignedByProduct.has(productId),
    );
    try {
      if (newProductIds.length > 0) {
        await tx.insert(productImageJobs).values(
          newProductIds.map((productId) => ({
            productId,
            branchId: assignee.branchId,
            sourceProductHash: productContentHash(productById.get(productId)!),
            mode: "FLATTEN" as const,
            status: "ASSIGNED" as const,
            priority: input.priority ?? "NORMAL",
            dueAt: input.dueAt ?? null,
            revision: 1,
            assignedTo: input.assigneeId,
            assignedBy: actor.userId,
            createdBy: actor.userId,
            activeSlot: 1,
            templateVersion: 1,
          })),
        );
      }
      const unassignedIds = Array.from(unassignedByProduct.values());
      if (unassignedIds.length > 0) {
        await tx
          .update(productImageJobs)
          .set({
            assignedTo: input.assigneeId,
            assignedBy: actor.userId,
            priority: input.priority ?? "NORMAL",
            ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
            revision: sql`${productImageJobs.revision} + 1`,
          })
          .where(inArray(productImageJobs.id, unassignedIds));
      }
    } catch (error) {
      if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تغيّرت المهام النشطة أثناء الإسناد الجماعي",
        });
      }
      throw error;
    }
    await tx.insert(auditLogs).values({
      ...auditValues(actor, "productStudio.bulkAssign", 0, {
        productIds,
        assigneeId: input.assigneeId,
        priority: input.priority ?? "NORMAL",
        dueAt: input.dueAt?.toISOString() ?? null,
      }),
      entityId: "bulk",
    });
    const taskIds = await tx
      .select({ id: productImageJobs.id })
      .from(productImageJobs)
      .where(and(inArray(productImageJobs.productId, productIds), eq(productImageJobs.assignedTo, input.assigneeId), eq(productImageJobs.activeSlot, 1)));
    return {
      createdCount: productIds.length,
      taskIds: taskIds.map((row) => Number(row.id)),
    };
  });
  await Promise.all(result.taskIds.map((taskId) => notifyStudioAssignment(taskId, input.assigneeId)));
  return { createdCount: result.createdCount };
}

export async function updateStudioTaskSchedule(
  actor: ProductStudioActor,
  input: {
    taskId: number;
    expectedRevision: number;
    priority: StudioPriority;
    dueAt?: Date | null;
  },
) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  return withTx(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    assertTaskAccess(actor, task, true);
    assertExpectedRevision(task, input.expectedRevision);
    if (!["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"].includes(task.status)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "لا يمكن تعديل موعد مهمة مغلقة",
      });
    }
    await tx
      .update(productImageJobs)
      .set({
        priority: input.priority,
        dueAt: input.dueAt ?? null,
        revision: sql`${productImageJobs.revision} + 1`,
      })
      .where(eq(productImageJobs.id, input.taskId));
    await tx.insert(auditLogs).values(
      auditValues(actor, "productStudio.updateSchedule", input.taskId, {
        priority: input.priority,
        dueAt: input.dueAt?.toISOString() ?? null,
      }),
    );
    return { ok: true as const, revision: nextRevision(task) };
  });
}

export async function saveStudioDraft(
  actor: ProductStudioActor,
  input: {
    taskId: number;
    proposedName?: string | null;
    proposedDescription?: string | null;
    proposedMarketingCopy?: string | null;
    adminOverrideReason?: string | null;
    expectedRevision?: number;
  },
) {
  return withTx(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    assertExpectedRevision(task, input.expectedRevision);
    const overrideReason = assertTaskWriteAccess(actor, task, input.adminOverrideReason);
    if (!["ASSIGNED", "IN_PROGRESS", "REJECTED"].includes(task.status)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "لا يمكن تعديل مهمة بانتظار المراجعة أو مغلقة",
      });
    }
    if (task.uploadLeaseToken && task.uploadLeaseExpiresAt && task.uploadLeaseExpiresAt > new Date()) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "الرفع قيد التنفيذ؛ انتظر اكتماله",
      });
    }
    if (task.processingLeaseTokenHash && task.processingLeaseExpiresAt && task.processingLeaseExpiresAt > new Date()) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "المعالجة عبر المزود قيد التنفيذ؛ انتظر اكتمالها",
      });
    }
    await tx
      .update(productImageJobs)
      .set({
        proposedName: input.proposedName?.trim() || null,
        proposedDescription: input.proposedDescription?.trim() || null,
        proposedMarketingCopy: input.proposedMarketingCopy?.trim() || null,
        status: "IN_PROGRESS",
        activeSlot: 1,
        // وصلنا هنا فقط إن لم توجد lease حيّة؛ تصفير المنتهية يدوّر الملكية ويمنع رفعاً بطيئاً
        // من الالتزام بعد حفظ هذه المسودة الأحدث.
        uploadLeaseToken: null,
        uploadLeaseExpiresAt: null,
        revision: sql`${productImageJobs.revision} + 1`,
      })
      .where(eq(productImageJobs.id, input.taskId));
    await tx.insert(auditLogs).values(
      auditValues(actor, "productStudio.saveDraft", input.taskId, {
        hasName: Boolean(input.proposedName?.trim()),
        hasDescription: Boolean(input.proposedDescription?.trim()),
        hasMarketingCopy: Boolean(input.proposedMarketingCopy?.trim()),
      }),
    );
    await recordAdminOverride(tx, actor, input.taskId, "saveDraft", overrideReason, task.assignedTo);
    return input.expectedRevision === undefined ? { ok: true as const } : { ok: true as const, revision: nextRevision(task) };
  });
}

/**
 * يحرس استدعاء المزود قبل حجز الحصة/الاتصال الخارجي. الموظف لا يستهلك خدمة مدفوعة إلا لمهمة
 * نشطة مسندة إليه في فرعه؛ لا مسار مباشر للمدير خارج المهمة، وتُعاد مراجعة المهمة تحت قفل عند
 * إصدار receipt بعد نجاح المزود لسد سباق تغيّر الإسناد/الحالة.
 */
export async function authorizeStudioProcessing(actor: ProductStudioActor, taskId: number, mode: "PRO" | "AI", adminOverrideReason?: string | null): Promise<string> {
  const authorization = randomUUID();
  await withTx(async (tx) => {
    const task = await lockTask(tx, taskId);
    const overrideReason = assertTaskWriteAccess(actor, task, adminOverrideReason);
    if (!["ASSIGNED", "IN_PROGRESS", "REJECTED"].includes(task.status)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "حالة المهمة لا تقبل معالجة جديدة",
      });
    }
    if (task.uploadLeaseToken && task.uploadLeaseExpiresAt && task.uploadLeaseExpiresAt > new Date()) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "رفع مرشح لهذه المهمة قيد التنفيذ",
      });
    }
    // يجب أن تسبق جاهزية R2 حجز الحصة والاتصال بالمزوّد؛ لا استهلاك مدفوع لمرشح لا يمكن حفظه.
    assertStoragePolicy();
    if (task.processingLeaseTokenHash && task.processingLeaseExpiresAt && task.processingLeaseExpiresAt > new Date()) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "معالجة أخرى لهذه المهمة قيد التنفيذ",
      });
    }
    await tx
      .update(productImageJobs)
      .set({
        processingLeaseTokenHash: processingAuthorizationHash(authorization, mode),
        processingLeaseExpiresAt: new Date(Date.now() + PROCESSING_AUTHORIZATION_MS),
      })
      .where(eq(productImageJobs.id, taskId));
    await recordAdminOverride(tx, actor, taskId, "processing", overrideReason, task.assignedTo);
  });
  return authorization;
}

/** يسجّل نجاح المزود خادمياً ويرجع receipt أحادي المهمة قصير العمر، بلا أسرار المزود. */
export async function attestStudioProcessing(actor: ProductStudioActor, taskId: number, mode: "PRO" | "AI", processingAuthorization: string, adminOverrideReason?: string | null): Promise<string> {
  const receipt = randomUUID();
  const authorizationHash = processingAuthorizationHash(processingAuthorization, mode);
  await withTx(async (tx) => {
    const task = await lockTask(tx, taskId);
    const overrideReason = assertTaskWriteAccess(actor, task, adminOverrideReason);
    if (!["ASSIGNED", "IN_PROGRESS", "REJECTED"].includes(task.status)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "حالة المهمة لا تقبل معالجة جديدة",
      });
    }
    if (task.processingLeaseTokenHash !== authorizationHash || !task.processingLeaseExpiresAt || task.processingLeaseExpiresAt <= new Date()) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "انتهى حجز المعالجة أو استُبدل",
      });
    }
    await tx
      .update(productImageJobs)
      .set({
        processingProofTokenHash: contentHash(Buffer.from(receipt, "utf8")),
        processingProofMode: mode,
        processingProofCandidateHash: null,
        processingProofExpiresAt: new Date(Date.now() + PROCESSING_PROOF_MS),
        processingLeaseTokenHash: null,
        processingLeaseExpiresAt: null,
      })
      .where(eq(productImageJobs.id, taskId));
    await recordAdminOverride(tx, actor, taskId, "processingAttestation", overrideReason, task.assignedTo);
  });
  return receipt;
}

/** يحرّر حجز المزود عند الفشل فقط؛ الشرط يمنع طلباً قديماً من مسح receipt أحدث. */
export async function releaseStudioProcessingAuthorization(taskId: number, mode: "PRO" | "AI", processingAuthorization: string): Promise<void> {
  const authorizationHash = processingAuthorizationHash(processingAuthorization, mode);
  await requireDb()
    .update(productImageJobs)
    .set({
      processingLeaseTokenHash: null,
      processingLeaseExpiresAt: null,
    })
    .where(and(eq(productImageJobs.id, taskId), eq(productImageJobs.processingLeaseTokenHash, authorizationHash)));
}

/** يربط receipt بالناتج النهائي بعد تركيب/ضغط العميل؛ submit يرفض أي تبديل بايتات لاحق. */
export async function bindStudioProcessingCandidate(
  actor: ProductStudioActor,
  input: {
    taskId: number;
    processingReceipt: string;
    candidateDataUrl: string;
    adminOverrideReason?: string | null;
  },
): Promise<{ ok: true }> {
  const candidate = decodeStudioImage(input.candidateDataUrl);
  const receiptHash = contentHash(Buffer.from(input.processingReceipt, "utf8"));
  return withTx(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    const overrideReason = assertTaskWriteAccess(actor, task, input.adminOverrideReason);
    if (!["ASSIGNED", "IN_PROGRESS", "REJECTED"].includes(task.status)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "حالة المهمة لا تقبل ربط معالجة جديدة",
      });
    }
    if (task.processingProofTokenHash !== receiptHash || !task.processingProofMode || !task.processingProofExpiresAt || task.processingProofExpiresAt <= new Date()) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "إيصال المعالجة غير صالح أو منتهي",
      });
    }
    await tx.update(productImageJobs).set({ processingProofCandidateHash: candidate.hash }).where(eq(productImageJobs.id, input.taskId));
    await recordAdminOverride(tx, actor, input.taskId, "bindProcessingProof", overrideReason, task.assignedTo);
    return { ok: true as const };
  });
}

export async function submitStudioCandidate(
  actor: ProductStudioActor,
  input: {
    taskId: number;
    originalDataUrl?: string | null;
    processedDataUrl: string;
    thumbnailDataUrl: string;
    mode: "FLATTEN" | "CUT";
    processingReceipt?: string | null;
    proposedName?: string | null;
    proposedDescription?: string | null;
    proposedMarketingCopy?: string | null;
    adminOverrideReason?: string | null;
    expectedRevision?: number;
  },
) {
  const token = randomUUID();
  const lease = await withTx(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    assertExpectedRevision(task, input.expectedRevision);
    const overrideReason = assertTaskWriteAccess(actor, task, input.adminOverrideReason);
    assertStoragePolicy();
    if (!["ASSIGNED", "IN_PROGRESS", "REJECTED"].includes(task.status)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "حالة المهمة لا تقبل مرشحاً جديداً",
      });
    }
    if (task.uploadLeaseToken && task.uploadLeaseExpiresAt && task.uploadLeaseExpiresAt > new Date()) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "رفع آخر لهذه المهمة قيد التنفيذ",
      });
    }
    if (task.processingLeaseTokenHash && task.processingLeaseExpiresAt && task.processingLeaseExpiresAt > new Date()) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "المعالجة عبر المزود قيد التنفيذ؛ لا يمكن إرسال نسخة أقدم",
      });
    }
    await tx
      .update(productImageJobs)
      .set({
        uploadLeaseToken: token,
        uploadLeaseExpiresAt: new Date(Date.now() + UPLOAD_LEASE_MS),
      })
      .where(eq(productImageJobs.id, input.taskId));
    return {
      originalObjectKey: task.originalObjectKey,
      sourceContentHash: task.sourceContentHash,
      originalMime: task.originalMime,
      assignedTo: task.assignedTo,
      overrideReason,
    };
  });

  try {
    const processed = decodeStudioImage(input.processedDataUrl);
    const thumbnail = decodeStudioThumbnail(input.thumbnailDataUrl, processed);
    const original = lease.originalObjectKey ? null : input.originalDataUrl ? decodeStudioImage(input.originalDataUrl) : null;
    if (!lease.originalObjectKey && !original) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "الصورة الأصلية مطلوبة لأول إرسال",
      });
    }
    const store = getImageStore();
    const originalKey = lease.originalObjectKey ?? objectKeyFor(original!.hash, original!.mime, studioObjectPrefix("original"));
    const processedKey = objectKeyFor(processed.hash, processed.mime, studioObjectPrefix("candidate"));
    if (original) {
      await stageStudioObject(originalKey);
      await store.put(originalKey, original.bytes, original.mime);
    }
    await stageStudioObject(processedKey);
    await store.put(processedKey, processed.bytes, processed.mime);

    const result = await withTx(async (tx) => {
      const task = await lockTask(tx, input.taskId);
      assertExpectedRevision(task, input.expectedRevision);
      assertTaskWriteAccess(actor, task, input.adminOverrideReason);
      if (task.uploadLeaseToken !== token || !task.uploadLeaseExpiresAt || task.uploadLeaseExpiresAt <= new Date() || !["ASSIGNED", "IN_PROGRESS", "REJECTED"].includes(task.status)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "انتهت ملكية الرفع أو تغيّرت حالة المهمة",
        });
      }
      const immutableOriginalHash = task.sourceContentHash ?? original?.hash;
      const immutableOriginalMime = task.originalMime ?? original?.mime;
      if (!immutableOriginalHash || !immutableOriginalMime) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "لقطة الأصل غير مكتملة",
        });
      }
      const receiptHash = input.processingReceipt ? contentHash(Buffer.from(input.processingReceipt, "utf8")) : null;
      let effectiveMode: "FLATTEN" | "CUT" | "PRO" | "AI" = input.mode;
      if (input.processingReceipt) {
        const proofValid = Boolean(receiptHash && task.processingProofTokenHash === receiptHash && task.processingProofExpiresAt && task.processingProofExpiresAt > new Date() && task.processingProofCandidateHash === processed.hash && (task.processingProofMode === "PRO" || task.processingProofMode === "AI"));
        if (!proofValid) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "إيصال المعالجة لا يطابق الصورة النهائية أو انتهت صلاحيته",
          });
        }
        effectiveMode = task.processingProofMode!;
      }
      await tx
        .update(productImageJobs)
        .set({
          // الأصل لقطة غير قابلة للكتابة: إن وُجد من الإسناد/الإرسال الأول لا يتغير بعد الرفض.
          originalObjectKey: task.originalObjectKey ?? originalKey,
          sourceContentHash: immutableOriginalHash,
          originalMime: immutableOriginalMime,
          processedObjectKey: processedKey,
          processedContentHash: processed.hash,
          processedMime: processed.mime,
          processedBytes: processed.bytes.length,
          processedWidth: processed.width,
          processedHeight: processed.height,
          // مصغّرة WebP فقط، مرتبطة بنفس المرشح المقفول؛ تُنقل للصف المنشور ثم تُمسح من المهمة.
          processedUrl: thumbnail.dataUrl,
          mode: effectiveMode,
          proposedName: input.proposedName === undefined ? task.proposedName : input.proposedName?.trim() || null,
          proposedDescription: input.proposedDescription === undefined ? task.proposedDescription : input.proposedDescription?.trim() || null,
          proposedMarketingCopy: input.proposedMarketingCopy === undefined ? task.proposedMarketingCopy : input.proposedMarketingCopy?.trim() || null,
          status: "PENDING_REVIEW",
          submittedAt: new Date(),
          // هوية المرسل حقيقة خادمية من Actor، ولا نقبلها من الحمولة.
          submittedBy: actor.userId,
          reviewedBy: null,
          reviewedAt: null,
          rejectionReason: null,
          activeSlot: 1,
          uploadLeaseToken: null,
          uploadLeaseExpiresAt: null,
          processingProofTokenHash: null,
          processingProofMode: null,
          processingProofCandidateHash: null,
          processingProofExpiresAt: null,
          revision: sql`${productImageJobs.revision} + 1`,
        })
        .where(eq(productImageJobs.id, input.taskId));
      await tx.insert(auditLogs).values(
        auditValues(actor, "productStudio.submit", input.taskId, {
          mode: effectiveMode,
          originalHash: immutableOriginalHash,
          processedHash: processed.hash,
          processedBytes: processed.bytes.length,
          thumbnailHash: thumbnail.hash,
          contentIncluded: true,
        }),
      );
      await recordAdminOverride(tx, actor, input.taskId, "submit", lease.overrideReason, lease.assignedTo);
      await tx
        .update(productImageObjectStaging)
        .set({ state: "REFERENCED", referencedAt: new Date() })
        .where(inArray(productImageObjectStaging.objectKey, original ? [originalKey, processedKey] : [processedKey]));
      return input.expectedRevision === undefined ? { ok: true as const } : { ok: true as const, revision: nextRevision(task) };
    });
    try {
      await cleanupStudioStaging(5);
    } catch (error) {
      // نجاح المعاملة هو الحقيقة؛ تعثّر الكنس لا يحوّل الإرسال الناجح إلى خطأ كاذب، ويُعاد لاحقاً.
      logger.warn({ err: error }, "productStudio: staging sweep deferred");
    }
    return result;
  } catch (error) {
    await requireDb()
      .update(productImageJobs)
      .set({ uploadLeaseToken: null, uploadLeaseExpiresAt: null })
      .where(and(eq(productImageJobs.id, input.taskId), eq(productImageJobs.uploadLeaseToken, token)));
    throw error;
  }
}

async function streamToBase64(key: string): Promise<string> {
  const stream = await getImageStore().getStream(key);
  if (!stream)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "ملف الصورة غير موجود في المخزن الخاص",
    });
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_PREVIEW_BYTES) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE" });
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("base64");
}

export async function getStudioCandidatePreview(actor: ProductStudioActor, taskId: number) {
  assertStoragePolicy();
  const task = (
    await requireDb()
      .select({
        assignedTo: productImageJobs.assignedTo,
        branchId: productImageJobs.branchId,
        originalObjectKey: productImageJobs.originalObjectKey,
        processedObjectKey: productImageJobs.processedObjectKey,
        originalMime: productImageJobs.originalMime,
        processedMime: productImageJobs.processedMime,
      })
      .from(productImageJobs)
      .where(eq(productImageJobs.id, taskId))
      .limit(1)
  )[0];
  if (!task) throw new TRPCError({ code: "NOT_FOUND" });
  assertTaskAccess(actor, task, false, true);
  if (!task.originalObjectKey || !task.processedObjectKey || !task.originalMime || !task.processedMime) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "لا يوجد مرشح مكتمل لهذه المهمة",
    });
  }
  const [originalBase64, processedBase64] = await Promise.all([streamToBase64(task.originalObjectKey), streamToBase64(task.processedObjectKey)]);
  return {
    originalBase64,
    processedBase64,
    originalMime: task.originalMime,
    processedMime: task.processedMime,
  };
}

/** يعيد لقطة المصدر للمحرر المصرّح فقط؛ لا يكشف objectKey ولا ينشئ رابطاً عاماً. */
export async function getStudioSourcePreview(actor: ProductStudioActor, taskId: number) {
  assertStoragePolicy();
  const task = (
    await requireDb()
      .select({
        assignedTo: productImageJobs.assignedTo,
        branchId: productImageJobs.branchId,
        originalObjectKey: productImageJobs.originalObjectKey,
        originalMime: productImageJobs.originalMime,
      })
      .from(productImageJobs)
      .where(eq(productImageJobs.id, taskId))
      .limit(1)
  )[0];
  if (!task) throw new TRPCError({ code: "NOT_FOUND" });
  assertTaskAccess(actor, task);
  if (!task.originalObjectKey || !task.originalMime) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "لا توجد صورة مصدر لهذه المهمة",
    });
  }
  return {
    base64: await streamToBase64(task.originalObjectKey),
    mime: task.originalMime,
  };
}

export async function approveStudioTask(actor: ProductStudioActor, taskId: number, adminOverrideReason?: string | null, expectedRevision?: number) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  return withTx(async (tx) => {
    const task = await lockTask(tx, taskId);
    assertExpectedRevision(task, expectedRevision);
    assertTaskAccess(actor, task, true);
    if (task.status !== "PENDING_REVIEW") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "المهمة لم تعد بانتظار المراجعة",
      });
    }
    const overrideReason = assertIndependentReviewer(actor, task, adminOverrideReason);
    assertStoragePolicy();
    if (!task.productId || !task.processedObjectKey || !task.processedContentHash || !task.processedMime || !task.processedUrl) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "بيانات المرشح غير مكتملة",
      });
    }
    const thumbnail = decodeStudioThumbnail(task.processedUrl, {
      width: task.processedWidth,
      height: task.processedHeight,
    });
    const product = (
      await tx
        .select({
          id: products.id,
          name: products.name,
          description: products.description,
        })
        .from(products)
        .where(eq(products.id, task.productId))
        .limit(1)
        .for("update")
    )[0];
    if (!product) throw new TRPCError({ code: "NOT_FOUND", message: "المنتج غير موجود" });

    const changesProductContent = Boolean(task.proposedName?.trim() || task.proposedDescription?.trim() || task.proposedMarketingCopy?.trim());
    if (changesProductContent && task.sourceProductHash && productContentHash(product) !== task.sourceProductHash) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "عُدّل محتوى المنتج بعد بدء المهمة؛ راجع النسخة الأحدث",
      });
    }

    let imageId: number;
    let existingOriginalKey: string | null = null;
    if (task.sourceImageId) {
      const image = (
        await tx
          .select({
            id: productImages.id,
            productId: productImages.productId,
            originalKey: productImages.originalKey,
            url: productImages.url,
            contentHash: productImages.contentHash,
            reviewStatus: productImages.reviewStatus,
          })
          .from(productImages)
          .where(eq(productImages.id, task.sourceImageId))
          .limit(1)
          .for("update")
      )[0];
      let currentSourceHash = image?.contentHash ?? null;
      if (image && !currentSourceHash) {
        try {
          currentSourceHash = decodeStudioImage(image.url).hash;
        } catch {
          currentSourceHash = null;
        }
      }
      if (!image || Number(image.productId) !== Number(task.productId) || image.reviewStatus !== "APPROVED" || !task.sourceContentHash || currentSourceHash !== task.sourceContentHash) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "صورة المصدر لم تعد صالحة",
        });
      }
      imageId = Number(image.id);
      existingOriginalKey = image.originalKey;
    } else {
      await tx
        .update(productImages)
        .set({ isPrimary: false })
        .where(and(eq(productImages.productId, task.productId), eq(productImages.isPrimary, true)));
      const [created] = await tx
        .insert(productImages)
        .values({
          productId: task.productId,
          variantId: task.variantId,
          url: "stored-object",
          isPrimary: true,
          sortOrder: 0,
          reviewStatus: "APPROVED",
          origin: task.mode === "AI" ? "STUDIO_AI" : task.mode === "PRO" ? "STUDIO_PRO" : "STUDIO_FREE",
        })
        .$returningId();
      imageId = Number(created.id);
    }
    const imageUrl = await publishedImageUrl(imageId, task.processedContentHash);
    await tx
      .update(productImages)
      .set({
        url: imageUrl,
        objectKey: task.processedObjectKey,
        originalKey: existingOriginalKey ?? task.originalObjectKey,
        contentHash: task.processedContentHash,
        mime: task.processedMime,
        width: task.processedWidth,
        height: task.processedHeight,
        bytes: task.processedBytes,
        thumbDataUrl: thumbnail.dataUrl,
        reviewStatus: "APPROVED",
        origin: task.mode === "AI" ? "STUDIO_AI" : task.mode === "PRO" ? "STUDIO_PRO" : "STUDIO_FREE",
        publishedStudioJobId: taskId,
        migratedAt: new Date(),
      })
      .where(eq(productImages.id, imageId));

    const combinedDescription = [task.proposedDescription?.trim(), task.proposedMarketingCopy?.trim()].filter(Boolean).join("\n\n");
    const productPatch: { name?: string; description?: string | null } = {};
    if (task.proposedName?.trim()) productPatch.name = task.proposedName.trim();
    if (combinedDescription) productPatch.description = combinedDescription;
    if (Object.keys(productPatch).length) await tx.update(products).set(productPatch).where(eq(products.id, task.productId));

    await tx
      .update(productImageJobs)
      .set({
        sourceImageId: imageId,
        status: "APPROVED",
        reviewedBy: actor.userId,
        reviewedAt: new Date(),
        rejectionReason: null,
        activeSlot: null,
        processedUrl: null,
        revision: sql`${productImageJobs.revision} + 1`,
      })
      .where(eq(productImageJobs.id, taskId));
    await tx.insert(auditLogs).values(
      auditValues(actor, "productStudio.approve", taskId, {
        productId: task.productId,
        imageId,
        processedHash: task.processedContentHash,
        thumbnailHash: thumbnail.hash,
        contentUpdated: Object.keys(productPatch).length > 0,
      }),
    );
    await recordAdminOverride(tx, actor, taskId, "approve", overrideReason, task.assignedTo);
    return expectedRevision === undefined ? { imageId } : { imageId, revision: nextRevision(task) };
  });
}

export async function rejectStudioTask(actor: ProductStudioActor, taskId: number, reason: string, adminOverrideReason?: string | null, expectedRevision?: number) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const cleanReason = reason.trim();
  if (cleanReason.length < 5)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سبب الرفض مطلوب بوضوح",
    });
  const result = await withTx(async (tx) => {
    const task = await lockTask(tx, taskId);
    assertExpectedRevision(task, expectedRevision);
    assertTaskAccess(actor, task, true);
    if (task.status !== "PENDING_REVIEW")
      throw new TRPCError({
        code: "CONFLICT",
        message: "المهمة لم تعد بانتظار المراجعة",
      });
    const overrideReason = assertIndependentReviewer(actor, task, adminOverrideReason);
    await tx
      .update(productImageJobs)
      .set({
        status: "REJECTED",
        processedUrl: null,
        reviewedBy: actor.userId,
        reviewedAt: new Date(),
        rejectionReason: cleanReason,
        activeSlot: 1,
        revision: sql`${productImageJobs.revision} + 1`,
      })
      .where(eq(productImageJobs.id, taskId));
    await tx.insert(auditLogs).values(
      auditValues(actor, "productStudio.reject", taskId, {
        reason: cleanReason,
      }),
    );
    await recordAdminOverride(tx, actor, taskId, "reject", overrideReason, task.assignedTo);
    return {
      response: expectedRevision === undefined ? { ok: true as const } : { ok: true as const, revision: nextRevision(task) },
      assignedTo: task.assignedTo,
      revision: nextRevision(task),
    };
  });
  if (result.assignedTo != null) await notifyStudioRejection(taskId, Number(result.assignedTo), result.revision);
  return result.response;
}

export async function revertStudioTask(actor: ProductStudioActor, taskId: number, expectedRevision?: number) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  assertStoragePolicy();
  const snapshot = (
    await requireDb()
      .select({
        assignedTo: productImageJobs.assignedTo,
        branchId: productImageJobs.branchId,
        status: productImageJobs.status,
        originalObjectKey: productImageJobs.originalObjectKey,
        sourceContentHash: productImageJobs.sourceContentHash,
        originalMime: productImageJobs.originalMime,
        revision: productImageJobs.revision,
      })
      .from(productImageJobs)
      .where(eq(productImageJobs.id, taskId))
      .limit(1)
  )[0];
  if (!snapshot) throw new TRPCError({ code: "NOT_FOUND" });
  assertExpectedRevision(snapshot, expectedRevision);
  assertTaskAccess(actor, snapshot, true);
  if (snapshot.status !== "APPROVED" || !snapshot.originalObjectKey || !snapshot.sourceContentHash || !snapshot.originalMime) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "لا يوجد أصل قابل للاسترجاع لهذه المهمة",
    });
  }
  const originalStream = await getImageStore().getStream(snapshot.originalObjectKey);
  if (!originalStream)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "الأصل غير موجود في المخزن الخاص",
    });
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of originalStream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_PREVIEW_BYTES) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE" });
    chunks.push(bytes);
  }
  const originalBytes = Buffer.concat(chunks);
  if (contentHash(originalBytes) !== snapshot.sourceContentHash) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "بصمة الأصل لا تطابق سجل المهمة",
    });
  }
  const publishedOriginalKey = objectKeyFor(snapshot.sourceContentHash, snapshot.originalMime, studioObjectPrefix("candidate"));
  await stageStudioObject(publishedOriginalKey);
  await getImageStore().put(publishedOriginalKey, originalBytes, snapshot.originalMime);
  const originalDimensions = parseImageDimensions(originalBytes, snapshot.originalMime);
  return withTx(async (tx) => {
    const task = await lockTask(tx, taskId);
    assertExpectedRevision(task, expectedRevision);
    assertTaskAccess(actor, task, true);
    if (task.status !== "APPROVED" || !task.sourceImageId || !task.originalObjectKey || !task.sourceContentHash || !task.originalMime) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "لا يوجد أصل قابل للاسترجاع لهذه المهمة",
      });
    }
    const image = (
      await tx
        .select({
          id: productImages.id,
          productId: productImages.productId,
          contentHash: productImages.contentHash,
          reviewStatus: productImages.reviewStatus,
          publishedStudioJobId: productImages.publishedStudioJobId,
        })
        .from(productImages)
        .where(eq(productImages.id, task.sourceImageId))
        .limit(1)
        .for("update")
    )[0];
    if (!image || Number(image.productId) !== Number(task.productId) || image.reviewStatus !== "APPROVED" || Number(image.publishedStudioJobId) !== taskId || image.contentHash !== task.processedContentHash) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "نُشرت نسخة أحدث؛ لا يمكن استرجاع مهمة قديمة",
      });
    }
    await tx
      .update(productImages)
      .set({
        url: await publishedImageUrl(Number(image.id), task.sourceContentHash),
        objectKey: publishedOriginalKey,
        contentHash: task.sourceContentHash,
        mime: task.originalMime,
        width: originalDimensions?.width ?? null,
        height: originalDimensions?.height ?? null,
        bytes: originalBytes.length,
        reviewStatus: "APPROVED",
        origin: "ORIGINAL",
        publishedStudioJobId: null,
      })
      .where(eq(productImages.id, image.id));
    await tx
      .update(productImageJobs)
      .set({
        status: "REVERTED",
        reviewedBy: actor.userId,
        reviewedAt: new Date(),
        activeSlot: null,
        revision: sql`${productImageJobs.revision} + 1`,
      })
      .where(eq(productImageJobs.id, taskId));
    await tx.update(productImageObjectStaging).set({ state: "REFERENCED", referencedAt: new Date() }).where(eq(productImageObjectStaging.objectKey, publishedOriginalKey));
    await tx.insert(auditLogs).values(
      auditValues(actor, "productStudio.revert", taskId, {
        productId: task.productId,
        imageId: image.id,
        originalHash: task.sourceContentHash,
      }),
    );
    return expectedRevision === undefined ? { imageId: Number(image.id) } : { imageId: Number(image.id), revision: nextRevision(task) };
  });
}
