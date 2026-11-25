import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { storeBannerDailyMetrics, storeBanners } from "../../../drizzle/schema";
import { getDb } from "../../db";

export type BannerMetricEvent = "IMPRESSION" | "CLICK";
export type BannerMetricPlacement = "HERO" | "SIDE" | "INLINE";

function todayYmdBaghdad(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function offsetYmdBaghdad(offsetDays: number): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** عداد مجمّع: لا يكتب IP أو هوية أو سجل تصفح فردي. */
export async function recordBannerMetric(input: {
  bannerId: number;
  placement: BannerMetricPlacement;
  event: BannerMetricEvent;
}): Promise<{ ok: true }> {
  const db = getDb();
  if (!db) return { ok: true };
  const today = todayYmdBaghdad();
  const [active] = await db
    .select({ id: storeBanners.id, placement: storeBanners.placement })
    .from(storeBanners)
    .where(and(
      eq(storeBanners.id, input.bannerId),
      eq(storeBanners.isActive, true),
      or(eq(storeBanners.placement, input.placement), eq(storeBanners.placement, "SIDE"))!,
      or(isNull(storeBanners.effectiveFrom), sql`${storeBanners.effectiveFrom} <= ${today}`)!,
      or(isNull(storeBanners.effectiveTo), sql`${storeBanners.effectiveTo} >= ${today}`)!,
    ))
    .limit(1);
  if (!active) return { ok: true };
  const impressions = input.event === "IMPRESSION" ? 1 : 0;
  const clicks = input.event === "CLICK" ? 1 : 0;
  await db.execute(sql`
    INSERT INTO storeBannerDailyMetrics (bannerId, metricDate, placement, impressions, clicks)
    VALUES (${input.bannerId}, ${today}, ${input.placement}, ${impressions}, ${clicks})
    ON DUPLICATE KEY UPDATE impressions = impressions + ${impressions}, clicks = clicks + ${clicks}
  `);
  return { ok: true };
}

export interface BannerMetricRowSummary {
  bannerId: number;
  impressions: number;
  clicks: number;
  /** نسبة النقر إلى الظهور (0..1). */
  ctr: number;
}

export interface BannerMetricsSummary {
  days: number;
  fromYmd: string;
  toYmd: string;
  totalImpressions: number;
  totalClicks: number;
  overallCtr: number;
  byBanner: BannerMetricRowSummary[];
}

/** قراءة مجمّعة لأداء البنرات خلال آخر N يوماً (بحبيبة يوم بغداد). */
export async function getBannerMetricsSummary(input?: { days?: number }): Promise<BannerMetricsSummary> {
  const days = Math.min(365, Math.max(1, Math.trunc(input?.days ?? 30)));
  const toYmd = todayYmdBaghdad();
  const fromYmd = offsetYmdBaghdad(-(days - 1));
  const db = getDb();
  if (!db) {
    return { days, fromYmd, toYmd, totalImpressions: 0, totalClicks: 0, overallCtr: 0, byBanner: [] };
  }

  const rows = await db
    .select({
      bannerId: storeBannerDailyMetrics.bannerId,
      impressions: sql<number>`COALESCE(SUM(${storeBannerDailyMetrics.impressions}), 0)`,
      clicks: sql<number>`COALESCE(SUM(${storeBannerDailyMetrics.clicks}), 0)`,
    })
    .from(storeBannerDailyMetrics)
    .where(
      and(
        gte(storeBannerDailyMetrics.metricDate, fromYmd),
        lte(storeBannerDailyMetrics.metricDate, toYmd),
      ),
    )
    .groupBy(storeBannerDailyMetrics.bannerId);

  let totalImpressions = 0;
  let totalClicks = 0;
  const byBanner: BannerMetricRowSummary[] = rows.map((r) => {
    const impressions = Number(r.impressions ?? 0);
    const clicks = Number(r.clicks ?? 0);
    totalImpressions += impressions;
    totalClicks += clicks;
    return {
      bannerId: Number(r.bannerId),
      impressions,
      clicks,
      ctr: impressions > 0 ? clicks / impressions : 0,
    };
  });
  byBanner.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || b.bannerId - a.bannerId);

  return {
    days,
    fromYmd,
    toYmd,
    totalImpressions,
    totalClicks,
    overallCtr: totalImpressions > 0 ? totalClicks / totalImpressions : 0,
    byBanner,
  };
}
