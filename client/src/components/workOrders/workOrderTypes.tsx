import type React from "react";
import { type WorkOrderStatus, WO_NEXT_STATUS, WO_STAGE_INDEX, workOrderStatusHue, workOrderStatusLabel, workOrderTimelineLabel } from "@shared/workOrderStatus";
import { isKanbanStateApplicable, isWorkOrderKanbanState, nextKanbanStateInCycle, workOrderKanbanDotCls, workOrderKanbanStateLabel, type WorkOrderKanbanState } from "@shared/workOrderKanban";
import { CheckCircle2, ChevronRight, Package } from "lucide-react";
import type { RouterOutputs } from "@/lib/trpc";
import { fmtAr, fmtInt, D, positiveDiff, round2 } from "@/lib/money";
import { fmtDate, fmtDateTime, toDate } from "@/lib/date";
import { printWorkOrder } from "@/lib/printing/printTemplates";
import { printWorkOrderReceipt } from "@/lib/printing/print";
import { printShippingLabel, type ShippingLabelData } from "@/lib/printing/shippingLabel";
import { notify } from "@/lib/notify";
import { buildWorkOrderStatusMessage } from "@/lib/whatsapp";
import { deriveWoDeliveryState, woDeliveryStateLabel } from "@shared/workOrderDeliveryState";

export type WO = RouterOutputs["workOrders"]["list"][number];
export type Detail = NonNullable<RouterOutputs["workOrders"]["get"]>;
export type Status = "RECEIVED" | "IN_PROGRESS" | "READY" | "DELIVERED";
export type DeliverTarget = { id: number; orderNumber: string; title: string; salePrice: string; deposit: string };

export function workOrderCardLabel(
  o: Pick<WO, "status" | "consignmentId" | "courierDeliveredAt" | "consignmentStatus" | "parcelStatus">,
): string {
  if (o.status === "DELIVERED" && o.consignmentId) {
    return o.courierDeliveredAt ? "وصل للعميل" : "مُرسل للتوصيل";
  }
  const st = deriveWoDeliveryState(o.consignmentStatus, o.parcelStatus);
  if (o.status === "READY" && st !== "NONE") return woDeliveryStateLabel(st)!;
  return workOrderStatusLabel(o.status);
}

// ── المراحل (أعمدة الكانبان) — مطابقة لحالات النظام الحقيقية ──
export const STATUSES: { key: Status; label: string; hint: string; hue: number }[] = [
  { key: "RECEIVED", label: "مُستلَم", hint: "بانتظار البدء", hue: 72 },
  { key: "IN_PROGRESS", label: "قيد التنفيذ", hint: "تحت الإنتاج الآن", hue: 250 },
  { key: "READY", label: "جاهز للتسليم", hint: "جاهز — بانتظار العميل", hue: 293 },
  { key: "DELIVERED", label: "مُغلق/مُرسل", hint: "فاتورة أو إرسالية توصيل", hue: 155 },
];

export const ADV_LABEL: Record<string, React.ReactNode> = {
  IN_PROGRESS: (<><ChevronRight aria-hidden className="size-4 inline-block align-text-bottom me-1" /> بدء التنفيذ (خصم المواد)</>),
  READY: (<><CheckCircle2 aria-hidden className="size-4 inline-block align-text-bottom me-1" /> وضع علامة: جاهز</>),
  DELIVERED: (<><Package aria-hidden className="size-4 inline-block align-text-bottom me-1" /> تسليم وإصدار فاتورة</>),
};

export type ColKey = "INBOX" | "CLAIMED" | "IN_PROGRESS" | "READY";
export const COLUMNS: { key: ColKey; label: string; hint: string; hue: number; status: Status; match: (o: WO) => boolean }[] = [
  { key: "INBOX", label: "طابور وارد", hint: "غير مسحوب — بانتظار فنّي", hue: 72, status: "RECEIVED", match: (o) => o.status === "RECEIVED" && !o.assignedTo },
  { key: "CLAIMED", label: "مسحوب", hint: "مُسنَد لفنّي — لم يبدأ", hue: 235, status: "RECEIVED", match: (o) => o.status === "RECEIVED" && !!o.assignedTo },
  { key: "IN_PROGRESS", label: "قيد التنفيذ", hint: "تحت الإنتاج الآن", hue: 250, status: "IN_PROGRESS", match: (o) => o.status === "IN_PROGRESS" },
  { key: "READY", label: "جاهز للتسليم", hint: "جاهز — بانتظار العميل", hue: 293, status: "READY", match: (o) => o.status === "READY" && deriveWoDeliveryState(o.consignmentStatus, o.parcelStatus) === "NONE" },
];

export const PRIORITIES: Record<string, { label: string; cls: string; rank: number }> = {
  URGENT: { label: "عاجل", cls: "wob-urgent", rank: 3 },
  NORMAL: { label: "عادي", cls: "wob-normal", rank: 2 },
  LOW: { label: "منخفض", cls: "wob-low", rank: 1 },
};


