import { ProductSearchPicker, type PurchaseRow } from "@/components/production/ProductSearchPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirmDelete } from "@/lib/confirm";
import { D } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { useState } from "react";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

let _k = 1;
type Comp = { key: number; inputVariantId: number; productName: string; sku: string; qty: string };
type OutPick = { variantId: number; productName: string; sku: string; units: PurchaseRow[]; unitId: number };

export default function ProductionRecipes() {
  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId ?? 1;
  const utils = trpc.useUtils();
  const list = trpc.production.recipes.list.useQuery({});

  const [editId, setEditId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [out, setOut] = useState<OutPick | null>(null);
  const [labor, setLabor] = useState("0");
  const [comps, setComps] = useState<Comp[]>([]);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);

  function resetForm() {
    setEditId(null); setName(""); setOut(null); setLabor("0"); setComps([]); setError(""); setShowForm(false);
  }

  async function startEdit(id: number) {
    const r: any = await utils.production.recipes.get.fetch({ id });
    setEditId(id);
    setName(r.name);
    setOut({ variantId: r.outputVariantId, productName: r.outputProductName ?? `#${r.outputVariantId}`, sku: r.outputSku ?? "", units: [], unitId: r.outputProductUnitId });
    setLabor(String(r.laborPerOutputBase ?? "0"));
    setComps((r.lines ?? []).map((l: any) => ({ key: _k++, inputVariantId: l.inputVariantId, productName: l.inputProductName ?? `#${l.inputVariantId}`, sku: l.inputSku ?? "", qty: String(l.qtyPerOutputBase) })));
    setShowForm(true);
  }

  const saveMut = trpc.production.recipes.create.useMutation();
  const updateMut = trpc.production.recipes.update.useMutation();
  const setActive = trpc.production.recipes.setActive.useMutation({
    onSuccess: () => utils.production.recipes.list.invalidate(),
    onError: (e) => notify.err(e),
  });
  const remove = trpc.production.recipes.remove.useMutation({
    onSuccess: () => { notify.ok("حُذفت الوصفة"); utils.production.recipes.list.invalidate(); },
    onError: (e) => notify.err(e),
  });

  function validate(): string | null {
    if (!name.trim()) return "اسم الوصفة مطلوب.";
    if (!out) return "اختر المنتج الناتج.";
    if (comps.length === 0) return "أضِف مكوّناً واحداً على الأقل.";
    for (const c of comps) {
      if (c.inputVariantId === out.variantId) return "المنتج الناتج لا يكون مكوّناً من نفسه.";
      if (D(c.qty).lte(0)) return `كمية المكوّن «${c.productName}» يجب أن تكون موجبة.`;
    }
    return null;
  }

  async function save() {
    const err = validate();
    if (err) { setError(err); return; }
    setError("");
    const payload = {
      name: name.trim(),
      outputVariantId: out!.variantId,
      outputProductUnitId: out!.unitId,
      laborPerOutputBase: D(labor).toFixed(2),
      lines: comps.map((c) => ({ inputVariantId: c.inputVariantId, qtyPerOutputBase: D(c.qty).toFixed(4) })),
    };
    try {
      if (editId) await updateMut.mutateAsync({ id: editId, ...payload });
      else await saveMut.mutateAsync(payload);
      notify.ok(editId ? "حُدِّثت الوصفة" : "أُنشئت الوصفة");
      await utils.production.recipes.list.invalidate();
      resetForm();
    } catch (e: any) {
      setError(e?.message ?? "تعذّر الحفظ");
      notify.err(e);
    }
  }

  const busy = saveMut.isPending || updateMut.isPending;

  return (
    <div className="space-y-4 max-w-4xl" dir="rtl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">وصفات الإنتاج</h1>
        {!showForm && <Button onClick={() => { resetForm(); setShowForm(true); }}>＋ وصفة جديدة</Button>}
      </div>
      <p className="text-sm text-muted-foreground">عرّف منتجاً متكرّراً مرّة واحدة (ملزمة/كتاب) ⇒ في شاشة الإنتاج تختار الوصفة وتكتب العدد فقط.</p>

      {showForm && (
        <Card>
          <CardHeader><CardTitle className="text-base">{editId ? "تعديل وصفة" : "وصفة جديدة"}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>اسم الوصفة *</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: ملزمة منهج الرياضيات" />
              </div>
              <div className="space-y-1">
                <Label>عمالة لكل وحدة ناتج (اختياري)</Label>
                <Input dir="ltr" value={labor} onChange={(e) => setLabor(e.target.value)} placeholder="0" />
              </div>
            </div>

            <div className="space-y-1">
              <Label>المنتج الناتج *</Label>
              {out ? (
                <div className="flex items-center justify-between rounded-md border p-2 text-sm">
                  <div><span className="font-medium">{out.productName}</span> <span className="text-xs text-muted-foreground font-mono" dir="ltr">{out.sku}</span></div>
                  <div className="flex items-center gap-2">
                    {out.units.length > 0 && (
                      <select className={selectCls + " w-auto"} value={out.unitId} onChange={(e) => setOut({ ...out, unitId: Number(e.target.value) })}>
                        {out.units.map((u) => <option key={u.productUnitId} value={u.productUnitId}>{u.unitName}{u.isBaseUnit ? " (أساس)" : ""}</option>)}
                      </select>
                    )}
                    <button type="button" className="text-rose-600 text-sm" onClick={() => setOut(null)}>تغيير</button>
                  </div>
                </div>
              ) : (
                <ProductSearchPicker branchId={branchId} placeholder="ابحث عن المنتج الناتج…" onPick={(v, u) => setOut({ variantId: v.variantId, productName: v.productName, sku: v.sku, units: u.length ? u : [v], unitId: v.productUnitId })} />
              )}
            </div>

            <div className="space-y-2">
              <Label>المكوّنات (لكل وحدة ناتج واحدة بالأساس) *</Label>
              <ProductSearchPicker branchId={branchId} placeholder="أضِف مكوّناً (مثل: ورق)…" onPick={(v) => setComps((p) => [...p, { key: _k++, inputVariantId: v.variantId, productName: v.productName, sku: v.sku, qty: "1" }])} />
              {comps.map((c) => (
                <div key={c.key} className="grid grid-cols-12 gap-2 items-center border rounded-md p-2">
                  <div className="col-span-7"><div className="font-medium text-sm">{c.productName}</div><div className="text-xs text-muted-foreground font-mono" dir="ltr">{c.sku}</div></div>
                  <div className="col-span-3"><Input dir="ltr" value={c.qty} onChange={(e) => setComps((p) => p.map((x) => x.key === c.key ? { ...x, qty: e.target.value } : x))} placeholder="كمية/وحدة" /></div>
                  <div className="col-span-2 text-left"><button type="button" className="text-rose-600 text-sm" onClick={() => setComps((p) => p.filter((x) => x.key !== c.key))}>حذف</button></div>
                </div>
              ))}
              {comps.length === 0 && <p className="text-xs text-muted-foreground">لا مكوّنات بعد.</p>}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button onClick={save} disabled={busy}>{busy ? "جارٍ الحفظ…" : "حفظ الوصفة"}</Button>
              <Button variant="outline" onClick={resetForm}>إلغاء</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">الوصفات <span className="text-xs text-muted-foreground font-normal">({(list.data ?? []).length})</span></CardTitle></CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50"><tr className="text-right">
              <th className="p-2">الاسم</th><th className="p-2">المنتج الناتج</th><th className="p-2 text-center">الحالة</th><th className="p-2 text-center">إجراءات</th>
            </tr></thead>
            <tbody>
              {(list.data ?? []).map((r: any) => (
                <tr key={Number(r.id)} className="border-t">
                  <td className="p-2 font-medium">{r.name}</td>
                  <td className="p-2 text-xs">{r.outputProductName} <span className="text-muted-foreground">({r.outputUnitName})</span></td>
                  <td className="p-2 text-center">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${r.isActive ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"}`}>{r.isActive ? "مفعّلة" : "معطّلة"}</span>
                  </td>
                  <td className="p-2 text-center space-x-2 space-x-reverse">
                    <button className="text-sky-700 text-sm" onClick={() => startEdit(Number(r.id))}>تعديل</button>
                    <button className="text-amber-700 text-sm" onClick={() => setActive.mutate({ id: Number(r.id), active: !r.isActive })}>{r.isActive ? "تعطيل" : "تفعيل"}</button>
                    <button className="text-rose-600 text-sm" onClick={async () => { if (await confirmDelete({ description: `حذف وصفة «${r.name}»؟` })) remove.mutate({ id: Number(r.id) }); }}>حذف</button>
                  </td>
                </tr>
              ))}
              {!list.isLoading && (list.data ?? []).length === 0 && (
                <tr><td colSpan={4} className="p-6 text-center text-muted-foreground">لا وصفات بعد.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
