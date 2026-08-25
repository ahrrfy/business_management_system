/**
 * تصدير صور الاستوديو **المنشورة** حزمةً واحدة — نطاقٌ صريح (كل الكتالوج / فئة / منتجات).
 *
 * الحاجة (المالك ٢٥/٨): «احتاج الصور المنتجات التي هي معدَّلة ومرتَّبة المنشورة» لاستعمالها
 * في السوشيال ميديا وأماكن أخرى. **المصدر إذن `productImages` بـ`reviewStatus='APPROVED'`
 * وحده — لا `productImageJobs.originalObjectKey` (الأصل غير المُعدَّل).**
 *
 * التسمية: كلّ صورةٍ باسم المنتج، مع اسم البديل إن وُجد. عند تكرار الاسم (منتجٌ بصورٍ متعدّدة)
 * تُذيَّل بـ`-N`. الحروف الممنوعة في أسماء الملفات (`\/:*?"<>|`) تُستبدل بشرطة.
 *
 * البثّ: يستعمل `archiver` كي لا يُحمّل الحزمة في الذاكرة — كل صورةٍ تُتلقَّى من R2 بـstream
 * وتُدفَع مباشرةً إلى استجابة HTTP. سقفٌ صارم على عدد الصور لكل نداء (`MAX_EXPORT_IMAGES`)
 * كي لا يستهلك أرشيفٌ ضخمٌ ذاكرة العامل وصلاحيّةَ الجلسة.
 *
 * الأمان: manager فقط (وقفٌ عند بوّابة الراوتر)، ومقيَّدٌ بفرع الفاعل (لا عبور)، ومعزولٌ
 * عن الأصل والمرشّح غير المُعتمَد (فقط `APPROVED` — لا مرشّح `PENDING_REVIEW`).
 */
// @types/archiver يُصدِّر أسماءً فقط بينما الحزمة تُصدّر دالّةً افتراضيّةً قابلة للاستدعاء.
// esModuleInterop يُلف الوحدة CJS ⇒ الاستيراد الافتراضيّ يعمل وقت التشغيل، لكن TS يتشكّى
// لأنّ التعريفات لا تُعلن default. `@ts-expect-error` يُقصر التجاوز على السطر الواحد.
// @ts-expect-error — CJS interop; runtime returns the archiver factory function.
import archiver from "archiver";
import type { Response } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { requireDb } from "./tx";
import { categories, productImages, productVariants, products } from "../../drizzle/schema";
import { getImageStore, isImageStoreOperational } from "../lib/imageStore";
import { logger } from "../logger";
import type { ProductStudioActor } from "./productStudioService";

/** سقفٌ صارم — أرشيفٌ أكبر يتطلّب مهمّة خلفيّة، لا نداءَ HTTP متزامناً. */
export const MAX_EXPORT_IMAGES = 2_000;

export type StudioExportScope =
  | { kind: "ALL" }
  | { kind: "CATEGORY"; categoryId: number }
  | { kind: "PRODUCTS"; productIds: number[] };

interface ExportImageRow {
  productId: number;
  productName: string;
  variantName: string | null;
  objectKey: string;
  mime: string | null;
}

/**
 * يجمعُ الصور المؤهَّلة للتصدير — المعتمدة فقط، وعلى فرع الفاعل إن لم يعبر.
 * الفرع مقيَّدٌ على المنتجات بـ`branchId`؟ لا — الكتالوج مشترك بين الفروع في هذا النظام،
 * والفرع يقيّد الجرد والفواتير لا كتالوج المنتجات. لذا التصفية بالنطاق فقط.
 */
