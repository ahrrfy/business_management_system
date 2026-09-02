import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AppSelect } from "@/components/ui/AppSelect";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { EmptyState } from "@/components/EmptyState";
import { fmtDate } from "@/lib/date";
import { D, fmtAr, positiveDiff } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { hasModuleAccess } from "@shared/permissions";
import { Banknote, CheckCircle, Gift, Pencil } from "lucide-react";
import { Link, useParams } from "wouter";
import { useState } from "react";
import { MoneyInput } from "@/components/form/MoneyInput";
import { NumberInput } from "@/components/form/NumberInput";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";
import { round2 } from "@/lib/money";
import { confirm } from "@/lib/confirm";

const PO_STATUS: Record<string, string> = {
  DRAFT: "مسوّدة",
  SENT: "مُرسَل",
  CONFIRMED: "بانتظار الترحيل (قديم)",
  RECEIVED: "معتمدة ومضافة للمخزون",
  CANCELLED: "ملغى",
};

/** نبرة الحالة عبر variants الشارة (توكنز، لا ألوان خام — حارس check:colors). */
function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "RECEIVED") return "default";
  if (status === "CANCELLED") return "destructive";
  if (status === "DRAFT") return "outline";
  return "secondary";
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

/**
 * تفاصيل فاتورة الشراء ومكان مراجعتها واعتمادها وتسديدها.
 *
 * سدّ رابطٍ مكسور: «سجلّ المشتريات» و«دفتر الأستاذ» يربطان رقم الأمر بـ`/purchases/:id`
 * وكان المسار غير معرَّف في App.tsx ⇒ صفحة فارغة عند كل نقرة (تدقيق ١٧/٧، السطر ٣٤١).
 * الصفحة هي الوجهة الوحيدة بعد حفظ الفاتورة؛ لا توجد شاشة استلام مستقلة. اعتماد الفاتورة يرحّل
 * كاملها للمخزون والدفتر، وتبقى هنا أدوات التسديد اللاحق فقط.
 *
 * التكلفة محجوبة خادمياً لغير أدواتها (`purchases.get` يُفرغ الأسعار والإجماليات إلى null)
 * ⇒ الشاشة تعرض «—» بلا منطق حجبٍ عميليّ موازٍ.
 */
