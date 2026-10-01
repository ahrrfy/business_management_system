import * as React from "react";
import {
  Building2,
  FileText,
  MapPin,
  Package,
  Phone,
  Truck,
  User,
} from "lucide-react";
import type { RouterOutputs } from "@/lib/trpc";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";

export type PredictiveItem = RouterOutputs["delivery"]["predictiveSearch"][number];

const PARCEL_STATUS_MAP: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  ASSIGNED: { label: "قيد الإسناد", variant: "outline" },
  ACCEPTED: { label: "مقبول", variant: "outline" },
  PICKED_UP: { label: "مستلم للتوصيل", variant: "secondary" },
  OUT_FOR_DELIVERY: { label: "بالطريق مع المندوب", variant: "default" },
  DELIVERED: { label: "مسلَّم للزبون", variant: "default" },
  FAILED: { label: "تعذّر التسليم", variant: "destructive" },
  RETURNED: { label: "مرتجع", variant: "destructive" },
  CANCELLED: { label: "ملغى", variant: "destructive" },
};

export interface PredictiveItemRowProps {
  item: PredictiveItem;
  isHighlighted: boolean;
  onSelect: (item: PredictiveItem) => void;
  onMouseEnter: () => void;
}

export const PredictiveItemRow = React.memo(function PredictiveItemRow({
  item,
  isHighlighted,
  onSelect,
  onMouseEnter,
}: PredictiveItemRowProps) {
  const statusMeta = PARCEL_STATUS_MAP[item.parcelStatus] ?? { label: item.parcelStatus, variant: "outline" };
  const isCompany = item.partyType === "COMPANY";

  return (
    <div
      id={`predictive-opt-${item.id}`}
      role="option"
      aria-selected={isHighlighted}
      tabIndex={-1}
      onClick={() => onSelect(item)}
      onMouseEnter={onMouseEnter}
      className={cn(
        "p-3 cursor-pointer transition-colors text-xs space-y-1.5 outline-none select-none",
        isHighlighted ? "bg-primary/10 text-foreground" : "hover:bg-muted/40",
      )}
    >
      {/* السطر الأول: أرقام الطرد والفاتورة والطلب والشارات */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-extrabold text-sm font-mono text-foreground flex items-center gap-1">
            <Package aria-hidden="true" className="size-3.5 text-primary shrink-0" />
            {item.consignmentNumber}
          </span>

          {item.externalTrackingRef && (
            <span className="font-bold text-xs text-primary font-mono bg-primary/10 px-1.5 py-0.5 rounded" dir="ltr">
              {item.externalTrackingRef}
            </span>
          )}

          {item.invoiceNumber && (
            <span className="text-xs text-muted-foreground font-mono flex items-center gap-1">
              <FileText aria-hidden="true" className="size-3" />
              فاتورة #{item.invoiceNumber}
            </span>
          )}

          {item.orderNumber && (
            <span className="text-xs text-muted-foreground font-mono">
              طلب #{item.orderNumber}
            </span>
          )}
        </div>

        {/* شارة حالة الطرد */}
        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-background/80 text-foreground">
          {statusMeta.label}
        </span>
      </div>

      {/* السطر الثاني: اسم الزبون والهاتف والعنوان */}
      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <User aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
          الزبون: <strong className="text-foreground">{item.customerName}</strong>
        </span>

        {item.customerPhone && (
          <span className="inline-flex items-center gap-1 font-mono text-foreground font-semibold" dir="ltr">
            <Phone aria-hidden="true" className="size-3 text-muted-foreground shrink-0" />
            <span>{item.customerPhone}</span>
          </span>
        )}

        {item.deliveryAddress && (
          <span className="inline-flex items-center gap-1 truncate max-w-[220px]" title={item.deliveryAddress}>
            <MapPin aria-hidden="true" className="size-3 text-muted-foreground shrink-0" />
            <span className="truncate">{item.deliveryAddress}</span>
          </span>
        )}
      </div>

      {/* السطر الثالث: جهة التوصيل والمبلغ المطلوب وشارات التطابق */}
      <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/40 text-[11px]">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            {isCompany ? (
              <Building2 aria-hidden="true" className="size-3 shrink-0" />
            ) : (
              <Truck aria-hidden="true" className="size-3 shrink-0" />
            )}
            <span>{item.partyName}</span>
          </span>

          {/* شارات نوع التطابق */}
          {item.matchedOn?.map((kind) => {
            if (kind === "PHONE") {
              return (
                <span key={kind} className="text-[10px] font-bold bg-emerald-500/10 text-emerald-700 px-1.5 py-0.2 rounded border border-emerald-500/30">
                  تطابق هاتف
                </span>
              );
            }
            if (kind === "CUSTOMER_NAME") {
              return (
                <span key={kind} className="text-[10px] font-bold bg-blue-500/10 text-blue-700 px-1.5 py-0.2 rounded border border-blue-500/30">
                  تطابق اسم
                </span>
              );
            }
            if (kind === "INVOICE_NUMBER") {
              return (
                <span key={kind} className="text-[10px] font-bold bg-purple-500/10 text-purple-700 px-1.5 py-0.2 rounded border border-purple-500/30">
                  تطابق فاتورة
                </span>
              );
            }
            if (kind === "CONSIGNMENT_NUMBER") {
              return (
                <span key={kind} className="text-[10px] font-bold bg-amber-500/10 text-amber-700 px-1.5 py-0.2 rounded border border-amber-500/30">
                  تطابق إرسالية
                </span>
              );
            }
            if (kind === "ADDRESS") {
              return (
                <span key={kind} className="text-[10px] font-bold bg-indigo-500/10 text-indigo-700 px-1.5 py-0.2 rounded border border-indigo-500/30">
                  تطابق عنوان
                </span>
              );
            }
            if (kind === "ORDER_NUMBER") {
              return (
                <span key={kind} className="text-[10px] font-bold bg-sky-500/10 text-sky-700 px-1.5 py-0.2 rounded border border-sky-500/30">
                  تطابق طلب
                </span>
              );
            }
            return null;
          })}
        </div>

        <div className="text-end">
          <span className="text-muted-foreground me-1">المطلوب (COD):</span>
          <strong className="text-foreground font-mono font-bold">{fmt(item.remainingAmount)} د.ع</strong>
        </div>
      </div>
    </div>
  );
});
