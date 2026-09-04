import { TRPCError } from "@trpc/server";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, like, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { appNotifications, auditLogs, categories, productImageObjectStaging, productImageJobs, productImages, productStudioCampaignAssignees, productStudioCampaignCategories, productStudioCampaignProducts, productStudioCampaigns, productUnitBarcodes, productUnits, productVariants, products, users } from "../../drizzle/schema";
import { appErrorMessage } from "@shared/errors";
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
import { mysqlCodeFrom } from "@shared/errorMap.ar";
import { getCurrentCompanyId } from "../tenancy/context";
import { isMultiTenantModeActive } from "../db";
import { resolveCompanyById } from "../tenancy/registry";
import { evaluateStagingRetention, loadR2GcDeletionAuthorization, resolveR2GcMode } from "../lib/imageStore/r2RetentionPolicy";
import { studioObjectRoot } from "../lib/imageStore/tenantNamespace";
import { canCrossBranches } from "../lib/branchAuthority";
import { utcDayStart, utcNextDayStart } from "./businessDay";
import { reserveStudioSubmitQuotaInTx, studioPayloadBytes } from "./productStudioSubmitQuota";
import { createAppNotification } from "./appNotificationService";
import {
  enqueueAppNotificationOutbox,
  reconcileAppNotificationOutbox,
  type AppNotificationOutboxIntent,
  type AppNotificationWriter,
} from "./appNotificationOutboxService";
import { generateAndSaveContentDraftForProduct } from "./productContentAiService";

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
    throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({ what: "تعذّر إسناد مهامّ الاستوديو", why: "حسابك بلا فرعٍ مُسنَد، وكلّ مهمّة استوديو تُنشأ داخل فرعٍ محدَّد", doThis: "اطلب من مدير النظام ربط حسابك بفرعٍ من صفحة المستخدمين، ثمّ أعد الإسناد" }) });
  }
  if (assigneeBranchId == null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر إسناد المهمّة إلى هذا الموظّف", why: "الموظّف بلا فرعٍ مُسنَد، ومهمّةٌ بلا فرعٍ لا يفتحها أحدٌ بعد إنشائها", doThis: "اختر مصوّراً آخر من فرعك الآن، واطلب من مدير النظام تعيين فرع هذا الموظّف من صفحة المستخدمين" }) });
  }
  if (Number(assigneeBranchId) !== Number(actor.branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({ what: "تعذّر إسناد المهمّة إلى هذا الموظّف", why: "الموظّف يتبع فرعاً غير فرعك، وإسناد مهامّ الاستوديو لا يعبر الفروع", doThis: "اختر مصوّراً من فرعك، أو اطلب من مدير النظام تنفيذ الإسناد عبر الفروع" }) });
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
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر حفظ مصوّري الحملة", why: "أحد المصوّرين المختارين لم يعد حساباً نشطاً — أُوقف أو حُذف بعد فتحك الشاشة", doThis: "حدّث الشاشة، ثمّ أعد اختيار المصوّرين من القائمة واحفظ" }) });
  }
  for (const row of rows) {
    if (Number(row.branchId) !== Number(campaignBranch)) {
      throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({ what: "تعذّر إضافة الموظّف إلى مصوّري الحملة", why: "الموظّف يتبع فرعاً غير فرع الحملة، ومصوّرو الحملة من فرعها وحده", doThis: "اختر مصوّرين من فرع الحملة، أو أنشئ حملةً مستقلّةً لذلك الفرع" }) });
    }
    if (!hasModuleAccess(row.role, row.permissionsOverride as PermissionMap | null, "productStudio", "FULL")) {
      throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر إضافة الموظّف إلى مصوّري الحملة", why: "الموظّف لا يملك صلاحية «استوديو المنتجات»، ومن لا يملكها لا تظهر له مهامّ الحملة", doThis: "اضغط «امنح الصلاحية» أمام اسمه في قائمة الموظّفين ثمّ أعد الحفظ" }) });
    }
  }
  void actor;
}

function isAdminActor(actor: ProductStudioActor): boolean {
  return canCrossBranches(actor);
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
      message: appErrorMessage({
        what: "تعذّر نشر الصورة بعد اعتمادها",
        why: "الجلسة بلا سياق شركةٍ في وضع تعدّد الشركات، ورابط الصورة العامّ يُبنى برمز الشركة",
        doThis: "سجّل الخروج وادخل من رابط شركتك، ثمّ أعد اعتماد المهمّة",
      }),
    });
  const company = await resolveCompanyById(companyId);
  if (!company)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر نشر الصورة بعد اعتمادها",
        why: "سجلّ الشركة المرتبط بجلستك غير مقروء، ومنه يُشتقّ رمزها في رابط الصورة العامّ",
        doThis: "أبلغ الدعم الفنّي بتعذّر قراءة سجلّ شركتك، وأعد الاعتماد بعد إصلاحه",
      }),
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
      message: appErrorMessage({
        what: "تعذّر فتح مهمّة الاستوديو",
        why: "المهمّة تتبع فرعاً غير فرعك، ومهامّ الاستوديو لا تُقرأ عبر الفروع",
        doThis: "اعمل على مهامّ فرعك من تبويب «الطابور»، أو اطلب من مدير النظام نقل المهمّة إلى فرعك",
      }),
    });
  }
  if (actor.role === "manager") return;
  if (auditorRead && actor.role === "auditor") return;
  if (managerOnly || Number(task.assignedTo) !== actor.userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر فتح مهمّة الاستوديو",
        why: "المهمّة مُسنَدة إلى مصوّرٍ آخر، وكلٌّ يفتح ما أُسنِد إليه",
        doThis: "افتح مهامّك من تبويب «مهامّي»، واطلب من المدير إعادة إسناد هذه المهمّة إليك إن كانت من نصيبك",
      }),
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
      message: appErrorMessage({
        what: "تعذّر الحفظ على مهمّة الاستوديو",
        why: "المهمّة تتبع فرعاً غير فرعك، والكتابة على مهامّ الاستوديو لا تعبر الفروع",
        doThis: "اعمل على مهامّ فرعك، أو اطلب من مدير النظام نقل المهمّة إلى فرعك",
      }),
    });
  }
  if (Number(task.assignedTo) === actor.userId) return null;
  const reason = cleanAdminOverrideReason(adminOverrideReason);
  if (!isAdminActor(actor) || !reason) {
    throw new TRPCError({
      code: "FORBIDDEN",
      // الفرعان يخاطبان قارئَين مختلفَين: مدير النظام يملك المخرج بيده (يكتب السبب)،
      // ومن دونه لا يملكه أصلاً ⇒ مخرجه **إحالة** لا أمرٌ يعجز عنه.
      message: isAdminActor(actor)
        ? appErrorMessage({
            what: "تعذّر العمل على مهمّة مصوّرٍ آخر",
            why: "المهمّة مُسنَدة إلى مصوّرٍ غيرك، والعمل نيابةً عنه تصحيحٌ إداريٌّ يلزمه سببٌ مكتوب لا يقلّ عن 5 أحرف",
            doThis: "اكتب سبب التصحيح الإداريّ في حقل السبب ثمّ أعد الحفظ",
          })
        : appErrorMessage({
            what: "تعذّر الحفظ على هذه المهمّة",
            why: "المهمّة مُسنَدة إلى مصوّرٍ آخر، والعمل عليها محصورٌ بمالكها أو بمدير النظام بسببٍ موثَّق",
            doThis: "اعمل على مهامّك من تبويب «مهامّي»، واطلب من المدير إعادة إسناد هذه المهمّة إليك إن كانت من نصيبك",
          }),
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
      message: appErrorMessage({
        what: "تعذّر إتمام مراجعة المهمّة",
        why: "أنت من نفّذ العمل أو أرسله للمراجعة، وفصلُ المهامّ يمنع مراجعة الشخص لعمل نفسه",
        doThis: "اطلب من مديرٍ آخر مراجعة المهمّة، أو من مدير النظام اعتمادها بسبب تصحيحٍ إداريٍّ مكتوب",
      }),
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
      message: appErrorMessage({
        what: "تعذّر قبول الصورة",
        why: "الملفّ المرسَل مبتورٌ أو ليس صورةً سليمة — تعذّرت قراءة أبعاده من بايتاته (المقبول PNG أو JPEG أو WebP كاملاً)",
        doThis: "أعِد التقاط الصورة أو صدّرها من جديد بصيغة JPEG، ثمّ أعد الإرسال",
      }),
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
      message: appErrorMessage({
        what: "تعذّر إرسال المرشّح للمراجعة",
        why: "مصغّرة العرض التي أنتجها متصفّحك ليست WebP ولا JPEG، وهما الصيغتان المقبولتان",
        doThis: "حدّث الصفحة وأعد الإرسال، وإن تكرّر فجرّب متصفّحاً آخر أو أبلغ الدعم الفنّي",
      }),
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
      // السبب وحده يتبدّل بالصيغة؛ المخرج واحدٌ لأنّ المصغّرة يُنتجها المتصفّح لا المصوّر.
      message: isWebp
        ? appErrorMessage({
            what: "تعذّر إرسال المرشّح للمراجعة",
            why: "مصغّرة WebP التي أنتجها متصفّحك مبتورةٌ أو بلا إطار صورةٍ ثابت، أو تجاوز ضلعُها 320 بكسل",
            doThis: "حدّث الصفحة وأعد الإرسال ليُنتج المتصفّح مصغّرةً جديدة، وإن تكرّر فأبلغ الدعم الفنّي",
          })
        : appErrorMessage({
            what: "تعذّر إرسال المرشّح للمراجعة",
            why: "مصغّرة JPEG التي أنتجها متصفّحك مبتورةٌ (بلا خاتمة ملفّ) أو تجاوز ضلعُها 320 بكسل",
            doThis: "حدّث الصفحة وأعد الإرسال ليُنتج المتصفّح مصغّرةً جديدة، وإن تكرّر فأبلغ الدعم الفنّي",
          }),
    });
  }
  if (!processed.width || !processed.height) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إرسال المرشّح للمراجعة",
        why: "أبعاد الصورة النهائية غير مقروءة، فلا سبيل للتحقّق أنّ المصغّرة مشتقّةٌ منها",
        doThis: "أعِد إنتاج الصورة النهائية من محرّر الاستوديو ثمّ أعد الإرسال",
      }),
    });
  }
  const expected = fittedThumbnailDimensions(processed.width, processed.height);
  if (dimensions.width !== expected.width || dimensions.height !== expected.height) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إرسال المرشّح للمراجعة",
        why: "أبعاد المصغّرة لا تطابق المشتقّ من الصورة النهائية (أطول ضلعٍ يُصغَّر إلى 320 بكسل)",
        doThis: "حدّث الصفحة وأعد إنتاج الصورة ومصغّرتها معاً ثمّ أعد الإرسال",
      }),
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
      message: appErrorMessage({
        what: "تعذّر تنفيذ عملية الاستوديو",
        why: "مخزن الصور الخاص غير مُهيَّأ على الخادم، ولا تُحفَظ صورةٌ بلا مخزنٍ يستقبلها",
        doThis: "أبلغ الإدارة بأنّ إعدادات مخزن صور الاستوديو ناقصة على الخادم؛ التصوير متوقّف حتى تُضبط",
      }),
    });
  }
}

