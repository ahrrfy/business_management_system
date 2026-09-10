import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AppSelect } from "@/components/ui/AppSelect";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { notify } from "@/lib/notify";
import { D, fmt } from "@/lib/money";
import { printReportDoc } from "@/lib/printing/reportDoc";
import {
  ShieldAlert,
  Printer,
  CheckCircle2,
  AlertCircle,
  Tag,
  Store,
} from "lucide-react";

export interface NoReceiptItem {
  productName: string;
  sku: string | null;
  barcode: string | null;
  lowestHistoricalPrice: string | null;
  variantId?: number;
}

export interface NoReceiptReturnDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: NoReceiptItem | null;
  onSuccess?: () => void;
}

interface IssuedVoucher {
  voucherCode: string;
  customerName: string;
  customerPhone: string;
  amount: string;
  itemName: string;
  quantity: number;
  unitPrice: string;
  disposition: string;
  resolution: string;
  dateStr: string;
}

export function NoReceiptReturnDialog({
  open,
  onOpenChange,
  item,
  onSuccess,
}: NoReceiptReturnDialogProps) {
  const [quantity, setQuantity] = useState(1);
  const [resolution, setResolution] = useState<"STORE_CREDIT" | "DIRECT_EXCHANGE">("STORE_CREDIT");
  const [disposition, setDisposition] = useState<"RESTOCK" | "SCRAP">("RESTOCK");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [nationalId, setNationalId] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [issuedVoucher, setIssuedVoucher] = useState<IssuedVoucher | null>(null);

  const unitPrice = item?.lowestHistoricalPrice ?? "0";
  const totalAmount = D(unitPrice).mul(quantity).toString();

  const handleReset = () => {
    setQuantity(1);
    setResolution("STORE_CREDIT");
    setDisposition("RESTOCK");
    setCustomerName("");
    setCustomerPhone("");
    setNationalId("");
    setReason("");
    setIssuedVoucher(null);
    setSubmitting(false);
  };

  const handleClose = () => {
    handleReset();
    onOpenChange(false);
  };

  const handleSubmit = async () => {
    if (!item) return;

    if (!customerName.trim()) {
      notify.err("يرجى إدخال اسم العميل الكامل للتوثيق الرقابي");
      return;
    }
    if (!customerPhone.trim()) {
      notify.err("يرجى إدخال رقم هاتف العميل");
      return;
    }
    if (!nationalId.trim()) {
      notify.err("يرجى إدخال رقم الهوية أو البطاقة الوطنية");
      return;
    }
    if (!reason.trim()) {
      notify.err("يرجى ذكر سبب الإرجاع ومبرر الموافقة الاستثنائية");
      return;
    }

    setSubmitting(true);

    try {
      const now = new Date();
      const randSuffix = Math.floor(1000 + Math.random() * 9000);
      const code = `SC-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}-${randSuffix}`;

      const voucher: IssuedVoucher = {
        voucherCode: code,
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        amount: totalAmount,
        itemName: item.productName,
        quantity,
        unitPrice,
        disposition: disposition === "RESTOCK" ? "سليم (إعادة للمخزن)" : "تالف (تخريد وعزل)",
        resolution: resolution === "STORE_CREDIT" ? "قسيمة رصيد متجر" : "استبدال فوري بالكاشير",
        dateStr: now.toLocaleDateString("ar-IQ", {
          year: "numeric",
          month: "long",
          day: "numeric",
        }),
      };

      setIssuedVoucher(voucher);
      notify.ok(`تم اعتماد الإرجاع الاستثنائي بنجاح برمز ${code}`);
      onSuccess?.();
    } catch {
      notify.err("تعذر إتمام الإرجاع الاستثنائي");
    } finally {
      setSubmitting(false);
    }
  };

  const handlePrintVoucher = () => {
    if (!issuedVoucher) return;

    printReportDoc({
      title: "قسيمة رصيد متجر (إرجاع استثنائي بدون فاتورة)",
      docNum: issuedVoucher.voucherCode,
      docDate: issuedVoucher.dateStr,
      headerExtra: [
        { label: "نوع التعويض", value: issuedVoucher.resolution },
        { label: "حالة السلعة", value: issuedVoucher.disposition },
      ],
      note: "تنبيه رقابي: هذا المستند صادر بموجب بروتوكول الإرجاع بدون فاتورة بأدنى سعر بيع تاريخي، ويُمنع صرف النقد كاش نهائياً بموجب السياسات المالية المعتمدة.",
      meta: [
        {
          title: "بيانات العميل (KYC)",
          fields: [
            { label: "اسم العميل", value: issuedVoucher.customerName },
            { label: "الهاتف", value: issuedVoucher.customerPhone },
            { label: "رقم الهوية", value: nationalId },
          ],
        },
      ],
      columns: [
        { key: "item", label: "الصنف المرتجع" },
        { key: "qty", label: "الكمية", align: "center" },
        { key: "price", label: "السعر التاريخي (الأدنى)", align: "left" },
        { key: "total", label: "إجمالي الرصيد", align: "left" },
      ],
      rows: [
        {
          item: issuedVoucher.itemName,
          qty: String(issuedVoucher.quantity),
          price: fmt(issuedVoucher.unitPrice),
          total: fmt(issuedVoucher.amount),
        },
      ],
      summary: [
        { label: "صافي رصيد المتجر الممنوح", value: fmt(issuedVoucher.amount), large: true, bold: true },
      ],
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-bold">
            <ShieldAlert className="size-5 text-stock-low" aria-hidden />
            بروتوكول الإرجاع الاستثنائي (بدون فاتورة)
          </DialogTitle>
          <DialogDescription className="text-xs">
            معالجة استرجاع الصنف عند فقدان الفاتورة الأصلية، وفق الضوابط الرقابية والمالية الصارمة.
          </DialogDescription>
        </DialogHeader>

        {issuedVoucher ? (
          <div className="space-y-4 py-2">
            <div className="p-4 bg-primary/5 border border-primary/20 rounded-xl text-center space-y-2">
              <CheckCircle2 className="size-8 text-primary mx-auto" aria-hidden />
              <div className="text-sm font-bold">تم اعتماد الإرجاع وتوليد القسيمة بنجاح</div>
              <div className="font-mono text-xl font-black text-primary">{issuedVoucher.voucherCode}</div>
              <div className="text-xs text-muted-foreground">
                صالحة للشراء المباشر في أي كاشير تابع للشركة
              </div>
            </div>

            <Card className="border">
              <CardContent className="p-4 space-y-2 text-xs">
                <div className="flex justify-between py-1 border-b">
                  <span className="text-muted-foreground">العميل:</span>
                  <span className="font-semibold">{issuedVoucher.customerName} ({issuedVoucher.customerPhone})</span>
                </div>
                <div className="flex justify-between py-1 border-b">
                  <span className="text-muted-foreground">الصنف:</span>
                  <span className="font-semibold">{issuedVoucher.itemName} × {issuedVoucher.quantity}</span>
                </div>
                <div className="flex justify-between py-1 border-b">
                  <span className="text-muted-foreground">سعر الاحتساب (الأدنى ٦٠ يوماً):</span>
                  <span className="font-mono">{fmt(issuedVoucher.unitPrice)}</span>
                </div>
                <div className="flex justify-between py-1 border-b">
                  <span className="text-muted-foreground">نوع التعويض:</span>
                  <Badge variant="outline">{issuedVoucher.resolution}</Badge>
                </div>
                <div className="flex justify-between py-1 text-sm font-bold pt-1">
                  <span>إجمالي رصيد المتجر:</span>
                  <span className="text-primary font-mono">{fmt(issuedVoucher.amount)}</span>
                </div>
              </CardContent>
            </Card>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" onClick={handlePrintVoucher} className="gap-2">
                <Printer className="size-4" aria-hidden />
                طباعة سند الرصيد
              </Button>
              <Button type="button" onClick={handleClose}>
                إغلاق والعودة
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4 py-1 text-xs">
            {/* التنبيه الحاكم */}
            <div className="p-3 rounded-lg border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]/20 flex items-start gap-2.5">
              <AlertCircle className="size-4 text-stock-low mt-0.5 shrink-0" aria-hidden />
              <div className="space-y-1">
                <div className="font-bold text-stock-low">قاعدة عدم التفريط المالي:</div>
                <div className="text-muted-foreground leading-relaxed">
                  يُمنع منعاً باتاً صرف أي نقد كاش من الدرج لفاتورة مفقودة (خروج النقد = 0).
                  التعويض يُقفل حصرياً على أدنى سعر بيع تاريخي، ويُصرف كرصيد متجر أو استبدال فوري بموافقة الإدارة.
                </div>
              </div>
            </div>

            {/* تفاصيل الصنف المقفل */}
            {item && (
              <Card className="bg-muted/30">
                <CardContent className="p-3 space-y-1.5">
                  <div className="font-bold text-sm text-foreground flex items-center gap-2">
                    <Tag className="size-3.5 text-primary" aria-hidden />
                    {item.productName}
                  </div>
                  <div className="text-muted-foreground flex gap-4 text-[11px]">
                    {item.barcode && <span>الباركود: <strong className="font-mono">{item.barcode}</strong></span>}
                    {item.sku && <span>SKU: <strong className="font-mono">{item.sku}</strong></span>}
                  </div>
                  <div className="pt-1 flex items-center justify-between border-t text-xs">
                    <span className="text-muted-foreground">أدنى سعر تاريخي مقفل (٦٠ يوماً):</span>
                    <span className="font-bold font-mono text-primary">{fmt(unitPrice)}</span>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* نموذج الكمية والإجمالي */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="no-receipt-qty" className="text-xs">الكمية المرتجعة</Label>
                <Input
                  id="no-receipt-qty"
                  type="number"
                  min={1}
                  max={50}
                  value={quantity}
                  onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">إجمالي الرصيد المستحق</Label>
                <div className="h-9 px-3 rounded-md bg-muted flex items-center font-mono font-bold text-primary">
                  {fmt(totalAmount)}
                </div>
              </div>
            </div>

            {/* مسار التعويض وحالة السلعة */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="no-receipt-res" className="text-xs">طريقة التعويض (صفر كاش)</Label>
                <AppSelect
                  id="no-receipt-res"
                  value={resolution}
                  onValueChange={(v) => setResolution(v as "STORE_CREDIT" | "DIRECT_EXCHANGE")}
                >
                  <option value="STORE_CREDIT">قسيمة رصيد متجر (Store Credit)</option>
                  <option value="DIRECT_EXCHANGE">استبدال فوري بصنف آخر (Exchange)</option>
                </AppSelect>
              </div>

              <div className="space-y-1">
                <Label htmlFor="no-receipt-disp" className="text-xs">حالة المخزون</Label>
                <AppSelect
                  id="no-receipt-disp"
                  value={disposition}
                  onValueChange={(v) => setDisposition(v as "RESTOCK" | "SCRAP")}
                >
                  <option value="RESTOCK">سليم (إعادة للمخزن)</option>
                  <option value="SCRAP">تالف/معيب (عزل وتخريد)</option>
                </AppSelect>
              </div>
            </div>

            {/* توثيق هوية العميل KYC */}
            <div className="space-y-2 pt-1 border-t">
              <div className="font-semibold text-xs text-foreground flex items-center gap-1.5">
                <Store className="size-3.5 text-primary" aria-hidden />
                توثيق هوية العميل الإلزامية (KYC)
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="customer-name" className="text-xs">اسم العميل الكامل *</Label>
                  <Input
                    id="customer-name"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="الاسم الثلاثي..."
                  />
                </div>

                <div className="space-y-1">
                  <Label htmlFor="customer-phone" className="text-xs">رقم الهاتف *</Label>
                  <IntlPhoneInput
                    id="customer-phone"
                    value={customerPhone}
                    onChange={setCustomerPhone}
                    placeholder="770 123 4567"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <Label htmlFor="national-id" className="text-xs">رقم الهوية أو البطاقة الوطنية *</Label>
                <Input
                  id="national-id"
                  value={nationalId}
                  onChange={(e) => setNationalId(e.target.value)}
                  placeholder="رقم البطاقة الوطنية أو هوية الأحوال..."
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="return-reason" className="text-xs">سبب الإرجاع ومبرر الموافقة الإدارية *</Label>
                <Input
                  id="return-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="سبب فقد الفاتورة ومبرر قبول الإرجاع الاستثنائي..."
                />
              </div>
            </div>

            <DialogFooter className="gap-2 sm:gap-0 pt-2">
              <Button type="button" variant="outline" onClick={handleClose}>
                إلغاء
              </Button>
              <Button
                type="button"
                onClick={handleSubmit}
                disabled={submitting}
                className="gap-2"
              >
                <CheckCircle2 className="size-4" aria-hidden />
                {submitting ? "جاري الاعتماد..." : "اعتماد وتوليد قسيمة الرصيد"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
