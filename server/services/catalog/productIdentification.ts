import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { productImages } from "../../../drizzle/schema";
import type { DB } from "../../db";
import {
  countProductImageUrl,
  inventoryProductImageUrl,
} from "../../imageRoute";

export type ProductIdentificationSubject = {
  productId: number;
  variantId: number;
};

export type ProductIdentificationAudience =
  | { kind: "inventory" }
  | { kind: "stocktake"; sessionCode: string };

type IdentificationImageRow = {
  id: number;
  productId: number;
  variantId: number | null;
  url: string;
  objectKey: string | null;
  contentHash: string | null;
};

function imageUrlFor(
  row: IdentificationImageRow,
  audience: ProductIdentificationAudience,
): string | null {
  // مسار/رابط إرثيّ ليس base64 يبقى مورداً مستقلاً كما هو؛ أمّا المحتوى المخزّن في DB/R2
  // فيمرّ حتماً عبر نقطة خاصة مصادَق عليها وبصمة immutable.
  if (!row.objectKey && !/^data:/i.test(row.url.trim())) return row.url;
  const source = {
    url: row.url,
    objectKey: row.objectKey,
    contentHash: row.contentHash,
  };
  return audience.kind === "inventory"
    ? inventoryProductImageUrl(row.id, source)
    : countProductImageUrl(audience.sessionCode, row.id, source);
}

/**
 * يختار صورة تعريف واحدة لكل متغيّر بجولة DB واحدة: صورة المتغيّر أولاً، ثم صورة المنتج.
 * الصفوف مرتبة (رئيسية ← sortOrder ← id) والروابط فقط هي ما يدخل JSON؛ الصورة نفسها تُجلب
 * عند فتح بطاقة التحقق، لذلك يبقى كتالوج الجرد بآلاف المواد خفيفاً.
 */
export async function loadProductIdentificationImages(
  db: DB,
  subjects: readonly ProductIdentificationSubject[],
  audience: ProductIdentificationAudience,
): Promise<Map<number, string | null>> {
  const result = new Map<number, string | null>();
  if (subjects.length === 0) return result;

  const productIds = Array.from(
    new Set(subjects.map((subject) => Number(subject.productId))),
  );
  const rows = await db
    .select({
      id: productImages.id,
      productId: productImages.productId,
      variantId: productImages.variantId,
      url: productImages.url,
      objectKey: productImages.objectKey,
      contentHash: productImages.contentHash,
    })
    .from(productImages)
    .where(
      and(
        inArray(productImages.productId, productIds),
        eq(productImages.reviewStatus, "APPROVED"),
      ),
    )
    .orderBy(
      desc(productImages.isPrimary),
      asc(productImages.sortOrder),
      asc(productImages.id),
    );

  const byVariant = new Map<number, string>();
  const byProduct = new Map<number, string>();
  for (const raw of rows) {
    const row: IdentificationImageRow = {
      id: Number(raw.id),
      productId: Number(raw.productId),
      variantId: raw.variantId == null ? null : Number(raw.variantId),
      url: raw.url,
      objectKey: raw.objectKey,
      contentHash: raw.contentHash,
    };
    const url = imageUrlFor(row, audience);
    if (!url) continue;
    if (row.variantId != null) {
      if (!byVariant.has(row.variantId)) byVariant.set(row.variantId, url);
    } else if (!byProduct.has(row.productId)) {
      byProduct.set(row.productId, url);
    }
  }

  for (const subject of subjects) {
    result.set(
      Number(subject.variantId),
      byVariant.get(Number(subject.variantId)) ??
        byProduct.get(Number(subject.productId)) ??
        null,
    );
  }
  return result;
}
