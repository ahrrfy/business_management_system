import * as React from "react";
import { useState, useMemo } from "react";
import {
  Copy,
  Check,
  ChevronDown,
  MessageSquare,
  Sparkles,
  MapPin,
  Clock,
  AlertTriangle,
  FileCheck,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { WhatsAppIcon } from "@/components/WhatsAppShare";
import {
  openWhatsApp,
  preferredWhatsAppPhone,
  buildCustomerOrderConfirmedMessage,
  buildCustomerLocationRequestMessage,
  buildCustomerDeliveredMessage,
  buildCustomerDeliveryFailedMessage,
  buildCustomerDispatchMessage,
  buildCourierAssignmentMessage,
  buildCourierUrgentDispatchMessage,
  buildCourierAddressUpdateMessage,
  buildCourierSettlementReminderMessage,
  buildCourierCancellationMessage,
} from "@/lib/whatsapp";
import { notify } from "@/lib/notify";

export interface WhatsAppContextData {
  orderNumber?: string | null;
  consignmentNumber?: string | null;
  title?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerWhatsapp?: string | null;
  deliveryAddress?: string | null;
  salePrice?: string | number | null;
  deposit?: string | number | null;
  dueDate?: string | null;
  isDelivery?: boolean | null;
  courierName?: string | null;
  courierPhone?: string | null;
  courierWhatsapp?: string | null;
  codAmount?: string | number | null;
  deliveryFee?: string | number | null;
  feeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
  openConsignmentsCount?: number;
  totalSettlementCod?: string | number;
}

export interface WhatsAppStageActionsMenuProps {
  data: WhatsAppContextData;
  target?: "customer" | "courier" | "both";
  size?: "sm" | "default" | "icon-sm";
  variant?: "outline" | "solid" | "ghost";
  className?: string;
  label?: string;
  iconOnly?: boolean;
}

interface TemplateOption {
  id: string;
  title: string;
  category: "customer" | "courier";
  icon: React.ElementType;
  buildMessage: () => string;
}

export function WhatsAppStageActionsMenu({
  data,
  target = "both",
  size = "sm",
  variant = "outline",
  className,
  label = "رسائل واتساب للمراحل",
  iconOnly = false,
}: WhatsAppStageActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"customer" | "courier">(
    target === "courier" ? "courier" : "customer"
  );
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const customerPhone = preferredWhatsAppPhone(data.customerWhatsapp, data.customerPhone);
  const courierPhone = preferredWhatsAppPhone(data.courierWhatsapp, data.courierPhone);

  const currentPhone = activeTab === "customer" ? customerPhone : courierPhone;

  // تعريف قوالب الرسائل المرحلية بحسب السياق
  const customerTemplates = useMemo<TemplateOption[]>(() => {
    return [
      {
        id: "cust-dispatch",
        title: "مع المندوب في الطريق",
        category: "customer",
        icon: Sparkles,
        buildMessage: () =>
          buildCustomerDispatchMessage({
            orderNumber: data.orderNumber || data.consignmentNumber || "",
            title: data.title || "الطلب",
            customerName: data.customerName,
            courierName: data.courierName || "المندوب",
            courierPhone: data.courierPhone,
            codAmount: data.codAmount ?? 0,
            deliveryFee: data.deliveryFee,
            feeCollection: data.feeCollection,
          }),
      },
      {
        id: "cust-location",
        title: "طلب اللوكيشن والعنوان الدقيق",
        category: "customer",
        icon: MapPin,
        buildMessage: () =>
          buildCustomerLocationRequestMessage({
            orderNumber: data.orderNumber || data.consignmentNumber || "",
            title: data.title,
            customerName: data.customerName,
          }),
      },
      {
        id: "cust-confirmed",
        title: "تأكيد استلام وبدء الطلب",
        category: "customer",
        icon: FileCheck,
        buildMessage: () =>
          buildCustomerOrderConfirmedMessage({
            orderNumber: data.orderNumber || "",
            title: data.title || "الطلب",
            customerName: data.customerName,
            salePrice: data.salePrice,
            deposit: data.deposit,
            dueDate: data.dueDate,
            isDelivery: data.isDelivery ?? true,
          }),
      },
      {
        id: "cust-delivered",
        title: "تم التسليم بنجاح وشكراً",
        category: "customer",
        icon: Check,
        buildMessage: () =>
          buildCustomerDeliveredMessage({
            orderNumber: data.orderNumber || data.consignmentNumber || "",
            title: data.title,
            customerName: data.customerName,
            courierName: data.courierName,
          }),
      },
      {
        id: "cust-failed",
        title: "تعذر الاتصال / محاولة بديلة",
        category: "customer",
        icon: AlertTriangle,
        buildMessage: () =>
          buildCustomerDeliveryFailedMessage({
            orderNumber: data.orderNumber || data.consignmentNumber || "",
            title: data.title,
            customerName: data.customerName,
            courierName: data.courierName,
            courierPhone: data.courierPhone,
          }),
      },
    ];
  }, [data]);

  const courierTemplates = useMemo<TemplateOption[]>(() => {
    return [
      {
        id: "cour-assign",
        title: "تفاصيل إسناد الشحنة",
        category: "courier",
        icon: FileCheck,
        buildMessage: () =>
          buildCourierAssignmentMessage({
            consignmentNumber: data.consignmentNumber || data.orderNumber || "",
            orderNumber: data.orderNumber,
            title: data.title,
            customerName: data.customerName,
            customerPhone: data.customerPhone,
            deliveryAddress: data.deliveryAddress,
            codAmount: data.codAmount ?? 0,
            deliveryFee: data.deliveryFee,
            feeCollection: data.feeCollection,
          }),
      },
      {
        id: "cour-urgent",
        title: "شحنة عاجلة ذات أولوية",
        category: "courier",
        icon: Clock,
        buildMessage: () =>
          buildCourierUrgentDispatchMessage({
            consignmentNumber: data.consignmentNumber || data.orderNumber || "",
            orderNumber: data.orderNumber,
            title: data.title,
            customerName: data.customerName,
            customerPhone: data.customerPhone,
            deliveryAddress: data.deliveryAddress,
            codAmount: data.codAmount ?? 0,
            deliveryFee: data.deliveryFee,
            feeCollection: data.feeCollection,
          }),
      },
      {
        id: "cour-addr",
        title: "تحديث عنوان / لوكيشن العميل",
        category: "courier",
        icon: MapPin,
        buildMessage: () =>
          buildCourierAddressUpdateMessage({
            consignmentNumber: data.consignmentNumber || data.orderNumber || "",
            orderNumber: data.orderNumber,
            customerName: data.customerName,
            newAddress: data.deliveryAddress || "مقر العميل المحدّث",
          }),
      },
      {
        id: "cour-remittance",
        title: "تذكير بتوريد المبالغ والعهد",
        category: "courier",
        icon: Sparkles,
        buildMessage: () =>
          buildCourierSettlementReminderMessage({
            courierName: data.courierName || "المندوب",
            openConsignmentsCount: data.openConsignmentsCount ?? 1,
            totalCodAmount: data.totalSettlementCod ?? (data.codAmount || 0),
          }),
      },
      {
        id: "cour-cancel",
        title: "إلغاء الإرسالية وإعادة الطرد",
        category: "courier",
        icon: RotateCcw,
        buildMessage: () =>
          buildCourierCancellationMessage({
            consignmentNumber: data.consignmentNumber || data.orderNumber || "",
            orderNumber: data.orderNumber,
            customerName: data.customerName,
            reason: "إلغاء الطلب من قبل الإدارة",
          }),
      },
    ];
  }, [data]);

  const activeTemplates = activeTab === "customer" ? customerTemplates : courierTemplates;

  const handleSendWhatsApp = (buildMsg: () => string) => {
    if (!currentPhone) {
      notify.warn(
        "لا يوجد رقم هاتف صالح",
        activeTab === "customer"
          ? "لم يتم تحديد رقم هاتف صالح للعميل"
          : "لم يتم تحديد رقم هاتف صالح للمندوب"
      );
      return;
    }
    const text = buildMsg();
    openWhatsApp(currentPhone, text);
  };

  const handleCopy = async (id: string, buildMsg: () => string) => {
    try {
      const text = buildMsg();
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      notify.ok("تم نسخ نص الرسالة لواتساب بنجاح");
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      notify.err("تعذر النسخ إلى الحافظة");
    }
  };

  const solid = variant === "solid";
  const ghost = variant === "ghost";

  return (
    <>
      <Button
        variant={solid ? "default" : ghost ? "ghost" : "outline"}
        size={size}
        className={`gap-1.5 font-bold ${
          solid
            ? "bg-[var(--brand-whatsapp)] hover:brightness-105 text-white"
            : ghost
            ? "text-[var(--brand-whatsapp)] hover:bg-[var(--brand-whatsapp)]/10 hover:text-[var(--brand-whatsapp)]"
            : "border-[var(--brand-whatsapp)] text-[var(--brand-whatsapp)] hover:bg-[var(--brand-whatsapp)]/10"
        } ${iconOnly ? "px-2" : ""} ${className ?? ""}`}
        onClick={() => setOpen(true)}
        type="button"
        title={label || "رسائل واتساب للمراحل"}
        aria-label={label || "رسائل واتساب للمراحل"}
      >
        <WhatsAppIcon className="size-4 shrink-0" />
        {!iconOnly && <span>{label}</span>}
        {!iconOnly && <ChevronDown className="size-3.5 opacity-70 shrink-0" />}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto" dir="rtl">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <div className="rounded-full bg-[var(--brand-whatsapp)]/10 p-2 text-[var(--brand-whatsapp)]">
                <WhatsAppIcon className="size-5" />
              </div>
              <div>
                <DialogTitle className="text-lg font-bold">
                  رسائل واتساب للمراحل والحالات
                </DialogTitle>
                <DialogDescription className="text-xs">
                  رسائل منسّقة وجاهزة للإرسال المباشر أو النسخ لجميع مراحل الطلب والتوصيل
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {/* أزرار التبديل بين العميل والمندوب */}
          {target === "both" && (
            <div className="flex rounded-lg border bg-muted/50 p-1 text-sm font-semibold">
              <button
                type="button"
                onClick={() => setActiveTab("customer")}
                className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md transition-all ${
                  activeTab === "customer"
                    ? "bg-card text-foreground shadow-xs font-bold"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span>العميل</span>
                {customerPhone ? (
                  <span className="text-[11px] font-mono opacity-80" dir="ltr">
                    ({customerPhone})
                  </span>
                ) : (
                  <span className="text-[10px] text-destructive">(بلا رقم)</span>
                )}
              </button>

              <button
                type="button"
                onClick={() => setActiveTab("courier")}
                className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md transition-all ${
                  activeTab === "courier"
                    ? "bg-card text-foreground shadow-xs font-bold"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span>المندوب</span>
                {courierPhone ? (
                  <span className="text-[11px] font-mono opacity-80" dir="ltr">
                    ({courierPhone})
                  </span>
                ) : (
                  <span className="text-[10px] text-destructive">(بلا رقم)</span>
                )}
              </button>
            </div>
          )}

          {/* قائمة القوالب المرحلية */}
          <div className="space-y-3 pt-2">
            {activeTemplates.map((template) => {
              const Icon = template.icon;
              const msg = template.buildMessage();
              const isCopied = copiedId === template.id;

              return (
                <div
                  key={template.id}
                  className="rounded-xl border bg-card/60 p-3 hover:border-primary/40 transition-colors space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className="rounded-md bg-primary/10 p-1.5 text-primary">
                        <Icon className="size-4" />
                      </div>
                      <span className="font-bold text-sm text-foreground">
                        {template.title}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 gap-1 text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => handleCopy(template.id, template.buildMessage)}
                        type="button"
                        title="نسخ نص الرسالة"
                      >
                        {isCopied ? (
                          <>
                            <Check className="size-3.5 text-[var(--sem-pos)]" />
                            <span className="text-[var(--sem-pos)]">تم النسخ</span>
                          </>
                        ) : (
                          <>
                            <Copy className="size-3.5" />
                            <span>نسخ</span>
                          </>
                        )}
                      </Button>

                      <Button
                        variant="default"
                        size="sm"
                        disabled={!currentPhone}
                        className="h-8 gap-1.5 text-xs bg-[var(--brand-whatsapp)] hover:bg-[var(--brand-whatsapp)]/90 text-white font-bold"
                        onClick={() => handleSendWhatsApp(template.buildMessage)}
                        type="button"
                        title={
                          currentPhone
                            ? `إرسال إلى ${currentPhone}`
                            : "لا يوجد رقم هاتف صالح"
                        }
                      >
                        <WhatsAppIcon className="size-3.5 shrink-0" />
                        <span>إرسال واتساب</span>
                      </Button>
                    </div>
                  </div>

                  {/* معاينة نص الرسالة */}
                  <div className="rounded-lg bg-muted/40 p-2.5 text-xs text-muted-foreground whitespace-pre-line leading-relaxed font-sans border border-border/40 select-text">
                    {msg}
                  </div>
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
