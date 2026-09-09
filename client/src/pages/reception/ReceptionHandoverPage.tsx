/**
 * ReceptionHandoverPage - شاشة التسليم المباشر للزبون
 * المسار: /reception/handover
 * تُفتح من رأس شاشة الاستقبال — مسح باركود → تفاصيل → تحصيل نقدي ذري
 */
import { useCallback, useRef, useState } from "react";

import {
  BadgeDollarSign,
  CheckCircle2,
  Package,
  ScanLine,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { confirm } from "@/lib/confirm";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { useBarcodeInput } from "@/hooks/useBarcodeInput";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { parseScan } from "@/lib/scanRouter";

interface ScannedOrder {
  id: number;
  kind?: "workOrder" | "invoice";
  orderNumber: string;
  title: string | null;
  customerName: string | null;
  customerPhone: string | null;
  salePrice: string;
  deposit: string | null;
}

export default function ReceptionHandoverPage() {
  const [scanned, setScanned] = useState<ScannedOrder | null>(null);
  const [manualInput, setManualInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();

  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const shiftQ = trpc.shifts.current.useQuery(
    { branchId: branchId!, shiftType: "RECEPTION" },
    { enabled: !!branchId },
  );
  const shift = shiftQ.data ?? null;

  // ─── مسح الباركود ────────────────────────────────────────────────────────

  const lookupOrder = useCallback(
    async (raw: string) => {
      const r = parseScan(raw);
      const orderNumber = r.type === "workOrder" || r.type === "invoice" ? r.number : raw.trim();
      if (!orderNumber) return;
      try {
        const wo = await utils.workOrders.getByNumber.fetch({ orderNumber });
        if (!wo) { notify.err("طلب أو فاتورة غير موجودة: " + orderNumber); return; }
        if (wo.kind === "workOrder") {
          if (wo.status === "DELIVERED") { notify.info("الطلب " + wo.orderNumber + " مُسلَّم مسبقاً"); return; }
          if (wo.status !== "READY") {
            notify.warn("الطلب غير جاهز للتسليم — حالته: " + wo.status);
            return;
          }
        } else if (wo.kind === "invoice") {
          if (wo.status === "CANCELLED" || wo.status === "RETURNED") {
            notify.err("هذه الفاتورة ملغاة أو مرتجعة");
            return;
          }
          if (wo.status === "PAID") {
            const rem = round2(D(wo.salePrice).minus(D(wo.deposit ?? "0")));
            if (rem.lte(0)) {
              notify.info("الفاتورة " + wo.orderNumber + " مسددة بالكامل مسبقاً ومسلّمة");
              return;
            }
          }
        }
        setScanned({
          id: wo.id,
          kind: wo.kind ?? "workOrder",
          orderNumber: wo.orderNumber,
          title: wo.title,
          customerName: wo.customerName,
          customerPhone: wo.customerPhone,
          salePrice: wo.salePrice,
          deposit: wo.deposit,
        });
        setManualInput("");
      } catch (e) {
        notify.err(e, "تعذّر جلب الطلب");
      }
    },
    [utils],
  );

  useBarcodeScanner(
    useCallback(
      async (raw: string) => { if (!scanned) await lookupOrder(raw); },
      [scanned, lookupOrder],
    ),
    { enabled: !scanned },
  );
  const barcodeInput = useBarcodeInput((code) => void lookupOrder(code));

  // ─── تسليم ────────────────────────────────────────────────────────────────

  const deliverMut = trpc.workOrders.deliver.useMutation({
    onSuccess: () => {
      notify.ok("تمّ تسليم طلب #" + (scanned?.orderNumber ?? ""));
      setScanned(null);
      void utils.workOrders.invalidate();
      void shiftQ.refetch();
      inputRef.current?.focus();
    },
    onError: (e) => notify.err(e, "تعذّر التسليم"),
  });

  const collectInvoiceMut = trpc.reception.collectOnInvoice.useMutation({
    onSuccess: () => {
      notify.ok("تمّ تحصيل الفاتورة #" + (scanned?.orderNumber ?? "") + " وتسليمها بنجاح");
      setScanned(null);
      void utils.workOrders.invalidate();
      void shiftQ.refetch();
      inputRef.current?.focus();
    },
    onError: (e) => notify.err(e, "تعذّر تحصيل الفاتورة"),
  });

  async function handleHandover() {
    if (!scanned || !shift) return;
    const remaining = round2(D(scanned.salePrice).minus(D(scanned.deposit ?? "0")));
    const docLabel = scanned.kind === "invoice" ? "الفاتورة" : "الطلب";
    const ok = await confirm({
      title: "تأكيد التسليم المباشر",
      description: [
        `${docLabel}: #${scanned.orderNumber}`,
        "العميل: " + (scanned.customerName ?? scanned.customerPhone ?? "غير محدد"),
        remaining.gt(0)
          ? "يُحصَّل الآن: " + fmt(remaining.toFixed(2)) + " د.ع نقداً"
          : "مدفوع بالكامل مسبقاً",
      ].join("\n"),
      confirmText: remaining.gt(0)
        ? "سلّم وحصّل " + fmt(remaining.toFixed(2)) + " د.ع"
        : "تسليم",
    });
    if (!ok) return;

    if (scanned.kind === "invoice") {
      if (remaining.gt(0)) {
        collectInvoiceMut.mutate({
          invoiceId: scanned.id,
          amount: remaining.toFixed(2),
          method: "CASH",
          clientRequestId: crypto.randomUUID(),
        });
      } else {
        notify.ok("الفاتورة مدفوعة مسبقاً — تم التسليم بنجاح");
        setScanned(null);
        void utils.workOrders.invalidate();
        void shiftQ.refetch();
        inputRef.current?.focus();
      }
    } else {
      deliverMut.mutate({
        workOrderId: scanned.id,
        payment: remaining.gt(0)
          ? { amount: remaining.toFixed(2), method: "CASH" as const }
          : undefined,
        clientRequestId: crypto.randomUUID(),
      });
    }
  }

  const remaining = scanned
    ? round2(D(scanned.salePrice).minus(D(scanned.deposit ?? "0")))
    : null;

  // ─── JSX ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background" dir="rtl">

      {/* رأس الصفحة */}
      <div className="shrink-0 border-b bg-card px-4 py-3">
        <PageHeader
          title="التسليم المباشر للزبون"
          icon={<CheckCircle2 aria-hidden className="size-5 text-green-600" />}
          backHref="/pos?mode=RECEPTION"
          backLabel="الاستقبال"
          actions={
            shift ? (
              <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-bold text-green-700">
                وردية #{shift.id}
              </span>
            ) : (
              <span className="rounded-full bg-destructive/10 px-3 py-1 text-xs font-bold text-destructive">
                لا وردية
              </span>
            )
          }
        />
      </div>

      {/* المحتوى */}
      <div className="flex flex-1 flex-col items-center gap-6 overflow-auto p-6">

        {/* منطقة المسح — تظهر إذا لم يكن هناك طلب ممسوح */}
        {!scanned && (
          <div className="w-full max-w-lg">
            <div className="rounded-2xl border-2 border-dashed border-green-400 bg-green-50 p-8 text-center">
              <ScanLine aria-hidden className="mx-auto size-14 text-green-500" />
              <p className="mt-4 text-xl font-extrabold text-green-800">
                امسح باركود الطلب الجاهز
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                وجّه الماسح نحو تذكرة الطلب أو أدخل الرقم يدوياً
              </p>
              <div className="mt-6 flex gap-2">
                <Input
                  ref={inputRef}
                  value={manualInput}
                  onChange={(e) => setManualInput(e.target.value)}
                  onKeyDown={(e) => {
                    barcodeInput.handleKeyDown(e, setManualInput);
                    if (!e.defaultPrevented && e.key === "Enter" && manualInput.trim()) {
                      void lookupOrder(manualInput.trim());
                    }
                  }}
                  placeholder="رقم الطلب (Enter للبحث)"
                  className="flex-1 h-12 text-center text-base font-bold"
                  dir="ltr"
                  autoFocus
                />
                <Button
                  size="lg"
                  variant="outline"
                  onClick={() => void lookupOrder(manualInput.trim())}
                  disabled={!manualInput.trim()}
                >
                  بحث
                </Button>
              </div>
            </div>

            {!shift && (
              <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-center">
                <p className="text-sm font-bold text-destructive">
                  لا وردية استقبال مفتوحة — افتح وردية أولاً
                </p>
              </div>
            )}
          </div>
        )}

        {/* بطاقة الطلب الممسوح */}
        {scanned && (
          <div className="w-full max-w-lg">
            <Card className="overflow-hidden gap-0 py-0 shadow-md">

              {/* رأس البطاقة */}
              <div className="border-b bg-green-50 p-5 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Package aria-hidden className="size-6 text-green-600" />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xl font-extrabold">#{scanned.orderNumber}</span>
                      <Badge
                        variant="outline"
                        className="border-green-500 bg-green-50 text-green-700"
                      >
                        جاهز للتسليم
                      </Badge>
                    </div>
                    {scanned.title && (
                      <p className="text-sm text-muted-foreground">{scanned.title}</p>
                    )}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setScanned(null); setManualInput(""); }}
                >
                  مسح آخر
                </Button>
              </div>

              {/* تفاصيل */}
              <div className="space-y-3 p-5">

                {/* العميل */}
                <div className="flex items-center gap-3 rounded-xl border bg-background p-4">
                  <User aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">العميل</p>
                    <p className="text-base font-bold">{scanned.customerName ?? "—"}</p>
                    {scanned.customerPhone && (
                      <p className="text-sm text-muted-foreground" dir="ltr">
                        {scanned.customerPhone}
                      </p>
                    )}
                  </div>
                </div>

                {/* المالي */}
                <div className="flex items-center gap-3 rounded-xl border bg-background p-4">
                  <BadgeDollarSign aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                  <div className="flex-1">
                    <p className="text-xs text-muted-foreground">المالي</p>
                    <div className="flex items-center justify-between">
                      <p className="text-base font-bold">{fmt(scanned.salePrice)} د.ع إجمالاً</p>
                      {D(scanned.deposit ?? "0").gt(0) && (
                        <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs font-bold text-green-600">
                          عربون {fmt(scanned.deposit ?? "0")} د.ع
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* مؤشر المبلغ المتبقي */}
                <div
                  className={
                    remaining && remaining.gt(0)
                      ? "rounded-xl border-2 border-amber-300 bg-amber-50 p-4"
                      : "rounded-xl border-2 border-green-300 bg-green-50 p-4"
                  }
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold">
                      {remaining && remaining.gt(0)
                        ? "يُحصَّل الآن نقداً:"
                        : "مدفوع بالكامل مسبقاً"}
                    </span>
                    {remaining && remaining.gt(0) && (
                      <span className="text-2xl font-extrabold tabular-nums text-amber-700">
                        {fmt(remaining.toFixed(2))} د.ع
                      </span>
                    )}
                  </div>
                </div>

                {/* زر التسليم */}
                <Button
                  className="w-full py-7 text-lg font-extrabold bg-green-600 hover:bg-green-700 text-white"
                  onClick={() => void handleHandover()}
                  disabled={deliverMut.isPending || !shift}
                >
                  {deliverMut.isPending
                    ? "جارٍ التسليم…"
                    : !shift
                    ? "افتح وردية استقبال أولاً"
                    : remaining && remaining.gt(0)
                    ? "سلّم وحصّل " + fmt(remaining.toFixed(2)) + " د.ع"
                    : "تسليم (مدفوع كاملاً)"}
                </Button>
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