async function lockTask(tx: Parameters<Parameters<typeof withTx>[0]>[0], taskId: number) {
  const task = (await tx.select().from(productImageJobs).where(eq(productImageJobs.id, taskId)).limit(1).for("update"))[0];
  if (!task)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر فتح مهمّة الاستوديو",
        why: "لا مهمّة بهذا الرقم — أُلغيت أو حُذفت بعد فتحك الشاشة",
        doThis: "حدّث قائمة المهامّ وأعد الاختيار منها",
      }),
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
      message: appErrorMessage({
        what: "تعذّر حفظ التغيير على المهمّة",
        why: "تغيّرت المهمّة بعد فتحك لها (إعادة إسنادٍ أو تغيير موعدٍ أو حفظٌ من جهازٍ آخر)، وحفظُك مبنيٌّ على نسخةٍ أقدم",
        doThis: "حدّث الشاشة لتقرأ النسخة الأحدث، ثمّ أعد إدخال تغييرك واحفظ",
      }),
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
      message: appErrorMessage({
        what: "تعذّر عرض الصفحة التالية من نتائج المنتجات",
        why: "مؤشّر الصفحة لم يعد مطابقاً لبحثك الحالي — تغيّر نصّ البحث أو مرشّح «إظهار المعطَّل» بعد إنشائه",
        doThis: "أعد البحث من أوّله ثمّ تنقّل بين الصفحات من جديد",
      }),
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
  // المنتجات الخدميّة تُستبعَد من الاستوديو كلّياً — لا صور مادّية لها.
  const baseWhere = and(showInactive ? undefined : eq(products.isActive, true), eq(products.isService, false), matches);
  const afterCursor = cursor ? sql`(${rank} > ${cursor.rank} or (${rank} = ${cursor.rank} and (${products.name} > ${cursor.name} or (${products.name} = ${cursor.name} and ${products.id} > ${cursor.id}))))` : undefined;
  const productsPage = await db
    .select({
      id: products.id,
      name: products.name,
      isActive: products.isActive,
      // البكج يعبر مسار الاستوديو كمنتج عاديّ، فكانت الشاشة تعرضه بلا تمييز — لا شارةٌ ولا فلتر.
      // تمريرُ `isBundle` هنا يفتح شارةً في المنتقي وحماية «قد لا تُطابق مكوّناته» في المراجعة.
      isBundle: products.isBundle,
      rank,
    })
    .from(products)
    .leftJoin(productVariants, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, eq(productUnits.variantId, productVariants.id))
    .leftJoin(productUnitBarcodes, eq(productUnitBarcodes.productUnitId, productUnits.id))
    .where(baseWhere)
    .groupBy(products.id, products.name, products.isActive, products.isBundle)
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
    // الباركود يُطبَّع على طرفَي المقارنة معاً (كالـSKU في السطر التالي): `q` مرّ أصلاً
    // بـ`normalizeSearchText` (الذي **يُصغّر الأحرف**)، بينما القيمة المخزّنة تصل بحالتها
    // الأصليّة. المقارنة الحرفيّة `row.primaryBarcode === q` كانت تُسقط أيّ باركود أبجديّ-رقميّ
    // بأحرفٍ كبيرة (Code39 والداخليّ `ALR…`) لأنّ «ABC» ≠ «abc» في JS — بينما ترتيبُ حروف
    // MySQL (`utf8mb4_0900_ai_ci`) لا يُميّز الحالة فيجد صفّه في SQL. النتيجة: صفٌّ يُطابقه
    // الاستعلامُ لكنّ التصنيف يسقط إلى NAME_CONTAINS، فيعيد `resolveStudioBarcode` (بلا
    // BARCODE_PRIMARY/ALIAS) خطأ «الباركود غير معروف» على منتجٍ موجود فعلاً.
    if (q && row.primaryBarcode != null && normalizeSearchText(row.primaryBarcode) === q)
      return { rank: 1, kind: "BARCODE_PRIMARY" as const, barcode: row.primaryBarcode };
    if (q && row.aliasBarcode != null && normalizeSearchText(row.aliasBarcode) === q)
      return { rank: 1, kind: "BARCODE_ALIAS" as const, barcode: row.aliasBarcode };
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
      isBundle: Boolean(product.isBundle),
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
async function claimFreshCampaignTask(
  tx: StudioTx,
  actor: ProductStudioActor,
  resolved: { productId: number; productName: string; variantId: number | null; variantName: string | null },
) {
  const productId = Number(resolved.productId);
  const variantId = resolved.variantId == null ? null : Number(resolved.variantId);
  // اسمُ العرض للمصوّر يجمع المنتج والبديل (إن وُجد) — الرسائل والأثر يستعملانه بلا تغييرِ عقد.
  const displayName = resolved.variantName ? `${resolved.productName} — ${resolved.variantName}` : resolved.productName;
  const managerActor = isManager(actor);
  // مدير النظام/المالك يستطيع بدء تصوير أيّ منتج داخل نطاق حملةٍ نشطة **بلا** اشتراط عضويّة
  // `productStudioCampaignAssignees` — إنشاء الحملة لا يُدرجه فيها تلقائياً، وطلبُ إضافة نفسه
  // قبل أوّل مسحٍ يعارض دوره التشغيليّ. شروطُ الفرع والنطاق تبقى مطبَّقةً تحت (الحلقة أدناه)،
  // فالاستثناء يخصّ العضويّة وحدها لا التخويلَ ككلّ. بلا هذا كان الأدمن الذي أنشأ الحملة
  // يقف عاجزاً أمام أوّل باركود يمسحه ويصله «راجع المدير لإضافتك» — وهو المدير نفسه.
  const baseCampaignSelect = {
    id: productStudioCampaigns.id,
    name: productStudioCampaigns.name,
    branchId: productStudioCampaigns.branchId,
    dueAt: productStudioCampaigns.dueAt,
    scopeKind: productStudioCampaigns.scopeKind,
    scopeCategoryId: productStudioCampaigns.scopeCategoryId,
    requiredImages: productStudioCampaigns.requiredImages,
    imagesPolicy: productStudioCampaigns.imagesPolicy,
  };
  const campaigns = managerActor
    ? await tx
        .select(baseCampaignSelect)
        .from(productStudioCampaigns)
        .where(eq(productStudioCampaigns.status, "ACTIVE"))
        // أولويّةٌ معلَنة عند تداخل حملتين على المنتج نفسه: الأقرب موعداً ثمّ الأقدم إنشاءً.
        // بلا ترتيبٍ كان الاختيار يتبع ما تُرجعه MySQL أوّلاً — فيُنسَب العمل لحملةٍ عشوائية.
        .orderBy(asc(productStudioCampaigns.dueAt), asc(productStudioCampaigns.id))
    : await tx
        .select(baseCampaignSelect)
        .from(productStudioCampaigns)
        .innerJoin(productStudioCampaignAssignees, and(eq(productStudioCampaignAssignees.campaignId, productStudioCampaigns.id), eq(productStudioCampaignAssignees.userId, actor.userId)))
        .where(eq(productStudioCampaigns.status, "ACTIVE"))
        .orderBy(asc(productStudioCampaigns.dueAt), asc(productStudioCampaigns.id));
  if (campaigns.length === 0) {
    // مديرٌ بلا أيّ حملة نشطة: رسالةٌ تدعوه لبدء واحدة بدل «راجع المدير».
    if (managerActor) {
      throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: `«${displayName}» لم يُفتح له عمل تصوير`, why: "لا حملة تصويرٍ نشطةٍ واحدة في النظام، والمسح يفتح العمل داخل حملةٍ نشطة", doThis: "أنشئ حملةً وفعّلها من لوحة الحملات، ثمّ أعد مسح الباركود" }) });
    }
    // تمييزٌ بين «لا حملات أصلاً» و«حملات موجودة لكنك لست عضواً» لغير المدير — قبلَ كان
    // كلاهما يخرج بنفس «راجع المدير»، فيراجعه في حملةٍ غير موجودة أصلاً. العدُّ مُقيَّدٌ
    // بفرع الفاعل حين لا يعبر الفروع (مراجعة Codex P2): وإلّا حملةٌ في فرعٍ آخر تُنتج
    // «حملات موجودة لكنك لست عضواً» ⇒ الموظّف يراجع مديره في حملةٍ خارج فرعه أصلاً،
    // ويكشف تنبيهياً وجودَ نشاطٍ عبر الفروع (تسريبٌ عرضيّ).
    const [activeCount] = await tx
      .select({ n: sql<number>`count(*)` })
      .from(productStudioCampaigns)
      .where(
        canCrossBranches(actor) || actor.branchId == null
          ? eq(productStudioCampaigns.status, "ACTIVE")
          : and(eq(productStudioCampaigns.status, "ACTIVE"), eq(productStudioCampaigns.branchId, Number(actor.branchId))),
      );
    if (Number(activeCount?.n ?? 0) === 0) {
      throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: `«${displayName}» لم يُفتح له عمل تصوير`, why: "لا حملة تصويرٍ نشطةٍ في فرعك، والمسح يفتح العمل داخل حملةٍ نشطة", doThis: "اطلب من المدير إنشاء حملةٍ لفرعك وتفعيلها، ثمّ أعد مسح الباركود" }) });
    }
    // FORBIDDEN لا NOT_FOUND: عدم العضويّة قرارُ صلاحيةٍ (لا يخصّه الطابور) — والاختبار
    // السابق كان يعتمد على هذا الرمز حين كان المسار السابق (backlog-based lookup) يرفض
    // المصوّرَ غير العضو قبل الفحص. الحفاظ على FORBIDDEN يُبقي عقد الرمز متسقاً.
    throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({ what: `«${displayName}» لم يُفتح له عمل تصوير`, why: "هناك حملاتٌ نشطة لكنّك لست ضمن مصوّري أيٍّ منها، والمسح يسحب من حملةٍ أنت أحد مصوّريها", doThis: "اطلب من المدير إضافتك إلى مصوّري الحملة، ثمّ أعد مسح الباركود" }) });
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
    // بعد هجرة 0268 صار المفتاح الفريد يعزل كلّ (productId, variantScope)، فالفحص هنا
    // يقيس شيئين: نطاقُ الحملة، وعددُ الصور المعتمدة للمنتج مقارنةً بـ`requiredImages`.
    // وجودُ مهمّةٍ نشطةٍ **لبديلٍ آخر** لا يمنع إنشاءَ مهمّةٍ للبديل الحاليّ (المفتاحُ مختلف).
    // فحصُ «هذا البديل بلا مهمّة نشطة» يقع في `claimStudioProductByBarcode` أعلاه —
    // إن وصلنا إلى هنا فالمهمّةُ غير موجودة لهذا البديل بعد.
    const requiredImages = Math.max(1, Number(campaign.requiredImages ?? 1));
    const [inScopeRow] = await tx
      .select({ id: products.id, name: products.name, description: products.description })
      .from(products)
      .where(and(eq(products.id, productId), eq(products.isActive, true), eq(products.isService, false), campaignScopeCondition(campaign)))
      .limit(1);
    if (!inScopeRow) {
      outOfScopeCount++;
      continue;
    }
    // عدّ الاعتمادات **لكل بديلٍ مسحوب**، لا للمنتج ككل: بعد هجرة 0268 صار كلّ (منتج،
    // متغيّر) مستقلٌّ بمهمّته ومفتاحه الفريد، فحصرُ العدّ بالمنتج يجعل مسحَ البديل B
    // يرتدّ بـ«اكتملت الصورة» بمجرّد اعتماد البديل A (الجذر: مراجعة Codex P1 على PR #807).
    // صور legacy على مستوى الأمّ (variantId=NULL) لا تحتسب لبديلٍ محدَّد.
    // في وضع ANY_REGARDLESS يُتجاوَز فحصُ الاكتمال — المصوّر يضيف صورةً جديدةً حتى
    // للمنتج المكتمل (طلب المالك ٢٦/٨). في ONLY_MISSING (السلوك القائم) يُفلتَر.
    if ((campaign.imagesPolicy ?? "ONLY_MISSING") === "ONLY_MISSING") {
      const [approvedCount] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(productImages)
        .where(
          and(
            eq(productImages.productId, productId),
            eq(productImages.reviewStatus, "APPROVED"),
            variantId == null ? isNull(productImages.variantId) : eq(productImages.variantId, variantId),
          ),
        );
      if (Number(approvedCount?.n ?? 0) >= requiredImages) {
        completedCount++;
        continue;
      }
    }
    const inScope = inScopeRow;
    const [created] = await tx
      .insert(productImageJobs)
      .values({
        productId,
        // البديلُ يُحفَظ على المهمّة فتذهب الصورةُ إليه على approve (`task.variantId` يمرَّر
        // إلى `productImages.variantId`). المفتاح الفريد الجديد (0268) يعزل كل بديلٍ عن
        // زميله بلا تصادم — راجع تعليق `oneActivePerProduct` في schema.
        variantId,
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
        // ماسحان متزامنان على البديل نفسه: القيد الفريد (productId, variantScope, activeSlot)
        // يمنع التكرار، لكنّ الخطأ الخام كان يصل الخاسرَ عطلاً داخلياً بدل «بيد زميل».
        if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
          throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: `«${displayName}» لم يُفتح لك`, why: "زميلٌ مسح الباركود نفسه قبلك بلحظة، ومهمّة المنتج الواحد لا تُفتح لاثنين معاً", doThis: "انتقل إلى المنتج التالي، أو اطلب من المدير نقل المهمّة إليك بإعادة الإسناد" }) });
        }
        throw error;
      });
    const taskId = Number(created.id);
    await tx.insert(auditLogs).values(auditValues(actor, "productStudio.claimByBarcode.created", taskId, { productId, variantId, campaignId: Number(campaign.id) }));
    return { taskId, productName: displayName, claimed: true as const, revision: 1, ...(await studioImageProgress(tx, productId, Number(campaign.id))) };
  }
  // ترتيبُ التشخيص من الأخصّ إلى الأعمّ: «اكتملت» يسبق «خارج النطاق» يسبق «فرعٌ آخر»،
  // فالمصوّر يقرأ سبباً واحداً محدَّداً بدل عدّة سببٍ عامّ محتمل.
  if (completedCount > 0) {
    throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: `«${displayName}» لا يحتاج تصويراً في حملتك`, why: "بلغت صوره المعتمَدة العددَ المطلوب في الحملة، وسياستها «الناقصة فقط»", doThis: "انتقل إلى المنتج التالي، واطلب من المدير ضبط سياسة الحملة على «كل المنتجات» إن أردتَ إضافة صورةٍ له رغم اكتماله" }) });
  }
  if (outOfScopeCount > 0) {
    throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: `«${displayName}» خارج نطاق حملاتك النشطة`, why: "فئة المنتج (أو قائمة منتجات الحملة) لا تشمله، والمسح يفتح ما يقع داخل النطاق وحده", doThis: "انتقل إلى منتجٍ داخل نطاق الحملة، واطلب من المدير توسيع نطاقها ليشمل فئة هذا المنتج" }) });
  }
  if (branchMismatchCount > 0) {
    throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({ what: `«${displayName}» لم يُفتح لك`, why: "حملاتك النشطة تتبع فرعاً غير فرعك الحاليّ، ومهمّة التصوير تُنشأ في فرع حملتها", doThis: "اطلب من المدير إنشاء حملةٍ لفرعك، أو نقلك إلى فرع الحملة، ثمّ أعد المسح" }) });
  }
  // احتياط: لا حملات مطابقة لأيّ سبب — يحدث حين تتغيّر الحملات بين استعلامَين.
  throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: `«${displayName}» ليس ضمن حملة تصويرٍ مُسنَدةٍ إليك`, why: "تغيّرت الحملات بين قراءتين أثناء المسح، فلم يبقَ ما يطابق هذا المنتج في حملاتك", doThis: "أعد مسح الباركود، وإن تكرّر فاطلب من المدير التأكّد من حملة هذا المنتج" }) });
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
  const variantId = resolved.variantId == null ? null : Number(resolved.variantId);
  // اسمُ العرض للرسائل يجمع المنتج والبديل (إن وُجد).
  const displayName = resolved.variantName ? `${resolved.productName} — ${resolved.variantName}` : resolved.productName;
  return withStudioTx(async (tx) => {
    // البحثُ عن مهمّةٍ نشطة يُقيَّد بـ **البديل نفسه**، مع سماحٍ باستهداف مهمّة الطابور
    // المستوى-الأمّ (`variantId IS NULL`) إن كان الماسحُ يمسح بديلاً ولا مهمّةَ خاصّةً بذلك
    // البديل بعد. حتى صدور هجرة 0268 كان (productId, activeSlot) وحده يُطابق ⇒ مسحُ بديلٍ
    // آخر من المنتج نفسه يقع على مهمّة الزميل ويصله CONFLICT. الآن كل (منتج، متغيّر)
    // مستقلٌّ بمفتاحه الفريد، ومهمّةُ الطابور تظلّ «قابلةً للترقية» إلى بديلٍ محدَّد.
    //
    // الأولويّة: مهمّةٌ خاصّةٌ بالبديل (variantId=Y) تُقدَّم على مهمّة الأمّ (NULL)،
    // فالمصوّر يعمل على عمله المُسنَد قبل أن يسحب من الطابور.
    const specificMatch = variantId == null
      ? null
      : (
          await tx
            .select({ id: productImageJobs.id, status: productImageJobs.status, assignedTo: productImageJobs.assignedTo, campaignId: productImageJobs.campaignId, branchId: productImageJobs.branchId, revision: productImageJobs.revision, variantId: productImageJobs.variantId })
            .from(productImageJobs)
            .where(and(eq(productImageJobs.productId, productId), eq(productImageJobs.activeSlot, 1), eq(productImageJobs.variantId, variantId)))
            .limit(1)
            .for("update")
        )[0];
    const parentMatch = specificMatch
      ? undefined
      : (
          await tx
            .select({ id: productImageJobs.id, status: productImageJobs.status, assignedTo: productImageJobs.assignedTo, campaignId: productImageJobs.campaignId, branchId: productImageJobs.branchId, revision: productImageJobs.revision, variantId: productImageJobs.variantId })
            .from(productImageJobs)
            .where(and(eq(productImageJobs.productId, productId), eq(productImageJobs.activeSlot, 1), isNull(productImageJobs.variantId)))
            .limit(1)
            .for("update")
        )[0];
    const active = specificMatch ?? parentMatch;
    if (!active) {
      // لا مهمّة نشطة لهذا البديل ⇒ نُنشئها فوراً إن كان المنتج داخل نطاق حملةٍ نشطة والماسحُ أحد
      // مصوّريها ولم يبلغ المنتج عدد الصور المطلوب. بدون هذا كان المصوّر يقف عاجزاً حتى
      // يُولّد المدير الطابور يدوياً — وهو ما يكسر انسيابية «امسح ثم صوّر».
      return claimFreshCampaignTask(tx, actor, resolved);
    }
    // ترقيةُ variantId قبل الرجوع «لصاحبها»: إن كان المدير أسنَد مهمّةً مستوى-أمّ
    // (variantId=NULL) إلى المصوّر ثمّ مسح المصوّرُ باركود بديلٍ محدَّد، الصورةُ يجب أن
    // تذهب لذاك البديل. بلا هذه الترقية كانت المهمّةُ تُغلَق مبكّراً بـ«صاحبها» ثمّ الاعتماد
    // ينشر `productImages.variantId=NULL` فتظهر لكل البدائل (الجذر: مراجعة Codex P1 على PR #807).
    if (variantId != null && active.variantId == null && Number(active.assignedTo) === actor.userId) {
      await tx
        .update(productImageJobs)
        .set({ variantId, revision: sql`${productImageJobs.revision} + 1` })
        .where(eq(productImageJobs.id, active.id));
      await tx.insert(auditLogs).values(
        auditValues(actor, "productStudio.claimByBarcode.upgradeVariant", Number(active.id), { productId, variantId, barcode: barcode.slice(0, 64) }),
      );
      return { taskId: Number(active.id), productName: displayName, claimed: false as const, revision: Number(active.revision) + 1, ...(await studioImageProgress(tx, productId, active.campaignId == null ? null : Number(active.campaignId))) };
    }
    if (Number(active.assignedTo) === actor.userId) {
      return { taskId: Number(active.id), productName: displayName, claimed: false as const, revision: Number(active.revision), ...(await studioImageProgress(tx, productId, active.campaignId == null ? null : Number(active.campaignId))) };
    }
    if (active.assignedTo != null) {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: `«${displayName}» بيد زميلٍ آخر الآن`, why: "المهمّة مُسنَدة إلى مصوّرٍ غيرك، ولا تُفتح المهمّة الواحدة لاثنين", doThis: "انتقل إلى المنتج التالي، أو اطلب من المدير نقل المهمّة إليك بإعادة الإسناد" }) });
    }
    // فحصُ الفرع وحده هنا: `assertTaskAccess` تفشل مغلقةً على صفٍّ **بلا منفّذ**
    // (`Number(null) === 0` لا يساوي معرّف أحد) — وهو بالضبط ما يعنيه السحب.
    // التخويل الحقيقيّ تحته: عضويّةُ الحملة.
    if (!canCrossBranches(actor) && (actor.branchId == null || Number(active.branchId) !== Number(actor.branchId))) {
      throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({ what: `«${displayName}» لم يُفتح لك`, why: "مهمّة هذا المنتج أُنشئت في فرعٍ غير فرعك، والسحب لا يعبر الفروع", doThis: "اطلب من المدير إنشاء حملةٍ لفرعك، أو نقل هذه المهمّة إلى فرعك" }) });
    }
    // السحب مشروطٌ بعضوية الحملة: لا يسحب من ليس مصوّراً فيها.
    if (active.campaignId == null) {
      throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({ what: `«${displayName}» لا يُسحَب بمسح الباركود`, why: "مهمّته أُنشئت بإسنادٍ مباشرٍ من المدير خارج أيّ حملة، والسحب بالمسح خاصٌّ بمهامّ الحملات", doThis: "اطلب من المدير إسناد المهمّة إليك، ثمّ افتحها من تبويب «مهامّي»" }) });
    }
    // حالةُ الحملة مطلوبةٌ هنا أيضاً بعد إضافة PAUSED (٢٨/٨، مراجعة Codex P1): «التجميد
    // الذكيّ» على مستوى الحملة يعني أنّ **الطابور المُسنَد مُسبقاً** يبقى قابلاً للإتمام
    // لكن السحبَ الطازج يتوقّف. `claimFreshCampaignTask` مغطّى بفلترِ `status='ACTIVE'`،
    // أمّا هذا المسار (مهمّةٌ **موجودةٌ سلفاً** في الطابور بلا مُسنَد) فكان يُسنِد بلا فحص
    // حالة الحملة ⇒ المصوّر يستمرّ في سحب المنتجات الـ٥٠٠ المولَّدة سلفاً حتى بعد الإيقاف.
    // القفلُ للقراءة (`for("update")` عليه) — العمليةُ ذرّية.
    const [campaignRow] = await tx
      .select({ status: productStudioCampaigns.status })
      .from(productStudioCampaigns)
      .where(eq(productStudioCampaigns.id, Number(active.campaignId)))
      .limit(1);
    if (campaignRow?.status === "PAUSED") {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: `«${displayName}» لا يُسحَب الآن`, why: "حملته موقوفةٌ مؤقّتاً، والإيقاف يمنع سحب عملٍ جديدٍ منها بينما يبقى المُسنَد سلفاً قابلاً للإتمام", doThis: "أكمل مهامّك المُسنَدة من تبويب «مهامّي»، واطلب من المدير «استئناف الحملة» لتعود قابلةً للسحب" }) });
    }
    if (campaignRow?.status === "COMPLETED" || campaignRow?.status === "CANCELLED") {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: `«${displayName}» لا يُسحَب الآن`, why: "حملته مُغلقة (مكتملة أو ملغاة)، والمُغلقة لا تفتح عملاً جديداً", doThis: "امسح منتجاً من حملةٍ نشطة، واطلب من المدير حملةً جديدةً إن كان هذا المنتج ما زال يحتاج صورة" }) });
    }
    const member = (
      await tx
        .select({ id: productStudioCampaignAssignees.id })
        .from(productStudioCampaignAssignees)
        .where(and(eq(productStudioCampaignAssignees.campaignId, Number(active.campaignId)), eq(productStudioCampaignAssignees.userId, actor.userId)))
        .limit(1)
    )[0];
    if (!member && !isManager(actor)) {
      throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({ what: "تعذّر سحب هذه المهمّة", why: "لستَ ضمن مصوّري الحملة التي تتبعها، والسحب من الطابور محصورٌ بمصوّريها", doThis: "اطلب من المدير إضافتك إلى مصوّري الحملة، ثمّ أعد مسح الباركود" }) });
    }
    // ترقيةُ variantId إن كانت المهمّةُ في الطابور الأمّ (NULL) والماسحُ يمسح بديلاً محدَّداً:
    // الصورةُ ستذهب لهذا البديل بالتحديد (approve يمرّرها إلى productImages.variantId).
    // بلا الترقية كانت مهمّةُ الطابور تظلّ بلا variantId فتُنشَر الصورةُ على مستوى الأمّ
    // فتُعرض لكل البدائل — نقيض «صورةٌ لكل بديل».
    const upgradeVariant = variantId != null && active.variantId == null;
    await tx
      .update(productImageJobs)
      .set({
        assignedTo: actor.userId,
        assignedBy: actor.userId,
        assignedAt: new Date(),
        ...(upgradeVariant ? { variantId } : {}),
        revision: sql`${productImageJobs.revision} + 1`,
      })
      .where(eq(productImageJobs.id, active.id));
    await tx.insert(auditLogs).values(
      auditValues(actor, "productStudio.claimByBarcode", Number(active.id), { productId, variantId, upgradedFromParent: upgradeVariant, barcode: barcode.slice(0, 64), campaignId: Number(active.campaignId) }),
    );
    return { taskId: Number(active.id), productName: displayName, claimed: true as const, revision: Number(active.revision) + 1, ...(await studioImageProgress(tx, productId, Number(active.campaignId))) };
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
      isBundle: activeMatch.isBundle,
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
      throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: `«${inactiveMatch.productName}» لا يُفتح له عمل تصوير`, why: "المنتج معطَّل في الكتالوج، والمعطَّل لا تُنشأ له مهمّة تصوير", doThis: "اطلب من المدير تفعيل المنتج من صفحة المنتجات، ثمّ أعد مسح الباركود" }) });
    }
  }
  throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: "تعذّر فتح عملٍ بهذا الباركود", why: "الرمز الممسوح لا يطابق باركود أيّ منتجٍ أو بديلٍ في الكتالوج", doThis: "ابحث عن المنتج بالاسم من حقل البحث في الاستوديو، أو اطلب من المدير إضافة هذا الباركود إلى المنتج" }) });
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
    if (!target) throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: "تعذّر منح صلاحية الاستوديو", why: "الحساب المختار غير موجودٍ أو غير نشط — أُوقف بعد فتحك القائمة", doThis: "حدّث قائمة الموظّفين واختر حساباً نشطاً، ثمّ أعد المنح" }) });
    if (!canCrossBranches(actor) && (actor.branchId == null || Number(target.branchId) !== Number(actor.branchId))) {
      throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({ what: "تعذّر منح صلاحية الاستوديو", why: "الموظّف يتبع فرعاً غير فرعك، ومنح الصلاحيات لا يعبر الفروع", doThis: "امنح الصلاحية لموظّفٍ من فرعك، أو اطلب من مدير النظام منحها لموظّفي الفروع الأخرى" }) });
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
      message: appErrorMessage({
        what: "تعذّر فتح الحملة",
        why: "الحملة تتبع فرعاً غير فرعك، وحملات الاستوديو لا تُقرأ عبر الفروع",
        doThis: "افتح حملات فرعك من لوحة الحملات، أو اطلب من مدير النظام العمل على حملة الفرع الآخر",
      }),
    });
  }
}

