import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  onlineOrderItems,
  onlineOrders,
  storefrontCustomizationAssets,
  storefrontQuoteRequests,
  type StorefrontCustomizationAsset,
} from "../../drizzle/schema";
import {
  contentHash,
  customizerObjectPrefix,
  extForMime,
  getImageStore,
  isCurrentTenantCustomizerKey,
  isImageStoreOperational,
  isImageStoreUnavailableError,
} from "../lib/imageStore";
import { parseImageDimensions } from "../lib/imageValidation";
import { splitQuoteCustomerNoteAndAssets } from "../lib/quoteRequestCustomizationMeta";
import { requireDb } from "./tx";

export const MAX_CUSTOMIZATION_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_CUSTOMIZATION_BASE64_CHARS = 2_800_000;
const MAX_CUSTOMIZATION_IMAGE_DIMENSION = 4096;
const ORPHAN_ASSET_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_CUSTOMIZATION_ORPHAN_WINDOW_MAX = 120;

const STRICT_BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type CustomizationAssetKind = "LOGO" | "PREVIEW";
export type CustomizationAssetMime = "image/png" | "image/jpeg" | "image/webp";

export type UploadCustomizationAssetInput = {
  kind: CustomizationAssetKind;
  mimeType: CustomizationAssetMime;
  dataBase64: string;
};

export type UploadedCustomizationAssetResult = {
  assetKey: string;
  sha256: string;
  mimeType: CustomizationAssetMime;
  byteLength: number;
};

function badAsset(why: string, doThis: string): never {
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: appErrorMessage({
      what: "تعذّر قبول مرفق التخصيص",
      why,
      doThis,
    }),
  });
}

function decodeStrictCustomizationBase64(raw: string): Buffer {
  const cleaned = raw.trim();
  if (
    !cleaned ||
    cleaned.length > MAX_CUSTOMIZATION_BASE64_CHARS ||
    cleaned.length % 4 !== 0 ||
    !STRICT_BASE64_RE.test(cleaned)
  ) {
    badAsset(
      "ترميز ملف الصورة غير صالح",
      "ارفع ملف صورة بصيغة PNG أو JPEG أو WebP مباشرة من جهازك",
    );
  }
  const bytes = Buffer.from(cleaned, "base64");
  if (!bytes.length || bytes.toString("base64") !== cleaned) {
    badAsset(
      "بيانات ملف الصورة تالفة أو غير مكتملة",
      "أعد اختيار الصورة وحاول الرفع مرّة أخرى",
    );
  }
  if (bytes.length > MAX_CUSTOMIZATION_ASSET_BYTES) {
    badAsset(
      "حجم الصورة يتجاوز الحدّ الأقصى المسموح (2 ميجابايت)",
      "اختر صورة بحجم لا يتجاوز 2 ميجابايت ثم أعد المحاولة",
    );
  }
  return bytes;
}

