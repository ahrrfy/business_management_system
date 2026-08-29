/**
 * SLA لعمر حالة أمر الشغل — يجعل «الوقت» ظاهراً في الشاشة، لا مخفيّاً في القاعدة.
 *
 * **الحاجة (تدقيق ٢٨/٨/٢٦، المحور ١٣):** SLA على التوصيل موجودٌ (`deliveryAging` ٢٤/٤٨/٧٢س)
 * لكن حالاتُ أمر الشغل نفسها بلا مؤقّت — أمرٌ يدخل RECEIVED ويجلس ساعاتٍ بلا سحبٍ لا يُنبَّه
 * عنه أحد، وأمرٌ IN_PROGRESS يعلق لدى فنّيّ في إجازةٍ يظلّ مخفيّاً. مبدأ عالميّ: كل حالةٍ لها
 * سقفٌ زمنيّ متوقَّع؛ تجاوزُه يُشعِل تنبيهاً للمشرف قبل أن يُشعله العميل.
 *
 * **العتبات (قرارٌ أوّليّ قابلٌ للتعديل من إعدادات المكتبة لاحقاً):**
 *   • RECEIVED     — 60د إلى تحذير، 180د إلى تصعيد (طلبٌ عالقٌ بلا سحبٍ من فنّيّ)
 *   • IN_PROGRESS  — 240د إلى تحذير، 480د إلى تصعيد (تنفيذٌ طويلٌ يتجاوز يوم عمل)
 *   • READY        — 30د إلى تحذير، 120د إلى تصعيد (جاهزٌ لكن العميل لم يُبلَّغ أو المندوب لم يخرج)
 *
 * الحسابُ **على العميل** (لا استعلامَ إضافيّ) — الحقول القائمة على workOrder تكفي:
 * `createdAt`، `workStartedAt`، `workSeconds`. Polling 15ث في ReceptionOrderQueue يُحدِّث العرض
 * تلقائياً بلا refetchOnFocus (معطَّل عالمياً).
 */

export const WORK_ORDER_SLA_MINUTES: Record<
  string,
  { warnAfter: number; breachAfter: number }
> = {
  RECEIVED: { warnAfter: 60, breachAfter: 180 },
  IN_PROGRESS: { warnAfter: 240, breachAfter: 480 },
  READY: { warnAfter: 30, breachAfter: 120 },
};

export type SlaLevel = "OK" | "WARNING" | "BREACHED" | "UNKNOWN";

export interface WorkOrderTimingSnapshot {
  status: string | null | undefined;
  createdAt: Date | string | null | undefined;
  /** لحظة بدء التنفيذ (يُختَم `NOW()` في startWorkOrder). */
  workStartedAt?: Date | string | null;
  /** ثوانٍ التنفيذ (يُختَم عند markReady عبر TIMESTAMPDIFF). */
  workSeconds?: number | string | null;
}

/**
 * يحسبُ عمرَ الحالة الحاليّة بالدقائق. `null` حين لا تتوفّر البيانات الكافية للحساب:
 *   - RECEIVED     ⇒ من createdAt (متوفّر دائماً).
 *   - IN_PROGRESS  ⇒ من workStartedAt (قد يكون null لأوامرَ قديمةٍ قبل هجرة العمود).
 *   - READY        ⇒ من (workStartedAt + workSeconds) — الاثنان مطلوبان.
 *   - غير ذلك (DELIVERED/CANCELLED) ⇒ null (لا سقف زمنيّ على حالة نهائيّة).
 *
 * `now` قابلٌ للحقن للاختبار الحتميّ (لا `new Date()` مخفيّةً داخل الدالّة).
 */
export function computeStateAgeMinutes(
  row: WorkOrderTimingSnapshot,
  now: Date = new Date(),
): number | null {
  const nowMs = now.getTime();
  const status = row.status ?? "";

  const parseDate = (v: Date | string | null | undefined): Date | null => {
    if (v == null) return null;
    if (v instanceof Date) return v;
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  };

  if (status === "RECEIVED") {
    const created = parseDate(row.createdAt);
    if (!created) return null;
    return Math.max(0, Math.floor((nowMs - created.getTime()) / 60_000));
  }

  if (status === "IN_PROGRESS") {
    const started = parseDate(row.workStartedAt);
    if (!started) return null;
    return Math.max(0, Math.floor((nowMs - started.getTime()) / 60_000));
  }

  if (status === "READY") {
    const started = parseDate(row.workStartedAt);
    const seconds = row.workSeconds != null ? Number(row.workSeconds) : null;
    if (!started || seconds == null || !Number.isFinite(seconds)) return null;
    const readyAtMs = started.getTime() + seconds * 1000;
    return Math.max(0, Math.floor((nowMs - readyAtMs) / 60_000));
  }

  // DELIVERED/CANCELLED/أيّ حالة أخرى — بلا مؤقّت.
  return null;
}

export function slaLevel(
  status: string | null | undefined,
  ageMinutes: number | null,
): SlaLevel {
  if (ageMinutes == null || !status) return "UNKNOWN";
  const rule = WORK_ORDER_SLA_MINUTES[status];
  if (!rule) return "UNKNOWN";
  if (ageMinutes >= rule.breachAfter) return "BREACHED";
  if (ageMinutes >= rule.warnAfter) return "WARNING";
  return "OK";
}

/** تسميةُ مدّةٍ مختصرةٌ بالعربية: «٥د» أو «١٢س ٣٠د» (لا ثوانٍ — الحبيبةُ دقائق). */
export function formatAgeShort(ageMinutes: number | null): string {
  if (ageMinutes == null) return "—";
  if (ageMinutes < 60) return `${ageMinutes}د`;
  const h = Math.floor(ageMinutes / 60);
  const m = ageMinutes % 60;
  return m === 0 ? `${h}س` : `${h}س ${m}د`;
}

/** فئةُ CSS للشارة بحسب المستوى — توكنز دلاليّة (`--sem-*`) لا ألوانٍ خام. */
export function slaLevelChipClass(level: SlaLevel): string {
  switch (level) {
    case "OK":
      return "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]";
    case "WARNING":
      return "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]";
    case "BREACHED":
      return "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]";
    case "UNKNOWN":
    default:
      return "bg-muted text-muted-foreground";
  }
}