function campaignBranchId(actor: ProductStudioActor, requested?: number): number {
  const branchId = requested ?? actor.branchId;
  if (branchId == null || !Number.isSafeInteger(Number(branchId)) || Number(branchId) < 1) {
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر حفظ الحملة", why: "الحملة بلا فرع: لا فرعٌ اختير في النموذج ولا فرعٌ مُسنَدٌ لحسابك يُشتقّ منه", doThis: "اختر فرع الحملة من قائمة الفروع في النموذج ثمّ احفظ" }) });
  }
  if (!canCrossBranches(actor) && Number(branchId) !== Number(actor.branchId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر حفظ الحملة",
        why: "الفرع المختار غير فرعك، وإنشاء حملةٍ لفرعٍ آخر محصورٌ بمدير النظام",
        doThis: "اختر فرعك في النموذج، أو اطلب من مدير النظام إنشاء الحملة لذلك الفرع",
      }),
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
    /**
     * نطاق الحملة:
     *   • ALL — الكتالوج كلّه.
     *   • CATEGORY — فئةٌ واحدة (بشجرتها الفرعيّة) — إرثيّ، متوافق.
     *   • CATEGORIES — عدّة فئات (كلٌّ بشجرتها الفرعيّة) — جديد.
     *   • PRODUCTS — مجموعةٌ من المنتجات صراحةً.
     */
    scopeKind?: "ALL" | "CATEGORY" | "CATEGORIES" | "PRODUCTS";
    scopeCategoryId?: number | null;
    /** الفئات حين يكون النطاق CATEGORIES — واحدة أو أكثر. */
    scopeCategoryIds?: number[];
    scopeProductIds?: number[];
    /** التوجيه الإداريّ لعدد الصور المطلوبة لكل منتج. */
    requiredImages?: number;
    /**
     * سياسة الصور: `ONLY_MISSING` (المنتجات الناقصة فقط) أو `ANY_REGARDLESS`
     * (كل منتجات النطاق، حتى المكتمل — لإضافة صور جديدة).
     */
    imagesPolicy?: "ONLY_MISSING" | "ANY_REGARDLESS";
    /** مصوّرو الحملة — تُسنَد إلى عدّة موظفين، ومنها يسحب كلٌّ منهم ما يمسح باركوده. */
    assigneeIds?: number[];
  },
) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const name = input.name.trim();
  if (name.length < 3 || name.length > 180) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حفظ الحملة",
        why: "اسم الحملة خارج المدى المسموح — المطلوب من 3 إلى 180 حرفاً",
        doThis: "اكتب اسماً بين 3 و180 حرفاً في حقل اسم الحملة ثمّ احفظ",
      }),
    });
  }
  const status = input.status ?? "DRAFT";
  const startsAt = status === "ACTIVE" ? (input.startsAt ?? new Date()) : (input.startsAt ?? null);
  if (startsAt && input.dueAt && input.dueAt <= startsAt) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حفظ الحملة",
        why: "الموعد النهائيّ يسبق تاريخ البداية أو يساويه، والحملة لا تنتهي قبل أن تبدأ",
        doThis: "اضبط الموعد النهائيّ على تاريخٍ بعد تاريخ البداية ثمّ احفظ",
      }),
    });
  }
  const branchId = campaignBranchId(actor, input.branchId);
  const scopeKind = input.scopeKind ?? "ALL";
  const imagesPolicy = input.imagesPolicy ?? "ONLY_MISSING";
  const requiredImages = Math.max(1, Math.min(Math.trunc(input.requiredImages ?? 1), MAX_REQUIRED_IMAGES));
  const scopeProductIds = Array.from(new Set((input.scopeProductIds ?? []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)));
  const scopeCategoryIds = Array.from(new Set((input.scopeCategoryIds ?? []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)));
  const assigneeIds = Array.from(new Set((input.assigneeIds ?? []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)));
  // النطاق يجب أن يحمل ما يصفه، وإلّا كانت الحملة فارغةً بلا أن يدري منشئها.
  if (scopeKind === "CATEGORY" && !input.scopeCategoryId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر حفظ الحملة", why: "النطاق «فئة» ولم تُختَر فئة، فتُحفظ حملةٌ فارغةٌ لا يُولَّد لها طابور", doThis: "اختر الفئة من قائمة الفئات، أو بدّل النطاق إلى «الكتالوج كلّه»، ثمّ احفظ" }) });
  }
  if (scopeKind === "CATEGORIES" && scopeCategoryIds.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر حفظ الحملة", why: "النطاق «فئات متعدّدة» ولم تُختَر أيّ فئة، فتُحفظ حملةٌ فارغةٌ لا يُولَّد لها طابور", doThis: "اختر فئةً واحدةً على الأقلّ، أو بدّل النطاق إلى «الكتالوج كلّه»، ثمّ احفظ" }) });
  }
  if (scopeKind === "PRODUCTS" && scopeProductIds.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر حفظ الحملة", why: "النطاق «منتجات» ولم يُختَر أيّ منتج، فتُحفظ حملةٌ فارغةٌ لا يُولَّد لها طابور", doThis: "أضِف منتجاً واحداً على الأقلّ من منتقي المنتجات، أو بدّل النطاق، ثمّ احفظ" }) });
  }
  if (scopeProductIds.length > MAX_CAMPAIGN_PRODUCTS) {
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر حفظ الحملة", why: `المنتجات المختارة تتجاوز سقف الحملة الواحدة (${MAX_CAMPAIGN_PRODUCTS} منتجاً)`, doThis: `أنقص الاختيار إلى ${MAX_CAMPAIGN_PRODUCTS} منتجاً أو أقلّ، أو وزّعها على أكثر من حملة، ثمّ احفظ` }) });
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
        imagesPolicy,
        createdBy: actor.userId,
      })
      .$returningId();
    const campaignId = Number(created.id);
    if (scopeKind === "PRODUCTS") {
      await tx.insert(productStudioCampaignProducts).values(scopeProductIds.map((productId) => ({ campaignId, productId })));
    }
    if (scopeKind === "CATEGORIES") {
      await tx.insert(productStudioCampaignCategories).values(scopeCategoryIds.map((categoryId) => ({ campaignId, categoryId })));
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
      newValue: { name, status, scopeKind, scopeCategoryId: input.scopeCategoryId ?? null, scopeCategoryIds, productCount: scopeProductIds.length, requiredImages, imagesPolicy, assigneeIds },
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

/**
 * قاموسٌ لبنية إشعارِ التغيّر لكل انتقالٍ — العنوان/النص/متطلَّب الفعل. مركزيٌّ كي لا
 * يعود المطوّرُ ليصيغَ رسالةً ثانيةً في مسارٍ آخر، ولا تُهدَر ترجمةٌ بحسب المسار.
 *
 * `survivingJobs` تُبدّل الرسالة لـCOMPLETED/CANCELLED (مراجعة Codex P1 على PR #862):
 * الحالتان النهائيّتان تُلغيان الطابور غير المسنَد فقط، والمهامّ المُسنَدة تبقى قابلةً
 * للإتمام. رسالةُ «لا حاجةَ لعملٍ» على مصوّرٍ لا يزال يملك مهاماً حيّة تدفعه لهجرها
 * فتصير يتيمةً. مصفوفة الرسائل:
 *   PAUSED             — إعلامٌ إعلاميّ (لا يعتمد على survivingJobs)
 *   ACTIVE (استئناف)   — إعلامٌ إعلاميّ
 *   COMPLETED + 0 jobs — تهنئةُ إغلاق
 *   COMPLETED + N jobs — «الحملة أُغلقت لكنّك تحتفظ بـN مهمّة — أنجزها»
 *   CANCELLED + 0 jobs — «طابورها أُلغي، لا حاجةَ لعملٍ إضافيّ»
 *   CANCELLED + N jobs — «مهامّك المسنَدة قائمةٌ ولم تُلغَ — أكملها أو راجع المدير»
 */
function studioCampaignTransitionNotification(status: StudioCampaignStatus, campaignName: string, survivingJobs: number): { title: string; body: string; requiresAction: boolean } | null {
  switch (status) {
    case "PAUSED":
      return {
        title: "حملة تصوير موقوفة مؤقّتاً",
        body: `أوقف المدير حملة «${campaignName}» مؤقّتاً — لن تستطيع سحب منتجاتٍ جديدة منها حتى الاستئناف، ومهامك المسنَدة تبقى قابلةً للإتمام.`,
        requiresAction: false,
      };
    case "ACTIVE":
      return {
        title: "استُؤنفت حملة تصوير",
        body: `أعاد المدير تفعيل حملة «${campaignName}» — يمكنك مسح منتجاتها من جديد.`,
        requiresAction: false,
      };
    case "COMPLETED":
      return survivingJobs > 0
        ? {
            title: "أُغلقت حملة تصوير — مهامّك قائمة",
            body: `أكمل المدير حملة «${campaignName}» لكنّك تحتفظ بـ${survivingJobs} مهمّة مسنَدةً — أنجزها قبل أن تنقضي مواعيدها.`,
            requiresAction: true,
          }
        : {
            title: "أُغلقت حملة تصوير",
            body: `أكمل المدير حملة «${campaignName}» — لا مهامَّ مسنَدة إليك، شكراً على عملك.`,
            requiresAction: false,
          };
    case "CANCELLED":
      return survivingJobs > 0
        ? {
            title: "أُلغيت حملة تصوير — مهامّك لم تُلغَ",
            body: `ألغى المدير حملة «${campaignName}» لكنّه لم يُلغِ مهامّك المسنَدة (${survivingJobs}) — أكملها أو راجع المدير لإلغائها فرداً فرداً.`,
            requiresAction: true,
          }
        : {
            title: "أُلغيت حملة تصوير",
            body: `ألغى المدير حملة «${campaignName}» — طابورها غير المسنَد أُغلق، لا حاجةَ لعملٍ إضافيّ منك.`,
            requiresAction: false,
          };
    default:
      return null;
  }
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
    /**
     * ٢٩/٨ (بلاغ مالك: «ألغيت الحملات ولكن مازالت تظهر مهام مسندة»): عند CANCELLED، إن
     * كانت `true` تُلغى **كلّ** المهام الحيّة (ASSIGNED/IN_PROGRESS/PENDING_REVIEW/REJECTED)
     * لا الطابور غير المسنَد فقط. القرار للمدير عبر الشاشة — الافتراضيّ `false` يُصان به
     * عملُ الموظف كما هو تاريخياً (اختبارٌ صريح يحرسه).
     */
    cascadeAssignedTasks?: boolean;
  },
  notificationWriter: AppNotificationWriter = createAppNotification,
) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  // UUID واحد لكل **حدث انتقال**. يُحفَظ في outbox داخل المعاملة، لذا دورتان
  // PAUSED→ACTIVE متكررتان لا تتشاركان مفتاحاً، بينما إعادة مصالحة الحدث نفسه تبقى
  // idempotent بقيد appNotifications.eventKey الفريد.
  const notificationOccurrenceId = randomUUID();
  const outcome = await withStudioTx(async (tx) => {
    const campaign = (
      await tx
        .select()
        .from(productStudioCampaigns)
        .where(eq(productStudioCampaigns.id, input.campaignId))
        .limit(1)
        .for("update")
    )[0];
    if (!campaign) {
      throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: "تعذّر تغيير حالة الحملة", why: "لا حملة بهذا الرقم — حُذفت أو تغيّرت بعد فتحك الشاشة", doThis: "حدّث لوحة الحملات واختر الحملة من جديد" }) });
    }
    assertCampaignAccess(actor, campaign);
    // مصفوفة الانتقالات المشروعة بعد إضافة PAUSED (٢٨/٨، تجميد ذكيّ):
    //   DRAFT     → ACTIVE | CANCELLED
    //   ACTIVE    → PAUSED | COMPLETED | CANCELLED
    //   PAUSED    → ACTIVE | COMPLETED | CANCELLED   (الاستئناف هو PAUSED→ACTIVE)
    //   COMPLETED / CANCELLED نهائيّتان
    // إبقاء الحرسِ صريحاً على شكل جدولٍ يمنع «انزلاقاً» غير مقصود كإعادة تفعيلٍ من CANCELLED.
    const legal =
      (campaign.status === "DRAFT" &&
        (input.status === "ACTIVE" || input.status === "CANCELLED")) ||
      (campaign.status === "ACTIVE" &&
        (input.status === "PAUSED" || input.status === "COMPLETED" || input.status === "CANCELLED")) ||
      (campaign.status === "PAUSED" &&
        (input.status === "ACTIVE" || input.status === "COMPLETED" || input.status === "CANCELLED"));
    if (!legal) {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر تغيير حالة الحملة", why: "الانتقال المطلوب غير مشروعٍ من حالتها الراهنة — المكتملة والملغاة نهائيّتان، والمسوّدة تُفعَّل أو تُلغى فقط", doThis: "حدّث لوحة الحملات لتقرأ حالتها الراهنة ثمّ اختر إجراءً متاحاً لها، أو أنشئ حملةً جديدة" }) });
    }
    const startsAt =
      input.status === "ACTIVE"
        ? (input.startsAt ?? campaign.startsAt ?? new Date())
        : campaign.startsAt;
    const dueAt = input.dueAt === undefined ? campaign.dueAt : input.dueAt;
    if (startsAt && dueAt && dueAt <= startsAt) {
      throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر تغيير حالة الحملة", why: "الموعد النهائيّ الناتج يسبق تاريخ البداية أو يساويه", doThis: "عدّل الموعد النهائيّ إلى تاريخٍ بعد البداية من زرّ تعديل الحملة، ثمّ أعد تغيير الحالة" }) });
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
        ? await cancelCampaignQueuedTasksInTx(tx, actor, campaign, input.reason?.trim() || `أُلغيت مع حملة «${campaign.name}» (#${input.campaignId})`, input.cascadeAssignedTasks === true ? "productStudio.campaign.cancelWithCampaign.cascade" : "productStudio.campaign.cancelWithCampaign", { cascadeAssigned: input.cascadeAssignedTasks === true })
        : { cancelledCount: 0, remaining: 0 };
    // قائمةُ المستلمين تُلتقط داخل المعاملة (مرجعٌ اتّساقيّ) وتُحوَّل إلى نوايا دائمة في
    // المعاملة نفسها. التسليم وحده يجري بعد commit كي لا يُدحرَج الانتقال بسبب عطلٍ عابر.
    //
    // اتحادُ (عضويّة الحملة) ∪ (مالكو مهام حيّة على الحملة) بعد مراجعة Codex P2 على PR #862:
    // `updateCampaignAssignees` يحذف صفَّ العضويّة ويترك المهامَّ سليمةً — فمصوّرٌ أُخرج من
    // الفريق وأبقى بيدِه مهامَّ مسنَدةً كان يفوت الإشعار. الاتحادُ يضمن أنّ صاحبَ عملٍ حيٍّ
    // على الحملة يعرف تغيّرَ حالتها حتى لو حُذفت عضويّته.
    //
    // survivingJobsByUser (Codex P1): كل مستلمٍ يحصل على رسالةٍ تعكس **جزءه** من الطابور
    // المتبقّي بعد الانتقال — لا رسالةٌ عامّة «لا حاجةَ لعملٍ» على مصوّرٍ يملك مهاماً حيّة
    // (CANCELLED/COMPLETED يلغيان الطابور غير المسنَد فقط).
    const assigneeRows = await tx
      .select({ userId: productStudioCampaignAssignees.userId })
      .from(productStudioCampaignAssignees)
      .where(eq(productStudioCampaignAssignees.campaignId, input.campaignId));
    const jobOwnerRows = await tx
      .selectDistinct({ userId: productImageJobs.assignedTo })
      .from(productImageJobs)
      .where(and(
        eq(productImageJobs.campaignId, input.campaignId),
        isNotNull(productImageJobs.assignedTo),
        inArray(productImageJobs.status, ["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"]),
      ));
    const recipientIds = Array.from(new Set([
      ...assigneeRows.map((r) => Number(r.userId)),
      ...jobOwnerRows.map((r) => Number(r.userId)),
    ]));
    // عدُّ الأحياء لكل مستلمٍ — نداءٌ واحد GROUP BY assignedTo كي لا نكرّر استعلام لكل مستلم.
    const survivingCounts = recipientIds.length === 0
      ? []
      : await tx
          .select({ userId: productImageJobs.assignedTo, n: sql<number>`count(*)` })
          .from(productImageJobs)
          .where(and(
            eq(productImageJobs.campaignId, input.campaignId),
            inArray(productImageJobs.assignedTo, recipientIds),
            inArray(productImageJobs.status, ["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"]),
          ))
          .groupBy(productImageJobs.assignedTo);
    const survivingByUser = new Map<number, number>();
    for (const row of survivingCounts) {
      if (row.userId != null) survivingByUser.set(Number(row.userId), Number(row.n));
    }
    const notificationIntents: AppNotificationOutboxIntent[] = [];
    for (const userId of recipientIds) {
      const notification = studioCampaignTransitionNotification(input.status, campaign.name, survivingByUser.get(userId) ?? 0);
      if (!notification) continue;
      notificationIntents.push({
        branchId: Number(campaign.branchId),
        streamKey: `studio.campaign:${input.campaignId}:user:${userId}`,
        occurrenceId: notificationOccurrenceId,
        notification: {
          userId,
          kind: "TASK_ASSIGNED",
          title: notification.title,
          body: notification.body,
          route: `/catalog/image-studio?campaign=${input.campaignId}`,
          eventKey: `studio.campaign.transition:${input.campaignId}:${notificationOccurrenceId}:${userId}`,
          entityType: "productStudioCampaign",
          entityId: input.campaignId,
          requiresAction: notification.requiresAction,
        },
      });
    }
    // Transactional outbox حقيقي ومفهرس: نجاح المعاملة يعني أنّ كل نية باقية حتى لو
    // تعطلت كتابة appNotifications اللاحقة؛ العامل الدوري يعيدها بلا مسح سجل التدقيق.
    await enqueueAppNotificationOutbox(tx, notificationIntents);
    return {
      campaignId: input.campaignId,
      status: input.status,
      startsAt,
      dueAt,
      cancelledTasks: cascade.cancelledCount,
      /** مهام طابورٍ لم تُلغَ بعد لأنّ الدفعة محدودة — تُستكمل بزرّ إلغاء الطابور. */
      remainingTasks: cascade.remaining,
      /** يُستعمَل خارج المعاملة لتسليم نوايا هذا الحدث فوراً — ليس جزءاً من عقد الواجهة. */
      _notificationOccurrenceId: notificationOccurrenceId,
    };
  });
  // محاولةٌ فورية بعد commit لتحافظ الشاشة على زمن الاستجابة السابق. إن فشلت القراءة
  // أو الكتابة لا يضيع شيء: سجلّ النية الذرّي يبقى، والعامل الدوري يعيد المصالحة.
  try {
    await reconcileStudioCampaignTransitionNotifications(actor, {
      occurrenceId: outcome._notificationOccurrenceId,
      notificationWriter,
    });
  } catch (error) {
    logger.warn({ err: error, campaignId: outcome.campaignId, status: outcome.status, occurrenceId: outcome._notificationOccurrenceId }, "productStudio.campaign.transition.notification_reconcile_failed");
  }
  // الحقل الداخليّ يُقشَّر قبل الإعادة — عقد الواجهة لا يحمل معرّف نية الإشعار.
  const { _notificationOccurrenceId: _occurrenceId, ...publicResult } = outcome;
  void _occurrenceId;
  return publicResult;
}

