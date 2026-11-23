import { assertStudioOperationBinding, assertStudioOperationTx, isStudioManager } from "./authorization/studioOperationAuthority";
/**
 * إدارةُ صور المنتج القائمة — حذف، ترتيب، تعيين رئيسيّة، وإرفاق بديل.
 *
 * الحاجة (المالك ٢٦/٨): «التحكم الكامل بالصور حتى الموجودة سابقاً في المنتج من إزالتها
 * وغير ذلك أو استبدالها». مسار الاستوديو القائم يُضيف صوراً ولا يمسّ الموجودة —
 * ولا مكانَ في الواجهة لحذفٍ أو إعادة ترتيب. هذا الخدمة تسدّ الفجوة.
 *
 * المصدر: `productImages` (المُنشورة، `reviewStatus='APPROVED'`) — لا نمسّ المرشّحات
 * ولا الأصل في `productImageJobs.originalObjectKey`.
 *
 * الأمان: manager فقط (وقفٌ عند الراوتر) + `productStudio: FULL` + عزل الفرع. كل عمليةٍ
 * تُسجَّل في `auditLogs` بـoldValue/newValue، والصورة المحذوفة تحمل مفتاح objectKey في
 * الأثر — سعاة R2 يستردّون الملفَّ في نافذة الاستحقاق (نفس مسار المرشّح المرفوض).
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { auditLogs, productImages, productVariants } from "../../drizzle/schema";
import { inventoryProductImageUrl } from "../imageRoute";
import { getCurrentCompanyId } from "../tenancy/context";
import { requireDb, withTx } from "./tx";
import { logger } from "../logger";
import { invalidateProductStudioCaches } from "./productStudioCache";
import type { ProductStudioActor } from "./productStudioService";

/** حرّاسٌ أساسيّة — نفس نمط productStudioService (كي لا يتسرّب فحص الصلاحية من مكانَين). */
function isManager(actor: ProductStudioActor): boolean {
  return isStudioManager(actor);
}

/**
 * قائمةُ صور المنتج مع اسم البديل (إن وُجد) — للعرض في «معرض الصور».
 * تُعاد فقط المُعتمَدة والمُنشورة (لها `objectKey`)، مرتّبةً بـ`sortOrder` ثمّ `id`.
 * تشمل الصور على مستوى الأمّ (`variantId=NULL`) والبدائل معاً — كل صفٍّ يعلن انتماءه.
 */
export async function listProductImagesForManager(actor: ProductStudioActor, productId: number) {
  assertStudioOperationBinding(actor, "productStudio.managerImages");
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const db = requireDb();
  const rows = await db
    .select({
      id: productImages.id,
      productId: productImages.productId,
      variantId: productImages.variantId,
      variantName: productVariants.variantName,
      url: productImages.url,
      isPrimary: productImages.isPrimary,
      sortOrder: productImages.sortOrder,
      objectKey: productImages.objectKey,
      contentHash: productImages.contentHash,
      mime: productImages.mime,
      width: productImages.width,
      height: productImages.height,
      bytes: productImages.bytes,
      thumbDataUrl: productImages.thumbDataUrl,
      origin: productImages.origin,
      createdAt: productImages.createdAt,
    })
    .from(productImages)
    .leftJoin(productVariants, eq(productVariants.id, productImages.variantId))
    .where(and(eq(productImages.productId, productId), eq(productImages.reviewStatus, "APPROVED")))
    .orderBy(productImages.sortOrder, productImages.id);
  return rows.map((r) => {
    const id = Number(r.id);
    const displayUrl =
      inventoryProductImageUrl(id, {
        url: r.url,
        objectKey: r.objectKey,
        contentHash: r.contentHash,
      }) ??
      r.thumbDataUrl ??
      r.url;
    return {
      id,
      productId: Number(r.productId),
      variantId: r.variantId == null ? null : Number(r.variantId),
      variantName: r.variantName,
      url: r.url,
      displayUrl,
      contentHash: r.contentHash,
      isPrimary: Boolean(r.isPrimary),
      sortOrder: Number(r.sortOrder ?? 0),
      objectKey: r.objectKey,
      mime: r.mime,
      width: r.width,
      height: r.height,
      bytes: r.bytes,
      thumbDataUrl: r.thumbDataUrl,
      origin: r.origin,
      createdAt: r.createdAt,
    };
  });
}

