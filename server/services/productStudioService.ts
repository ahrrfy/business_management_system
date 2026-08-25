import { TRPCError } from "@trpc/server";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, like, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { appNotifications, auditLogs, categories, productImageObjectStaging, productImageJobs, productImages, productStudioCampaignAssignees, productStudioCampaignProducts, productStudioCampaigns, productUnitBarcodes, productUnits, productVariants, products, users } from "../../drizzle/schema";
import type { PermissionMap } from "@shared/permissions";
import { hasModuleAccess, resolvePermissions } from "@shared/permissions";
import { ARABIC_FOLD_PAIRS, normalizeSearchText } from "@shared/searchNormalize";
import { foldDigitsSql } from "../lib/similarMatch";
import { escLike } from "../lib/sqlLike";
import { requireDb, withTx } from "./tx";
import { assertValidImageDataUrl, canonicalImageMime, parseImageDimensions } from "../lib/imageValidation";
import { assertImageStoreOperationalConfiguration, contentHash, getImageStore, isImageStoreOperational, MAX_PUBLISHED_PRODUCT_IMAGE_BYTES, objectKeyFor, shortHash, studioObjectPrefix } from "../lib/imageStore";
import { hashPassword } from "../auth/password";
import { logger } from "../logger";
import { getCurrentCompanyId } from "../tenancy/context";
import { isMultiTenantModeActive } from "../db";
import { resolveCompanyById } from "../tenancy/registry";
import { evaluateStagingRetention, loadR2GcDeletionAuthorization, resolveR2GcMode } from "../lib/imageStore/r2RetentionPolicy";
import { studioObjectRoot } from "../lib/imageStore/tenantNamespace";
import { canCrossBranches } from "../lib/branchAuthority";
import { utcDayStart, utcNextDayStart } from "./businessDay";
import { reserveStudioSubmitQuotaInTx, studioPayloadBytes } from "./productStudioSubmitQuota";
import { createAppNotification } from "./appNotificationService";

const MAX_STUDIO_THUMBNAIL_BYTES = 128 * 1024;
const MAX_STUDIO_THUMBNAIL_DIMENSION = 320;
const MAX_PREVIEW_BYTES = 1_000_000;
const UPLOAD_LEASE_MS = 2 * 60_000;
const PROCESSING_AUTHORIZATION_MS = 2 * 60_000;
const PROCESSING_PROOF_MS = 15 * 60_000;
const STAGING_AUDIT_INTERVAL_MS = 24 * 60 * 60_000;
/** سقف مهام الحملة المولَّدة في المعاملة الواحدة؛ الباقي يُولَّد باستدعاءٍ تالٍ. */
const BACKLOG_BATCH_LIMIT = 500;
/** أقصى صورٍ مطلوبة لكل منتج في حملة، وأقصى منتجاتٍ تُختار صراحةً لحملةٍ واحدة. */
const MAX_REQUIRED_IMAGES = 10;
const MAX_CAMPAIGN_PRODUCTS = 5000;
/** سقف مسح تذكيرات المواعيد في النبضة الواحدة. */
const DUE_REMINDER_SCAN_LIMIT = 500;
/** نافذة وسيط زمن الدورة وسقف عيّنته — تمنعان تحميل تاريخ الاعتماد كلّه لحساب رقمٍ واحد. */
const CYCLE_WINDOW_DAYS = 90;
const CYCLE_SAMPLE_LIMIT = 500;

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


/**
 * فرعُ المُسنَد إليه يجب أن يطابق فرع المُسنِد، وكلاهما يجب أن يكون **معروفاً**.
 *
 * كان الفحص `Number(assignee.branchId) !== Number(actor.branchId)` وحده، و`Number(null)`
 * يساوي صفراً ⇒ مديرٌ بلا فرعٍ يُسنِد إلى موظفٍ بلا فرع فيمرّ الشرط (0 !== 0 كاذب)،
 * وتُنشأ مهمةٌ بـ`branchId = NULL` لا يراها أحد بعدها: حرّاس الوصول تفشل مغلقةً على
 * فرعٍ مجهول، فتصير المهمة يتيمةً لا يبلغها إلّا مديرُ النظام.
 */
function assertAssignableBranch(actor: ProductStudioActor, assigneeBranchId: number | null): void {
  // مدير النظام/المالك يعبر الفروع، فمهمةٌ بلا فرعٍ تبقى في متناوله ويعملها بنفسه —
  // مسارٌ قائمٌ ومقصود. الحظر يخصّ من لا يعبر.
  if (canCrossBranches(actor)) return;
  if (actor.branchId == null) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لك؛ لا يمكنك إسناد مهام الاستوديو" });
  }
  if (assigneeBranchId == null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الموظف بلا فرع مُسنَد؛ عيّن فرعه قبل إسناد مهام الاستوديو" });
  }
  if (Number(assigneeBranchId) !== Number(actor.branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن الإسناد إلى فرع آخر" });
  }
}

/**
 * مصوّرو الحملة يخضعون لنفس شروط الإسناد الفرديّ: فرعٌ مطابق وصلاحية وحدة كاملة.
 * بدونها كانت الحملة باباً خلفياً يُدخل من لا يملك الوحدة أو من فرعٍ آخر.
 */
async function assertCampaignAssignees(tx: StudioTx, actor: ProductStudioActor, campaignBranch: number, userIds: number[]): Promise<void> {
  const rows = await tx
    .select({ id: users.id, role: users.role, branchId: users.branchId, permissionsOverride: users.permissionsOverride })
    .from(users)
    .where(and(inArray(users.id, userIds), eq(users.isActive, true)));
  if (rows.length !== userIds.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "أحد الموظفين غير متاح" });
  }
  for (const row of rows) {
    if (Number(row.branchId) !== Number(campaignBranch)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن إسناد الحملة إلى موظفٍ من فرعٍ آخر" });
    }
    if (!hasModuleAccess(row.role, row.permissionsOverride as PermissionMap | null, "productStudio", "FULL")) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "أحد الموظفين لا يملك صلاحية استوديو المنتجات" });
    }
  }
  void actor;
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

/**
 * كل معاملات هذه الوحدة **غير ماليّة**: لا قيدَ دفترٍ ولا إيصالَ ولا فاتورة تُكتب هنا
 * (تحقّقٌ نصّيّ: صفر إشارة إلى postEntry/receipts/invoices في الملف كلّه).
 *
 * ومع ذلك كانت تأخذ البوّابة الافتراضية `FINANCIAL_WRITER` — قفلٌ مشارك على صفّ تسلسل
 * إقفال الشهر — فتزاحم الكتابات الماليّة الحقيقية بلا داعٍ، والأسوأ: عمليةٌ طويلة على
 * الصور (توليد طابور حملة، كنس المخزن) كانت تحجب **إقفال الشهر** طوال تنفيذها، لأنّ
 * الإقفال يطلب الصورة الحصرية من البوّابة نفسها.
 */
function withStudioTx<T>(fn: (tx: StudioTx) => Promise<T>): Promise<T> {
  return withTx(fn, { gate: "NONE" });
}

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
  // موحَّدٌ عند المدخل: image/jpg ⇐ image/jpeg، فلا يصل المخزنَ اسمٌ لا يعرفه.
  const mime = canonicalImageMime(dataUrl.slice(5, dataUrl.indexOf(";")));
  const bytes = Buffer.from(dataUrl.slice(comma + 1), "base64");
  const dims = parseImageDimensions(bytes, mime);
  const structurallyComplete = mime === "image/png" ? bytes.length >= 20 && bytes.readUInt32BE(bytes.length - 12) === 0 && bytes.toString("ascii", bytes.length - 8, bytes.length - 4) === "IEND" : mime === "image/jpeg" ? bytes.length >= 4 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9 : mime === "image/webp" ? bytes.length >= 12 && bytes.readUInt32LE(4) + 8 === bytes.length : false;
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
/**
 * هل هذه بايتات WebP **كاملةٌ لصورةٍ ساكنةٍ واحدة**؟ يمشي على مقاطع RIFF بدل افتراض شكلٍ بعينه.
 *
 * **العطب الذي أغلقه (٢٠/٨، جولةٌ حيّة):** الفحص السابق كان يشترط **مقطعاً واحداً** بترويسة
 * `VP8 ` أو `VP8L`. لكنّ Chromium الحديث يُخرج من `canvas.toDataURL("image/webp")` حاوية
 * **`VP8X`** يتبعها **`ICCP`** (ملفّ ألوان sRGB يُضمّنه المتصفّح) ثمّ `VP8 ` — ثلاثةُ مقاطع.
 * فكان الخادم يرفض **كل** مصغّرةٍ يُنتجها Chrome/Edge برسالة «بنية/إطار مصغّرة WebP غير
 * مكتمل»، والمصوّر يُمنع من الإرسال. أثبتَته جولةٌ حيّة: `chunks = [VP8X 10, ICCP 456, VP8  50]`.
 * (ولاحظ أنّ `parseImageDimensions` كان يفكّ `VP8X` أصلاً — فالرافض والقارئ كانا مختلفَين
 * في فهم الصيغة نفسها داخل الملفّ الواحد.)
 *
 * والمشي على المقاطع **أدقّ** من الفحص القديم لا أرخى: يرفض الملفّ المبتور وذيلَ البايتات
 * الزائد ويرفض المتحرّك (`ANIM`/`ANMF`) — والمصغّرة إطارٌ ساكنٌ واحدٌ بحكم التعريف — ويشترط
 * مقطعَ صورةٍ واحداً بالضبط.
 */
export function isCompleteStillWebp(bytes: Buffer): boolean {
  return locateStillWebpFrame(bytes) !== null;
}

/**
 * يحدّد **إطار الصورة الوحيد** داخل ملفّ WebP كامل، ويعيد أبعاده المقروءة **من الإطار نفسه**.
 * يعيد `null` لأيّ ملفٍّ ناقصٍ أو مُتلاعَبٍ به أو متحرّك.
 *
 * لماذا المشي على المقاطع: الفحص السابق كان يشترط **مقطعاً واحداً** بترويسة `VP8 `/`VP8L`،
 * وChromium يُخرج `[VP8X, ICCP, VP8 ]` (يُضمّن ملفّ ألوان sRGB) ⇒ **كل مصغّرةٍ ينتجها
 * Chrome/Edge مرفوضة** والمصوّر ممنوعٌ من التسليم (جولةٌ حيّة ٢٠/٨).
 *
 * ⚠️ ولماذا يُفحص **حِمل** الإطار لا اسمُ مقطعه فقط (أمسكه Codex على أوّل نسخةٍ من هذا
 * الإصلاح): المشي وحده يقبل مقطعاً اسمه `VP8 ` وحمولتُه أصفارٌ — ملفٌّ لا يُفكّ ترميزه —
 * بينما `parseImageDimensions` يصدّق أبعاد ترويسة `VP8X` **غير المَمسوسة**، فيُخزَّن
 * ويُنشَر «مرشّحٌ» لا يعرضه أيّ متصفّح. الفحص القديم كان يحرس هذا بترويسة الإطار، وإسقاطُه
 * انحدارٌ لا تبسيط.
 *
 * **والأبعاد تُقرأ من الإطار لا من ترويسة `VP8X`:** الترويسة تصريحٌ يكتبه المُنتِج والإطار
 * هو الصورة فعلاً، فحين يختلفان تُصدَّق الصورة. وبها تبقى مطابقةُ أبعاد المرشّح صادقة.
 */
export function locateStillWebpFrame(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 20) return null;
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return null;
  // حجم RIFF يجب أن يصف الملفّ كلّه: يمنع البتر والذيل الزائد معاً.
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) return null;
  let offset = 12;
  let frame: { fourcc: string; at: number; size: number } | null = null;
  let frames = 0;
  let animated = false;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    // حجمٌ يتجاوز ما تبقّى = ملفٌّ مبتورٌ أو مُتلاعَبٌ به.
    if (size < 0 || offset + 8 + size > bytes.length) return null;
    if (id === "VP8 " || id === "VP8L") {
      frames++;
      frame = { fourcc: id, at: offset + 8, size };
    }
    if (id === "ANIM" || id === "ANMF") animated = true;
    offset += 8 + size + (size % 2); // حشوٌ إلى حدّ زوجيّ
  }
  // الوقوف عند النهاية بالضبط: أيّ بايتٍ زائدٍ أو ناقصٍ يُسقِط الملفّ.
  if (offset !== bytes.length || frames !== 1 || animated || !frame) return null;

  if (frame.fourcc === "VP8 ") {
    // VP8 المضغوط: وسمُ إطارٍ ٣ بايتات، ثمّ رمز البدء 9D 01 2A، ثمّ العرض والارتفاع ١٤ بتّاً لكلٍّ.
    if (frame.size < 10) return null;
    const p = frame.at;
    if (bytes[p + 3] !== 0x9d || bytes[p + 4] !== 0x01 || bytes[p + 5] !== 0x2a) return null;
    return { width: bytes.readUInt16LE(p + 6) & 0x3fff, height: bytes.readUInt16LE(p + 8) & 0x3fff };
  }
  // VP8L (بلا فقد): توقيعٌ 0x2F ثمّ ١٤ بتّاً للعرض و١٤ للارتفاع (ناقصاً واحداً).
  if (frame.size < 5) return null;
  const p = frame.at;
  if (bytes[p] !== 0x2f) return null;
  const b1 = bytes[p + 1];
  const b2 = bytes[p + 2];
  const b3 = bytes[p + 3];
  const b4 = bytes[p + 4];
  return {
    width: 1 + (b1 | ((b2 & 0x3f) << 8)),
    height: 1 + (((b2 & 0xc0) >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
  };
}

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
  // ٢٠/٨ (بلاغ إنتاج): كان WebP إلزامياً — و`canvas.toDataURL("image/webp")` غير مدعوم على
  // Safari/iOS قبل ١٧، فكان المصوّر على iPhone يُمنع من الإرسال نهائياً بسبب **مشتقّ عرضٍ**
  // لا علاقة له بجودة عمله ولا بسلامة المال. الاحتياطيّ JPEG لأنّ كل متصفّحٍ يرمّزه من
  // canvas ويبقى تحت السقف. ⛔ التساهل في **الصيغة** لا في **التحقّق**: لكلٍّ فحصُ بنيةٍ
  // كامل، ومطابقةُ الأبعاد للمرشّح تبقى الحارس المشترك أياً كانت الصيغة.
  const isWebp = dataUrl.startsWith("data:image/webp;base64,");
  const isJpeg = dataUrl.startsWith("data:image/jpeg;base64,");
  if (!isWebp && !isJpeg) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مصغّرة العرض يجب أن تكون WebP أو JPEG",
    });
  }
  assertValidImageDataUrl(dataUrl, MAX_STUDIO_THUMBNAIL_BYTES, true, MAX_STUDIO_THUMBNAIL_DIMENSION);
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  // للـWebP تُقرأ الأبعاد **من إطار الصورة** لا من ترويسة `VP8X`: الترويسة تصريحٌ يكتبه
  // المُنتِج، والإطار هو الصورة فعلاً — وعند اختلافهما تُصدَّق الصورة لا التصريح.
  const frame = isWebp ? locateStillWebpFrame(bytes) : null;
  const dimensions = isWebp ? frame : parseImageDimensions(bytes, "image/jpeg");
  let structureOk: boolean;
  if (isWebp) {
    structureOk = frame !== null;
  } else {
    // JPEG: SOI في المقدّمة وEOI في الخاتمة ⇒ ملفٌّ كاملٌ غير مبتور، ومقطعُ SOF مقروءٌ
    // (وإلّا رجع `dimensions` فارغاً فسقط الفحص أدناه).
    structureOk =
      bytes.length >= 4 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[bytes.length - 2] === 0xff &&
      bytes[bytes.length - 1] === 0xd9;
  }
  if (!structureOk || !dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > MAX_STUDIO_THUMBNAIL_DIMENSION || dimensions.height > MAX_STUDIO_THUMBNAIL_DIMENSION) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: isWebp ? "بنية/إطار مصغّرة WebP غير مكتمل" : "بنية مصغّرة JPEG غير مكتملة",
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

/** تقدّم صور المنتج مقابل توجيه حملته: «الصورة ٢ من ٣». */
async function studioImageProgress(tx: StudioTx, productId: number, campaignId: number | null) {
  const [approved] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(productImages)
    .where(and(eq(productImages.productId, productId), eq(productImages.reviewStatus, "APPROVED")));
  let requiredImages = 1;
  if (campaignId != null) {
    const [campaign] = await tx.select({ requiredImages: productStudioCampaigns.requiredImages }).from(productStudioCampaigns).where(eq(productStudioCampaigns.id, campaignId)).limit(1);
    requiredImages = Math.max(1, Number(campaign?.requiredImages ?? 1));
  }
  return { approvedImages: Number(approved?.count ?? 0), requiredImages };
}

