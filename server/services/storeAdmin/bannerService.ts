/**
 * bannerService — بنرات المتجر الترويجية (يديرها الموظف من لوحة hPanel).
 * القراءة العلنية (listActiveBanners) آمنة: حقول عرض فقط، ضمن النافذة الزمنية + الفرع + مفعّلة.
 * مستقلّة عن بنرات «عروض اليوم» المشتقّة من promotions (تُعرَض بجانبها في المتجر).
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { promotions, storeBanners } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { withTx } from "../tx";
import { resolveStorefrontBranchId } from "../storefrontService";
import { normalizeInternalBannerUrl } from "../../lib/bannerSafety";
import { bannerImageUrl, decodeDataUrl } from "../../imageRoute";

function todayYmdBaghdad(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export type BannerPlacement = "HERO" | "SIDE" | "INLINE";
export type BannerRenderMode = "SMART_CROP" | "PRESERVE_FULL" | "LAYERED";

export interface BannerInput {
  title: string;
  subtitle?: string | null;
  imageUrl?: string | null;
  images?: BannerImageInput[];
  mobileImageUrl?: string | null;
  renderMode?: BannerRenderMode;
  focusX?: number;
  focusY?: number;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  sortOrder?: number;
  isActive?: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  branchId?: number | null;
  /** موضع العرض في المتجر — HERO (كاروسيل، الافتراضي) / SIDE (جانبي طولي) / INLINE (فاصل بين المنتجات). */
  placement?: BannerPlacement;
}

export interface BannerImageInput {
  url: string;
  mobileUrl?: string | null;
  title?: string | null;
  subtitle?: string | null;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}

function normalizeImages(input: Partial<BannerInput>): BannerImageInput[] {
  if (input.images?.length) {
    return input.images.map((image, index) => ({
      ...image,
      mobileUrl: image.mobileUrl || null,
      title: image.title?.trim() || null,
      subtitle: image.subtitle?.trim() || null,
      ctaLabel: image.ctaLabel?.trim() || null,
      ctaUrl: normalizeInternalBannerUrl(image.ctaUrl),
      isActive: image.isActive ?? true,
      sortOrder: image.sortOrder ?? index,
    }));
  }
  return input.imageUrl ? [{ url: input.imageUrl, isActive: true, sortOrder: 0 }] : [];
}

