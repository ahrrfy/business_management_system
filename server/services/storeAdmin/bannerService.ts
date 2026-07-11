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

function todayYmdBaghdad(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export interface BannerInput {
  title: string;
  subtitle?: string | null;
  imageUrl?: string | null;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  sortOrder?: number;
  isActive?: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  branchId?: number | null;
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
  ctaLabel: string | null;
  ctaUrl: string | null;
}

/** البنرات الفعّالة للمتجر (علني، آمن): مفعّلة + ضمن النافذة الزمنية + الفرع. */
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
      ctaLabel: storeBanners.ctaLabel,
      ctaUrl: storeBanners.ctaUrl,
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
    .limit(12);
  return rows.map((r) => ({
    id: Number(r.id),
    title: r.title,
    subtitle: r.subtitle ?? null,
    imageUrl: r.imageUrl ?? null,
    ctaLabel: r.ctaLabel ?? null,
    ctaUrl: r.ctaUrl ?? null,
  }));
}

export async function createBanner(input: BannerInput, userId: number): Promise<{ id: number }> {
  return withTx(async (tx) => {
    const res = await tx.insert(storeBanners).values({
      title: input.title.trim(),
      subtitle: input.subtitle ?? null,
      imageUrl: input.imageUrl ?? null,
      ctaLabel: input.ctaLabel ?? null,
      ctaUrl: input.ctaUrl ?? null,
      sortOrder: input.sortOrder ?? 0,
      isActive: input.isActive ?? true,
      effectiveFrom: input.effectiveFrom || null,
      effectiveTo: input.effectiveTo || null,
      branchId: input.branchId ?? null,
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
    if (input.ctaLabel !== undefined) patch.ctaLabel = input.ctaLabel ?? null;
    if (input.ctaUrl !== undefined) patch.ctaUrl = input.ctaUrl ?? null;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    if (input.effectiveFrom !== undefined) patch.effectiveFrom = input.effectiveFrom || null;
    if (input.effectiveTo !== undefined) patch.effectiveTo = input.effectiveTo || null;
    if (input.branchId !== undefined) patch.branchId = input.branchId ?? null;
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