/**
 * حذفُ صورةٍ من `productImages`. المفتاح في R2 يُستردّ تلقائياً عند غياب المراجع؛
 * الأثرُ يحفظ objectKey للتشخيص. إذا كانت الصورة المحذوفة رئيسيّةً وُجِد لها بديلٌ
 * معتمَدٌ في نفس النطاق (variant-scoped) يُرقّى تلقائياً إلى رئيسيّةٍ؛ وإن كانت آخر
 * صورةٍ في النطاق يُسمح للمدير بإزالتها بعد التأكيد.
 */
export async function deleteProductImage(
  actor: ProductStudioActor,
  input: { imageId: number; reason?: string | null },
) {
  assertStudioOperationBinding(actor, "productStudio.deleteImage");
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const reason = input.reason?.trim() ?? null;
  const companyId = getCurrentCompanyId() ?? 1;
  return withTx(async (tx) => {
    await assertStudioOperationTx(tx, actor, "productStudio.deleteImage");
    const [image] = await tx
      .select()
      .from(productImages)
      .where(eq(productImages.id, input.imageId))
      .limit(1)
      .for("update");
    if (!image) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر حذف الصورة",
          why: "الصورة المطلوبة غير موجودة أو حُذفت مسبقاً",
          doThis: "حدّث معرض الصور للتحقّق من القائمة الحاليّة",
        }),
      });
    }
    await tx.delete(productImages).where(eq(productImages.id, input.imageId));
    let promotedNewPrimary = false;
    // إن كانت الرئيسيّة: عيّن التاليةَ رئيسيّةً — **في نفس النطاق** (variant-scoped)
    // كي لا نُرقّي صورةَ بديلٍ آخر إلى رئيسيّةٍ لهذا النطاق (خلطٌ يمرّ في الكشك/المتجر).
    if (image.isPrimary) {
      const [next] = await tx
        .select({ id: productImages.id })
        .from(productImages)
        .where(
          and(
            eq(productImages.productId, image.productId),
            eq(productImages.reviewStatus, "APPROVED"),
            image.variantId == null ? isNull(productImages.variantId) : eq(productImages.variantId, image.variantId),
          ),
        )
        .orderBy(productImages.sortOrder, productImages.id)
        .limit(1);
      if (next) {
        await tx.update(productImages).set({ isPrimary: true }).where(eq(productImages.id, next.id));
        promotedNewPrimary = true;
      }
    }
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: actor.branchId,
      action: "productStudio.image.delete",
      entityType: "productImage",
      entityId: String(input.imageId),
      oldValue: { productId: image.productId, variantId: image.variantId, objectKey: image.objectKey, isPrimary: image.isPrimary, sortOrder: image.sortOrder },
      newValue: { deleted: true, promotedNewPrimary, reason },
    });
    invalidateProductStudioCaches(companyId, [Number(image.productId)]);
    return { imageId: input.imageId, promotedNewPrimary };
  });
}

/**
 * تعيينُ صورةٍ محدَّدة رئيسيّةً — يخفض بقيّة الرئيسيات على نفس المستوى (variantId).
 * يشترط أن تكون الصورة معتمدة (`APPROVED`) حتى لا تُرقّى صورةٌ مرفوضة أو قيد المراجعة.
 */
