/**
 * مؤقت دورة حياة أمر الشغل — يحسب زمن معالجة الطلب من لحظة استلامه
 * ويتوقف تلقائياً عند بلوغ الجاهزية («جاهز للتسليم») أو التسليم.
 */

export interface WorkOrderTimingSnapshot {
  status?: string | null;
  createdAt?: Date | string | null;
  workStartedAt?: Date | string | null;
  workSeconds?: number | string | null;
  deliveredAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

export type OrderTimerState = "RUNNING" | "STOPPED" | "UNKNOWN";

export interface OrderTimerResult {
  state: OrderTimerState;
  /** المدة الإجمالية بالدقائق */
  durationMinutes: number | null;
  /** لحظة التوقف (الجاهزية أو التسليم) إن وجدت */
  stoppedAt: Date | null;
  /** النص العربي الموجز للمدة: «١٥د»، «١س ٣٠د»، «١ي ٤س» */
  formattedDuration: string;
  /** نص شارة العرض: مثلاً «١٥د» أو «استغرق: ١س ٣٠د» */
  badgeLabel: string;
  /** تلميح الشرح التفصيلي */
  tooltip: string;
}

/** تحليل التاريخ بأمان */
export function parseDateSafe(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** اشتقاق لحظة الجاهزية أو التوقف */
export function deriveOrderStoppedAt(order: WorkOrderTimingSnapshot): Date | null {
  const started = parseDateSafe(order.workStartedAt);
  const seconds = order.workSeconds != null ? Number(order.workSeconds) : null;
  if (started && seconds != null && Number.isFinite(seconds) && seconds >= 0) {
    return new Date(started.getTime() + seconds * 1000);
  }
  return parseDateSafe(order.deliveredAt) ?? parseDateSafe(order.updatedAt) ?? null;
}

/**
 * تنسيق الدقائق إلى نص عربي موجز ومنضبط
 * - أقل من 60 دقيقة: «15د»
 * - أقل من 24 ساعة: «1س 30د» أو «2س»
 * - 24 ساعة فأكثر: «1ي 4س» أو «2ي»
 */
export function formatOrderDuration(minutes: number | null): string {
  if (minutes == null || !Number.isFinite(minutes) || minutes < 0) return "—";
  if (minutes < 60) return `${minutes}د`;
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h}س` : `${h}س ${m}د`;
  }
  const days = Math.floor(minutes / 1440);
  const remMinutes = minutes % 1440;
  const remHours = Math.floor(remMinutes / 60);
  return remHours === 0 ? `${days}ي` : `${days}ي ${remHours}س`;
}

/**
 * حساب حالة ومدة المؤقت لأمر الشغل
 * now يمكن تمريره للاختبار الحتمي
 */
export function computeOrderLifecycleTiming(
  order: WorkOrderTimingSnapshot,
  now: Date = new Date(),
): OrderTimerResult {
  const status = order.status ?? "";
  const created = parseDateSafe(order.createdAt);

  if (!created) {
    return {
      state: "UNKNOWN",
      durationMinutes: null,
      stoppedAt: null,
      formattedDuration: "—",
      badgeLabel: "—",
      tooltip: "تاريخ الاستلام غير متوفر",
    };
  }

  const nowMs = now.getTime();
  const createdMs = created.getTime();

  // الحالات التي يتوقف عندها العداد: READY أو DELIVERED
  if (status === "READY" || status === "DELIVERED") {
    const stoppedAt = deriveOrderStoppedAt(order) ?? now;
    const stoppedMs = stoppedAt.getTime();
    const durationMs = Math.max(0, stoppedMs - createdMs);
    const durationMinutes = Math.floor(durationMs / 60_000);
    const formatted = formatOrderDuration(durationMinutes);

    return {
      state: "STOPPED",
      durationMinutes,
      stoppedAt,
      formattedDuration: formatted,
      badgeLabel: `استغرق: ${formatted}`,
      tooltip: `توقف العداد عند الجاهزية للتسليم (استغرق: ${formatted})`,
    };
  }

  if (status === "CANCELLED") {
    const stoppedAt = deriveOrderStoppedAt(order) ?? now;
    const durationMs = Math.max(0, stoppedAt.getTime() - createdMs);
    const durationMinutes = Math.floor(durationMs / 60_000);
    const formatted = formatOrderDuration(durationMinutes);

    return {
      state: "STOPPED",
      durationMinutes,
      stoppedAt,
      formattedDuration: formatted,
      badgeLabel: `أُلغي بعد: ${formatted}`,
      tooltip: `توقف العداد بعد إلغاء الأمر (مضى عليه: ${formatted})`,
    };
  }

  // الحالات النشطة: RECEIVED أو IN_PROGRESS أو أي حالة تشغيلية أخرى
  const durationMs = Math.max(0, nowMs - createdMs);
  const durationMinutes = Math.floor(durationMs / 60_000);
  const formatted = formatOrderDuration(durationMinutes);

  return {
    state: "RUNNING",
    durationMinutes,
    stoppedAt: null,
    formattedDuration: formatted,
    badgeLabel: formatted,
    tooltip: `العداد نشط: مضى ${formatted} منذ استلام الطلب`,
  };
}
