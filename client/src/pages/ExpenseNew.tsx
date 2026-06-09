import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { D } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { Link, useLocation } from "wouter";

/**
 * مصروف جديد — v3 add-screens.
 *
 * تصميم:
 *  - الحقول الأساسية (الفرع/الفئة/المبلغ/الدفع/التاريخ) — كما كانت.
 *  - حقول جديدة: جهة الصرف (payee)، مركز التكلفة (costCenter)، مصروف متكرّر (toggle + دورية).
 *  - المتكرّر للوصف فقط — لا يُولّد قيوداً مستقبليّة هنا (ميزة لاحقة).
 */

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const CATEGORIES: { value: string; label: string }[] = [
  { value: "RENT", label: "إيجار" },
  { value: "UTILITIES", label: "خدمات/فواتير (كهرباء/ماء/إنترنت)" },
  { value: "SUPPLIES", label: "لوازم تشغيل" },
  { value: "SALARY", label: "مرتبات/أجور" },
  { value: "TRANSPORT", label: "مواصلات/شحن" },
  { value: "MAINTENANCE", label: "صيانة" },
  { value: "MARKETING", label: "تسويق/إعلان" },
  { value: "OTHER", label: "أخرى" },
];

const METHODS: { value: string; label: string }[] = [
  { value: "CASH", label: "نقدي" },
  { value: "CARD", label: "بطاقة" },
  { value: "CHECK", label: "شيك" },
  { value: "TRANSFER", label: "تحويل" },
  { value: "WALLET", label: "محفظة" },
];

const COST_CENTERS = ["المبيعات", "الإدارة والتشغيل", "التسويق", "الصيانة", "عام"];
const FREQS: { value: string; label: string }[] = [
  { value: "DAILY", label: "يومي" },
  { value: "WEEKLY", label: "أسبوعي" },
  { value: "MONTHLY", label: "شهري" },
  { value: "QUARTERLY", label: "ربع سنوي" },
  { value: "YEARLY", label: "سنوي" },
];

export default function ExpenseNew() {
  const [, navigate] = useLocation();
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();
  const branches = trpc.branches.list.useQuery();

  const [branchId, setBranchId] = useState<number | "">("");
  const [category, setCategory] = useState("RENT");
  const [amount, setAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("CASH");
  const [expenseDate, setExpenseDate] = useState(new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [payee, setPayee] = useState("");
  const [costCenter, setCostCenter] = useState("الإدارة والتشغيل");
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurringFrequency, setRecurringFrequency] = useState("MONTHLY");
  const [error, setError] = useState("");

  const effectiveBranch = branchId || me.data?.branchId || (branches.data?.[0] ? Number(branches.data[0].id) : 1);
  const openShift = trpc.shifts.current.useQuery(
    { branchId: Number(effectiveBranch) },
    { enabled: !!effectiveBranch }
  );

  const create = trpc.expenses.create.useMutation({
    onSuccess: async () => {
      await utils.expenses.list.invalidate();
      notify.ok("تم تسجيل المصروف");
      navigate("/expenses");
    },
    onError: (e) => { setError(e.message); notify.err(e); },
  });

  function submit() {
    setError("");
    if (!effectiveBranch) return setError("اختر الفرع.");
    if (!amount.trim() || D(amount).lte(0)) return setError("المبلغ مطلوب وموجب.");
    if (category === "OTHER" && !description.trim()) return setError("وصف المصروف مطلوب لفئة «أخرى».");
    create.mutate({
      branchId: Number(effectiveBranch),
      shiftId: openShift.data?.id ? Number(openShift.data.id) : null,
      expenseDate: expenseDate || undefined,
      category: category as any,
      amount: D(amount).toFixed(2),
      paymentMethod: paymentMethod as any,
      description: description.trim() || null,
      referenceNumber: referenceNumber.trim() || null,
      payee: payee.trim() || null,
      costCenter: costCenter || null,
      isRecurring,
      recurringFrequency: isRecurring ? (recurringFrequency as any) : null,
    });
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">مصروف جديد</h1>
        <Link href="/expenses" className="text-sm text-muted-foreground">← رجوع للمصروفات</Link>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">بيانات المصروف</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label>الفرع *</Label>
            <select className={selectCls} value={effectiveBranch} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
              {(branches.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            {openShift.data ? (
              <p className="text-xs text-emerald-700">سيُربط بوردية #{Number(openShift.data.id)} المفتوحة.</p>
            ) : (
              <p className="text-xs text-muted-foreground">لا توجد وردية مفتوحة لهذا الفرع — سيُسجَّل بلا ربط.</p>
            )}
          </div>
          <div className="space-y-1">
            <Label>التاريخ *</Label>
            <Input type="date" dir="ltr" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>الفئة *</Label>
            <select className={selectCls} value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label>طريقة الدفع *</Label>
            <select className={selectCls} value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
              {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label>المبلغ *</Label>
            <Input dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </div>
          <div className="space-y-1">
            <Label>رقم مرجعي (اختياري)</Label>
            <Input dir="ltr" value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} placeholder="فاتورة/إيصال" />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label>الوصف{category === "OTHER" ? " *" : " (اختياري)"}</Label>
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="تفصيل المصروف…" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">جهة الصرف ومركز التكلفة</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="payee">جهة الصرف</Label>
            <Input id="payee" value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="مثال: شركة الكهرباء، صاحب العقار" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cc">مركز التكلفة</Label>
            <select id="cc" className={selectCls} value={costCenter} onChange={(e) => setCostCenter(e.target.value)}>
              {COST_CENTERS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">مصروف متكرّر</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch checked={isRecurring} onCheckedChange={setIsRecurring} id="recurring" />
            <Label htmlFor="recurring" className="cursor-pointer">
              {isRecurring ? "نعم — مصروف متكرّر" : "لا — مرة واحدة"}
            </Label>
          </div>
          <div className={cn("grid grid-cols-1 md:grid-cols-2 gap-4 transition-opacity", isRecurring ? "opacity-100" : "opacity-50 pointer-events-none")}>
            <div className="space-y-1">
              <Label htmlFor="freq">الدورية</Label>
              <select id="freq" className={selectCls} value={recurringFrequency} onChange={(e) => setRecurringFrequency(e.target.value)}>
                {FREQS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
              <p className="text-[11px] text-muted-foreground">
                للتوثيق الآن — الإصدارات المستقبلية ستولّد قيوداً تلقائياً.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={submit} disabled={create.isPending}>{create.isPending ? "جارٍ الحفظ…" : "حفظ المصروف"}</Button>
        <Link href="/expenses"><Button variant="outline">إلغاء</Button></Link>
      </div>
    </div>
  );
}