/**
 * يصالح outbox انتقالات الحملات مع صندوق التطبيق الدائم. السحب بقفل skip-locked وlease
 * يمنع احتكار الصفوف الفاشلة للدفعة، و`appNotifications.eventKey` يحسم نافذة الانهيار
 * بين إنشاء الإشعار وختم النية. بعدها يتولى `nativePushOutbox` إعادة محاولات الدفع.
 */
export async function reconcileStudioCampaignTransitionNotifications(
  actor: ProductStudioActor,
  options: { occurrenceId?: string; limit?: number; notificationWriter?: AppNotificationWriter } = {},
): Promise<{ createdCount: number; claimedCount: number; failedCount: number }> {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  if (!canCrossBranches(actor) && actor.branchId == null) {
    throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({ what: "تعذّر إرسال إشعارات الحملة", why: "حسابك بلا فرعٍ مُسنَد، وإشعارات الحملة تُرسَل ضمن نطاق فرعٍ محدَّد", doThis: "اطلب من مدير النظام ربط حسابك بفرعٍ من صفحة المستخدمين، ثمّ أعد المحاولة" }) });
  }
  const result = await reconcileAppNotificationOutbox({
    branchId: canCrossBranches(actor) ? undefined : Number(actor.branchId),
    occurrenceId: options.occurrenceId,
    limit: options.limit,
    notificationWriter: options.notificationWriter,
  });
  // النداء المقيّد بـoccurrenceId هو التسليم الطبيعيّ الفوري لكل انتقال؛ لا نحوله إلى
  // تحذير. التحذير يخصّ ما التقطه العامل لاحقاً، لأنه دليل فشلٍ سابق يستحق المراقبة.
  if (result.createdCount > 0 && !options.occurrenceId) {
    logger.warn({ createdCount: result.createdCount, claimedCount: result.claimedCount, failedCount: result.failedCount }, "productStudio.campaign.transition.notifications_reconciled");
  }
  return { createdCount: result.createdCount, claimedCount: result.claimedCount, failedCount: result.failedCount };
}

