/* ============================================================================
 * أنواع مشتركة لجسر أجهزة الحضور (server/services/hrDevices/types.ts)
 * الجسر يستقبل من عائلتين: AIFACE_WS (جهازنا AI518 — WebSocket JSON) وZKTECO_PUSH
 * (بروتوكول iclock النصي HTTP — عائلة ZKTeco المنتشرة). كل سائق يحوّل حمولته إلى
 * RawPunch موحَّد يدخل punchStore ثم يُطوى إلى سجل الحضور.
 * ========================================================================== */
import type { HrFingerprintDevice } from "../../../drizzle/schema";

/** بصمة موحَّدة كما يخرجها أي سائق قبل التخزين الخام. */
export interface RawPunch {
  /** رقم المستخدم داخل الجهاز (enrollid/PIN). */
  enrollId: number;
  /** توقيت الحائط المحلي من ساعة الجهاز "YYYY-MM-DD HH:MM:SS". */
  punchAt: string;
  /** وسيلة التحقق (face/card/pwd/fp أو الرقم الخام نصاً عند الجهل). */
  mode?: string;
  /** in | out إن أبلغها الجهاز. */
  inOut?: string;
  /** الحمولة الأصلية للتشخيص. */
  raw?: unknown;
}

/** مستخدم جهاز موحَّد (من senduser/getuserlist/OPERLOG). */
export interface RawDeviceUser {
  enrollId: number;
  name?: string;
  isAdmin?: boolean;
  cardNo?: string;
  /** رقم نوع القالب (backupnum) → سجل القالب كما أرسله الجهاز. */
  backup?: { num: number; record: unknown };
}

/** وصلة حيّة بجهاز متصل (aiface): إرسال أوامر + حالة الأمر الجاري. */
export interface DeviceLink {
  deviceId: number;
  serialNumber: string;
  protocol: string;
  send: (obj: Record<string, unknown>) => void;
  close: () => void;
  /** أمر واحد قيد التنفيذ لكل جهاز (البروتوكول طلب/استجابة على نفس المقبس). */
  inflight: { commandId: number; cmd: string; received: number; expected: number | null } | null;
}

export type DeviceRow = HrFingerprintDevice;

/** أوامر الخادم→الجهاز المسموحة (قائمة بيضاء تُفرض في الراوتر والسائقين). */
export const DEVICE_COMMANDS = [
  "settime",
  "getalllog",
  "getnewlog",
  "getuserlist",
  "getuserinfo",
  "setuserinfo",
  "deleteuser",
  "opendoor",
  "reboot",
] as const;
export type DeviceCommandName = (typeof DEVICE_COMMANDS)[number];

/** الآن بتوقيت بغداد "YYYY-MM-DD HH:MM:SS" — لمزامنة ساعة الجهاز (cloudtime) وتقارير الجسر.
 *  Intl بمنطقة Asia/Baghdad (UTC+3 ثابتة) — لا حساب يدوي لمكوّنات محلية (حارس businessDay). */
export function baghdadNow(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Baghdad",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/** تطبيع توقيت بصمة قادم من جهاز إلى "YYYY-MM-DD HH:MM:SS" — null إن لم يُفهم. */
export function normalizePunchTime(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim().replace("T", " ");
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] ?? "00"}`;
}
