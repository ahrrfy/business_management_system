export interface ReservationConversionLineSnapshot {
  variantId: number;
  productName?: string | null;
  baseQuantity: number;
  fulfilledBase: number;
  currentOnHandBase: number;
  currentAvailableBase: number;
}

export interface ReservationConversionSnapshot {
  status: string;
  expiresAt?: Date | string | null;
  lines: ReservationConversionLineSnapshot[];
}

export type ReservationAvailabilitySnapshot = Record<string, number>;

export interface ReservationAvailabilityDrop {
  variantId: number;
  productName: string;
  previousAvailableBase: number;
  currentAvailableBase: number;
}

export interface ReservationStockShortage {
  variantId: number;
  productName: string;
  remainingBase: number;
  currentOnHandBase: number;
}

const CONVERTIBLE_STATUSES = new Set(["ACTIVE", "PARTIALLY_FULFILLED"]);

function availabilityByVariant(detail: ReservationConversionSnapshot) {
  const rows = new Map<number, { productName: string; currentAvailableBase: number }>();
  for (const line of detail.lines) {
    if (!rows.has(line.variantId)) {
      rows.set(line.variantId, {
        productName: line.productName?.trim() || `الصنف #${line.variantId}`,
        currentAvailableBase: Number(line.currentAvailableBase),
      });
    }
  }
  return rows;
}

/** لقطة ATP عند فتح الحوار؛ لا تُستعمل لمنع صاحب الحجز، بل لاكتشاف الانخفاض وعرضه له. */
export function captureReservationAvailability(
  detail: ReservationConversionSnapshot,
): ReservationAvailabilitySnapshot {
  const snapshot: ReservationAvailabilitySnapshot = {};
  for (const [variantId, row] of Array.from(availabilityByVariant(detail).entries())) {
    snapshot[String(variantId)] = row.currentAvailableBase;
  }
  return snapshot;
}

/** انخفاض ATP استشاري: الحجز الحالي يظل ذا أولوية ما دام الرصيد الفعلي يغطي كميته المتبقية. */
export function findReservationAvailabilityDrops(
  initial: ReservationAvailabilitySnapshot | null,
  detail: ReservationConversionSnapshot,
): ReservationAvailabilityDrop[] {
  if (!initial) return [];
  const drops: ReservationAvailabilityDrop[] = [];
  for (const [variantId, row] of Array.from(availabilityByVariant(detail).entries())) {
    const previous = initial[String(variantId)];
    if (previous != null && row.currentAvailableBase < previous) {
      drops.push({
        variantId,
        productName: row.productName,
        previousAvailableBase: previous,
        currentAvailableBase: row.currentAvailableBase,
      });
    }
  }
  return drops;
}

/** الحارس الصارم الوحيد: الرصيد الفعلي، لا ATP الذي يشمل حجوزات عملاء آخرين. */
export function findReservationStockShortages(
  detail: ReservationConversionSnapshot,
): ReservationStockShortage[] {
  const grouped = new Map<number, { productName: string; remainingBase: number; currentOnHandBase: number }>();
  for (const line of detail.lines) {
    const remainingBase = Math.max(0, Number(line.baseQuantity) - Number(line.fulfilledBase));
    const current = grouped.get(line.variantId);
    if (current) {
      current.remainingBase += remainingBase;
    } else {
      grouped.set(line.variantId, {
        productName: line.productName?.trim() || `الصنف #${line.variantId}`,
        remainingBase,
        currentOnHandBase: Number(line.currentOnHandBase),
      });
    }
  }
  return Array.from(grouped.entries())
    .filter(([, row]) => row.remainingBase > row.currentOnHandBase)
    .map(([variantId, row]) => ({ variantId, ...row }));
}

export function reservationConversionClosedMessage(
  detail: Pick<ReservationConversionSnapshot, "status" | "expiresAt">,
  nowMs = Date.now(),
): string | null {
  const expiresAtMs = detail.expiresAt == null ? Number.POSITIVE_INFINITY : new Date(detail.expiresAt).getTime();
  if (detail.status === "EXPIRED" || (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs)) {
    return "انتهت مدّة الحجز أثناء فتح الحوار؛ أُغلق التحويل ولم تُنشأ فاتورة.";
  }
  if (!CONVERTIBLE_STATUSES.has(detail.status)) {
    return "تغيّرت حالة الحجز أثناء فتح الحوار؛ أُغلق التحويل. حدّث القائمة وراجع الحجز.";
  }
  return null;
}

export function reservationConversionErrorClosesDialog(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /انتهت مدّة الحجز|حجز حالته (EXPIRED|CANCELLED|RELEASED|FULFILLED)/.test(message);
}