export async function listStudioCampaigns(actor: ProductStudioActor) {
  if (!isManager(actor) && actor.role !== "auditor") throw new TRPCError({ code: "FORBIDDEN" });
  const conditions = canCrossBranches(actor) ? undefined : eq(productStudioCampaigns.branchId, Number(actor.branchId));
  const db = requireDb();
  const rows = await db
    .select({
      id: productStudioCampaigns.id,
      name: productStudioCampaigns.name,
      branchId: productStudioCampaigns.branchId,
      status: productStudioCampaigns.status,
      startsAt: productStudioCampaigns.startsAt,
      dueAt: productStudioCampaigns.dueAt,
      // `requiredImages` + `imagesPolicy` + `scopeKind`/`scopeCategoryId` تُعاد كي يُحرِّرها
      // المدير بلا استعلامٍ ثانٍ، والشاشة تُميّز الحملات ONLY_MISSING عن ANY_REGARDLESS.
      // فئات النطاق CATEGORIES تُلحق أدناه من الجدول الجانبيّ (طلب Codex P2 على PR #825).
      requiredImages: productStudioCampaigns.requiredImages,
      imagesPolicy: productStudioCampaigns.imagesPolicy,
      scopeKind: productStudioCampaigns.scopeKind,
      scopeCategoryId: productStudioCampaigns.scopeCategoryId,
      createdAt: productStudioCampaigns.createdAt,
      // اسمُ منشئ الحملة + عدد مصوّريها (٢٩/٨) — يُوضّحان الملكيّةَ والفريقَ في السطر
      // الواحد بلا نداءٍ ثانٍ من الواجهة. `assigneeCount` عبر subquery correlated (فرد
      // بفرد، بلا JOIN) لأنّ الحملات قد تصل عشراتٍ لكل صفٍ ٤٥+ مصوّراً في الحالة القصوى.
      //
      // Codex P2: تُستبعَد الحسابات غير المتاحة (isActive=false أو accessExpiresAt ماضٍ)
      // كي لا يُخفي مصوّرٌ مؤقّتٌ منتهي الصلاحية تحذيرَ «صفر فريق». المصوّر المؤقّت يحمل
      // صفَّ عضويّةٍ للحفاظ على الأثر التدقيقيّ حتى بعد الإبطال (revokeTemporaryPhotographers
      // يجعله `isActive=false` مع `accessExpiresAt=revokedAt` بلا مسِّ صفّ العضويّة).
      createdByName: users.name,
      assigneeCount: sql<number>`(
        select count(*)
        from ${productStudioCampaignAssignees} psca
        inner join users a on a.id = psca.userId
        where psca.campaignId = ${productStudioCampaigns.id}
          and a.isActive = 1
          and (a.accessExpiresAt is null or a.accessExpiresAt > now())
      )`,
    })
    .from(productStudioCampaigns)
    // LEFT JOIN كي يُقاوم صفَّ حملةٍ يتيمٍ (منشئ محذوف) — لا يُسقطها من القائمة.
    .leftJoin(users, eq(users.id, productStudioCampaigns.createdBy))
    .where(conditions)
    .orderBy(desc(productStudioCampaigns.createdAt), desc(productStudioCampaigns.id));
  if (rows.length === 0) return [];
  const campaignsWithCategoriesScope = rows.filter((r) => r.scopeKind === "CATEGORIES").map((r) => Number(r.id));
  const categoryLinks = campaignsWithCategoriesScope.length === 0
    ? []
    : await db
        .select({
          campaignId: productStudioCampaignCategories.campaignId,
          categoryId: productStudioCampaignCategories.categoryId,
        })
        .from(productStudioCampaignCategories)
        .where(inArray(productStudioCampaignCategories.campaignId, campaignsWithCategoriesScope));
  const categoriesByCampaign = new Map<number, number[]>();
  for (const link of categoryLinks) {
    const cid = Number(link.campaignId);
    if (!categoriesByCampaign.has(cid)) categoriesByCampaign.set(cid, []);
    categoriesByCampaign.get(cid)!.push(Number(link.categoryId));
  }
  return rows.map((r) => ({ ...r, scopeCategoryIds: categoriesByCampaign.get(Number(r.id)) ?? [] }));
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
    // PAUSED (٢٨/٨، تجميد ذكيّ) تُشمَل: المصوّر يفقد بابَ الإنشاء الجديد بالمسح، لكنّ
    // المهام المُسنَدة إليه سلفاً في حملةٍ مُوقَفة لا تختفي عن لوحته — يستطيع إتمامها.
    // الشاشة تميّز الحالتين بشارةٍ (`status` مُعادٌ لكل صفّ)، فالمصوّر يعرف أنّه لن
    // يستطيع سحب منتجٍ جديد تحت هذه الحملة حتى يستأنفها المدير.
    .where(and(inArray(productStudioCampaigns.status, ["ACTIVE", "PAUSED"]), branchFilter))
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
        .where(and(eq(products.isActive, true), eq(products.isService, false), campaignScopeCondition(scope)));
      const totalProducts = Number(totals?.total ?? 0);
      const campaignDone = Number(totals?.complete ?? 0);
      return {
        campaignId: Number(row.id),
        name: row.name,
        branchId: row.branchId == null ? null : Number(row.branchId),
        // PAUSED (٢٨/٨) مضافة إلى القاموس — ينكسر الاستنتاج للواجهة إن نسينا توسيع هذا
        // التمثيل. المصدر الوحيد للسلسلة `shared/studioCampaignStatus.ts`.
        status: row.status as import("@shared/studioCampaignStatus").StudioCampaignStatus,
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
      message: appErrorMessage({
        what: "تعذّر فتح الحملة",
        why: "لا حملة بهذا الرقم — حُذفت أو تغيّر رقمها بعد فتحك الشاشة",
        doThis: "حدّث لوحة الحملات واختر الحملة من القائمة",
      }),
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
function campaignScopeCondition(campaign: { id: number | string; scopeKind: "ALL" | "CATEGORY" | "CATEGORIES" | "PRODUCTS"; scopeCategoryId: number | null }) {
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
  if (campaign.scopeKind === "CATEGORIES") {
    // فئاتٌ متعدّدة، كلٌّ بشجرتها الفرعيّة. CTE عوديّ يبدأ من كل الفئات المختارة معاً
    // ويتوسّع نزولاً. هجرة 0269.
    return sql`${products.categoryId} in (
      with recursive category_tree (id) as (
        select ${productStudioCampaignCategories.categoryId} from ${productStudioCampaignCategories}
        where ${productStudioCampaignCategories.campaignId} = ${Number(campaign.id)}
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
 * «ناقص» بحسب سياسة الحملة:
 *   • ONLY_MISSING — منتج نشط لم يبلغ `requiredImages` صور معتمَدة، ولا مهمّة نشطة له.
 *   • ANY_REGARDLESS — كل منتج نشط ضمن النطاق، بلا فحص الاكتمال (السياسة الجديدة — هجرة
 *     0269). المالك يريد إضافة صور جديدة لمنتجاتٍ مكتملة بلا إعادة إنشاء الحملة.
 *
 * كان التعريف السابق «< requiredImages صور» ⇒ منتجٌ مكتملٌ يختفي أبداً. الآن السياسة تختار.
 * فحصُ «مهمّة نشطة» يبقى دائماً — منعُ ازدواج المهام بغضّ النظر عن السياسة.
 */
function missingStudioProductConditions(requiredImages = 1, imagesPolicy: "ONLY_MISSING" | "ANY_REGARDLESS" = "ONLY_MISSING", campaignId?: number | string | null) {
  const required = Math.max(1, Math.trunc(requiredImages));
  const missingCountCondition = imagesPolicy === "ANY_REGARDLESS"
    ? undefined
    : sql`(select count(*) from ${productImages} where ${productImages.productId} = ${products.id} and ${productImages.reviewStatus} = 'APPROVED') < ${required}`;
  // في ONLY_MISSING الفحصُ activeSlot=1 يكفي — بمجرد اعتماد الصورة يخرج المنتج بشرط
  // العدّ. في ANY_REGARDLESS المنتج المكتمل مسموحٌ ⇒ إن اقتصر الفحص على activeSlot=1
  // فإنّ approve يفرّغه فيصير المنتج «ناقصاً» فوراً ⇒ باكلوغ لا نهائيّ (الجذر:
  // مراجعة Codex P1 على PR #825). الحلّ: في ANY_REGARDLESS نستبعد أيضاً كل منتجٍ
  // له مهمّةٌ **في هذه الحملة تحديداً** بأيّ حالة — فتظلّ المهمّة الواحدة كافيةً حتى
  // يتّخذ المدير قرار «زيادة» صريحاً (بحذف قديمةٍ أو تجديد الحملة).
  const anyJobInThisCampaign = imagesPolicy === "ANY_REGARDLESS" && campaignId != null
    ? sql`not exists (select 1 from ${productImageJobs} where ${productImageJobs.productId} = ${products.id} and ${productImageJobs.campaignId} = ${Number(campaignId)})`
    : undefined;
  return and(
    eq(products.isActive, true),
    // المنتج الخدميّ (طباعة/تصميم/رسوم) لا مخزونَ ماديّاً له يُصوَّر — يُستبعَد من
    // كل حملات التصوير تلقائياً. كان يظهر في الطابور ويُتوقَّع تصويره بلا معنى.
    eq(products.isService, false),
    missingCountCondition,
    anyJobInThisCampaign,
    sql`not exists (select 1 from ${productImageJobs} where ${productImageJobs.productId} = ${products.id} and ${productImageJobs.activeSlot} = 1)`,
  );
}

type CampaignScope = { id: number | string; scopeKind: "ALL" | "CATEGORY" | "CATEGORIES" | "PRODUCTS"; scopeCategoryId: number | null; requiredImages?: number | null; imagesPolicy?: "ONLY_MISSING" | "ANY_REGARDLESS" | null };

async function countMissingStudioProducts(db: ReturnType<typeof requireDb> | StudioTx, campaign?: CampaignScope) {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(products)
    .where(and(missingStudioProductConditions(campaign?.requiredImages ?? 1, campaign?.imagesPolicy ?? "ONLY_MISSING", campaign?.id), campaign ? campaignScopeCondition(campaign) : undefined));
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
    .where(and(missingStudioProductConditions(campaign?.requiredImages ?? 1, campaign?.imagesPolicy ?? "ONLY_MISSING", campaign?.id), campaign ? campaignScopeCondition(campaign) : undefined))
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
        message: appErrorMessage({
          what: "تعذّر توليد مهامّ الحملة",
          why: "لا حملة بهذا الرقم — حُذفت بعد فتحك الشاشة",
          doThis: "حدّث لوحة الحملات واختر الحملة، ثمّ أعد التوليد",
        }),
      });
    assertCampaignAccess(actor, campaign);
    if (campaign.status !== "ACTIVE") {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر توليد مهامّ الحملة",
          why: "الحملة ليست نشطة، والتوليد يجري على النشطة وحدها كي لا يُنشأ طابورٌ لحملةٍ مسوّدةٍ أو مُغلقة",
          doThis: "فعّل الحملة من لوحة الحملات ثمّ أعد التوليد",
        }),
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
 * تعديلُ بيانات الحملة الجارية — الاسم، عدد الصور المطلوب لكل منتج، والمواعيد.
 *
 * قبل هذه الدالة: بعد إنشاء الحملة كان الوحيد إلغاؤها وإعادة إنشائها. الحاجة العمليّة:
 * المدير يكتشف بعد بدء العمل أنّ بعض المنتجات تحتاج أكثر من صورة، أو أنّ التاريخ الموعود
 * تغيّر — لا معنى لخسارة تدقيق الحملة كاملةً لأجل تصحيحٍ صغير.
 *
 * ما يُقبَل:
 *   • `name` — تجميليّ، آمنٌ في كل الحالات.
 *   • `requiredImages` — يُغيّر تعريف «ناقص» في `missingStudioProductConditions`؛
 *     رفعُه يُعيد منتجاتٍ كانت مكتملةً إلى الطابور (السلوك المطلوب حين اكتُشفت الحاجة
 *     لأكثر من صورة)، وتخفيضُه قد يُغلق مهمّاتٍ قائمةً بلا مساس. لا نمنع كليهما.
 *   • `startsAt` — تعديلٌ يسبق البدء أو يُصحّح الوقت المُعلَن؛ لا يُعاد كتابة الماضي.
 *   • `dueAt` — أهمّ حقلٍ عمليّاً؛ إشعارات المتأخّرات تعتمده مباشرةً.
 *
 * ما لا يُقبَل هنا:
 *   • `branchId` — لقطة موضعٍ لا تُنقَل (يُخالف قفل الفرع في المهام المُولَّدة).
 *   • `status` — له مسارٌ خاصّ (`transitionStudioCampaign`) يجرّ الطابور.
 *   • `scopeKind`/`scopeCategoryId`/`scopeProductIds` — تغييرٌ يُطلّق المهام القائمة
 *     على منتجاتٍ خارج النطاق الجديد بلا مسارِ استرداد. إن لزم فتوجّه إلى الإلغاء.
 *
 * الحرّاس: على حملةٍ نشطةٍ أو مسوَّدة فقط (لا COMPLETED/CANCELLED)، وعلى فرعها،
 * وعلى مدير `productStudio`. رفضٌ لطلبٍ فارغ (بلا حقلٍ مُصرَّح).
 */
export async function updateStudioCampaignDetails(
  actor: ProductStudioActor,
  input: {
    campaignId: number;
    name?: string;
    requiredImages?: number;
    startsAt?: Date | null;
    dueAt?: Date | null;
  },
) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length < 3 || name.length > 180) {
      throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر تعديل الحملة", why: "اسم الحملة خارج المدى المسموح — المطلوب من 3 إلى 180 حرفاً", doThis: "اكتب اسماً بين 3 و180 حرفاً ثمّ احفظ التعديل" }) });
    }
    patch.name = name;
  }
  if (input.requiredImages !== undefined) {
    const required = Math.trunc(Number(input.requiredImages));
    if (!Number.isSafeInteger(required) || required < 1 || required > 10) {
      throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر تعديل الحملة", why: "عدد الصور المطلوبة لكلّ منتج خارج المدى المسموح — المطلوب من 1 إلى 10 صور", doThis: "اضبط «صور مطلوبة» على عددٍ بين 1 و10 صور ثمّ احفظ التعديل" }) });
    }
    patch.requiredImages = required;
  }
  if (input.startsAt !== undefined) patch.startsAt = input.startsAt;
  if (input.dueAt !== undefined) patch.dueAt = input.dueAt;
  if (Object.keys(patch).length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر تعديل الحملة", why: "الطلب وصل بلا أيّ حقلٍ مُغيَّر، فلا شيء يُحفَظ", doThis: "غيّر الاسم أو عدد الصور أو التواريخ في النموذج ثمّ احفظ" }) });
  }
  return withStudioTx(async (tx) => {
    const [campaign] = await tx.select().from(productStudioCampaigns).where(eq(productStudioCampaigns.id, input.campaignId)).limit(1).for("update");
    if (!campaign) throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: "تعذّر تعديل الحملة", why: "لا حملة بهذا الرقم — حُذفت بعد فتحك النموذج", doThis: "حدّث لوحة الحملات واختر الحملة من جديد" }) });
    assertCampaignAccess(actor, campaign);
    if (campaign.status === "COMPLETED" || campaign.status === "CANCELLED") {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر تعديل الحملة", why: "الحملة مكتملة أو ملغاة، والمُغلقة سجلٌّ تاريخيٌّ لا يُعدَّل", doThis: "أنشئ حملةً جديدةً بالبيانات المطلوبة بدل تعديل المُغلقة" }) });
    }
    // تحقّقُ ترتيبٍ زمنيّ: يُقاس على القيم الجديدة إن قُدِّمت، وإلّا القائمة.
    const effectiveStartsAt = patch.startsAt === undefined ? campaign.startsAt : (patch.startsAt as Date | null);
    const effectiveDueAt = patch.dueAt === undefined ? campaign.dueAt : (patch.dueAt as Date | null);
    if (effectiveStartsAt && effectiveDueAt && effectiveDueAt <= effectiveStartsAt) {
      throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر تعديل الحملة", why: "الموعد النهائيّ الناتج يسبق تاريخ البداية أو يساويه", doThis: "اضبط الموعد النهائيّ على تاريخٍ بعد البداية ثمّ احفظ التعديل" }) });
    }
    await tx.update(productStudioCampaigns).set(patch).where(eq(productStudioCampaigns.id, input.campaignId));

    // تعديلُ `dueAt` يتالى إلى (١) المهامّ الحيّة على الحملة و(٢) المصوّرين المؤقّتين
    // (٢٩/٨، مراجعة Codex P1 على PR #862): زرّ «+٧ أيام» كان يُحدّث `productStudioCampaigns`
    // فقط، والمهامّ المُسنَدة تحمل نسخةَ الموعد القديم (نُقلت لحظة توليد الطابور)، والحسابات
    // المؤقّتة لها `accessExpiresAt = campaign.dueAt` (نُقلت لحظة الإنشاء) — فالواجهة تُبلّغ
    // بتمديدٍ ناجح بينما المهامّ تبقى متأخّرة والمصوّر المؤقّت يُقفَل حسابه في الموعد الأصليّ.
    // النطاق ضيّق: المهام الحيّة فقط (ASSIGNED/IN_PROGRESS/PENDING_REVIEW/REJECTED)، والحسابات
    // المؤقّتة **غير المُبطَلة** (`isActive=true`) كي لا نعيد إحياءَ حسابٍ أُلغي قصداً.
    let cascadeJobs = 0;
    let cascadeTempUsers = 0;
    if (patch.dueAt !== undefined) {
      const newDueAt = patch.dueAt as Date | null;
      const jobsResult = await tx
        .update(productImageJobs)
        .set({ dueAt: newDueAt })
        .where(and(
          eq(productImageJobs.campaignId, input.campaignId),
          inArray(productImageJobs.status, ["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"]),
        ));
      // mysql2 driver يُرجع rowsAffected في result[0].affectedRows؛ درizzle يلفّه في header.
      // نعتمد على `changes`/`rowsAffected` بحسب الـdriver — إن غاب نعدّ صفراً بلا فشل.
      cascadeJobs = Number((jobsResult as unknown as { rowsAffected?: number; affectedRows?: number }).rowsAffected
        ?? (jobsResult as unknown as { affectedRows?: number }).affectedRows
        ?? 0);
      // المصوّرون المؤقّتون: مطابقةٌ عبر جدول العضويّة + بادئة `openId=studio-temp:`.
      // `newDueAt=null` = «بلا موعد» ⇒ نُبقي وصولَهم حتى إبطالٍ إداريّ صريح؛ إن وُجد موعدٌ
      // جديد فهو مصدرُ الحقيقة كما كان الأصل. لا نطيلُ أبداً `accessExpiresAt` وراء
      // `newDueAt` — الأمانُ هنا في الاتّجاه الواحد.
      const tempUsersResult = await tx
        .update(users)
        .set({ accessExpiresAt: newDueAt })
        .where(and(
          eq(users.isActive, true),
          like(users.openId, "studio-temp:%"),
          sql`${users.id} in (select ${productStudioCampaignAssignees.userId} from ${productStudioCampaignAssignees} where ${productStudioCampaignAssignees.campaignId} = ${input.campaignId})`,
        ));
      cascadeTempUsers = Number((tempUsersResult as unknown as { rowsAffected?: number; affectedRows?: number }).rowsAffected
        ?? (tempUsersResult as unknown as { affectedRows?: number }).affectedRows
        ?? 0);
    }

    const oldSnapshot: Record<string, unknown> = {};
    const newSnapshot: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) {
      oldSnapshot[key] = (campaign as unknown as Record<string, unknown>)[key];
      const value = patch[key];
      newSnapshot[key] = value instanceof Date ? value.toISOString() : value;
    }
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: Number(campaign.branchId),
      action: "productStudio.campaign.updateDetails",
      entityType: "productStudioCampaign",
      entityId: String(input.campaignId),
      oldValue: oldSnapshot,
      newValue: { ...newSnapshot, cascadeJobs, cascadeTempUsers },
    });
    return { campaignId: input.campaignId, updated: Object.keys(patch), cascadeJobs, cascadeTempUsers };
  });
}

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
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر حفظ مصوّري الحملة", why: "القائمة المرسَلة تحمل معرّفاً غير صالح — أُرسل رقمٌ لا يخصّ مستخدماً", doThis: "حدّث الشاشة وأعد اختيار المصوّرين من القائمة ثمّ احفظ" }) });
  }
  return withStudioTx(async (tx) => {
    const [campaign] = await tx.select().from(productStudioCampaigns).where(eq(productStudioCampaigns.id, input.campaignId)).limit(1).for("update");
    if (!campaign) throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: "تعذّر حفظ مصوّري الحملة", why: "لا حملة بهذا الرقم — حُذفت بعد فتحك الشاشة", doThis: "حدّث لوحة الحملات واختر الحملة من جديد" }) });
    assertCampaignAccess(actor, campaign);
    if (campaign.status === "CANCELLED" || campaign.status === "COMPLETED") {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر حفظ مصوّري الحملة", why: "الحملة مكتملة أو ملغاة، ولا يُضاف مصوّرٌ إلى حملةٍ لا عمل فيها", doThis: "أنشئ حملةً جديدةً وأضِف مصوّريها فيها" }) });
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
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر إنشاء حساب المصوّر المؤقّت", why: "الاسم خارج المدى المسموح — المطلوب من 3 إلى 80 حرفاً", doThis: "اكتب اسم المصوّر بين 3 و80 حرفاً ثمّ أنشئ الحساب" }) });
  }
  const campaign = await loadCampaign(actor, input.campaignId);
  if (campaign.status !== "ACTIVE" && campaign.status !== "DRAFT") {
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر إنشاء حساب المصوّر المؤقّت", why: "الحملة مكتملة أو ملغاة، والحساب المؤقّت ينتهي بموعدها فلا عمل له فيها", doThis: "أنشئ الحساب على حملةٍ نشطةٍ أو مسوّدة، أو أنشئ حملةً جديدةً أوّلاً" }) });
  }
  // الانتهاء يتبع موعد الحملة، وبسقفٍ افتراضيّ إن كانت بلا موعد — لا حسابَ بلا نهاية.
  const expiresAt = campaign.dueAt ?? new Date(Date.now() + TEMP_ACCOUNT_FALLBACK_DAYS * 24 * 60 * 60_000);
  if (expiresAt.getTime() <= Date.now()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر إنشاء حساب المصوّر المؤقّت", why: "موعد الحملة مضى، وصلاحية الحساب المؤقّت تنتهي بموعدها — فيُغلَق ساعة إنشائه", doThis: "مدّد موعد الحملة إلى تاريخٍ قادم من زرّ تعديل الحملة، ثمّ أنشئ الحساب" }) });
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
    .where(and(eq(products.isActive, true), eq(products.isService, false), campaignScopeCondition(campaign)));
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
        // الغياب يُقاس بمعيارَين متمايزَين بحسب الحالة، مقصودَين معاً:
        //   • ASSIGNED/IN_PROGRESS ⇒ أيّ إشعارٍ سابقٍ للمهمّة يكفي (منعُ إغراقٍ عند رفع
        //     `revision` من حفظ مسودة أو تعديل موعد — يحرسه اختبار ⭐).
        //   • REJECTED             ⇒ يلزم إشعارُ رفضٍ لهذا التنقيح بالضبط، لأنّ إشعار
        //     إسنادٍ سابقٍ لا يُبلّغ عن الرفض. الجذر: مراجعة Codex P2 على PR #776 (٢٥/٨).
        // الفرق حاسم: توسيعُ المعيار الثاني على الإسناد يُنشئ إشعاراً بعد كل حفظ مسودة،
        // وتضييقُه على الرفض وحده يُبقي الرفضَ المفقود صامتاً.
        sql`not exists (
          select 1 from ${appNotifications} n
          where n.userId = ${productImageJobs.assignedTo}
          and (
            (${productImageJobs.status} = 'REJECTED'
              and n.eventKey = concat('product-studio:', ${productImageJobs.id}, ':rejected:r', ${productImageJobs.revision}))
            or
            (${productImageJobs.status} in ('ASSIGNED', 'IN_PROGRESS')
              and n.entityType = 'productImageJob' and n.entityId = ${productImageJobs.id})
          )
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
      message: appErrorMessage({
        what: "تعذّر عرض الصفحة التالية من المهامّ",
        why: "مؤشّر الصفحة لم يعد مطابقاً للمرشّحات الحالية — تغيّر التبويب أو الحالة أو البحث بعد إنشائه",
        doThis: "أعد ضبط المرشّحات ثمّ تنقّل بين الصفحات من جديد",
      }),
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
    /**
     * ٢٩/٨ (بلاغ مالك: مهام الحملات الملغاة تُشوّش القائمة): يُخفي المهامَّ التي حملتُها
     * في حالةٍ نهائيّة (COMPLETED/CANCELLED). PAUSED تبقى ظاهرةً لأنّها لحظيةٌ لا نهائيّة —
     * المصوّر ينهي عمله المسنَد ثمّ يُنتظَر استئنافٌ إداريّ. `campaignId IS NULL` (المهام
     * المستقلّة بلا حملة، أو مهام PS بيدويّ) لا تُلمس.
     */
    hideClosedCampaigns?: boolean;
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
  // إخفاءُ مهام الحملات النهائيّة (٢٩/٨): يُنفَّذ في WHERE عبر subquery correlated كي لا
  // نُغيّر جدول الأصل ولا نضيف JOIN إضافياً للفلترة. `NOT IN` مع `IS NULL` (مهامّ بلا حملة).
  if (input.hideClosedCampaigns === true) {
    conds.push(
      sql`(${productImageJobs.campaignId} is null or ${productImageJobs.campaignId} not in (
        select id from ${productStudioCampaigns} where status in ('COMPLETED', 'CANCELLED')
      ))`,
    );
  }
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
      // بديل المهمّة (`variantId`+`variantName`) يُعاد كي تُميّز الشاشة بطاقتَي بديلَين
      // من المنتج نفسه. بلا هذا كانتا ظاهرتَين باسمٍ متطابق فيرفع المصوّرُ صورةً للبديل
      // الخطأ (الجذر: مراجعة Codex P1 على PR #807).
      variantId: productImageJobs.variantId,
      variantName: productVariants.variantName,
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
      // حالةُ حملة المهمّة تصعد إلى الواجهة (٢٩/٨) لتُبرزَ الشاشةُ شارة تحذير على المهام
      // التي تتبع حملةً مغلقة/موقوفة. `null` للمهام المستقلّة بلا حملة.
      campaignStatus: productStudioCampaigns.status,
    })
    .from(productImageJobs)
    .innerJoin(products, eq(products.id, productImageJobs.productId))
    .leftJoin(productVariants, eq(productVariants.id, productImageJobs.variantId))
    .leftJoin(users, eq(users.id, productImageJobs.assignedTo))
    .leftJoin(productStudioCampaigns, eq(productStudioCampaigns.id, productImageJobs.campaignId))
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
  if (!product) throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: "تعذّر عرض صور المنتج", why: "لا منتج نشطٌ بهذا الرقم — حُذف أو عُطِّل بعد فتحك الشاشة", doThis: "حدّث الشاشة واختر منتجاً نشطاً من القائمة" }) });
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
        message: appErrorMessage({
          what: "تعذّر إسناد المهمّة على صورة المصدر المطلوبة",
          why: "الصورة المطلوبة لا تخصّ هذا المنتج أو ليست معتمَدة، والعمل يبدأ من صورةٍ معتمَدةٍ للمنتج نفسه",
          doThis: "اختر صورةً معتمَدةً من معرض صور المنتج، أو أسنِد المهمّة بلا صورة مصدر",
        }),
      });
    return null;
  }

  if (source.objectKey && source.contentHash && source.mime) {
    if (!/^[0-9a-f]{64}$/i.test(source.contentHash) || !["image/png", "image/jpeg", "image/webp"].includes(canonicalImageMime(source.mime))) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر إسناد المهمّة على صورة المصدر المطلوبة",
          why: "سجلّ الصورة يحمل بصمةً أو نوع ملفٍّ غير صالح، فلا يمكن التحقّق من سلامة بايتاتها",
          doThis: "اختر صورة مصدرٍ أخرى من معرض المنتج، وأبلغ الدعم الفنّي بالصورة المعطوبة",
        }),
      });
    }
    if (!(await getImageStore().head(source.objectKey)).exists) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر إسناد المهمّة على صورة المصدر المطلوبة",
          why: "ملفّ الصورة غير موجودٍ في مخزن الصور رغم بقاء سجلّها، فلا مصدرَ يُسلَّم للمصوّر",
          doThis: "اختر صورة مصدرٍ أخرى، أو أسنِد المهمّة بلا مصدر ليصوّر المنتج من جديد",
        }),
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
        .where(and(eq(products.id, input.productId), eq(products.isActive, true), eq(products.isService, false)))
        .limit(1)
        .for("update")
    )[0];
    if (!product)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر إسناد مهمّة تصوير لهذا المنتج",
          why: "المنتج غير موجودٍ أو معطَّل أو خدميّ، ولا يُصوَّر إلّا منتجٌ نشطٌ مخزنيّ",
          doThis: "فعّل المنتج من صفحة المنتجات إن كان معطَّلاً، أو اختر منتجاً نشطاً، ثمّ أعد الإسناد",
        }),
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
    if (!assignee) throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر إسناد المهمّة", why: "المصوّر المختار غير موجودٍ أو غير نشط — أُوقف حسابه بعد فتحك القائمة", doThis: "حدّث قائمة المصوّرين واختر حساباً نشطاً ثمّ أعد الإسناد" }) });
    assertAssignableBranch(actor, assignee.branchId);
    if (!hasModuleAccess(assignee.role, assignee.permissionsOverride as PermissionMap | null, "productStudio", "FULL")) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إسناد المهمّة",
          why: "الموظّف لا يملك صلاحية «استوديو المنتجات»، فلن تظهر له المهمّة بعد إسنادها",
          doThis: "اضغط «امنح الصلاحية» أمام اسمه في قائمة الموظّفين ثمّ أعد الإسناد",
        }),
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
          message: appErrorMessage({
            what: "تعذّر إسناد المهمّة",
            why: "تغيّرت صورة المصدر المختارة أثناء الحفظ — نُشرت نسخةٌ أحدث أو سُحب اعتمادها",
            doThis: "حدّث الشاشة، ثمّ أعد اختيار صورة المصدر وأعد الإسناد",
          }),
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
        // إسنادُ المدير الفرديّ **مستوى-الأمّ فقط** (`variantId IS NULL`): مهامّ البدائل
        // من مسح المصوّر لها دورتها ولا يُسنِدها المدير هنا (الجذر: مراجعة Codex P2 على PR #807).
        .where(and(eq(productImageJobs.productId, input.productId), eq(productImageJobs.activeSlot, 1), isNull(productImageJobs.variantId)))
        .limit(1)
        .for("update")
    )[0];
    if (activeTask) {
      if (activeTask.assignedTo != null) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر إسناد مهمّة تصوير لهذا المنتج",
            why: "للمنتج مهمّةٌ نشطةٌ بيد مصوّرٍ الآن، ولا تُفتح للمنتج مهمّتان معاً",
            doThis: "افتح المهمّة القائمة من لوحة المهامّ وانقلها بزرّ إعادة الإسناد، أو انتظر إغلاقها",
          }),
        });
      }
      if (Number(activeTask.branchId) !== Number(assignee.branchId)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذّر إسناد المهمّة إلى هذا المصوّر",
            why: "مهمّة المنتج القائمة في الطابور تتبع فرعاً غير فرع المصوّر، والمهمّة لا تعبر الفروع",
            doThis: "اختر مصوّراً من فرع المهمّة، أو اطلب من مدير النظام نقلها بين الفروع",
          }),
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
          message: appErrorMessage({
            what: "تعذّر إنشاء مهمّة التصوير",
            why: "أُنشئت للمنتج مهمّةٌ نشطةٌ في اللحظة نفسها من شاشةٍ أخرى، والمنتج لا يحمل مهمّتين معاً",
            doThis: "حدّث لوحة المهامّ لترى المهمّة القائمة، وأعد إسنادها من هناك إن لزم",
          }),
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
      message: appErrorMessage({
        what: "تعذّر الإسناد الجماعيّ",
        why: "عدد المنتجات المختارة خارج المسموح — الدفعة الواحدة من 1 إلى 100 منتج",
        doThis: "أنقص التحديد إلى 100 منتجٍ أو أقلّ ونفّذ الإسناد على دفعات",
      }),
    });
  }
  if (productIds.length !== input.productIds.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر الإسناد الجماعيّ",
        why: "قائمة المنتجات المرسَلة تحمل منتجاً مكرّراً، والإسناد يُحسب مرّةً واحدةً لكلّ منتج",
        doThis: "حدّث الشاشة وأعد التحديد ثمّ أعد الإسناد الجماعيّ",
      }),
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
    if (!assignee) throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر الإسناد الجماعيّ", why: "المصوّر المختار غير موجودٍ أو غير نشط — أُوقف حسابه بعد فتحك القائمة", doThis: "حدّث قائمة المصوّرين واختر حساباً نشطاً ثمّ أعد الإسناد الجماعيّ" }) });
    assertAssignableBranch(actor, assignee.branchId);
    if (!hasModuleAccess(assignee.role, assignee.permissionsOverride as PermissionMap | null, "productStudio", "FULL")) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر الإسناد الجماعيّ",
          why: "الموظّف لا يملك صلاحية «استوديو المنتجات»، فلن تظهر له المهامّ بعد إسنادها",
          doThis: "اضغط «امنح الصلاحية» أمام اسمه في قائمة الموظّفين ثمّ أعد الإسناد الجماعيّ",
        }),
      });
    }
    const selectedProducts = await tx
      .select({
        id: products.id,
        name: products.name,
        description: products.description,
      })
      .from(products)
      .where(and(inArray(products.id, productIds), eq(products.isActive, true), eq(products.isService, false)))
      .for("update");
    if (selectedProducts.length !== productIds.length) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر الإسناد الجماعيّ",
          why: "أحد المنتجات المحدَّدة غير موجودٍ أو معطَّل أو خدميّ، ولا يُصوَّر إلّا المنتج النشط المخزنيّ",
          doThis: "أزِل المنتجات المعطَّلة والخدميّة من التحديد ثمّ أعد الإسناد الجماعيّ",
        }),
      });
    }
    // الإسنادُ الجماعيّ **مستوى-الأمّ فقط**: يعمل على المهام بـ`variantId=NULL` — لا
    // يلمس المهام الخاصّة ببديل (تلك تأتي من مسح المصوّر ولها دورتها). بعد هجرة 0268
    // صار كل (منتج، متغيّر) مستقلاً بمهمّته، فقراءةُ كل النشطات ودمجُها في
    // Map<productId, jobId> تُخفي المهام الخاصّة بالبدائل صامتاً — لذا نُصفّي هنا
    // على variantId=NULL (الجذر: مراجعة Codex P2 على PR #807).
    const active = await tx
      .select({
        id: productImageJobs.id,
        productId: productImageJobs.productId,
        branchId: productImageJobs.branchId,
        assignedTo: productImageJobs.assignedTo,
        variantId: productImageJobs.variantId,
      })
      .from(productImageJobs)
      .where(
        and(
          inArray(productImageJobs.productId, productIds),
          eq(productImageJobs.activeSlot, 1),
          isNull(productImageJobs.variantId),
        ),
      )
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
        message: appErrorMessage({
          what: "تعذّر الإسناد الجماعيّ",
          why: "أحد المنتجات المحدَّدة له مهمّةٌ نشطةٌ بيد مصوّر، أو مهمّةٌ في طابور فرعٍ آخر",
          doThis: "أزِل المنتجات التي لها مهمّةٌ قائمة من التحديد — أو انقلها بإعادة الإسناد — ثمّ أعد الإسناد الجماعيّ",
        }),
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
          message: appErrorMessage({
            what: "تعذّر إتمام الإسناد الجماعيّ",
            why: "أُنشئت مهامٌّ لبعض هذه المنتجات من شاشةٍ أخرى أثناء تنفيذ الدفعة",
            doThis: "حدّث لوحة المهامّ وأعد التحديد، ثمّ أعد الإسناد الجماعيّ",
          }),
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
        message: appErrorMessage({
          what: "تعذّر إعادة إسناد المهمّة",
          why: "المهمّة بانتظار المراجعة أو مغلقة، وإعادة الإسناد تخصّ المهامّ الجارية (مُسنَدة أو قيد العمل أو مرفوضة)",
          doThis: "اعتمد المهمّة أو ارفضها أوّلاً من شاشة المراجعة، ثمّ أعد إسنادها بعد الرفض",
        }),
      });
    }
    // الطابور المفتوح متاحٌ فقط لمهامّ الحملات: `claimStudioProductByBarcode` يرفض سحب
    // مهمّةٍ بلا `campaignId` («تُسنَد من المدير ولا تُسحَب بالمسح»). إرسالُها للطابور
    // إذن يُعلّقها بلا يدٍ ولا مسارِ استرداد — يلزم اختيارُ مصوّرٍ صراحةً.
    if (input.newAssigneeId == null && task.campaignId == null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إعادة المهمّة إلى الطابور المفتوح",
          why: "المهمّة غير مرتبطةٍ بحملة، ومهامّ الطابور المفتوح تُسحَب بمسح الباركود داخل حملةٍ فقط — فتبقى بلا يدٍ تلتقطها",
          doThis: "اختر مصوّراً بعينه في حقل المصوّر الجديد ثمّ أعد الإسناد",
        }),
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
      if (!assignee) throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر إعادة إسناد المهمّة", why: "المصوّر المختار غير موجودٍ أو غير نشط — أُوقف حسابه بعد فتحك القائمة", doThis: "حدّث قائمة المصوّرين واختر حساباً نشطاً ثمّ أعد الإسناد" }) });
      assertAssignableBranch(actor, assignee.branchId);
      if (Number(assignee.branchId) !== Number(task.branchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({ what: "تعذّر إعادة إسناد المهمّة", why: "المصوّر المختار يتبع فرعاً غير فرع المهمّة، والمهمّة لا تعبر الفروع", doThis: "اختر مصوّراً من فرع المهمّة نفسه ثمّ أعد الإسناد" }) });
      }
      if (!hasModuleAccess(assignee.role, assignee.permissionsOverride as PermissionMap | null, "productStudio", "FULL")) {
        throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر إعادة إسناد المهمّة", why: "المصوّر المختار لا يملك صلاحية «استوديو المنتجات»، فلن تظهر له المهمّة بعد نقلها", doThis: "اضغط «امنح الصلاحية» أمام اسمه في قائمة الموظّفين ثمّ أعد الإسناد" }) });
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
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر إعادة الإسناد الجماعيّة", why: "عدد المهامّ المحدَّدة خارج المسموح — الدفعة الواحدة من 1 إلى 100 مهمّة", doThis: "أنقص التحديد إلى 100 مهمّةٍ أو أقلّ ونفّذ إعادة الإسناد على دفعات" }) });
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
      if (!assignee) throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر إعادة الإسناد الجماعيّة", why: "المصوّر المختار غير موجودٍ أو غير نشط — أُوقف حسابه بعد فتحك القائمة", doThis: "حدّث قائمة المصوّرين واختر حساباً نشطاً ثمّ أعد التنفيذ" }) });
      assertAssignableBranch(actor, assignee.branchId);
      if (!hasModuleAccess(assignee.role, assignee.permissionsOverride as PermissionMap | null, "productStudio", "FULL")) {
        throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر إعادة الإسناد الجماعيّة", why: "المصوّر المختار لا يملك صلاحية «استوديو المنتجات»، فلن تظهر له المهامّ بعد نقلها", doThis: "اضغط «امنح الصلاحية» أمام اسمه في قائمة الموظّفين ثمّ أعد التنفيذ" }) });
      }
      newAssignee = { id: Number(assignee.id), role: assignee.role, branchId: assignee.branchId == null ? null : Number(assignee.branchId) };
    }
    const tasks = await tx
      .select({ id: productImageJobs.id, productId: productImageJobs.productId, branchId: productImageJobs.branchId, status: productImageJobs.status, assignedTo: productImageJobs.assignedTo, revision: productImageJobs.revision })
      .from(productImageJobs)
      .where(inArray(productImageJobs.id, taskIds))
      .for("update");
    if (tasks.length !== taskIds.length) throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: "تعذّر إعادة الإسناد الجماعيّة", why: "بعض المهامّ المحدَّدة لم تعد موجودة — حُذفت أو تغيّرت بعد فتحك الشاشة", doThis: "حدّث لوحة المهامّ وأعد التحديد ثمّ نفّذ إعادة الإسناد" }) });
    for (const t of tasks) {
      if (!canCrossBranches(actor) && Number(t.branchId) !== Number(actor.branchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({ what: "تعذّر إعادة الإسناد الجماعيّة", why: "بعض المهامّ المحدَّدة تتبع فرعاً غير فرعك، ومهامّ الاستوديو لا تعبر الفروع", doThis: "اقصر التحديد على مهامّ فرعك ثمّ أعد التنفيذ" }) });
      }
      if (!["ASSIGNED", "IN_PROGRESS", "REJECTED"].includes(t.status)) {
        throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر إعادة الإسناد الجماعيّة", why: "بعض المهامّ المحدَّدة بانتظار المراجعة أو مغلقة، وإعادة الإسناد للمهامّ الجارية وحدها", doThis: "أزِل المهامّ المنتظِرة للمراجعة والمغلقة من التحديد ثمّ أعد التنفيذ" }) });
      }
      if (newAssignee && Number(t.branchId) !== newAssignee.branchId) {
        throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({ what: "تعذّر إعادة الإسناد الجماعيّة", why: "المصوّر المختار يتبع فرعاً غير فرع بعض المهامّ المحدَّدة", doThis: "اختر مصوّراً من فرع المهامّ نفسه، أو اقصر التحديد على مهامّ فرعه" }) });
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
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر ضبط الأولويّة على الدفعة", why: "عدد المهامّ المحدَّدة خارج المسموح — الدفعة الواحدة من 1 إلى 100 مهمّة", doThis: "أنقص التحديد إلى 100 مهمّةٍ أو أقلّ واضبط الأولويّة على دفعات" }) });
  }
  return withStudioTx(async (tx) => {
    const tasks = await tx
      .select({ id: productImageJobs.id, branchId: productImageJobs.branchId, status: productImageJobs.status })
      .from(productImageJobs)
      .where(inArray(productImageJobs.id, taskIds))
      .for("update");
    if (tasks.length !== taskIds.length) throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: "تعذّر ضبط الأولويّة على الدفعة", why: "بعض المهامّ المحدَّدة لم تعد موجودة — حُذفت بعد فتحك الشاشة", doThis: "حدّث لوحة المهامّ وأعد التحديد ثمّ اضبط الأولويّة" }) });
    for (const t of tasks) {
      if (!canCrossBranches(actor) && Number(t.branchId) !== Number(actor.branchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({ what: "تعذّر ضبط الأولويّة على الدفعة", why: "بعض المهامّ المحدَّدة تتبع فرعاً غير فرعك، ومهامّ الاستوديو لا تعبر الفروع", doThis: "اقصر التحديد على مهامّ فرعك ثمّ أعد الضبط" }) });
      }
      if (!["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"].includes(t.status)) {
        throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر ضبط الأولويّة على الدفعة", why: "بعض المهامّ المحدَّدة مغلقة (معتمَدة أو ملغاة أو فاشلة)، والأولويّة تخصّ العمل الجاري", doThis: "أزِل المهامّ المغلقة من التحديد ثمّ أعد الضبط" }) });
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
        message: appErrorMessage({
          what: "تعذّر تعديل موعد المهمّة وأولويّتها",
          why: "المهمّة مغلقة (معتمَدة أو ملغاة أو فاشلة)، والموعد يخصّ العمل الجاري",
          doThis: "عدّل موعد مهمّةٍ جارية، أو أنشئ مهمّةً جديدةً لهذا المنتج",
        }),
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
        message: appErrorMessage({
          what: "تعذّر حفظ مسودّة المهمّة",
          why: "المهمّة بانتظار مراجعة المدير أو مغلقة، ولا تُحرَّر بعد إرسالها",
          doThis: "انتظر قرار المدير — فإن رُفضت عادت إليك قابلةً للتحرير — واطلب منه إعادتها إليك إن أردتَ تعديلها الآن",
        }),
      });
    }
    if (task.uploadLeaseToken && task.uploadLeaseExpiresAt && task.uploadLeaseExpiresAt > new Date()) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر حفظ مسودّة المهمّة",
          why: "رفعُ صورةٍ لهذه المهمّة جارٍ الآن، وحفظُ مسودّةٍ أثناءه يُبطل الرفع الجاري",
          doThis: "انتظر انتهاء الرفع (دقيقتان على الأكثر) ثمّ أعد الحفظ",
        }),
      });
    }
    if (task.processingLeaseTokenHash && task.processingLeaseExpiresAt && task.processingLeaseExpiresAt > new Date()) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر حفظ مسودّة المهمّة",
          why: "معالجة الصورة عبر المزوّد جارية الآن، وحفظُ مسودّةٍ أثناءها يُبطل نتيجتها",
          doThis: "انتظر انتهاء المعالجة (دقيقتان على الأكثر) ثمّ أعد الحفظ",
        }),
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
        message: appErrorMessage({
          what: "تعذّر بدء معالجة الصورة عبر المزوّد",
          why: "حالة المهمّة لا تقبل معالجةً جديدة — المعالجة تجري على المُسنَدة أو قيد العمل أو المرفوضة",
          doThis: "حدّث الشاشة لتقرأ حالة المهمّة، واطلب من المدير إعادتها إليك إن كانت بانتظار المراجعة",
        }),
      });
    }
    if (task.uploadLeaseToken && task.uploadLeaseExpiresAt && task.uploadLeaseExpiresAt > new Date()) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر بدء معالجة الصورة عبر المزوّد",
          why: "رفعُ مرشّحٍ لهذه المهمّة جارٍ الآن، ولا تُستهلك حصّة المزوّد على مهمّةٍ تُكتب في اللحظة نفسها",
          doThis: "انتظر انتهاء الرفع (دقيقتان على الأكثر) ثمّ أعد المعالجة",
        }),
      });
    }
    // يجب أن تسبق جاهزية R2 حجز الحصة والاتصال بالمزوّد؛ لا استهلاك مدفوع لمرشح لا يمكن حفظه.
    assertStoragePolicy();
    if (task.processingLeaseTokenHash && task.processingLeaseExpiresAt && task.processingLeaseExpiresAt > new Date()) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر بدء معالجة الصورة عبر المزوّد",
          why: "معالجةٌ أخرى لهذه المهمّة ما زالت جارية، ولا تُحجَز حصّتان للمهمّة الواحدة",
          doThis: "انتظر انتهاء المعالجة الجارية (دقيقتان على الأكثر) ثمّ أعد المحاولة",
        }),
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
        message: appErrorMessage({
          what: "تعذّر تسجيل نتيجة المعالجة",
          why: "تغيّرت حالة المهمّة أثناء المعالجة فلم تعد تقبل نتيجةً جديدة — تُقبَل على المُسنَدة أو قيد العمل أو المرفوضة",
          doThis: "حدّث الشاشة لتقرأ حالة المهمّة، ثمّ أعد المعالجة من جديد إن كانت ما زالت بيدك",
        }),
      });
    }
    if (task.processingLeaseTokenHash !== authorizationHash || !task.processingLeaseExpiresAt || task.processingLeaseExpiresAt <= new Date()) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر تسجيل نتيجة المعالجة",
          why: "حجز المعالجة انتهت مهلته (دقيقتان) أو استبدلته معالجةٌ أحدث على المهمّة نفسها",
          doThis: "أعد تشغيل المعالجة من زرّها في محرّر الاستوديو، ولا تترك النتيجة معلّقةً أكثر من دقيقتين",
        }),
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
        message: appErrorMessage({
          what: "تعذّر ربط نتيجة المعالجة بالصورة",
          why: "تغيّرت حالة المهمّة فلم تعد تقبل ربطاً جديداً — يُقبَل على المُسنَدة أو قيد العمل أو المرفوضة",
          doThis: "حدّث الشاشة، ثمّ أعد المعالجة من جديد إن كانت المهمّة ما زالت بيدك",
        }),
      });
    }
    if (task.processingProofTokenHash !== receiptHash || !task.processingProofMode || !task.processingProofExpiresAt || task.processingProofExpiresAt <= new Date()) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر ربط نتيجة المعالجة بالصورة",
          why: "إيصال المعالجة لا يطابق سجلّ المهمّة أو انتهت صلاحيته (15 دقيقة من تسجيل النتيجة)",
          doThis: "أعد تشغيل المعالجة من زرّها في محرّر الاستوديو ثمّ أرسل نتيجتها مباشرةً",
        }),
      });
    }
    await tx.update(productImageJobs).set({ processingProofCandidateHash: candidate.hash }).where(eq(productImageJobs.id, input.taskId));
    await recordAdminOverride(tx, actor, input.taskId, "bindProcessingProof", overrideReason, task.assignedTo);
    return input.expectedRevision === undefined ? { ok: true as const } : { ok: true as const, revision: task.revision };
  });
}

