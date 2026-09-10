import { useEffect, useMemo, useRef, useState } from "react";
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
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { notify } from "@/lib/notify";
import { D, fmt } from "@/lib/money";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { playReadyBeep } from "@/lib/notifyBeep";
import { trpc } from "@/lib/trpc";
import {
  ShieldAlert,
  Printer,
  CheckCircle2,
  AlertCircle,
  Store,
  Barcode,
  ArrowRightLeft,
  Receipt,
  Plus,
  Minus,
  Trash2,
  Sparkles,
  Banknote,
  CreditCard,
} from "lucide-react";
import { cn } from "@/lib/utils";

const NO_RECEIPT_REASONS = [
  "فاتورة مفقودة - هدية من قريب",
  "فاتورة تالفة أو ممسوحة حرارياً",
  "شراء نقدي قديم بدون وصل ورقي",
  "استبدال مباشر بعد الشراء",
  "عيب مصنعي أو خلل بالصنف",
];

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

export interface BasketReturnItem {
  key: string;
  variantId: number;
  productUnitId?: number;
  productName: string;
  unitName: string;
  barcode?: string | null;
  sku?: string | null;
  quantity: number;
  unitPrice: string;
  disposition: "RESTOCK" | "SCRAP";
}

export interface BasketExchangeItem {
  key: string;
  variantId: number;
  productUnitId?: number;
  productName: string;
  unitName: string;
  barcode?: string | null;
  sku?: string | null;
  quantity: number;
  unitPrice: string;
}

interface IssuedExecutionDoc {
  voucherCode: string;
  mode: "STORE_CREDIT" | "DIRECT_EXCHANGE";
  customerName: string;
  customerPhone?: string | null;
  returnTotal: string;
  exchangeTotal: string;
  differenceAmount: string;
  returnItems: BasketReturnItem[];
  exchangeItems: BasketExchangeItem[];
  dateStr: string;
  reason: string;
}