export default function PurchaseOrderDetail() {
  const params = useParams();
  const purchaseOrderId = Number(params.id);
  const po = trpc.purchases.get.useQuery(
    { purchaseOrderId },
    { enabled: Number.isFinite(purchaseOrderId) && purchaseOrderId > 0 }
  );
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();
  const [payAmount, setPayAmount] = useState("");
  const [payRequestId, setPayRequestId] = useState(() => crypto.randomUUID());
  const [directUsd, setDirectUsd] = useState("");
  const [directIqd, setDirectIqd] = useState("");
  const [directFee, setDirectFee] = useState("");
  const [directMethod, setDirectMethod] = useState<"CARD" | "TRANSFER" | "WALLET">("CARD");
  const [directReference, setDirectReference] = useState("");
  const [directCardLastFour, setDirectCardLastFour] = useState("");
  const [directRequestId, setDirectRequestId] = useState(() => crypto.randomUUID());
  const [bonusQuantities, setBonusQuantities] = useState<Record<number, string>>({});
  const [bonusRequestId, setBonusRequestId] = useState(() => crypto.randomUUID());
  const [shippingPaymentMethod, setShippingPaymentMethod] =
    useState<"CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET">("CASH");
  const [shippingPaymentReference, setShippingPaymentReference] = useState("");
  const [shippingCardLastFour, setShippingCardLastFour] = useState("");
  const [shippingBeneficiaryName, setShippingBeneficiaryName] = useState("");
  const [shippingEvidenceReference, setShippingEvidenceReference] = useState("");
  const approve = trpc.purchases.confirmOrder.useMutation({
    onSuccess: async () => {
      notify.ok("اعتُمدت فاتورة الشراء وأُضيف كامل محتواها إلى المخزون");
      await Promise.all([
        utils.purchases.get.invalidate({ purchaseOrderId }),
        utils.purchases.list.invalidate(),
      ]);
    },
    onError: (e) => notify.err(e),
  });
  const pay = trpc.purchases.pay.useMutation({
    onSuccess: async (r) => {
      notify.ok(
        "أُنشئ طلب التسديد",
        `المبلغ محجوزٌ بانتظار اعتماد مالكٍ ثانٍ — لا يُصرَف ولا يُنقص المتبقّي (${r.remainingBefore}) قبله.`,
      );
      setPayAmount("");
      setPayRequestId(crypto.randomUUID());
      await utils.purchases.get.invalidate({ purchaseOrderId });
      await utils.purchases.list.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  const settleUsdDirect = trpc.purchases.settleUsdDirect.useMutation({
    onSuccess: async (r) => {
      notify.ok(
        "أُنشئ طلب تسديد الدولار",
        `الطلب #${r.receiptId} ينتظر اعتماد مالك آخر؛ فرق الصرف المتوقع ${fmtAr(r.fxDiff)} د.ع.`,
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
    onError: (e) => notify.err(e),
  });

  const recordBonus = trpc.gifts.receivePurchaseBonus.useMutation({
    onSuccess: async (r) => {
      notify.ok(r?.giftNumber ? `سُجّل بونص المورد ${r.giftNumber}` : "لا توجد كمية بونص لتسجيلها");
      setBonusQuantities({});
      setBonusRequestId(crypto.randomUUID());
      await utils.purchases.get.invalidate({ purchaseOrderId });
    },
    onError: (e) => notify.err(e),
  });

  const canManagePurchases = hasModuleAccess(
    me.data?.role ?? "",
    (me.data as { permissionsOverride?: Record<string, "NONE" | "READ" | "FULL"> | null } | undefined)
      ?.permissionsOverride ?? null,
    "purchases",
    "FULL"
  );
  const canRecordBonus = hasModuleAccess(
    me.data?.role ?? "",
    (me.data as { permissionsOverride?: Record<string, "NONE" | "READ" | "FULL"> | null } | undefined)
      ?.permissionsOverride ?? null,
    "gifts",
    "FULL",
  );

  if (!Number.isFinite(purchaseOrderId) || purchaseOrderId <= 0) {
    return <ErrorState message="رقم أمر شراء غير صالح." />;
  }
  if (po.isLoading) return <LoadingState />;
  // دورٌ مُنح «التقارير» صراحةً دون «المشتريات» يعبُر سجلّ المشتريات/الأستاذ (بوّابة reports)
  // ثمّ يصطدم هنا بـFORBIDDEN لأنّ `purchases.get` يلزمه purchases≥READ. لا نُوسّع الإجراء
  // (يسرّب تكلفة الشراء لأدوارٍ لم تُمنَحها) — نشرح السبب بدل خطأٍ خام.
  if (po.error) {
    return po.error.data?.code === "FORBIDDEN" ? (
      <EmptyState
        title="لا تملك صلاحية «المشتريات»"
        description="تفاصيل أمر الشراء تتطلّب صلاحية المشتريات (قراءة) — اطلبها من المدير."
      />
    ) : (
      <ErrorState message={po.error.message} />
    );
  }
  if (!po.data) {
    return (
      <EmptyState
        title="أمر الشراء غير موجود"
        description="قد يكون محذوفاً أو يخصّ فرعاً آخر لا تملك الاطّلاع عليه."
      />
    );
  }

  const d = po.data;
  const costHidden = d.total === null;
  const isUsd = d.agreedCurrency === "USD";
  // المتبقّي للمورّد بعملة الاتفاق: أمر الدولار تُتابَع ذمّته بـusdTotal−paidUsd−returnedUsd
  // (نفس حساب خدمة التسوية) — عرض متبقّي الدينار وحده يُظهر رقماً مختلفاً مادّياً.
  const remaining = costHidden
    ? null
    : isUsd
      ? positiveDiff(d.usdTotal, D(d.paidUsd ?? 0).plus(D(d.returnedUsd ?? 0)).toString())
      : positiveDiff(d.total, d.paidAmount);
  const hasShippingExpense = D(d.shippingCost ?? 0).plus(D(d.customsCost ?? 0)).gt(0);
  // التعديل ممكن ما لم يبدأ الأثر الفعليّ: أمرٌ نهائيّ، أو استُلم منه سطر، أو حمل دفعة.
  // نفس حرّاس `updatePurchaseOrder` — والخادم هو الحكم النهائيّ.
  const openForEditing =
    d.status !== "RECEIVED" &&
    d.status !== "CANCELLED" &&
    !d.items.some((it) => (it.receivedBaseQuantity ?? 0) > 0) &&
    !D(d.paidAmount ?? 0).gt(0) &&
    !D(d.paidUsd ?? 0).gt(0);

  async function submitDirectUsdPayment() {
    let usd;
    let iqd;
    let fee;
    try {
      usd = round2(D(directUsd));
      iqd = round2(D(directIqd));
      fee = round2(D(directFee || "0"));
    } catch {
      return notify.err("تحقق من مبالغ التسديد المدخلة");
    }
    if (usd.lte(0) || iqd.lte(0)) return notify.err("أدخل مبلغ الدولار والمبلغ الديناري الفعلي");
    if (remaining == null || usd.gt(remaining)) return notify.err("مبلغ الدولار يتجاوز المتبقي على الفاتورة");
    if (fee.lt(0)) return notify.err("العمولة لا تكون سالبة");
    if (!directReference.trim()) return notify.err("أدخل رقم مرجع البطاقة أو التحويل");
    if (directMethod === "CARD" && !/^\d{4}$/.test(directCardLastFour)) {
      return notify.err("أدخل آخر أربعة أرقام للبطاقة");
    }
    const ok = await confirm({
      variant: "info",
      title: "إنشاء طلب تسديد فاتورة الدولار",
      description: `سيُنشأ طلب مقابل ${usd.toFixed(2)}$ بقيمة فعلية ${iqd.toFixed(2)} د.ع، ويبقى بلا أثر حتى اعتماد مالك آخر.`,
      confirmText: "إنشاء الطلب",
    });
    if (!ok) return;
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

  function submitBonus() {
    const byVariant = new Map<number, number>();
    for (const item of d.items) {
      const quantity = Math.trunc(Number(bonusQuantities[Number(item.id)] || 0));
      if (quantity > 0) {
        const variantId = Number(item.variantId);
        byVariant.set(variantId, (byVariant.get(variantId) ?? 0) + quantity);
      }
    }
    const bonusLines = Array.from(byVariant, ([variantId, freeBaseQuantity]) => ({ variantId, freeBaseQuantity }));
    if (!bonusLines.length) return notify.err("أدخل كمية بونص واحدة على الأقل");
    recordBonus.mutate({ purchaseOrderId, bonusLines, clientRequestId: bonusRequestId });
  }

  async function approveInvoice() {
    if (
      hasShippingExpense &&
      (shippingPaymentMethod === "TRANSFER" || shippingPaymentMethod === "CHECK") &&
      !shippingPaymentReference.trim()
    ) {
      return notify.err(
        shippingPaymentMethod === "CHECK"
          ? "أدخل رقم صك تسوية الشحن"
          : "أدخل مرجع تحويل تسوية الشحن",
      );
    }
    if (hasShippingExpense && shippingPaymentMethod === "CARD" && !/^\d{4}$/.test(shippingCardLastFour)) {
      return notify.err("أدخل آخر أربعة أرقام لبطاقة تسوية الشحن");
    }
    const ok = await confirm({
      variant: "info",
      title: "اعتماد فاتورة الشراء",
      description: `تأكد أن البضاعة وصلت فعلياً. سيضيف النظام كامل الكميات المتبقية في ${d.poNumber} إلى المخزون ويثبت القيد والذمة فوراً.`,
      confirmText: "اعتماد وإضافة للمخزون",
      cancelText: "تراجع",
    });
    if (ok) {
      approve.mutate({
        purchaseOrderId,
        shippingPaymentMethod: hasShippingExpense ? shippingPaymentMethod : undefined,
        shippingPaymentReference:
          hasShippingExpense &&
          (shippingPaymentMethod === "TRANSFER" || shippingPaymentMethod === "CHECK")
            ? shippingPaymentReference.trim()
            : undefined,
        shippingCardLastFour:
          hasShippingExpense && shippingPaymentMethod === "CARD" ? shippingCardLastFour : undefined,
        shippingBeneficiaryName:
          hasShippingExpense && shippingBeneficiaryName.trim().length >= 2
            ? shippingBeneficiaryName.trim()
            : undefined,
        shippingEvidenceReference:
          hasShippingExpense && shippingEvidenceReference.trim().length >= 2
            ? shippingEvidenceReference.trim()
            : undefined,
      });
    }
  }

  const canApprove =
    canManagePurchases &&
    (d.status === "DRAFT" || d.status === "SENT" || d.status === "CONFIRMED");

  return (
    <div className="space-y-4">
      <PageHeader
        title={`فاتورة شراء ${d.poNumber ?? `#${d.id}`}`}
        actions={
          canManagePurchases && (openForEditing || canApprove) ? (
            <div className="flex items-center gap-2">
              {canApprove ? (
                <Button size="sm" onClick={() => void approveInvoice()} disabled={approve.isPending}>
                  <CheckCircle aria-hidden className="size-4" />
                  {approve.isPending ? "جارٍ الاعتماد…" : "اعتماد وإضافة للمخزون"}
                </Button>
              ) : null}
              {openForEditing ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={`/purchases/${d.id}/edit`}>
                    <Pencil aria-hidden className="size-4" />
                    تعديل
                  </Link>
                </Button>
              ) : null}
            </div>
          ) : undefined
        }
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">بيانات الأمر</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Field label="المورّد">
            {d.supplierId ? (
              <Link href={`/suppliers/${d.supplierId}/edit`} className="text-primary underline-offset-2 hover:underline">
                {d.supplierName ?? `#${d.supplierId}`}
              </Link>
            ) : (
              (d.supplierName ?? "—")
            )}
          </Field>
          <Field label="التاريخ">{fmtDate(d.orderDate)}</Field>
          <Field label="الحالة">
            <Badge variant={statusVariant(d.status)}>{PO_STATUS[d.status] ?? d.status}</Badge>
          </Field>
          <Field label="العملة المتّفقة">{d.agreedCurrency ?? "IQD"}</Field>
          {d.notes ? (
            <div className="col-span-2 md:col-span-4">
              <Field label="ملاحظات">{d.notes}</Field>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {canApprove && hasShippingExpense ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">تسوية مصروف الشحن عند الاعتماد</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="po-approve-shipping-method">أداة التسوية</Label>
              <AppSelect
                id="po-approve-shipping-method"
                value={shippingPaymentMethod}
                onValueChange={(value) =>
                  setShippingPaymentMethod(value as typeof shippingPaymentMethod)
                }
              >
                <option value="CASH">نقدي</option>
                <option value="TRANSFER">تحويل</option>
                <option value="CHECK">صك</option>
                <option value="CARD">بطاقة</option>
                <option value="WALLET">محفظة</option>
              </AppSelect>
            </div>
            {shippingPaymentMethod === "TRANSFER" || shippingPaymentMethod === "CHECK" ? (
              <div className="space-y-1">
                <Label htmlFor="po-approve-shipping-reference">
                  {shippingPaymentMethod === "CHECK" ? "رقم الصك" : "مرجع التحويل"}
                </Label>
                <Input
                  id="po-approve-shipping-reference"
                  value={shippingPaymentReference}
                  onChange={(event) => setShippingPaymentReference(event.target.value)}
                  maxLength={50}
                />
              </div>
            ) : null}
            {shippingPaymentMethod === "CARD" ? (
              <div className="space-y-1">
                <Label htmlFor="po-approve-shipping-card">آخر أربعة أرقام</Label>
                <Input
                  id="po-approve-shipping-card"
                  value={shippingCardLastFour}
                  onChange={(event) =>
                    setShippingCardLastFour(event.target.value.replace(/\D/g, "").slice(0, 4))
                  }
                  inputMode="numeric"
                  dir="ltr"
                  maxLength={4}
                />
              </div>
            ) : null}
            <div className="space-y-1">
              <Label htmlFor="po-approve-shipping-beneficiary">اسم الناقل (اختياري)</Label>
              <Input
                id="po-approve-shipping-beneficiary"
                value={shippingBeneficiaryName}
                onChange={(event) => setShippingBeneficiaryName(event.target.value)}
                maxLength={200}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="po-approve-shipping-evidence">فاتورة/وصل الشحن (اختياري)</Label>
              <Input
                id="po-approve-shipping-evidence"
                value={shippingEvidenceReference}
                onChange={(event) => setShippingEvidenceReference(event.target.value)}
                maxLength={191}
              />
            </div>
            <p className="text-xs text-muted-foreground md:col-span-2">
              يُثبت المصروف مع الفاتورة، لكن الصرف يبقى معلّقاً حتى اعتماد شخص آخر.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* تسديد فاتورة الشراء — الفجوة التي كانت تُبقي الشراء الآجل بلا مسار إقفال: بطاقة الدفع
          كانت تختفي بعد الترحيل ولا «تسديد» في الإجراءات، فيخرج كل سدادٍ لاحق إلى سند صرفٍ عامّ
          لا يمسّ `paidAmount` ⇒ «المتبقّي» يطالب بمبلغٍ مسدَّد وخطرُ دفعٍ مكرَّر للمورّد. */}
      {canManagePurchases && !isUsd && d.status === "RECEIVED" && remaining != null && remaining.gt(0) ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">تسديد للمورّد</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              المتبقّي {fmtAr(remaining.toFixed(2))} د.ع. التسديد نقديّ، ويُنشأ طلباً معلّقاً يعتمده مالكٌ
              ثانٍ — لا يخرج المال ولا يُنقص المتبقّي قبل الاعتماد.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-40 space-y-1">
                <Label htmlFor="po-pay-amount">المبلغ</Label>
                <MoneyInput value={payAmount} onChange={setPayAmount} placeholder={remaining.toFixed(2)} />
              </div>
              <Button
                size="sm"
                disabled={pay.isPending || !D(payAmount || "0").gt(0)}
                onClick={() => {
                  const amount = round2(D(payAmount || "0"));
                  if (!amount.gt(0)) return notify.err("أدخل مبلغاً موجباً");
                  if (amount.gt(remaining)) return notify.err(`المبلغ يتجاوز المتبقّي (${fmtAr(remaining.toFixed(2))})`);
                  pay.mutate({
                    purchaseOrderId,
                    amount: amount.toFixed(2),
                    method: "CASH",
                    clientRequestId: payRequestId,
                  });
                }}
              >
                <Banknote aria-hidden className="size-4" />
                طلب تسديد
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {canManagePurchases && isUsd && d.status === "RECEIVED" && remaining != null && remaining.gt(0) ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">تسديد فاتورة الدولار</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              استخدم <Link href="/exchange?tab=settle" className="font-bold text-primary hover:underline">الصيرفة</Link>،
              أو أنشئ طلباً مباشراً بمرجع البطاقة/التحويل. لا يتغيّر الرصيد قبل اعتماد مالك آخر.
            </p>
            <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-3 xl:grid-cols-6">
              <div className="space-y-1">
                <Label htmlFor="po-usd-amount">الدولار للمورّد</Label>
                <MoneyInput id="po-usd-amount" value={directUsd} onChange={setDirectUsd} placeholder="0.00" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="po-iqd-amount">المسحوب بالدينار</Label>
                <MoneyInput id="po-iqd-amount" value={directIqd} onChange={setDirectIqd} placeholder="0.00" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="po-usd-fee">العمولة</Label>
                <MoneyInput id="po-usd-fee" value={directFee} onChange={setDirectFee} placeholder="0.00" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="po-usd-method">المصدر</Label>
                <AppSelect id="po-usd-method" value={directMethod} onValueChange={(v) => setDirectMethod(v as typeof directMethod)}>
                  <option value="CARD">بطاقة</option>
                  <option value="TRANSFER">تحويل مصرفي</option>
                  <option value="WALLET">محفظة دينارية</option>
                </AppSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor="po-usd-reference">رقم المرجع</Label>
                <Input id="po-usd-reference" value={directReference} onChange={(e) => setDirectReference(e.target.value)} placeholder="رقم العملية" />
              </div>
              {directMethod === "CARD" ? (
                <div className="space-y-1">
                  <Label htmlFor="po-usd-card">آخر أربعة أرقام</Label>
                  <Input
                    id="po-usd-card"
                    value={directCardLastFour}
                    onChange={(e) => setDirectCardLastFour(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    inputMode="numeric"
                    maxLength={4}
                    dir="ltr"
                    placeholder="4242"
                  />
                </div>
              ) : null}
            </div>
            <Button onClick={() => void submitDirectUsdPayment()} disabled={settleUsdDirect.isPending}>
              {settleUsdDirect.isPending ? "جارٍ إنشاء الطلب…" : "إنشاء طلب التسديد"}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {canRecordBonus && d.status === "RECEIVED" ? (
        <Card>
          <details>
            <summary className="cursor-pointer px-6 py-4 text-sm font-bold">
              <span className="inline-flex items-center gap-2"><Gift aria-hidden className="size-4" /> بونص مجاني من المورّد</span>
            </summary>
            <CardContent className="space-y-3 border-t pt-4">
              <p className="text-xs text-muted-foreground">استخدمه فقط للكميات المجانية غير المحسوبة ضمن سطور الفاتورة.</p>
              <div className="grid gap-2 md:grid-cols-2">
                {d.items.map((item) => (
                  <label key={item.id} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
                    <span className="min-w-0 truncate">{item.productName ?? `صنف #${item.variantId}`}</span>
                    <NumberInput
                      value={bonusQuantities[Number(item.id)] ?? ""}
                      onChange={(value) => setBonusQuantities((current) => ({ ...current, [Number(item.id)]: value }))}
                      ariaLabel={`كمية البونص لـ${item.productName ?? item.variantId}`}
                      placeholder="0"
                      className="w-24"
                    />
                  </label>
                ))}
              </div>
              <Button size="sm" onClick={submitBonus} disabled={recordBonus.isPending}>
                {recordBonus.isPending ? "جارٍ التسجيل…" : "تسجيل البونص"}
              </Button>
            </CardContent>
          </details>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">البنود</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="p-2.5 text-end font-medium">الصنف</th>
                  <th className="p-2.5 text-end font-medium">الوحدة</th>
                  <th className="p-2.5 text-end font-medium">الكمية</th>
                  <th className="p-2.5 text-end font-medium">المضاف للمخزون / كمية الفاتورة (أساس)</th>
                  <th className="p-2.5 text-end font-medium">سعر الوحدة{isUsd ? " ($)" : ""}</th>
                  <th className="p-2.5 text-end font-medium">الإجمالي{isUsd ? " ($)" : ""}</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((it) => (
                  <tr key={it.id} className="border-b last:border-0">
                    <td className="p-2.5 text-end">
                      {it.productName ?? "—"}
                      {it.variantName ? <span className="text-muted-foreground"> — {it.variantName}</span> : null}
                    </td>
                    <td className="p-2.5 text-end">{it.unitName ?? "—"}</td>
                    <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(it.quantity)}</td>
                    {/* الطرفان بوحدة الأساس: `quantity` بوحدة الشراء و`receivedBaseQuantity` بالأساس،
                        فمقارنتهما مباشرةً تُظهر «٢ مطلوب / ٢٤ مستلَم» لكرتونٍ من ١٢. */}
                    <td className="p-2.5 text-right tabular-nums" dir="ltr">
                      {fmtAr(it.receivedBaseQuantity)} / {fmtAr(it.baseQuantity)}
                    </td>
                    <td className="p-2.5 text-right tabular-nums" dir="ltr">
                      {fmtAr(isUsd ? it.usdUnitPrice : it.unitPrice)}
                    </td>
                    <td className="p-2.5 text-right tabular-nums" dir="ltr">
                      {fmtAr(isUsd ? it.usdTotal : it.total)}
                    </td>
                  </tr>
                ))}
                {d.items.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-4 text-center text-muted-foreground">
                      لا بنود في هذا الأمر.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">الإجماليات</CardTitle>
        </CardHeader>
        <CardContent>
          {costHidden ? (
            <p className="text-sm text-muted-foreground">قيم التكلفة محجوبة عن صلاحيّتك.</p>
          ) : (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Field label="المجموع قبل الضريبة">{fmtAr(d.subtotal)}</Field>
              {/* خصم فاتورة المورّد (0204): **مطبَّقٌ في الأعمدة أعلاه** — المجموع صافٍ بعده،
                  والذمّة وتكلفة المخزون كذلك. يُعرَض إفصاحاً لا بنداً يُطرَح مرّةً أخرى. */}
              {D(d.invoiceDiscount ?? 0).gt(0) && (
                <Field label="خصم فاتورة المورّد (مطبَّق)">
                  −{fmtAr(d.invoiceDiscount)}
                  {isUsd && D(d.usdInvoiceDiscount ?? 0).gt(0) ? ` (${fmtAr(d.usdInvoiceDiscount)} $)` : ""}
                </Field>
              )}
              <Field label="الضريبة">{fmtAr(d.taxAmount)}</Field>
              <Field label="الشحن">{fmtAr(d.shippingCost)}</Field>
              <Field label="الكمرك">{fmtAr(d.customsCost)}</Field>
              <Field label="الإجمالي">{fmtAr(d.total)}</Field>
              <Field label="المدفوع">{fmtAr(d.paidAmount)}</Field>
              {isUsd ? (
                <>
                  {/* مطابَقةٌ لا اشتقاق: منذ ضابط `supplierInvoiceTotal` يُرفض حفظ أمرٍ يخالف
                      قيمة فاتورة المورّد، فهذا الرقم هو رقم الورقة نفسه. */}
                  <Field label="فاتورة المورّد ($)">{fmtAr(d.usdTotal)}</Field>
                  <Field label="المدفوع ($)">{fmtAr(d.paidUsd)}</Field>
                  <Field label="المُرتجَع ($)">{fmtAr(d.returnedUsd)}</Field>
                  <Field label="المتبقّي للمورّد ($)">{fmtAr(remaining?.toString())}</Field>
                </>
              ) : (
                <Field label="المتبقّي">{fmtAr(remaining?.toString())}</Field>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