/**
 * تحويلُ خطأ إرسال المرشّح **الخام** إلى `TRPCError` مصنَّف برسالةٍ عربيةٍ موجَّهة.
 *
 * قبل هذا: أيّ فشلٍ لم يُلفّ في `TRPCError` مسمّى (خطأ مخزن R2/S3 مؤقّت، انقطاع شبكة،
 * قفل مؤجَّل …) يصعد كـ`INTERNAL_SERVER_ERROR` عامّ، فيصل المصوّرَ «حدث خطأ غير متوقّع
 * — رمز المتابعة …» بلا دلالة يفعل بها شيئاً (لا يعلم أنّه شبكة أو تعارض قفل أو مخزن).
 * الحرصُ هنا **لا يبتلع** خطأً — يعيد رميه بعقدٍ يعرفه الوسيط ورسالةٍ ينفَع بها المستخدم.
 */
function classifyStudioSubmitError(err: unknown, taskId: number, userId: number): unknown {
  // `TRPCError` سبق أن صنَّفتها الخدمة (BAD_REQUEST/CONFLICT/PRECONDITION_FAILED) — مرورٌ كما هي.
  if (err instanceof TRPCError) return err;

  // ⚠️ ترتيبُ الفحص مقصود: **الشبكة قبل قاعدة البيانات** — `mysqlCodeFrom` يقبل عمداً
  // رموز Node العامّة (`E[A-Z]+`) كي يلتقط أخطاء الاتّصال الأدنى بـMySQL، فأخطاء R2/S3
  // الشبكية (`ETIMEDOUT`/`ECONNRESET`/`ECONNREFUSED`/`ENOTFOUND`/`EPIPE`) تدخل الفرع
  // الأوّل خطأً وتظهر للمصوّر «تعذّر حفظ المرشّح في قاعدة البيانات» — نصيحةٌ مضلِّلة.
  // فحصُ الشبكة أوّلاً يُخرِج فشلَ المخزن قبل أن يبتلعه غيره (مراجعة Codex P2).
  const meta = err as {
    name?: string;
    code?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const name = typeof meta?.name === "string" ? meta.name : "";
  const nodeCode = typeof meta?.code === "string" ? meta.code : "";
  const httpStatus = meta?.$metadata?.httpStatusCode;
  const isNetwork =
    ["NetworkingError", "TimeoutError", "AbortError", "RequestTimeout"].includes(name) ||
    ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE"].includes(nodeCode);
  if (isNetwork) {
    logger.warn({ err, taskId, userId, name, nodeCode }, "productStudio.submit.network");
    return new TRPCError({
      code: "TIMEOUT",
      message: appErrorMessage({
        what: "تعذّر إرسال الصورة للمراجعة",
        why: "انقطع الاتّصال بمخزن الصور أثناء الرفع — انتهت المهلة أو سقطت الشبكة",
        doThis: "تحقّق من اتّصال الجهاز بالشبكة ثمّ أعد الإرسال؛ عملك محفوظٌ ولم يُفقد",
      }),
      cause: err,
    });
  }

  const dbCode = mysqlCodeFrom(err);
  if (dbCode === "ER_LOCK_WAIT_TIMEOUT" || dbCode === "ER_LOCK_DEADLOCK") {
    logger.warn({ err, taskId, userId, dbCode }, "productStudio.submit.lock_conflict");
    return new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر إرسال الصورة للمراجعة",
        why: "تعارضُ قفلٍ مؤقّتٌ في قاعدة البيانات أثناء الحفظ — كتابةٌ أخرى كانت تمسّ المهمّة نفسها",
        doThis: "انتظر بضع ثوانٍ ثمّ أعد الإرسال",
      }),
      cause: err,
    });
  }
  if (dbCode === "ER_DUP_ENTRY") {
    logger.warn({ err, taskId, userId }, "productStudio.submit.duplicate");
    return new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر إرسال الصورة للمراجعة",
        why: "هذه الصورة أُرسلت للمراجعة سلفاً، فلا تُسجَّل مرّتين",
        doThis: "حدّث الشاشة لترى المهمّة بانتظار المراجعة، وأرسل صورةً جديدةً إن أردتَ استبدالها",
      }),
      cause: err,
    });
  }
  // الرموز الحقيقيّة لـMySQL تبدأ بـ`ER_` — أيّ رمزٍ عامّ (`E*`) وصل هنا لم يُصنَّف
  // شبكةً أعلاه فهو يخصّ اتّصالَ الـDriver ذاته (ECONNRESET إلى MySQL مثلاً)، لكنّه
  // ليس عطلَ استعلام. النصيحة أدق: «تعذّر الاتّصال بقاعدة البيانات».
  if (dbCode?.startsWith("ER_")) {
    logger.error({ err, taskId, userId, dbCode }, "productStudio.submit.db_error");
    return new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: appErrorMessage({
        what: "تعذّر إرسال الصورة للمراجعة",
        why: `رفضت قاعدة البيانات حفظ الصورة برمز الخطأ ${dbCode}، والعلّة ليست في صورتك`,
        doThis: "أعد الإرسال مرّةً، وإن تكرّر فأبلغ الدعم الفنّي برمز الخطأ الظاهر هنا",
      }),
      cause: err,
    });
  }
  if (dbCode) {
    logger.warn({ err, taskId, userId, dbCode }, "productStudio.submit.db_connection");
    return new TRPCError({
      code: "TIMEOUT",
      message: appErrorMessage({
        what: "تعذّر إرسال الصورة للمراجعة",
        why: `انقطع اتّصال الخادم بقاعدة البيانات برمز ${dbCode} أثناء الحفظ`,
        doThis: "انتظر لحظاتٍ وأعد الإرسال، وإن تكرّر فأبلغ الدعم الفنّي برمز الخطأ الظاهر هنا",
      }),
      cause: err,
    });
  }
  const isAccessDenied =
    ["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch"].includes(name) ||
    httpStatus === 401 ||
    httpStatus === 403;
  if (isAccessDenied) {
    logger.error({ err, taskId, userId, name, httpStatus }, "productStudio.submit.storage_auth");
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر إرسال الصورة للمراجعة",
        why: "رفض مخزن الصور مفاتيح الوصول المضبوطة على الخادم، فلا تُكتب صورةٌ فيه",
        doThis: "أبلغ الإدارة بأنّ مفاتيح مخزن صور الاستوديو غير صحيحة؛ الإرسال متوقّف حتى تُصحَّح",
      }),
      cause: err,
    });
  }
  const isStorageMissing = ["NoSuchBucket", "PermanentRedirect"].includes(name) || httpStatus === 404;
  if (isStorageMissing) {
    logger.error({ err, taskId, userId, name, httpStatus }, "productStudio.submit.storage_missing");
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر إرسال الصورة للمراجعة",
        why: "الحاوية المضبوطة في إعدادات مخزن الصور غير موجودةٍ على الخادم",
        doThis: "أبلغ الإدارة بأنّ حاوية مخزن صور الاستوديو غير موجودة؛ الإرسال متوقّف حتى تُنشأ",
      }),
      cause: err,
    });
  }
  if (typeof httpStatus === "number" && httpStatus >= 500) {
    logger.warn({ err, taskId, userId, httpStatus }, "productStudio.submit.storage_5xx");
    return new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: appErrorMessage({
        what: "تعذّر إرسال الصورة للمراجعة",
        why: `مخزن الصور ردّ بخطأ خادمٍ (رمز ${httpStatus})، وهو عطلٌ مؤقّتٌ عنده لا في صورتك`,
        doThis: "انتظر دقيقةً ثمّ أعد الإرسال، وإن تكرّر فأبلغ الإدارة",
      }),
      cause: err,
    });
  }
  // غير مصنَّف: يصعد كـINTERNAL_SERVER_ERROR والرسالةُ عامّة، فيلحق به «رمز المتابعة»
  // من `errorFormatter`. سجلٌّ بنيويٌّ هنا يمنح فريق الدعم مسمًّى ينتظره في السجلّ حين يصل
  // الرقم من الحقل، فلا يكون العثور عليه بحثاً أعمى في ملفّ تشغيل.
  logger.error({ err, taskId, userId }, "productStudio.submit.unclassified");
  return err;
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
        message: appErrorMessage({
          what: "تعذّر إرسال الصورة للمراجعة",
          why: "حالة المهمّة لا تقبل صورةً جديدة — الإرسال يجري على المُسنَدة أو قيد العمل أو المرفوضة",
          doThis: "حدّث الشاشة لتقرأ حالة المهمّة، واطلب من المدير إعادتها إليك إن كانت بانتظار المراجعة",
        }),
      });
    }
    if (task.uploadLeaseToken && task.uploadLeaseExpiresAt && task.uploadLeaseExpiresAt > new Date()) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر إرسال الصورة للمراجعة",
          why: "رفعٌ آخر لهذه المهمّة جارٍ الآن (من هذا الجهاز أو من جهازٍ آخر)، ولا يُقبَل رفعان معاً",
          doThis: "انتظر انتهاء الرفع الجاري (دقيقتان على الأكثر) ثمّ أعد الإرسال",
        }),
      });
    }
    if (task.processingLeaseTokenHash && task.processingLeaseExpiresAt && task.processingLeaseExpiresAt > new Date()) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر إرسال الصورة للمراجعة",
          why: "معالجة الصورة عبر المزوّد جارية الآن، وإرسال نسخةٍ أقدم أثناءها يطمس نتيجتها",
          doThis: "انتظر انتهاء المعالجة (دقيقتان على الأكثر) ثمّ أرسل ناتجها بدل النسخة الأقدم",
        }),
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
        message: appErrorMessage({
          what: "تعذّر إرسال الصورة للمراجعة",
          why: "هذا أوّل إرسالٍ للمهمّة ولم تُرفَق الصورة الأصلية، والأصل لقطةٌ لا تُستعاد بعدها",
          doThis: "أرفِق الصورة الأصلية قبل المعالجة ثمّ أعد الإرسال؛ وإن كنتَ حدّثت الصفحة فأعد التقاطها من جديد",
        }),
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
          message: appErrorMessage({
            what: "تعذّر إتمام إرسال الصورة",
            why: "انتهت مهلة الرفع (دقيقتان) أو تغيّرت حالة المهمّة أثناءه — بدأ رفعٌ أحدث أو نُقلت المهمّة",
            doThis: "حدّث الشاشة، ثمّ أعد الإرسال إن كانت المهمّة ما زالت بيدك",
          }),
        });
      }
      const immutableOriginalHash = task.sourceContentHash ?? original?.hash;
      const immutableOriginalMime = task.originalMime ?? original?.mime;
      if (!immutableOriginalHash || !immutableOriginalMime) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "تعذّر إتمام إرسال الصورة",
            why: "لقطة الصورة الأصلية على المهمّة ناقصة (بلا بصمةٍ أو نوع ملفّ)، والاعتماد لاحقاً يُقاس عليها",
            doThis: "أرفِق الصورة الأصلية وأعد الإرسال، واطلب من المدير إعادة إسناد المهمّة إن تكرّر",
          }),
        });
      }
      const receiptHash = input.processingReceipt ? contentHash(Buffer.from(input.processingReceipt, "utf8")) : null;
      let effectiveMode: "FLATTEN" | "CUT" | "PRO" | "AI" = input.mode;
      if (input.processingReceipt) {
        const proofValid = Boolean(receiptHash && task.processingProofTokenHash === receiptHash && task.processingProofExpiresAt && task.processingProofExpiresAt > new Date() && task.processingProofCandidateHash === processed.hash && (task.processingProofMode === "PRO" || task.processingProofMode === "AI"));
        if (!proofValid) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "تعذّر إتمام إرسال الصورة",
              why: "إيصال المعالجة لا يطابق بايتات الصورة المرسَلة أو انتهت صلاحيته (15 دقيقة)",
              doThis: "أعد تشغيل المعالجة من زرّها في المحرّر ثمّ أرسل ناتجها كما هو بلا تعديل",
            }),
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
    // إفلاتُ الحصر أوّلاً كي لا تبقى المهمّة «قيد رفع» حتى انتهاء الإيجار (٢ دقيقة)
    // بينما الفشلُ لحظيّ. ثمّ يُصنَّف الخطأُ الخام إلى `TRPCError` برسالةٍ عربيةٍ موجَّهة —
    // بدل «حدث خطأ غير متوقّع + رمز متابعة» على كلّ فشلٍ لا صلة له بحالة المهمة.
    await requireDb()
      .update(productImageJobs)
      .set({ uploadLeaseToken: null, uploadLeaseExpiresAt: null })
      .where(and(eq(productImageJobs.id, input.taskId), eq(productImageJobs.uploadLeaseToken, token)));
    throw classifyStudioSubmitError(error, input.taskId, actor.userId);
  }
}

