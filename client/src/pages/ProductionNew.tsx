import { ProductSearchPicker, type PurchaseRow } from "@/components/production/ProductSearchPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { confirm } from "@/lib/confirm";
import { D, fmt, pct, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printProductionDoc } from "@/lib/printing/printTemplates";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** شريط مقياس (مخزون متاح / إنتاجية). */
function Meter({ value, max, tone, right, label }: { value: number; max: number; tone: "ok" | "warn" | "bad"; right?: string; label?: string }) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const color = tone === "bad" ? "bg-rose-500" : tone === "warn" ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="w-full">
      {(label || right) && (
        <div className="flex justify-between text-xs font-semibold mb-1"><span>{label}</span><span className="text-muted-foreground" dir="ltr">{right}</span></div>
      )}
      <div className="h-2 rounded-full bg-muted overflow-hidden"><div className={`h-full rounded-full ${color}`} style={{ width: `${(ratio * 100).toFixed(1)}%` }} /></div>
    </div>
  );
}

// ───────────────────── الوضع اليدوي (مدخلات/مخرجات حرّة) ─────────────────────
let _key = 1;
type Line = {
  key: number; variantId: number; productName: string; sku: string;
  costPriceBase: string; stockBase: number; units: PurchaseRow[];
  productUnitId: number | null; conversionFactor: string; qty: string;
};
function mkLine(v: PurchaseRow, units: PurchaseRow[]): Line {
  return {
    key: _key++, variantId: v.variantId, productName: v.productName, sku: v.sku,
    costPriceBase: String(v.costPriceBase ?? "0"), stockBase: Number(v.stockBase ?? 0),
    units: units.length ? units : [v], productUnitId: v.productUnitId, conversionFactor: String(v.conversionFactor ?? "1"), qty: "1",
  };
}
function lineBase(l: Line) { return D(l.qty).times(D(l.conversionFactor)); }
function lineValid(l: Line) { const b = lineBase(l); return b.gt(0) && b.isInteger(); }