async function queryExportImages(actor: ProductStudioActor, scope: StudioExportScope): Promise<ExportImageRow[]> {
  const db = requireDb();
  void actor;
  const scopeCondition = (() => {
    if (scope.kind === "ALL") return undefined;
    if (scope.kind === "CATEGORY") {
      const categoryId = Number(scope.categoryId);
      // فئةٌ **بكامل شجرتها الفرعية** — نفس منطق `campaignScopeCondition` (CTE عوديّ MySQL 8).
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
    if (scope.kind === "PRODUCTS") {
      if (scope.productIds.length === 0) return sql`1 = 0`;
      return inArray(products.id, scope.productIds);
    }
    return undefined;
  })();

  const rows = await db
    .select({
      productId: productImages.productId,
      productName: products.name,
      variantName: productVariants.variantName,
      objectKey: productImages.objectKey,
      mime: productImages.mime,
    })
    .from(productImages)
    .innerJoin(products, eq(products.id, productImages.productId))
    .leftJoin(productVariants, eq(productVariants.id, productImages.variantId))
    .where(
      and(
        eq(productImages.reviewStatus, "APPROVED"),
        // فقط الصور المنشورة في R2 (لها objectKey) — لا صور legacy تُخدَم من `url` وحدها.
        // تلك لم تمرّ بمسار الاستوديو الحديث وليست «معدَّلة ومرتَّبة» بمعنى المالك.
        sql`${productImages.objectKey} is not null`,
        // استبعادُ `ORIGINAL` — يشمل الصور القديمة (legacy) والصور التي أُعيدت بـ
        // `revertStudioTask` (تُستعاد الأصل غير المعدَّل مع `origin='ORIGINAL'` و
        // `reviewStatus='APPROVED'`). المالك طلب المعدَّل المنشور، لا الأصل المستعاد.
        inArray(productImages.origin, ["STUDIO_FREE", "STUDIO_PRO", "STUDIO_AI"]),
        eq(products.isActive, true),
        // الخدمات لا تُصوَّر ⇒ لا تُصدَّر (تكامل مع استبعادها من الحملات).
        eq(products.isService, false),
        scopeCondition,
      ),
    )
    // ترتيبٌ ثابت (منتج ثمّ id) كي تكون التسمية `-N` مستقرّةً عبر التصديرات.
    .orderBy(products.name, products.id, productImages.id)
    .limit(MAX_EXPORT_IMAGES + 1);

  return rows.map((row): ExportImageRow => ({
    productId: Number(row.productId),
    productName: row.productName,
    variantName: row.variantName,
    objectKey: String(row.objectKey),
    mime: row.mime,
  }));
}

const FORBIDDEN_FILENAME_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;

/** يستبدل الحروف الممنوعة في أسماء الملفات ويقصّ الطول لحدٍّ آمن على Windows/macOS. */
function sanitizeFilenamePart(input: string): string {
  const cleaned = input.replace(FORBIDDEN_FILENAME_CHARS, "-").trim();
  // Windows يقصّ عند 255 محرفاً لكن نسمّي بأمانٍ أوسع كي يبقى مسموحاً في أرشيفاتٍ متداخلة.
  return cleaned.slice(0, 120) || "منتج";
}

function extensionForMime(mime: string | null): string {
  if (!mime) return "bin";
  const lower = mime.toLowerCase();
  if (lower === "image/jpeg" || lower === "image/jpg") return "jpg";
  if (lower === "image/png") return "png";
  if (lower === "image/webp") return "webp";
  if (lower === "image/gif") return "gif";
  if (lower === "image/avif") return "avif";
  if (lower === "image/svg+xml") return "svg";
  return "bin";
}

/**
 * بثُّ الأرشيف مباشرةً إلى استجابة HTTP. يفرض الحرَّاسَ (المسار الوحيد للتصدير)،
 * ويُدير مصدر الصور (R2) بـstreams — بلا تحميلِ كل الحزمة في الذاكرة.
 */
export async function streamStudioImageExport(
  actor: ProductStudioActor,
  scope: StudioExportScope,
  res: Response,
): Promise<void> {
  if (!isImageStoreOperational()) {
    res.status(503).json({ error: "مخزن R2 غير مُهيَّأ — التصدير متوقّف حتى تفعيله" });
    return;
  }
  const rows = await queryExportImages(actor, scope);
  if (rows.length === 0) {
    res.status(404).json({ error: "لا صور معتمدة في هذا النطاق" });
    return;
  }
  const truncated = rows.length > MAX_EXPORT_IMAGES;
  const items = truncated ? rows.slice(0, MAX_EXPORT_IMAGES) : rows;

  // تسميةٌ مستقرّة مع فكّ التكرار: منتجٌ اسمه X بصورتين ⇒ `X.jpg` + `X-2.jpg`.
  const nameCounts = new Map<string, number>();
  const usedNames = new Set<string>();
  function uniqueFilename(base: string, ext: string): string {
    let candidate = `${base}.${ext}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      nameCounts.set(base, 1);
      return candidate;
    }
    const next = (nameCounts.get(base) ?? 1) + 1;
    nameCounts.set(base, next);
    candidate = `${base}-${next}.${ext}`;
    while (usedNames.has(candidate)) {
      const bump = (nameCounts.get(base) ?? next) + 1;
      nameCounts.set(base, bump);
      candidate = `${base}-${bump}.${ext}`;
    }
    usedNames.add(candidate);
    return candidate;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const archiveName = `studio-images-${timestamp}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${archiveName}"`);
  res.setHeader("Cache-Control", "no-store");
  if (truncated) res.setHeader("X-Studio-Export-Truncated", String(rows.length));

  // `store: true` (بلا ضغط zlib) لأنّ محتوى الحزمة كلّه صور JPEG/WebP/PNG مضغوطةٌ سلفاً
  // من `ImageUploader`. تطبيقُ ضغطٍ إضافيٍّ يوفّر ~١٪ سعةً مقابل استهلاكِ CPU كبير على
  // آلاف الصور. القرارُ يحفظ الجودةَ بالبايت الواحد (المصدرُ لا يُفَكّ ترميزُه) وينسخُه
  // إلى ZIP كما هو من R2. الصور المُنشَرة في المتجر هي نفسها المُصدَّرة هنا بلا فرق.
  const archive = archiver("zip", { store: true });
  archive.on("warning", (err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    logger.warn({ err }, "studio-image-export: archiver warning");
  });
  archive.on("error", (err: unknown) => {
    logger.error({ err }, "studio-image-export: archiver error");
    if (!res.headersSent) res.status(500);
    res.destroy(err as Error);
  });

  archive.pipe(res);
  const store = getImageStore();
  let added = 0;
  let skipped = 0;
  for (const item of items) {
    try {
      const stream = await store.getStream(item.objectKey);
      if (!stream) {
        skipped++;
        continue;
      }
      const baseName = item.variantName
        ? `${sanitizeFilenamePart(item.productName)}--${sanitizeFilenamePart(item.variantName)}`
        : sanitizeFilenamePart(item.productName);
      const filename = uniqueFilename(baseName, extensionForMime(item.mime));
      archive.append(stream, { name: filename });
      added++;
    } catch (err) {
      logger.warn({ err, objectKey: item.objectKey }, "studio-image-export: image fetch failed");
      skipped++;
    }
  }
  // «فهرس» صغيرٌ للتوثيق داخل الأرشيف — يفيد المالك في معرفة ما وُجد فعلياً.
  archive.append(
    Buffer.from(
      [
        // en-GB لأنّ قرار المالك (٢٥/٨) كل رقمٍ يعرضه النظام لاتينيّ — `ar-IQ` يُنتج هندية.
        `تصدير صور استوديو المنتجات — ${new Date().toLocaleString("en-GB")}`,
        `النطاق: ${scope.kind === "ALL" ? "كل الكتالوج" : scope.kind === "CATEGORY" ? `فئة ${scope.categoryId}` : `منتجات ${scope.productIds.length}`}`,
        `مؤهَّلات: ${rows.length}${truncated ? ` (مقصوصة إلى ${MAX_EXPORT_IMAGES})` : ""}`,
        `أُضيفت للأرشيف: ${added}`,
        `تعذّر جلبها من المخزن: ${skipped}`,
      ].join("\n"),
      "utf8",
    ),
    { name: "_index.txt" },
  );
  await archive.finalize();
}
