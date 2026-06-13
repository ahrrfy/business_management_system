import { ProductSearchPicker, type PurchaseRow } from "@/components/production/ProductSearchPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { confirm } from "@/lib/confirm";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

let _key = 1;
type Line = {
  key: number;
  variantId: number;
  productName: string;
  sku: string;
  costPriceBase: string;
  stockBase: number;
  units: PurchaseRow[];
  productUnitId: number | null;
  conversionFactor: string;
  qty: string;
  /** وضع الوصفة: كمية أساس مثبّتة (للقراءة). */
  fixedBase: number | null;
};

function mkLine(v: PurchaseRow, units: PurchaseRow[]): Line {
  return {
    key: _key++,
    variantId: v.variantId,
    productName: v.productName,
    sku: v.sku,
    costPriceBase: String(v.costPriceBase ?? "0"),
    stockBase: Number(v.stockBase ?? 0),
    units: units.length ? units : [v],
    productUnitId: v.productUnitId,
    conversionFactor: String(v.conversionFactor ?? "1"),
    qty: "1",
    fixedBase: null,
  };
}

function baseQtyOf(l: Line) {
  if (l.fixedBase != null) return D(l.fixedBase);
  return D(l.qty).times(D(l.conversionFactor));
}
function lineValid(l: Line): boolean {
  const b = baseQtyOf(l);
  return b.gt(0) && b.isInteger();
}

