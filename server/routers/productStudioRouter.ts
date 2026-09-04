import { z } from "zod";
import { productStudioManagerProcedure, productStudioReadProcedure, productStudioWriteProcedure, router } from "../trpc";
import { barcodeString } from "../lib/schemas";
import { approveStudioTask, assignStudioTask, bulkAssignStudioTasks, bulkCancelStudioBacklog, bulkReassignStudioTasks, bulkSetStudioPriority, cancelStudioTask, claimStudioProductByBarcode, createStudioCampaign, createTemporaryCampaignPhotographer, revokeTemporaryCampaignPhotographers, grantStudioAccess, createStudioCampaignBacklog, bindStudioProcessingCandidate, getStudioCandidatePreview, getStudioSourcePreview, getStudioDashboard, getStudioCampaignAnalytics, getStudioCampaignBoard, listStudioAssignees, listStudioCampaigns, listMyStudioCampaigns, listStudioProducts, listStudioProductImages, listStudioTasks, reassignStudioTask, rejectStudioTask, previewStudioCampaignBacklog, resolveStudioBarcode, revertStudioTask, saveStudioDraft, sendStudioDueNotifications, submitStudioCandidate, transitionStudioCampaign, updateCampaignAssignees, updateStudioCampaignDetails, updateStudioTaskSchedule, type ProductStudioActor } from "../services/productStudioService";
import { deleteProductImage, listProductImagesForManager, reorderProductImages, setPrimaryProductImage } from "../services/productStudioImageManager";
import { discoverImageGaps, getImageHealthCounts, getTopGapCategories, IMAGE_HEALTH_STATES } from "../services/productStudioDiscovery";

function actor(ctx: {
  user: {
    id: number;
    branchId?: number | null;
    role: string;
    isOwner?: boolean;
  };
}): ProductStudioActor {
  return {
    userId: Number(ctx.user.id),
    branchId: ctx.user.branchId == null ? null : Number(ctx.user.branchId),
    role: ctx.user.role,
    isOwner: ctx.user.isOwner === true,
  };
}

const taskId = z.number().int().positive();
const expectedRevision = z.number().int().positive();
const priority = z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]);
const campaignId = z.number().int().positive();
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const adminOverrideReason = z.string().trim().min(5).max(500).optional();