export default function ProductionNew() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const utils = trpc.useUtils();

  const preRecipe = useMemo(() => {
    const id = Number(new URLSearchParams(search).get("recipe"));
    return Number.isFinite(id) && id > 0 ? id : null;
  }, [search]);

  const [mode, setMode] = useState<"recipe" | "manual">("recipe");
  const [branchId, setBranchId] = useState<number | "">("");
  const effectiveBranch = Number(branchId || me.data?.branchId || (branches.data?.[0] ? Number(branches.data[0].id) : 1));
  const branchName = (branches.data ?? []).find((b) => Number(b.id) === effectiveBranch)?.name ?? "";

  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());
  const [showHelp, setShowHelp] = useState(false);

  const recipes = trpc.production.recipes.list.useQuery({ activeOnly: true });
  const [recipeId, setRecipeId] = useState<number | "">("");
  const [batch, setBatch] = useState("100");
  const [scrap, setScrap] = useState("0");
  const [labor, setLabor] = useState("0");
  const [workOrder, setWorkOrder] = useState("");

  // اضبط الوصفة من رابط ?recipe= مرّة واحدة.
  useEffect(() => { if (preRecipe) { setRecipeId(preRecipe); setMode("recipe"); } }, [preRecipe]);

  // عمالة الوصفة الافتراضية عند اختيارها (يعيد الضبط أيضاً متى وصلت قائمة الوصفات بعد التحديد من الرابط).
  const selectedRecipe = (recipes.data ?? []).find((r: any) => Number(r.id) === Number(recipeId)) as any;
  useEffect(() => {
    if (selectedRecipe) setLabor(String(selectedRecipe.laborPerOutputBase ?? "0"));
  }, [recipeId, selectedRecipe?.laborPerOutputBase]); // eslint-disable-line react-hooks/exhaustive-deps

  // معاينة حيّة (مُهلَّة) — نفس حساب الترحيل خادمياً.
  const dBatch = useDebouncedValue(batch, 300);
  const dScrap = useDebouncedValue(scrap, 300);
  const dLabor = useDebouncedValue(labor, 300);
  const previewEnabled = mode === "recipe" && !!recipeId && Number(dBatch) > 0;
  const preview = trpc.production.runPreview.useQuery(
    { recipeId: Number(recipeId), batchQty: Math.trunc(Number(dBatch) || 0), scrapQty: Math.trunc(Number(dScrap) || 0), laborPerUnit: D(dLabor || "0").toFixed(2), branchId: effectiveBranch },
    { enabled: previewEnabled }
  );
  const pv = preview.data;

  const create = trpc.production.create.useMutation({
    onSuccess: (r: any) => {
      setClientRequestId(crypto.randomUUID());
      notify.ok("تم ترحيل المستند", `رقم ${r.docNumber} — حُدِّث المخزون.`);
      utils.production.list.invalidate();
      utils.inventory.onHand.invalidate();
      utils.inventory.movementsRich.invalidate();
      navigate(`/production/${r.productionOrderId}`);
    },
    onError: (e) => { setError(e.message); notify.err(e); },
  });

  function printOrder() {
    if (!pv) return;
    printProductionDoc({
      branchName, workOrder: workOrder.trim() || null, recipeName: pv.recipeName,
      outputName: pv.outputName ?? "", outputUnit: pv.outputUnitName,
      planned: pv.batch, good: pv.good, scrap: pv.scrap, wasteStdPct: Number(pv.wasteStdPct),
      normalAllow: pv.normalAllow, abnormalUnits: pv.abnormalUnits, yieldPct: pv.yieldPct,
      inputs: pv.inputs.map((i) => ({ name: i.productName ?? "", sku: i.sku, perUnit: i.perOutputBase, consumed: i.consumed, short: i.short })),
      materialsCost: pv.materialsCost, laborCost: pv.laborCost, totalCost: pv.totalCost,
      abnormalLoss: pv.abnormalLoss, unitCost: pv.unitCost, newCost: pv.wavg.newCost,
    }, "order");
  }

  async function submitRecipe() {
    if (!recipeId) return setError("اختر وصفة أولاً.");
    if (!(Number(batch) > 0)) return setError("أدخل عدد الدفعة (عدد موجب).");
    if (!pv) return setError("انتظر اكتمال المعاينة.");
    if (pv.anyShort) return setError("المخزون لا يكفي لأحد المدخلات — قلّل الدفعة أو جهّز المخزون.");
    setError("");
    const noteParts = [notes.trim(), workOrder.trim() ? `مرتبط بأمر شغل: ${workOrder.trim()}` : ""].filter(Boolean);
    const ok = await confirm({
      variant: "warning",
      title: "تأكيد ترحيل التشغيل",
      description: `سيُخصم ${pv.inputs.length} مدخل ويُنتَج ${fmt(pv.good)} ${pv.outputUnitName ?? ""} «${pv.outputName}» بكلفة وحدة ${fmt(pv.unitCost)} د.ع.${Number(pv.abnormalLoss) > 0 ? ` خسارة هدر غير طبيعي ${fmt(pv.abnormalLoss)} د.ع تُسجَّل.` : ""} يُعدَّل المخزون فوراً. متابعة؟`,
      confirmText: "ترحيل المستند",
    });
    if (!ok) return;
    create.mutate({
      branchId: effectiveBranch,
      run: { recipeId: Number(recipeId), batchQty: Math.trunc(Number(batch)), scrapQty: Math.trunc(Number(scrap) || 0), laborPerUnit: D(labor || "0").toFixed(2) },
      notes: noteParts.join(" · ") || null,
      clientRequestId,
    });
  }

  // ── الوضع اليدوي ──
  const [inputs, setInputs] = useState<Line[]>([]);
  const [outputs, setOutputs] = useState<Line[]>([]);
  const [mLabor, setMLabor] = useState("0");
  const totalInputCost = useMemo(() => inputs.reduce((a, l) => a.plus(round2(D(l.costPriceBase).times(lineBase(l)))), D(0)), [inputs]);
  const mTotalCost = useMemo(() => round2(totalInputCost.plus(D(mLabor))), [totalInputCost, mLabor]);
  const totalOutBase = useMemo(() => outputs.reduce((a, l) => a.plus(lineBase(l)), D(0)), [outputs]);
  const unitOutCost = totalOutBase.gt(0) ? round2(mTotalCost.div(totalOutBase)) : D(0);

  function setLine(list: Line[], setList: (l: Line[]) => void, key: number, patch: Partial<Line>) {
    setList(list.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  async function submitManual() {
    if (inputs.length === 0) return setError("أضِف مدخلاً واحداً على الأقل.");
    if (outputs.length === 0) return setError("أضِف مخرجاً واحداً على الأقل.");
    for (const l of inputs) if (!lineValid(l)) return setError(`كمية المدخل «${l.productName}» يجب أن تنتج عدداً صحيحاً موجباً.`);
    for (const l of outputs) if (!lineValid(l)) return setError(`كمية المخرج «${l.productName}» يجب أن تنتج عدداً صحيحاً موجباً.`);
    if (D(mLabor).isNegative()) return setError("العمالة لا يمكن أن تكون سالبة.");
    setError("");
    const ok = await confirm({
      variant: "warning", title: "تأكيد مستند تحويل",
      description: `سيُستهلك ${inputs.length} منتج مدخل بكلفة ${fmt(mTotalCost.toString())} د.ع ويُنتَج ${outputs.length} منتج. يُعدَّل المخزون فوراً. متابعة؟`,
      confirmText: "ترحيل المستند",
    });
    if (!ok) return;
    const toPayload = (l: Line) => ({ variantId: l.variantId, productUnitId: l.productUnitId!, quantity: D(l.qty).toFixed(4) });
    create.mutate({
      branchId: effectiveBranch,
      inputs: inputs.map(toPayload), outputs: outputs.map(toPayload),
      laborCost: D(mLabor).toFixed(2), notes: notes.trim() || null, clientRequestId,
    });
  }
  function renderLines(list: Line[], setList: (l: Line[]) => void, kind: "in" | "out") {
    return list.map((l) => {
      const base = lineBase(l);
      const valid = lineValid(l);
      const over = kind === "in" && base.gt(l.stockBase);
      return (
        <div key={l.key} className="grid grid-cols-12 gap-2 items-center border rounded-md p-2">
          <div className="col-span-4"><div className="font-medium text-sm">{l.productName}</div><div className="text-xs text-muted-foreground font-mono" dir="ltr">{l.sku}</div></div>
          <div className="col-span-3">
            <select className={selectCls} value={l.productUnitId ?? ""} onChange={(e) => { const u = l.units.find((x) => x.productUnitId === Number(e.target.value)); setLine(list, setList, l.key, { productUnitId: Number(e.target.value), conversionFactor: String(u?.conversionFactor ?? "1") }); }}>
              {l.units.map((u) => <option key={u.productUnitId} value={u.productUnitId}>{u.unitName}{u.isBaseUnit ? " (أساس)" : ` × ${u.conversionFactor}`}</option>)}
            </select>
          </div>
          <div className="col-span-2"><Input dir="ltr" value={l.qty} onChange={(e) => setLine(list, setList, l.key, { qty: e.target.value })} /></div>
          <div className="col-span-2 text-left text-sm tabular-nums" dir="ltr">{kind === "in" ? fmt(round2(D(l.costPriceBase).times(base)).toString()) : <span className="text-sky-700">{fmt(unitOutCost.toString())}/و</span>}</div>
          <div className="col-span-1 text-left"><button type="button" className="text-rose-600 text-sm" onClick={() => setList(list.filter((x) => x.key !== l.key))}>حذف</button></div>
          {!valid && <div className="col-span-12 text-xs text-rose-600">الكمية يجب أن تُنتج عدداً صحيحاً موجباً من الوحدة الأساس.</div>}
          {over && <div className="col-span-12 text-xs text-amber-600">المتاح {Number(l.stockBase).toLocaleString("en-US")} فقط — سيُرفض إن لم يكفِ.</div>}
        </div>
      );
    });
  }

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">الإنتاج / تحويل المخزون</h1>
          <p className="text-sm text-muted-foreground mt-1">يُخصَم الورق المُدخَل ويُنتَج المنتج بكلفته الحقيقية. الورق مصدر حقيقة واحد ⇒ لا سالب.</p>
        </div>
        <Link href="/production" className="text-sm text-muted-foreground">← رجوع</Link>
      </div>

      {/* محدّد الوضع */}
      <div className="inline-flex gap-1 rounded-lg bg-muted p-1">
        <button onClick={() => setMode("recipe")} className={`px-4 py-1.5 rounded-md text-sm font-semibold ${mode === "recipe" ? "bg-background shadow text-foreground" : "text-muted-foreground"}`}>بوصفة (مُوصى)</button>
        <button onClick={() => setMode("manual")} className={`px-4 py-1.5 rounded-md text-sm font-semibold ${mode === "manual" ? "bg-background shadow text-foreground" : "text-muted-foreground"}`}>يدوي (حرّ)</button>
      </div>

      <Card>
        <CardContent className="pt-4">
          <button type="button" className="text-sm text-sky-700" onClick={() => setShowHelp((s) => !s)}>؟ متى أستخدم هذه الشاشة؟</button>
          {showHelp && (
            <div className="mt-2 text-xs text-muted-foreground space-y-1 leading-6">
              <p>• أبيع نفس الورق بوحدة أكبر/أصغر؟ ← <b>ليس إنتاجاً</b>: أضِف وحدة قياس للورق (ورقة/ربطة/كرتون).</p>
              <p>• أحوّل الورق إلى منتج جديد (دفتر/كتاب/كيس)؟ ← <b>هذه الشاشة</b> (بوصفة أو يدوي).</p>
              <p>• أستهلك منتجاً داخلياً (رول حراري/A4/أقلام) أو تلف؟ ← من <b>«المصاريف»</b> (نثرية/تلف).</p>
            </div>
          )}
        </CardContent>
      </Card>

      {mode === "recipe" ? (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_330px] gap-4 items-start">
          {/* العمود الرئيسي */}
          <div className="space-y-4 min-w-0">
            <Card>
              <CardHeader><CardTitle className="text-base">الوصفة والفرع</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>الوصفة *</Label>
                  <select className={selectCls} value={recipeId === "" ? "" : String(recipeId)} onChange={(e) => setRecipeId(e.target.value ? Number(e.target.value) : "")}>
                    <option value="">— اختر وصفة —</option>
                    {(recipes.data ?? []).map((r: any) => <option key={r.id} value={Number(r.id)}>{r.name}</option>)}
                  </select>
                  {(recipes.data ?? []).length === 0 && <p className="text-xs text-amber-600">لا وصفات مفعّلة. <Link href="/production-recipes" className="underline">أنشئ وصفة</Link> أولاً.</p>}
                </div>
                <div className="space-y-1">
                  <Label>الفرع</Label>
                  <select className={selectCls} value={effectiveBranch} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
                    {(branches.data ?? []).map((b) => <option key={Number(b.id)} value={Number(b.id)}>{b.name}</option>)}
                  </select>
                </div>
              </CardContent>
            </Card>

            {recipeId ? (
              <>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">الإنتاجية</CardTitle>
                    <p className="text-xs text-muted-foreground">رقم واحد يقود الاستهلاك = حجم الدفعة. الوحدة التالفة استهلكت ورقها — نتتبّعها بدل أن تختفي. السليم = الدفعة − التالف.</p>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] gap-2 items-end">
                      <div className="space-y-1">
                        <Label className="flex items-center gap-1">الدفعة <span title="العدد المطلوب تشغيله — هو وحده يقود استهلاك المواد." className="inline-grid place-items-center w-4 h-4 rounded-full bg-muted text-[10px] text-muted-foreground cursor-help">؟</span></Label>
                        <Input dir="ltr" value={batch} onChange={(e) => setBatch(e.target.value)} />
                      </div>
                      <div className="text-xl text-muted-foreground pb-2">−</div>
                      <div className="space-y-1">
                        <Label>التالف (هدر)</Label>
                        <Input dir="ltr" value={scrap} onChange={(e) => setScrap(e.target.value)} className="border-amber-400" />
                      </div>
                      <div className="text-xl text-muted-foreground pb-2">=</div>
                      <div className="space-y-1">
                        <Label>السليم الناتج</Label>
                        <div className="h-9 flex items-center gap-1 font-bold text-emerald-700 bg-emerald-50 rounded-md px-3" dir="ltr">{fmt(pv?.good ?? Math.max(0, Math.trunc(Number(batch) || 0) - Math.trunc(Number(scrap) || 0)))} <span className="text-xs text-muted-foreground font-normal">{pv?.outputUnitName}</span></div>
                      </div>
                    </div>
                    {pv && (
                      <div>
                        <Meter value={pv.good} max={pv.batch || 1} tone={pv.yieldPct >= 1 - Number(pv.wasteStdPct) ? "ok" : "warn"} label="الإنتاجية (Yield)" right={pct(pv.yieldPct)} />
                        <div className="flex gap-4 flex-wrap text-xs text-muted-foreground mt-2">
                          <span>بدأ التشغيل: <b className="text-foreground" dir="ltr">{fmt(pv.batch)}</b></span>
                          <span>مسموح طبيعي: <b className="text-foreground" dir="ltr">{fmt(pv.normalAllow)}</b></span>
                          {pv.abnormalUnits > 0 && <span>هدر غير طبيعي: <b className="text-rose-600" dir="ltr">{fmt(pv.abnormalUnits)}</b></span>}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">المدخلات المُستهلَكة</CardTitle>
                    <p className="text-xs text-muted-foreground">محسوبة من الوصفة × ما بدأ التشغيل ({fmt(pv?.batch ?? 0)}). الأشرطة تُظهر المتاح الحيّ.</p>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {preview.isLoading && <p className="text-xs text-muted-foreground">جارٍ الحساب…</p>}
                    {pv?.inputs.map((i) => {
                      const tone = i.short ? "bad" : i.available != null && i.consumed > i.available * 0.85 ? "warn" : "ok";
                      return (
                        <div key={i.variantId} className="grid grid-cols-1 md:grid-cols-[1fr_1.4fr] gap-3 items-center border rounded-md p-3">
                          <div>
                            <div className="font-medium text-sm">{i.productName}</div>
                            <div className="text-xs text-muted-foreground" dir="ltr">يُستهلك {fmt(i.consumed)} · كلفة {fmt(i.lineCost)} د.ع</div>
                          </div>
                          <div>
                            <Meter value={i.consumed} max={i.available ?? i.consumed} tone={tone} right={`${fmt(i.consumed)} / ${i.available != null ? fmt(i.available) : "—"}`} />
                            {i.short
                              ? <div className="text-xs font-semibold text-rose-600 mt-1.5">المتاح أقل بـ {fmt(i.consumed - (i.available ?? 0))} — سيُرفض الترحيل</div>
                              : i.available != null && <div className="text-xs font-semibold text-emerald-600 mt-1.5">يكفي ✓ يتبقّى {fmt(i.available - i.consumed)}</div>}
                          </div>
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader><CardTitle className="text-base">عمالة وربط</CardTitle></CardHeader>
                  <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label>عمالة مقطوعة / وحدة</Label>
                      <Input dir="ltr" value={labor} onChange={(e) => setLabor(e.target.value)} />
                      <p className="text-[11px] text-muted-foreground">إن سجّلت أجر العامل كمصروف رواتب منفصل اتركها صفراً (تفادي الاحتساب المزدوج).</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="flex items-center gap-1">ربط بأمر شغل (مرجع، اختياري) <span title="إن كان الإنتاج لأمر شغل بعينه، اذكره لتفادي خصم الورق مرّتين." className="inline-grid place-items-center w-4 h-4 rounded-full bg-muted text-[10px] text-muted-foreground cursor-help">؟</span></Label>
                      <Input dir="ltr" value={workOrder} onChange={(e) => setWorkOrder(e.target.value)} placeholder="WO-1-…" />
                      {workOrder.trim() && <p className="text-[11px] text-amber-600">تأكّد أن الورق لا يُخصَم مرّتين (هنا وداخل أمر الشغل).</p>}
                    </div>
                  </CardContent>
                </Card>

                <div className="space-y-1 max-w-xl">
                  <Label>ملاحظة (اختياري)</Label>
                  <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value.slice(0, 500))} placeholder="تفاصيل…" />
                </div>

                {error && <p className="text-sm text-destructive">{error}</p>}
                <div className="flex gap-2 flex-wrap">
                  <Button onClick={submitRecipe} disabled={create.isPending || !pv || pv.anyShort || !(pv.good > 0)}>
                    {create.isPending ? "جارٍ الترحيل…" : pv?.anyShort ? "المخزون لا يكفي" : "ترحيل المستند"}
                  </Button>
                  <Button variant="outline" onClick={printOrder} disabled={!pv}>🖨 طباعة أمر تشغيل</Button>
                  <Link href="/production"><Button variant="ghost">إلغاء</Button></Link>
                </div>
              </>
            ) : (
              <Card><CardContent className="p-6 text-center text-muted-foreground">اختر وصفة لبدء التشغيل، أو <Link href="/production-recipes" className="text-sky-700 underline">أنشئ وصفة جديدة</Link>.</CardContent></Card>
            )}
          </div>

          {/* العمود الجانبي: الكلفة + WAVG */}
          <div className="space-y-4 lg:sticky lg:top-4">
            <Card className="border-sky-200">
              <CardHeader><CardTitle className="text-base">الكلفة وتوزيعها</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">كلفة المواد</span><b dir="ltr">{fmt(pv?.materialsCost ?? 0)}</b></div>
                <div className="flex justify-between"><span className="text-muted-foreground">العمالة</span><b dir="ltr">{fmt(pv?.laborCost ?? 0)}</b></div>
                <div className="flex justify-between border-t border-dashed pt-2"><span className="font-semibold">الكلفة الكلية للتشغيل</span><b dir="ltr">{fmt(pv?.totalCost ?? 0)}</b></div>
                <div className="mt-2 p-2 rounded-md bg-muted/50 space-y-1">
                  <div className="text-xs font-semibold text-muted-foreground">معالجة الهدر</div>
                  <div className="flex justify-between text-xs text-emerald-700"><span>هدر طبيعي ({fmt(pv?.normalAllow ?? 0)}) — يُمتَص في كلفة السليم</span><b>مُحمَّل</b></div>
                  {pv && pv.abnormalUnits > 0
                    ? <div className="flex justify-between text-xs text-rose-600"><span>هدر غير طبيعي ({fmt(pv.abnormalUnits)}) — خسارة منفصلة</span><b dir="ltr">− {fmt(pv.abnormalLoss)}</b></div>
                    : <div className="flex justify-between text-xs text-muted-foreground"><span>لا هدر غير طبيعي</span><b dir="ltr">0</b></div>}
                </div>
                <div className="flex justify-between items-center mt-2 px-3 py-2 rounded-md bg-emerald-50">
                  <span className="font-semibold">كلفة الوحدة السليمة</span>
                  <b className="text-lg text-emerald-700" dir="ltr">{fmt(pv?.unitCost ?? 0)}</b>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">أثر المتوسّط المرجّح (WAVG)</CardTitle>
                {pv && <p className="text-xs text-muted-foreground">{pv.outputName}</p>}
              </CardHeader>
              <CardContent>
                <div className="flex items-stretch gap-2">
                  <div className="flex-1 text-center p-2 rounded-md bg-muted/50">
                    <div className="text-[10px] text-muted-foreground font-bold">قبل</div>
                    <div className="text-base font-bold" dir="ltr">{fmt(pv?.wavg.oldQty ?? 0)}</div>
                    <div className="text-[11px] text-muted-foreground" dir="ltr">{fmt(pv?.wavg.oldCost ?? 0)}</div>
                  </div>
                  <div className="flex items-center text-muted-foreground">←</div>
                  <div className="flex-1 text-center p-2 rounded-md bg-sky-50">
                    <div className="text-[10px] text-muted-foreground font-bold">يُضاف</div>
                    <div className="text-base font-bold" dir="ltr">+{fmt(pv?.wavg.addQty ?? 0)}</div>
                    <div className="text-[11px] text-muted-foreground" dir="ltr">{fmt(pv?.unitCost ?? 0)}</div>
                  </div>
                  <div className="flex items-center text-muted-foreground">←</div>
                  <div className="flex-1 text-center p-2 rounded-md bg-emerald-50">
                    <div className="text-[10px] text-muted-foreground font-bold">بعد</div>
                    <div className="text-base font-bold" dir="ltr">{fmt(pv?.wavg.newQty ?? 0)}</div>
                    <div className="text-[11px] text-muted-foreground" dir="ltr">{fmt(pv?.wavg.newCost ?? 0)}</div>
                  </div>
                </div>
                {pv && <p className="text-xs text-muted-foreground text-center mt-3 leading-6">كلفة المنتج ستتغيّر من <b className="text-foreground" dir="ltr">{fmt(pv.wavg.oldCost)}</b> إلى <b className="text-foreground" dir="ltr">{fmt(pv.wavg.newCost)}</b> — احسبها قبل الترحيل لتسعير صحيح.</p>}
              </CardContent>
            </Card>
          </div>
        </div>
      ) : (
        // ───────── الوضع اليدوي ─────────
        <div className="space-y-4 max-w-4xl">
          <Card>
            <CardHeader><CardTitle className="text-base">الفرع</CardTitle></CardHeader>
            <CardContent>
              <select className={selectCls} value={effectiveBranch} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
                {(branches.data ?? []).map((b) => <option key={Number(b.id)} value={Number(b.id)}>{b.name}</option>)}
              </select>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">المدخلات (المُستهلَكة)</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <ProductSearchPicker branchId={effectiveBranch} placeholder="ابحث عن منتج مدخل…" onPick={(v, u) => setInputs((p) => [...p, mkLine(v, u)])} />
              {inputs.length > 0 ? renderLines(inputs, setInputs, "in") : <p className="text-xs text-muted-foreground">لم تُضف مدخلات بعد.</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">عمالة/تشغيل (اختياري)</CardTitle></CardHeader>
            <CardContent>
              <div className="space-y-1 max-w-xs">
                <Label>كلفة العمالة الكلية</Label>
                <Input dir="ltr" value={mLabor} onChange={(e) => setMLabor(e.target.value)} placeholder="0" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">المخرجات (المُنتَجة)</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <ProductSearchPicker branchId={effectiveBranch} placeholder="ابحث عن المنتج الناتج…" onPick={(v, u) => setOutputs((p) => [...p, mkLine(v, u)])} />
              {outputs.length > 0 ? renderLines(outputs, setOutputs, "out") : <p className="text-xs text-muted-foreground">لم تُضف مخرجات بعد.</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">الإجماليات</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div><div className="text-xs text-muted-foreground">كلفة المواد</div><div className="font-semibold tabular-nums" dir="ltr">{fmt(totalInputCost.toString())}</div></div>
              <div><div className="text-xs text-muted-foreground">العمالة</div><div className="font-semibold tabular-nums" dir="ltr">{fmt(mLabor)}</div></div>
              <div><div className="text-xs text-muted-foreground">الكلفة الكلية</div><div className="font-bold text-sky-700 tabular-nums" dir="ltr">{fmt(mTotalCost.toString())}</div></div>
              <div><div className="text-xs text-muted-foreground">كلفة الوحدة الناتجة</div><div className="font-semibold tabular-nums" dir="ltr">{fmt(unitOutCost.toString())}</div></div>
            </CardContent>
          </Card>
          <div className="space-y-1 max-w-xl">
            <Label>ملاحظة (اختياري)</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value.slice(0, 500))} placeholder="تفاصيل…" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button onClick={submitManual} disabled={create.isPending}>{create.isPending ? "جارٍ الترحيل…" : "حفظ المستند"}</Button>
            <Link href="/production"><Button variant="outline">إلغاء</Button></Link>
          </div>
        </div>
      )}
    </div>
  );
}