/**
 * إنشاءُ مهمةٍ لحظةَ المسح داخل حملةٍ نشطة يكون الماسحُ أحد مصوّريها.
 * يُعيد استعمال القيد الفريد `(productId, activeSlot)` حارساً ضدّ ماسحَين متزامنين.
 *
 * الرسائل التشخيصية تُميّز بين أسباب الرفض الأربعة (ليس في حملة · حملات في فرعٍ آخر ·
 * المنتج خارج نطاق الحملة · اكتملت صور المنتج) — كانت رسالةً واحدة ملبّسة الأسباب،
 * فيقف المصوّر أمام «المنتج ليس ضمن حملة» بلا معرفة أيّها العلّة ولا كيف يعالجها.
 */
async function claimFreshCampaignTask(tx: StudioTx, actor: ProductStudioActor, resolved: { productId: number; productName: string }) {
  const productId = Number(resolved.productId);
  const campaigns = await tx
    .select({
      id: productStudioCampaigns.id,
      name: productStudioCampaigns.name,
      branchId: productStudioCampaigns.branchId,
      dueAt: productStudioCampaigns.dueAt,
      scopeKind: productStudioCampaigns.scopeKind,
      scopeCategoryId: productStudioCampaigns.scopeCategoryId,
      requiredImages: productStudioCampaigns.requiredImages,
    })
    .from(productStudioCampaigns)
    .innerJoin(productStudioCampaignAssignees, and(eq(productStudioCampaignAssignees.campaignId, productStudioCampaigns.id), eq(productStudioCampaignAssignees.userId, actor.userId)))
    .where(eq(productStudioCampaigns.status, "ACTIVE"))
    // أولويّةٌ معلَنة عند تداخل حملتين على المنتج نفسه: الأقرب موعداً ثمّ الأقدم إنشاءً.
    // بلا ترتيبٍ كان الاختيار يتبع ما تُرجعه MySQL أوّلاً — فيُنسَب العمل لحملةٍ عشوائية.
    .orderBy(asc(productStudioCampaigns.dueAt), asc(productStudioCampaigns.id));
  if (campaigns.length === 0) {
    throw new TRPCError({ code: "NOT_FOUND", message: "لست ضمن مصوّري أيّ حملةٍ نشطة — راجع المدير لإضافتك" });
  }
  let branchMismatchCount = 0;
  let outOfScopeCount = 0;
  let completedCount = 0;
  for (const campaign of campaigns) {
    // الفرع يُعاد فحصه من **الحملة** لا من صفّ العضوية: الموظف قد يكون نُقل بعد إضافته،
    // فتبقى عضويّته قائمةً بينما فرعه تغيّر — وإنشاءُ مهمةٍ في فرعٍ آخر يُنتج عملاً
    // لا يستطيع صاحبه فتحه لاحقاً (الحرّاس مُفرَّعة).
    if (!canCrossBranches(actor) && (actor.branchId == null || Number(campaign.branchId) !== Number(actor.branchId))) {
      branchMismatchCount++;
      continue;
    }
    // «المنتج مكتمل الصور» = صفٌّ **موجود** خارج شرط الناقص، لكن ضمن نطاق الحملة.
    // نُميّزه عن «خارج النطاق» بفحصٍ صريح: نطاقٌ مطابق أوّلاً ثمّ اكتمالٌ ثانياً.
    const [inScopeAndMissing] = await tx
      .select({ id: products.id, name: products.name, description: products.description })
      .from(products)
      .where(and(eq(products.id, productId), missingStudioProductConditions(Number(campaign.requiredImages ?? 1)), campaignScopeCondition(campaign)))
      .limit(1);
    if (!inScopeAndMissing) {
      // فرّق بين خارج النطاق واكتمال الصور — اكتمالٌ حين يقع المنتج داخل النطاق فقط.
      const [inScopeIgnoringMissing] = await tx
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.id, productId), eq(products.isActive, true), campaignScopeCondition(campaign)))
        .limit(1);
      if (inScopeIgnoringMissing) completedCount++;
      else outOfScopeCount++;
      continue;
    }
    const inScope = inScopeAndMissing;
    const [created] = await tx
      .insert(productImageJobs)
      .values({
        productId,
        campaignId: Number(campaign.id),
        branchId: Number(campaign.branchId),
        sourceProductHash: productContentHash(inScope),
        mode: "FLATTEN",
        status: "ASSIGNED",
        priority: "NORMAL",
        dueAt: campaign.dueAt,
        revision: 1,
        assignedTo: actor.userId,
        assignedBy: actor.userId,
        assignedAt: new Date(),
        createdBy: actor.userId,
        activeSlot: 1,
        templateVersion: 1,
      })
      .$returningId()
      .catch((error: unknown) => {
        // ماسحان متزامنان على منتجٍ بلا مهمة: القيد الفريد (productId, activeSlot) يمنع
        // التكرار، لكنّ الخطأ الخام كان يصل الخاسرَ عطلاً داخلياً بدل «بيد زميل».
        if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
          throw new TRPCError({ code: "CONFLICT", message: `«${resolved.productName}» فتحه زميلٌ قبلك للتوّ` });
        }
        throw error;
      });
    const taskId = Number(created.id);
    await tx.insert(auditLogs).values(auditValues(actor, "productStudio.claimByBarcode.created", taskId, { productId, campaignId: Number(campaign.id) }));
    return { taskId, productName: resolved.productName, claimed: true as const, revision: 1, ...(await studioImageProgress(tx, productId, Number(campaign.id))) };
  }
  // ترتيبُ التشخيص من الأخصّ إلى الأعمّ: «اكتملت» يسبق «خارج النطاق» يسبق «فرعٌ آخر»،
  // فالمصوّر يقرأ سبباً واحداً محدَّداً بدل عدّة سببٍ عامّ محتمل.
  if (completedCount > 0) {
    throw new TRPCError({ code: "NOT_FOUND", message: `«${resolved.productName}» اكتملت صوره المعتمَدة في حملتك` });
  }
  if (outOfScopeCount > 0) {
    throw new TRPCError({ code: "NOT_FOUND", message: `«${resolved.productName}» خارج نطاق حملاتك النشطة — تحقّق من فئة المنتج مع المدير` });
  }
  if (branchMismatchCount > 0) {
    throw new TRPCError({ code: "FORBIDDEN", message: `«${resolved.productName}»: حملاتك في فرعٍ آخر — راجع المدير` });
  }
  // احتياط: لا حملات مطابقة لأيّ سبب — يحدث حين تتغيّر الحملات بين استعلامَين.
  throw new TRPCError({ code: "NOT_FOUND", message: `«${resolved.productName}» ليس ضمن حملة تصوير نشطة مُسنَدة إليك` });
}

/**
 * مسحُ باركودٍ يفتح العمل مباشرةً — قلب شاشة المصوّر.
 *
 * كان الباركود يبحث في مهامّ المصوّر **المسنَدة إليه سلفاً** فقط، فلا يفتح عملاً جديداً:
 * يمسح منتجاً من الحملة فلا يجد شيئاً. هنا يسحب المصوّر المنتجَ إلى يده بنفسه:
 * إن كانت له مهمّةٌ فتُفتَح، وإن كانت في طابور حملةٍ هو أحد مصوّريها فتُسنَد إليه ذرّياً
 * تحت قفلٍ — فلا يسحب اثنان المنتج نفسه.
 */
export async function claimStudioProductByBarcode(actor: ProductStudioActor, barcode: string) {
  const resolved = await resolveStudioBarcode(actor, barcode);
  const productId = Number(resolved.productId);
  return withStudioTx(async (tx) => {
    const active = (
      await tx
        .select({ id: productImageJobs.id, status: productImageJobs.status, assignedTo: productImageJobs.assignedTo, campaignId: productImageJobs.campaignId, branchId: productImageJobs.branchId, revision: productImageJobs.revision })
        .from(productImageJobs)
        .where(and(eq(productImageJobs.productId, productId), eq(productImageJobs.activeSlot, 1)))
        .limit(1)
        .for("update")
    )[0];
    if (!active) {
      // لا مهمّة نشطة ⇒ نُنشئها فوراً إن كان المنتج داخل نطاق حملةٍ نشطة والماسحُ أحد
      // مصوّريها ولم يبلغ المنتج عدد الصور المطلوب. بدون هذا كان المصوّر يقف عاجزاً حتى
      // يُولّد المدير الطابور يدوياً — وهو ما يكسر انسيابية «امسح ثم صوّر».
      return claimFreshCampaignTask(tx, actor, resolved);
    }
    if (Number(active.assignedTo) === actor.userId) {
      return { taskId: Number(active.id), productName: resolved.productName, claimed: false as const, revision: Number(active.revision), ...(await studioImageProgress(tx, productId, active.campaignId == null ? null : Number(active.campaignId))) };
    }
    if (active.assignedTo != null) {
      throw new TRPCError({ code: "CONFLICT", message: `«${resolved.productName}» بيد زميلٍ آخر الآن` });
    }
    // فحصُ الفرع وحده هنا: `assertTaskAccess` تفشل مغلقةً على صفٍّ **بلا منفّذ**
    // (`Number(null) === 0` لا يساوي معرّف أحد) — وهو بالضبط ما يعنيه السحب.
    // التخويل الحقيقيّ تحته: عضويّةُ الحملة.
    if (!canCrossBranches(actor) && (actor.branchId == null || Number(active.branchId) !== Number(actor.branchId))) {
      throw new TRPCError({ code: "FORBIDDEN", message: "المهمة تتبع فرعاً آخر" });
    }
    // السحب مشروطٌ بعضوية الحملة: لا يسحب من ليس مصوّراً فيها.
    if (active.campaignId == null) {
      throw new TRPCError({ code: "FORBIDDEN", message: "هذه المهمة تُسنَد من المدير ولا تُسحَب بالمسح" });
    }
    const member = (
      await tx
        .select({ id: productStudioCampaignAssignees.id })
        .from(productStudioCampaignAssignees)
        .where(and(eq(productStudioCampaignAssignees.campaignId, Number(active.campaignId)), eq(productStudioCampaignAssignees.userId, actor.userId)))
        .limit(1)
    )[0];
    if (!member && !isManager(actor)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لستَ ضمن مصوّري هذه الحملة" });
    }
    await tx
      .update(productImageJobs)
      .set({ assignedTo: actor.userId, assignedBy: actor.userId, assignedAt: new Date(), revision: sql`${productImageJobs.revision} + 1` })
      .where(eq(productImageJobs.id, active.id));
    await tx.insert(auditLogs).values(
      auditValues(actor, "productStudio.claimByBarcode", Number(active.id), { productId, barcode: barcode.slice(0, 64), campaignId: Number(active.campaignId) }),
    );
    return { taskId: Number(active.id), productName: resolved.productName, claimed: true as const, revision: Number(active.revision) + 1, ...(await studioImageProgress(tx, productId, Number(active.campaignId))) };
  });
}

export async function resolveStudioBarcode(actor: ProductStudioActor, barcode: string) {
  // بحثٌ أوّليّ باحترام صلاحيّة المستخدم — يعطي المنتج النشط إن وُجد.
  const activeOnly = await listStudioProducts(actor, {
    search: barcode,
    includeInactive: isManager(actor),
  });
  const activeMatch = activeOnly.rows.find((row) => row.matchKind === "BARCODE_PRIMARY" || row.matchKind === "BARCODE_ALIAS");
  if (activeMatch) {
    return {
      productId: activeMatch.productId,
      productName: activeMatch.productName,
      variantId: activeMatch.variantId,
      variantName: activeMatch.variantName,
      unitId: activeMatch.unitId,
      unitName: activeMatch.unitName,
      isActive: activeMatch.isActive,
      matchKind: activeMatch.matchKind,
    };
  }
  // بحثٌ ثانٍ يشمل المُعطَّل — إن وُجد، فرّق الرسالة كي لا يظنّ المصوّر أنّ الماسح مكسور
  // أو الباركود مطبوعٌ خطأ. قبل هذا: كل الحالات ⇒ «الباركود غير معروف» رسالةً واحدة.
  // تمريرُ دور «admin» هنا آمن: `listStudioProducts` يقصر `includeInactive` على المدير
  // فقط، والكتالوج نفسه ليس مُفرَّعاً (المنتجات مشتركة بين الفروع) ⇒ لا تسريبَ عبر فروع
  // من إظهار اسم منتجٍ معطَّل — نفس الاسم يظهر لكل مدير في النظام.
  if (!isManager(actor)) {
    const withInactive = await listStudioProducts({ ...actor, role: "admin" }, {
      search: barcode,
      includeInactive: true,
    });
    const inactiveMatch = withInactive.rows.find(
      (row) => (row.matchKind === "BARCODE_PRIMARY" || row.matchKind === "BARCODE_ALIAS") && row.isActive === false,
    );
    if (inactiveMatch) {
      throw new TRPCError({ code: "NOT_FOUND", message: `«${inactiveMatch.productName}» منتجٌ معطَّل — راجع المدير قبل تصويره` });
    }
  }
  throw new TRPCError({ code: "NOT_FOUND", message: "الباركود غير معروف — لم يُطابق أيّ منتجٍ في نظامك" });
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
  // تُعاد **كل** كوادر الفرع، لا من يملك الصلاحية فقط، مع علَمٍ يفصل بينهم.
  // كان الترشيح يُخفي الكاشير والمندوب وغيرهم فيبدو للمدير أنّ موظفيه «ناقصون» بلا سبب
  // ظاهر — ولا يعرف أنّ العلّة صلاحيةٌ مفقودة ولا أين يمنحها.
  return rows
    .filter((u) => canCrossBranches(actor) || Number(u.branchId) === Number(actor.branchId))
    .map(({ id, name, role, branchId, permissionsOverride }) => ({
      id,
      name: name || `مستخدم ${id}`,
      role,
      branchId,
      canStudio: hasModuleAccess(role, permissionsOverride as PermissionMap | null, "productStudio", "FULL"),
    }));
}

/**
 * منحُ صلاحية استوديو المنتجات لموظفٍ في فرع المدير — بفعلٍ صريحٍ مُدقَّق.
 *
 * لماذا من هنا: المدير يرى فريقه في شاشة الحملة، وإرسالُه إلى شاشة المستخدمين ليمنح
 * وحدةً واحدة ثمّ يعود احتكاكٌ بلا فائدة. ولماذا **بزرٍّ لا تلقائياً عند الاختيار**:
 * توسيعُ صلاحيةٍ فعلٌ يستحقّ قصداً صريحاً وأثراً، لا أثراً جانبياً لاختيارٍ في نموذج.
 *
 * النطاق ضيّقٌ عمداً: يفتح `productStudio` وحده ولا يمسّ أيّ وحدةٍ أخرى، ولا يعمل عبر
 * الفروع لغير من يعبرها، ولا يرفع دور المستخدم.
 */
export async function grantStudioAccess(actor: ProductStudioActor, userId: number) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  return withStudioTx(async (tx) => {
    const [target] = await tx
      .select({ id: users.id, name: users.name, role: users.role, branchId: users.branchId, permissionsOverride: users.permissionsOverride })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.isActive, true)))
      .limit(1)
      .for("update");
    if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير متاح" });
    if (!canCrossBranches(actor) && (actor.branchId == null || Number(target.branchId) !== Number(actor.branchId))) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن منح صلاحية لموظفٍ من فرعٍ آخر" });
    }
    if (hasModuleAccess(target.role, target.permissionsOverride as PermissionMap | null, "productStudio", "FULL")) {
      return { granted: false as const, name: target.name };
    }
    const nextOverride: PermissionMap = { ...((target.permissionsOverride as PermissionMap | null) ?? {}), productStudio: "FULL" };
    await tx.update(users).set({ permissionsOverride: nextOverride }).where(eq(users.id, userId));
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: actor.branchId,
      action: "productStudio.grantAccess",
      entityType: "user",
      entityId: String(userId),
      oldValue: { productStudio: hasModuleAccess(target.role, target.permissionsOverride as PermissionMap | null, "productStudio", "READ") ? "READ" : "NONE" },
      newValue: { productStudio: "FULL" },
    });
    return { granted: true as const, name: target.name };
  });
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
    /** نطاق الحملة: الكتالوج كلّه · فئةٌ (بفئاتها الفرعية) · مجموعةٌ مختارة صراحةً. */
    scopeKind?: "ALL" | "CATEGORY" | "PRODUCTS";
    scopeCategoryId?: number | null;
    scopeProductIds?: number[];
    /** التوجيه الإداريّ لعدد الصور المطلوبة لكل منتج. */
    requiredImages?: number;
    /** مصوّرو الحملة — تُسنَد إلى عدّة موظفين، ومنها يسحب كلٌّ منهم ما يمسح باركوده. */
    assigneeIds?: number[];
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
  const status = input.status ?? "DRAFT";
  const startsAt = status === "ACTIVE" ? (input.startsAt ?? new Date()) : (input.startsAt ?? null);
  if (startsAt && input.dueAt && input.dueAt <= startsAt) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "موعد الحملة يجب أن يكون بعد بدايتها",
    });
  }
  const branchId = campaignBranchId(actor, input.branchId);
  const scopeKind = input.scopeKind ?? "ALL";
  const requiredImages = Math.max(1, Math.min(Math.trunc(input.requiredImages ?? 1), MAX_REQUIRED_IMAGES));
  const scopeProductIds = Array.from(new Set((input.scopeProductIds ?? []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)));
  const assigneeIds = Array.from(new Set((input.assigneeIds ?? []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)));
  // النطاق يجب أن يحمل ما يصفه، وإلّا كانت الحملة فارغةً بلا أن يدري منشئها.
  if (scopeKind === "CATEGORY" && !input.scopeCategoryId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "اختر الفئة قبل حفظ حملةٍ بنطاق فئة" });
  }
  if (scopeKind === "PRODUCTS" && scopeProductIds.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "اختر منتجاً واحداً على الأقل قبل حفظ حملةٍ بنطاق منتجات" });
  }
  if (scopeProductIds.length > MAX_CAMPAIGN_PRODUCTS) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `أقصى عدد منتجاتٍ للحملة الواحدة ${MAX_CAMPAIGN_PRODUCTS}` });
  }
  return withStudioTx(async (tx) => {
    const [created] = await tx
      .insert(productStudioCampaigns)
      .values({
        name,
        branchId,
        status,
        startsAt,
        dueAt: input.dueAt ?? null,
        scopeKind,
        scopeCategoryId: scopeKind === "CATEGORY" ? Number(input.scopeCategoryId) : null,
        requiredImages,
        createdBy: actor.userId,
      })
      .$returningId();
    const campaignId = Number(created.id);
    if (scopeKind === "PRODUCTS") {
      await tx.insert(productStudioCampaignProducts).values(scopeProductIds.map((productId) => ({ campaignId, productId })));
    }
    if (assigneeIds.length > 0) {
      await assertCampaignAssignees(tx, actor, branchId, assigneeIds);
      await tx.insert(productStudioCampaignAssignees).values(assigneeIds.map((userId) => ({ campaignId, userId, createdBy: actor.userId })));
    }
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId,
      action: "productStudio.campaign.create",
      entityType: "productStudioCampaign",
      entityId: String(campaignId),
      newValue: { name, status, scopeKind, scopeCategoryId: input.scopeCategoryId ?? null, productCount: scopeProductIds.length, requiredImages, assigneeIds },
    });
    return {
      campaignId,
      name,
      branchId,
      status,
      startsAt,
      dueAt: input.dueAt ?? null,
      scopeKind,
      requiredImages,
      assigneeIds,
    };
  });
}

