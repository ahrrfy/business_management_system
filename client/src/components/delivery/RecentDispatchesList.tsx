import React from "react";
import { fmt } from "@/lib/money";
import { CheckCircle2, Printer, Ban } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export interface DispatchedItemHistory {
  consignmentId: number;
  consignmentNumber: string;
  sourceType: "ONLINE_ORDER" | "WORK_ORDER" | "INVOICE";
  sourceId: number;
  sourceNumber: string;
  invoiceNumber?: string | null;
  codAmount: string;
  deliveryFee: string;
  recipientName?: string | null;
  recipientPhone?: string | null;
  deliveryAddress?: string | null;
  partyName: string;
  dispatchedAt: Date;
  externalTrackingRef?: string | null;
  qrUrl?: string | null;
}

interface Props {
  items: DispatchedItemHistory[];
  onPrint: (item: DispatchedItemHistory) => void;
  onCancelAssignment?: (consignment: { id: number; number: string }) => void;
}

export function RecentDispatchesList({ items, onPrint, onCancelAssignment }: Props) {
  if (items.length === 0) return null;

  return (
    <div className="border-t pt-3 space-y-2">
      <div className="flex items-center justify-between text-xs font-bold text-muted-foreground px-1">
        <span>الطرود المسندة مؤخراً ({items.length})</span>
        <span className="text-[11px] font-normal">تحديث فوري وإمكانية إعادة الطباعة</span>
      </div>

      <div className="divide-y rounded-lg border bg-muted/20 max-h-56 overflow-y-auto">
        {items.map((item) => (
          <div
            key={item.consignmentId}
            className="flex items-center justify-between p-2.5 hover:bg-muted/40 transition-colors text-xs"
          >
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-full bg-emerald-500/10 text-emerald-600">
                <CheckCircle2 className="size-4" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-foreground font-mono">{item.consignmentNumber}</span>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                    {item.sourceType === "ONLINE_ORDER" ? "متجر" : item.sourceType === "INVOICE" ? "فاتورة" : "شغل"} #{item.sourceNumber}
                  </Badge>
                  <span className="text-muted-foreground">←</span>
                  <span className="font-semibold text-primary">{item.partyName}</span>
                </div>
                <div className="text-muted-foreground text-[11px] mt-0.5">
                  {item.recipientName ?? "عميل"} {item.recipientPhone ? `· ${item.recipientPhone}` : ""}
                  {item.deliveryAddress ? ` · ${item.deliveryAddress}` : ""}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="text-left font-mono">
                <div className="font-bold text-foreground">{fmt(item.codAmount)} د.ع</div>
                {Number(item.deliveryFee) > 0 && (
                  <div className="text-[10px] text-muted-foreground">أجرة: {fmt(item.deliveryFee)} د.ع</div>
                )}
              </div>
              {onCancelAssignment && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() =>
                    onCancelAssignment({
                      id: item.consignmentId,
                      number: item.consignmentNumber,
                    })
                  }
                  title="إلغاء إسناد هذا الطرد وتحرير عهدة المندوب"
                >
                  <Ban className="size-3.5" />
                  إلغاء
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1 text-xs"
                onClick={() => onPrint(item)}
                title="إعادة طباعة البوليصة والملصق"
              >
                <Printer className="size-3.5" />
                طباعة
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
