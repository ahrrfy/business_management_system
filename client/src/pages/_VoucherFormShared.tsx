// نموذج موحَّد لإنشاء سند قبض/صرف. الاختلاف الوحيد بينهما هو voucherType والـlabels والألوان.
import { BalanceBadge, balanceOptionText } from "@/components/BalanceBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const METHODS = [
  { value: "CASH", label: "نقدي" },
  { value: "CARD", label: "بطاقة" },
  { value: "TRANSFER", label: "تحويل" },
  { value: "WALLET", label: "محفظة" },
] as const;

export interface VoucherFormProps {
  voucherType: "RECEIPT" | "PAYMENT";
}

export default function VoucherFormShared({ voucherType }: VoucherFormProps) {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const isReceipt = voucherType === "RECEIPT";

  const [branchId, setBranchId] = useState<number>(1);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<typeof METHODS[number]["value"]>("CASH");
  const [partyType, setPartyType] = useState<"CUSTOMER" | "SUPPLIER" | "OTHER">("OTHER");
  const [partyId, setPartyId] = useState<number | "">("");
  const [description, setDescription] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [cardLastFour, setCardLastFour] = useState("");
  const [err, setErr] = useState("");

  const branches = trpc.branches.list.useQuery();
  const customers = trpc.customers.list.useQuery(undefined, { enabled: partyType === "CUSTOMER" });
  const suppliers = trpc.suppliers.list.useQuery(undefined, { enabled: partyType === "SUPPLIER" });
  // بوّابة الوردية النقدية: السندات النقدية تَمسّ صندوق الوردية ⇒ لا تُكتَب بدون وردية مفتوحة.
  // (الخادم يرمي PRECONDITION_FAILED كحارس أخير، لكن نُعطّل في الواجهة لمنع نقرة عرضية.)
  const openShift = trpc.shifts.current.useQuery({ branchId }, { enabled: !!branchId });
  const cashWithoutShift = method === "CASH" && !openShift.data && !openShift.isLoading;

  // idempotency: مفتاح ثابت لكل سند (الصفحة تنتقل بعد النجاح فيتجدّد) ⇒ نقرة مزدوجة لا تُنشئ سندين.
  const [clientRequestId] = useState(() => crypto.randomUUID());
  const create = trpc.vouchers.create.useMutation({
    onSuccess: async (res) => {
      notify.ok(`تمّ إنشاء ${isReceipt ? "سند القبض" : "سند الصرف"} ${res.voucherNumber}`);
      await utils.vouchers.list.invalidate();
      navigate("/vouchers");
    },
    onError: (e) => setErr(e.message),
  });

  const titleColor = isReceipt ? "text-emerald-700" : "text-rose-700";
  const submitColor = isReceipt ? "bg-emerald-600 hover:bg-emerald-700" : "bg-rose-600 hover:bg-rose-700";

  const partyList = useMemo(() => {
    if (partyType === "CUSTOMER") return customers.data ?? [];
    if (partyType === "SUPPLIER") return suppliers.data ?? [];
    return [];
  }, [partyType, customers.data, suppliers.data]);

  function submit() {
    setErr("");
    if (!amount.trim() || !/^\d+(\.\d{1,2})?$/.test(amount.trim()) || Number(amount) <= 0) {
      setErr("المبلغ مطلوب (موجب، منزلتان عشريتان).");
      return;
    }
    if (!description.trim()) {
      setErr("وصف السند مطلوب.");
      return;
    }
    if ((partyType === "CUSTOMER" || partyType === "SUPPLIER") && !partyId) {
      setErr(`اختر ${partyType === "CUSTOMER" ? "العميل" : "المورّد"} المرتبط بالسند.`);
      return;
    }
    create.mutate({
      voucherType,
      branchId,
      amount: amount.trim(),
      paymentMethod: method,
      partyType,
      partyId: partyType === "OTHER" ? null : Number(partyId),
      description: description.trim(),
      referenceNumber: referenceNumber.trim() || null,
      checkNumber: null,
      cardLastFour: method === "CARD" ? cardLastFour.trim() || null : null,
      clientRequestId,
    });
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className={`text-2xl font-bold ${titleColor}`}>
          {isReceipt ? "سند قبض جديد" : "سند صرف جديد"}
        </h1>
        <Link href="/vouchers">
          <Button variant="outline" size="sm">→ القائمة</Button>
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        {isReceipt
          ? "إيرادات/تحصيلات مستقلّة بلا فاتورة (مثل: دفعة من عميل بلا تخصيص، إيرادات متفرّقة، استرداد من مورّد)."
          : "مصاريف/مدفوعات مستقلّة بلا فاتورة (مثل: راتب موظف، إيجار، صيانة، دفعة لمورّد)."}
      </p>

      <Card>
        <CardHeader><CardTitle className="text-base">البيانات الرئيسية</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>الفرع *</Label>
            <select className={selectCls} value={branchId} onChange={(e) => setBranchId(Number(e.target.value))}>
              {(branches.data ?? []).map((b) => (
                <option key={Number(b.id)} value={Number(b.id)}>{b.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label>المبلغ * (IQD)</Label>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="50000" inputMode="decimal" />
          </div>

          <div className="space-y-1">
            <Label>طريقة الدفع *</Label>
            <select className={selectCls} value={method} onChange={(e) => setMethod(e.target.value as any)}>
              {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label>الرقم المرجعي (اختياري)</Label>
            <Input value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} placeholder="مثال: رقم العملية" />
          </div>

          {method === "CARD" && (
            <div className="space-y-1">
              <Label>آخر 4 من البطاقة (اختياري)</Label>
              <Input value={cardLastFour} onChange={(e) => setCardLastFour(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="1234" maxLength={4} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">الطرف المقابل</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>نوع الطرف *</Label>
            <select className={selectCls} value={partyType} onChange={(e) => { setPartyType(e.target.value as any); setPartyId(""); }}>
              <option value="OTHER">أخرى (راتب/إيجار/إيرادات متفرّقة…)</option>
              <option value="CUSTOMER">عميل</option>
              <option value="SUPPLIER">مورّد</option>
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              {partyType === "OTHER" && "لا تأثير على الذمم — تأثير على الصندوق/الدفتر فقط."}
              {partyType === "CUSTOMER" && (isReceipt ? "AR (ما يدين به العميل) ينقص بقيمة السند." : "AR يَزيد (المتجر يَدفع للعميل، مثل استرداد).")}
              {partyType === "SUPPLIER" && (isReceipt ? "AP (ما ندين به للمورّد) يَزيد (استلام نقد من المورّد)." : "AP يَنقص (دفعة للمورّد).")}
            </p>
          </div>
          {(partyType === "CUSTOMER" || partyType === "SUPPLIER") && (
            <div className="space-y-1">
              <Label>{partyType === "CUSTOMER" ? "العميل" : "المورّد"} *</Label>
              {/* الرصيد يظهر مع كل اسم في القائمة، وبشارة ملوّنة بعد الاختيار — قرار سند بعلم كامل بالذمة */}
              <select className={selectCls} value={partyId} onChange={(e) => setPartyId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">— اختر —</option>
                {partyList.map((p: any) => (
                  <option key={Number(p.id)} value={Number(p.id)}>
                    {p.name}
                    {balanceOptionText(p.currentBalance, partyType === "CUSTOMER" ? "customer" : "supplier")}
                  </option>
                ))}
              </select>
              {partyId !== "" && (() => {
                const sel: any = partyList.find((p: any) => Number(p.id) === Number(partyId));
                return sel ? (
                  <div className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
                    <span>الرصيد الحالي قبل هذا السند:</span>
                    <BalanceBadge
                      amount={sel.currentBalance}
                      entityType={partyType === "CUSTOMER" ? "customer" : "supplier"}
                      showZero
                    />
                  </div>
                ) : null;
              })()}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">الوصف</CardTitle></CardHeader>
        <CardContent>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={isReceipt ? "مثال: تحصيل مبلغ من تاجر بدون فاتورة محدّدة" : "مثال: راتب الموظف أحمد لشهر يونيو"}
            rows={3}
          />
        </CardContent>
      </Card>

      {err && (
        <div className="rounded-md bg-rose-50 border border-rose-200 text-rose-700 text-sm p-3">{err}</div>
      )}

      {cashWithoutShift && (
        <div className="rounded-md bg-amber-50 border border-amber-300 text-amber-800 text-sm p-3">
          ⚠️ لا توجد وردية مفتوحة في هذا الفرع. السندات النقدية تَمسّ صندوق الوردية، فلا يمكن حفظها بلا وردية (وإلا تختفي من Z-report).
          {" "}<Link href="/shifts" className="underline">افتح وردية</Link> أوّلاً، أو غيِّر طريقة الدفع لغير نقدية (بطاقة/تحويل/محفظة).
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          onClick={submit}
          disabled={create.isPending || cashWithoutShift}
          className={submitColor}
          title={cashWithoutShift ? "افتح وردية قبل تسجيل سند نقدي" : undefined}
        >
          {create.isPending ? "جارٍ الحفظ…" : (isReceipt ? "حفظ سند القبض" : "حفظ سند الصرف")}
        </Button>
        <Link href="/vouchers"><Button variant="outline" disabled={create.isPending}>إلغاء</Button></Link>
      </div>
    </div>
  );
}