function extractLinkedPromoId(ctaUrl: string | null | undefined): number | null {
  if (!ctaUrl) return null;
  const match = ctaUrl.match(/[?&]promo=(\d+)\b/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function resolveLivePromoIds(promoIds: number[], today: string): Promise<Set<number>> {
  const db = getDb();
  const unique = Array.from(new Set(promoIds.filter((n) => n > 0)));
  if (!db || unique.length === 0) return new Set();
  const rows = await db
    .select({ id: promotions.id })
    .from(promotions)
    .where(
      and(
        inArray(promotions.id, unique),
        eq(promotions.isActive, true),
        sql`${promotions.effectiveFrom} <= DATE(${today})`,
        or(isNull(promotions.effectiveTo), sql`${promotions.effectiveTo} >= DATE(${today})`)!,
      ),
    );
  return new Set(rows.map((r) => Number(r.id)));
}

/** كل البنرات (لوحة الإدارة) — مرتّبة بالترتيب ثم الأحدث، مع كشف ارتباط البنر بعرض متوقف أو منتهٍ. */
export async function listBanners() {
  const db = getDb();
  if (!db) return [];
  const today = todayYmdBaghdad();
  const rows = await db.select().from(storeBanners).orderBy(asc(storeBanners.sortOrder), desc(storeBanners.id));
  const promoIds = rows
    .map((r) => extractLinkedPromoId(r.ctaUrl))
    .filter((id): id is number => id != null);
  const liveSet = await resolveLivePromoIds(promoIds, today);
  return rows.map((r) => {
    const linkedPromoId = extractLinkedPromoId(r.ctaUrl);
    return {
      ...r,
      linkedPromoInactive: linkedPromoId != null && !liveSet.has(linkedPromoId),
    };
  });
}

export interface PublicBanner {
  id: number;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  mobileImageUrl: string | null;
  renderMode: BannerRenderMode;
  focusX: number;
  focusY: number;
  ctaLabel: string | null;
  ctaUrl: string | null;
  placement: BannerPlacement;
  imageIndex?: number;
}

/**
 * يحوّل صورة البنر المخزَّنة إلى ما يُرسَل للمتجر. ثلاث حالات **متمايزة عمداً**:
 *   • data URL صورة صالحة ⇒ **رابط النقطة** (`/api/img/...`) — هذا هو التوفير.
 *   • قيمة ليست data URL (مسار/رابط خارجيّ من صفٍّ قديم أو مستورَد) ⇒ **تُمرَّر كما هي**:
 *     هي رابطٌ يعمل في المتصفّح أصلاً. تحويلها إلى null كان **انحداراً**: صورةٌ تختفي من
 *     المتجر بصمت (أمسكه اختبار #207 القائم — نفس صنف علّة #203 التي عالجناها اليوم).
 *   • `null` (بنر نصّي — قرار المالك) أو data URL **ليست صورةً صالحة** ⇒ `null`: الأخيرة نفايةٌ
 *     لا تُعرَض، وشحنها base64 داخل JSON يُبطل الغرض كلّه.
 */
function toPublicImage(bannerId: number, slot: string, value: string | null | undefined): string | null {
  if (!value) return null;
  const isDataUrl = /^data:/i.test(value.trim());
  if (!isDataUrl) return value;
  return decodeDataUrl(value) ? bannerImageUrl(bannerId, slot, value) : null;
}

function activeBannerImages(value: unknown, today: string): BannerImageInput[] {
  if (!Array.isArray(value)) return [];
  return value.filter((image): image is BannerImageInput => {
    if (!image || typeof image !== "object" || typeof (image as BannerImageInput).url !== "string") return false;
    const item = image as BannerImageInput;
    return item.isActive !== false && (!item.effectiveFrom || item.effectiveFrom <= today) && (!item.effectiveTo || item.effectiveTo >= today);
  }).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

/** البنرات الفعّالة للمتجر (علني، آمن): مفعّلة + ضمن النافذة الزمنية + الفرع — بكل المواضع،
 *  والعميل يوزّعها (HERO كاروسيل / SIDE جوانب / INLINE فواصل). السقف 24 يتّسع للمواضع الثلاثة. */
export async function listActiveBanners(branchIdInput?: number): Promise<PublicBanner[]> {
  const db = getDb();
  if (!db) return [];
  const branchId = await resolveStorefrontBranchId(branchIdInput);
  const today = todayYmdBaghdad();
  const rows = await db
    .select({
      id: storeBanners.id,
      title: storeBanners.title,
      subtitle: storeBanners.subtitle,
      imageUrl: storeBanners.imageUrl,
      images: storeBanners.images,
      mobileImageUrl: storeBanners.mobileImageUrl,
      renderMode: storeBanners.renderMode,
      focusX: storeBanners.focusX,
      focusY: storeBanners.focusY,
      ctaLabel: storeBanners.ctaLabel,
      ctaUrl: storeBanners.ctaUrl,
      placement: storeBanners.placement,
    })
    .from(storeBanners)
    .where(
      and(
        eq(storeBanners.isActive, true),
        or(isNull(storeBanners.effectiveFrom), sql`${storeBanners.effectiveFrom} <= ${today}`)!,
        or(isNull(storeBanners.effectiveTo), sql`${storeBanners.effectiveTo} >= ${today}`)!,
        or(isNull(storeBanners.branchId), eq(storeBanners.branchId, branchId))!
      )
    )
    .orderBy(asc(storeBanners.sortOrder), desc(storeBanners.id))
    .limit(24);
  const candidatePromoIds: number[] = [];
  for (const r of rows) {
    const rootPromo = extractLinkedPromoId(r.ctaUrl);
    if (rootPromo) candidatePromoIds.push(rootPromo);
    for (const img of activeBannerImages(r.images, today)) {
      const slidePromo = extractLinkedPromoId(img.ctaUrl);
      if (slidePromo) candidatePromoIds.push(slidePromo);
    }
  }
  const livePromoIds = await resolveLivePromoIds(candidatePromoIds, today);

  return rows.flatMap((r) => {
    const images = activeBannerImages(r.images, today);
    const sources: Array<Omit<Partial<BannerImageInput>, "url"> & { url: string | null }> = images.length
      ? images
      : [{ url: r.imageUrl ?? null }];
    return sources.flatMap((image, imageIndex) => {
      const resolvedCtaUrl = normalizeInternalBannerUrl(image.ctaUrl) ?? normalizeInternalBannerUrl(r.ctaUrl);
      const linkedPromoId = extractLinkedPromoId(resolvedCtaUrl);
      // أتمتة دورة الحياة: إذا كان البنر أو الشريحة يروّج لعرض ترويجي انتهى أو عُطّل، يُحجب آلياً من المتجر
      if (linkedPromoId != null && !livePromoIds.has(linkedPromoId)) {
        return [];
      }
      const resolvedMobile = image.mobileUrl
        ? toPublicImage(Number(r.id), `mobile-${imageIndex}`, image.mobileUrl)
        : sources.length === 1
          ? toPublicImage(Number(r.id), "mobile", r.mobileImageUrl)
          : null;
      return [{
        id: Number(r.id),
        title: image.title?.trim() || r.title,
        subtitle: image.subtitle?.trim() || r.subtitle || null,
        imageUrl: toPublicImage(Number(r.id), `main-${imageIndex}`, image.url),
        mobileImageUrl: resolvedMobile,
        renderMode: (r.renderMode as BannerRenderMode) ?? "PRESERVE_FULL",
        focusX: Math.min(100, Math.max(0, r.focusX ?? 50)),
        focusY: Math.min(100, Math.max(0, r.focusY ?? 50)),
        ctaLabel: image.ctaLabel?.trim() || r.ctaLabel || null,
        ctaUrl: resolvedCtaUrl,
        placement: (r.placement as BannerPlacement) ?? "HERO",
        imageIndex,
      }];
    });
  });
}

export async function createBanner(input: BannerInput, userId: number): Promise<{ id: number }> {
  return withTx(async (tx) => {
    const res = await tx.insert(storeBanners).values({
      title: input.title.trim(),
      subtitle: input.subtitle ?? null,
      imageUrl: input.imageUrl ?? null,
      images: normalizeImages(input),
      mobileImageUrl: input.mobileImageUrl ?? null,
      renderMode: input.renderMode ?? "PRESERVE_FULL",
      focusX: input.focusX ?? 50,
      focusY: input.focusY ?? 50,
      ctaLabel: input.ctaLabel ?? null,
      ctaUrl: normalizeInternalBannerUrl(input.ctaUrl),
      sortOrder: input.sortOrder ?? 0,
      isActive: input.isActive ?? true,
      effectiveFrom: input.effectiveFrom || null,
      effectiveTo: input.effectiveTo || null,
      branchId: input.branchId ?? null,
      placement: input.placement ?? "HERO",
      createdBy: userId,
    });
    return { id: extractInsertId(res) };
  });
}

export async function updateBanner(id: number, input: Partial<BannerInput>): Promise<{ id: number }> {
  return withTx(async (tx) => {
    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) patch.title = input.title.trim();
    if (input.subtitle !== undefined) patch.subtitle = input.subtitle ?? null;
    if (input.imageUrl !== undefined) patch.imageUrl = input.imageUrl ?? null;
    if (input.images !== undefined) patch.images = normalizeImages(input);
    if (input.mobileImageUrl !== undefined) patch.mobileImageUrl = input.mobileImageUrl ?? null;
    if (input.renderMode !== undefined) patch.renderMode = input.renderMode;
    if (input.focusX !== undefined) patch.focusX = input.focusX;
    if (input.focusY !== undefined) patch.focusY = input.focusY;
    if (input.ctaLabel !== undefined) patch.ctaLabel = input.ctaLabel ?? null;
    if (input.ctaUrl !== undefined) patch.ctaUrl = normalizeInternalBannerUrl(input.ctaUrl);
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    if (input.effectiveFrom !== undefined) patch.effectiveFrom = input.effectiveFrom || null;
    if (input.effectiveTo !== undefined) patch.effectiveTo = input.effectiveTo || null;
    if (input.branchId !== undefined) patch.branchId = input.branchId ?? null;
    if (input.placement !== undefined) patch.placement = input.placement;
    if (Object.keys(patch).length) await tx.update(storeBanners).set(patch).where(eq(storeBanners.id, id));
    return { id };
  });
}

export async function deleteBanner(id: number): Promise<{ id: number }> {
  return withTx(async (tx) => {
    await tx.delete(storeBanners).where(eq(storeBanners.id, id));
    return { id };
  });
}
