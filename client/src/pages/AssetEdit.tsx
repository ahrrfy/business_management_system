import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { iqd } from "@/lib/assets/ui";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { ASSET_CATEGORIES, DEPRECIATION_METHODS } from "@shared/assets";
import { AlertCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";

const selectCls = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const stripMoney = (v: string | number | null | undefined) => (v == null ? "" : String(v).replace(/\.00$/, ""));

/** معاينة القسط السنوي (سنة أولى) — للعرض فقط؛ الخادم يحسب نهائياً. */
function previewAnnual(cost: number, salvage: number, life: number, method: "sl" | "db"): number {
  if (!life || life <= 0 || !cost) return 0;
  if (method === "db") return Math.min(Math.max(0, cost - salvage), Math.round(cost * (2 / life)));
  return Math.round(Math.max(0, cost - salvage) / life);
}

export default function AssetEdit() {
  const params = useParams();
  const id = Number(params.id);
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const opts = trpc.assets.formOptions.useQuery();
  const q = trpc.assets.get.useQuery({ id }, { enabled: Number.isFinite(id) });
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const [form, setForm] = useState({
    name: "", category: "computers", brand: "", serial: "",
    branchId: "", location: "", condition: "",
    supplierId: "", purchaseDate: "", purchaseValue: "", warrantyEnd: "",
    method: "sl" as "sl" | "db", usefulLifeYears: "1", salvageValue: "0",
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  // تعبئة النموذج من بيانات الأصل (مرّة واحدة).
  if (q.data && !loaded) {
    const a = q.data;
    setForm({
      name: a.name ?? "", category: a.category ?? "computers", brand: a.brand ?? "", serial: a.serial ?? "",
      branchId: a.branchId ? String(a.branchId) : "", location: a.location ?? "", condition: a.condition ?? "",
      supplierId: a.supplierId ? String(a.supplierId) : "", purchaseDate: a.purchaseDate ?? "", purchaseValue: stripMoney(a.purchaseValue), warrantyEnd: a.warrantyEnd ?? "",
      method: (a.depreciationMethod as "sl" | "db") ?? "sl", usefulLifeYears: String(a.usefulLifeYears ?? 1), salvageValue: stripMoney(a.salvageValue),
    });
    setLoaded(true);
  }

  const annual = useMemo(
    () => previewAnnual(Number(form.purchaseValue || 0), Number(form.salvageValue || 0), Number(form.usefulLifeYears || 0), form.method),
    [form.purchaseValue, form.salvageValue, form.usefulLifeYears, form.method],
  );

  const update = trpc.assets.update.useMutation({
    onSuccess: async (a) => { notify.ok("تم حفظ تعديلات الأصل"); await utils.assets.get.invalidate({ id }); await utils.assets.list.invalidate(); navigate(`/assets/${a?.id ?? id}`); },
    onError: (e) => { setError(e.message); notify.err(e); },
  });

  if (q.isLoading) return <div className="p-10 text-center text-muted-foreground">جارٍ التحميل…</div>;
  if (q.error) return <div className="p-10 text-center text-destructive">تعذّر تحميل الأصل: {q.error.message}</div>;
  if (!q.data) return <div className="p-10 text-center text-muted-foreground">الأصل غير موجود. <Link href="/assets/register" className="text-primary">رجوع للسجلّ</Link></div>;
  if (q.data.status === "disposed") {
    return <div className="p-10 text-center text-muted-foreground">لا يمكن تعديل أصل مُستبعَد. <Link href={`/assets/${id}`} className="text-primary">رجوع للأصل</Link></div>;
  }

  function submit() {
    setError("");
    if (!form.name.trim()) { setError("اسم الأصل مطلوب."); return; }
    if (!form.purchaseValue.trim()) { setError("قيمة الشراء مطلوبة."); return; }
    if (!(Number(form.usefulLifeYears) > 0)) { setError("العمر الإنتاجي يجب أن يكون أكبر من صفر."); return; }
    update.mutate({
      id,
      name: form.name.trim(),
      category: form.category as never,
      brand: form.brand.trim() || undefined,
      serial: form.serial.trim() || undefined,
      branchId: form.branchId ? Number(form.branchId) : undefined,
      location: form.location.trim() || undefined,
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
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">تعديل الأصل <span className="font-mono text-base text-muted-foreground" dir="ltr">{q.data.code}</span></h1>
        <Link href={`/assets/${id}`} className="text-sm text-muted-foreground">← رجوع للأصل</Link>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">البيانات الأساسية</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1"><Label htmlFor="name">اسم الأصل *</Label><Input id="name" value={form.name} onChange={(e) => set({ name: e.target.value })} /></div>
          <div className="space-y-1">
            <Label htmlFor="cat">الفئة *</Label>
            <select id="cat" className={selectCls} value={form.category} onChange={(e) => set({ category: e.target.value })}>
              {ASSET_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </div>
          <div className="space-y-1"><Label htmlFor="brand">الماركة</Label><Input id="brand" value={form.brand} onChange={(e) => set({ brand: e.target.value })} dir="auto" /></div>
          <div className="space-y-1"><Label htmlFor="serial">الرقم التسلسلي</Label><Input id="serial" value={form.serial} onChange={(e) => set({ serial: e.target.value })} dir="ltr" /></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">التصنيف والموقع</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="br">الفرع</Label>
            <select id="br" className={selectCls} value={form.branchId} onChange={(e) => set({ branchId: e.target.value })}>
              <option value="">— اختر الفرع —</option>
              {(opts.data?.branches ?? []).map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
            </select>
          </div>
          <div className="space-y-1"><Label htmlFor="loc">الموقع</Label><Input id="loc" value={form.location} onChange={(e) => set({ location: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="cond">الحالة الفنية</Label><Input id="cond" value={form.condition} onChange={(e) => set({ condition: e.target.value })} placeholder="ممتاز / جيد / متوسط" /></div>
          <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground self-end">العهدة تُغيَّر من صفحة الأصل («تسليم عهدة») لا من هنا.</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">الشراء والكفالة</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="sup">المورّد</Label>
            <select id="sup" className={selectCls} value={form.supplierId} onChange={(e) => set({ supplierId: e.target.value })}>
              <option value="">— بلا مورّد —</option>
              {(opts.data?.suppliers ?? []).map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
            </select>
          </div>
          <div className="space-y-1"><Label htmlFor="pdate">تاريخ الشراء *</Label><Input id="pdate" type="date" dir="ltr" value={form.purchaseDate} onChange={(e) => set({ purchaseDate: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="pval">قيمة الشراء (د.ع) *</Label><Input id="pval" dir="ltr" inputMode="decimal" value={form.purchaseValue} onChange={(e) => set({ purchaseValue: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="war">نهاية الكفالة</Label><Input id="war" type="date" dir="ltr" value={form.warrantyEnd} onChange={(e) => set({ warrantyEnd: e.target.value })} /></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">الإهلاك</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1">
            <Label htmlFor="meth">الطريقة</Label>
            <select id="meth" className={selectCls} value={form.method} onChange={(e) => set({ method: e.target.value as "sl" | "db" })}>
              {DEPRECIATION_METHODS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </div>
          <div className="space-y-1"><Label htmlFor="life">العمر الإنتاجي (سنوات) *</Label><Input id="life" dir="ltr" inputMode="numeric" value={form.usefulLifeYears} onChange={(e) => set({ usefulLifeYears: e.target.value.replace(/\D/g, "") })} /></div>
          <div className="space-y-1"><Label htmlFor="salv">القيمة التخريدية (د.ع)</Label><Input id="salv" dir="ltr" inputMode="decimal" value={form.salvageValue} onChange={(e) => set({ salvageValue: e.target.value })} placeholder="0" /></div>
          <div className="md:col-span-3 rounded-md border bg-muted/30 p-3 flex items-center justify-between">
            <span className="text-sm text-muted-foreground">القسط السنوي المُقدَّر ({DEPRECIATION_METHODS.find((m) => m.key === form.method)?.short})</span>
            <span className="text-lg font-bold tabular-nums" dir="ltr">{iqd(annual)} د.ع</span>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="whitespace-pre-wrap break-words">{error}</span>
        </div>
      )}
      <div className="flex gap-2">
        <Button onClick={submit} disabled={update.isPending}>{update.isPending ? "جارٍ الحفظ…" : "حفظ التعديلات"}</Button>
        <Link href={`/assets/${id}`}><Button variant="outline">إلغاء</Button></Link>
      </div>
    </div>
  );
}