export async function transitionStudioCampaign(
  actor: ProductStudioActor,
  input: {
    campaignId: number;
    status: StudioCampaignStatus;
    startsAt?: Date | null;
    dueAt?: Date | null;
    /** سبب إلغاء الحملة — يُنسَخ على كل مهمة طابورٍ تُلغى معها. */
    reason?: string | null;
  },
) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  return withStudioTx(async (tx) => {
    const campaign = (
      await tx
        .select()
        .from(productStudioCampaigns)
        .where(eq(productStudioCampaigns.id, input.campaignId))
        .limit(1)
        .for("update")
    )[0];
    if (!campaign) {
      throw new TRPCError({ code: "NOT_FOUND", message: "حملة الاستوديو غير موجودة" });
    }
    assertCampaignAccess(actor, campaign);
    const legal =
      (campaign.status === "DRAFT" &&
        (input.status === "ACTIVE" || input.status === "CANCELLED")) ||
      (campaign.status === "ACTIVE" &&
        (input.status === "COMPLETED" || input.status === "CANCELLED"));
    if (!legal) {
      throw new TRPCError({ code: "CONFLICT", message: "انتقال حالة الحملة غير مسموح" });
    }
    const startsAt =
      input.status === "ACTIVE"
        ? (input.startsAt ?? campaign.startsAt ?? new Date())
        : campaign.startsAt;
    const dueAt = input.dueAt === undefined ? campaign.dueAt : input.dueAt;
    if (startsAt && dueAt && dueAt <= startsAt) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "موعد الحملة يجب أن يكون بعد بدايتها" });
    }
    await tx
      .update(productStudioCampaigns)
      .set({ status: input.status, startsAt, dueAt })
      .where(eq(productStudioCampaigns.id, input.campaignId));
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: Number(campaign.branchId),
      action: "productStudio.campaign.transition",
      entityType: "productStudioCampaign",
      entityId: String(input.campaignId),
      oldValue: { status: campaign.status },
      newValue: {
        status: input.status,
        startsAt: startsAt?.toISOString() ?? null,
        dueAt: dueAt?.toISOString() ?? null,
      },
    });
    // إلغاء الحملة يجرّ طابورها: كان الانتقال يمسّ صفّ الحملة وحده، فتبقى مهامها في
    // الطابور وفي المؤشّرات وتحتجز منتجاتها رغم أنّ حملتها أُلغيت.
    // النطاق هو نفسه المُضيَّق في الإلغاء الصريح — غير المسنَد فقط: عملٌ بدأه موظف
    // لا يُمحى تبعاً لقرارٍ إداريّ على الحملة، بل يُلغى فرداً فرداً بقرارٍ مرئيّ.
    const cascade =
      input.status === "CANCELLED"
        ? await cancelCampaignQueuedTasksInTx(tx, actor, campaign, input.reason?.trim() || `أُلغيت مع حملة «${campaign.name}» (#${input.campaignId})`, "productStudio.campaign.cancelWithCampaign")
        : { cancelledCount: 0, remaining: 0 };
    return {
      campaignId: input.campaignId,
      status: input.status,
      startsAt,
      dueAt,
      cancelledTasks: cascade.cancelledCount,
      /** مهام طابورٍ لم تُلغَ بعد لأنّ الدفعة محدودة — تُستكمل بزرّ إلغاء الطابور. */
      remainingTasks: cascade.remaining,
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

/**
 * حملاتُ المصوّر التي هو عضوٌ فيها — نافذته الوحيدة على «ماذا يخصّني».
 *
 * قبل هذه الدالة كان `campaigns` محصوراً بالمدير، فالمصوّر لا يرى اسم حملتِه ولا موعدها
 * ولا كم منتجاً بقي منها، ويعمل «أعمى» يمسح باركوداً ثمّ آخر بلا صورةِ تقدّم. فتحُ
 * `campaigns` كاملةً كان سيسرّب حملاتٍ ليس فيها ولا يعنيه أمرها؛ لذا `myCampaigns`
 * قراءةٌ ضيّقة: **الحملات النشطة التي هو عضوٌ فيها فقط**، مع رقمَين تشغيليَّين:
 * ما أنجزه هو، وما تبقّى في الحملة كلّها.
 *
 * `assignedActive` = مهمّةٌ بيده الآن (نطاق `MINE`). `personalDone` = مهمّةٌ اعتُمدت
 * وكان هو مُنفّذها الأخير. `campaignRemaining` بوحدة **المنتجات** لا المهام —
 * توافقاً مع لوحة المدير في `getStudioCampaignBoard`. مؤشّراتٌ ثلاثة تكفي لعينَي المصوّر.
 */
export async function listMyStudioCampaigns(actor: ProductStudioActor) {
  const userId = Number(actor.userId);
  if (!Number.isSafeInteger(userId) || userId < 1) return [];
  const db = requireDb();
  const branchFilter = canCrossBranches(actor)
    ? undefined
    : actor.branchId == null
      ? sql`1 = 0`
      : eq(productStudioCampaigns.branchId, Number(actor.branchId));
  const rows = await db
    .select({
      id: productStudioCampaigns.id,
      name: productStudioCampaigns.name,
      branchId: productStudioCampaigns.branchId,
      status: productStudioCampaigns.status,
      startsAt: productStudioCampaigns.startsAt,
      dueAt: productStudioCampaigns.dueAt,
      scopeKind: productStudioCampaigns.scopeKind,
      scopeCategoryId: productStudioCampaigns.scopeCategoryId,
      requiredImages: productStudioCampaigns.requiredImages,
      personalActive: sql<number>`(
        select count(*) from ${productImageJobs}
        where ${productImageJobs.campaignId} = ${productStudioCampaigns.id}
        and ${productImageJobs.assignedTo} = ${userId}
        and ${productImageJobs.status} in ('ASSIGNED','IN_PROGRESS','REJECTED')
      )`,
      personalPending: sql<number>`(
        select count(*) from ${productImageJobs}
        where ${productImageJobs.campaignId} = ${productStudioCampaigns.id}
        and ${productImageJobs.assignedTo} = ${userId}
        and ${productImageJobs.status} = 'PENDING_REVIEW'
      )`,
      personalDone: sql<number>`(
        select count(*) from ${productImageJobs}
        where ${productImageJobs.campaignId} = ${productStudioCampaigns.id}
        and ${productImageJobs.assignedTo} = ${userId}
        and ${productImageJobs.status} = 'APPROVED'
      )`,
    })
    .from(productStudioCampaigns)
    .innerJoin(
      productStudioCampaignAssignees,
      and(
        eq(productStudioCampaignAssignees.campaignId, productStudioCampaigns.id),
        eq(productStudioCampaignAssignees.userId, userId),
      ),
    )
    .where(and(eq(productStudioCampaigns.status, "ACTIVE"), branchFilter))
    .orderBy(asc(productStudioCampaigns.dueAt), asc(productStudioCampaigns.id));

  // إجماليّ الحملة (منتجات نُفّذت / متبقّية) يُشتقّ خارج الاستعلام بنفس صيغة لوحة
  // المدير: تسلسليّاً على عددٍ صغير من الحملات لا يبرّر تعقيداً إضافياً في SQL.
  return Promise.all(
    rows.map(async (row) => {
      const required = Math.max(1, Number(row.requiredImages ?? 1));
      const scope: CampaignScope = {
        id: Number(row.id),
        scopeKind: row.scopeKind as "ALL" | "CATEGORY" | "PRODUCTS",
        scopeCategoryId: row.scopeCategoryId as number | null,
        requiredImages: required,
      };
      const [totals] = await db
        .select({
          total: sql<number>`count(*)`,
          complete: sql<number>`sum(case when (select count(*) from ${productImages} where ${productImages.productId} = ${products.id} and ${productImages.reviewStatus} = 'APPROVED') >= ${required} then 1 else 0 end)`,
        })
        .from(products)
        .where(and(eq(products.isActive, true), campaignScopeCondition(scope)));
      const totalProducts = Number(totals?.total ?? 0);
      const campaignDone = Number(totals?.complete ?? 0);
      return {
        campaignId: Number(row.id),
        name: row.name,
        branchId: row.branchId == null ? null : Number(row.branchId),
        status: row.status as "DRAFT" | "ACTIVE" | "COMPLETED" | "CANCELLED",
        startsAt: row.startsAt,
        dueAt: row.dueAt,
        requiredImages: required,
        personal: {
          active: Number(row.personalActive ?? 0),
          pendingReview: Number(row.personalPending ?? 0),
          done: Number(row.personalDone ?? 0),
        },
        campaign: {
          done: campaignDone,
          remaining: Math.max(0, totalProducts - campaignDone),
          totalProducts,
        },
      };
    }),
  );
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

/**
 * «ناقص» = منتج نشط بلا صورةٍ معتمدة وبلا مهمة استوديو نشطة.
 * الاستبعاد يجري داخل SQL لا في ذاكرة Node: النسخة السابقة كانت تسحب كل المنتجات النشطة
 * وكل صفوف الصور والمهام المطابقة ثم تطرح بينها بـSet — تكلفةٌ تنمو مع الكتالوج كلّه في كل معاينة.
 */
/**
 * شرط النطاق: الكتالوج كلّه · فئةٌ **بكامل شجرتها الفرعية** (عمقٌ غير محدود) · مجموعةٌ مختارة.
 *
 * قبل هذا: `parentId = X` وحدها ⇒ العمق **مستويان فقط** بلا إعلان. شجرةٌ ثلاثيّةٌ
 * «قرطاسية → أوراق → دفاتر» تُسقط أحفاد `دفاتر` صامتاً، ولوحةُ المدير تعلن «الحملة
 * مكتملة» بينما شجرةٌ كاملةٌ لم تُولَّد لها مهمّةٌ قط. الجذر: تدقيق ٢٤/٨ (بنك الوكلاء الخامس).
 *
 * الحلّ: **CTE عودي** (MySQL 8 يدعمه بلا امتداد) يبدأ من الفئة المطلوبة ويتوسّع نزولاً
 * إلى كل الأحفاد. كلفة الحساب على شجرةٍ عمقها N هي N جولات صغيرة بحجم عرضِ الشجرة —
 * أسرع من N استعلاماً منفصلاً في Node، وأدقّ من التقطيع بالعمق.
 */
function campaignScopeCondition(campaign: { id: number | string; scopeKind: "ALL" | "CATEGORY" | "PRODUCTS"; scopeCategoryId: number | null }) {
  if (campaign.scopeKind === "CATEGORY") {
    const categoryId = Number(campaign.scopeCategoryId);
    return sql`${products.categoryId} in (
      with recursive category_tree (id) as (
        select ${categoryId}
        union all
        select ${categories.id} from ${categories}
        inner join category_tree on ${categories.parentId} = category_tree.id
      )
      select id from category_tree
    )`;
  }
  if (campaign.scopeKind === "PRODUCTS") {
    return sql`exists (select 1 from ${productStudioCampaignProducts} where ${productStudioCampaignProducts.campaignId} = ${Number(campaign.id)} and ${productStudioCampaignProducts.productId} = ${products.id})`;
  }
  return undefined;
}

/**
 * «ناقص» = منتج نشط لم يبلغ **عدد الصور الذي تطلبه الحملة** وبلا مهمة نشطة.
 *
 * كان التعريف «بلا أيّ صورة معتمدة» — أي أنّ المنتج يخرج من الطابور بعد أوّل صورة.
 * فتوجيهُ «ثلاث صور» كان سيبقى زينةً: لا شيء يُطالب بالثانية والثالثة. العدّ يجعل
 * التوجيه نافذاً بلا تغيير عقد الإرسال: دورةٌ لكل صورة على المسار المُثبَت نفسه.
 */
function missingStudioProductConditions(requiredImages = 1) {
  const required = Math.max(1, Math.trunc(requiredImages));
  return and(
    eq(products.isActive, true),
    sql`(select count(*) from ${productImages} where ${productImages.productId} = ${products.id} and ${productImages.reviewStatus} = 'APPROVED') < ${required}`,
    sql`not exists (select 1 from ${productImageJobs} where ${productImageJobs.productId} = ${products.id} and ${productImageJobs.activeSlot} = 1)`,
  );
}

type CampaignScope = { id: number | string; scopeKind: "ALL" | "CATEGORY" | "PRODUCTS"; scopeCategoryId: number | null; requiredImages?: number | null };

async function countMissingStudioProducts(db: ReturnType<typeof requireDb> | StudioTx, campaign?: CampaignScope) {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(products)
    .where(and(missingStudioProductConditions(campaign?.requiredImages ?? 1), campaign ? campaignScopeCondition(campaign) : undefined));
  return Number(row?.count ?? 0);
}

async function missingStudioProducts(db: ReturnType<typeof requireDb> | StudioTx, limit: number, campaign?: CampaignScope) {
  return db
    .select({
      id: products.id,
      name: products.name,
      description: products.description,
    })
    .from(products)
    .where(and(missingStudioProductConditions(campaign?.requiredImages ?? 1), campaign ? campaignScopeCondition(campaign) : undefined))
    .orderBy(asc(products.id))
    .limit(limit);
}

export async function previewStudioCampaignBacklog(actor: ProductStudioActor, campaignId: number) {
  const campaign = await loadCampaign(actor, campaignId);
  const db = requireDb();
  const count = await countMissingStudioProducts(db, campaign);
  const items = count === 0 ? [] : await missingStudioProducts(db, 100, campaign);
  return {
    campaignId: Number(campaign.id),
    count,
    items: items.map((product) => ({ id: Number(product.id), name: product.name })),
    truncated: count > items.length,
    /** أقصى ما تُنشئه دفعةٌ واحدة؛ تُظهره الشاشة كي يعرف المدير أنّ عليه تكرار التوليد. */
    batchLimit: BACKLOG_BATCH_LIMIT,
  };
}

export async function createStudioCampaignBacklog(actor: ProductStudioActor, campaignId: number) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  return withStudioTx(async (tx) => {
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

    // دفعةٌ محدودة لكل استدعاء. النسخة السابقة كانت تقفل كل منتجٍ نشط بـFOR UPDATE في
    // معاملةٍ واحدة (٤٢٨٥ صفاً في الإنتاج) فتحجب أيّ كتابةٍ على الكتالوج طوال تنفيذها،
    // وتُبقي بوّابة القيد المالي المشتركة محجوزةً معها.
    const missing = await missingStudioProducts(tx, BACKLOG_BATCH_LIMIT, campaign);
    if (missing.length === 0) return { createdCount: 0, remaining: 0 };
    const ids = missing.map((product) => Number(product.id));
    await tx.select({ id: products.id }).from(products).where(inArray(products.id, ids)).for("update");
    // حرسُ سباق: حملتان نشطتان بنطاقٍ متقاطع تحسبان الناقص قبل أيّ إدراج، ثمّ تتسابقان
    // على القيد الفريد `(productId, activeSlot)`. `onDuplicateKeyUpdate` بضبطٍ ذاتيّ
    // يُحوّل الاصطدام إلى **تخطٍّ صامتٍ ذرّيّ** (`affectedRows=0`) بدل إسقاط الدفعة
    // كاملةً بـER_DUP_ENTRY. `createdCount` يُشتقّ من `affectedRows` لا من طول القائمة،
    // فلا يُبالِغ عند وجود تكراراتٍ. جذر الثغرة: تدقيق ٢٤/٨ (بنك الوكلاء الخامس).
    const insertResult = await tx
      .insert(productImageJobs)
      .values(
        missing.map((product) => ({
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
      )
      .onDuplicateKeyUpdate({ set: { productId: sql`productId` } });
    const affected = Number(
      (insertResult as unknown as [{ affectedRows?: number }])[0]?.affectedRows ??
        (insertResult as unknown as { affectedRows?: number }).affectedRows ??
        missing.length,
    );
    // MySQL يعيد ١ لكل صفٍّ مُدرَج و٠ للتصادم الذاتيّ (لا تغيّرَ حقيقي).
    const createdCount = Math.max(0, Math.min(missing.length, affected));
    // «تجاوَزَتنا حملةٌ أخرى» — يُسجَّل في التدقيق ولا يُبثّ في الجسم لأنّ الشاشة القائمة
    // تعتمد الشكل `{createdCount, remaining}` فحسب؛ توسّعُ العقد يتبع الحاجة.
    const skippedDuplicates = missing.length - createdCount;
    const remaining = await countMissingStudioProducts(tx, campaign);
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: Number(campaign.branchId),
      action: "productStudio.campaign.createBacklog",
      entityType: "productStudioCampaign",
      entityId: String(campaignId),
      newValue: { createdCount, skippedDuplicates, attempted: missing.length, remaining },
    });
    return { createdCount, remaining };
  });
}

/**
 * لوحة الحملة كما تريدها الإدارة: **طابور الإنجاز وطابور المتبقّي** ومن يعمل على ماذا.
 *
 * «المتبقّي» ليس رقماً واحداً بل ثلاثة أرقامٍ مختلفة المعنى — لم تُصوَّر بعد، وقيد
 * التصوير، وتنتظر اعتمادك. جمعُها في رقمٍ واحد يُخفي أين يقف العمل فعلاً.
 */
/**
 * تعديلُ عضويّة الحملة بعد إنشائها — إضافة/إزالة مصوّرين على حملةٍ قائمة.
 *
 * قبل هذه الدالة كان الوحيد لإضافة موظفٍ حقيقيّ هو إعادة إنشاء الحملة كاملةً
 * (لأنّ `assigneeIds` تُقرأ عند الإنشاء فقط) — أو استعمالُ حساب مصوّرٍ مؤقّتٍ لموظفٍ
 * موجودٍ أصلاً، وهذا خلطٌ لهويّات لا داعي له. الآن الإضافة نمطٌ إداريّ عاديّ: يستقبل
 * قائمة المصوّرين النهائية ويوفّق الجدول عليها (upsert للجدد، حذفٌ لمن أُخرج).
 *
 * القيود: (١) الفرعُ فرعُ الحملة كما في `createStudioCampaign` — لا عبور، (٢) العضو
 * يجب أن يملك `productStudio: FULL` (منح تلقائيّ عبر شاشة الاستوديو)، (٣) لا يُمسّ حسابٌ
 * مؤقّت (`openId` بادئتها `studio-temp:`) — إبطاله يمرّ عبر `revokeTemporaryPhotographers`.
 */
export async function updateCampaignAssignees(actor: ProductStudioActor, input: { campaignId: number; assigneeIds: number[] }) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const uniqueIds = Array.from(new Set(input.assigneeIds.map((id) => Number(id))));
  if (uniqueIds.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "معرّف مصوّرٍ غير صالح" });
  }
  return withStudioTx(async (tx) => {
    const [campaign] = await tx.select().from(productStudioCampaigns).where(eq(productStudioCampaigns.id, input.campaignId)).limit(1).for("update");
    if (!campaign) throw new TRPCError({ code: "NOT_FOUND", message: "حملة الاستوديو غير موجودة" });
    assertCampaignAccess(actor, campaign);
    if (campaign.status === "CANCELLED" || campaign.status === "COMPLETED") {
      throw new TRPCError({ code: "CONFLICT", message: "لا يمكن تعديل مصوّري حملةٍ مُغلقة" });
    }
    const existing = await tx
      .select({ id: productStudioCampaignAssignees.id, userId: productStudioCampaignAssignees.userId, openId: users.openId, isActive: users.isActive })
      .from(productStudioCampaignAssignees)
      .innerJoin(users, eq(users.id, productStudioCampaignAssignees.userId))
      .where(eq(productStudioCampaignAssignees.campaignId, input.campaignId));
    // الحسابات المؤقّتة (`studio-temp:*`) خارج التوفيق — لها مسارٌ إبطالٍ مستقل. وحسابٌ
    // مؤقّتٌ منتهي الصلاحية يبقى صفّه في `productStudioCampaignAssignees` بينما يصير المستخدم
    // `isActive=false`، فيظهر على لوحة الحملة (`getStudioCampaignBoard`) لكنه غائبٌ عن قائمة
    // المصوّرين في الشاشة (`listStudioAssignees` يفرض `isActive=true`). المصدر يُرسل هذا الـID
    // ضمن القائمة النهائيّة، فيرفضه `assertCampaignAssignees` (لا يجد المستخدم) بـBAD_REQUEST
    // ويُغلق كلّ تعديلٍ للفريق. الحلّ: **استبعادُ معرّفات الحسابات المؤقّتة من التحقّق ومن التوفيق**
    // كأنّها ليست في القائمة أصلاً (الجذر: مراجعة Codex P2 على PR #776، ٢٥/٨).
    const tempMemberIds = new Set(existing.filter((row) => (row.openId ?? "").startsWith("studio-temp:")).map((row) => Number(row.userId)));
    const idsForValidation = uniqueIds.filter((id) => !tempMemberIds.has(id));
    if (idsForValidation.length > 0) await assertCampaignAssignees(tx, actor, Number(campaign.branchId), idsForValidation);
    const permanentExisting = existing.filter((row) => !tempMemberIds.has(Number(row.userId)));
    const existingIds = new Set(permanentExisting.map((row) => Number(row.userId)));
    const nextIds = new Set(idsForValidation);
    const toAdd = idsForValidation.filter((id) => !existingIds.has(id));
    const toRemove = permanentExisting.filter((row) => !nextIds.has(Number(row.userId))).map((row) => Number(row.userId));
    if (toAdd.length > 0) {
      await tx
        .insert(productStudioCampaignAssignees)
        .values(toAdd.map((userId) => ({ campaignId: input.campaignId, userId, createdBy: actor.userId })))
        // القيد الفريد `uq_psca_campaign_user` يقلب سباقاً على نفس الإضافة إلى تكرارٍ آمن.
        .onDuplicateKeyUpdate({ set: { campaignId: sql`campaignId` } });
    }
    if (toRemove.length > 0) {
      await tx
        .delete(productStudioCampaignAssignees)
        .where(and(eq(productStudioCampaignAssignees.campaignId, input.campaignId), inArray(productStudioCampaignAssignees.userId, toRemove)));
    }
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: Number(campaign.branchId),
      action: "productStudio.campaign.updateAssignees",
      entityType: "productStudioCampaign",
      entityId: String(input.campaignId),
      oldValue: { assigneeIds: Array.from(existingIds) },
      newValue: { assigneeIds: idsForValidation, added: toAdd, removed: toRemove, ignoredTempAccounts: Array.from(tempMemberIds).filter((id) => uniqueIds.includes(id)) },
    });
    return { campaignId: input.campaignId, added: toAdd.length, removed: toRemove.length, total: idsForValidation.length };
  });
}

