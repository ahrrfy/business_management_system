import { priceTierLabel } from "@/lib/labels";

export interface PriceHistoryRecordLike {
  oldPrice: string | number | null;
  newPrice: string | number;
  priceTier: string;
  reason?: string | null;
  waveId?: number | null;
  waveName?: string | null;
  actorUserId: number;
  actorName?: string | null;
}

const PRICE_FORMAT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function formatHistoryPrice(value: string | number | null): string {
  if (value == null || value === "") return "—";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? PRICE_FORMAT.format(parsed) : "—";
}

export function toPriceHistoryDisplay(row: PriceHistoryRecordLike) {
  const waveName = row.waveName?.trim();
  const reason = row.reason?.trim();
  return {
    oldPrice: formatHistoryPrice(row.oldPrice),
    newPrice: formatHistoryPrice(row.newPrice),
    tier: priceTierLabel(row.priceTier),
    actor: row.actorName?.trim() || `مستخدم #${row.actorUserId}`,
    source: waveName || (row.waveId != null ? `موجة #${row.waveId}` : "تعديل مباشر"),
    reason: reason || "—",
  };
}
