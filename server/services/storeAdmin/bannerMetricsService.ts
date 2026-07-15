import { and, eq, isNull, or, sql } from "drizzle-orm";
import { storeBanners } from "../../../drizzle/schema";
import { getDb } from "../../db";

export type BannerMetricEvent = "IMPRESSION" | "CLICK";
export type BannerMetricPlacement = "HERO" | "SIDE" | "INLINE";

function todayYmdBaghdad(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
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
      eq(storeBanners.placement, input.placement),
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