export function colVars(hue: number): React.CSSProperties {
  return {
    ["--c-solid" as string]: `oklch(0.6 0.17 ${hue})`,
    ["--c-soft" as string]: `oklch(0.6 0.17 ${hue} / 0.13)`,
    ["--c-text" as string]: `oklch(0.45 0.17 ${hue})`,
  } as React.CSSProperties;
}

export function avatarHue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "؟") + (parts[1]?.[0] ?? "")).slice(0, 2);
}

export function dueDayDelta(dueVal: unknown): number | null {
  const due = toDate(dueVal as string | number | Date | null | undefined);
  if (!due) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  return Math.round((dueDay.getTime() - today.getTime()) / 864e5);
}

export function dueInfo(o: { status: string; dueDate: unknown }): { state: "done" | "ok" | "soon" | "late"; text: string } {
  if (o.status === "DELIVERED") return { state: "done", text: "سُلّم" };
  const days = dueDayDelta(o.dueDate);
  if (days == null) return { state: "ok", text: "بلا موعد" };
  if (days < 0) return { state: "late", text: days === -1 ? "متأخر يوم" : `متأخر ${Math.abs(days)} يوم` };
  if (days === 0) return { state: "soon", text: "يستحق اليوم" };
  if (days === 1) return { state: "soon", text: "غداً" };
  return { state: "ok", text: `باقٍ ${days} يوم` };
}

export function progressOf(status: string) {
  const i = Math.max(WO_STAGE_INDEX[status as WorkOrderStatus] ?? 0, 0);
  return { idx: i, pct: Math.round((i / 3) * 100) };
}

export function workOrderContactMessage(o: {
  orderNumber: string;
  title: string;
  status: string;
  customerName: string | null;
  quantity?: number | null;
  dueDate: unknown;
  salePrice?: string | number | null;
  deposit?: string | number | null;
  hasDelivery?: boolean | null;
  deliveryCost?: string | number | null;
  deliveryFeeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
}) {
  return buildWorkOrderStatusMessage({
    orderNumber: o.orderNumber,
    title: o.title,
    status: o.status,
    customerName: o.customerName,
    quantity: o.quantity,
    dueDate: o.dueDate ? String(o.dueDate) : null,
    amountDue: o.status === "READY" ? D(o.salePrice ?? 0).minus(D(o.deposit ?? 0)).toString() : null,
    hasDelivery: o.hasDelivery,
    deliveryFee: o.deliveryCost ?? "0",
    deliveryFeeCollection: o.deliveryFeeCollection ?? "COURIER",
  });
}

export function printWoFromCard(o: WO) {
  printWorkOrder({
    woNumber: o.orderNumber,
    woDate: o.createdAt ? String(o.createdAt).slice(0, 10) : undefined,
    dueDate: o.dueDate ? String(o.dueDate).slice(0, 10) : undefined,
    status: o.status,
    employeeName: o.createdByName?.trim() || "موظف الخدمة",
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    jobType: o.title,
    items: [{ name: `${o.title} (${o.quantity} نسخة)`, unit: "مهمة", quantity: 1, unitPrice: o.salePrice, total: o.salePrice }],
    subtotal: o.salePrice,
    total: o.salePrice,
  });
}

export function printWoShippingLabel(o: {
  orderNumber: string;
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress?: string | null;
  salePrice: string;
  deposit: string | null;
  quantity: number;
  title: string;
  createdAt: Date | string | null;
}) {
  const data: ShippingLabelData = {
    orderNumber: o.orderNumber,
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    governorate: null,
    addressText: o.deliveryAddress ?? null,
    total: String(Math.max(0, Number(o.salePrice) - Number(o.deposit ?? 0))),
    createdAt: o.createdAt,
    items: [{ productName: o.title, unitName: "", quantity: String(o.quantity) }],
  };
  void printShippingLabel(data).then((r) => {
    if (!r.ok) notify.err("افسح مانع النوافذ المنبثقة لطباعة ملصق الشحن");
  });
}

export function printWoThermalFromCard(o: WO) {
  void printWorkOrderReceipt({
    orderNumber: o.orderNumber,
    orderDate: o.createdAt ? String(o.createdAt).slice(0, 10) : undefined,
    dueDate: o.dueDate ? String(o.dueDate).slice(0, 10) : undefined,
    status: o.status,
    employeeName: o.createdByName?.trim() || "موظف الخدمة",
    customerName: o.customerName ?? undefined,
    customerPhone: o.customerPhone ?? undefined,
    jobTitle: o.title,
    quantity: o.quantity ? `${o.quantity} نسخة` : undefined,
    total: o.salePrice,
    paidUpfront: Number(o.deposit ?? 0) > 0 ? o.deposit : null,
    balanceDue: Number(o.deposit ?? 0) > 0
      ? String(Math.max(0, Number(o.salePrice) - Number(o.deposit ?? 0)))
      : null,
  });
}
