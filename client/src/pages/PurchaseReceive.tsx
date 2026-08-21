import { Button } from "@/components/ui/button";
import { confirm } from "@/lib/confirm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { allocateLineTax } from "@/components/invoice";
import { fmtAr, D, positiveDiff, round2 } from "@/lib/money";
import { MoneyInput } from "@/components/form/MoneyInput";
import { NumberInput } from "@/components/form/NumberInput";
import { notify } from "@/lib/notify";
import { CO } from "@/lib/printing/brand";
import { printPurchaseInvoiceV2 } from "@/lib/printing/printTemplatesV2";
import { qrCodeSvg } from "@/lib/printing/qr";
import { trpc } from "@/lib/trpc";
import { hasModuleAccess } from "@shared/permissions";
import { useEffect, useState } from "react";
import { Link, useParams } from "wouter";

const PO_STATUS: Record<string, string> = {
  DRAFT: "مسوّدة",
  SENT: "مُرسَل",
  CONFIRMED: "مؤكّد",
  RECEIVED: "مُستلَم",
  CANCELLED: "ملغى",
};

// تسويةُ الشحن/الكمرك تُنشئ سند صرفٍ نظاميّاً يقبل غير النقد فعلاً ⇒ قائمتها الكاملة.
// ⚠️ «صك» محذوفٌ: قرار المالك «لا تعامل بالصكوك» مطبَّقٌ في راوتر السندات (`creatableMethod`)
// وفي `lib/paymentMethod`، وكان هذا المنتقي **المنفذ الوحيد الباقي في النظام** لإنشاء صكّ
// فعليّ (عبر createSystemPaymentRequestTx) — بابٌ خلفيّ لقرارٍ مُقفلٍ في كل بابٍ آخر.
const SHIPPING_METHODS: {
  v: "CASH" | "CARD" | "TRANSFER" | "WALLET";
  label: string;
}[] = [
  { v: "CASH", label: "نقدي" },
  { v: "TRANSFER", label: "تحويل" },
  { v: "CARD", label: "بطاقة" },
  { v: "WALLET", label: "محفظة" },
];
const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function PurchaseReceive() {
  const params = useParams();
  const purchaseOrderId = Number(params.id);
  const utils = trpc.useUtils();

  const po = trpc.purchases.get.useQuery(
    { purchaseOrderId },
    { enabled: Number.isFinite(purchaseOrderId) },
  );
  const [recv, setRecv] = useState<Record<number, string>>({});
  // «اشترِ واحصل» (G-م٦): كمية مجّانية بونص لكل سطر — تُسجَّل هديةً واردة (لمن يملك gifts=FULL فقط).
  const me = trpc.auth.me.useQuery();
  const canGiftBonus = hasModuleAccess(
    me.data?.role ?? "",
    (
      me.data as
        | {
            permissionsOverride?: Record<
              string,
              "NONE" | "READ" | "FULL"
            > | null;
          }
        | undefined
    )?.permissionsOverride ?? null,
    "gifts",
    "FULL",
  );
  const canManagePurchases = hasModuleAccess(
    me.data?.role ?? "",
    (
      me.data as
        | {
            permissionsOverride?: Record<
              string,
              "NONE" | "READ" | "FULL"
            > | null;
          }
        | undefined
    )?.permissionsOverride ?? null,
    "purchases",
    "FULL",
  );
  const [free, setFree] = useState<Record<number, string>>({});
  const [payAmount, setPayAmount] = useState("");
  // طريقة دفع **مصروف الشحن/الكمرك** (لشركة النقل) — مستقلّة تماماً عن تسوية المورّد.
  const [shipMethod, setShipMethod] =
    useState<(typeof SHIPPING_METHODS)[number]["v"]>("CASH");
  const [shipPaymentReference, setShipPaymentReference] = useState("");
  const [shipCardLastFour, setShipCardLastFour] = useState("");
  // الناقل ومستند الشحن — **اختياريان** (قرار المالك ١٧/٨/٢٦). كانا إلزامَين خادمياً بلا حقلٍ
  // لهما في هذه الشاشة ⇒ كلّ أمرٍ عليه شحن/كمرك كان يُرفَض حتماً. الخادم يُكمل الناقص ببديلٍ
  // صريح الجهالة («ناقل غير محدَّد» / رقم أمر الشراء) فيبقى المصروف مثبتاً وقابلاً للتصحيح.
  const [shipBeneficiarySupplierId, setShipBeneficiarySupplierId] =
    useState<string>("");
  const [shipBeneficiaryName, setShipBeneficiaryName] = useState("");
  const [shipEvidenceReference, setShipEvidenceReference] = useState("");
  const suppliersQuery = trpc.suppliers.list.useQuery();
  const [laterPayAmount, setLaterPayAmount] = useState("");
  const [laterPayRequestId, setLaterPayRequestId] = useState(() =>
    crypto.randomUUID(),
  );
  const [directUsd, setDirectUsd] = useState("");
  const [directIqd, setDirectIqd] = useState("");
  const [directFee, setDirectFee] = useState("");
  const [directMethod, setDirectMethod] = useState<
    "CARD" | "TRANSFER" | "WALLET"
  >("CARD");
  const [directReference, setDirectReference] = useState("");
  const [directCardLastFour, setDirectCardLastFour] = useState("");
  const [directRequestId, setDirectRequestId] = useState(() =>
    crypto.randomUUID(),
  );
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  // Default each line's receive input to its remaining quantity, once loaded.
  useEffect(() => {
    if (!po.data) return;
    const init: Record<number, string> = {};
    for (const it of po.data.items) {
      const remaining = it.baseQuantity - (it.receivedBaseQuantity ?? 0);
      init[Number(it.id)] = remaining > 0 ? String(remaining) : "0";
    }
    setRecv(init);
  }, [po.data]);

  // idempotency: مفتاح ثابت لكل استلام (يتجدّد بعد النجاح) ⇒ نقرة مزدوجة لا تُكرّر المخزون/AP.
  const [clientRequestId, setClientRequestId] = useState(() =>
    crypto.randomUUID(),
  );
  const receive = trpc.purchases.receive.useMutation({
    onSuccess: async (r) => {
      const recognized = r.fullyReceived
        ? "تم الاستلام الكامل وإثبات المخزون واستحقاق المورد."
        : "تم الاستلام الجزئي وإثبات المخزون واستحقاق المورد.";
      const pending: string[] = [];
      if (r.shippingPaymentRequestReceiptId)
        pending.push(
          "أُثبت مصروف الشحن والتزامه، وتسويته معلّقة لاعتماد مالكٍ آخر",
        );
      if (r.supplierPaymentRequestReceiptId)
        pending.push("دفعة المورّد النقدية معلّقة لاعتماد مالكٍ آخر");
      setDone([recognized, ...pending].join(" "));
      await Promise.all([
        utils.purchases.get.invalidate({ purchaseOrderId }),
        utils.purchases.list.invalidate(),
      ]);
      // تصفير مفتاح الـidempotency يتأخّر إلى ما بعد نجاح البونص أيضاً (في submit) كي تُعيد إعادةُ
      // المحاولة تشغيلَ الاستلام بأمان (replay) بدل استلامٍ مزدوج عند فشل البونص جزئياً.
    },
    onError: (e) => setError(e.message),
  });
  // بونص «اشترِ واحصل» (G-م٦): الكمية المجّانية المرافقة تُسجَّل سند هدية وارد للمورّد نفسه.
  const recordBonus = trpc.gifts.receivePurchaseBonus.useMutation({
    onSuccess: (r) => {
      if (r?.giftNumber)
        setDone((d) => `${d} + سُجّل بونص هدية ${r.giftNumber}`);
    },
    onError: (e) =>
      setError(
        (prev) =>
          prev ||
          `فشل تسجيل البونص المجّانيّ (سجّله يدوياً من الهدايا): ${e.message}`,
      ),
  });
  const settleUsdDirect = trpc.purchases.settleUsdDirect.useMutation({
    onSuccess: async (r) => {
      setDone(
        `أُنشئ طلب تسديد USD #${r.receiptId} وبقي بلا أثر مالي حتى يعتمدَه مالك آخر. فرق الصرف المتوقع: ${fmtAr(r.fxDiff)} د.ع.`,
      );
      setDirectUsd("");
      setDirectIqd("");
      setDirectFee("");
      setDirectReference("");
      setDirectCardLastFour("");
      setDirectRequestId(crypto.randomUUID());
      await Promise.all([
        utils.purchases.get.invalidate({ purchaseOrderId }),
        utils.purchases.list.invalidate(),
        utils.suppliers.list.invalidate(),
      ]);
    },
    onError: (e) => setError(e.message),
  });
  const requestSupplierPayment = trpc.purchases.pay.useMutation({
    onSuccess: async (r) => {
      setDone(
        `أُنشئ طلب صرف المورد #${r.paymentRequestReceiptId} وبقي معلّقاً لاعتماد مالكٍ آخر.`,
      );
      setLaterPayAmount("");
      setLaterPayRequestId(crypto.randomUUID());
      await Promise.all([
        utils.purchases.get.invalidate({ purchaseOrderId }),
        utils.purchases.list.invalidate(),
      ]);
    },
    onError: (e) => setError(e.message),
  });

  if (po.isLoading) return <LoadingState />;
  if (!po.data)
    return (
      <ErrorState
        message="أمر الشراء غير موجود."
        onRetry={() => po.refetch()}
      />
    );

  const data = po.data;
  const closed = data.status === "RECEIVED" || data.status === "CANCELLED";
  const remainingUsd =
    data.agreedCurrency === "USD"
      ? D(data.usdTotal ?? 0)
          .minus(D(data.paidUsd ?? 0))
          .minus(D(data.returnedUsd ?? 0))
      : D(0);

  async function submitDirectUsdPayment() {
    setError("");
    setDone("");
    let usd;
    let iqd;
    let fee;
    try {
      usd = round2(D(directUsd));
      iqd = round2(D(directIqd));
      fee = round2(D(directFee));
    } catch {
      setError("تحقق من مبالغ التسديد المدخلة.");
      return;
    }
    if (usd.lte(0) || iqd.lte(0))
      return setError("أدخل مبلغ الدولار والمبلغ الديناري الفعلي.");
    if (usd.gt(remainingUsd))
      return setError("مبلغ الدولار يتجاوز المتبقي على الفاتورة.");
    if (fee.lt(0)) return setError("العمولة لا تكون سالبة.");
    if (!directReference.trim())
      return setError("أدخل رقم مرجع البطاقة أو التحويل.");
    if (directMethod === "CARD" && !/^\d{4}$/.test(directCardLastFour)) {
      return setError("أدخل آخر أربعة أرقام للبطاقة.");
    }
    if (
      !(await confirm({
        variant: "info",
        title: "إنشاء طلب تسديد فاتورة الدولار",
        description: `سيُنشأ طلب مقابل ${usd.toFixed(2)}$ وحركة متوقعة ${iqd.toFixed(2)} د.ع. لن تتغير الذمة أو الأصول حتى اعتماد مالك آخر.`,
        confirmText: "إنشاء الطلب",
      }))
    )
      return;
    settleUsdDirect.mutate({
      purchaseOrderId,
      settledUsd: usd.toFixed(2),
      chargedIqd: iqd.toFixed(2),
      feeIqd: fee.gt(0) ? fee.toFixed(2) : undefined,
      method: directMethod,
      referenceNumber: directReference.trim(),
      cardLastFour: directMethod === "CARD" ? directCardLastFour : undefined,
      clientRequestId: directRequestId,
    });
  }

  async function submitLaterSupplierPayment() {
    setError("");
    setDone("");
    let amount;
    try {
      amount = round2(D(laterPayAmount));
    } catch {
      setError("تحقق من مبلغ طلب دفع المورد.");
      return;
    }
    if (amount.lte(0)) return setError("أدخل مبلغاً موجباً لطلب دفع المورد.");
    if (
      !(await confirm({
        variant: "info",
        title: `طلب دفع المورد — ${data.poNumber}`,
        description: `سيُنشأ طلب صرف نقدي بمبلغ ${amount.toFixed(2)} د.ع بلا أثر حتى يعتمدَه مالك آخر.`,
        confirmText: "إنشاء الطلب",
      }))
    )
      return;
    requestSupplierPayment.mutate({
      purchaseOrderId,
      amount: amount.toFixed(2),
      method: "CASH",
      clientRequestId: laterPayRequestId,
    });
  }

  async function submit() {
    setError("");
    setDone("");
    const lines = data.items
      .map((it) => ({
        purchaseOrderItemId: Number(it.id),
        receivedBaseQuantity: Math.trunc(Number(recv[Number(it.id)] || 0)),
      }))
      .filter((l) => l.receivedBaseQuantity > 0);
    if (!lines.length) return setError("أدخل كمية استلام واحدة على الأقل.");
    for (const it of data.items) {
      const want = Math.trunc(Number(recv[Number(it.id)] || 0));
      const remaining = it.baseQuantity - (it.receivedBaseQuantity ?? 0);
      if (want > remaining)
        return setError(
          `الكمية المستلمة للمنتج «${it.productName}» تتجاوز المتبقّي (${remaining}).`,
        );
    }
    // أمر CASH لا يعتمد على مبلغ يدخله المستخدم: الخادم يطلب تلقائياً كامل قيمة هذا
    // الاستلام. أمر CREDIT وحده يقبل دفعة نقدية جزئية صريحة.
    const payment = data.settlementType === "CREDIT" && D(payAmount).gt(0)
        ? { amount: round2(D(payAmount)).toFixed(2), method: "CASH" as const }
        : undefined;
    if (shipMethod === "TRANSFER" && !shipPaymentReference.trim()) {
      return setError("أدخل مرجع تحويل الشحن.");
    }
    if (shipMethod === "CARD" && !/^\d{4}$/.test(shipCardLastFour.trim())) {
      return setError("أدخل آخر أربعة أرقام لبطاقة تسوية الشحن.");
    }
    if (
      !(await confirm({
        variant: "info",
        title: `استلام أمر الشراء ${data.poNumber}`,
        description:
          data.settlementType === "CASH"
            ? "سيُضاف المخزون ويُثبت استحقاق المورد، ثم يُنشأ طلب صرف نقدي تلقائياً بكامل قيمة هذا الاستلام لاعتماده من شخص آخر. تأكيد؟"
            : "سيُضاف المخزون وتُثبت القيمة ذمةً على المورد. تأكيد؟",
        confirmText: "استلام",
      }))
    )
      return;
    const bonusLines = canGiftBonus
      ? data.items
          .map((it) => ({
            variantId: Number(it.variantId),
            freeBaseQuantity: Math.trunc(Number(free[Number(it.id)] || 0)),
          }))
          .filter((b) => b.freeBaseQuantity > 0)
      : [];
    try {
      await receive.mutateAsync({
        purchaseOrderId,
        lines,
        payment,
        shippingPaymentMethod: shipMethod,
        shippingPaymentReference:
          shipMethod === "TRANSFER" ? shipPaymentReference.trim() : undefined,
        shippingCardLastFour:
          shipMethod === "CARD" ? shipCardLastFour.trim() : undefined,
        // الفراغ يُرسَل undefined لا نصّاً فارغاً (zod يفرض min على النصّ الموجود)؛ الخادم
        // يُكمل البديل الصريح. اسمُ الناقل الحرّ يُهمَل متى اختير مورّدٌ مسجَّل.
        shippingBeneficiarySupplierId: shipBeneficiarySupplierId
          ? Number(shipBeneficiarySupplierId)
          : undefined,
        shippingBeneficiaryName:
          !shipBeneficiarySupplierId && shipBeneficiaryName.trim().length >= 2
            ? shipBeneficiaryName.trim()
            : undefined,
        shippingEvidenceReference:
          shipEvidenceReference.trim().length >= 2
            ? shipEvidenceReference.trim()
            : undefined,
        clientRequestId,
      });
      // البونص المجّانيّ بعد نجاح الاستلام العاديّ (تسلسليّ idempotent — نمط convertQuotation؛ مفتاح مشتقّ).
      if (bonusLines.length)
        await recordBonus.mutateAsync({
          purchaseOrderId,
          bonusLines,
          clientRequestId: `${clientRequestId}:bonus`,
        });
      setClientRequestId(crypto.randomUUID()); // تصفيرٌ بعد نجاح الاثنين معاً
      setFree({});
    } catch {
      /* onError لكلتا الطفرتين يضبط رسالة الخطأ؛ لا نُصفّر المفتاح ⇒ إعادة المحاولة آمنة (replay) */
    }
  }

  const fmt = fmtAr;

  // طباعة سند استلام (جزئي أو كامل) — يوثِّق ما استُلم فعلياً حتى الآن. نستدعي القالب الموجود
  // (printPurchaseInvoiceV2 نفسه المُستعمَل لطباعة أمر الشراء في Purchases.tsx) بشارة توضّح أنه سند
  // استلام لا أمر شراء مجرّد — لا حاجة لقالب جديد.
  async function printReceiveSlip() {
    try {
      const receivedItems = data.items
        .filter((item) => (item.receivedBaseQuantity ?? 0) > 0)
        .map((item) => {
          const portion = D(item.receivedBaseQuantity ?? 0).dividedBy(
            D(item.baseQuantity || 1),
          );
          return {
            ...item,
            receivedPurchaseQuantity: D(item.quantity).times(portion),
            receivedLineTotal: round2(D(item.total ?? 0).times(portion)),
          };
        });
      const receivedSubtotal = round2(
        receivedItems.reduce(
          (sum, item) => sum.plus(item.receivedLineTotal),
          D(0),
        ),
      );
      const receivedTax = D(data.subtotal ?? 0).gt(0)
        ? round2(
            D(data.taxAmount ?? 0)
              .times(receivedSubtotal)
              .dividedBy(D(data.subtotal ?? 1)),
          )
        : D(0);
      const receivedTotal = round2(receivedSubtotal.plus(receivedTax));
      const remaining = positiveDiff(
        receivedTotal.toFixed(2),
        data.paidAmount ?? "0",
      );
      const taxShares = allocateLineTax(
        receivedItems.map((item) => ({
          total: item.receivedLineTotal.toFixed(2),
        })),
        receivedTax.toFixed(2),
        receivedSubtotal.toFixed(2),
      );
      const statusColor =
        data.status === "RECEIVED"
          ? "#0D6B52"
          : data.status === "CANCELLED"
            ? "#8A1F11"
            : "#92400E";
      const qrSvg = await qrCodeSvg(
        [
          CO.sub,
          `سند استلام تراكمي: ${data.poNumber}`,
          `الإجمالي المستلم: ${fmtAr(receivedTotal.toFixed(2))} د.ع`,
        ].join("\n"),
        { size: 88, margin: 1 },
      ).catch(() => "");
      printPurchaseInvoiceV2({
        qrSvg: qrSvg || null,
        invoiceNumber: data.poNumber,
        invoiceDate: data.orderDate as unknown as string | null,
        statusLabel: `سند استلام تراكمي — ${PO_STATUS[data.status] ?? data.status} · ${data.settlementType === "CASH" ? "نقدي" : "آجل"}`,
        statusColor,
        supplierName: data.supplierName,
        items: receivedItems.map((it, index) => ({
          productName: it.productName ?? "",
          unitName: it.unitName,
          quantity: it.receivedPurchaseQuantity.toFixed(3),
          unitPrice: it.unitPrice,
          taxAmount: taxShares[index] ?? "0",
          total: it.receivedLineTotal.toFixed(2),
        })),
        subtotal: receivedSubtotal.toFixed(2),
        taxAmount: receivedTax.toFixed(2),
        taxRate: Number(data.taxRatePercent ?? 0),
        total: receivedTotal.toFixed(2),
        paidAmount: data.paidAmount ?? "0",
        remainingAmount: remaining.toFixed(2),
      });
    } catch (e) {
      notify.err(e);
    }
  }
  const hasAnyReceived = data.items.some(
    (it) => (it.receivedBaseQuantity ?? 0) > 0,
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="استلام أمر شراء"
        actions={
          <Link href="/purchases" className="text-sm text-muted-foreground">
            ← رجوع للمشتريات
          </Link>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">بيانات الأمر</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div>
            <div className="text-muted-foreground text-xs">رقم الأمر</div>
            <div className="font-mono" dir="ltr">
              {data.poNumber}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">المورد</div>
            <div>{data.supplierName ?? "—"}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">الحالة</div>
            <div>{PO_STATUS[data.status] ?? data.status}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">نوع التسوية</div>
            <div>
              {data.settlementType === "CASH"
                ? "نقدي — طلب صرف تلقائي"
                : "آجل — ذمة مورد"}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">
              تكلفة المخزون / المسدد دفترياً
            </div>
            <div dir="ltr">
              {fmt(data.total)} / {fmt(data.paidAmount)}
            </div>
          </div>
          {data.agreedCurrency === "USD" && data.usdTotal && (
            <>
              <div>
                <div className="text-muted-foreground text-xs">
                  فاتورة المورد / المدفوع
                </div>
                <div dir="ltr" className="font-medium">
                  ${fmt(data.usdTotal)} / ${fmt(data.paidUsd)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">
                  سعر التثبيت (د.ع/$)
                </div>
                <div dir="ltr">
                  {data.agreedRate ? fmt(data.agreedRate) : "—"}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">
                  المتبقي للمورد
                </div>
                <div dir="ltr" className="font-bold">
                  $
                  {D(data.usdTotal)
                    .minus(D(data.paidUsd ?? 0))
                    .minus(D(data.returnedUsd ?? 0))
                    .toFixed(2)}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">المنتجات</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2">المنتج</th>
                <th className="p-2">الوحدة</th>
                <th className="p-2 text-center">سعر المورد</th>
                <th className="p-2 text-center">المعادل د.ع</th>
                <th className="p-2 text-center">الكلفة بعد الشحن</th>
                <th className="p-2 text-center">المطلوب (أساس)</th>
                <th className="p-2 text-center">مُستلَم سابقاً</th>
                <th className="p-2 text-center">المتبقّي</th>
                <th className="p-2 w-32">استلام الآن</th>
                {canGiftBonus ? (
                  <th className="p-2 w-28">كمية مجانية (بالوحدة الأساس)</th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {data.items.map((it) => {
                const already = it.receivedBaseQuantity ?? 0;
                const remaining = it.baseQuantity - already;
                const landed = D(data.shippingCost ?? 0).plus(
                  D(data.customsCost ?? 0),
                );
                const share = D(data.subtotal ?? 0).gt(0)
                  ? landed
                      .times(D(it.total ?? 0))
                      .dividedBy(D(data.subtotal ?? 1))
                  : D(0);
                // قرار المالك (٥/٨/٢٦): تكلفة الوحدة = سعر المورّد وحده — حصّة الشحن (share) تبقى
                // معروضةً للعِلم فقط ولا تُضاف هنا، لأنّها لم تعُد تدخل WAVG (صارت مصروف نقل).
                const finalUnit = D(it.quantity ?? 0).gt(0)
                  ? D(it.total ?? 0).dividedBy(D(it.quantity))
                  : D(0);
                return (
                  <tr key={it.id} className="border-t">
                    <td className="p-2">
                      {it.productName}
                      {it.variantName ? ` — ${it.variantName}` : ""}{" "}
                      <span
                        className="text-xs text-muted-foreground font-mono"
                        dir="ltr"
                      >
                        {it.sku}
                      </span>
                    </td>
                    <td className="p-2 text-muted-foreground">{it.unitName}</td>
                    <td className="p-2 text-center tabular-nums" dir="ltr">
                      {data.agreedCurrency === "USD"
                        ? `${fmt(it.usdUnitPrice)} $`
                        : `${fmt(it.unitPrice)} د.ع`}
                    </td>
                    <td className="p-2 text-center tabular-nums" dir="ltr">
                      {fmt(it.unitPrice)} د.ع
                    </td>
                    <td
                      className="p-2 text-center font-bold tabular-nums"
                      dir="ltr"
                    >
                      {fmt(finalUnit.toFixed(2))} د.ع
                    </td>
                    <td className="p-2 text-center">{it.baseQuantity}</td>
                    <td className="p-2 text-center">{already}</td>
                    <td className="p-2 text-center">{remaining}</td>
                    <td className="p-2">
                      {/* NumberInput: لوحة أرقام على الجوال (inputMode) + حدّ أدنى صفر (لا سالب — allowNegative
                          افتراضياً false) + عدد صحيح فقط (decimals=0، الكمية بالوحدة الأساس). */}
                      <NumberInput
                        className="h-8 text-center"
                        value={recv[Number(it.id)] ?? ""}
                        disabled={closed || remaining <= 0}
                        onChange={(v) =>
                          setRecv((prev) => ({ ...prev, [Number(it.id)]: v }))
                        }
                        ariaLabel={`استلام الآن — ${it.productName}`}
                      />
                    </td>
                    {canGiftBonus ? (
                      <td className="p-2">
                        <NumberInput
                          className="h-8 text-center"
                          placeholder="0"
                          value={free[Number(it.id)] ?? ""}
                          disabled={closed}
                          onChange={(v) =>
                            setFree((prev) => ({ ...prev, [Number(it.id)]: v }))
                          }
                          ariaLabel={`كمية مجانية — ${it.productName}`}
                        />
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* مصروف الشحن/الكمرك — يُسجَّل مصروف نقلٍ على الشركة لحظة الاستلام (لا على المورّد). */}
      {!closed &&
        D(data.shippingCost ?? 0)
          .plus(D(data.customsCost ?? 0))
          .gt(0) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">مصروف الشحن/الكمرك</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                شحن هذا الأمر{" "}
                <span
                  dir="ltr"
                  className="font-bold tabular-nums text-foreground"
                >
                  {fmt(
                    D(data.shippingCost ?? 0)
                      .plus(D(data.customsCost ?? 0))
                      .toFixed(2),
                  )}{" "}
                  د.ع
                </span>{" "}
                يُثبَت <strong>مصروف نقلٍ والتزامٌ على الشركة</strong> بحصّة ما
                تستلمه الآن — لا يُضاف إلى ذمّة المورّد ولا إلى تكلفة الصنف.
                لا تُسجّله مرةً ثانية من شاشة المصروفات؛ اختر أداة التسوية المتوقعة
                هنا، ويبقى السداد معلّقاً حتى اعتماد مالكٍ آخر.
              </p>
              <div className="space-y-1">
                <Label>طريقة دفع الشحن</Label>
                <select
                  className={selectCls}
                  value={shipMethod}
                  onChange={(e) =>
                    setShipMethod(e.target.value as typeof shipMethod)
                  }
                >
                  {SHIPPING_METHODS.map((m) => (
                    <option key={m.v} value={m.v}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              {/* الناقل ومستند الشحن — اختياريّان. لا يحجبان الاستلام؛ تركُهما فارغَين يُسجّل
                المصروف باسم «ناقل غير محدَّد» ومرجعِ أمر الشراء، ويبقى قابلاً للتصحيح لاحقاً. */}
              <div className="space-y-1">
                <Label>
                  الناقل / المستفيد{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    (اختياري)
                  </span>
                </Label>
                <select
                  className={selectCls}
                  value={shipBeneficiarySupplierId}
                  onChange={(e) => setShipBeneficiarySupplierId(e.target.value)}
                >
                  <option value="">— غير محدَّد / اسم حرّ —</option>
                  {(suppliersQuery.data ?? []).map((s) => (
                    <option key={s.id} value={String(s.id)}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              {!shipBeneficiarySupplierId ? (
                <div className="space-y-1">
                  <Label>
                    اسم الناقل{" "}
                    <span className="text-xs font-normal text-muted-foreground">
                      (اختياري)
                    </span>
                  </Label>
                  <Input
                    value={shipBeneficiaryName}
                    onChange={(event) =>
                      setShipBeneficiaryName(event.target.value)
                    }
                    placeholder="اتركه فارغاً إن لم يُعرَف بعد"
                    maxLength={200}
                  />
                </div>
              ) : null}
              <div className="space-y-1">
                <Label>
                  رقم فاتورة/وصل الشحن أو مستند الكمرك{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    (اختياري)
                  </span>
                </Label>
                <Input
                  value={shipEvidenceReference}
                  onChange={(event) =>
                    setShipEvidenceReference(event.target.value)
                  }
                  placeholder={`الافتراضي: أمر الشراء ${data.poNumber}`}
                  maxLength={191}
                  dir="ltr"
                />
              </div>
              {shipMethod === "TRANSFER" ? (
                <div className="space-y-1">
                  <Label>مرجع التحويل</Label>
                  <Input
                    value={shipPaymentReference}
                    onChange={(event) =>
                      setShipPaymentReference(event.target.value)
                    }
                    maxLength={50}
                    dir="ltr"
                  />
                </div>
              ) : null}
              {shipMethod === "CARD" ? (
                <div className="space-y-1">
                  <Label>آخر أربعة أرقام للبطاقة</Label>
                  <Input
                    value={shipCardLastFour}
                    onChange={(event) =>
                      setShipCardLastFour(
                        event.target.value.replace(/\D/g, "").slice(0, 4),
                      )
                    }
                    inputMode="numeric"
                    maxLength={4}
                    dir="ltr"
                  />
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground sm:col-span-2">
                لا يحدث أي صرف عند الاستلام. يبقى المبلغ التزاماً حتى يعتمد مالك
                آخر طلب التسوية، مع حفظ أداة الدفع ومرجعها.
              </p>
            </CardContent>
          </Card>
        )}
      {!closed &&
        data.agreedCurrency !== "USD" &&
        data.settlementType === "CASH" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">تسوية المورد النقدية</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                عند الاستلام ينشئ النظام تلقائياً طلب صرف نقدي من الخزينة بكامل
                قيمة الكميات المستلمة. يبقى الطلب معلّقاً حتى يعتمدَه شخص آخر؛
                عندها فقط ينخفض رصيد المورد ويُسجّل خروج النقد.
              </p>
            </CardContent>
          </Card>
        )}
      {!closed &&
        data.agreedCurrency !== "USD" &&
        data.settlementType === "CREDIT" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">دفعة للمورد (اختياري)</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
              <div className="space-y-1">
                <Label>طلب دفعة نقدية مع هذا الاستلام</Label>
                <MoneyInput
                  value={payAmount}
                  onChange={setPayAmount}
                  placeholder="0"
                />
              </div>
              <p className="text-sm text-muted-foreground">
                يُنشأ طلب صرف نقدي معلّق لاعتماد شخص آخر. البطاقة والتحويل
                يُسجّلان من سند صرف موثّق بمرجعهما.
              </p>
            </CardContent>
          </Card>
        )}
      {canManagePurchases &&
        hasAnyReceived &&
        data.agreedCurrency !== "USD" &&
        data.status !== "CANCELLED" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                طلب سداد ذمة مرتبطة بالأمر
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
              <div className="space-y-1">
                <Label>مبلغ طلب الصرف النقدي</Label>
                <MoneyInput
                  value={laterPayAmount}
                  onChange={setLaterPayAmount}
                  placeholder="0"
                />
              </div>
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  يعتمد السقف على رصيد دفتر الأستاذ لهذا الأمر بعد الاستلامات
                  والمرتجعات، ويخصم الطلبات المعلّقة؛ فلا تُدفع بضاعة غير مستلمة
                  ولا يُحجز المبلغ مرتين.
                </p>
                <Button
                  onClick={() => void submitLaterSupplierPayment()}
                  disabled={requestSupplierPayment.isPending}
                >
                  {requestSupplierPayment.isPending
                    ? "جارٍ إنشاء الطلب…"
                    : "إنشاء طلب دفع"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      {data.agreedCurrency === "USD" &&
        data.status !== "CANCELLED" &&
        remainingUsd.gt(0) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">تسديد فاتورة الدولار</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                للدفع من الصيرفة استخدم
                <Link
                  href="/exchange?tab=settle"
                  className="mx-1 font-bold text-primary"
                >
                  تسديد مورد عبر الصيرفة
                </Link>
                أو أنشئ أدناه طلب دفع مباشر من البطاقة/التحويل. يبقى الطلب بلا
                أثر مالي حتى اعتماد مالك آخر.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4 items-end">
                <div className="space-y-1">
                  <Label>الدولار الواصل للمورد ($)</Label>
                  <MoneyInput
                    value={directUsd}
                    onChange={setDirectUsd}
                    placeholder="0.00"
                  />
                </div>
                <div className="space-y-1">
                  <Label>المبلغ المسحوب فعلياً (د.ع)</Label>
                  <MoneyInput
                    value={directIqd}
                    onChange={setDirectIqd}
                    placeholder="0.00"
                  />
                </div>
                <div className="space-y-1">
                  <Label>العمولة (د.ع)</Label>
                  <MoneyInput
                    value={directFee}
                    onChange={setDirectFee}
                    placeholder="0.00"
                  />
                </div>
                <div className="space-y-1">
                  <Label>المصدر</Label>
                  <select
                    className={selectCls}
                    value={directMethod}
                    onChange={(e) =>
                      setDirectMethod(e.target.value as typeof directMethod)
                    }
                  >
                    <option value="CARD">بطاقة</option>
                    <option value="TRANSFER">تحويل مصرفي</option>
                    <option value="WALLET">محفظة دينارية</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label>رقم المرجع</Label>
                  <Input
                    value={directReference}
                    onChange={(e) => setDirectReference(e.target.value)}
                    placeholder="رقم العملية"
                  />
                </div>
                {directMethod === "CARD" && (
                  <div className="space-y-1">
                    <Label>آخر أربعة أرقام</Label>
                    <Input
                      value={directCardLastFour}
                      onChange={(e) =>
                        setDirectCardLastFour(
                          e.target.value.replace(/\D/g, "").slice(0, 4),
                        )
                      }
                      inputMode="numeric"
                      maxLength={4}
                      dir="ltr"
                      placeholder="4242"
                    />
                  </div>
                )}
              </div>
              {/^\d+(\.\d{0,2})?$/.test(directUsd) && data.agreedRate && (
                <div className="rounded-md bg-muted/50 p-3 text-sm">
                  القيمة الدفترية بسعر الفاتورة:{" "}
                  <b dir="ltr">
                    {fmt(
                      round2(D(directUsd).times(D(data.agreedRate))).toFixed(2),
                    )}{" "}
                    د.ع
                  </b>
                </div>
              )}
              <Button
                onClick={submitDirectUsdPayment}
                disabled={settleUsdDirect.isPending}
              >
                {settleUsdDirect.isPending
                  ? "جارٍ إنشاء الطلب…"
                  : "إنشاء طلب الدفع المباشر"}
              </Button>
            </CardContent>
          </Card>
        )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {done && <p className="text-sm text-money-positive">{done}</p>}
      <div className="flex gap-2">
        {!closed && (
          <Button onClick={submit} disabled={receive.isPending}>
            {receive.isPending ? "جارٍ الاستلام…" : "تأكيد الاستلام"}
          </Button>
        )}
        <Button
          variant="outline"
          onClick={() => void printReceiveSlip()}
          disabled={!hasAnyReceived}
          title={
            hasAnyReceived ? undefined : "لا كميات مُستلَمة بعد لطباعة سند بها"
          }
        >
          طباعة سند الاستلام
        </Button>
        <Link href="/purchases">
          <Button variant="outline">{closed ? "رجوع" : "إلغاء"}</Button>
        </Link>
      </div>
    </div>
  );
}