/** سقفٌ افتراضيّ لعمر الحساب المؤقّت حين تكون الحملة بلا موعد — لا حسابَ بلا نهاية. */
const TEMP_ACCOUNT_FALLBACK_DAYS = 30;

/**
 * خريطة صلاحيات: **كل شيء مغلق عدا استوديو المنتجات**.
 * تُبنى بحلّ قالب الدور ثمّ إغلاق كل مفاتيحه — لا بقائمةٍ يدوية تشيخ كلّما أُضيفت وحدة.
 */
function studioOnlyPermissions(): PermissionMap {
  const resolved = resolvePermissions("print_operator", null);
  const locked: PermissionMap = {};
  for (const key of Object.keys(resolved)) locked[key] = "NONE";
  locked.productStudio = "FULL";
  return locked;
}

/** طول رمز الدخول المؤقّت — قويٌّ لا PIN. عشرون محرفاً من أبجديةٍ بلا أحرفٍ ملتبسة. */
const TEMP_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TEMP_CODE_LENGTH = 20;

function generateTemporaryCode(): string {
  const bytes = randomBytes(TEMP_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < TEMP_CODE_LENGTH; i++) code += TEMP_CODE_ALPHABET[bytes[i]! % TEMP_CODE_ALPHABET.length];
  // مجموعاتٌ من خمسة للقراءة الصوتيّة عند التسليم.
  return (code.match(/.{1,5}/g) ?? [code]).join("-");
}

/**
 * حسابُ مصوّرٍ مؤقّت لحملةٍ بعينها — بديلُ «PIN مؤقّت» الذي طلبه المالك.
 *
 * **لماذا لا PIN:** رمزٌ قصير ليس باباً إلى الاستوديو بل إلى النظام كلّه (نقد، رواتب،
 * ذمم موردّين) — ومن دخل به يصل إلى ما تصله صلاحيته. البديل يعطي الفائدة نفسها بلا
 * الثغرة: حسابٌ حقيقيّ يمرّ بمسار المصادقة المُحصَّن نفسه، برمزٍ **مولَّدٍ قويّ** يُعرَض
 * مرّةً واحدة، وبصلاحيةٍ زمنيّة تنتهي وحدها.
 *
 * ثلاثة قيود تجعله آمناً:
 * ١) `permissionsOverride` يُغلق **كل** الوحدات ويفتح `productStudio` وحدها — قالب
 *    `print_operator` وحده يفتح CRM وأوامر الشغل وغيرها، وهو أوسع بكثير من مصوّرٍ مؤقّت.
 * ٢) `accessExpiresAt` يُفرَض مركزياً في الجلسة ⇒ ينغلق الوصول وحده ولو بقيت الجلسة مفتوحة.
 * ٣) الرمز لا يُخزَّن ولا يُسترجَع — يُعرَض مرّةً للمدير ليسلّمه، وبعدها لا سبيل إليه إلّا التوليد من جديد.
 */
export async function createTemporaryCampaignPhotographer(actor: ProductStudioActor, input: { campaignId: number; name: string }) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const name = input.name.trim();
  if (name.length < 3 || name.length > 80) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "اسم المصوّر يجب أن يكون بين ٣ و٨٠ حرفاً" });
  }
  const campaign = await loadCampaign(actor, input.campaignId);
  if (campaign.status !== "ACTIVE" && campaign.status !== "DRAFT") {
    throw new TRPCError({ code: "CONFLICT", message: "لا يُنشَأ مصوّر مؤقّت لحملةٍ منتهية أو ملغاة" });
  }
  // الانتهاء يتبع موعد الحملة، وبسقفٍ افتراضيّ إن كانت بلا موعد — لا حسابَ بلا نهاية.
  const expiresAt = campaign.dueAt ?? new Date(Date.now() + TEMP_ACCOUNT_FALLBACK_DAYS * 24 * 60 * 60_000);
  if (expiresAt.getTime() <= Date.now()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "موعد الحملة مضى؛ حدّثه قبل إنشاء مصوّر مؤقّت" });
  }
  const code = generateTemporaryCode();
  const passwordHash = await hashPassword(code);
  const username = `cam-${input.campaignId}-${randomBytes(4).toString("hex")}`;
  const result = await withStudioTx(async (tx) => {
    const [created] = await tx
      .insert(users)
      .values({
        openId: `studio-temp:${username}`,
        name,
        username,
        passwordHash,
        role: "print_operator",
        branchId: Number(campaign.branchId),
        isActive: true,
        accessExpiresAt: expiresAt,
        // كل الوحدات مغلقة عدا الاستوديو — القالب وحده أوسع من الحاجة بكثير.
        permissionsOverride: studioOnlyPermissions(),
      })
      .$returningId();
    const userId = Number(created.id);
    await tx.insert(productStudioCampaignAssignees).values({ campaignId: input.campaignId, userId, createdBy: actor.userId });
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: Number(campaign.branchId),
      action: "productStudio.campaign.temporaryPhotographer",
      entityType: "productStudioCampaign",
      entityId: String(input.campaignId),
      newValue: { temporaryUserId: userId, name, username, expiresAt: expiresAt.toISOString() },
    });
    return { userId, username };
  });
  // الرمز يُعاد مرّةً واحدة فقط — لا يُخزَّن نصّاً ولا يُسترجَع لاحقاً.
  return { ...result, name, code, expiresAt };
}

/**
 * إغلاق وصول مصوّري الحملة المؤقّتين فوراً. يُستدعى عند إلغاء الحملة أو إكمالها،
 * وبطلبٍ صريح من المدير. لا يحذف الحساب — الأثر التدقيقيّ يبقى منسوباً لصاحبه.
 */
export async function revokeTemporaryCampaignPhotographers(actor: ProductStudioActor, campaignId: number) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const campaign = await loadCampaign(actor, campaignId);
  return withStudioTx(async (tx) => {
    const rows = await tx
      .select({ userId: users.id })
      .from(productStudioCampaignAssignees)
      .innerJoin(users, eq(users.id, productStudioCampaignAssignees.userId))
      .where(and(eq(productStudioCampaignAssignees.campaignId, campaignId), like(users.openId, "studio-temp:%"), eq(users.isActive, true)));
    if (rows.length === 0) return { revoked: 0 };
    const ids = rows.map((row) => Number(row.userId));
    const now = new Date();
    // الانتهاء يُضبط في **الماضي** لا على «الآن»: عمود TIMESTAMP يقرّب ما دون الثانية لأعلى،
    // فضبطه على اللحظة نفسها قد يُخزَّن جزءاً من ثانيةٍ في المستقبل — أي «مُبطَلٌ» يقرؤه
    // حارس الجلسة صالحاً. ثانيةٌ إلى الوراء تُغلق النافذة يقيناً.
    const revokedAt = new Date(now.getTime() - 1000);
    // ثلاثيّ الإبطال: `accessExpiresAt` يمنع دخولاً جديداً، `isActive` يُسقط الحساب،
    // و`sessionsValidFrom` يُبطل كل توكنٍ قائم — لا يُعوَّل على واحدٍ منها وحده.
    await tx.update(users).set({ accessExpiresAt: revokedAt, isActive: false, sessionsValidFrom: now }).where(inArray(users.id, ids));
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: Number(campaign.branchId),
      action: "productStudio.campaign.revokeTemporary",
      entityType: "productStudioCampaign",
      entityId: String(campaignId),
      newValue: { revoked: ids },
    });
    return { revoked: ids.length };
  });
}

