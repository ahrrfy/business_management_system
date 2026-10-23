import { AlertCircle, AlertTriangle, CheckCircle2, Coins } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { SalesReturnPortalModel } from "./useSalesReturnPortal";

type Props = Pick<
  SalesReturnPortalModel,
  | "openDrawersQ"
  | "openDrawers"
  | "selectedShiftId"
  | "setSelectedShiftId"
  | "effectiveCashOrCardRefund"
>;
export function SalesReturnCashDrawers({
  openDrawersQ,
  openDrawers,
  selectedShiftId,
  setSelectedShiftId,
  effectiveCashOrCardRefund,
}: Props) {
  return (
    <div className="p-2.5 rounded-lg border border-emerald-200 dark:border-emerald-800/60 bg-emerald-50/50 dark:bg-emerald-950/20 space-y-2">
      <div className="flex items-center justify-between text-[11px] font-bold text-emerald-900 dark:text-emerald-300">
        <span className="flex items-center gap-1.5">
          <Coins className="size-3.5 text-emerald-600" />
          اختيار درج النقدية للصرف (الوردية)
        </span>
        {openDrawers.length > 0 && (
          <span className="text-[10px] text-muted-foreground font-normal font-mono">
            {openDrawers.length} درج متاح
          </span>
        )}
      </div>

      {openDrawersQ.isLoading ? (
        <div className="text-[11px] text-muted-foreground p-2 text-center">
          جارٍ فحص أدراج النقدية المفتوحة...
        </div>
      ) : openDrawers.length === 0 ? (
        <div className="p-2.5 rounded border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 text-[11px] flex items-start gap-2">
          <AlertTriangle className="size-4 shrink-0 text-amber-600 mt-0.5" />
          <div>
            <div className="font-bold">لا توجد وردية كاشير مفتوحة حالياً</div>
            <div className="text-[10px] text-muted-foreground">
              يجب فتح وردية في هذا الفرع لصرف النقد، أو اختيار طريقة استرداد
              أخرى كالبطاقة أو رصيد المتجر أو معادلة الذمم.
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {openDrawers.map((dr) => {
            const isSelected = dr.shiftId === selectedShiftId;
            const isLow =
              Number(dr.expectedCash || 0) < effectiveCashOrCardRefund;
            const shiftTypeLabel =
              dr.shiftType === "RETAIL"
                ? "تجزئة"
                : dr.shiftType === "RECEPTION"
                  ? "استقبال"
                  : dr.shiftType === "PRINT_SERVICES"
                    ? "طباعة"
                    : dr.shiftType;

            return (
              <button
                key={dr.shiftId}
                type="button"
                onClick={() => setSelectedShiftId(dr.shiftId)}
                className={cn(
                  "w-full p-2 rounded-md border text-right transition-all flex flex-col gap-1 cursor-pointer text-xs",
                  isSelected
                    ? "border-emerald-600 bg-white dark:bg-card ring-1 ring-emerald-500 font-bold shadow-xs"
                    : "border-border/70 hover:bg-background/80 bg-background/50 text-foreground",
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-bold">
                    <span>{dr.userName}</span>
                    <Badge
                      variant="outline"
                      className="text-[9px] py-0 px-1 font-normal"
                    >
                      {shiftTypeLabel}
                    </Badge>
                    {dr.isMine && (
                      <Badge className="text-[9px] py-0 px-1 bg-emerald-600 text-white hover:bg-emerald-700 font-normal">
                        درجي
                      </Badge>
                    )}
                  </div>
                  {isSelected && (
                    <CheckCircle2 className="size-3.5 text-emerald-600" />
                  )}
                </div>
                <div className="flex items-center justify-between text-[11px] font-normal">
                  <span className="text-muted-foreground">النقد بالدرج:</span>
                  <span
                    className={cn(
                      "font-mono font-bold",
                      isLow
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-emerald-700 dark:text-emerald-400",
                    )}
                  >
                    {fmt(dr.expectedCash)} د.ع
                  </span>
                </div>
                {isLow && isSelected && (
                  <div className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
                    <AlertCircle className="size-3 shrink-0" />
                    <span>
                      تنبيه: النقد بالدرج أقل من صافي مبلغ المرتجع (
                      {fmt(String(effectiveCashOrCardRefund))} د.ع)
                    </span>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
