/* ============================================================================
 * مساعدات فترة العمولات (YYYY-MM) — مشتركة بين الخطط/الأهداف/المحرّك.
 * مرآة اتفاقية payrollService (PERIOD_RE نفسها) كي تتطابق فترة تشغيلة العمولة
 * حرفياً مع فترة مسيّر الرواتب الذي سيلتقطها.
 * ========================================================================== */
import { TRPCError } from "@trpc/server";

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function assertPeriod(period: string): string {
  const p = period?.trim();
  if (!p || !PERIOD_RE.test(p)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الشهر يجب أن يكون بصيغة YYYY-MM" });
  }
  return p;
}

/** الشهر التالي (YYYY-MM) — حساب نصّي بحت بلا Date ولا مناطق زمنية. */
export function nextPeriod(p: string): string {
  const [y, m] = p.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** الشهر السابق (YYYY-MM). */
export function prevPeriod(p: string): string {
  const [y, m] = p.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** حدّا الشهر لكنس دفتري sargable على عمود DATE: [أول الشهر، أول الشهر التالي). */
export function periodDateRange(p: string): { from: string; toExclusive: string } {
  return { from: `${p}-01`, toExclusive: `${nextPeriod(p)}-01` };
}

/** الشهر الجاري (مرساة UTC — يطابق TZ=UTC في الاختبارات وentryDate الدفتري). */
export function currentPeriodUTC(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