export async function getStudioCampaignBoard(actor: ProductStudioActor, campaignId: number) {
  const campaign = await loadCampaign(actor, campaignId);
  const db = requireDb();
  const scope = eq(productImageJobs.campaignId, campaignId);
  const [counts] = await db
    .select({
      queued: sql<number>`sum(case when ${productImageJobs.status} = 'ASSIGNED' and ${productImageJobs.assignedTo} is null then 1 else 0 end)`,
      inProgress: sql<number>`sum(case when ${productImageJobs.status} in ('ASSIGNED','IN_PROGRESS') and ${productImageJobs.assignedTo} is not null then 1 else 0 end)`,
      awaitingReview: sql<number>`sum(case when ${productImageJobs.status} = 'PENDING_REVIEW' then 1 else 0 end)`,
      needsFix: sql<number>`sum(case when ${productImageJobs.status} = 'REJECTED' then 1 else 0 end)`,
      done: sql<number>`sum(case when ${productImageJobs.status} = 'APPROVED' then 1 else 0 end)`,
      cancelled: sql<number>`sum(case when ${productImageJobs.status} = 'CANCELLED' then 1 else 0 end)`,
    })
    .from(productImageJobs)
    .where(scope);
  // ما لم تُولَّد له مهمّةٌ بعد داخل نطاق الحملة — جزءٌ من «المتبقّي» وإن لم يظهر في الجدول.
  const notGenerated = await countMissingStudioProducts(db, campaign);
  const perPhotographer = await db
    .select({
      userId: users.id,
      name: users.name,
      done: sql<number>`sum(case when ${productImageJobs.status} = 'APPROVED' then 1 else 0 end)`,
      active: sql<number>`sum(case when ${productImageJobs.status} in ('ASSIGNED','IN_PROGRESS','PENDING_REVIEW','REJECTED') then 1 else 0 end)`,
    })
    .from(productStudioCampaignAssignees)
    .innerJoin(users, eq(users.id, productStudioCampaignAssignees.userId))
    .leftJoin(productImageJobs, and(eq(productImageJobs.campaignId, campaignId), eq(productImageJobs.assignedTo, users.id)))
    .where(eq(productStudioCampaignAssignees.campaignId, campaignId))
    .groupBy(users.id, users.name);
  // الوحدة **منتجات** في الرقمين معاً. كان `done` يعُدّ مهامّ معتمَدة و`remaining` يخلط
  // مهامّاً بمنتجاتٍ لم تُولَّد ⇒ في حملةٍ تطلب ثلاث صور لمنتجٍ واحد تقرأ اللوحة
  // «أُنجز ١ · متبقٍّ ١» بعد أوّل صورة، وكلاهما عن الشيء نفسه.
  const required = Math.max(1, Number(campaign.requiredImages ?? 1));
  const [scopeTotals] = await db
    .select({
      total: sql<number>`count(*)`,
      complete: sql<number>`sum(case when (select count(*) from ${productImages} where ${productImages.productId} = ${products.id} and ${productImages.reviewStatus} = 'APPROVED') >= ${required} then 1 else 0 end)`,
    })
    .from(products)
    .where(and(eq(products.isActive, true), campaignScopeCondition(campaign)));
  const totalProducts = Number(scopeTotals?.total ?? 0);
  const done = Number(scopeTotals?.complete ?? 0);
  const remaining = Math.max(0, totalProducts - done);
  return {
    campaignId,
    name: campaign.name,
    status: campaign.status,
    scopeKind: campaign.scopeKind,
    requiredImages: Number(campaign.requiredImages ?? 1),
    /** منتجاتٌ بلغت عدد الصور المطلوب. */
    done,
    /** منتجاتٌ لم تبلغه بعد — نفس وحدة `done`. */
    remaining,
    totalProducts,
    /** توزيعُ **المهام** الجارية (وحدةٌ أخرى: مهمّة لا منتج) — يُسمّى كذلك في الشاشة. */
    breakdown: {
      notGenerated,
      queued: Number(counts?.queued ?? 0),
      inProgress: Number(counts?.inProgress ?? 0),
      awaitingReview: Number(counts?.awaitingReview ?? 0),
      needsFix: Number(counts?.needsFix ?? 0),
      cancelled: Number(counts?.cancelled ?? 0),
    },
    photographers: perPhotographer.map((row) => ({ userId: Number(row.userId), name: row.name, done: Number(row.done ?? 0), active: Number(row.active ?? 0) })),
  };
}

