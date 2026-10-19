import { z } from "zod";
import { operationDecision, type OperationUser } from "@shared/operationPermissions";
import { STUDIO_REVIEW_READ_OPERATIONS, STUDIO_TASK_MANAGEMENT_OPERATIONS } from "../services/authorization/studioOperationAuthority";
import { routeOperationAuthority } from "../services/authorization/operationAuthority";
import { reserveStudioImageTasks } from "../services/productStudioService";
import { productStudioManagerProcedure, productStudioReadProcedure, productStudioWriteProcedure, requireRole, router } from "../trpc";
import { barcodeString, barcodeStorageString, optionalBarcodeString } from "../lib/schemas";
import { approveStudioTask, assignStudioTask, bulkAssignStudioTasks, bulkCancelStudioBacklog, bulkReassignStudioTasks, bulkSetStudioPriority, cancelStudioTask, claimStudioProductByBarcode, createStudioCampaign, createTemporaryCampaignPhotographer, revokeTemporaryCampaignPhotographers, grantStudioAccess, createStudioCampaignBacklog, drainStudioCampaignBacklog, distributeCampaignTasks, getNextPhotographerTask, bindStudioProcessingCandidate, getStudioCandidatePreview, getStudioTaskPreviousImages, getStudioDashboard, getStudioCampaignAnalytics, getStudioCampaignBoard, listStudioAssignees, listStudioCampaigns, listMyStudioCampaigns, listStudioProducts, listStudioProductImages, listStudioTasks, reassignStudioTask, rejectStudioTask, previewStudioCampaignBacklog, resolveStudioBarcode, revertStudioTask, saveStudioDraft, sendStudioDueNotifications, submitStudioCandidate, transitionStudioCampaign, updateCampaignAssignees, updateStudioCampaignDetails, updateStudioTaskSchedule, getStudioProductUnits, getStudioProductVariantMatrix, linkStudioBarcode, quickBarcodeLookup, quickSaveBarcodeProductImage, quickAiTransform, type ProductStudioActor } from "../services/productStudioService";
import { logAudit } from "../services/auditService";
import { deleteProductImage, listProductImagesForManager, reorderProductImages, setPrimaryProductImage } from "../services/productStudioImageManager";
import { discoverImageGaps, getGapProductIds, getImageHealthCounts, getTopGapCategories, IMAGE_HEALTH_STATES } from "../services/productStudioDiscovery";

function actor(ctx: {
  user: OperationUser & {
    id: number;
    branchId?: number | null;
    role: string;
    isOwner?: boolean;
  };
 }, path: string): ProductStudioActor {
  const managementPath = STUDIO_REVIEW_READ_OPERATIONS.has(path)
    ? Array.from(STUDIO_TASK_MANAGEMENT_OPERATIONS).find(operation => operationDecision(ctx.user, operation).allowed)
    : undefined;
  return {
    userId: Number(ctx.user.id),
    branchId: ctx.user.branchId == null ? null : Number(ctx.user.branchId),
    role: ctx.user.role,
    isOwner: ctx.user.isOwner === true,
    operationAuthority: routeOperationAuthority(ctx.user, path),
    managementAuthority: managementPath ? routeOperationAuthority(ctx.user, managementPath) : undefined,
  };
}

const taskId = z.number().int().positive();
const expectedRevision = z.number().int().positive();
const priority = z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]);
const campaignId = z.number().int().positive();
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const adminOverrideReason = z.string().trim().min(5).max(500).optional();

