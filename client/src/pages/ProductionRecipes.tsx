import { ProductSearchPicker, type PurchaseRow } from "@/components/production/ProductSearchPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirm, confirmDelete } from "@/lib/confirm";
import { D, fmt, pct, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link } from "wouter";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

let _k = 1;
type CompUnit = { productUnitId: number; unitName: string; conversionFactor: string; isBaseUnit?: boolean };
type Comp = {
  key: number;
  inputVariantId: number;
  productName: string;
  sku: string;
  costPriceBase: string;
  units: CompUnit[];
  productUnitId: number | null;
  conversionFactor: string;
  qty: string;
};
type OutPick = { variantId: number; productName: string; sku: string; costPriceBase: string; units: PurchaseRow[]; unitId: number; unitName: string };

function compBaseQty(c: Comp) {
  return D(c.qty).times(D(c.conversionFactor || "1"));
}
function compLineCost(c: Comp) {
  return round2(D(c.costPriceBase).times(compBaseQty(c)));
}

export default function ProductionRecipes() {
  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId ?? 1;
  const utils = trpc.useUtils();
  const list = trpc.production.recipes.list.useQuery({});

  const [editId, setEditId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [out, setOut] = useState<OutPick | null>(null);
  const [labor, setLabor] = useState("0");
  const [wastePct, setWastePct] = useState("0"); // كنسبة مئوية للعرض (5 = 5%)
  const [comps, setComps] = useState<Comp[]>([]);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [q, setQ] = useState("");

  function resetForm() {
    setEditId(null); setName(""); setOut(null); setLabor("0"); setWastePct("0"); setComps([]); setError(""); setShowForm(false);
  }

  function pickComp(v: PurchaseRow, units: PurchaseRow[]) {
    const us: CompUnit[] = (units.length ? units : [v]).map((u) => ({
      productUnitId: u.productUnitId, unitName: u.unitName, conversionFactor: String(u.conversionFactor ?? "1"), isBaseUnit: u.isBaseUnit,
    }));
    const base = us.find((u) => u.isBaseUnit) ?? us[0];
    setComps((p) => [...p, {
      key: _k++, inputVariantId: v.variantId, productName: v.productName, sku: v.sku,
      costPriceBase: String(v.costPriceBase ?? "0"), units: us,
      productUnitId: base?.productUnitId ?? v.productUnitId, conversionFactor: base?.conversionFactor ?? "1", qty: "1",
    }]);
  }

  async function startEdit(id: number) {
    const r: any = await utils.production.recipes.get.fetch({ id });
    setEditId(id);
    setName(r.name);
    setOut({ variantId: r.outputVariantId, productName: r.outputProductName ?? `#${r.outputVariantId}`, sku: r.outputSku ?? "", costPriceBase: String(r.outputCostPrice ?? "0"), units: [], unitId: r.outputProductUnitId, unitName: r.outputUnitName ?? "" });
    setLabor(String(r.laborPerOutputBase ?? "0"));
    setWastePct(String(Math.round(Number(r.wasteStdPct ?? 0) * 100 * 100) / 100));
    setComps((r.lines ?? []).map((l: any) => {
      const units: CompUnit[] = (l.units ?? []).map((u: any) => ({ productUnitId: u.productUnitId, unitName: u.unitName, conversionFactor: String(u.conversionFactor), isBaseUnit: u.isBaseUnit }));
      // أعِد بناء الوحدة المخزّنة: إن وُجد inputProductUnitId استعمله، وإلّا الوحدة الأساس (معامل 1).
      const stored = units.find((u) => u.productUnitId === l.inputProductUnitId);
      const chosen = stored ?? units.find((u) => u.isBaseUnit) ?? units[0] ?? { productUnitId: l.inputProductUnitId ?? 0, unitName: "أساس", conversionFactor: "1" };
      const factor = D(chosen.conversionFactor || "1");
      const qty = factor.gt(0) ? D(l.qtyPerOutputBase).div(factor) : D(l.qtyPerOutputBase);
      return {
        key: _k++, inputVariantId: l.inputVariantId, productName: l.inputProductName ?? `#${l.inputVariantId}`, sku: l.inputSku ?? "",
        costPriceBase: String(l.inputCostPrice ?? "0"), units: units.length ? units : [chosen],
        productUnitId: chosen.productUnitId, conversionFactor: chosen.conversionFactor || "1", qty: qty.toString(),
      };
    }));
    setShowForm(true);
  }

  function duplicate(r: any) {
    startEdit(Number(r.id)).then(() => { setEditId(null); setName((r.name ?? "") + " (نسخة)"); });
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

  // لوحة الكلفة المعيارية الحيّة.
  const cost = useMemo(() => {
    const materials = comps.reduce((acc, c) => acc.plus(compLineCost(c)), D(0));
    const lab = D(labor);
    const direct = round2(materials.plus(lab));
    const waste = D(wastePct).div(100);
    const stdUnit = waste.lt(1) ? round2(direct.div(D(1).minus(waste))) : direct;
    const absorb = round2(stdUnit.minus(direct));
    const stored = out ? D(out.costPriceBase) : null;
    const delta = stored && stored.gt(0) ? round2(stdUnit.minus(stored)) : null;
    return { materials: round2(materials), labor: round2(lab), direct, waste, stdUnit, absorb, stored, delta };
  }, [comps, labor, wastePct, out]);

  function validate(): string | null {
    if (!name.trim()) return "اسم الوصفة مطلوب.";
    if (!out) return "اختر المنتج الناتج.";
    if (comps.length === 0) return "أضِف مكوّناً واحداً على الأقل.";
    if (D(wastePct).lt(0) || D(wastePct).gte(100)) return "الهدر المعياري يجب أن يكون بين 0% وأقل من 100%.";
    for (const c of comps) {
      if (c.inputVariantId === out.variantId) return "المنتج الناتج لا يكون مكوّناً من نفسه.";
      if (compBaseQty(c).lte(0)) return `كمية المكوّن «${c.productName}» يجب أن تكون موجبة.`;
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
      wasteStdPct: D(wastePct).div(100).toFixed(2),
      lines: comps.map((c) => ({ inputVariantId: c.inputVariantId, inputProductUnitId: c.productUnitId, qtyPerOutputBase: compBaseQty(c).toFixed(4) })),
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
  const rows: any[] = list.data ?? [];
  const filtered = rows.filter((r) => !q.trim() || String(r.name).includes(q.trim()));

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">وصفات الإنتاج</h1>
          <p className="text-sm text-muted-foreground mt-1">عرّف منتجاً متكرّراً مرّة واحدة (ملزمة/كتاب/كيس) ⇒ في الإنتاج تختار الوصفة وتكتب العدد فقط. مسار لا يقبل خطأ الموظف.</p>
        </div>
        {!showForm && <Button onClick={() => { resetForm(); setShowForm(true); }}>＋ وصفة جديدة</Button>}
      </div>

      {showForm && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_330px] gap-4 items-start">
          {/* العمود الرئيسي */}
          <div className="space-y-4 min-w-0">
            <Card>
              <CardHeader><CardTitle className="text-base">{editId ? "تعديل وصفة" : "وصفة جديدة"}</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label>اسم الوصفة *</Label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: ملزمة منهج الرياضيات" />
                  </div>
                  <div className="space-y-1">
                    <Label>المنتج الناتج *</Label>
                    {out ? (
                      <div className="flex items-center justify-between rounded-md border p-2 text-sm h-9">
                        <div className="truncate"><span className="font-medium">{out.productName}</span> <span className="text-xs text-muted-foreground font-mono" dir="ltr">{out.sku}</span></div>
                        <div className="flex items-center gap-2 shrink-0">
                          {out.units.length > 0 && (
                            <select className={selectCls + " w-auto"} value={out.unitId} onChange={(e) => setOut({ ...out, unitId: Number(e.target.value) })}>
                              {out.units.map((u) => <option key={u.productUnitId} value={u.productUnitId}>{u.unitName}{u.isBaseUnit ? " (أساس)" : ""}</option>)}
                            </select>
                          )}
                          <button type="button" className="text-rose-600 text-sm" onClick={() => setOut(null)}>تغيير</button>
                        </div>
                      </div>
                    ) : (
                      <ProductSearchPicker branchId={branchId} placeholder="ابحث عن المنتج الناتج…" onPick={(v, u) => setOut({ variantId: v.variantId, productName: v.productName, sku: v.sku, costPriceBase: String(v.costPriceBase ?? "0"), units: u.length ? u : [v], unitId: v.productUnitId, unitName: v.unitName })} />
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label>عمالة مقطوعة / وحدة ناتج (اختياري)</Label>
                    <Input dir="ltr" value={labor} onChange={(e) => setLabor(e.target.value)} placeholder="0" />
                  </div>
                  <div className="space-y-1">
                    <Label className="flex items-center gap-1">
                      عامل الهدر المعياري %
                      <span title="نسبة الوحدات التي تخرج تالفة عادةً في التشغيل. تُحمَّل تلقائياً على كلفة الوحدة السليمة؛ ما يتجاوزها يُسجَّل خسارة منفصلة." className="inline-grid place-items-center w-4 h-4 rounded-full bg-muted text-[10px] text-muted-foreground cursor-help">؟</span>
                    </Label>
                    <div className="relative">
                      <Input dir="ltr" value={wastePct} onChange={(e) => setWastePct(e.target.value)} placeholder="5" className="pl-7" />
                      <span className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground font-semibold text-sm">%</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">المكوّنات</CardTitle>
                <p className="text-xs text-muted-foreground">الكمية لكل وحدة ناتج واحدة. اختر وحدة المكوّن (ورقة / ربطة / غرام…).</p>
              </CardHeader>
              <CardContent className="space-y-2">
                <ProductSearchPicker branchId={branchId} placeholder="أضِف مكوّناً (ورق، غلاف، غراء…)…" onPick={pickComp} />
                {comps.map((c) => (
                  <div key={c.key} className="grid grid-cols-12 gap-2 items-center border rounded-md p-2">
                    <div className="col-span-12 md:col-span-4">
                      <div className="font-medium text-sm">{c.productName}</div>
                      <div className="text-xs text-muted-foreground font-mono" dir="ltr">{c.sku} · كلفة {fmt(c.costPriceBase)}</div>
                    </div>
                    <div className="col-span-4 md:col-span-2">
                      <Input dir="ltr" value={c.qty} onChange={(e) => setComps((p) => p.map((x) => x.key === c.key ? { ...x, qty: e.target.value } : x))} placeholder="كمية" />
                    </div>
                    <div className="col-span-5 md:col-span-3">
                      <select className={selectCls} value={c.productUnitId ?? ""} onChange={(e) => {
                        const u = c.units.find((x) => x.productUnitId === Number(e.target.value));
                        setComps((p) => p.map((x) => x.key === c.key ? { ...x, productUnitId: Number(e.target.value), conversionFactor: u?.conversionFactor ?? "1" } : x));
                      }}>
                        {c.units.map((u) => <option key={u.productUnitId} value={u.productUnitId}>{u.unitName}{Number(u.conversionFactor) !== 1 ? ` ×${u.conversionFactor}` : ""}</option>)}
                      </select>
                    </div>
                    <div className="col-span-2 md:col-span-2 text-left text-sm font-semibold tabular-nums" dir="ltr">{fmt(compLineCost(c).toString())}</div>
                    <div className="col-span-1 text-start">
                      <button type="button" className="text-rose-600 text-sm" onClick={() => setComps((p) => p.filter((x) => x.key !== c.key))}>حذف</button>
                    </div>
                  </div>
                ))}
                {comps.length === 0 && <p className="text-xs text-muted-foreground">لا مكوّنات بعد — ابحث وأضِف أعلاه.</p>}
              </CardContent>
            </Card>

            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button onClick={save} disabled={busy}>{busy ? "جارٍ الحفظ…" : "حفظ الوصفة"}</Button>
              <Button variant="outline" onClick={resetForm}>إلغاء</Button>
            </div>
          </div>

          {/* العمود الجانبي: كلفة حيّة + معاينة BOM */}
          <div className="space-y-4 lg:sticky lg:top-4">
            <Card className="border-sky-200">
              <CardHeader>
                <CardTitle className="text-base">الكلفة المعيارية — بأسعار اليوم</CardTitle>
                <p className="text-xs text-muted-foreground">تُحدَّث فوراً مع كل تعديل. تشمل امتصاص الهدر الطبيعي ({pct(cost.waste.toString())}).</p>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">كلفة المواد / وحدة</span><b dir="ltr">{fmt(cost.materials.toString())}</b></div>
                <div className="flex justify-between"><span className="text-muted-foreground">العمالة / وحدة</span><b dir="ltr">{fmt(cost.labor.toString())}</b></div>
                <div className="flex justify-between border-t border-dashed pt-2"><span className="font-semibold">كلفة مباشرة (بلا هدر)</span><b dir="ltr">{fmt(cost.direct.toString())}</b></div>
                <div className="flex justify-between text-amber-600"><span>+ امتصاص الهدر الطبيعي ({pct(cost.waste.toString())})</span><b dir="ltr">{fmt(cost.absorb.toString())}</b></div>
                <div className="flex justify-between items-center mt-2 px-3 py-2 rounded-md bg-sky-50">
                  <span className="font-semibold">الكلفة المعيارية / وحدة</span>
                  <b className="text-lg text-sky-700" dir="ltr">{fmt(cost.stdUnit.toString())}</b>
                </div>
                {cost.delta != null && (
                  <div className={`text-xs text-center ${cost.delta.gt(0) ? "text-rose-600" : cost.delta.lt(0) ? "text-emerald-600" : "text-muted-foreground"}`}>
                    {cost.delta.eq(0) ? "مطابِقة لكلفة المنتج الحالية" : <>الكلفة الحالية المخزّنة <span dir="ltr">{fmt(cost.stored!.toString())}</span> · فرق <span dir="ltr">{cost.delta.gt(0) ? "+" : ""}{fmt(cost.delta.toString())}</span></>}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">معاينة الوصفة</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-sky-100 text-sky-700">ناتج</span>
                  <span>{out?.productName ?? "—"} {out && <span className="text-xs text-muted-foreground font-normal">(1 {out.unitName})</span>}</span>
                </div>
                <div className="text-center text-xs text-muted-foreground">↑ يتطلّب</div>
                <ul className="space-y-1">
                  {comps.map((c) => (
                    <li key={c.key} className="text-sm px-3 py-2 rounded bg-muted/50">
                      <span dir="ltr">{c.qty} {c.units.find((u) => u.productUnitId === c.productUnitId)?.unitName ?? ""}</span> {c.productName}{" "}
                      <span className="text-xs text-muted-foreground" dir="ltr">= {fmt(compBaseQty(c).toString())} أساس</span>
                    </li>
                  ))}
                  {comps.length === 0 && <li className="text-xs text-muted-foreground text-center">—</li>}
                </ul>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* قائمة البطاقات */}
      {!showForm && (
        <>
          <div className="flex items-center gap-3">
            <Input className="max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 ابحث في الوصفات…" />
            <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-muted text-muted-foreground">{filtered.length} وصفة</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filtered.map((r) => (
              <Card key={Number(r.id)} className={r.isActive ? "" : "opacity-60"}>
                <CardContent className="pt-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-semibold leading-snug">{r.name}</div>
                    <span className={`shrink-0 inline-block rounded-full px-2 py-0.5 text-xs ${r.isActive ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"}`}>{r.isActive ? "مفعّلة" : "معطّلة"}</span>
                  </div>
                  <div className="text-sm text-muted-foreground">→ {r.outputProductName} <span className="text-xs">({r.outputUnitName})</span></div>
                  <div className="grid grid-cols-3 gap-2 border-y py-2 text-center">
                    <div><div className="text-[10px] text-muted-foreground font-semibold">كلفة المنتج</div><b className="text-sm tabular-nums" dir="ltr">{fmt(r.outputCostPrice)}</b></div>
                    <div><div className="text-[10px] text-muted-foreground font-semibold">مكوّنات</div><b className="text-sm tabular-nums" dir="ltr">{r.linesCount}</b></div>
                    <div><div className="text-[10px] text-muted-foreground font-semibold">هدر معياري</div><b className="text-sm tabular-nums" dir="ltr">{pct(r.wasteStdPct ?? 0)}</b></div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {r.isActive
                      ? <Link href={`/production/new?recipe=${Number(r.id)}`}><Button size="sm">إنتاج بهذه الوصفة ←</Button></Link>
                      : <Button size="sm" disabled>إنتاج بهذه الوصفة ←</Button>}
                    <button className="text-sky-700 text-xs font-semibold" onClick={() => startEdit(Number(r.id))}>تعديل</button>
                    <button className="text-muted-foreground hover:text-sky-700 text-xs font-semibold" onClick={() => duplicate(r)}>تكرار</button>
                    <button className="text-amber-700 text-xs font-semibold" onClick={async () => {
                      if (r.isActive && !(await confirm({ variant: "warning", title: "تعطيل الوصفة", description: `تعطيل وصفة «${r.name}»؟ الوصفات المعطَّلة لا تُستخدم للإنتاج. متابعة؟`, confirmText: "تعطيل" }))) return;
                      setActive.mutate({ id: Number(r.id), active: !r.isActive });
                    }}>{r.isActive ? "تعطيل" : "تفعيل"}</button>
                    <button className="text-rose-600 text-xs font-semibold" onClick={async () => {
                      if (!(await confirmDelete({ description: `حذف وصفة «${r.name}» نهائياً؟ الحذف نهائي ولا يُسترجَع.`, confirmText: "حذف نهائي" }))) return;
                      remove.mutate({ id: Number(r.id) });
                    }}>حذف</button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          {!list.isLoading && filtered.length === 0 && (
            <Card><CardContent className="p-6 text-center text-muted-foreground">{q.trim() ? "لا نتائج." : "لا وصفات بعد."}</CardContent></Card>
          )}
        </>
      )}
    </div>
  );
}