export async function getStudioCampaignAnalytics(actor: ProductStudioActor, campaignId: number) {
  const campaign = await loadCampaign(actor, campaignId);
  const jobs = await requireDb()
    .select({
      id: productImageJobs.id,
      status: productImageJobs.status,
      assignedTo: productImageJobs.assignedTo,
      rejectionReason: productImageJobs.rejectionReason,
      createdAt: productImageJobs.createdAt,
      reviewedAt: productImageJobs.reviewedAt,
    })
    .from(productImageJobs)
    .where(and(eq(productImageJobs.campaignId, campaignId), eq(productImageJobs.branchId, Number(campaign.branchId))));
  const ids = jobs.map((job) => String(job.id));
  const reviewAudits =
    ids.length === 0
      ? []
      : await requireDb()
          .select({
            id: auditLogs.id,
            entityId: auditLogs.entityId,
            action: auditLogs.action,
            newValue: auditLogs.newValue,
            createdAt: auditLogs.createdAt,
          })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.entityType, "productImageJob"),
              inArray(auditLogs.action, ["productStudio.approve", "productStudio.reject"]),
              inArray(auditLogs.entityId, ids),
            ),
          )
          .orderBy(asc(auditLogs.createdAt), asc(auditLogs.id));
  const rejects = reviewAudits.filter((row) => row.action === "productStudio.reject");
  const rejectedIds = new Set(
    rejects
      .map((row) => row.entityId)
      .filter((entityId): entityId is string => entityId != null),
  );
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
  // REVERTED is terminal only after revertStudioApproval restores an APPROVED source image
  // in the same transaction, so it is completed without being a currently approved candidate.
  const completedJobs = jobs.filter((job) => job.status === "APPROVED" || job.status === "REVERTED");
  const firstReviewOutcomeByJob = new Map<string, "APPROVED" | "REJECTED">();
  const firstApprovalAtByJob = new Map<string, Date>();
  for (const row of reviewAudits) {
    if (!row.entityId) continue;
    if (!firstReviewOutcomeByJob.has(row.entityId)) {
      firstReviewOutcomeByJob.set(
        row.entityId,
        row.action === "productStudio.approve" ? "APPROVED" : "REJECTED",
      );
    }
    if (row.action === "productStudio.approve" && !firstApprovalAtByJob.has(row.entityId)) {
      firstApprovalAtByJob.set(row.entityId, row.createdAt);
    }
  }
  const cycleMinutes = completedJobs
    .flatMap((job) => {
      const approvedAt = firstApprovalAtByJob.get(String(job.id));
      return approvedAt
        ? [Math.max(0, Math.round((approvedAt.getTime() - job.createdAt.getTime()) / 60_000))]
        : [];
    })
    .sort((a, b) => a - b);
  const middle = Math.floor(cycleMinutes.length / 2);
  const medianCycleMinutes = cycleMinutes.length === 0 ? null : cycleMinutes.length % 2 === 1 ? cycleMinutes[middle] : Math.round(((cycleMinutes[middle - 1] ?? 0) + (cycleMinutes[middle] ?? 0)) / 2);
  const firstReviewOutcomes = firstReviewOutcomeByJob.size;
  const firstPassApproved = Array.from(firstReviewOutcomeByJob.values()).filter(
    (outcome) => outcome === "APPROVED",
  ).length;
  return {
    campaignId,
    total: jobs.length,
    approved: approvedJobs.length,
    completed: completedJobs.length,
    rejected: jobs.filter((job) => job.status === "REJECTED").length,
    pendingReview: jobs.filter((job) => job.status === "PENDING_REVIEW").length,
    unassigned: jobs.filter((job) => job.assignedTo == null).length,
    completionPercent: jobs.length === 0 ? 0 : Math.round((completedJobs.length / jobs.length) * 100),
    firstPassApprovalRate: firstReviewOutcomes === 0 ? null : Math.round((firstPassApproved / firstReviewOutcomes) * 100),
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
  // تذكيرٌ فرديّ للمهام المسنَدة فقط والتي لم يفت موعدها بعد.
  // كان المسح يشمل المهام غير المسنَدة أيضاً (طابور الحملة كلّه) بلا سقف.
  const jobs = await requireDb()
    .select({
      id: productImageJobs.id,
      branchId: productImageJobs.branchId,
      assignedTo: productImageJobs.assignedTo,
      dueAt: productImageJobs.dueAt,
      assigneeRole: users.role,
    })
    .from(productImageJobs)
    .innerJoin(users, eq(users.id, productImageJobs.assignedTo))
    .where(and(branchScope, inArray(productImageJobs.status, ["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"]), gte(productImageJobs.dueAt, now), lte(productImageJobs.dueAt, horizon)))
    .orderBy(asc(productImageJobs.dueAt))
    .limit(DUE_REMINDER_SCAN_LIMIT);
  // المتأخّرات تُبلَّغ للمدير **مُجمَّعةً مرّةً في اليوم**، لا إشعاراً لكل مهمة.
  // الحملةُ تَسِم آلاف المهام بموعدٍ واحد، فكان كل نبضٍ (٥ د) يحاول إدراج
  // (عدد المتأخرات × عدد المديرين) إشعاراً تفشل كلّها على المفتاح الفريد — أبداً.
  const overdueByBranch = await requireDb()
    .select({ branchId: productImageJobs.branchId, count: sql<number>`count(*)` })
    .from(productImageJobs)
    .where(and(branchScope, inArray(productImageJobs.status, ["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"]), lt(productImageJobs.dueAt, now)))
    .groupBy(productImageJobs.branchId);
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
  const overdueDayKey = now.toISOString().slice(0, 10);
  for (const row of overdueByBranch) {
    if (row.branchId == null) continue;
    const overdueCount = Number(row.count);
    if (overdueCount === 0) continue;
    // شريحةُ العدّ (band) تدخل مفتاحَ الحدث ⇒ قفزةٌ عدديّةٌ ماديّة (٥ ⇒ ٤٠) تُنتج
    // مفتاحاً مختلفاً فيبلغ المديرَ إشعارٌ جديد بالرقم الصحيح. قبله كان المفتاح يحوي
    // اليوم فقط ⇒ أوّلُ إشعارٍ يوميٍّ يقتنص التاريخ، وبقيّة اليوم يقرأ المدير رقماً
    // قديماً بينما الحقيقةُ تضاعفت (الجذر: تدقيق ٢٤/٨ / بنك الوكلاء الرابع).
    const countBand = overdueCount < 10 ? "0-9" : overdueCount < 25 ? "10-24" : overdueCount < 50 ? "25-49" : overdueCount < 100 ? "50-99" : overdueCount < 200 ? "100-199" : "200+";
    for (const managerId of managersByBranch.get(Number(row.branchId)) ?? []) {
      const result = await createAppNotification({
        userId: managerId,
        kind: "APPROVAL_REQUIRED",
        title: "استثناء: مهام استوديو متأخرة",
        body: `لديك ${overdueCount} مهمة استوديو تجاوزت موعدها.`,
        route: "/catalog/image-studio?view=overdue",
        eventKey: `product-studio:overdue-digest:${overdueDayKey}:band:${countBand}:branch:${Number(row.branchId)}:manager:${managerId}`,
        entityType: "productStudioOverdueDigest",
        entityId: Number(row.branchId),
        requiresAction: true,
      });
      if (result.created) createdCount++;
    }
  }
  for (const job of jobs) {
    if (!job.dueAt) continue;
    const dueKey = job.dueAt.toISOString();
    if (job.assignedTo != null && job.assigneeRole !== "manager" && job.assigneeRole !== "admin") {
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
  }
  return { createdCount };
}

/** سقفُ **العمل** لا سقفُ الرؤية: الاستعلام يُرجع الناقص وحده، فالحدّ يقصّ ما يُنشأ في النبضة. */
const ASSIGNMENT_RECONCILE_CREATE_LIMIT = 200;

/**
 * مهلةُ سماحٍ قبل اعتبار الإشعار مفقوداً — تمنع سباق المصالحة مع المُرسِل المباشر.
 * بدونها قد تُدرج النبضةُ إشعاراً ثانياً لإسنادٍ وقع قبل ثوانٍ ولمّا يكتمل إرسالُه.
 */
const ASSIGNMENT_RECONCILE_GRACE_MS = 10 * 60_000;

/**
 * **مصالحةُ إشعار الإسناد**: تُنشئ ما فُقد منه، بلا جدولٍ جديد ولا عاملٍ جديد.
 *
 * **العطب:** `notifyStudioAssignment` تُستدعى **بعد** إغلاق المعاملة وتبتلع أيّ فشلٍ
 * بتحذير. فانقطاعٌ لحظيّ ⇒ مهمّةٌ مُسنَدةٌ وموظّفٌ لا يعلم بها أبداً، بلا أثرٍ وبلا إعادة
 * محاولة. وخطورتُه تضاعفت بعد #683: بطاقةُ الإشعار صارت مدخلَ المصوّر إلى مهمّته.
 *
 * ثلاثةُ قيودٍ هنا **كلٌّ منها أمسكته مراجعةُ Codex على النسخة الأولى**، وبدونها تُنتج
 * الميزةُ عكسَ غرضها — إشعاراتٌ زائفةٌ تُدرّب الموظّف على تجاهل الإشعارات كلّها:
 *
 * **١) الوجودُ يُقاس بالكيان لا بمفتاح الحدث.** المفتاح يحمل `revision`، و`saveStudioDraft`
 * و`updateStudioTaskSchedule` **يرفعان `revision`** بلا إسنادٍ جديد ⇒ كل حفظِ مسودةٍ كان
 * يُولّد مفتاحاً جديداً لا يُوجَد، فتُنشئ المصالحة إشعار «مهمة جديدة» **بعد كل تعديل**.
 * الآن السؤال: «هل لهذا الموظّف إشعارٌ عن هذه المهمّة أصلاً؟» — سؤالٌ لا يتأثّر بالتنقيح
 * ولا بتغيّر صيغة المفاتيح لاحقاً.
 *
 * **٢) المسحُ الذاتيّ ليس إسناداً.** `claimStudioProductByBarcode` يضع
 * `assignedBy = assignedTo` **ولا يُشعر عمداً** — الماسح يعلم بما مسح. وبما أنّ المسح هو
 * مسار العمل الأساسيّ في الحملات، كانت المصالحة ستُشعر كلّ مصوّرٍ بمنتجٍ مسحه بيده للتوّ،
 * وتعُدّ ذلك «إصلاح فشل» في السجلّ. الشرط `assignedBy <> assignedTo` يفصلهما.
 *
 * **٣) لا تجويعَ للأقدم.** جلبُ أحدث ٥٠٠ ثمّ الترشيح يعني أنّ حملةً بآلاف المهام تُبقي
 * النبضةَ تفحص الصفوف الحديثة نفسها أبداً، فلا يُصلَح القديمُ قطّ — وهو نقضٌ للوعد
 * بالتصحيح الرجعيّ. الاستعلام الآن **يُرجع الناقص وحده** (`NOT EXISTS`)، فالسقف يقصّ
 * العمل لا الرؤية، والنبضة التالية تلتقط ما تبقّى.
 *
 * **نطاقُها إشعارُ الإسناد وحده** — لا الرفض: مفتاح الرفض يحمل `revision` بدوره، ومهمّةٌ
 * مرفوضةٌ يحفظ صاحبُها مسودّتها ترفعه، فمصالحتُه بنفس المنطق تُعيد إنتاج العطب ١. والمهمّة
 * المرفوضة تظهر لصاحبها في طابوره على كلّ حال.
 */
export async function reconcileStudioAssignmentNotifications(
  actor: ProductStudioActor,
  now = new Date(),
  limit = ASSIGNMENT_RECONCILE_CREATE_LIMIT,
): Promise<{ createdCount: number; missing: number }> {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const branchScope = canCrossBranches(actor) ? undefined : eq(productImageJobs.branchId, Number(actor.branchId));
  const cutoff = new Date(now.getTime() - ASSIGNMENT_RECONCILE_GRACE_MS);
  const missing = await requireDb()
    .select({
      id: productImageJobs.id,
      status: productImageJobs.status,
      assignedTo: productImageJobs.assignedTo,
      revision: productImageJobs.revision,
      reviewedAt: productImageJobs.reviewedAt,
      assignedAt: productImageJobs.assignedAt,
      assigneeRole: users.role,
    })
    .from(productImageJobs)
    .innerJoin(users, eq(users.id, productImageJobs.assignedTo))
    .where(
      and(
        branchScope,
        eq(users.isActive, true),
        // الحالات التي ينتظر فيها الموظّفُ فعلاً. المعتمَدة والمُلغاة لا تنتظر أحداً،
        // وPENDING_REVIEW بيد المدير لا المصوّر.
        inArray(productImageJobs.status, ["ASSIGNED", "IN_PROGRESS", "REJECTED"]),
        // إسنادٌ من غيره — لا مسحٌ ذاتيّ (القيد ٢ أعلاه).
        isNotNull(productImageJobs.assignedBy),
        sql`${productImageJobs.assignedBy} <> ${productImageJobs.assignedTo}`,
        // مهلةُ سماحٍ: لا نسابق المُرسِل المباشر.
        isNotNull(productImageJobs.assignedAt),
        lte(productImageJobs.assignedAt, cutoff),
        // الغياب يُقاس بمفتاح الحدث المتوقّع للحالة الراهنة، لا بأيّ إشعارٍ سابق للمهمّة:
        //   • ASSIGNED/IN_PROGRESS ⇒ مفتاح إسنادٍ لهذا التنقيح غائب
        //   • REJECTED             ⇒ مفتاح رفضٍ لهذا التنقيح غائب
        // قبل هذا الفرق كان أيُّ إشعارٍ سابقٍ يُلغي المصالحة، فرفضٌ فشل إرساله بعد إسنادٍ نجح
        // كان يظلّ صامتاً أبداً (الجذر: مراجعة Codex P2 على PR #776، ٢٥/٨).
        sql`not exists (
          select 1 from ${appNotifications} n
          where n.userId = ${productImageJobs.assignedTo}
          and n.eventKey = case
            when ${productImageJobs.status} = 'REJECTED'
              then concat('product-studio:', ${productImageJobs.id}, ':rejected:r', ${productImageJobs.revision})
            else concat('product-studio:', ${productImageJobs.id}, ':assigned:', ${productImageJobs.assignedTo}, ':r', ${productImageJobs.revision})
          end
        )`,
      ),
    )
    .orderBy(desc(productImageJobs.id))
    .limit(Math.max(1, Math.min(limit, ASSIGNMENT_RECONCILE_CREATE_LIMIT)));

  let createdCount = 0;
  for (const job of missing) {
    if (!isRoutineStudioRecipient(job.assigneeRole)) continue;
    // المصالحةُ تُميّز بين الرفض المفقود والإسناد المفقود بحسب حالة المهمّة — قبل هذا
    // كانت كلّها تُرسَل بعنوان «مهمة جديدة» فيقرأ المصوّر «جديدة» بينما هي مرفوضة
    // بانتظار تصحيحه. الجذر: تدقيق ٢٤/٨ (بنك الوكلاء الرابع).
    const isRejected = job.status === "REJECTED";
    const result = await createAppNotification({
      userId: Number(job.assignedTo),
      kind: "TASK_ASSIGNED",
      title: isRejected ? "مهمة استوديو تحتاج تعديلاً" : "مهمة جديدة في استوديو المنتجات",
      body: isRejected ? `أُعيدت مهمة الاستوديو رقم ${job.id} للتعديل.` : `أُسندت إليك مهمة الاستوديو رقم ${job.id}.`,
      route: `/catalog/image-studio?task=${job.id}`,
      eventKey: isRejected
        ? studioRejectedEventKey(Number(job.id), Number(job.revision))
        : studioAssignedEventKey(Number(job.id), Number(job.assignedTo), Number(job.revision)),
      entityType: "productImageJob",
      entityId: Number(job.id),
      requiresAction: true,
    });
    if (result.created) createdCount++;
  }
  if (createdCount > 0) {
    // تحذيرٌ عمداً: تكرارُه يعني أنّ المُرسِل المباشر يفشل بانتظام، والمصالحة تستر العطب
    // بدل أن تكشفه. وبعد القيدين ١ و٢ صار السجلّ يدلّ على فشلٍ حقيقيّ لا على عملٍ عاديّ.
    logger.warn({ createdCount, missing: missing.length }, "productStudio.notifications.reconciled_missing");
  }
  return { createdCount, missing: missing.length };
}

export async function getStudioDashboard(actor: ProductStudioActor, now = new Date()) {
  // نطاق المنفّذ مهامُه هو، ونطاق المدير/المدقّق فرعُه. الفارق جوهريّ للقارئ: الأرقام
  // نفسها تحت العناوين نفسها تعني شيئين مختلفين، فتُعاد `scopeKind` كي تُسمّيها الشاشة
  // بما هي («مهامي» لا «المهام النشطة») — منفّذٌ له مهمتان كان يقرأ «المهام النشطة ٢»
  // بينما زميله غارقٌ في ثلاثمئة، فيستنتج أنّ الفرع خاملٌ.
  const personalScope = !isManager(actor) && actor.role !== "auditor";
  const scope = canCrossBranches(actor) ? undefined : personalScope ? and(eq(productImageJobs.branchId, Number(actor.branchId)), eq(productImageJobs.assignedTo, actor.userId)) : eq(productImageJobs.branchId, Number(actor.branchId));
  // المهمة «مملوكة» حين لها منفّذ فعليّ. الحالة ASSIGNED وحدها لا تدلّ على ذلك:
  // مهام الحملة تُولَد ASSIGNED بـassignedTo=null، فعدُّها «قيد العمل» يجعل اللوحة تكذب.
  const ownedExpr = sql<number>`case when ${productImageJobs.assignedTo} is null then 0 else 1 end`;
  const rows = await requireDb()
    .select({ status: productImageJobs.status, owned: ownedExpr, count: sql<number>`count(*)` })
    .from(productImageJobs)
    .where(scope)
    .groupBy(productImageJobs.status, ownedExpr);
  const counts: Record<StudioStatus, number> = {
    ASSIGNED: 0,
    IN_PROGRESS: 0,
    PENDING_REVIEW: 0,
    APPROVED: 0,
    REJECTED: 0,
    FAILED: 0,
    REVERTED: 0,
    CANCELLED: 0,
  };
  const ownedCounts: Record<StudioStatus, number> = { ...counts };
  for (const row of rows) {
    counts[row.status] += Number(row.count);
    if (Number(row.owned) === 1) ownedCounts[row.status] += Number(row.count);
  }
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
      // المتأخّر بلا منفّذ يُعَدّ في الخانتين؛ تُعاد صراحةً كي لا تعرض الشاشة المشكلة الواحدة مشكلتين.
      overdueUnassigned: sql<number>`sum(case when ${productImageJobs.status} in (${sql.join(
        activeStatuses.map((status) => sql`${status}`),
        sql`, `,
      )}) and ${productImageJobs.assignedTo} is null and ${productImageJobs.dueAt} is not null and ${productImageJobs.dueAt} < ${now} then 1 else 0 end)`,
      completedToday: sql<number>`sum(case when ${productImageJobs.status} = 'APPROVED' and ${productImageJobs.reviewedAt} >= ${todayStart} and ${productImageJobs.reviewedAt} < ${tomorrowStart} then 1 else 0 end)`,
    })
    .from(productImageJobs)
    .where(metricScope);
  // نافذة متدحرجة + سقف صريح: بلا حدٍّ كانت تُحمَّل كل المهام المعتمدة منذ نشأة النظام
  // إلى ذاكرة Node عند كل إبطالٍ للوحة (بعد كل اعتماد/رفض) — نموّ لا يتوقّف لقيمةٍ عدديّة واحدة.
  const cycleWindowStart = new Date(now.getTime() - CYCLE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const cycleRows = await requireDb()
    .select({
      createdAt: productImageJobs.createdAt,
      assignedAt: productImageJobs.assignedAt,
      reviewedAt: productImageJobs.reviewedAt,
    })
    .from(productImageJobs)
    .where(
      and(
        metricScope,
        eq(productImageJobs.status, "APPROVED"),
        sql`${productImageJobs.reviewedAt} is not null`,
        gte(productImageJobs.reviewedAt, cycleWindowStart),
      ),
    )
    .orderBy(desc(productImageJobs.reviewedAt))
    .limit(CYCLE_SAMPLE_LIMIT);
  const cycleMinutes = cycleRows
    .filter((row) => row.reviewedAt != null)
    // من لحظة الإسناد لا الإنشاء: مهام الحملة تُولَد بالآلاف دفعةً ثمّ تنتظر، فالقياس من
    // الإنشاء يُبلّغ عمرَ الطابور لا زمنَ العمل. الصفوف السابقة للعمود ترجع إلى createdAt.
    .map((row) => Math.max(0, Math.round((row.reviewedAt!.getTime() - (row.assignedAt ?? row.createdAt).getTime()) / 60_000)))
    .sort((a, b) => a - b);
  const middle = Math.floor(cycleMinutes.length / 2);
  const medianCycleMinutes = cycleMinutes.length === 0 ? null : cycleMinutes.length % 2 === 1 ? cycleMinutes[middle] : Math.round(((cycleMinutes[middle - 1] ?? 0) + (cycleMinutes[middle] ?? 0)) / 2);
  return {
    counts,
    ownedCounts,
    active: counts.ASSIGNED + counts.IN_PROGRESS + counts.PENDING_REVIEW + counts.REJECTED,
    /** العمل الجاري فعلاً: مسنَدٌ لمنفّذ. لا يشمل طابور الحملة العاطل. */
    inProgress: ownedCounts.ASSIGNED + ownedCounts.IN_PROGRESS,
    rejected: counts.REJECTED,
    /** ‏"PERSONAL" = الأرقام مهامُ هذا المنفّذ وحده؛ "BRANCH" = فرعه؛ "ALL" = كل الفروع. */
    scopeKind: canCrossBranches(actor) ? ("ALL" as const) : personalScope ? ("PERSONAL" as const) : ("BRANCH" as const),
    // في النطاق الشخصيّ يستحيل أن يكون للمنفّذ مهمةٌ غير مسنَدة (الشرطان يتناقضان)،
    // فالصفر هنا ليس «لا طابور» بل «لا ينطبق» — تُعاد null كي لا تعرض الشاشة صفراً كاذباً.
    unassigned: personalScope ? null : Number(exceptionMetrics?.unassigned ?? 0),
    overdue: Number(exceptionMetrics?.overdue ?? 0),
    overdueUnassigned: personalScope ? null : Number(exceptionMetrics?.overdueUnassigned ?? 0),
    completedToday: Number(exceptionMetrics?.completedToday ?? 0),
    medianCycleMinutes,
    medianCycleWindowDays: CYCLE_WINDOW_DAYS,
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
  productId: number | null;
  campaignId: number | null;
  unassigned: boolean;
  search: string;
  updatedAt: string;
  id: number;
};

function encodeStudioTaskCursor(cursor: StudioTaskCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeStudioTaskCursor(value: string, expected: Omit<StudioTaskCursor, "updatedAt" | "id">): StudioTaskCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as StudioTaskCursor;
    if (parsed.scope !== expected.scope || JSON.stringify(parsed.statuses) !== JSON.stringify(expected.statuses) || JSON.stringify(parsed.priorities) !== JSON.stringify(expected.priorities) || parsed.overdue !== expected.overdue || parsed.assigneeId !== expected.assigneeId || parsed.productId !== expected.productId || parsed.campaignId !== expected.campaignId || parsed.unassigned !== expected.unassigned || parsed.search !== expected.search || typeof parsed.updatedAt !== "string" || Number.isNaN(Date.parse(parsed.updatedAt)) || !Number.isSafeInteger(parsed.id) || parsed.id < 1) throw new Error("invalid cursor");
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
    productId?: number;
    campaignId?: number;
    unassigned?: boolean;
    search?: string;
    now?: Date;
  },
) {
  const conds = [];
  const limit = Math.min(input.limit ?? 50, 100);
  const search = normalizeSearchText(input.search ?? "").slice(0, 80);
  const priorities = Array.from(new Set(input.priority ?? [])).sort();
  const statuses = Array.from(new Set(input.statuses ?? [])).sort();
  const assigneeId = input.assigneeId ?? null;
  const productId = input.productId ?? null;
  const campaignId = input.campaignId ?? null;
  const cursorScope = {
    scope: input.scope,
    statuses,
    priorities,
    overdue: input.overdue ?? null,
    assigneeId,
    productId,
    campaignId,
    unassigned: input.unassigned === true,
    search,
  };
  const cursor = input.cursor ? decodeStudioTaskCursor(input.cursor, cursorScope) : null;
  const now = input.now ?? new Date();
  if (!canCrossBranches(actor)) conds.push(eq(productImageJobs.branchId, Number(actor.branchId)));
  const branchAuditHistory = actor.role === "auditor" && input.scope === "HISTORY";
  if ((!isManager(actor) && !branchAuditHistory) || input.scope === "MINE") {
    conds.push(eq(productImageJobs.assignedTo, actor.userId));
  }
  // عرض الاستثناءات (متأخّر/بلا منفّذ) يشمل ما ينتظر المراجعة أيضاً، وإلّا خالف العدّادَ
  // في اللوحة: بطاقةٌ تقول ١٢ وقائمةٌ تعرض ٩، والثلاثة الغائبة هي المتأخّرة قيد المراجعة.
  const exceptionView = input.overdue === true || input.unassigned === true;
  if (input.scope === "QUEUE") conds.push(inArray(productImageJobs.status, exceptionView ? ["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"] : ["ASSIGNED", "IN_PROGRESS", "REJECTED"]));
  if (input.scope === "REVIEW") conds.push(eq(productImageJobs.status, "PENDING_REVIEW"));
  if (input.scope === "HISTORY") conds.push(inArray(productImageJobs.status, ["APPROVED", "FAILED", "REVERTED", "CANCELLED"]));
  if (statuses.length) conds.push(inArray(productImageJobs.status, statuses));
  if (priorities.length) conds.push(inArray(productImageJobs.priority, priorities));
  if (assigneeId != null) {
    if (!isManager(actor) && assigneeId !== actor.userId) throw new TRPCError({ code: "FORBIDDEN" });
    conds.push(eq(productImageJobs.assignedTo, assigneeId));
  }
  if (productId != null) conds.push(eq(productImageJobs.productId, productId));
  if (campaignId != null) conds.push(eq(productImageJobs.campaignId, campaignId));
  if (input.unassigned === true) conds.push(isNull(productImageJobs.assignedTo));
  // بحثٌ باسم المنتج/الرمز داخل الطابور. بدونه كان الوصول إلى مهمةٍ بعينها بين آلاف الصفوف
  // يعني الضغط على «تحميل المزيد» عشرات المرّات ثمّ المسح البصريّ.
  if (search) {
    conds.push(like(sql<string>`coalesce(${products.searchNorm}, lower(${products.name}))`, `%${escLike(search)}%`));
  }
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
      cancellationReason: productImageJobs.cancellationReason,
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

/**
 * صور المنتج المعتمَدة، لاختيار مصدرٍ عند الإسناد.
 *
 * الفاعل إلزاميّ: كان هذا الإجراء الوحيد في راوترَي الاستوديو الذي لا يستقبله إطلاقاً،
 * فكسَر قاعدة الطبقات (الخدمة تستقبل Actor لا ctx) وأتاح لأيّ حاملِ صلاحية قراءةٍ أن
 * يتنقّل بين معرّفات المنتجات فيُعدّد جرد الصور المعتمدة للكتالوج كلّه — بياناتٌ وصفية
 * لا بايتات، لكنّ التعداد نفسه لا مبرّر له.
 */
export async function listStudioProductImages(actor: ProductStudioActor, productId: number) {
  if (!isManager(actor) && actor.role !== "auditor") throw new TRPCError({ code: "FORBIDDEN" });
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
  // تحميلٌ كسولٌ مرّةً واحدة لكل مسح، وخارج أيّ معاملة. كان يُحمَّل في رأس الدالّة دائماً
  // — حتى حين لا مرشّح مؤهّلاً للحذف أصلاً — وهو قراءةٌ وتجزئةٌ قد تبلغ غيغابايتات.
  let authorizationOnce: Promise<{ authorize(objectKey: string): void }> | null = null;
  const deletionAuthorization = () => (authorizationOnce ??= loadDeletionAuthorization(process.env, now, studioObjectRoot()));
  const candidates = await requireDb()
    .select({ objectKey: productImageObjectStaging.objectKey })
    .from(productImageObjectStaging)
    // REFERENCED ليست نهائية: إعادة الإرسال تستبدل processedObjectKey، وحذف المهمة/الصورة يزيل آخر مرجع.
    // نفحص الحالتين بعد TTL ونحذف فقط بعد إثبات غياب أي مرجع داخل معاملة مقفلة.
    .where(sql`${productImageObjectStaging.touchedAt} < ${cutoff}`)
    .orderBy(asc(productImageObjectStaging.touchedAt))
    .limit(Math.max(1, Math.min(limit, STAGING_SWEEP_MAX_BATCH)));
  let removed = 0;
  for (const candidate of candidates) {
    // المرحلة الأولى: تقييمٌ تحت القفل، وتطبيقُ كل قرارٍ غير الحذف. لا تحميلَ للإثبات هنا.
    const eligible = await withStudioTx(async (tx) => {
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
        // الوضع المُعلَن هو المعيار، لا كون الإثبات قد حُمِّل بعد — التحميل صار كسولاً.
        deleteRequested: gcMode === "delete",
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
      // مؤهَّلٌ للحذف: لا نحذف هنا كي لا يُحمَّل الإثبات داخل معاملةٍ تمسك قفلاً.
      return true;
    });
    if (!eligible) continue;
    if (gcMode !== "delete") throw new Error("R2_GC_DELETE_AUTHORIZATION_REQUIRED");
    const authorization = await deletionAuthorization();
    // المرحلة الثانية: إعادة القفل وإعادة إثبات غياب المرجع قبل الحذف فعلياً — النافذة
    // بين المرحلتين قد يظهر فيها مرجعٌ جديد (إعادة رفعٍ بنفس المحتوى).
    const deleted = await withStudioTx(async (tx) => {
      const staging = (await tx.select().from(productImageObjectStaging).where(eq(productImageObjectStaging.objectKey, candidate.objectKey)).limit(1).for("update"))[0];
      if (!staging) return false;
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
      if (jobRef.length > 0 || imageRef.length > 0) {
        await tx.update(productImageObjectStaging).set({ state: "REFERENCED", referencedAt: now, touchedAt: now }).where(eq(productImageObjectStaging.objectKey, candidate.objectKey));
        return false;
      }
      authorization.authorize(candidate.objectKey);
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
    if (!/^[0-9a-f]{64}$/i.test(source.contentHash) || !["image/png", "image/jpeg", "image/webp"].includes(canonicalImageMime(source.mime))) {
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

function isRoutineStudioRecipient(role: string | null | undefined): boolean {
  return role !== "admin" && role !== "manager";
}

/**
 * المفتاح يحمل `revision` لأنّ الإسناد يتكرّر على المهمة نفسها: تُسحَب من موظف ثمّ
 * تُعاد إليه لاحقاً. بمفتاحٍ بلا مراجعة كان الإشعار الثاني يُبتلَع بوصفه مكرَّراً
 * فلا يعلم الموظف أنّ المهمة عادت إليه — بخلاف مفتاح الرفض الذي يحملها أصلاً.
 */
/**
 * مفاتيح أحداث إشعارات الاستوديو — **مصدرُ اشتقاقٍ واحد** يستعمله المُرسِل والمُصالِح معاً.
 *
 * كانت السلاسل مكتوبةً في موضع الإرسال وحده. ولمّا صار للمصالحة (أدناه) أن تُعيد بناء
 * المفتاح نفسه، فأيّ اختلاف حرفٍ بينهما يجعلها تُعيد إنشاء إشعارٍ موجودٍ أبداً — أو تظنّ
 * المفقودَ موجوداً فلا تُصلحه. الاشتقاق من دالّةٍ واحدة يجعل الانحراف مستحيلاً لا مستبعَداً.
 * و`appNotifications.eventKey` **فريدٌ**، فإعادة الإدراج تُرجع `created:false` بلا ضرر.
 */
function studioAssignedEventKey(taskId: number, assigneeId: number, revision: number): string {
  return `product-studio:${taskId}:assigned:${assigneeId}:r${revision}`;
}

function studioRejectedEventKey(taskId: number, revision: number): string {
  return `product-studio:${taskId}:rejected:r${revision}`;
}

/**
 * مفتاحُ اعتمادِ الاستوديو — دورةٌ مغلقةٌ للمصوّر: أُسنِد، رُفض/اعتُمد.
 * قبل هذا كان المصوّر يعرف الاعتماد بتحديث `HISTORY` يدوياً؛ الآن يصله إشعارٌ كأخوَيه.
 */
function studioApprovedEventKey(taskId: number, revision: number): string {
  return `product-studio:${taskId}:approved:r${revision}`;
}

async function notifyStudioAssignment(taskId: number, assigneeId: number, assigneeRole: string, revision: number): Promise<void> {
  if (!isRoutineStudioRecipient(assigneeRole)) return;
  try {
    await createAppNotification({
      userId: assigneeId,
      kind: "TASK_ASSIGNED",
      title: "مهمة جديدة في استوديو المنتجات",
      body: `أُسندت إليك مهمة الاستوديو رقم ${taskId}.`,
      route: `/catalog/image-studio?task=${taskId}`,
      eventKey: studioAssignedEventKey(taskId, assigneeId, revision),
      entityType: "productImageJob",
      entityId: taskId,
      requiresAction: true,
    });
  } catch (error) {
    logger.warn({ err: error, taskId, assigneeId }, "تعذّر إنشاء إشعار إسناد الاستوديو");
  }
}

async function notifyStudioRejection(taskId: number, assigneeId: number, revision: number, assigneeRole: string | null): Promise<void> {
  if (!isRoutineStudioRecipient(assigneeRole)) return;
  try {
    await createAppNotification({
      userId: assigneeId,
      kind: "TASK_ASSIGNED",
      title: "مهمة استوديو تحتاج تعديلاً",
      body: `أُعيدت مهمة الاستوديو رقم ${taskId} للتعديل.`,
      route: `/catalog/image-studio?task=${taskId}`,
      eventKey: studioRejectedEventKey(taskId, revision),
      entityType: "productImageJob",
      entityId: taskId,
      requiresAction: true,
    });
  } catch (error) {
    logger.warn({ err: error, taskId, assigneeId }, "تعذّر إنشاء إشعار رفض الاستوديو");
  }
}

async function notifyStudioApproval(taskId: number, assigneeId: number, revision: number, assigneeRole: string | null, productName: string | null): Promise<void> {
  if (!isRoutineStudioRecipient(assigneeRole)) return;
  try {
    await createAppNotification({
      userId: assigneeId,
      kind: "TASK_ASSIGNED",
      title: "اعتُمدت مهمّة استوديو المنتجات",
      body: productName ? `اعتُمدت الصورة والمحتوى: «${productName}».` : `اعتُمدت مهمّة الاستوديو رقم ${taskId}.`,
      route: `/catalog/image-studio?task=${taskId}`,
      eventKey: studioApprovedEventKey(taskId, revision),
      entityType: "productImageJob",
      entityId: taskId,
      requiresAction: false,
    });
  } catch (error) {
    logger.warn({ err: error, taskId, assigneeId }, "تعذّر إنشاء إشعار اعتماد الاستوديو");
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
  const result = await withStudioTx(async (tx) => {
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
        // قفل مشارك: القراءة هنا تحقّقُ صلاحيةٍ لا تعديل. قفل X على users يصطدم بأقفال FK
        // المشتركة لكل إدراجٍ بـcreatedBy لنفس المستخدم (إيصال/وردية/فاتورة)، وكان يعكس
        // ترتيب القفل بين assign (products→users) وbulkAssign (users→products) فيولّد deadlock.
        .for("share")
    )[0];
    if (!assignee) throw new TRPCError({ code: "BAD_REQUEST", message: "الموظف غير متاح" });
    assertAssignableBranch(actor, assignee.branchId);
    if (!hasModuleAccess(assignee.role, assignee.permissionsOverride as PermissionMap | null, "productStudio", "FULL")) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "الموظف لا يملك صلاحية استوديو المنتجات",
      });
    }
    // تُستعمل في مسارَي الإسناد معاً: إنشاء مهمة جديدة، وتبنّي مهمة طابورٍ قائمة.
    // كان التحقّق حكراً على مسار الإنشاء، فكان تبنّي مهمة الطابور يمرّ بلا تحقّقٍ ثم يُهمل اللقطة.
    const assertSourceSnapshotCurrent = async () => {
      if (!snapshot) return;
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
    };
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
      await assertSourceSnapshotCurrent();
      await tx
        .update(productImageJobs)
        .set({
          assignedTo: input.assigneeId,
          assignedBy: actor.userId,
          assignedAt: new Date(),
          priority: input.priority ?? activeTask.priority,
          dueAt: input.dueAt === undefined ? activeTask.dueAt : input.dueAt,
          // لقطة المصدر التي اختارها المدير تُحفَظ هنا أيضاً؛ إغفالها كان يُفقدها صامتاً
          // فيصطدم المنفّذ لاحقاً بـ«الصورة الأصلية مطلوبة لأول إرسال».
          ...(snapshot
            ? {
                sourceImageId: snapshot.sourceImageId,
                originalObjectKey: snapshot.originalObjectKey,
                sourceContentHash: snapshot.sourceContentHash,
                originalMime: snapshot.originalMime,
              }
            : {}),
          sourceProductHash: productContentHash(product),
          revision: sql`${productImageJobs.revision} + 1`,
        })
        .where(eq(productImageJobs.id, activeTask.id));
      if (snapshot) {
        await tx.update(productImageObjectStaging).set({ state: "REFERENCED", referencedAt: new Date() }).where(eq(productImageObjectStaging.objectKey, snapshot.originalObjectKey));
      }
      await tx.insert(auditLogs).values(
        auditValues(actor, "productStudio.assignBacklog", Number(activeTask.id), {
          productId: input.productId,
          assigneeId: input.assigneeId,
          sourceImageId: snapshot?.sourceImageId ?? null,
          priority: input.priority ?? activeTask.priority,
          dueAt: input.dueAt === undefined ? (activeTask.dueAt?.toISOString() ?? null) : (input.dueAt?.toISOString() ?? null),
        }),
      );
      return {
        taskId: Number(activeTask.id),
        revision: Number(activeTask.revision) + 1,
        assigneeRole: assignee.role,
      };
    }
    await assertSourceSnapshotCurrent();
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
          assignedAt: new Date(),
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
      return { taskId, revision: 1, assigneeRole: assignee.role };
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
  await notifyStudioAssignment(result.taskId, input.assigneeId, result.assigneeRole, result.revision);
  return { taskId: result.taskId, revision: result.revision };
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
  const result = await withStudioTx(async (tx) => {
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
        // قفل مشارك: القراءة هنا تحقّقُ صلاحيةٍ لا تعديل. قفل X على users يصطدم بأقفال FK
        // المشتركة لكل إدراجٍ بـcreatedBy لنفس المستخدم (إيصال/وردية/فاتورة)، وكان يعكس
        // ترتيب القفل بين assign (products→users) وbulkAssign (users→products) فيولّد deadlock.
        .for("share")
    )[0];
    if (!assignee) throw new TRPCError({ code: "BAD_REQUEST", message: "الموظف غير متاح" });
    assertAssignableBranch(actor, assignee.branchId);
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
            assignedAt: new Date(),
            createdBy: actor.userId,
            activeSlot: 1,
            templateVersion: 1,
          })),
        );
      }
      const unassignedIds = Array.from(unassignedByProduct.values());
      if (unassignedIds.length > 0) {
        // إعادةُ الإسناد لطابورٍ قائم: `sourceProductHash` يُحدَّث ليطابق محتوى المنتج
        // اللحظة، وإلّا رُفض الاعتماد لاحقاً بـ«عُدّل محتوى المنتج بعد بدء المهمة» بينما
        // المصوّر عمل على المحتوى الراهن منذ لحظة الإسناد. مُسنَدٌ بمعنيَين: بيدٍ جديدة
        // ومقابل محتوى راهن. الجذر أمسكه تدقيق ٢٤/٨ (بنك الوكلاء الخامس).
        for (const [productId, jobId] of Array.from(unassignedByProduct.entries())) {
          const product = productById.get(productId);
          if (!product) continue;
          await tx
            .update(productImageJobs)
            .set({
              assignedTo: input.assigneeId,
              assignedBy: actor.userId,
              assignedAt: new Date(),
              sourceProductHash: productContentHash(product),
              // أولوية المهمة القائمة تُصان ما لم يُصرّح المدير بغيرها؛ الحشو بـNORMAL
              // كان يخفض حزمة مهامٍ URGENT صامتاً لمجرّد أنّ الإسناد الجماعي لم يمرّر أولوية.
              ...(input.priority === undefined ? {} : { priority: input.priority }),
              ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
              revision: sql`${productImageJobs.revision} + 1`,
            })
            .where(eq(productImageJobs.id, jobId));
        }
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
    const assignedRows = await tx
      .select({ id: productImageJobs.id, revision: productImageJobs.revision })
      .from(productImageJobs)
      .where(and(inArray(productImageJobs.productId, productIds), eq(productImageJobs.assignedTo, input.assigneeId), eq(productImageJobs.activeSlot, 1)));
    return {
      createdCount: productIds.length,
      taskIds: assignedRows.map((row) => ({ id: Number(row.id), revision: Number(row.revision) })),
      assigneeRole: assignee.role,
    };
  });
  await Promise.all(result.taskIds.map((task) => notifyStudioAssignment(task.id, input.assigneeId, result.assigneeRole, task.revision)));
  return { createdCount: result.createdCount };
}

