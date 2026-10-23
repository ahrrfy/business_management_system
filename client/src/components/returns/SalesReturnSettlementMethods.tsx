import { AlertCircle, CheckCircle2, Ticket, Wallet, Scale } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import { CardBrandLogos } from "@/components/ui/CardBrandLogos";
import type { SalesReturnPortalModel } from "./useSalesReturnPortal";
import { SalesReturnCashDrawers } from "./SalesReturnCashDrawers";
type Props = Pick<
  SalesReturnPortalModel,
  | "salesRefundMethod"
  | "setSalesRefundMethod"
  | "salesCardRef"
  | "setSalesCardRef"
  | "openDrawersQ"
  | "openDrawers"
  | "selectedShiftId"
  | "setSelectedShiftId"
  | "inspectedInvoice"
  | "salesTotal"
  | "effectiveCashOrCardRefund"
>;
export function SalesReturnSettlementMethods({
  salesRefundMethod,
  setSalesRefundMethod,
  salesCardRef,
  setSalesCardRef,
  openDrawersQ,
  openDrawers,
  selectedShiftId,
  setSelectedShiftId,
  inspectedInvoice,
  salesTotal,
  effectiveCashOrCardRefund,
}: Props) {
  return (
    <div className="space-y-2">
      <label className="text-xs font-bold text-foreground">
        طريقة الاسترداد المالي
      </label>
      <div className="space-y-2">
        {/* خيار معادلة الذمم (للفواتير الآجلة أو تصفية الحساب) */}
        <button
          type="button"
          onClick={() => setSalesRefundMethod("CREDIT_OFFSET")}
          className={cn(
            "w-full p-3 rounded-lg border text-right transition-all flex items-center justify-between text-xs cursor-pointer",
            salesRefundMethod === "CREDIT_OFFSET"
              ? "border-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 font-bold text-emerald-900 dark:text-emerald-200"
              : "border-border hover:bg-muted/50 text-foreground",
          )}
        >
          <div className="flex items-center gap-2.5">
            <Scale className="size-4 text-emerald-600" />
            <div>
              <div className="flex items-center gap-1.5">
                <span>معادلة ذمم (إنقاص ذمة العميل / تسوية الآجل)</span>
                {inspectedInvoice &&
                  Number(inspectedInvoice.paidAmount || 0) <= 0 && (
                    <Badge
                      variant="outline"
                      className="text-[9px] px-1 py-0 border-emerald-500 text-emerald-700 bg-emerald-50/50"
                    >
                      موصى به (فاتورة آجلة)
                    </Badge>
                  )}
              </div>
              <div className="text-[10px] text-muted-foreground font-normal">
                يُخصم مباشرة من رصيد ذمة العميل في حسابه دون صرف نقد من الدرج
              </div>
            </div>
          </div>
          {salesRefundMethod === "CREDIT_OFFSET" && (
            <CheckCircle2 className="size-4 text-emerald-600" />
          )}
        </button>

        {salesRefundMethod === "CREDIT_OFFSET" && (
          <div className="p-2.5 rounded-lg border border-emerald-200 dark:border-emerald-800/60 bg-emerald-50/50 dark:bg-emerald-950/20 space-y-1.5 text-xs">
            <div className="flex items-center justify-between text-[11px] font-bold text-emerald-900 dark:text-emerald-300">
              <span className="flex items-center gap-1.5">
                <Scale className="size-3.5 text-emerald-600" />
                تسوية الحساب الآجل للعميل
              </span>
              {inspectedInvoice?.customerBalance != null && (
                <span className="text-[10px] text-muted-foreground font-mono">
                  رصيد الذمة الحالي: {fmt(inspectedInvoice.customerBalance)} د.ع
                </span>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {inspectedInvoice ? (
                <span>
                  سيتم إلغاء مديونية الفاتورة بقيمة ({fmt(String(salesTotal))}{" "}
                  د.ع) وتنزيلها ذرياً من رصيد ذمة العميل [
                  {inspectedInvoice.customerName || "العميل"}] دون أي صرف نقد من
                  الدرج.
                </span>
              ) : (
                <span>
                  اختر أو ابحث عن العميل أعلاه لربط المرتجع بحسابه وتخفيض ذمته
                  بمبلغ المرتجع.
                </span>
              )}
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => setSalesRefundMethod("CASH")}
          className={cn(
            "w-full p-3 rounded-lg border text-right transition-all flex items-center justify-between text-xs cursor-pointer",
            salesRefundMethod === "CASH"
              ? "border-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 font-bold text-emerald-900 dark:text-emerald-200"
              : "border-border hover:bg-muted/50 text-foreground",
          )}
        >
          <div className="flex items-center gap-2.5">
            <Wallet className="size-4 text-emerald-600" />
            <div>
              <div className="flex items-center gap-1.5">
                <span>صرف نقدي كاش (من الصندوق)</span>
                {inspectedInvoice &&
                  Number(inspectedInvoice.paidAmount || 0) <= 0 && (
                    <Badge
                      variant="destructive"
                      className="text-[9px] px-1 py-0"
                    >
                      غير متاح (المدفوع 0 د.ع)
                    </Badge>
                  )}
              </div>
              <div className="text-[10px] text-muted-foreground font-normal">
                يصرف نقداً ويُسجل كحركة خروج نقد من الدرج
              </div>
            </div>
          </div>
          {salesRefundMethod === "CASH" && (
            <CheckCircle2 className="size-4 text-emerald-600" />
          )}
        </button>

        {salesRefundMethod === "CASH" &&
          inspectedInvoice &&
          Number(inspectedInvoice.paidAmount || 0) <= 0 && (
            <div className="p-2 rounded border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 text-[11px] flex items-start gap-1.5">
              <AlertCircle className="size-3.5 shrink-0 mt-0.5 text-amber-600" />
              <span>
                تنبيه محاسبي: الفاتورة آجلة بالكامل (المدفوع 0 د.ع). لا يمكن صرف
                نقد من الدرج لعميل لم يدفع. يرجى اختيار [معادلة ذمم] لتسوية رصيد
                العميل.
              </span>
            </div>
          )}

        {salesRefundMethod === "CASH" && (
          <SalesReturnCashDrawers
            {...{
              openDrawersQ,
              openDrawers,
              selectedShiftId,
              setSelectedShiftId,
              effectiveCashOrCardRefund,
            }}
          />
        )}

        <button
          type="button"
          onClick={() => setSalesRefundMethod("CARD")}
          className={cn(
            "w-full p-3 rounded-lg border text-right transition-all flex items-center justify-between text-xs cursor-pointer",
            salesRefundMethod === "CARD"
              ? "border-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 font-bold text-emerald-900 dark:text-emerald-200"
              : "border-border hover:bg-muted/50 text-foreground",
          )}
        >
          <div className="flex items-center gap-2.5">
            <CardBrandLogos size="sm" />
            <div>
              <div>استرداد بنكي / بطاقة</div>
              <div className="text-[10px] text-muted-foreground font-normal">
                إرجاع للبطاقة البنكية مع تسجيل المرجع
              </div>
            </div>
          </div>
          {salesRefundMethod === "CARD" && (
            <CheckCircle2 className="size-4 text-emerald-600" />
          )}
        </button>

        {salesRefundMethod === "CARD" && (
          <div className="pr-4 pl-1">
            <Input
              value={salesCardRef}
              onChange={(e) => setSalesCardRef(e.target.value)}
              placeholder="رقم مرجع العملية بالبطاقة (اختياري)..."
              className="h-8 text-xs font-mono"
            />
          </div>
        )}

        <button
          type="button"
          onClick={() => setSalesRefundMethod("STORE_CREDIT")}
          className={cn(
            "w-full p-3 rounded-lg border text-right transition-all flex items-center justify-between text-xs cursor-pointer",
            salesRefundMethod === "STORE_CREDIT"
              ? "border-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 font-bold text-emerald-900 dark:text-emerald-200"
              : "border-border hover:bg-muted/50 text-foreground",
          )}
        >
          <div className="flex items-center gap-2.5">
            <Ticket className="size-4 text-emerald-600" />
            <div>
              <div>رصيد متجر (Store Credit)</div>
              <div className="text-[10px] text-muted-foreground font-normal">
                إيداع رصيد بحساب العميل للمشتريات القادمة
              </div>
            </div>
          </div>
          {salesRefundMethod === "STORE_CREDIT" && (
            <CheckCircle2 className="size-4 text-emerald-600" />
          )}
        </button>
      </div>
    </div>
  );
}
