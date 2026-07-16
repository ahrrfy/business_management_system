/**
 * bannerService — بنرات المتجر الترويجية (يديرها الموظف من لوحة hPanel).
 * القراءة العلنية (listActiveBanners) آمنة: حقول عرض فقط، ضمن النافذة الزمنية + الفرع + مفعّلة.
 * مستقلّة عن بنرات «عروض اليوم» المشتقّة من promotions (تُعرَض بجانبها في المتجر).
 */
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { storeBanners } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { withTx } from "../tx";
import { resolveStorefrontBranchId } from "../storefrontService";
import { normalizeInternalBannerUrl } from "../../lib/bannerSafety";

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
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}

function normalizeImages(input: Partial<BannerInput>): BannerImageInput[] {
  if (input.images?.length) return input.images.map((image, index) => ({ ...image, isActive: image.isActive ?? true, sortOrder: image.sortOrder ?? index }));
  return input.imageUrl ? [{ url: input.imageUrl, isActive: true, sortOrder: 0 }] : [];
}

/** كل البنرات (لوحة الإدارة) — مرتّبة بالترتيب ثم الأحدث. */
export async function listBanners() {
  const db = getDb();
  if (!db) return [];
  return db.select().from(storeBanners).orderBy(asc(storeBanners.sortOrder), desc(storeBanners.id));
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
  return rows.flatMap((r) => {
    const images = activeBannerImages(r.images, today);
    // ⚠️ انحدار #203: كان `sources = images.length ? images : (r.imageUrl ? [...] : [])` ⇒ بنرٌ
    // بلا صور **وبلا** imageUrl يُنتج صفراً من الصفوف فيختفي من المتجر بصمت (كان قبلها يُعرض
    // بعنوانه/زرّه). نفرّق بين حالتين مختلفتين جوهرياً:
    //   • له صور مُهيّأة لكن لا فعّالة اليوم ⇒ **مُخفيّ بقرار الجدولة** (هذا هو معنى الجدولة).
    //   • بلا صور مُهيّأة أصلاً ⇒ بنر أحادي/بلا صورة ⇒ صفٌّ واحد بـimageUrl (أو null) — سلوك
    //     ما قبل #203 حرفياً. الواجهة تتعامل مع imageUrl=null أصلاً (النوع `string | null`).
    const hasConfiguredImages = Array.isArray(r.images) && r.images.length > 0;
    const sources: Array<{ url: string | null }> = images.length
      ? images
      : hasConfiguredImages
        ? []
        : [{ url: r.imageUrl ?? null }];
    return sources.map((image, imageIndex) => ({
    id: Number(r.id),
    title: r.title,
    subtitle: r.subtitle ?? null,
    imageUrl: image.url ?? null,
    mobileImageUrl: r.mobileImageUrl ?? null,
    renderMode: (r.renderMode as BannerRenderMode) ?? "PRESERVE_FULL",
    focusX: Math.min(100, Math.max(0, r.focusX ?? 50)),
    focusY: Math.min(100, Math.max(0, r.focusY ?? 50)),
    ctaLabel: r.ctaLabel ?? null,
    ctaUrl: normalizeInternalBannerUrl(r.ctaUrl),
    placement: (r.placement as BannerPlacement) ?? "HERO",
    imageIndex,
    }));
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
