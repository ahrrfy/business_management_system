import React, { useState, useRef, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { fmt } from "@/lib/money";
import { playReadyBeep } from "@/lib/notifyBeep";
import { normalizeBarcodeScannerInput } from "@/lib/barcodeScannerInput";
import {
  ScanBarcode,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  Loader2,
  PackageX,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

export interface ReturnedItemHistory {
  consignmentId: number;
  consignmentNumber: string;
  invoiceId?: number | null;
  reversed: boolean;
  partyName?: string | null;
  recipientName?: string | null;
  codAmount: string;
  returnReason: string;
  returnedAt: Date;
}

interface Props {
  onReturnSuccess?: () => void;
}

const COMMON_RETURN_REASONS = [
  "رفض العميل الاستلام",
  "عنوان خاطئ / لا يمكن الوصول",
  "العميل لا يرد / مغلق",
  "إلغاء الطلب قبل التسليم",
  "طلب مؤجل / إرجاع للمخزن",
  "طرد تالف / غير مطابق",
];

export function BarcodeReturnStream({ onReturnSuccess }: Props) {
  const [barcode, setBarcode] = useState("");
  const [returnReason, setReturnReason] = useState(COMMON_RETURN_REASONS[0]);
  const [customReason, setCustomReason] = useState("");
  const [recentReturns, setRecentReturns] = useState<ReturnedItemHistory[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  const focusInput = useCallback(() => {
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
  }, []);

  const returnMutation = trpc.delivery.returnByBarcode.useMutation();

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setLastError(null);

    const raw = barcode.trim();
    if (!raw) return;

    const cleanBarcode = normalizeBarcodeScannerInput(raw);
    const effectiveReason = customReason.trim() || returnReason;

    try {
      const res = await returnMutation.mutateAsync({
        barcode: cleanBarcode,
        returnReason: effectiveReason,
        clientRequestId: crypto.randomUUID(),
      });

      playReadyBeep();

      const historyItem: ReturnedItemHistory = {
        consignmentId: res.consignmentId,
        consignmentNumber: res.consignmentNumber,
        invoiceId: res.invoiceId,
        reversed: res.reversed,
        partyName: res.partyName,
        recipientName: res.recipientName,
        codAmount: res.codAmount,
        returnReason: res.returnReason,
        returnedAt: new Date(),
      };

      setRecentReturns((prev) => [historyItem, ...prev.slice(0, 19)]);
      setBarcode("");
      notify.ok(
        "تم استلام المرتجع وعكس الفاتورة",
        `الإرسالية ${res.consignmentNumber} — أُعيدت للمخزن وأُلغيت عهدة COD ${fmt(res.codAmount)} د.ع`,
      );

      onReturnSuccess?.();
    } catch (err: any) {
      const msg = err.message || "تعذر استلام المرتجع";
      setLastError(msg);
      notify.err("فشل استلام المرتجع", msg);
    } finally {
      focusInput();
    }
  };

  return (
    <div className="rounded-xl border border-amber-500/30 bg-card p-4 space-y-4 shadow-sm" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <div className="flex items-center gap-2">
          <div className="p-2 bg-amber-500/10 text-amber-600 rounded-lg">
            <RotateCcw className="size-5" />
          </div>
          <div>
            <h3 className="font-bold text-sm text-foreground">استلام المرتجعات السريع بالباركود</h3>
            <p className="text-xs text-muted-foreground">
              امسح باركود الإرسالية (CN-) أو رقم الفاتورة أو مرجع الشركة لعكس المبيعات وتحرير عهدة المندوب فورياً
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground">سبب الرجوع:</span>
          <select
            value={returnReason}
            onChange={(e) => {
              setReturnReason(e.target.value);
              focusInput();
            }}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
          >
            {COMMON_RETURN_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
          {/* حقل مسح باركود المرتجع */}
          <div className="sm:col-span-8 space-y-1">
            <label className="text-xs font-bold text-foreground flex items-center gap-1">
              <ScanBarcode className="size-3.5 text-amber-600" />
              باركود الطرد المرتجع (CN- / مرجع الشركة / الفاتورة)
            </label>
            <div className="relative">
              <Input
                ref={inputRef}
                autoFocus
                placeholder="امسح باركود الإرسالية أو رقم الفاتورة..."
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                disabled={returnMutation.isPending}
                className="h-10 text-base font-mono pr-10 focus:ring-2 focus:ring-amber-500 border-amber-500/40"
                dir="ltr"
              />
              <div className="absolute right-3 top-2.5 text-muted-foreground pointer-events-none">
                {returnMutation.isPending ? (
                  <Loader2 className="size-5 animate-spin text-amber-600" />
                ) : (
                  <ScanBarcode className="size-5" />
                )}
              </div>
            </div>
          </div>

          {/* ملاحظة أو سبب إضافي (اختياري) */}
          <div className="sm:col-span-4 space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              ملاحظة مخصصة (اختياري)
            </label>
            <Input
              placeholder="سبب خاص للمرتجع..."
              value={customReason}
              onChange={(e) => setCustomReason(e.target.value)}
              disabled={returnMutation.isPending}
              className="h-10 text-xs"
            />
          </div>
        </div>

        {lastError && (
          <div className="flex items-center gap-2 p-2.5 rounded-lg border border-destructive/40 bg-destructive/10 text-destructive text-xs font-medium">
            <AlertCircle className="size-4 shrink-0" />
            <span>{lastError}</span>
          </div>
        )}
      </form>

      {/* سجل المرتجعات المستلمة في هذه الجلسة */}
      {recentReturns.length > 0 && (
        <div className="border-t pt-3 space-y-2">
          <div className="flex items-center justify-between text-xs font-bold text-muted-foreground px-1">
            <span>المرتجعات المستلمة مؤخرا ({recentReturns.length})</span>
            <span className="text-[11px] font-normal">عكس الفواتير وإعادة للمخزن</span>
          </div>

          <div className="divide-y rounded-lg border bg-muted/20 max-h-52 overflow-y-auto">
            {recentReturns.map((item) => (
              <div
                key={item.consignmentId}
                className="flex items-center justify-between p-2.5 hover:bg-muted/40 transition-colors text-xs"
              >
                <div className="flex items-center gap-2.5">
                  <div className="p-1.5 rounded-full bg-amber-500/10 text-amber-600">
                    <PackageX className="size-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-foreground font-mono">{item.consignmentNumber}</span>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-amber-500/50 text-amber-700 bg-amber-500/10">
                        مرتجع
                      </Badge>
                      {item.partyName && (
                        <span className="text-muted-foreground">من: {item.partyName}</span>
                      )}
                    </div>
                    <div className="text-muted-foreground text-[11px] mt-0.5">
                      السبب: <span className="text-foreground font-medium">{item.returnReason}</span>
                      {item.recipientName ? ` · العميل: ${item.recipientName}` : ""}
                    </div>
                  </div>
                </div>

                <div className="text-left font-mono">
                  <div className="font-bold text-destructive line-through">{fmt(item.codAmount)} د.ع</div>
                  <div className="text-[10px] text-emerald-600 font-sans">إعادة للمخزون</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
