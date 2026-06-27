import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { iqd } from "@/lib/assets/ui";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { ASSET_CATEGORIES, DEPRECIATION_METHODS, categoryDefaultLife } from "@shared/assets";
import { AlertCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";

const selectCls = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const today = () => new Date().toISOString().slice(0, 10);

/** معاينة القسط السنوي (سنة أولى) — للعرض فقط؛ الخادم يحسب نهائياً. */
function previewAnnual(cost: number, salvage: number, life: number, method: "sl" | "db"): number {
  if (!life || life <= 0 || !cost) return 0;
  if (method === "db") return Math.min(Math.max(0, cost - salvage), Math.round(cost * (2 / life)));
  return Math.round(Math.max(0, cost - salvage) / life);
}

export default function AssetNew() {
  const [, navigate] = useLocation();
  const opts = trpc.assets.formOptions.useQuery();
  const [error, setError] = useState("");

  const [form, setForm] = useState({
    name: "", category: "computers", brand: "", serial: "",
    branchId: "", location: "", condition: "ممتاز",
    supplierId: "", purchaseDate: today(), purchaseValue: "", warrantyEnd: "",
    method: "sl" as "sl" | "db", usefulLifeYears: String(categoryDefaultLife("computers")), salvageValue: "0",
    custodianId: "",
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const annual = useMemo(
    () => previewAnnual(Number(form.purchaseValue || 0), Number(form.salvageValue || 0), Number(form.usefulLifeYears || 0), form.method),
    [form.purchaseValue, form.salvageValue, form.usefulLifeYears, form.method],
  );

  const create = trpc.assets.create.useMutation({
    onSuccess: (a) => { notify.ok(`أُضيف الأصل ${a?.code ?? ""}`); navigate(a?.id ? `/assets/${a.id}` : "/assets/register"); },
    onError: (e) => { setError(e.message); notify.err(e); },
  });

  function submit() {
    setError("");
    if (!form.name.trim()) { setError("اسم الأصل مطلوب."); return; }
    if (!form.purchaseValue.trim()) { setError("قيمة الشراء مطلوبة."); return; }
    if (!(Number(form.usefulLifeYears) > 0)) { setError("العمر الإنتاجي يجب أن يكون أكبر من صفر."); return; }
    create.mutate({
      name: form.name.trim(),
      category: form.category as never,
      brand: form.brand.trim() || undefined,
      serial: form.serial.trim() || undefined,
      branchId: form.branchId ? Number(form.branchId) : undefined,
      location: form.location.trim() || undefined,
      custodianId: form.custodianId ? Number(form.custodianId) : undefined,
      supplierId: form.supplierId ? Number(form.supplierId) : undefined,
      purchaseDate: form.purchaseDate,
      purchaseValue: form.purchaseValue.trim(),
      salvageValue: form.salvageValue.trim() || "0",
      usefulLifeYears: Number(form.usefulLifeYears),
      depreciationMethod: form.method,
      condition: form.condition.trim() || undefined,
      warrantyEnd: form.warrantyEnd.trim() || undefined,
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">إضافة أصل جديد</h1>
        <Link href="/assets/register" className="text-sm text-muted-foreground">← رجوع للسجلّ</Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 items-start">
      <Card>
        <CardHeader><CardTitle className="text-base">البيانات الأساسية</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1"><Label>اسم الأصل *</Label><Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="لابتوب Dell Latitude" /></div>
          <div className="space-y-1">
            <Label>الفئة *</Label>
            <select className={selectCls} value={form.category} onChange={(e) => set({ category: e.target.value, usefulLifeYears: String(categoryDefaultLife(e.target.value)) })}>
              {ASSET_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </div>
          <div className="space-y-1"><Label>الماركة</Label><Input value={form.brand} onChange={(e) => set({ brand: e.target.value })} dir="auto" placeholder="Dell" /></div>
          <div className="space-y-1"><Label>الرقم التسلسلي</Label><Input value={form.serial} onChange={(e) => set({ serial: e.target.value })} dir="ltr" /></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">التصنيف والموقع والعهدة</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label>الفرع</Label>
            <select className={selectCls} value={form.branchId} onChange={(e) => set({ branchId: e.target.value })}>
              <option value="">— اختر الفرع —</option>
              {(opts.data?.branches ?? []).map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
            </select>
          </div>
          <div className="space-y-1"><Label>الموقع</Label><Input value={form.location} onChange={(e) => set({ location: e.target.value })} placeholder="مكتب الإدارة" /></div>
          <div className="space-y-1">
            <Label>العهدة (الموظف المسؤول)</Label>
            <select className={selectCls} value={form.custodianId} onChange={(e) => set({ custodianId: e.target.value })}>
              <option value="">— بلا عهدة —</option>
              {(opts.data?.employees ?? []).map((emp) => <option key={emp.id} value={String(emp.id)}>{emp.name}{emp.position ? ` — ${emp.position}` : ""}</option>)}
            </select>
          </div>
          <div className="space-y-1"><Label>الحالة الفنية</Label><Input value={form.condition} onChange={(e) => set({ condition: e.target.value })} placeholder="ممتاز / جيد / متوسط" /></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">الشراء والكفالة</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label>المورّد</Label>
            <select className={selectCls} value={form.supplierId} onChange={(e) => set({ supplierId: e.target.value })}>
              <option value="">— بلا مورّد —</option>
              {(opts.data?.suppliers ?? []).map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
            </select>
          </div>
          <div className="space-y-1"><Label>تاريخ الشراء *</Label><Input type="date" dir="ltr" value={form.purchaseDate} onChange={(e) => set({ purchaseDate: e.target.value })} /></div>
          <div className="space-y-1"><Label>قيمة الشراء (د.ع) *</Label><Input dir="ltr" inputMode="decimal" value={form.purchaseValue} onChange={(e) => set({ purchaseValue: e.target.value })} placeholder="1850000" /></div>
          <div className="space-y-1"><Label>نهاية الكفالة</Label><Input type="date" dir="ltr" value={form.warrantyEnd} onChange={(e) => set({ warrantyEnd: e.target.value })} /></div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader><CardTitle className="text-base">الإهلاك</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1">
            <Label>الطريقة</Label>
            <select className={selectCls} value={form.method} onChange={(e) => set({ method: e.target.value as "sl" | "db" })}>
              {DEPRECIATION_METHODS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </div>
          <div className="space-y-1"><Label>العمر الإنتاجي (سنوات) *</Label><Input dir="ltr" inputMode="numeric" value={form.usefulLifeYears} onChange={(e) => set({ usefulLifeYears: e.target.value.replace(/\D/g, "") })} /></div>
          <div className="space-y-1"><Label>القيمة التخريدية (د.ع)</Label><Input dir="ltr" inputMode="decimal" value={form.salvageValue} onChange={(e) => set({ salvageValue: e.target.value })} placeholder="0" /></div>
          <div className="md:col-span-3 rounded-md border bg-muted/30 p-3 flex items-center justify-between">
            <span className="text-sm text-muted-foreground">القسط السنوي المُقدَّر ({DEPRECIATION_METHODS.find((m) => m.key === form.method)?.short})</span>
            <span className="text-lg font-bold tabular-nums" dir="ltr">{iqd(annual)} د.ع</span>
          </div>
        </CardContent>
      </Card>
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="whitespace-pre-wrap break-words">{error}</span>
        </div>
      )}
      <div className="flex gap-2">
        <Button onClick={submit} disabled={create.isPending}>{create.isPending ? "جارٍ الحفظ…" : "حفظ الأصل"}</Button>
        <Link href="/assets/register"><Button variant="outline">إلغاء</Button></Link>
      </div>
    </div>
  );
}
