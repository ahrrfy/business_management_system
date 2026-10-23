import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { cn } from "@/lib/utils";
import type { SalesReturnPortalModel } from "./useSalesReturnPortal";

type Props = Pick<
  SalesReturnPortalModel,
  | "salesInvoiceNo"
  | "setSalesInvoiceNo"
  | "salesCustomerName"
  | "setSalesCustomerName"
  | "setSalesCustomerPhone"
  | "salesCustomerId"
  | "setSalesCustomerId"
  | "salesCustomerSearch"
  | "setSalesCustomerSearch"
  | "debouncedCustomerSearch"
  | "customersQuery"
  | "salesDisposition"
  | "setSalesDisposition"
  | "salesReason"
  | "setSalesReason"
  | "setInspectedInvoice"
  | "invoiceLookupLoading"
  | "handleLookupInvoice"
>;
export function SalesReturnSourceFields({
  salesInvoiceNo,
  setSalesInvoiceNo,
  salesCustomerName,
  setSalesCustomerName,
  setSalesCustomerPhone,
  salesCustomerId,
  setSalesCustomerId,
  salesCustomerSearch,
  setSalesCustomerSearch,
  debouncedCustomerSearch,
  customersQuery,
  salesDisposition,
  setSalesDisposition,
  salesReason,
  setSalesReason,
  setInspectedInvoice,
  invoiceLookupLoading,
  handleLookupInvoice,
}: Props) {
  return (
    <Card className="shadow-xs border-emerald-500/20">
      <CardContent className="p-3">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2.5 items-end">
          {/* حقل الفاتورة الأصلية (اختياري) */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-semibold text-foreground">
                رقم الفاتورة (اختياري)
              </label>
              {salesInvoiceNo && (
                <button
                  type="button"
                  onClick={() => {
                    setSalesInvoiceNo("");
                    setInspectedInvoice(null);
                  }}
                  className="text-[10px] text-muted-foreground hover:text-destructive"
                >
                  مسح
                </button>
              )}
            </div>
            <div className="flex gap-1">
              <Input
                value={salesInvoiceNo}
                onChange={(e) => setSalesInvoiceNo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleLookupInvoice();
                  }
                }}
                placeholder="INV-1002 أو 1002..."
                className="h-8.5 text-xs"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void handleLookupInvoice()}
                disabled={invoiceLookupLoading || !salesInvoiceNo.trim()}
                className="h-8.5 shrink-0 text-xs px-2.5"
              >
                {invoiceLookupLoading ? "فحص..." : "فحص"}
              </Button>
            </div>
          </div>

          {/* حقل العميل والـ CRM الذكي */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-semibold text-foreground">
                العميل / CRM (اختياري)
              </label>
              {salesCustomerId && (
                <button
                  type="button"
                  onClick={() => {
                    setSalesCustomerId(null);
                    setSalesCustomerName("");
                    setSalesCustomerPhone("");
                  }}
                  className="text-[10px] text-muted-foreground hover:text-destructive"
                >
                  إلغاء
                </button>
              )}
            </div>
            <div className="relative">
              <UnifiedSearchInput
                barcode={false}
                debounceMs={0}
                value={salesCustomerSearch || salesCustomerName}
                onChange={(val) => {
                  setSalesCustomerSearch(val);
                  setSalesCustomerName(val);
                  if (salesCustomerId) setSalesCustomerId(null);
                }}
                placeholder="اسم العميل أو ابحث في الـ CRM..."
                className="h-8.5 text-xs"
              />
              {debouncedCustomerSearch.length >= 2 &&
                customersQuery.data &&
                customersQuery.data.length > 0 &&
                !salesCustomerId && (
                  <div className="absolute z-30 top-full mt-1 right-0 left-0 bg-popover border rounded-lg shadow-lg p-1 max-h-44 overflow-auto">
                    {customersQuery.data.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setSalesCustomerId(c.id);
                          setSalesCustomerName(c.name);
                          setSalesCustomerPhone(c.phone || "");
                          setSalesCustomerSearch("");
                        }}
                        className="w-full text-right p-1.5 text-xs rounded hover:bg-muted flex items-center justify-between"
                      >
                        <span className="font-semibold">{c.name}</span>
                        <span className="text-muted-foreground font-mono text-[11px]">
                          {c.phone || "—"}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
            </div>
          </div>

          {/* المسار المخزني للصنف: رجوع للرف أو تالف */}
          <div className="space-y-1">
            <label className="text-[11px] font-semibold text-foreground">
              المسار المخزني للصنف
            </label>
            <div className="grid grid-cols-2 gap-1 bg-muted/40 p-0.5 rounded-lg border">
              <button
                type="button"
                onClick={() => setSalesDisposition("RESTOCK")}
                className={cn(
                  "h-7 px-2 rounded-md text-[11px] font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer",
                  salesDisposition === "RESTOCK"
                    ? "bg-emerald-600 text-white shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <RotateCcw className="size-3" aria-hidden />
                <span>رجوع للرف</span>
              </button>

              <button
                type="button"
                onClick={() => setSalesDisposition("DAMAGED")}
                className={cn(
                  "h-7 px-2 rounded-md text-[11px] font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer",
                  salesDisposition === "DAMAGED"
                    ? "bg-amber-600 text-white shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <AlertTriangle className="size-3" aria-hidden />
                <span>تالف (خسارة)</span>
              </button>
            </div>
          </div>

          {/* سبب الإرجاع */}
          <div className="space-y-1">
            <label className="text-[11px] font-semibold text-foreground">
              سبب الإرجاع / ملاحظة
            </label>
            <Input
              value={salesReason}
              onChange={(e) => setSalesReason(e.target.value)}
              placeholder="رغبة العميل، مقاس، عيب مصنعي..."
              className="h-8.5 text-xs"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