export const productStudioRouter = router({
  dashboard: productStudioReadProcedure.query(({ ctx }) => getStudioDashboard(actor(ctx))),
  products: productStudioReadProcedure
    .input(
      z.object({
        search: z.string().trim().max(80).default(""),
        cursor: z.string().max(500).nullable().optional(),
        includeInactive: z.boolean().optional(),
      }),
    )
    .query(({ ctx, input }) => listStudioProducts(actor(ctx), input)),
  resolveBarcode: productStudioReadProcedure.input(z.object({ barcode: barcodeString })).query(({ ctx, input }) => resolveStudioBarcode(actor(ctx), input.barcode)),
  productImages: productStudioReadProcedure.input(z.object({ productId: z.number().int().positive() })).query(({ ctx, input }) => listStudioProductImages(actor(ctx), input.productId)),
  // إدارةُ صور المنتج القائمة — للمدير (طلب المالك ٢٦/٨: التحكم الكامل بالصور).
  managerImages: productStudioManagerProcedure
    .input(z.object({ productId: z.number().int().positive() }))
    .query(({ ctx, input }) => listProductImagesForManager(actor(ctx), input.productId)),
  deleteImage: productStudioManagerProcedure
    .input(z.object({ imageId: z.number().int().positive(), reason: z.string().trim().max(500).optional() }))
    .mutation(({ ctx, input }) => deleteProductImage(actor(ctx), input)),
  setImagePrimary: productStudioManagerProcedure
    .input(z.object({ imageId: z.number().int().positive() }))
    .mutation(({ ctx, input }) => setPrimaryProductImage(actor(ctx), input.imageId)),
  reorderImages: productStudioManagerProcedure
    .input(z.object({ productId: z.number().int().positive(), orderedImageIds: z.array(z.number().int().positive()).min(1).max(200) }))
    .mutation(({ ctx, input }) => reorderProductImages(actor(ctx), input)),
  // كاشفُ فجوات الصور (طلب المالك ٢٦/٨): تصنيفٌ ذكيّ يُبرِز الأولويّات لتوفير الوقت.
  imageHealthCounts: productStudioManagerProcedure.query(({ ctx }) => getImageHealthCounts(actor(ctx))),
  discoverImageGaps: productStudioManagerProcedure
    .input(
      z.object({
        states: z.array(z.enum(IMAGE_HEALTH_STATES)).max(6).optional(),
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
    .query(({ ctx, input }) => discoverImageGaps(actor(ctx), input)),
  topGapCategories: productStudioManagerProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).optional() }))
    .query(({ ctx, input }) => getTopGapCategories(actor(ctx), input.limit)),
  assignees: productStudioManagerProcedure.query(({ ctx }) => listStudioAssignees(actor(ctx))),
  grantStudioAccess: productStudioManagerProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .mutation(({ ctx, input }) => grantStudioAccess(actor(ctx), input.userId)),
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
        campaignId: campaignId.optional(),
        unassigned: z.boolean().optional(),
        search: z.string().trim().max(80).optional(),
        // ٢٩/٨: يُخفي المهامَّ التي حملتُها في حالةٍ نهائيّة (مغلقة/ملغاة) — PAUSED تبقى.
        hideClosedCampaigns: z.boolean().optional(),
      }),
    )
    .query(({ ctx, input }) => listStudioTasks(actor(ctx), input)),
  campaigns: productStudioReadProcedure.query(({ ctx }) => listStudioCampaigns(actor(ctx))),
  /**
   * حملاتُ المستخدم الحاليّ (نشطةٌ وهو عضوٌ فيها) — نافذته الوحيدة على «ماذا يخصّني».
   * قراءةٌ ضيّقة تُعوّض غياب `campaigns` عن الأدوار غير الإدارية بلا تسريب حملاتٍ لا تعنيه.
   */
  myCampaigns: productStudioReadProcedure.query(({ ctx }) => listMyStudioCampaigns(actor(ctx))),
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
    .mutation(({ ctx, input }) => createStudioCampaign(actor(ctx), input)),
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
    .mutation(({ ctx, input }) => updateStudioCampaignDetails(actor(ctx), input)),
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
    .mutation(({ ctx, input }) => transitionStudioCampaign(actor(ctx), input)),
  previewCampaignBacklog: productStudioManagerProcedure.input(z.object({ campaignId })).query(({ ctx, input }) => previewStudioCampaignBacklog(actor(ctx), input.campaignId)),
  createCampaignBacklog: productStudioManagerProcedure.input(z.object({ campaignId })).mutation(({ ctx, input }) => createStudioCampaignBacklog(actor(ctx), input.campaignId)),
  campaignAnalytics: productStudioReadProcedure.input(z.object({ campaignId })).query(({ ctx, input }) => getStudioCampaignAnalytics(actor(ctx), input.campaignId)),
  campaignBoard: productStudioReadProcedure.input(z.object({ campaignId })).query(({ ctx, input }) => getStudioCampaignBoard(actor(ctx), input.campaignId)),
  createTemporaryPhotographer: productStudioManagerProcedure
    .input(z.object({ campaignId, name: z.string().trim().min(3).max(80) }))
    .mutation(({ ctx, input }) => createTemporaryCampaignPhotographer(actor(ctx), input)),
  /**
   * توفيقُ مصوّري الحملة بعد الإنشاء — إضافةٌ وإزالةٌ في نداءٍ واحد.
   * يستقبل القائمة النهائيّة (لا الفرق) فتغيّرات الشاشة تنعكس ذرّياً بلا سباق.
   */
  updateCampaignAssignees: productStudioManagerProcedure
    .input(z.object({ campaignId, assigneeIds: z.array(z.number().int().positive()).max(50) }))
    .mutation(({ ctx, input }) => updateCampaignAssignees(actor(ctx), input)),
  revokeTemporaryPhotographers: productStudioManagerProcedure
    .input(z.object({ campaignId }))
    .mutation(({ ctx, input }) => revokeTemporaryCampaignPhotographers(actor(ctx), input.campaignId)),
  claimByBarcode: productStudioWriteProcedure.input(z.object({ barcode: barcodeString })).mutation(({ ctx, input }) => claimStudioProductByBarcode(actor(ctx), input.barcode)),
  sendDueNotifications: productStudioManagerProcedure.input(z.object({ horizonHours: z.number().int().min(1).max(168).default(24) })).mutation(({ ctx, input }) => sendStudioDueNotifications(actor(ctx), new Date(), input.horizonHours)),
  candidatePreview: productStudioReadProcedure.input(z.object({ taskId })).query(({ ctx, input }) => {
    ctx.res.setHeader("Cache-Control", "private, no-store, max-age=0");
    ctx.res.setHeader("Pragma", "no-cache");
    return getStudioCandidatePreview(actor(ctx), input.taskId);
  }),
  sourcePreview: productStudioReadProcedure.input(z.object({ taskId })).query(({ ctx, input }) => {
    ctx.res.setHeader("Cache-Control", "private, no-store, max-age=0");
    ctx.res.setHeader("Pragma", "no-cache");
    return getStudioSourcePreview(actor(ctx), input.taskId);
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
    .mutation(({ ctx, input }) => assignStudioTask(actor(ctx), input)),
  bulkAssign: productStudioManagerProcedure
    .input(
      z.object({
        productIds: z.array(z.number().int().positive()).min(1).max(100),
        assigneeId: z.number().int().positive(),
        priority: priority.optional(),
        dueAt: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => bulkAssignStudioTasks(actor(ctx), input)),
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
    .mutation(({ ctx, input }) => reassignStudioTask(actor(ctx), input)),
  /** إعادةُ إسنادٍ جماعيّة — يستقبل معرّفات مهام لا منتجات؛ يوفّق المصوّر الجديد بلا إنشاء صفوف. */
  bulkReassign: productStudioManagerProcedure
    .input(
      z.object({
        taskIds: z.array(z.number().int().positive()).min(1).max(100),
        newAssigneeId: z.number().int().positive().nullable(),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(({ ctx, input }) => bulkReassignStudioTasks(actor(ctx), input)),
  /** ضبطُ الأولويّة على دفعةٍ من المهام دفعةً واحدة — بلا هذا المسار كان المدير يفتح كلاًّ منفرداً. */
  bulkSetPriority: productStudioManagerProcedure
    .input(
      z.object({
        taskIds: z.array(z.number().int().positive()).min(1).max(100),
        priority,
        dueAt: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => bulkSetStudioPriority(actor(ctx), input)),
  updateSchedule: productStudioManagerProcedure
    .input(
      z.object({
        taskId,
        expectedRevision,
        priority,
        dueAt: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => updateStudioTaskSchedule(actor(ctx), input)),
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
    .mutation(({ ctx, input }) => saveStudioDraft(actor(ctx), input)),
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
    .mutation(({ ctx, input }) => bindStudioProcessingCandidate(actor(ctx), input)),
  submitCandidate: productStudioWriteProcedure
    .input(
      z.object({
        taskId,
        originalDataUrl: z.string().max(1_300_000).nullable().optional(),
        processedDataUrl: z.string().max(1_300_000),
        thumbnailDataUrl: z.string().max(180_000),
        mode: z.enum(["FLATTEN", "CUT"]),
        processingReceipt: z.string().uuid().nullable().optional(),
        proposedName: nullableText(255),
        proposedDescription: nullableText(5_000),
        proposedMarketingCopy: nullableText(3_000),
        adminOverrideReason,
        expectedRevision,
      }),
    )
    .mutation(({ ctx, input }) => submitStudioCandidate(actor(ctx), input)),
  approve: productStudioManagerProcedure.input(z.object({ taskId, adminOverrideReason, expectedRevision })).mutation(({ ctx, input }) => approveStudioTask(actor(ctx), input.taskId, input.adminOverrideReason, input.expectedRevision)),
  reject: productStudioManagerProcedure
    .input(
      z.object({
        taskId,
        reason: z.string().trim().min(5).max(500),
        adminOverrideReason,
        expectedRevision,
      }),
    )
    .mutation(({ ctx, input }) => rejectStudioTask(actor(ctx), input.taskId, input.reason, input.adminOverrideReason, input.expectedRevision)),
  revert: productStudioManagerProcedure.input(z.object({ taskId, expectedRevision })).mutation(({ ctx, input }) => revertStudioTask(actor(ctx), input.taskId, input.expectedRevision)),
  cancel: productStudioManagerProcedure
    .input(
      z.object({
        taskId,
        reason: z.string().trim().min(5).max(500),
        expectedRevision,
      }),
    )
    .mutation(({ ctx, input }) => cancelStudioTask(actor(ctx), input)),
  cancelCampaignBacklog: productStudioManagerProcedure
    .input(
      z.object({
        campaignId,
        reason: z.string().trim().min(5).max(500),
        // ٢٩/٨: cascade أيضاً في الـsweep حتى لا يبقى المسنَد بعد أن اختار المدير حذفَه.
        cascadeAssigned: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => bulkCancelStudioBacklog(actor(ctx), input)),
});