export function NoReceiptReturnDialog({
  open,
  onOpenChange,
  item,
  onSuccess,
}: NoReceiptReturnDialogProps) {
  const utils = trpc.useUtils();

  const [mode, setMode] = useState<"STORE_CREDIT" | "DIRECT_EXCHANGE">("STORE_CREDIT");
  const [returnItems, setReturnItems] = useState<BasketReturnItem[]>([]);
  const [exchangeItems, setExchangeItems] = useState<BasketExchangeItem[]>([]);

  const [returnBarcode, setReturnBarcode] = useState("");
  const [exchangeBarcode, setExchangeBarcode] = useState("");
  const [isScanningReturn, setIsScanningReturn] = useState(false);
  const [isScanningExchange, setIsScanningExchange] = useState(false);

  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [reason, setReason] = useState("");

  const [paymentMethod, setPaymentMethod] = useState<"CASH" | "CARD">("CASH");
  const [selectedShiftId, setSelectedShiftId] = useState<number | null>(null);

  const [issuedDoc, setIssuedDoc] = useState<IssuedExecutionDoc | null>(null);

  const returnInputRef = useRef<HTMLInputElement>(null);
  const exchangeInputRef = useRef<HTMLInputElement>(null);

  // استعلام الورديات المفتوحة للفرع
  const shiftsQuery = trpc.returns.shifts.useQuery(undefined, { enabled: open });
  const openShifts = shiftsQuery.data ?? [];

  useEffect(() => {
    if (openShifts.length > 0 && selectedShiftId == null) {
      setSelectedShiftId(Number(openShifts[0].shiftId));
    }
  }, [openShifts, selectedShiftId]);

  // تهيئة النافذة عند الفتح
  useEffect(() => {
    if (!open) return;
    if (item && returnItems.length === 0) {
      setReturnItems([
        {
          key: crypto.randomUUID(),
          variantId: item.variantId ?? 1,
          productName: item.productName,
          unitName: "قطعة",
          barcode: item.barcode,
          sku: item.sku,
          quantity: 1,
          unitPrice: item.lowestHistoricalPrice ?? "0",
          disposition: "RESTOCK",
        },
      ]);
    }
  }, [open, item]); // eslint-disable-line react-hooks/exhaustive-deps

  // الحسابات المالية
  const returnTotal = useMemo(() => {
    return returnItems.reduce(
      (acc, itm) => D(acc).plus(D(itm.unitPrice).mul(itm.quantity)).toString(),
      "0"
    );
  }, [returnItems]);

  const exchangeTotal = useMemo(() => {
    return exchangeItems.reduce(
      (acc, itm) => D(acc).plus(D(itm.unitPrice).mul(itm.quantity)).toString(),
      "0"
    );
  }, [exchangeItems]);

  // فرق التسوية: البديل الجديد - المرتجع
  const differenceAmount = useMemo(() => {
    if (mode === "STORE_CREDIT") {
      return D(returnTotal).neg().toString();
    }
    return D(exchangeTotal).minus(returnTotal).toString();
  }, [mode, returnTotal, exchangeTotal]);

  const customerOwes = D(differenceAmount).gt(0);
  const customerGetsCredit = D(differenceAmount).lt(0);

  const handleReset = () => {
    setMode("STORE_CREDIT");
    setReturnItems([]);
    setExchangeItems([]);
    setReturnBarcode("");
    setExchangeBarcode("");
    setCustomerName("");
    setCustomerPhone("");
    setReason("");
    setIssuedDoc(null);
  };

  const handleClose = () => {
    handleReset();
    onOpenChange(false);
  };

  // مسح باركود صنف المرتجع
  const handleScanReturnItem = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const code = returnBarcode.trim();
    if (!code) return;

    setIsScanningReturn(true);
    try {
      const res = await utils.returns.lookupItemForReturn.fetch({ barcode: code });
      if (!res) {
        notify.err("لم يُعثر على صنف بهذا الباركود أو الرمز");
        return;
      }

      setReturnItems((prev) => {
        const existingIdx = prev.findIndex((i) => i.variantId === res.variantId);
        if (existingIdx >= 0) {
          const next = [...prev];
          next[existingIdx] = { ...next[existingIdx], quantity: next[existingIdx].quantity + 1 };
          return next;
        }
        return [
          ...prev,
          {
            key: crypto.randomUUID(),
            variantId: res.variantId,
            productUnitId: res.productUnitId,
            productName: res.productName,
            unitName: res.unitName,
            barcode: res.barcode,
            sku: res.sku,
            quantity: 1,
            unitPrice: res.lowestHistoricalPrice || res.retailPrice || "0",
            disposition: "RESTOCK",
          },
        ];
      });

      playReadyBeep();
      notify.ok(`أُضيف للسلة: ${res.productName}`);
      setReturnBarcode("");
      returnInputRef.current?.focus();
    } catch {
      notify.err("تعذر البحث عن الصنف بالباركود");
    } finally {
      setIsScanningReturn(false);
    }
  };

  // مسح باركود صنف الاستبدال (البديل الجديد)
  const handleScanExchangeItem = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const code = exchangeBarcode.trim();
    if (!code) return;

    setIsScanningExchange(true);
    try {
      const res = await utils.returns.lookupItemForReturn.fetch({ barcode: code });
      if (!res) {
        notify.err("لم يُعثر على صنف بديل بهذا الباركود");
        return;
      }

      setExchangeItems((prev) => {
        const existingIdx = prev.findIndex((i) => i.variantId === res.variantId);
        if (existingIdx >= 0) {
          const next = [...prev];
          next[existingIdx] = { ...next[existingIdx], quantity: next[existingIdx].quantity + 1 };
          return next;
        }
        return [
          ...prev,
          {
            key: crypto.randomUUID(),
            variantId: res.variantId,
            productUnitId: res.productUnitId,
            productName: res.productName,
            unitName: res.unitName,
            barcode: res.barcode,
            sku: res.sku,
            quantity: 1,
            unitPrice: res.retailPrice || "0",
          },
        ];
      });

      playReadyBeep();
      notify.ok(`أُضيف كبديل: ${res.productName}`);
      setExchangeBarcode("");
      exchangeInputRef.current?.focus();
    } catch {
      notify.err("تعذر جلب الصنف البديل");
    } finally {
      setIsScanningExchange(false);
    }
  };

  // طفرة التنفيذ الخلفي
  const executeMutation = trpc.returns.executeNoReceiptOrExchange.useMutation({
    onSuccess: (res) => {
      notify.ok(
        mode === "DIRECT_EXCHANGE"
          ? `تم تنفيذ الاستبدال المباشر بنجاح برمز ${res.voucherCode}`
          : `تم اعتماد الإرجاع وتوليد قسيمة الرصيد برمز ${res.voucherCode}`
      );
      setIssuedDoc({
        voucherCode: res.voucherCode,
        mode: res.mode,
        customerName: res.customerName,
        customerPhone: res.customerPhone,
        returnTotal: res.returnTotal,
        exchangeTotal: res.exchangeTotal,
        differenceAmount: res.differenceAmount,
        returnItems,
        exchangeItems,
        dateStr: res.dateStr,
        reason: reason.trim() || (mode === "DIRECT_EXCHANGE" ? "استبدال مباشر بضاعة" : "إرجاع بضاعة بدون فاتورة"),
      });
      onSuccess?.();
    },
    onError: (err) => notify.err(err.message),
  });

  const handleSubmit = async () => {
    if (returnItems.length === 0) {
      notify.err("يرجى إضافة صنف واحد على الأقل إلى سلة المرتجعات");
      return;
    }
    if (mode === "DIRECT_EXCHANGE" && exchangeItems.length === 0) {
      notify.err("يرجى إضافة صنف بديل واحد على الأقل إلى سلة الاستبدال");
      return;
    }

    executeMutation.mutate({
      mode,
      returnItems: returnItems.map((i) => ({
        variantId: i.variantId,
        productUnitId: i.productUnitId,
        productName: i.productName,
        barcode: i.barcode ?? undefined,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        disposition: i.disposition,
      })),
      exchangeItems:
        mode === "DIRECT_EXCHANGE"
          ? exchangeItems.map((i) => ({
              variantId: i.variantId,
              productUnitId: i.productUnitId,
              productName: i.productName,
              barcode: i.barcode ?? undefined,
              quantity: i.quantity,
              unitPrice: i.unitPrice,
            }))
          : undefined,
      customer: {
        name: customerName.trim() || undefined,
        phone: customerPhone.trim() || undefined,
      },
      reason: reason.trim() || undefined,
      settlement: {
        returnTotal,
        exchangeTotal: mode === "DIRECT_EXCHANGE" ? exchangeTotal : undefined,
        differenceAmount,
        paymentMethod: customerOwes ? paymentMethod : undefined,
        shiftId: customerOwes && paymentMethod === "CASH" ? selectedShiftId ?? undefined : undefined,
      },
    });
  };

  const handlePrintDoc = () => {
    if (!issuedDoc) return;

    printReportDoc({
      title:
        issuedDoc.mode === "DIRECT_EXCHANGE"
          ? "سند استبدال بضاعة وتسوية فورية (بدون فاتورة)"
          : "قسيمة رصيد متجر (إرجاع استثنائي بدون فاتورة)",
      docNum: issuedDoc.voucherCode,
      docDate: issuedDoc.dateStr,
      headerExtra: [
        {
          label: "نوع العملية",
          value: issuedDoc.mode === "DIRECT_EXCHANGE" ? "استبدال فوري مباشر" : "إرجاع وقسيمة رصيد",
        },
        { label: "السبب المعتمد", value: issuedDoc.reason },
      ],
      note: "وثيقة رقابية معتمدة من نظام الرؤية العربية. تضمن حركة المخزون الذرية وتسوية الذمم الرسمية.",
      meta: [
        {
          title: "بيانات الزبون",
          fields: [
            { label: "الزبون", value: issuedDoc.customerName || "زبون عابر" },
            { label: "الهاتف", value: issuedDoc.customerPhone || "—" },
            { label: "السبب", value: issuedDoc.reason || "—" },
          ],
        },
      ],
      columns: [
        { key: "type", label: "الحركة" },
        { key: "item", label: "الصنف" },
        { key: "qty", label: "الكمية", align: "center" },
        { key: "price", label: "سعر الاحتساب", align: "left" },
        { key: "total", label: "الإجمالي", align: "left" },
      ],
      rows: [
        ...issuedDoc.returnItems.map((i) => ({
          type: "مرتجع مستلم",
          item: `${i.productName} (${i.disposition === "RESTOCK" ? "سليم" : "تالف"})`,
          qty: String(i.quantity),
          price: fmt(i.unitPrice),
          total: fmt(D(i.unitPrice).mul(i.quantity).toString()),
        })),
        ...(issuedDoc.exchangeItems ?? []).map((i) => ({
          type: "صنف بديل جديد",
          item: i.productName,
          qty: String(i.quantity),
          price: fmt(i.unitPrice),
          total: fmt(D(i.unitPrice).mul(i.quantity).toString()),
        })),
      ],
      summary: [
        { label: "إجمالي قيمة المرتجع", value: fmt(issuedDoc.returnTotal) },
        ...(issuedDoc.mode === "DIRECT_EXCHANGE"
          ? [
              { label: "إجمالي قيمة البديل", value: fmt(issuedDoc.exchangeTotal) },
              {
                label: D(issuedDoc.differenceAmount).gt(0) ? "المقبوض من الزبون نقداً" : "رصيد المتجر المتبقي للزبون",
                value: fmt(D(issuedDoc.differenceAmount).abs().toString()),
                large: true,
                bold: true,
              },
            ]
          : [{ label: "صافي رصيد المتجر الممنوح", value: fmt(issuedDoc.returnTotal), large: true, bold: true }]),
      ],
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[92vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-bold">
            <ShieldAlert className="size-5 text-amber-500" aria-hidden />
            سلة الإرجاع والاستبدال السريع بالباركود
          </DialogTitle>
          <DialogDescription className="text-xs">
            معالجة استرجاع الأصناف أو استبدالها مباشرة بالباركود عند فقدان الفاتورة، مع حفظ الحقوق المالية والمخزنية للطرفين.
          </DialogDescription>
        </DialogHeader>

        {issuedDoc ? (
          <div className="space-y-4 py-2">
            <div className="p-4 bg-primary/5 border border-primary/20 rounded-xl text-center space-y-2">
              <CheckCircle2 className="size-8 text-primary mx-auto" aria-hidden />
              <div className="text-sm font-bold">
                {issuedDoc.mode === "DIRECT_EXCHANGE"
                  ? "تم تنفيذ الاستبدال المباشر وتحديث المخزون والمالية بنجاح"
                  : "تم اعتماد الإرجاع وتوليد قسيمة الرصيد بنجاح"}
              </div>
              <div className="font-mono text-xl font-black text-primary">{issuedDoc.voucherCode}</div>
              <div className="text-xs text-muted-foreground">
                سند رسمي موثق في سجل التدقيق ومطابق للأرصدة
              </div>
            </div>

            <Card className="border">
              <CardContent className="p-4 space-y-2 text-xs">
                <div className="flex justify-between py-1 border-b">
                  <span className="text-muted-foreground">العميل:</span>
                  <span className="font-semibold">{issuedDoc.customerName} ({issuedDoc.customerPhone})</span>
                </div>
                <div className="flex justify-between py-1 border-b">
                  <span className="text-muted-foreground">إجمالي المرتجع:</span>
                  <span className="font-mono font-bold text-amber-600">{fmt(issuedDoc.returnTotal)}</span>
                </div>
                {issuedDoc.mode === "DIRECT_EXCHANGE" && (
                  <>
                    <div className="flex justify-between py-1 border-b">
                      <span className="text-muted-foreground">إجمالي البديل:</span>
                      <span className="font-mono font-bold text-emerald-600">{fmt(issuedDoc.exchangeTotal)}</span>
                    </div>
                    <div className="flex justify-between py-1 text-sm font-bold pt-1">
                      <span>
                        {D(issuedDoc.differenceAmount).gt(0)
                          ? "المبلغ المقبوض من الزبون (فرق السعر):"
                          : "رصيد المتجر المتبقي للزبون:"}
                      </span>
                      <span className="text-primary font-mono">
                        {fmt(D(issuedDoc.differenceAmount).abs().toString())}
                      </span>
                    </div>
                  </>
                )}
                {issuedDoc.mode === "STORE_CREDIT" && (
                  <div className="flex justify-between py-1 text-sm font-bold pt-1">
                    <span>إجمالي رصيد المتجر الممنوح:</span>
                    <span className="text-primary font-mono">{fmt(issuedDoc.returnTotal)}</span>
                  </div>
                )}
              </CardContent>
            </Card>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" onClick={handlePrintDoc} className="gap-2">
                <Printer className="size-4" aria-hidden />
                طباعة السند الرسمي
              </Button>
              <Button type="button" onClick={handleClose}>
                إغلاق والعودة
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4 py-1 text-xs">
            {/* التبديل بين المسارين */}
            <div className="grid grid-cols-2 gap-2 p-1 bg-muted/60 rounded-xl border">
              <button
                type="button"
                onClick={() => setMode("STORE_CREDIT")}
                className={cn(
                  "flex items-center justify-center gap-2 py-2 rounded-lg font-bold text-xs transition-all",
                  mode === "STORE_CREDIT"
                    ? "bg-background text-foreground shadow-sm border"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Receipt className="size-4 text-amber-500" aria-hidden />
                إرجاع واسترداد مالي (رصيد متجر)
              </button>
              <button
                type="button"
                onClick={() => setMode("DIRECT_EXCHANGE")}
                className={cn(
                  "flex items-center justify-center gap-2 py-2 rounded-lg font-bold text-xs transition-all",
                  mode === "DIRECT_EXCHANGE"
                    ? "bg-background text-foreground shadow-sm border"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <ArrowRightLeft className="size-4 text-emerald-500" aria-hidden />
                استبدال مباشر بصنف آخر (Exchange)
              </button>
            </div>

            {/* سلة الأصناف المرتجعة */}
            <Card className="border border-amber-500/20 bg-amber-500/5">
              <CardContent className="p-3.5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-bold text-sm flex items-center gap-2 text-foreground">
                    <Barcode className="size-4 text-amber-600" aria-hidden />
                    سلة الأصناف المرتجعة (ما جلبه الزبون)
                    <Badge variant="secondary" className="font-mono text-[11px]">
                      {returnItems.length} صنف
                    </Badge>
                  </div>
                  <div className="text-xs font-bold text-amber-700 font-mono">
                    إجمالي المرتجع: {fmt(returnTotal)}
                  </div>
                </div>

                {/* شريط مسح الباركود للمرتجع */}
                <form onSubmit={handleScanReturnItem} className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      ref={returnInputRef}
                      value={returnBarcode}
                      onChange={(e) => setReturnBarcode(e.target.value)}
                      placeholder="امسح باركود الصنف المرتجع أو أدخله..."
                      className="h-9 pr-9 font-mono text-xs"
                      disabled={isScanningReturn}
                    />
                    <Barcode className="size-4 text-muted-foreground absolute right-2.5 top-2.5" aria-hidden />
                  </div>
                  <Button type="submit" size="sm" variant="secondary" disabled={!returnBarcode.trim() || isScanningReturn}>
                    <Plus className="size-3.5 me-1" aria-hidden />
                    إضافة للسلة
                  </Button>
                </form>

                {/* جدول بنود المرتجع */}
                {returnItems.length > 0 ? (
                  <div className="border rounded-lg overflow-hidden bg-background">
                    <table className="w-full text-start text-[11px]">
                      <thead className="bg-muted/50 border-b text-muted-foreground">
                        <tr>
                          <th className="p-2 text-start font-medium">الصنف</th>
                          <th className="p-2 text-center font-medium">سعر الاحتساب (الأدنى)</th>
                          <th className="p-2 text-center font-medium">الكمية</th>
                          <th className="p-2 text-center font-medium">حالة السلعة</th>
                          <th className="p-2 text-end font-medium">الإجمالي</th>
                          <th className="p-2 text-center font-medium w-8"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {returnItems.map((itm, idx) => (
                          <tr key={itm.key} className="hover:bg-muted/30">
                            <td className="p-2">
                              <div className="font-bold text-foreground">{itm.productName}</div>
                              {itm.barcode && <div className="text-[10px] text-muted-foreground font-mono">{itm.barcode}</div>}
                            </td>
                            <td className="p-2 text-center font-mono font-medium">
                              {fmt(itm.unitPrice)}
                            </td>
                            <td className="p-2 text-center">
                              <div className="inline-flex items-center gap-1 border rounded-md px-1 py-0.5 bg-background">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setReturnItems((prev) => {
                                      const next = [...prev];
                                      if (next[idx].quantity > 1) {
                                        next[idx] = { ...next[idx], quantity: next[idx].quantity - 1 };
                                      }
                                      return next;
                                    });
                                  }}
                                  className="size-5 flex items-center justify-center rounded hover:bg-muted"
                                >
                                  <Minus className="size-3" aria-hidden />
                                </button>
                                <span className="w-6 text-center font-mono font-bold">{itm.quantity}</span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setReturnItems((prev) => {
                                      const next = [...prev];
                                      next[idx] = { ...next[idx], quantity: next[idx].quantity + 1 };
                                      return next;
                                    });
                                  }}
                                  className="size-5 flex items-center justify-center rounded hover:bg-muted"
                                >
                                  <Plus className="size-3" aria-hidden />
                                </button>
                              </div>
                            </td>
                            <td className="p-2 text-center">
                              <select
                                value={itm.disposition}
                                onChange={(e) => {
                                  const disp = e.target.value as "RESTOCK" | "SCRAP";
                                  setReturnItems((prev) => {
                                    const next = [...prev];
                                    next[idx] = { ...next[idx], disposition: disp };
                                    return next;
                                  });
                                }}
                                className="text-[11px] rounded border bg-background px-1.5 py-1"
                              >
                                <option value="RESTOCK">سليم (للمخزن)</option>
                                <option value="SCRAP">تالف (تخريد)</option>
                              </select>
                            </td>
                            <td className="p-2 text-end font-mono font-bold text-amber-700">
                              {fmt(D(itm.unitPrice).mul(itm.quantity).toString())}
                            </td>
                            <td className="p-2 text-center">
                              <button
                                type="button"
                                onClick={() => setReturnItems((prev) => prev.filter((_, i) => i !== idx))}
                                className="text-destructive/70 hover:text-destructive p-1 rounded"
                              >
                                <Trash2 className="size-3.5" aria-hidden />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="p-4 border border-dashed rounded-lg text-center text-muted-foreground text-xs">
                    السلة فارغة. امسح باركود المنتج لإضافته مباشرة لسلة المرتجعات.
                  </div>
                )}
              </CardContent>
            </Card>

            {/* سلة الأصناف البديلة (في وضع الاستبدال المباشر فقط) */}
            {mode === "DIRECT_EXCHANGE" && (
              <Card className="border border-emerald-500/20 bg-emerald-500/5">
                <CardContent className="p-3.5 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="font-bold text-sm flex items-center gap-2 text-foreground">
                      <Sparkles className="size-4 text-emerald-600" aria-hidden />
                      سلة الأصناف البديلة (ما يأخذه الزبون الآن)
                      <Badge variant="secondary" className="font-mono text-[11px]">
                        {exchangeItems.length} صنف
                      </Badge>
                    </div>
                    <div className="text-xs font-bold text-emerald-700 font-mono">
                      إجمالي البديل: {fmt(exchangeTotal)}
                    </div>
                  </div>

                  {/* شريط مسح الباركود للبديل */}
                  <form onSubmit={handleScanExchangeItem} className="flex gap-2">
                    <div className="relative flex-1">
                      <Input
                        ref={exchangeInputRef}
                        value={exchangeBarcode}
                        onChange={(e) => setExchangeBarcode(e.target.value)}
                        placeholder="امسح باركود الصنف البديل الجديد..."
                        className="h-9 pr-9 font-mono text-xs"
                        disabled={isScanningExchange}
                      />
                      <Barcode className="size-4 text-muted-foreground absolute right-2.5 top-2.5" aria-hidden />
                    </div>
                    <Button type="submit" size="sm" variant="secondary" disabled={!exchangeBarcode.trim() || isScanningExchange}>
                      <Plus className="size-3.5 me-1" aria-hidden />
                      إضافة للبديل
                    </Button>
                  </form>

                  {/* جدول بنود البديل */}
                  {exchangeItems.length > 0 ? (
                    <div className="border rounded-lg overflow-hidden bg-background">
                      <table className="w-full text-start text-[11px]">
                        <thead className="bg-muted/50 border-b text-muted-foreground">
                          <tr>
                            <th className="p-2 text-start font-medium">الصنف البديل</th>
                            <th className="p-2 text-center font-medium">سعر التجزئة</th>
                            <th className="p-2 text-center font-medium">الكمية</th>
                            <th className="p-2 text-end font-medium">الإجمالي</th>
                            <th className="p-2 text-center font-medium w-8"></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {exchangeItems.map((itm, idx) => (
                            <tr key={itm.key} className="hover:bg-muted/30">
                              <td className="p-2">
                                <div className="font-bold text-foreground">{itm.productName}</div>
                                {itm.barcode && <div className="text-[10px] text-muted-foreground font-mono">{itm.barcode}</div>}
                              </td>
                              <td className="p-2 text-center font-mono font-medium">
                                {fmt(itm.unitPrice)}
                              </td>
                              <td className="p-2 text-center">
                                <div className="inline-flex items-center gap-1 border rounded-md px-1 py-0.5 bg-background">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setExchangeItems((prev) => {
                                        const next = [...prev];
                                        if (next[idx].quantity > 1) {
                                          next[idx] = { ...next[idx], quantity: next[idx].quantity - 1 };
                                        }
                                        return next;
                                      });
                                    }}
                                    className="size-5 flex items-center justify-center rounded hover:bg-muted"
                                  >
                                    <Minus className="size-3" aria-hidden />
                                  </button>
                                  <span className="w-6 text-center font-mono font-bold">{itm.quantity}</span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setExchangeItems((prev) => {
                                        const next = [...prev];
                                        next[idx] = { ...next[idx], quantity: next[idx].quantity + 1 };
                                        return next;
                                      });
                                    }}
                                    className="size-5 flex items-center justify-center rounded hover:bg-muted"
                                  >
                                    <Plus className="size-3" aria-hidden />
                                  </button>
                                </div>
                              </td>
                              <td className="p-2 text-end font-mono font-bold text-emerald-700">
                                {fmt(D(itm.unitPrice).mul(itm.quantity).toString())}
                              </td>
                              <td className="p-2 text-center">
                                <button
                                  type="button"
                                  onClick={() => setExchangeItems((prev) => prev.filter((_, i) => i !== idx))}
                                  className="text-destructive/70 hover:text-destructive p-1 rounded"
                                >
                                  <Trash2 className="size-3.5" aria-hidden />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="p-4 border border-dashed rounded-lg text-center text-muted-foreground text-xs">
                      سلة البديل فارغة. امسح باركود الأصناف البديلة الجديدة التي سيأخذها الزبون.
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* شريط التسوية اللحظية وحساب الحقوق (The Settlement Tally) */}
            <Card className="border shadow-sm">
              <CardContent className="p-3.5 space-y-3">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                    <div className="text-[11px] text-muted-foreground">قيمة المرتجع</div>
                    <div className="font-mono font-bold text-sm text-amber-700 mt-0.5">{fmt(returnTotal)}</div>
                  </div>
                  {mode === "DIRECT_EXCHANGE" ? (
                    <>
                      <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                        <div className="text-[11px] text-muted-foreground">قيمة البديل</div>
                        <div className="font-mono font-bold text-sm text-emerald-700 mt-0.5">{fmt(exchangeTotal)}</div>
                      </div>
                      <div
                        className={cn(
                          "p-2 rounded-lg border",
                          customerOwes
                            ? "bg-rose-500/10 border-rose-500/30 text-rose-700"
                            : customerGetsCredit
                            ? "bg-primary/10 border-primary/30 text-primary"
                            : "bg-muted border-muted-foreground/20 text-muted-foreground"
                        )}
                      >
                        <div className="text-[11px] font-medium">
                          {customerOwes ? "مطلوب دفع فرق:" : customerGetsCredit ? "متبقي قسيمة رصيد:" : "فرق التسوية:"}
                        </div>
                        <div className="font-mono font-black text-sm mt-0.5">
                          {customerOwes ? `+${fmt(differenceAmount)}` : fmt(D(differenceAmount).abs().toString())}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="col-span-2 p-2 rounded-lg bg-primary/10 border border-primary/20 text-center">
                      <div className="text-[11px] text-muted-foreground">صافي رصيد المتجر الصادر للزبون (Store Credit)</div>
                      <div className="font-mono font-bold text-base text-primary mt-0.5">{fmt(returnTotal)}</div>
                    </div>
                  )}
                </div>

                {/* خيار وسيلة الدفع عند وجود فرق مطلوب من الزبون */}
                {mode === "DIRECT_EXCHANGE" && customerOwes && (
                  <div className="pt-2 border-t flex flex-wrap items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-foreground">طريقة قبض الفرق من الزبون:</span>
                      <div className="inline-flex rounded-lg border p-0.5 bg-muted/40">
                        <button
                          type="button"
                          onClick={() => setPaymentMethod("CASH")}
                          className={cn(
                            "flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold",
                            paymentMethod === "CASH" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground"
                          )}
                        >
                          <Banknote className="size-3.5" aria-hidden />
                          نقدي بالدرج
                        </button>
                        <button
                          type="button"
                          onClick={() => setPaymentMethod("CARD")}
                          className={cn(
                            "flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold",
                            paymentMethod === "CARD" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground"
                          )}
                        >
                          <CreditCard className="size-3.5" aria-hidden />
                          بطاقة / دفع إلكتروني
                        </button>
                      </div>
                    </div>

                    {paymentMethod === "CASH" && openShifts.length > 0 && (
                      <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                        <span>الدرج المستلم:</span>
                        <strong className="font-bold text-foreground">{openShifts[0].userName ?? "الوردية المفتوحة"}</strong>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* بيانات العميل وأسباب الإرجاع */}
            <div className="space-y-2 pt-1 border-t">
              <div className="font-semibold text-xs text-foreground flex items-center gap-1.5">
                <Store className="size-3.5 text-primary" aria-hidden />
                بيانات الزبون وسبب الإرجاع / الاستبدال (اختياري)
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="customer-name" className="text-xs">اسم الزبون (اختياري)</Label>
                  <Input
                    id="customer-name"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="اسم الزبون (زبون عابر افتراضياً)..."
                    className="h-8 text-xs"
                  />
                </div>

                <div className="space-y-1">
                  <Label htmlFor="customer-phone" className="text-xs">رقم الهاتف (اختياري)</Label>
                  <IntlPhoneInput
                    id="customer-phone"
                    value={customerPhone}
                    onChange={setCustomerPhone}
                    placeholder="770 123 4567"
                    className="h-8 text-xs"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="return-reason" className="text-xs">سبب الإرجاع أو الاستبدال (اختياري)</Label>
                <div className="flex flex-wrap gap-1">
                  {NO_RECEIPT_REASONS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setReason(r)}
                      className={cn(
                        "rounded-md border px-2 py-0.5 text-xs transition-colors",
                        reason === r
                          ? "bg-primary text-primary-foreground border-primary font-bold"
                          : "bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {r}
                    </button>
                  ))}
                </div>
                <Input
                  id="return-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="اختر سبباً من الأزرار أو اكتب مبرر الإرجاع والاستبدال..."
                  className="h-8 text-xs"
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
                disabled={executeMutation.isPending || returnItems.length === 0}
                className="gap-2"
              >
                <CheckCircle2 className="size-4" aria-hidden />
                {executeMutation.isPending
                  ? "جاري التنفيذ والحفظ..."
                  : mode === "DIRECT_EXCHANGE"
                  ? "تنفيذ الاستبدال المباشر والتسوية"
                  : "اعتماد وتوليد قسيمة الرصيد"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