/**
 * إعادةُ إسناد مهمّة استوديو قائمة إلى مصوّرٍ آخر (أو إلى الطابور المفتوح).
 *
 * قبل هذه الدالة: مهمّةٌ عالقةٌ بيد مصوّرٍ غادر/انشغل تظلّ بيده أبداً — لا مسارَ للمدير
 * لتحريرها إلّا إلغاؤها ثم إعادة توليدها، وهو مسارٌ يفقد سبب الرفض والمرشّح المرفوض
 * والتدقيق. `newAssigneeId=null` يُعيد المهمة إلى **الطابور المفتوح** (blind pool)
 * فيسحبها أوّلُ مصوّرٍ يمسح باركود منتجها. القيد الفريد `(productId, activeSlot)` يمنع
 * تكرار المهمة، فإعادة الإسناد آمنةٌ ذرّياً.
 *
 * ما يُحدَّث: `assignedTo/By/At`، ويُحدَّث `sourceProductHash` (نفس منطق إصلاح
 * `bulkAssignStudioTasks`) لأنّ المصوّر الجديد سيعمل على المحتوى الراهن، ورُفع المراجعة
 * (`revision`) لكسر أيّ محرّرٍ مفتوحٍ على النسخة القديمة.
 */
export async function reassignStudioTask(
  actor: ProductStudioActor,
  input: {
    taskId: number;
    newAssigneeId: number | null;
    expectedRevision: number;
    reason?: string;
  },
) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const cleanReason = input.reason?.trim() ?? null;
  const result = await withStudioTx(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    assertExpectedRevision(task, input.expectedRevision);
    assertTaskAccess(actor, task, true);
    if (!["ASSIGNED", "IN_PROGRESS", "REJECTED"].includes(task.status)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "لا يمكن إعادة إسناد مهمّةٍ منتظرةٍ للمراجعة أو مغلقة",
      });
    }
    // الطابور المفتوح متاحٌ فقط لمهامّ الحملات: `claimStudioProductByBarcode` يرفض سحب
    // مهمّةٍ بلا `campaignId` («تُسنَد من المدير ولا تُسحَب بالمسح»). إرسالُها للطابور
    // إذن يُعلّقها بلا يدٍ ولا مسارِ استرداد — يلزم اختيارُ مصوّرٍ صراحةً.
    if (input.newAssigneeId == null && task.campaignId == null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "المهمّةُ غير مرتبطةٍ بحملة — لا يمكن إعادتها للطابور المفتوح، اختر مصوّراً صراحةً",
      });
    }
    let newAssigneeRole: string | null = null;
    if (input.newAssigneeId != null) {
      const [assignee] = await tx
        .select({ id: users.id, role: users.role, branchId: users.branchId, permissionsOverride: users.permissionsOverride })
        .from(users)
        .where(and(eq(users.id, input.newAssigneeId), eq(users.isActive, true)))
        .limit(1)
        .for("share");
      if (!assignee) throw new TRPCError({ code: "BAD_REQUEST", message: "المصوّر الجديد غير متاح" });
      assertAssignableBranch(actor, assignee.branchId);
      if (Number(assignee.branchId) !== Number(task.branchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن نقل المهمة إلى مصوّرٍ من فرعٍ آخر" });
      }
      if (!hasModuleAccess(assignee.role, assignee.permissionsOverride as PermissionMap | null, "productStudio", "FULL")) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "المصوّر الجديد لا يملك صلاحية استوديو المنتجات" });
      }
      newAssigneeRole = assignee.role;
    }
    // بصمةُ المحتوى تُحدَّث كي لا يُرفَض اعتماد المرشّح لاحقاً بـ«عُدّل محتوى المنتج».
    const product = task.productId
      ? (await tx.select({ id: products.id, name: products.name, description: products.description }).from(products).where(eq(products.id, task.productId)).limit(1))[0]
      : null;
    await tx
      .update(productImageJobs)
      .set({
        assignedTo: input.newAssigneeId,
        assignedBy: actor.userId,
        assignedAt: new Date(),
        sourceProductHash: product ? productContentHash(product) : null,
        revision: sql`${productImageJobs.revision} + 1`,
      })
      .where(eq(productImageJobs.id, input.taskId));
    await tx.insert(auditLogs).values(
      auditValues(actor, "productStudio.reassign", input.taskId, {
        oldAssigneeId: task.assignedTo,
        newAssigneeId: input.newAssigneeId,
        reason: cleanReason,
      }),
    );
    return {
      response: { taskId: input.taskId, newAssigneeId: input.newAssigneeId, revision: nextRevision(task) },
      newAssigneeRole,
      revision: nextRevision(task),
    };
  });
  // إشعارُ المسنَد إليه إن كان لدينا واحدٌ (لا إشعارَ لمن يعود إلى الطابور المفتوح).
  if (input.newAssigneeId != null && result.newAssigneeRole) {
    await notifyStudioAssignment(input.taskId, input.newAssigneeId, result.newAssigneeRole, result.revision);
  }
  return result.response;
}

/**
 * إسنادٌ جماعيّ لمهامٍ **قائمة** — بلا إنشاء صفوف. يستقبل معرّفات المهمات لا المنتجات،
 * فيوفّق المصوّر الجديد على كلٍّ منها في نداءٍ واحد. مصمَّم لإعادة توزيع أعباء طابور
 * حملةٍ بعد غياب أحد المصوّرين. سقفٌ ١٠٠ مهمّة لكل نداء كسقف `bulkAssign`.
 */
