import { useState, useMemo } from "react";
import {
  Clock,
  Phone,
  User,
  CheckCircle2,
  Trash2,
  Pencil,
  Truck,
  Printer,
  Search,
  X,
  AlertCircle,
  Banknote,
  CreditCard,
  ArrowLeftRight,
  ExternalLink,
  MessageSquare,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { fmt, round2, D } from "@/lib/money";
import { fmtDate, fmtDateTime, fmtTime } from "@/lib/date";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { InvoiceDispatchDialog, type DispatchableInvoice } from "@/components/delivery/InvoiceDispatchDialog";
import { PaymentReferenceField } from "@/components/pos/PaymentReferenceField";
import { getDeviceCode } from "@/lib/offline/outbox";
import { printReceipt } from "@/lib/printing/print";
import { buildBrandedReceipt, type Receipt } from "@/components/pos/posShared";

export interface HeldSaleOrder {
  id: number;
  invoiceNumber: string;
  status: string;
  total: string;
  paidAmount: string;
  remainingAmount: string;
  createdAt: string | Date;
  notes: string | null;
  contactName: string | null;
  contactPhone: string | null;
  customerId: number | null;
  customerDisplayName: string;
  customerDisplayPhone: string;
  lines: Array<{
    id: number;
    variantId: number;
    productUnitId: number;
    quantity: string;
    unitPrice: string;
    total: string;
    itemNameSnapshot: string | null;
  }>;
}

interface HeldOrdersDrawerProps {
  open: boolean;
  onClose: () => void;
  branchId: number;
  onEditOrder: (order: HeldSaleOrder) => void;
  cashierName?: string;
  shiftId?: number | null;
}

export function HeldOrdersDrawer({
  open,
  onClose,
  branchId,
  onEditOrder,
  cashierName,
  shiftId,
}: HeldOrdersDrawerProps) {
  const [search, setSearch] = useState("");
  const [selectedForCollect, setSelectedForCollect] = useState<HeldSaleOrder | null>(null);
  const [selectedForDispatch, setSelectedForDispatch] = useState<DispatchableInvoice | null>(null);
  const [dispatchOpen, setDispatchOpen] = useState(false);

  // حالة نموذج التحصيل السريع
  const [collectMethod, setCollectMethod] = useState<"CASH" | "CARD" | "TRANSFER">("CASH");
  const [paymentRef, setPaymentRef] = useState("");
  const [externalAttempt, setExternalAttempt] = useState<{
    attemptId: number | null;
    deviceId: string;
    confirmed: boolean;
  } | null>(null);

  const utils = trpc.useUtils();
  const heldQ = trpc.printPos.listHeldSales.useQuery(
    { branchId },
    { enabled: open, refetchInterval: open ? 10_000 : false },
  );

  const cancelMut = trpc.printPos.cancelHeldSale.useMutation({
    onSuccess: (res) => {
      notify.ok(
        "تم إلغاء الطلب بنجاح",
        Number(res.refundAmount) > 0 ? `تم استرداد عربون بقيمة ${fmt(res.refundAmount)} د.ع` : undefined,
      );
      void utils.printPos.listHeldSales.invalidate();
    },
    onError: (e) => notify.err(e.message, "تعذّر إلغاء الطلب"),
  });

  const initiateExternal = trpc.sales.initiateExternalPayment.useMutation();
  const confirmExternal = trpc.sales.confirmExternalPayment.useMutation();

  const collectMut = trpc.reception.collectOnInvoice.useMutation({
    onSuccess: async (_, vars) => {
      notify.ok("تم تحصيل المتبقي وتسليم الفاتورة بنجاح");
      if (selectedForCollect) {
        // طباعة إيصال التسليم المكتمل
        try {
          const now = new Date();
          const rec: Receipt = {
            invoiceId: selectedForCollect.id,
            invoiceNumber: selectedForCollect.invoiceNumber,
            num: selectedForCollect.invoiceNumber,
            date: fmtDateTime(now),
            printDate: fmtDate(now),
            printTime: fmtTime(now),
            cashierName: cashierName ?? undefined,
            customerName: selectedForCollect.customerDisplayName,
            shiftId: shiftId ?? null,
            lines: selectedForCollect.lines.map((l) => ({
              name: l.itemNameSnapshot || "خدمة طباعة",
              unit: "خدمة",
              qty: Number(l.quantity),
              price: Number(l.unitPrice),
              total: Number(l.total),
            })),
            subtotal: Number(selectedForCollect.total),
            total: Number(selectedForCollect.total),
            received: Number(vars.amount),
            change: 0,
            credit: 0,
            method: vars.method === "CASH" ? "نقدي" : vars.method === "CARD" ? "بطاقة" : "تحويل",
            methodCode: vars.method,
            isCredit: false,
          };
          void printReceipt(buildBrandedReceipt(rec));
        } catch {
          // خطأ طباعة لا يُبطل التحصيل
        }
      }
      setSelectedForCollect(null);
      setPaymentRef("");
      setExternalAttempt(null);
      await utils.printPos.listHeldSales.invalidate();
    },
    onError: (e) => notify.err(e.message, "تعذّر تحصيل الفاتورة"),
  });

  const orders = useMemo(() => {
    const list = (heldQ.data ?? []) as HeldSaleOrder[];
    if (!search.trim()) return list;
    const q = search.trim().toLowerCase();
    return list.filter(
      (o) =>
        o.invoiceNumber.toLowerCase().includes(q) ||
        o.customerDisplayName.toLowerCase().includes(q) ||
        o.customerDisplayPhone.includes(q) ||
        (o.notes && o.notes.toLowerCase().includes(q)),
    );
  }, [heldQ.data, search]);

  async function handleCancelOrder(order: HeldSaleOrder) {
    const ok = await confirm({
      title: `إلغاء الطلب المحجوز #${order.invoiceNumber}`,
      description: `هل أنت متأكد من إلغاء هذا الطلب؟\nالزبون: ${order.customerDisplayName}\nالإجمالي: ${fmt(order.total)} د.ع\nالمدفوع: ${fmt(order.paidAmount)} د.ع\nسيتم إرجاع المواد للمخزون واسترداد أي عربون نقدي من الدرج.`,
      variant: "danger",
      confirmText: "إلغاء الطلب واسترداد العربون",
      cancelText: "تراجع",
    });
    if (!ok) return;

    cancelMut.mutate({
      invoiceId: order.id,
      reason: "إلغاء بطلب من الزبون في كاشير الطباعة",
      refundPaymentMethod: "CASH",
    });
  }

  async function handleConfirmExternalPayment() {
    if (!selectedForCollect) return;
    const trimmed = paymentRef.trim();
    if (!trimmed) {
      notify.err("أدخل رقم المرجع أولاً");
      return;
    }
    try {
      const deviceId = externalAttempt?.deviceId ?? (await getDeviceCode());
      const requestId = crypto.randomUUID();
      const initiated = await initiateExternal.mutateAsync({
        branchId,
        channel: "POS",
        method: collectMethod as any,
        amount: selectedForCollect.remainingAmount,
        reference: trimmed,
        requestId,
        deviceId,
      });
      await confirmExternal.mutateAsync({
        branchId,
        channel: "POS",
        attemptId: initiated.attemptId,
        deviceId,
      });
      setExternalAttempt({
        attemptId: initiated.attemptId,
        deviceId,
        confirmed: true,
      });
      notify.ok("تم تأكيد الدفع الإلكتروني بنجاح");
    } catch (e: any) {
      notify.err(e.message, "فشل تأكيد الدفع الإلكتروني");
    }
  }

  function handleExecuteCollect() {
    if (!selectedForCollect) return;
    const remaining = Number(selectedForCollect.remainingAmount);
    if (collectMethod !== "CASH" && remaining > 0 && !externalAttempt?.confirmed) {
      notify.err("يجب تأكيد العملية الإلكترونية قبل التحصيل");
      return;
    }

    collectMut.mutate({
      invoiceId: selectedForCollect.id,
      amount: selectedForCollect.remainingAmount,
      method: collectMethod,
      reference: collectMethod !== "CASH" ? paymentRef.trim() : undefined,
      externalPaymentAttemptId: externalAttempt?.attemptId ?? undefined,
      externalPaymentDeviceId: externalAttempt?.deviceId ?? undefined,
      clientRequestId: crypto.randomUUID(),
    });
  }

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-xs transition-opacity"
        onClick={onClose}
        dir="rtl"
      >
        <div
          className="flex h-full w-full max-w-xl flex-col bg-background shadow-2xl border-s border-border"
          onClick={(e) => e.stopPropagation()}
        >
          {/* الرأس */}
          <div className="flex items-center justify-between border-b border-border px-5 py-4 bg-muted/40">
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Clock className="size-5" />
              </div>
              <div>
                <h2 className="text-base font-bold">الطلبات المحجوزة والمعلقة</h2>
                <p className="text-xs text-muted-foreground">
                  {orders.length} طلب قيد الانتظار أو التجهيز للتسليم والتوصيل
                </p>
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} className="rounded-full">
              <X className="size-5" />
            </Button>
          </div>

          {/* حقل البحث السريع */}
          <div className="p-4 border-b border-border bg-card">
            <div className="relative">
              <Search className="absolute right-3 top-2.5 size-4 text-muted-foreground" />
              <Input
                placeholder="ابحث برقم الفاتورة، اسم الزبون، أو رقم الهاتف…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pr-9 h-10 text-sm"
              />
            </div>
          </div>

          {/* قائمة الطلبات */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {heldQ.isLoading ? (
              <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
                جارٍ تحميل الطلبات المحجوزة…
              </div>
            ) : orders.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 text-center text-muted-foreground">
                <CheckCircle2 className="size-12 mb-2 text-muted-foreground/40" />
                <p className="text-sm font-semibold">لا توجد طلبات محجوزة معلقة حالياً</p>
                <p className="text-xs mt-1">كل طلبات الطباعة مسددة ومسلمة بالكامل</p>
              </div>
            ) : (
              orders.map((o) => {
                const remaining = Number(o.remainingAmount);
                const isPartiallyPaid = Number(o.paidAmount) > 0;
                return (
                  <div
                    key={o.id}
                    className="rounded-xl border border-border bg-card p-4 shadow-2xs hover:border-primary/40 transition-colors"
                  >
                    {/* رأس الكرت */}
                    <div className="flex items-start justify-between gap-2 border-b border-border/60 pb-2.5">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-black text-primary">
                            #{o.invoiceNumber}
                          </span>
                          <Badge variant={isPartiallyPaid ? "secondary" : "outline"} className="text-2xs px-1.5 py-0">
                            {isPartiallyPaid ? "عربون مقبوض" : "بدون عربون"}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-2 mt-1 text-xs font-semibold text-foreground">
                          <User className="size-3 text-muted-foreground" />
                          <span>{o.customerDisplayName}</span>
                          {o.customerDisplayPhone && (
                            <span className="text-muted-foreground text-2xs" dir="ltr">
                              ({o.customerDisplayPhone})
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-start">
                        <div className="text-xs text-muted-foreground">المتبقي للتحصيل</div>
                        <div className="text-base font-black text-amber-600 dark:text-amber-400" dir="ltr">
                          {fmt(o.remainingAmount)} <span className="text-2xs font-normal">د.ع</span>
                        </div>
                      </div>
                    </div>

                    {/* بنود الفاتورة */}
                    <div className="py-2.5 space-y-1">
                      {o.lines.slice(0, 3).map((line, idx) => (
                        <div key={idx} className="flex justify-between text-xs text-muted-foreground">
                          <span className="truncate max-w-[280px]">
                            • {line.itemNameSnapshot || "خدمة طباعة"}
                          </span>
                          <span>
                            {line.quantity} × {fmt(line.unitPrice)}
                          </span>
                        </div>
                      ))}
                      {o.lines.length > 3 && (
                        <div className="text-2xs text-muted-foreground/80">
                          + {o.lines.length - 3} بنود إضافية
                        </div>
                      )}
                      {o.notes && (
                        <div className="mt-1 text-2xs text-muted-foreground/90 bg-muted/30 p-1.5 rounded-sm">
                          {o.notes}
                        </div>
                      )}
                    </div>

                    {/* المبالغ والتاريخ */}
                    <div className="flex items-center justify-between text-2xs text-muted-foreground border-t border-border/40 pt-2 mb-3">
                      <span>الإجمالي: {fmt(o.total)} د.ع</span>
                      <span>المدفوع: {fmt(o.paidAmount)} د.ع</span>
                      <span>{fmtTime(o.createdAt)}</span>
                    </div>

                    {/* أزرار الإجراءات السريعة */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                      <Button
                        size="sm"
                        onClick={() => setSelectedForCollect(o)}
                        className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold h-8 col-span-1"
                      >
                        <CheckCircle2 className="size-3.5 ml-1" />
                        تحصيل
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          onEditOrder(o);
                          onClose();
                        }}
                        className="text-xs font-semibold h-8 border-border hover:bg-muted col-span-1"
                      >
                        <Pencil className="size-3.5 ml-1" />
                        تعديل
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setSelectedForDispatch({
                            id: o.id,
                            invoiceNumber: o.invoiceNumber,
                            total: o.total,
                            paidAmount: o.paidAmount,
                            customerName: o.customerDisplayName,
                            customerPhone: o.customerDisplayPhone,
                          });
                          setDispatchOpen(true);
                        }}
                        className="text-xs font-semibold h-8 border-border hover:bg-muted col-span-1"
                      >
                        <Truck className="size-3.5 ml-1" />
                        توصيل
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleCancelOrder(o)}
                        disabled={cancelMut.isPending}
                        className="text-destructive hover:bg-destructive/10 text-xs font-semibold h-8 col-span-1"
                      >
                        <Trash2 className="size-3.5 ml-1" />
                        إلغاء
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* حوار التحصيل السريع */}
      <Dialog open={!!selectedForCollect} onOpenChange={(open) => !open && setSelectedForCollect(null)}>
        <DialogContent className="sm:max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle>تحصيل وتسليم الفاتورة #{selectedForCollect?.invoiceNumber}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="rounded-lg bg-muted/40 p-3 flex justify-between items-center">
              <div>
                <span className="text-xs text-muted-foreground">الزبون</span>
                <div className="text-sm font-bold">{selectedForCollect?.customerDisplayName}</div>
              </div>
              <div className="text-left">
                <span className="text-xs text-muted-foreground">المتبقي للتحصيل</span>
                <div className="text-lg font-black text-primary">
                  {fmt(selectedForCollect?.remainingAmount ?? "0")} د.ع
                </div>
              </div>
            </div>

            {/* طريقة التحصيل */}
            <div>
              <label className="text-xs font-bold mb-1.5 block">طريقة الاستلام</label>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setCollectMethod("CASH");
                    setPaymentRef("");
                    setExternalAttempt(null);
                  }}
                  className={`flex h-10 items-center justify-center gap-1.5 rounded-lg border-2 text-xs font-bold transition-all ${
                    collectMethod === "CASH"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-card text-foreground"
                  }`}
                >
                  <Banknote className="size-4" />
                  نقدي
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCollectMethod("CARD");
                    setExternalAttempt(null);
                  }}
                  className={`flex h-10 items-center justify-center gap-1.5 rounded-lg border-2 text-xs font-bold transition-all ${
                    collectMethod === "CARD"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-card text-foreground"
                  }`}
                >
                  <CreditCard className="size-4" />
                  بطاقة
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCollectMethod("TRANSFER");
                    setExternalAttempt(null);
                  }}
                  className={`flex h-10 items-center justify-center gap-1.5 rounded-lg border-2 text-xs font-bold transition-all ${
                    collectMethod === "TRANSFER"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-card text-foreground"
                  }`}
                >
                  <ArrowLeftRight className="size-4" />
                  تحويل
                </button>
              </div>
            </div>

            {/* مرجع الدفع غير النقدي */}
            {collectMethod !== "CASH" && (
              <PaymentReferenceField
                value={paymentRef}
                onChange={setPaymentRef}
                method={collectMethod}
                confirmed={externalAttempt?.confirmed ?? false}
                confirming={initiateExternal.isPending || confirmExternal.isPending}
                onConfirm={handleConfirmExternalPayment}
                inputId="held-collect-ref"
                colors={{
                  border: "var(--border)",
                  muted: "var(--muted)",
                  mutedFg: "var(--muted-foreground)",
                  fg: "var(--foreground)",
                  amber: "var(--sem-warn)",
                  success: "var(--sem-pos)",
                }}
              />
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setSelectedForCollect(null)}>
              إلغاء
            </Button>
            <Button
              onClick={handleExecuteCollect}
              disabled={collectMut.isPending || (collectMethod !== "CASH" && !externalAttempt?.confirmed)}
              className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold"
            >
              {collectMut.isPending ? "جارٍ التحصيل…" : `قبض ${fmt(selectedForCollect?.remainingAmount ?? "0")} د.ع وتسليم`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار إسناد التوصيل */}
      <InvoiceDispatchDialog
        invoice={selectedForDispatch}
        open={dispatchOpen}
        onOpenChange={(v) => {
          setDispatchOpen(v);
          if (!v) setSelectedForDispatch(null);
        }}
        onCompleted={() => {
          notify.ok("تم إسناد الطلب للتوصيل بنجاح");
          void utils.printPos.listHeldSales.invalidate();
          setDispatchOpen(false);
          setSelectedForDispatch(null);
        }}
      />
    </>
  );
}