function matchesDeclaredMagicBytes(bytes: Buffer, mimeType: CustomizationAssetMime): boolean {
  if (mimeType === "image/png") {
    return (
      bytes.length >= 24 &&
      bytes.subarray(0, 8).equals(PNG_MAGIC) &&
      bytes.readUInt32BE(8) === 13 &&
      bytes.toString("ascii", 12, 16) === "IHDR"
    );
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/webp") {
    return (
      bytes.length >= 16 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  return false;
}

export async function uploadStorefrontCustomizationAsset(
  input: UploadCustomizationAssetInput,
): Promise<UploadedCustomizationAssetResult> {
  const bytes = decodeStrictCustomizationBase64(input.dataBase64);

  if (!matchesDeclaredMagicBytes(bytes, input.mimeType)) {
    badAsset(
      "الترويسة الثنائية للملف لا تطابق صيغة الصورة المعلنة",
      "استخدم صورة حقيقية بصيغة PNG أو JPEG أو WebP فقط (ملفات SVG أو الملفات المتنكّرة غير مسموحة)",
    );
  }

  const dims = parseImageDimensions(bytes, input.mimeType);
  if (!dims || dims.width <= 0 || dims.height <= 0) {
    badAsset(
      "بنية إطار الصورة غير مكتملة أو تالفة",
      "استخدم صورة حقيقية صالحة بصيغة PNG أو JPEG أو WebP فقط",
    );
  }
  if (
    dims.width > MAX_CUSTOMIZATION_IMAGE_DIMENSION ||
    dims.height > MAX_CUSTOMIZATION_IMAGE_DIMENSION
  ) {
    badAsset(
      `أبعاد الصورة تتجاوز الحدّ الأقصى المسموح (${MAX_CUSTOMIZATION_IMAGE_DIMENSION} بكسل)`,
      "صغّر أبعاد الصورة إلى 4096×4096 بكسل أو أقل ثم أعد المحاولة",
    );
  }

  const sha256 = contentHash(bytes);
  const folder = input.kind === "LOGO" ? "logo" : "preview";
  const assetKey = `${customizerObjectPrefix(folder)}/${sha256}.${extForMime(input.mimeType)}`;
  if (!isCurrentTenantCustomizerKey(assetKey)) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: appErrorMessage({
        what: "تعذّر حفظ مرفق التخصيص",
        why: "فشل التحقق من نطاق تخزين المرفق",
        doThis: "أعد المحاولة بعد قليل",
      }),
    });
  }

  if (!isImageStoreOperational()) {
    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: appErrorMessage({
        what: "خدمة رفع المرفقات غير متاحة مؤقتاً",
        why: "مخزن الملفات الآمن غير مهيّأ حالياً لاستقبال المرفقات",
        doThis: "انتظر لحظات ثم أعد رفع الشعار أو تواصل مع إدارة المتجر",
      }),
    });
  }

  const db = requireDb();
  const [existingAsset] = await db
    .select({ id: storefrontCustomizationAssets.id })
    .from(storefrontCustomizationAssets)
    .where(eq(storefrontCustomizationAssets.assetKey, assetKey))
    .limit(1);

  if (!existingAsset) {
    const orphanWindowMax = Number(
      process.env.STOREFRONT_CUSTOMIZATION_ORPHAN_WINDOW_MAX ??
        DEFAULT_CUSTOMIZATION_ORPHAN_WINDOW_MAX,
    );
    if (Number.isFinite(orphanWindowMax) && orphanWindowMax > 0) {
      const [recentOrphans] = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(storefrontCustomizationAssets)
        .where(
          and(
            isNotNull(storefrontCustomizationAssets.expiresAt),
            sql`${storefrontCustomizationAssets.createdAt} >= DATE_SUB(NOW(), INTERVAL 15 MINUTE)`,
          ),
        );
      if (Number(recentOrphans?.count ?? 0) >= orphanWindowMax) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: appErrorMessage({
            what: "تعذّر رفع مرفق التخصيص حالياً",
            why: "تم تجاوز الحدّ المؤقت للمرفقات قيد الإعداد غير المربوطة بطلب",
            doThis: "انتظر بضع دقائق أو أكمل إرسال طلبك الحالي ثم أعد المحاولة",
          }),
        });
      }
    }
  }

  try {
    await getImageStore().put(assetKey, bytes, input.mimeType);
  } catch (error) {
    if (isImageStoreUnavailableError(error)) {
      throw new TRPCError({
        code: "SERVICE_UNAVAILABLE",
        message: appErrorMessage({
          what: "خدمة رفع المرفقات غير متاحة مؤقتاً",
          why: "تعثّر الاتصال بمخزن الملفات الآمن",
          doThis: "انتظر لحظات ثم أعد رفع الشعار",
        }),
      });
    }
    throw error;
  }

  const expiresAt = new Date(Date.now() + ORPHAN_ASSET_TTL_MS);
  await db
    .insert(storefrontCustomizationAssets)
    .values({
      assetKey,
      sha256,
      mimeType: input.mimeType,
      byteLength: bytes.length,
      kind: input.kind,
      expiresAt,
    })
    .onDuplicateKeyUpdate({
      set: {
        expiresAt: sql`IF(${storefrontCustomizationAssets.expiresAt} IS NULL, NULL, VALUES(expiresAt))`,
      },
    });

  return {
    assetKey,
    sha256,
    mimeType: input.mimeType,
    byteLength: bytes.length,
  };
}

