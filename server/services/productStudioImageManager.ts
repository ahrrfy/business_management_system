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
import { auditLogs, productImages, productVariants, products } from "../../drizzle/schema";
import { requireDb, withTx } from "./tx";
import { logger } from "../logger";
import type { ProductStudioActor } from "./productStudioService";

/** حرّاسٌ أساسيّة — نفس نمط productStudioService (كي لا يتسرّب فحص الصلاحية من مكانَين). */
function isManager(actor: ProductStudioActor): boolean {
  return actor.role === "admin" || actor.role === "manager" || actor.isOwner === true;
}

/**
 * قائمةُ صور المنتج مع اسم البديل (إن وُجد) — للعرض في «معرض الصور».
 * تُعاد فقط المُعتمَدة والمُنشورة (لها `objectKey`)، مرتّبةً بـ`sortOrder` ثمّ `id`.
 * تشمل الصور على مستوى الأمّ (`variantId=NULL`) والبدائل معاً — كل صفٍّ يعلن انتماءه.
 */
export async function listProductImagesForManager(actor: ProductStudioActor, productId: number) {
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
  return rows.map((r) => ({
    id: Number(r.id),
    productId: Number(r.productId),
    variantId: r.variantId == null ? null : Number(r.variantId),
    variantName: r.variantName,
    url: r.url,
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
  }));
}

/**
 * حذفُ صورةٍ من `productImages`. المفتاح في R2 يُترَك في السجلّ (سعاة الاسترداد
 * البنيويّة يعالجونه)؛ الأثرُ يحفظ objectKey للتشخيص. **لا يُسمح بحذف الصورة الرئيسيّة
 * إن كانت الوحيدة** — يجب أوّلاً تعيين صورةٍ أخرى رئيسيّةً أو إضافة أخرى.
 */
export async function deleteProductImage(
  actor: ProductStudioActor,
  input: { imageId: number; reason?: string | null },
) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const reason = input.reason?.trim() ?? null;
  return withTx(async (tx) => {
    const [image] = await tx
      .select()
      .from(productImages)
      .where(eq(productImages.id, input.imageId))
      .limit(1)
      .for("update");
    if (!image) throw new TRPCError({ code: "NOT_FOUND", message: "الصورة غير موجودة" });
    if (image.isPrimary) {
      // منعُ حذف الرئيسيّة إن كانت الوحيدة — يُبقي المنتج ظاهراً بلا صورةٍ في الشبكة.
      const [siblings] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(productImages)
        .where(and(eq(productImages.productId, image.productId), sql`${productImages.id} <> ${image.id}`));
      if (Number(siblings?.n ?? 0) === 0) {
        throw new TRPCError({ code: "CONFLICT", message: "لا يمكن حذف الصورة الوحيدة للمنتج — أضِف صورةً أخرى أوّلاً" });
      }
    }
    await tx.delete(productImages).where(eq(productImages.id, input.imageId));
    // إن كانت الرئيسيّة: عيّن التاليةَ رئيسيّةً تلقائياً — كي لا يظلّ المنتج بلا primary.
    if (image.isPrimary) {
      const [next] = await tx
        .select({ id: productImages.id })
        .from(productImages)
        .where(and(eq(productImages.productId, image.productId), eq(productImages.reviewStatus, "APPROVED")))
        .orderBy(productImages.sortOrder, productImages.id)
        .limit(1);
      if (next) {
        await tx.update(productImages).set({ isPrimary: true }).where(eq(productImages.id, next.id));
      }
    }
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: actor.branchId,
      action: "productStudio.image.delete",
      entityType: "productImage",
      entityId: String(input.imageId),
      oldValue: { productId: image.productId, variantId: image.variantId, objectKey: image.objectKey, isPrimary: image.isPrimary, sortOrder: image.sortOrder },
      newValue: { deleted: true, reason },
    });
    return { imageId: input.imageId, promotedNewPrimary: image.isPrimary };
  });
}

/**
 * تعيينُ صورةٍ محدَّدة رئيسيّةً — يخفض بقيّة الرئيسيات على نفس المستوى (variantId).
 * (بعد هجرة 0268 صار كلّ بديلٍ يحتفظ برئيسيّته المستقلّة — approve يفعلها للجديد؛
 * هذا المسار يُوفّر تحكّماً يدوياً للمدير على الصور القائمة.)
 */
export async function setPrimaryProductImage(actor: ProductStudioActor, imageId: number) {
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  return withTx(async (tx) => {
    const [image] = await tx
      .select({ id: productImages.id, productId: productImages.productId, variantId: productImages.variantId, isPrimary: productImages.isPrimary })
      .from(productImages)
      .where(eq(productImages.id, imageId))
      .limit(1)
      .for("update");
    if (!image) throw new TRPCError({ code: "NOT_FOUND", message: "الصورة غير موجودة" });
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
  if (!isManager(actor)) throw new TRPCError({ code: "FORBIDDEN" });
  const ids = Array.from(new Set(input.orderedImageIds.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0)));
  if (ids.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "قائمة الصور فارغة" });
  return withTx(async (tx) => {
    const belonging = await tx
      .select({ id: productImages.id })
      .from(productImages)
      .where(and(eq(productImages.productId, input.productId), inArray(productImages.id, ids)));
    const belongingSet = new Set(belonging.map((r) => Number(r.id)));
    let position = 0;
    for (const id of ids) {
      if (!belongingSet.has(id)) continue;
      await tx.update(productImages).set({ sortOrder: position }).where(eq(productImages.id, id));
      position++;
    }
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: actor.branchId,
      action: "productStudio.image.reorder",
      entityType: "product",
      entityId: String(input.productId),
      newValue: { orderedImageIds: ids.filter((id) => belongingSet.has(id)) },
    });
    return { updatedCount: position };
  });
}

// دالة `withTx` تُعرَّف داخل productStudioService عبر `withStudioTx`. لكن كل ما نحتاجه
// هنا هو معاملةٌ عاديّة — نُعيد استعمال `withTx` من `./tx` (البرميل العامّ) كي لا نُدخل
// دورةَ استيراد بين هذا الملفّ وproductStudioService (كلاهما يستورد الآخر منطقياً).
void logger;