export async function bulkReassignStudioTasks(
  actor: ProductStudioActor,
  input: { taskIds: number[]; newAssigneeId: number | null; reason?: string },
) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const taskIds = Array.from(new Set(input.taskIds.map(Number)));
  if (taskIds.length === 0 || taskIds.length > 100) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "اختر من مهمّة واحدة إلى ١٠٠ مهمّة" });
  }
  const cleanReason = input.reason?.trim() ?? null;
  const result = await withStudioTx(async (tx) => {
    let newAssignee: { id: number; role: string; branchId: number | null } | null = null;
    if (input.newAssigneeId != null) {
      const [assignee] = await tx
        .select({ id: users.id, role: users.role, branchId: users.branchId, permissionsOverride: users.permissionsOverride })
        .from(users)
        .where(and(eq(users.id, input.newAssigneeId), eq(users.isActive, true)))
        .limit(1)
        .for("share");
      if (!assignee) throw new TRPCError({ code: "BAD_REQUEST", message: "المصوّر الجديد غير متاح" });
      assertAssignableBranch(actor, assignee.branchId);
      if (!hasModuleAccess(assignee.role, assignee.permissionsOverride as PermissionMap | null, "productStudio", "FULL")) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "المصوّر الجديد لا يملك صلاحية استوديو المنتجات" });
      }
      newAssignee = { id: Number(assignee.id), role: assignee.role, branchId: assignee.branchId == null ? null : Number(assignee.branchId) };
    }
    const tasks = await tx
      .select({ id: productImageJobs.id, productId: productImageJobs.productId, branchId: productImageJobs.branchId, status: productImageJobs.status, assignedTo: productImageJobs.assignedTo, revision: productImageJobs.revision })
      .from(productImageJobs)
      .where(inArray(productImageJobs.id, taskIds))
      .for("update");
    if (tasks.length !== taskIds.length) throw new TRPCError({ code: "NOT_FOUND", message: "بعض المهام غير موجود" });
    for (const t of tasks) {
      if (!canCrossBranches(actor) && Number(t.branchId) !== Number(actor.branchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "بعض المهام في فرعٍ آخر" });
      }
      if (!["ASSIGNED", "IN_PROGRESS", "REJECTED"].includes(t.status)) {
        throw new TRPCError({ code: "CONFLICT", message: "بعض المهام لا تقبل إعادة الإسناد (منتظرة مراجعةً أو مغلقة)" });
      }
      if (newAssignee && Number(t.branchId) !== newAssignee.branchId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "المصوّر الجديد في فرعٍ آخر" });
      }
    }
    const productIds = tasks.map((t) => Number(t.productId)).filter((id) => Number.isSafeInteger(id));
    const productRows = productIds.length === 0
      ? []
      : await tx.select({ id: products.id, name: products.name, description: products.description }).from(products).where(inArray(products.id, productIds));
    const productById = new Map(productRows.map((p) => [Number(p.id), p]));
    const updated: Array<{ id: number; revision: number }> = [];
    for (const t of tasks) {
      const product = t.productId ? productById.get(Number(t.productId)) : null;
      await tx
        .update(productImageJobs)
        .set({
          assignedTo: input.newAssigneeId,
          assignedBy: actor.userId,
          assignedAt: new Date(),
          sourceProductHash: product ? productContentHash(product) : null,
          revision: sql`${productImageJobs.revision} + 1`,
        })
        .where(eq(productImageJobs.id, Number(t.id)));
      updated.push({ id: Number(t.id), revision: Number(t.revision) + 1 });
    }
    await tx.insert(auditLogs).values({
      ...auditValues(actor, "productStudio.bulkReassign", 0, {
        taskIds,
        newAssigneeId: input.newAssigneeId,
        reason: cleanReason,
      }),
      entityId: "bulk",
    });
    return { updated, newAssigneeRole: newAssignee?.role ?? null };
  });
  if (input.newAssigneeId != null && result.newAssigneeRole) {
    await Promise.all(result.updated.map((row) => notifyStudioAssignment(row.id, input.newAssigneeId!, result.newAssigneeRole!, row.revision)));
  }
  return { reassignedCount: result.updated.length };
}

/**
 * ضبطُ الأولويّة على دفعةٍ من المهام — بدون هذا المسار كان المدير يفتح كلاً منها منفرداً.
 * لا يمسّ الحالة ولا المسنَد إليه، فقط الأولوية (والموعد اختيارياً).
 */
export async function bulkSetStudioPriority(
  actor: ProductStudioActor,
  input: { taskIds: number[]; priority: StudioPriority; dueAt?: Date | null },
) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const taskIds = Array.from(new Set(input.taskIds.map(Number)));
  if (taskIds.length === 0 || taskIds.length > 100) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "اختر من مهمّة واحدة إلى ١٠٠ مهمّة" });
  }
  return withStudioTx(async (tx) => {
    const tasks = await tx
      .select({ id: productImageJobs.id, branchId: productImageJobs.branchId, status: productImageJobs.status })
      .from(productImageJobs)
      .where(inArray(productImageJobs.id, taskIds))
      .for("update");
    if (tasks.length !== taskIds.length) throw new TRPCError({ code: "NOT_FOUND", message: "بعض المهام غير موجود" });
    for (const t of tasks) {
      if (!canCrossBranches(actor) && Number(t.branchId) !== Number(actor.branchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "بعض المهام في فرعٍ آخر" });
      }
      if (!["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"].includes(t.status)) {
        throw new TRPCError({ code: "CONFLICT", message: "لا يمكن ضبط أولويّة مهمّة مغلقة" });
      }
    }
    await tx
      .update(productImageJobs)
      .set({
        priority: input.priority,
        ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
        revision: sql`${productImageJobs.revision} + 1`,
      })
      .where(inArray(productImageJobs.id, taskIds));
    await tx.insert(auditLogs).values({
      ...auditValues(actor, "productStudio.bulkSetPriority", 0, {
        taskIds,
        priority: input.priority,
        dueAt: input.dueAt?.toISOString() ?? null,
      }),
      entityId: "bulk",
    });
    return { updatedCount: tasks.length };
  });
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
  return withStudioTx(async (tx) => {
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
  return withStudioTx(async (tx) => {
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
  await withStudioTx(async (tx) => {
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
  await withStudioTx(async (tx) => {
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
    /**
     * تحقّقٌ متفائل: كلّ كاتبٍ آخر (`saveDraft`/`updateSchedule`/`submitCandidate`/…)
     * يُلزم `expectedRevision`؛ غيابُه هنا كان يجعل هذا المسار **الوحيد** الذي يقبل
     * كتابةً على مهمّةٍ تغيّرت تحت يد المصوّر (إعادة إسناد إداريّ · تحديث موعد). لا
     * يفسد بيانات (submit لاحقاً يتحقّق من hash المرشّح)، لكنه يكسر عقد الاتّساق المُعلَن.
     */
    expectedRevision?: number;
  },
): Promise<{ ok: true; revision?: number }> {
  const candidate = decodeStudioImage(input.candidateDataUrl);
  const receiptHash = contentHash(Buffer.from(input.processingReceipt, "utf8"));
  return withStudioTx(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    if (input.expectedRevision !== undefined) assertExpectedRevision(task, input.expectedRevision);
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
    return input.expectedRevision === undefined ? { ok: true as const } : { ok: true as const, revision: task.revision };
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
  const lease = await withStudioTx(async (tx) => {
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
    // الحجز قبل الرفع وداخل معاملة الحجز نفسها: لا يُكتب بايتٌ في المخزن قبل إثبات رصيده.
    // كان هذا المسار المجّاني بلا سقفٍ إطلاقاً بينما يكتب كائنَين لا يُستبدَلان ولا يُستردّان.
    await reserveStudioSubmitQuotaInTx(tx, actor.userId, studioPayloadBytes(input.processedDataUrl, input.thumbnailDataUrl, task.originalObjectKey ? null : input.originalDataUrl));
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

    const result = await withStudioTx(async (tx) => {
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
    // الكنس ليس من عمل هذا الطلب. كان يُستدعى هنا بعد كل إرسال ناجح، وفي وضع الحذف
    // يقرأ إثبات النسخ الاحتياطي ويجزّئه (بيانٌ حتى ٥٠ م.ب + حتى ١٠٠ كائنٍ مستعاد بحدّ
    // ٢٥ م.ب لكلٍّ) ⇒ إضافةُ غيغابايتات من القراءة المتزامنة إلى مسار طلب الموظف.
    // مكانه العامل الدوريّ المحروس بمُشغّلٍ واحد في العنقود.
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
  return withStudioTx(async (tx) => {
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
    // إشعار الاعتماد للمصوّر — دورةٌ مغلقةٌ لسلسلة الإشعارات (أُسنِد/رُفض/اعتُمد).
    // قبله كان المصوّر يعرف الاعتماد بتحديث «السجلّ» يدوياً — احتكاكٌ مجانيّ لصمت الخادم.
    const assigneeRole = task.assignedTo == null
      ? null
      : (await tx.select({ role: users.role }).from(users).where(eq(users.id, task.assignedTo)).limit(1))[0]?.role ?? null;
    return {
      response: expectedRevision === undefined ? { imageId } : { imageId, revision: nextRevision(task) },
      assignedTo: task.assignedTo,
      revision: nextRevision(task),
      assigneeRole,
      productName: product.name ?? null,
    };
  }).then(async (out) => {
    if (out.assignedTo != null) {
      await notifyStudioApproval(taskId, Number(out.assignedTo), out.revision, out.assigneeRole, out.productName);
    }
    return out.response;
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
  const result = await withStudioTx(async (tx) => {
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
        // مفاتيحُ المخزن للمرشّح المرفوض تُفرَّغ كما تُفرَّغ في الإلغاء — دفعُ إعادة الإرسال
        // ستضع كائناً جديداً (المفاتيح موجَّهةٌ بالمحتوى)، فحفظُ القديم لا فائدةَ تشغيليّة له.
        // الأثر الجنائيّ باقٍ في `auditLogs.productStudio.reject` بمفاتيحه، وسبب الرفض
        // يبقى في الصفّ ذاته. غياب هذا الحقل كان يمنع سعاة R2 من استرداد المرشّحات المرفوضة أبداً.
        processedObjectKey: null,
        processedContentHash: null,
        processedMime: null,
        processedBytes: null,
        processedWidth: null,
        processedHeight: null,
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
    const assigneeRole = task.assignedTo == null
      ? null
      : (await tx.select({ role: users.role }).from(users)
          .where(eq(users.id, task.assignedTo)).limit(1))[0]?.role ?? null;
    return {
      response: expectedRevision === undefined ? { ok: true as const } : { ok: true as const, revision: nextRevision(task) },
      assignedTo: task.assignedTo,
      revision: nextRevision(task),
      assigneeRole,
    };
  });
  if (result.assignedTo != null) {
    await notifyStudioRejection(taskId, Number(result.assignedTo), result.revision, result.assigneeRole);
  }
  return result.response;
}

/** الحالات التي يجوز إلغاؤها: عملٌ لم يُنشَر بعد. المعتمدة لها مسارها الخاصّ (استرجاع الأصل). */
const CANCELLABLE_STUDIO_STATUSES: StudioStatus[] = ["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"];

/**
 * الحقول التي يُفرغها الإلغاء: الحجوزات والإثباتات والمرشّح المعروض — **ومفاتيح المخزن**.
 *
 * قبل هذا: `processedObjectKey/Hash/Mime/Bytes/Width/Height` تُصان «أثراً» — لكن مسّاح
 * `productImageObjectStaging` يعتبرها **مرجعاً نشطاً** (line ~2242) فلا يستردّ الكائن
 * أبداً حتى وضع GC = `delete`. النتيجة: مرشّحات المرفوضين والملغاة تتكدّس في R2 بلا نهاية.
 *
 * الأثر الجنائيّ يبقى في `auditLogs` (كل تحوّلٍ ماريّ به دخل بالإجراء والمُنفّذ والوقت
 * ومفاتيح الكائنات مطبوعةٌ في مدخلات submit/approve) — لا نحتاج مؤشّراً على الصفّ نفسه.
 * وتفريغُ المفاتيح يُدرج الكائنَ في مسار المسح البنيويّ (REFERENCED → PENDING → حذف بعد
 * نافذة الاحتفاظ) بلا مساسٍ بأيّ عارضٍ للصورة (المرشّح المرفوض لا يُخدَم أصلاً).
 */
function cancelledTaskFields(actor: ProductStudioActor, reason: string, now: Date) {
  return {
    status: "CANCELLED" as const,
    // تفريغ activeSlot هو جوهر الإصلاح: القيد الفريد (productId, activeSlot) كان يحتجز
    // المنتج إلى الأبد خلف مهمةٍ خاطئة فلا يقبل مهمةً صحيحة بديلة.
    activeSlot: null,
    processedUrl: null,
    processedObjectKey: null,
    processedContentHash: null,
    processedMime: null,
    processedBytes: null,
    processedWidth: null,
    processedHeight: null,
    cancellationReason: reason,
    cancelledBy: actor.userId,
    cancelledAt: now,
    uploadLeaseToken: null,
    uploadLeaseExpiresAt: null,
    processingLeaseTokenHash: null,
    processingLeaseExpiresAt: null,
    processingProofTokenHash: null,
    processingProofExpiresAt: null,
    processingProofCandidateHash: null,
    processingProofMode: null,
    revision: sql`${productImageJobs.revision} + 1`,
  };
}

/**
 * إلغاء مهمة استوديو واحدة بقرار مدير موثَّق.
 *
 * كان توليدُ الحملة قادراً على إنشاء آلاف المهام بلا أيّ مسار تراجع: لا إجراء إلغاء في الراوتر،
 * ولا إلغاءُ الحملة يمسّ مهامها. فتبقى في الطابور وفي المؤشّرات وفي إشعارات التأخّر أبداً،
 * ويبقى المنتج محجوزاً خلفها.
 */
export async function cancelStudioTask(actor: ProductStudioActor, input: { taskId: number; reason: string; expectedRevision?: number }) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const cleanReason = input.reason.trim();
  if (cleanReason.length < 5)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سبب الإلغاء مطلوب بوضوح",
    });
  return withStudioTx(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    assertExpectedRevision(task, input.expectedRevision);
    assertTaskAccess(actor, task, true);
    if (task.status === "APPROVED")
      throw new TRPCError({
        code: "CONFLICT",
        message: "المهمة معتمدة ومنشورة؛ استعمل استرجاع الأصل بدل الإلغاء",
      });
    if (!CANCELLABLE_STUDIO_STATUSES.includes(task.status))
      throw new TRPCError({
        code: "CONFLICT",
        message: "المهمة في حالة نهائية ولا تقبل الإلغاء",
      });
    await tx
      .update(productImageJobs)
      .set(cancelledTaskFields(actor, cleanReason, new Date()))
      .where(eq(productImageJobs.id, input.taskId));
    await tx.insert(auditLogs).values(
      auditValues(actor, "productStudio.cancel", input.taskId, {
        reason: cleanReason,
        previousStatus: task.status,
        previousAssignee: task.assignedTo,
        campaignId: task.campaignId == null ? null : Number(task.campaignId),
      }),
    );
    return input.expectedRevision === undefined ? { ok: true as const } : { ok: true as const, revision: nextRevision(task) };
  });
}

/** سقف مرشّحي الكنس في المسح الواحد. رُفع من ٢٥ بعد إخراج الكنس من مسار الطلب. */
const STAGING_SWEEP_MAX_BATCH = 500;

/** سقف الإلغاء الجماعيّ في المعاملة الواحدة — نفس منطق سقف التوليد. */
const CANCEL_BATCH_LIMIT = 500;

/**
 * إلغاء طابور حملةٍ وُلِّد خطأً.
 *
 * النطاق مُضيَّق عمداً: **المهام غير المسنَدة في حالة ASSIGNED فقط**. عملٌ بدأه موظف
 * (IN_PROGRESS أو أُرسل للمراجعة) لا يُمحى بضغطةٍ جماعية — يُلغى فرداً فرداً بقرارٍ مرئيّ.
 */
/**
 * نواة إلغاء طابور حملة، مشتركةٌ بين الإلغاء الصريح وإلغاء الحملة نفسها.
 * تفترض أنّ صلاحية الفاعل على الحملة قد فُحصت، وتعمل داخل معاملة القادم.
 */
async function cancelCampaignQueuedTasksInTx(tx: Parameters<Parameters<typeof withTx>[0]>[0], actor: ProductStudioActor, campaign: { id: number | string; branchId: number | string | null }, reason: string, action: string) {
  const campaignId = Number(campaign.id);
  const scope = and(eq(productImageJobs.campaignId, campaignId), eq(productImageJobs.status, "ASSIGNED"), isNull(productImageJobs.assignedTo), eq(productImageJobs.activeSlot, 1));
  const rows = await tx.select({ id: productImageJobs.id }).from(productImageJobs).where(scope).orderBy(asc(productImageJobs.id)).limit(CANCEL_BATCH_LIMIT).for("update");
  if (rows.length === 0) return { cancelledCount: 0, remaining: 0 };
  const ids = rows.map((row) => Number(row.id));
  await tx
    .update(productImageJobs)
    .set(cancelledTaskFields(actor, reason, new Date()))
    .where(inArray(productImageJobs.id, ids));
  const [remainingRow] = await tx.select({ count: sql<number>`count(*)` }).from(productImageJobs).where(scope);
  const remaining = Number(remainingRow?.count ?? 0);
  await tx.insert(auditLogs).values({
    userId: actor.userId,
    branchId: campaign.branchId == null ? null : Number(campaign.branchId),
    action,
    entityType: "productStudioCampaign",
    entityId: String(campaignId),
    newValue: { cancelledCount: ids.length, remaining, reason },
  });
  return { cancelledCount: ids.length, remaining };
}

export async function bulkCancelStudioBacklog(actor: ProductStudioActor, input: { campaignId: number; reason: string }) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const cleanReason = input.reason.trim();
  if (cleanReason.length < 5)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سبب الإلغاء مطلوب بوضوح",
    });
  return withStudioTx(async (tx) => {
    const campaign = (await tx.select().from(productStudioCampaigns).where(eq(productStudioCampaigns.id, input.campaignId)).limit(1))[0];
    if (!campaign)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "حملة الاستوديو غير موجودة",
      });
    assertCampaignAccess(actor, campaign);
    return cancelCampaignQueuedTasksInTx(tx, actor, campaign, cleanReason, "productStudio.campaign.cancelBacklog");
  });
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
  return withStudioTx(async (tx) => {
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