export const productStudioRouter = router({
  authorizeExport: productStudioReadProcedure.use(requireRole("manager")).query(({ ctx }) => {
    return { authorized: true, scope: ctx.scopedOwnerId == null ? "BRANCH" as const : "OWN" as const };
  }),
  dashboard: productStudioReadProcedure.query(({ ctx }) => getStudioDashboard(actor(ctx, "productStudio.dashboard"))),
  products: productStudioReadProcedure
    .input(
      z.object({
        search: z.string().trim().max(80).default(""),
        cursor: z.string().max(500).nullable().optional(),
        includeInactive: z.boolean().optional(),
      }),
    )
    .query(({ ctx, input }) => listStudioProducts(actor(ctx, "productStudio.products"), input)),
  resolveBarcode: productStudioReadProcedure.input(z.object({ barcode: barcodeString })).query(({ ctx, input }) => resolveStudioBarcode(actor(ctx, "productStudio.resolveBarcode"), input.barcode)),
  productImages: productStudioReadProcedure.input(z.object({ productId: z.number().int().positive() })).query(({ ctx, input }) => listStudioProductImages(actor(ctx, "productStudio.productImages"), input.productId)),
  productUnits: productStudioReadProcedure
    .input(z.object({ productId: z.number().int().positive() }))
    .query(({ ctx, input }) => getStudioProductUnits(actor(ctx, "productStudio.productUnits"), input.productId)),
  variantMatrix: productStudioReadProcedure
    .input(z.object({ productId: z.number().int().positive() }))
    .query(({ ctx, input }) => getStudioProductVariantMatrix(actor(ctx, "productStudio.variantMatrix"), input.productId)),
  // إدارةُ صور المنتج القائمة — للمدير (طلب المالك ٢٦/٨: التحكم الكامل بالصور).
  managerImages: productStudioManagerProcedure
    .input(z.object({ productId: z.number().int().positive() }))
    .query(({ ctx, input }) => listProductImagesForManager(actor(ctx, "productStudio.managerImages"), input.productId)),
  deleteImage: productStudioManagerProcedure
    .input(z.object({ imageId: z.number().int().positive(), reason: z.string().trim().max(500).optional() }))
    .mutation(({ ctx, input }) => deleteProductImage(actor(ctx, "productStudio.deleteImage"), input)),
  setImagePrimary: productStudioManagerProcedure
    .input(z.object({ imageId: z.number().int().positive() }))
    .mutation(({ ctx, input }) => setPrimaryProductImage(actor(ctx, "productStudio.setImagePrimary"), input.imageId)),
  reorderImages: productStudioManagerProcedure
    .input(z.object({ productId: z.number().int().positive(), orderedImageIds: z.array(z.number().int().positive()).min(1).max(200) }))
    .mutation(({ ctx, input }) => reorderProductImages(actor(ctx, "productStudio.reorderImages"), input)),
  // كاشفُ فجوات الصور (طلب المالك ٢٦/٨): تصنيفٌ ذكيّ يُبرِز الأولويّات لتوفير الوقت.
  imageHealthCounts: productStudioManagerProcedure.query(({ ctx }) => getImageHealthCounts(actor(ctx, "productStudio.imageHealthCounts"))),
  discoverImageGaps: productStudioManagerProcedure
    .input(
      z.object({
        states: z.array(z.enum(IMAGE_HEALTH_STATES)).max(15).optional(),
        categoryIds: z.array(z.number().int().positive()).max(200).optional(),
        isBundle: z.boolean().optional(),
        search: z.string().trim().max(80).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.number().int().nonnegative().optional(),
        // فرزٌ خادميّ (Codex P2 على PR #865): الفرز على الواجهة كان يمسّ الصفحة المقطَّعة
        // فيُقصّ الأولويّ. الآن يُطبَّق داخل الاستعلام قبل التقطيع.
        sort: z.enum(["MISSING_MOST", "NAME_ASC", "APPROVED_ASC", "VARIANTS_MISSING_MOST"]).optional(),
      }),
    )
    .query(({ ctx, input }) => discoverImageGaps(actor(ctx, "productStudio.discoverImageGaps"), input)),
  gapProductIds: productStudioManagerProcedure
    .input(
      z.object({
        states: z.array(z.enum(IMAGE_HEALTH_STATES)).max(15).optional(),
        categoryIds: z.array(z.number().int().positive()).max(200).optional(),
        isBundle: z.boolean().optional(),
        search: z.string().trim().max(80).optional(),
        maxLimit: z.number().int().min(1).max(20_000).optional(),
        sort: z.enum(["MISSING_MOST", "NAME_ASC", "APPROVED_ASC", "VARIANTS_MISSING_MOST"]).optional(),
      }),
    )
    .query(({ ctx, input }) => getGapProductIds(actor(ctx, "productStudio.gapProductIds"), input)),
  topGapCategories: productStudioManagerProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).optional() }))
    .query(({ ctx, input }) => getTopGapCategories(actor(ctx, "productStudio.topGapCategories"), input.limit)),
  assignees: productStudioManagerProcedure.query(({ ctx }) => listStudioAssignees(actor(ctx, "productStudio.assignees"))),
  grantStudioAccess: productStudioManagerProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .mutation(({ ctx, input }) => grantStudioAccess(actor(ctx, "productStudio.grantStudioAccess"), input.userId)),
  tasks: productStudioReadProcedure
    .input(
      z.object({
        scope: z.enum(["QUEUE", "MINE", "REVIEW", "HISTORY"]),
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().max(1_000).nullable().optional(),
        statuses: z
          .array(z.enum(["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "APPROVED", "REJECTED", "FAILED", "REVERTED", "CANCELLED"]))
          .max(8)
          .optional(),
        priority: z.array(priority).max(4).optional(),
        overdue: z.boolean().optional(),
        assigneeId: z.number().int().positive().optional(),
        productId: z.number().int().positive().optional(),
        taskId: taskId.optional(),
        campaignId: campaignId.optional(),
        unassigned: z.boolean().optional(),
        search: z.string().trim().max(80).optional(),
        // ٢٩/٨: يُخفي المهامَّ التي حملتُها في حالةٍ نهائيّة (مغلقة/ملغاة) — PAUSED تبقى.
        hideClosedCampaigns: z.boolean().optional(),
      }),
    )
    .query(({ ctx, input }) => listStudioTasks(actor(ctx, "productStudio.tasks"), input)),
  campaigns: productStudioReadProcedure.query(({ ctx }) => listStudioCampaigns(actor(ctx, "productStudio.campaigns"))),
  /**
   * حملاتُ المستخدم الحاليّ (نشطةٌ وهو عضوٌ فيها) — نافذته الوحيدة على «ماذا يخصّني».
   * قراءةٌ ضيّقة تُعوّض غياب `campaigns` عن الأدوار غير الإدارية بلا تسريب حملاتٍ لا تعنيه.
   */
  myCampaigns: productStudioReadProcedure.query(({ ctx }) => listMyStudioCampaigns(actor(ctx, "productStudio.myCampaigns"))),
  nextPhotographerTask: productStudioWriteProcedure.mutation(({ ctx }) => getNextPhotographerTask(actor(ctx, "productStudio.nextPhotographerTask"))),
  createCampaign: productStudioManagerProcedure
    .input(
      z.object({
        name: z.string().trim().min(3).max(180),
        branchId: z.number().int().positive().optional(),
        status: z.enum(["DRAFT", "ACTIVE"]).default("DRAFT"),
        startsAt: z.coerce.date().nullable().optional(),
        dueAt: z.coerce.date().nullable().optional(),
        // `CATEGORIES` (متعدّد) جديد — هجرة 0269. القديم `CATEGORY` (واحد) يبقى متاحاً.
        scopeKind: z.enum(["ALL", "CATEGORY", "CATEGORIES", "PRODUCTS"]).default("ALL"),
        scopeCategoryId: z.number().int().positive().nullable().optional(),
        scopeCategoryIds: z.array(z.number().int().positive()).max(200).optional(),
        scopeProductIds: z.array(z.number().int().positive()).max(5_000).optional(),
        requiredImages: z.number().int().min(1).max(10).optional(),
        // سياسة الصور (هجرة 0269): افتراضياً ONLY_MISSING (السلوك القديم). ANY_REGARDLESS
        // يشمل المنتجات المكتملة لإضافة صور جديدة — طلب المالك ٢٦/٨.
        imagesPolicy: z.enum(["ONLY_MISSING", "ANY_REGARDLESS"]).optional(),
        assigneeIds: z.array(z.number().int().positive()).max(50).optional(),
      }),
    )
    .mutation(({ ctx, input }) => createStudioCampaign(actor(ctx, "productStudio.createCampaign"), input)),
  /**
   * تعديلُ بيانات حملةٍ نشطة أو مسوَّدة: الاسم، عدد الصور المطلوبة، والمواعيد.
   * كلّ الحقول اختياريّة (مسار PATCH)؛ الحمولةُ الفارغة مرفوضة. الحالة والفرع والنطاق
   * مسائل مستقلّة لها مساراتها.
   */
  updateCampaignDetails: productStudioManagerProcedure
    .input(
      z.object({
        campaignId,
        name: z.string().trim().min(3).max(180).optional(),
        requiredImages: z.number().int().min(1).max(10).optional(),
        startsAt: z.coerce.date().nullable().optional(),
        dueAt: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => updateStudioCampaignDetails(actor(ctx, "productStudio.updateCampaignDetails"), input)),
  transitionCampaign: productStudioManagerProcedure
    .input(z.object({
      campaignId,
      // PAUSED (٢٨/٨) = «تجميد ذكيّ» يخفي الحملة عن مسار المسح، ويُبقي المهام المُسنَدة سلفاً
      // قابلةً للإتمام. الحرسُ الفعليّ للانتقالات في `transitionStudioCampaign` نفسه.
      status: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"]),
      startsAt: z.coerce.date().nullable().optional(),
      dueAt: z.coerce.date().nullable().optional(),
      reason: z.string().trim().max(500).optional(),
      // ٢٩/٨ (بلاغ مالك): CANCELLED + true ⇒ إلغاءُ كلّ المهام الحيّة لا الطابور فقط.
      cascadeAssignedTasks: z.boolean().optional(),
    }))
    .mutation(({ ctx, input }) => transitionStudioCampaign(actor(ctx, "productStudio.transitionCampaign"), input)),
  previewCampaignBacklog: productStudioManagerProcedure.input(z.object({ campaignId })).query(({ ctx, input }) => previewStudioCampaignBacklog(actor(ctx, "productStudio.previewCampaignBacklog"), input.campaignId)),
  createCampaignBacklog: productStudioManagerProcedure
    .input(z.object({ campaignId }))
    .mutation(({ ctx, input }) => createStudioCampaignBacklog(actor(ctx, "productStudio.createCampaignBacklog"), input.campaignId)),
  drainCampaignBacklog: productStudioManagerProcedure
    .input(z.object({ campaignId, autoDistribute: z.boolean().optional() }))
    .mutation(({ ctx, input }) => drainStudioCampaignBacklog(actor(ctx, "productStudio.drainCampaignBacklog"), input.campaignId, { autoDistribute: input.autoDistribute })),
  distributeCampaignTasks: productStudioManagerProcedure
    .input(z.object({ campaignId, assigneeIds: z.array(z.number().int().positive()).max(50).optional() }))
    .mutation(({ ctx, input }) => distributeCampaignTasks(actor(ctx, "productStudio.distributeCampaignTasks"), input)),
  campaignAnalytics: productStudioReadProcedure.input(z.object({ campaignId })).query(({ ctx, input }) => getStudioCampaignAnalytics(actor(ctx, "productStudio.campaignAnalytics"), input.campaignId)),
  campaignBoard: productStudioReadProcedure.input(z.object({ campaignId })).query(({ ctx, input }) => getStudioCampaignBoard(actor(ctx, "productStudio.campaignBoard"), input.campaignId)),
  createTemporaryPhotographer: productStudioManagerProcedure
    .input(z.object({ campaignId, name: z.string().trim().min(3).max(80) }))
    .mutation(({ ctx, input }) => createTemporaryCampaignPhotographer(actor(ctx, "productStudio.createTemporaryPhotographer"), input)),
  /**
   * توفيقُ مصوّري الحملة بعد الإنشاء — إضافةٌ وإزالةٌ في نداءٍ واحد.
   * يستقبل القائمة النهائيّة (لا الفرق) فتغيّرات الشاشة تنعكس ذرّياً بلا سباق.
   */
  updateCampaignAssignees: productStudioManagerProcedure
    .input(z.object({ campaignId, assigneeIds: z.array(z.number().int().positive()).max(50) }))
    .mutation(({ ctx, input }) => updateCampaignAssignees(actor(ctx, "productStudio.updateCampaignAssignees"), input)),
  revokeTemporaryPhotographers: productStudioManagerProcedure
    .input(z.object({ campaignId }))
    .mutation(({ ctx, input }) => revokeTemporaryCampaignPhotographers(actor(ctx, "productStudio.revokeTemporaryPhotographers"), input.campaignId)),
  claimByBarcode: productStudioWriteProcedure.input(z.object({ barcode: barcodeString })).mutation(({ ctx, input }) => claimStudioProductByBarcode(actor(ctx, "productStudio.claimByBarcode"), input.barcode)),
  linkBarcode: productStudioWriteProcedure
    .input(
      z.object({
        productUnitId: z.number().int().positive(),
        barcode: barcodeStorageString,
        note: z.string().max(255).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const res = await linkStudioBarcode(actor(ctx, "productStudio.linkBarcode"), input);
      await logAudit(ctx, {
        action: "productStudio.linkBarcode",
        entityType: "productUnit",
        entityId: input.productUnitId,
        newValue: { barcode: input.barcode.trim(), note: input.note ?? null },
      });
      return res;
    }),
  sendDueNotifications: productStudioManagerProcedure.input(z.object({ horizonHours: z.number().int().min(1).max(168).default(24) })).mutation(({ ctx, input }) => sendStudioDueNotifications(actor(ctx, "productStudio.sendDueNotifications"), new Date(), input.horizonHours)),
  candidatePreview: productStudioReadProcedure.input(z.object({ taskId })).query(({ ctx, input }) => {
    ctx.res.setHeader("Cache-Control", "private, no-store, max-age=0");
    ctx.res.setHeader("Pragma", "no-cache");
    return getStudioCandidatePreview(actor(ctx, "productStudio.candidatePreview"), input.taskId);
  }),
  taskPreviousImages: productStudioReadProcedure.input(z.object({ taskId })).query(({ ctx, input }) => {
    ctx.res.setHeader("Cache-Control", "private, no-store, max-age=0");
    ctx.res.setHeader("Pragma", "no-cache");
    return getStudioTaskPreviousImages(actor(ctx, "productStudio.taskPreviousImages"), input.taskId);
  }),
  assign: productStudioManagerProcedure
    .input(
      z.object({
        productId: z.number().int().positive(),
        assigneeId: z.number().int().positive(),
        sourceImageId: z.number().int().positive().nullable().optional(),
        priority: priority.optional(),
        dueAt: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => assignStudioTask(actor(ctx, "productStudio.assign"), input)),
  bulkAssign: productStudioManagerProcedure
    .input(
      z.object({
        productIds: z.array(z.number().int().positive()).min(1).max(100),
        assigneeId: z.number().int().positive(),
        priority: priority.optional(),
        dueAt: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => bulkAssignStudioTasks(actor(ctx, "productStudio.bulkAssign"), input)),
  /**
   * إعادةُ إسناد مهمّةٍ **قائمة** إلى مصوّرٍ آخر — أو إلى الطابور المفتوح
   * (`newAssigneeId=null`). المسار الوحيد لتحرير مهمّةٍ عالقةٍ بيد مصوّرٍ غائب
   * بلا إلغاءٍ وفقدانِ سبب الرفض.
   */
  reassign: productStudioManagerProcedure
    .input(
      z.object({
        taskId,
        newAssigneeId: z.number().int().positive().nullable(),
        expectedRevision,
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(({ ctx, input }) => reassignStudioTask(actor(ctx, "productStudio.reassign"), input)),
  /** إعادةُ إسنادٍ جماعيّة — يستقبل معرّفات مهام لا منتجات؛ يوفّق المصوّر الجديد بلا إنشاء صفوف. */
  bulkReassign: productStudioManagerProcedure
    .input(
      z.object({
        taskIds: z.array(z.number().int().positive()).min(1).max(100),
        newAssigneeId: z.number().int().positive().nullable(),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(({ ctx, input }) => bulkReassignStudioTasks(actor(ctx, "productStudio.bulkReassign"), input)),
  /** ضبطُ الأولويّة على دفعةٍ من المهام دفعةً واحدة — بلا هذا المسار كان المدير يفتح كلاًّ منفرداً. */
  bulkSetPriority: productStudioManagerProcedure
    .input(
      z.object({
        taskIds: z.array(z.number().int().positive()).min(1).max(100),
        priority,
        dueAt: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => bulkSetStudioPriority(actor(ctx, "productStudio.bulkSetPriority"), input)),
  updateSchedule: productStudioManagerProcedure
    .input(
      z.object({
        taskId,
        expectedRevision,
        priority,
        dueAt: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => updateStudioTaskSchedule(actor(ctx, "productStudio.updateSchedule"), input)),
  saveDraft: productStudioWriteProcedure
    .input(
      z.object({
        taskId,
        proposedName: nullableText(255),
        proposedDescription: nullableText(5_000),
        proposedMarketingCopy: nullableText(3_000),
        adminOverrideReason,
        expectedRevision,
      }),
    )
    .mutation(({ ctx, input }) => saveStudioDraft(actor(ctx, "productStudio.saveDraft"), { ...input, requireBarcodeVerification: true })),
  bindProcessingProof: productStudioWriteProcedure
    .input(
      z.object({
        taskId,
        processingReceipt: z.string().uuid(),
        candidateDataUrl: z.string().max(1_300_000),
        adminOverrideReason,
        expectedRevision: expectedRevision.optional(),
      }),
    )
    .mutation(({ ctx, input }) => bindStudioProcessingCandidate(actor(ctx, "productStudio.bindProcessingProof"), { ...input, requireBarcodeVerification: true })),
  reserveImages: productStudioWriteProcedure
    .input(z.object({ taskId, count: z.number().int().min(1).max(10), adminOverrideReason }))
    .mutation(({ ctx, input }) => reserveStudioImageTasks(actor(ctx, "productStudio.reserveImages"), { ...input, requireBarcodeVerification: true })),
  submitCandidate: productStudioWriteProcedure
    .input(
      z.object({
        taskId,
        originalDataUrl: z.string().max(1_300_000).nullable().optional(),
        processedDataUrl: z.string().max(1_300_000),
        thumbnailDataUrl: z.string().max(180_000),
        mode: z.enum(["FLATTEN", "CUT", "AI"]),
        processingReceipt: z.string().uuid().nullable().optional(),
        proposedName: nullableText(255),
        proposedDescription: nullableText(5_000),
        proposedMarketingCopy: nullableText(3_000),
        adminOverrideReason,
        expectedRevision,
      }),
    )
    .mutation(({ ctx, input }) => submitStudioCandidate(actor(ctx, "productStudio.submitCandidate"), { ...input, requireBarcodeVerification: true })),
  approve: productStudioManagerProcedure.input(z.object({ taskId, adminOverrideReason, expectedRevision })).mutation(({ ctx, input }) => approveStudioTask(actor(ctx, "productStudio.approve"), input.taskId, input.adminOverrideReason, input.expectedRevision)),
  reject: productStudioManagerProcedure
    .input(
      z.object({
        taskId,
        reason: z.string().trim().min(5).max(500),
        adminOverrideReason,
        expectedRevision,
      }),
    )
    .mutation(({ ctx, input }) => rejectStudioTask(actor(ctx, "productStudio.reject"), input.taskId, input.reason, input.adminOverrideReason, input.expectedRevision)),
  revert: productStudioManagerProcedure.input(z.object({ taskId, expectedRevision })).mutation(({ ctx, input }) => revertStudioTask(actor(ctx, "productStudio.revert"), input.taskId, input.expectedRevision)),
  cancel: productStudioManagerProcedure
    .input(
      z.object({
        taskId,
        reason: z.string().trim().min(5).max(500),
        expectedRevision,
      }),
    )
    .mutation(({ ctx, input }) => cancelStudioTask(actor(ctx, "productStudio.cancel"), input)),
  cancelCampaignBacklog: productStudioManagerProcedure
    .input(
      z.object({
        campaignId,
        reason: z.string().trim().min(5).max(500),
        // ٢٩/٨: cascade أيضاً في الـsweep حتى لا يبقى المسنَد بعد أن اختار المدير حذفَه.
        cascadeAssigned: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => bulkCancelStudioBacklog(actor(ctx, "productStudio.cancelCampaignBacklog"), input)),
  // البحث السريع بالباركود للمنتجات وصورها — متاح لكل من يملك الوصول للاستوديو بلا حملات
  quickBarcodeLookup: productStudioReadProcedure
    .input(z.object({ barcode: optionalBarcodeString, productId: z.number().int().positive().optional(), variantId: z.number().int().positive().nullable().optional() }))
    .query(({ ctx, input }) => quickBarcodeLookup(actor(ctx, "productStudio.quickBarcodeLookup"), input)),
  // الحفظ الفوري والمعالجة: اعتماد مباشر وتلقائي للمدير بلا روتين، وإرسال للاعتماد لغير المدير
  quickSaveBarcodeProductImage: productStudioWriteProcedure
    .input(
      z.object({
        productId: z.number().int().positive(),
        variantId: z.number().int().positive().nullable().optional(),
        barcode: optionalBarcodeString,
        originalDataUrl: z.string().max(1_300_000).nullable().optional(),
        processedDataUrl: z.string().max(1_300_000),
        thumbnailDataUrl: z.string().max(180_000),
        mode: z.enum(["FLATTEN", "CUT", "PRO", "AI", "ORIGINAL"]).default("FLATTEN"),
        setAsPrimary: z.boolean().optional(),
        adminOverrideReason,
      }),
    )
    .mutation(({ ctx, input }) => quickSaveBarcodeProductImage(actor(ctx, "productStudio.quickSaveBarcodeProductImage"), input)),
  // معالجة بالذكاء الاصطناعي السريعة عبر API (Gemini أو remove.bg) لصور الباركود المباشرة
  quickAiTransform: productStudioWriteProcedure
    .input(
      z.object({
        imageDataUrl: z.string().min(1).max(6_000_000),
        mode: z.enum(["AI", "REMOVEBG"]).default("AI"),
        productId: z.number().int().positive().optional(),
        barcode: optionalBarcodeString,
        adminOverrideReason,
      }),
    )
    .mutation(({ ctx, input }) => quickAiTransform(actor(ctx, "productStudio.quickAiTransform"), input)),
});