async function streamToBase64(key: string): Promise<string> {
  const stream = await getImageStore().getStream(key);
  if (!stream)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر عرض الصورة",
        why: "ملفّ الصورة غير موجودٍ في مخزن الصور رغم بقاء سجلّه على المهمّة",
        doThis: "حدّث الشاشة، ثمّ أعد رفع الصورة من محرّر الاستوديو أو اطلب من مصوّرها إعادة إرسالها",
      }),
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
      message: appErrorMessage({
        what: "تعذّر عرض المرشّح للمقارنة",
        why: "المهمّة بلا صورةٍ نهائيةٍ مكتملة — لم يُرسَل مرشّحٌ بعد أو أُفرِغ بعد رفضه",
        doThis: "أرسل صورة المهمّة من المحرّر إن كانت بيدك، أو اطلب من مصوّرها إرسالها ثمّ أعد فتح المقارنة",
      }),
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
      message: appErrorMessage({
        what: "تعذّر عرض صورة المصدر",
        why: "المهمّة أُسنِدت بلا صورة مصدرٍ سابقة — تُصوَّر من جديد لا تُعالَج من صورةٍ قائمة",
        doThis: "التقط الصورة من محرّر الاستوديو مباشرةً بدل انتظار مصدر",
      }),
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
        message: appErrorMessage({
          what: "تعذّر اعتماد المهمّة",
          why: "المهمّة لم تعد بانتظار المراجعة — بتّ فيها مديرٌ آخر أو أُلغيت بعد فتحك الشاشة",
          doThis: "حدّث لوحة المراجعة لتقرأ حالتها الراهنة، وانتقل إلى المهمّة التالية",
        }),
      });
    }
    const overrideReason = assertIndependentReviewer(actor, task, adminOverrideReason);
    assertStoragePolicy();
    if (!task.productId || !task.processedObjectKey || !task.processedContentHash || !task.processedMime || !task.processedUrl) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر اعتماد المهمّة",
          why: "بيانات الصورة النهائية على المهمّة ناقصة (ملفٌّ أو بصمةٌ أو رابطٌ مفقود)، ولا تُنشَر صورةٌ ناقصة البيانات",
          doThis: "ارفض المهمّة بسببٍ مكتوب ليعيد المصوّر إرسال الصورة كاملة",
        }),
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
    if (!product) throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: "تعذّر اعتماد المهمّة", why: "منتج المهمّة لم يعد موجوداً في الكتالوج — حُذف بعد إنشائها", doThis: "ألغِ المهمّة بسببٍ مكتوب، وأنشئ مهمّةً جديدةً على المنتج الصحيح" }) });

    const changesProductContent = Boolean(task.proposedName?.trim() || task.proposedDescription?.trim() || task.proposedMarketingCopy?.trim());
    if (changesProductContent && task.sourceProductHash && productContentHash(product) !== task.sourceProductHash) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر اعتماد المهمّة",
          why: "المهمّة تقترح اسماً أو وصفاً للمنتج، وقد عُدّل محتوى المنتج بعد بدئها — فالاعتماد يطمس التعديل الأحدث",
          doThis: "قارن اقتراح المصوّر بمحتوى المنتج الحاليّ، ثمّ ارفض المهمّة بسببٍ مكتوب ليبني اقتراحه على النسخة الأحدث",
        }),
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
          message: appErrorMessage({
            what: "تعذّر اعتماد المهمّة",
            why: "صورة المصدر التي بُنيت عليها المهمّة تغيّرت أو سُحب اعتمادها، فلا يصحّ استبدالها بناتج مهمّةٍ قديمة",
            doThis: "ارفض المهمّة بسببٍ مكتوب، وأسنِد مهمّةً جديدةً على صورة المصدر الحالية",
          }),
        });
      }
      imageId = Number(image.id);
      existingOriginalKey = image.originalKey;
    } else {
      // العزلُ لكل بديل: تخفيضُ الصور الرئيسيّة يُقيَّد بنفس `variantId` (أو نفس مستوى-الأمّ
      // إن كانت المهمّة variantId=NULL). بلا هذا القيد كانت الصورة الأخيرة لأيّ بديلٍ
      // تُعزَّز رئيسيّةً وتُخفَّض جميع البدائل الأخرى — فيقرأ الكشك/المتجر صورةً واحدة
      // لكل البدائل (الجذر: مراجعة Codex P1 على PR #807).
      await tx
        .update(productImages)
        .set({ isPrimary: false })
        .where(
          and(
            eq(productImages.productId, task.productId),
            eq(productImages.isPrimary, true),
            task.variantId == null ? isNull(productImages.variantId) : eq(productImages.variantId, task.variantId),
          ),
        );
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
      productId: Number(task.productId),
    };
  }).then(async (out) => {
    if (out.assignedTo != null) {
      await notifyStudioApproval(taskId, Number(out.assignedTo), out.revision, out.assigneeRole, out.productName);
    }
    // هوك «الهجين»: بعد اعتماد صورة استوديو، ولّد مسودّة محتوى بصريّاً تلقائياً في الخلفية.
    // fire-and-forget بحقّ: لا await ⇒ لا يُبطئ ردّ الاستوديو، ولا خطأٌ فيه يُفشِل الاعتماد
    // (اعتماد الصورة نفسه قد التزم في DB). الفشل يُسجَّل بمستوى info/warn — الزرّ اليدويّ يبقى
    // البديل النهائيّ للحالات التي يتجاوز فيها الحدّ اليوميّ أو يفشل التحقّق.
    setImmediate(() => {
      void generateAndSaveContentDraftForProduct(out.productId, {
        userId: actor.userId,
        branchId: actor.branchId ?? null,
      })
        .then((outcome) => {
          if (outcome.draftId) {
            logger.info(
              { productId: out.productId, draftId: outcome.draftId, taskId },
              "auto content draft created after studio approval",
            );
          } else {
            logger.info(
              { productId: out.productId, taskId, reason: outcome.reason, detail: "detail" in outcome ? outcome.detail : undefined },
              "auto content draft skipped",
            );
          }
        })
        .catch((err) => {
          logger.warn({ err, productId: out.productId, taskId }, "auto content draft crashed unexpectedly");
        });
    });
    return out.response;
  });
}

