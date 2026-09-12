import { HR_DEVICE_PROTOCOL_LABELS } from "@shared/hr";

export const PROTOCOL_LABELS: Record<string, string> = HR_DEVICE_PROTOCOL_LABELS;

export interface DeviceFormData {
  name: string;
  serialNumber: string;
  protocol: string;
  model: string;
  location: string;
  branchId: string;
  deviceCode: string;
  ip: string;
}

export const emptyForm: DeviceFormData = {
  name: "",
  serialNumber: "",
  protocol: "AIFACE_WS",
  model: "",
  location: "",
  branchId: "",
  deviceCode: "",
  ip: "",
};

/** توقيت مقروء ببغداد — أو «—». */
export function fmtTime(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("ar-IQ-u-nu-latn", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Baghdad",
  });
}

/** وقتٌ نسبيّ قصير للحالة الحيّة؛ التاريخ الكامل يبقى للتوقيتات الأقدم. */
export function fmtRelativeTime(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const seconds = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1_000));
  if (seconds < 60) return "الآن";
  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return "قبل دقيقة";
  if (minutes === 2) return "قبل دقيقتين";
  if (minutes < 60) return `قبل ${minutes.toLocaleString("ar-IQ-u-nu-latn")} دقائق`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "قبل ساعة";
  if (hours === 2) return "قبل ساعتين";
  if (hours < 24) return `قبل ${hours.toLocaleString("ar-IQ-u-nu-latn")} ساعات`;
  return fmtTime(d);
}