export default function ProductionNew() {
  const [, navigate] = useLocation();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const utils = trpc.useUtils();

  const [branchId, setBranchId] = useState<number | "">("");
  const effectiveBranch = Number(branchId || me.data?.branchId || (branches.data?.[0] ? Number(branches.data[0].id) : 1));

  const [inputs, setInputs] = useState<Line[]>([]);
  const [outputs, setOutputs] = useState<Line[]>([]);
  const [laborCost, setLaborCost] = useState("0");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());

  // الوصفة.
  const recipes = trpc.production.recipes.list.useQuery({ activeOnly: true });
  const [recipeId, setRecipeId] = useState<number | "">("");
  const [recipeQty, setRecipeQty] = useState("1");
  const [recipeBusy, setRecipeBusy] = useState(false);

  const totalInputCost = useMemo(
    () => inputs.reduce((acc, l) => acc.plus(round2(D(l.costPriceBase).times(baseQtyOf(l)))), D(0)),
    [inputs]
  );
  const totalCost = useMemo(() => round2(totalInputCost.plus(D(laborCost))), [totalInputCost, laborCost]);
  const totalOutBase = useMemo(() => outputs.reduce((acc, l) => acc.plus(baseQtyOf(l)), D(0)), [outputs]);
  const unitOutCost = totalOutBase.gt(0) ? round2(totalCost.div(totalOutBase)) : D(0);

  function setLine(list: Line[], setList: (l: Line[]) => void, key: number, patch: Partial<Line>) {
    setList(list.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function applyRecipe() {
    if (!recipeId) return setError("اختر وصفة أولاً.");
    if (D(recipeQty).lte(0)) return setError("أدخل عدداً موجباً للإنتاج.");
    setError("");
    setRecipeBusy(true);
    try {
      const pv = await utils.production.recipes.preview.fetch({ recipeId: Number(recipeId), outputQuantity: D(recipeQty).toFixed(4), branchId: effectiveBranch });
      setInputs(
        pv.inputs.map((i) => ({
          key: _key++, variantId: i.variantId, productName: i.productName ?? `#${i.variantId}`, sku: i.sku ?? "",
          costPriceBase: i.unitCost, stockBase: i.available ?? 0, units: [], productUnitId: null,
          conversionFactor: "1", qty: String(i.baseQuantity), fixedBase: i.baseQuantity,
        }))
      );
      setOutputs([
        { key: _key++, variantId: pv.outputVariantId, productName: pv.outputName ?? `#${pv.outputVariantId}`, sku: "", costPriceBase: "0", stockBase: 0, units: [], productUnitId: pv.outputProductUnitId, conversionFactor: "1", qty: String(pv.outputBase), fixedBase: pv.outputBase },
      ]);
      setLaborCost(pv.laborCost);
      notify.ok("طُبّقت الوصفة", `المدخلات والمخرَج عُبّئت تلقائياً.`);
    } catch (e: any) {
      setError(e?.message ?? "تعذّرت معاينة الوصفة");
      notify.err(e);
    } finally {
      setRecipeBusy(false);
    }
  }

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

  function validate(): string | null {
    if (!effectiveBranch) return "اختر الفرع.";
    if (inputs.length === 0) return "أضِف مدخلاً واحداً على الأقل.";
    if (outputs.length === 0) return "أضِف مخرجاً واحداً على الأقل.";
    for (const l of inputs) if (!lineValid(l)) return `كمية المدخل «${l.productName}» يجب أن تنتج عدداً صحيحاً موجباً.`;
    for (const l of outputs) if (!lineValid(l)) return `كمية المخرج «${l.productName}» يجب أن تنتج عدداً صحيحاً موجباً.`;
    if (D(laborCost).isNegative()) return "العمالة لا يمكن أن تكون سالبة.";
    return null;
  }

  async function submit() {
    const err = validate();
    if (err) { setError(err); return; }
    setError("");
    const ok = await confirm({
      variant: "warning",
      title: "تأكيد مستند تحويل",
      description: `سيُستهلك ${inputs.length} صنف مدخل بكلفة ${fmt(totalCost.toString())} د.ع ويُنتَج ${outputs.length} صنف. يُعدَّل المخزون فوراً. متابعة؟`,
      confirmText: "ترحيل المستند",
    });
    if (!ok) return;
    const toPayload = (l: Line) =>
      l.fixedBase != null
        ? { variantId: l.variantId, baseQuantity: l.fixedBase }
        : { variantId: l.variantId, productUnitId: l.productUnitId!, quantity: D(l.qty).toFixed(4) };
    create.mutate({
      branchId: effectiveBranch,
      inputs: inputs.map(toPayload),
      outputs: outputs.map(toPayload),
      laborCost: D(laborCost).toFixed(2),
      notes: notes.trim() || null,
      linkedRecipeId: recipeId ? Number(recipeId) : null,
      clientRequestId,
    });
  }

  function renderLines(list: Line[], setList: (l: Line[]) => void, kind: "in" | "out") {
    return list.map((l) => {
      const base = baseQtyOf(l);
      const valid = lineValid(l);
      const over = kind === "in" && l.fixedBase == null && base.gt(l.stockBase);
      return (
        <div key={l.key} className="grid grid-cols-12 gap-2 items-center border rounded-md p-2">
          <div className="col-span-4">
            <div className="font-medium text-sm">{l.productName}</div>
            <div className="text-xs text-muted-foreground font-mono" dir="ltr">{l.sku}</div>
          </div>
          {l.fixedBase != null ? (
            <div className="col-span-3 text-sm" dir="ltr">{Number(l.fixedBase).toLocaleString("en-US")} <span className="text-xs text-muted-foreground">(أساس)</span></div>
          ) : (
            <>
              <div className="col-span-3">
                <select
                  className={selectCls}
                  value={l.productUnitId ?? ""}
                  onChange={(e) => {
                    const u = l.units.find((x) => x.productUnitId === Number(e.target.value));
                    setLine(list, setList, l.key, { productUnitId: Number(e.target.value), conversionFactor: String(u?.conversionFactor ?? "1") });
                  }}
                >
                  {l.units.map((u) => (
                    <option key={u.productUnitId} value={u.productUnitId}>
                      {u.unitName}{u.isBaseUnit ? " (أساس)" : ` × ${u.conversionFactor}`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-span-2">
                <Input dir="ltr" value={l.qty} onChange={(e) => setLine(list, setList, l.key, { qty: e.target.value })} />
              </div>
            </>
          )}
          <div className="col-span-2 text-left text-sm tabular-nums" dir="ltr">
            {kind === "in" ? (
              <span title="كلفة السطر">{fmt(round2(D(l.costPriceBase).times(base)).toString())}</span>
            ) : (
              <span title="كلفة الوحدة المحتسبة" className="text-sky-700">{fmt(unitOutCost.toString())}/و</span>
            )}
          </div>
          <div className="col-span-1 text-left">
            <button type="button" className="text-rose-600 text-sm" onClick={() => setList(list.filter((x) => x.key !== l.key))}>حذف</button>
          </div>
          {!valid && <div className="col-span-12 text-xs text-rose-600">الكمية يجب أن تُنتج عدداً صحيحاً موجباً من الوحدة الأساس.</div>}
          {over && <div className="col-span-12 text-xs text-amber-600">المتاح {Number(l.stockBase).toLocaleString("en-US")} فقط — سيُرفض إن لم يكفِ.</div>}
        </div>
      );
    });
  }

  return (
    <div className="space-y-4 max-w-4xl" dir="rtl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">الإنتاج / تحويل المخزون</h1>
        <Link href="/production" className="text-sm text-muted-foreground">← رجوع</Link>
      </div>

      {/* لوحة المساعدة */}
      <Card>
        <CardContent className="pt-4">
          <button type="button" className="text-sm text-sky-700" onClick={() => setShowHelp((s) => !s)}>
            ؟ متى أستخدم هذه الشاشة؟
          </button>
          {showHelp && (
            <div className="mt-2 text-xs text-muted-foreground space-y-1 leading-6">
              <p>• أبيع نفس الورق بوحدة أكبر/أصغر؟ ← <b>ليس إنتاجاً</b>: أضِف وحدة قياس للورق (ورقة/ربطة/كرتون) ولا تستخدم هذه الشاشة.</p>
              <p>• أحوّل الورق إلى منتج جديد (دفتر/كتاب/كيس)؟ ← <b>هذه الشاشة (تحويل)</b>.</p>
              <p>• أستهلك صنفاً داخلياً (رول حراري/A4/أقلام) أو تلف؟ ← من <b>«المصاريف»</b> (صرف من المخزون: نثرية/تلف).</p>
              <p className="text-amber-600">• إن كان الإنتاج لأمر شغل عميل بعينه فاستهلك الورق من داخل أمر الشغل (تفادي الخصم المزدوج).</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">الفرع</CardTitle></CardHeader>
        <CardContent>
          <select className={selectCls} value={effectiveBranch} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
            {(branches.data ?? []).map((b) => <option key={b.id} value={Number(b.id)}>{b.name}</option>)}
          </select>
        </CardContent>
      </Card>

      {/* الوصفة */}
      <Card>
        <CardHeader><CardTitle className="text-base">إنتاج بوصفة محفوظة (اختياري)</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          <div className="space-y-1 md:col-span-1">
            <Label>الوصفة</Label>
            <select className={selectCls} value={recipeId === "" ? "" : String(recipeId)} onChange={(e) => setRecipeId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">— بدون وصفة (يدوي) —</option>
              {(recipes.data ?? []).map((r: any) => <option key={r.id} value={Number(r.id)}>{r.name}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label>العدد المطلوب إنتاجه</Label>
            <Input dir="ltr" value={recipeQty} onChange={(e) => setRecipeQty(e.target.value)} placeholder="مثال: 50" />
          </div>
          <div>
            <Button type="button" variant="secondary" onClick={applyRecipe} disabled={!recipeId || recipeBusy}>
              {recipeBusy ? "جارٍ التطبيق…" : "تطبيق الوصفة"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* المدخلات */}
      <Card>
        <CardHeader><CardTitle className="text-base">المدخلات (المُستهلَكة)</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <ProductSearchPicker branchId={effectiveBranch} placeholder="ابحث عن صنف مدخل…" onPick={(v, u) => setInputs((p) => [...p, mkLine(v, u)])} />
          {inputs.length > 0 && renderLines(inputs, setInputs, "in")}
          {inputs.length === 0 && <p className="text-xs text-muted-foreground">لم تُضف مدخلات بعد.</p>}
        </CardContent>
      </Card>

      {/* العمالة */}
      <Card>
        <CardHeader><CardTitle className="text-base">عمالة/تشغيل (اختياري)</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-1 max-w-xs">
            <Label>كلفة العمالة الكلية</Label>
            <Input dir="ltr" value={laborCost} onChange={(e) => setLaborCost(e.target.value)} placeholder="0" />
            <p className="text-[11px] text-muted-foreground">تُضاف لكلفة المنتج. إن كنت تُسجّل أجور العامل كمصروف رواتب منفصل فاتركها صفراً (تفادي الاحتساب المزدوج).</p>
          </div>
        </CardContent>
      </Card>

      {/* المخرجات */}
      <Card>
        <CardHeader><CardTitle className="text-base">المخرجات (المُنتَجة)</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <ProductSearchPicker branchId={effectiveBranch} placeholder="ابحث عن المنتج الناتج…" onPick={(v, u) => setOutputs((p) => [...p, mkLine(v, u)])} />
          {outputs.length > 0 && renderLines(outputs, setOutputs, "out")}
          {outputs.length === 0 && <p className="text-xs text-muted-foreground">لم تُضف مخرجات بعد.</p>}
        </CardContent>
      </Card>

      {/* الإجماليات */}
      <Card>
        <CardHeader><CardTitle className="text-base">الإجماليات</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div><div className="text-xs text-muted-foreground">كلفة المواد</div><div className="font-semibold tabular-nums" dir="ltr">{fmt(totalInputCost.toString())}</div></div>
          <div><div className="text-xs text-muted-foreground">العمالة</div><div className="font-semibold tabular-nums" dir="ltr">{fmt(laborCost)}</div></div>
          <div><div className="text-xs text-muted-foreground">الكلفة الكلية</div><div className="font-bold text-sky-700 tabular-nums" dir="ltr">{fmt(totalCost.toString())}</div></div>
          <div><div className="text-xs text-muted-foreground">كلفة الوحدة الناتجة</div><div className="font-semibold tabular-nums" dir="ltr">{fmt(unitOutCost.toString())}</div></div>
        </CardContent>
      </Card>

      <div className="space-y-1 max-w-xl">
        <Label>ملاحظة (اختياري)</Label>
        <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value.slice(0, 500))} placeholder="تفاصيل…" />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={submit} disabled={create.isPending}>{create.isPending ? "جارٍ الترحيل…" : "حفظ المستند"}</Button>
        <Link href="/production"><Button variant="outline">إلغاء</Button></Link>
      </div>
    </div>
  );
}