export async function rejectStudioTask(actor: ProductStudioActor, taskId: number, reason: string, adminOverrideReason?: string | null, expectedRevision?: number) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const cleanReason = reason.trim();
  if (cleanReason.length < 5)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر رفض المهمّة",
        why: "سبب الرفض أقصر من 5 أحرف، والمصوّر يبني إعادة العمل على هذا السبب وحده",
        doThis: "اكتب في حقل السبب ما ينقص الصورة تحديداً (الإضاءة أو الخلفية أو الزاوية) ثمّ أعد الرفض",
      }),
    });
  const result = await withStudioTx(async (tx) => {
    const task = await lockTask(tx, taskId);
    assertExpectedRevision(task, expectedRevision);
    assertTaskAccess(actor, task, true);
    if (task.status !== "PENDING_REVIEW")
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر رفض المهمّة",
          why: "المهمّة لم تعد بانتظار المراجعة — بتّ فيها مديرٌ آخر أو أُلغيت بعد فتحك الشاشة",
          doThis: "حدّث لوحة المراجعة لتقرأ حالتها الراهنة، وانتقل إلى المهمّة التالية",
        }),
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
      message: appErrorMessage({
        what: "تعذّر إلغاء المهمّة",
        why: "سبب الإلغاء أقصر من 5 أحرف، والإلغاء قرارٌ يبقى في سجلّ التدقيق بسببه",
        doThis: "اكتب سبب الإلغاء في حقل السبب بخمسة أحرفٍ فأكثر ثمّ أعد الإلغاء",
      }),
    });
  return withStudioTx(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    assertExpectedRevision(task, input.expectedRevision);
    assertTaskAccess(actor, task, true);
    if (task.status === "APPROVED")
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر إلغاء المهمّة",
          why: "المهمّة معتمَدةٌ وصورتها منشورةٌ على المنتج، والإلغاء لا يسحب صورةً نُشرت",
          doThis: "اضغط «استرجاع الأصل» على المهمّة لتعود صورة المنتج إلى أصلها قبل المعالجة",
        }),
      });
    if (!CANCELLABLE_STUDIO_STATUSES.includes(task.status))
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر إلغاء المهمّة",
          why: "المهمّة في حالةٍ نهائية (ملغاةٌ سلفاً أو فاشلة)، ولا يُلغى ما أُغلق",
          doThis: "حدّث لوحة المهامّ لتقرأ حالتها، وأنشئ مهمّةً جديدةً لهذا المنتج إن كان يحتاج صورة",
        }),
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
async function cancelCampaignQueuedTasksInTx(
  tx: Parameters<Parameters<typeof withTx>[0]>[0],
  actor: ProductStudioActor,
  campaign: { id: number | string; branchId: number | string | null },
  reason: string,
  action: string,
  options: {
    /**
     * `false` (افتراضيّ) — يُلغي غير المُسنَد فقط (السلوك التاريخيّ: عملُ الموظفين يُصان).
     * `true` (٢٩/٨، بلاغ مالك) — يُلغي كلّ المهام الحيّة (ASSIGNED/IN_PROGRESS/PENDING_REVIEW/
     * REJECTED)، سواء مُسنَدةً لموظفٍ أم لا. المستَعمَل عندما يريد المدير محوَ الحملة كلّياً.
     * قرارُ المالك يعلو على السلوك الافتراضيّ — الشاشة تسأل صراحةً قبل تفعيله.
     */
    cascadeAssigned?: boolean;
  } = {},
) {
  const campaignId = Number(campaign.id);
  const cascadeAssigned = options.cascadeAssigned === true;
  const scope = cascadeAssigned
    // كل مهمّةٍ حيّةٍ على الحملة — بمُنفّذٍ أو بلا — تُلغى. PENDING_REVIEW تُلغى أيضاً لأنّها
    // ما زالت مفتوحةً على منتجٍ ينتظر قراراً؛ عدم إلغائها يترك تناقضاً مع «الحملة ملغاة».
    ? and(eq(productImageJobs.campaignId, campaignId), inArray(productImageJobs.status, ["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"]), eq(productImageJobs.activeSlot, 1))
    : and(eq(productImageJobs.campaignId, campaignId), eq(productImageJobs.status, "ASSIGNED"), isNull(productImageJobs.assignedTo), eq(productImageJobs.activeSlot, 1));
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

export async function bulkCancelStudioBacklog(actor: ProductStudioActor, input: { campaignId: number; reason: string; cascadeAssigned?: boolean }) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const cleanReason = input.reason.trim();
  if (cleanReason.length < 5)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إلغاء طابور الحملة",
        why: "سبب الإلغاء أقصر من 5 أحرف، وإلغاء دفعةٍ كاملة يبقى في سجلّ التدقيق بسببه",
        doThis: "اكتب سبب إلغاء الطابور في حقل السبب بخمسة أحرفٍ فأكثر ثمّ أعد التنفيذ",
      }),
    });
  return withStudioTx(async (tx) => {
    const campaign = (await tx.select().from(productStudioCampaigns).where(eq(productStudioCampaigns.id, input.campaignId)).limit(1))[0];
    if (!campaign)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر إلغاء طابور الحملة",
          why: "لا حملة بهذا الرقم — حُذفت بعد فتحك الشاشة",
          doThis: "حدّث لوحة الحملات واختر الحملة من جديد",
        }),
      });
    assertCampaignAccess(actor, campaign);
    return cancelCampaignQueuedTasksInTx(tx, actor, campaign, cleanReason, input.cascadeAssigned === true ? "productStudio.campaign.cancelBacklog.cascade" : "productStudio.campaign.cancelBacklog", { cascadeAssigned: input.cascadeAssigned === true });
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
      message: appErrorMessage({
        what: "تعذّر استرجاع الصورة الأصلية",
        why: "المهمّة ليست معتمَدةً أو لا تحمل لقطةً كاملةً للأصل، ولا يُسترجَع أصلٌ غير محفوظ",
        doThis: "أسنِد مهمّةً جديدةً على المنتج ليُلتقط له أصلٌ جديد بدل الاسترجاع",
      }),
    });
  }
  const originalStream = await getImageStore().getStream(snapshot.originalObjectKey);
  if (!originalStream)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر استرجاع الصورة الأصلية",
        why: "ملفّ الأصل غير موجودٍ في مخزن الصور رغم بقاء سجلّه على المهمّة",
        doThis: "أسنِد مهمّةً جديدةً على المنتج ليُلتقط أصلٌ جديد، وأبلغ الإدارة إن تكرّر على أكثر من مهمّة",
      }),
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
      message: appErrorMessage({
        what: "تعذّر استرجاع الصورة الأصلية",
        why: "بصمة الملفّ المقروء من المخزن لا تطابق البصمة المسجَّلة على المهمّة — تغيّر محتواه",
        doThis: "أبلغ الإدارة بأنّ أصل هذه المهمّة تغيّر في المخزن، وأسنِد مهمّةً جديدةً للمنتج بدل الاسترجاع",
      }),
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
        message: appErrorMessage({
          what: "تعذّر استرجاع الصورة الأصلية",
          why: "تغيّرت المهمّة أثناء الاسترجاع فلم تعد معتمَدةً أو فُقدت لقطة أصلها",
          doThis: "حدّث الشاشة لتقرأ حالة المهمّة، وأسنِد مهمّةً جديدةً على المنتج إن لزم",
        }),
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
        message: appErrorMessage({
          what: "تعذّر استرجاع الصورة الأصلية",
          why: "صورة المنتج نُشرت من مهمّةٍ أحدث بعد هذه، واسترجاع القديمة يطمس الأحدث",
          doThis: "افتح المهمّة الأحدث على المنتج واسترجع أصلها منها إن أردتَ إعادة الصورة السابقة",
        }),
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