export async function findStorefrontCustomizationAssetForStaff(
  identifier: string,
  options?: {
    scopedBranchId?: number | null;
    allowOrderAssets?: boolean;
    allowQuoteAssets?: boolean;
  },
): Promise<StorefrontCustomizationAsset | null> {
  const trimmed = identifier.trim();
  if (!trimmed || trimmed.length > 255) return null;
  const allowOrderAssets = options?.allowOrderAssets ?? true;
  const allowQuoteAssets = options?.allowQuoteAssets ?? true;
  if (!allowOrderAssets && !allowQuoteAssets) return null;

  const db = requireDb();
  let row: StorefrontCustomizationAsset | undefined;

  if (/^\d+$/.test(trimmed)) {
    const numericId = Number(trimmed);
    if (!Number.isSafeInteger(numericId) || numericId <= 0) return null;
    [row] = await db
      .select()
      .from(storefrontCustomizationAssets)
      .where(
        and(
          eq(storefrontCustomizationAssets.id, numericId),
          isNull(storefrontCustomizationAssets.expiresAt),
        ),
      )
      .limit(1);
  } else {
    if (!isCurrentTenantCustomizerKey(trimmed)) return null;
    [row] = await db
      .select()
      .from(storefrontCustomizationAssets)
      .where(
        and(
          eq(storefrontCustomizationAssets.assetKey, trimmed),
          isNull(storefrontCustomizationAssets.expiresAt),
        ),
      )
      .limit(1);
  }

  if (!row || !isCurrentTenantCustomizerKey(row.assetKey)) {
    return null;
  }

  const scopedBranchId = options?.scopedBranchId ?? null;
  if (allowOrderAssets) {
    const attachedConditions = [
      sql`(
        JSON_UNQUOTE(JSON_EXTRACT(${onlineOrderItems.customizationSnapshot}, '$.logoAssetKey')) = ${row.assetKey}
        OR JSON_UNQUOTE(JSON_EXTRACT(${onlineOrderItems.customizationSnapshot}, '$.previewAssetKey')) = ${row.assetKey}
      )`,
    ];
    if (scopedBranchId != null) {
      attachedConditions.push(eq(onlineOrders.branchId, scopedBranchId));
    }

    const [attachedOrder] = await db
      .select({ id: onlineOrders.id })
      .from(onlineOrderItems)
      .innerJoin(onlineOrders, eq(onlineOrders.id, onlineOrderItems.onlineOrderId))
      .where(and(...attachedConditions))
      .limit(1);

    if (attachedOrder) {
      return row;
    }
  }

  if (allowQuoteAssets) {
    const escapedKey = row.assetKey.replace(/[\\%_]/g, "\\$&");
    const quoteConditions = [
      sql`${storefrontQuoteRequests.customerNote} LIKE ${"%---SRQ_CUSTOM_ASSETS_V1---%"}`,
      sql`${storefrontQuoteRequests.customerNote} LIKE ${`%${escapedKey}%`} ESCAPE '\\\\'`,
    ];
    if (scopedBranchId != null) {
      quoteConditions.push(eq(storefrontQuoteRequests.branchId, scopedBranchId));
    }
    const candidateQuotes = await db
      .select({
        id: storefrontQuoteRequests.id,
        customerNote: storefrontQuoteRequests.customerNote,
      })
      .from(storefrontQuoteRequests)
      .where(and(...quoteConditions))
      .limit(25);

    const attachedToQuote = candidateQuotes.some((q) =>
      splitQuoteCustomerNoteAndAssets(q.customerNote).attachments.some(
        (att) =>
          att.logoAssetKey === row.assetKey ||
          att.previewAssetKey === row.assetKey,
      ),
    );
    if (attachedToQuote) {
      return row;
    }
  }

  return null;
}