export async function setPrimaryProductImage(actor: ProductStudioActor, imageId: number) {
  assertStudioOperationBinding(actor, "productStudio.setImagePrimary");
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const companyId = getCurrentCompanyId() ?? 1;
  return withTx(async (tx) => {
    await assertStudioOperationTx(tx, actor, "productStudio.setImagePrimary");
    const [image] = await tx
      .select({
        id: productImages.id,
        productId: productImages.productId,
        variantId: productImages.variantId,
        isPrimary: productImages.isPrimary,
        reviewStatus: productImages.reviewStatus,
      })
      .from(productImages)
      .where(eq(productImages.id, imageId))
      .limit(1)
      .for("update");
    if (!image) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر تعيين الصورة رئيسيّةً",
          why: "سجلّ الصورة غير موجود أو تمّت إزالته",
          doThis: "حدّث معرض الصور واختر صورةً قائمة",
        }),
      });
    }
    if (image.reviewStatus !== "APPROVED") {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر تعيين الصورة رئيسيّةً",
          why: "لا يمكن ترقية صورة غير معتمدة (قيد المراجعة أو مرفوضة) كصورة رئيسيّة",
          doThis: "اعتمد الصورة أوّلاً من لوحة المراجعة ثمّ عيّنها رئيسيّةً",
        }),
      });
    }
    if (image.isPrimary) return { imageId, changed: false as const };
    await tx
      .update(productImages)
      .set({ isPrimary: false })
      .where(
        and(
          eq(productImages.productId, image.productId),
          eq(productImages.isPrimary, true),
          image.variantId == null ? isNull(productImages.variantId) : eq(productImages.variantId, image.variantId),
        ),
      );
    await tx.update(productImages).set({ isPrimary: true }).where(eq(productImages.id, imageId));
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: actor.branchId,
      action: "productStudio.image.setPrimary",
      entityType: "productImage",
      entityId: String(imageId),
      newValue: { productId: image.productId, variantId: image.variantId },
    });
    invalidateProductStudioCaches(companyId, [Number(image.productId)]);
    return { imageId, changed: true as const };
  });
}

/**
 * إعادةُ ترتيب صور منتجٍ بضربةٍ واحدة. يُقبَل معرّفات الصور بالترتيب الذي يريده المدير،
 * ويكتب `sortOrder` تسلسلياً. المعرّفات غير التابعة للمنتج (تسريبٌ من الواجهة) تُتجاهَل.
 */
export async function reorderProductImages(
  actor: ProductStudioActor,
  input: { productId: number; orderedImageIds: number[] },
) {
  assertStudioOperationBinding(actor, "productStudio.reorderImages");
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const ids = Array.from(new Set(input.orderedImageIds.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0)));
  if (ids.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حفظ الترتيب",
        why: "قائمة معرّفات الصور المرسلة فارغة",
        doThis: "رتّب صورةً واحدةً على الأقلّ ثمّ أعد الحفظ",
      }),
    });
  }
  const companyId = getCurrentCompanyId() ?? 1;
  return withTx(async (tx) => {
    await assertStudioOperationTx(tx, actor, "productStudio.reorderImages");
    const belonging = await tx
      .select({ id: productImages.id })
      .from(productImages)
      .where(and(eq(productImages.productId, input.productId), inArray(productImages.id, ids)));
    const belongingSet = new Set(belonging.map((r) => Number(r.id)));
    const validIds = ids.filter((id) => belongingSet.has(id));
    if (validIds.length > 0) {
      const cases = sql.join(
        validIds.map((id, i) => sql`WHEN ${productImages.id} = ${id} THEN ${i}`),
        sql` `,
      );
      await tx
        .update(productImages)
        .set({ sortOrder: sql`CASE ${cases} ELSE ${productImages.sortOrder} END` })
        .where(inArray(productImages.id, validIds));
    }
    const position = validIds.length;
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: actor.branchId,
      action: "productStudio.image.reorder",
      entityType: "product",
      entityId: String(input.productId),
      newValue: { orderedImageIds: validIds },
    });
    invalidateProductStudioCaches(companyId, [Number(input.productId)]);
    return { updatedCount: position };
  });
}

// دالة `withTx` تُعرَّف داخل productStudioService عبر `withStudioTx`. لكن كل ما نحتاجه
// هنا هو معاملةٌ عاديّة — نُعيد استعمال `withTx` من `./tx` (البرميل العامّ) كي لا نُدخل
// دورةَ استيراد بين هذا الملفّ وproductStudioService (كلاهما يستورد الآخر منطقياً).
void logger;
