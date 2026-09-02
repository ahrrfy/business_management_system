import { ProductSearchPicker, type PurchaseRow } from "@/components/production/ProductSearchPicker";
import { AppSelect } from "@/components/ui/AppSelect";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { confirm } from "@/lib/confirm";
import { D, fmt, fmtInt, pct, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printProductionDoc } from "@/lib/printing/printTemplates";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useSaveShortcuts } from "@/hooks/useSaveShortcuts";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";
import { normalizeSearchText } from "@shared/searchNormalize";
import { Check, Printer, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";

/** حالات أمر الشغل النشطة — مرآة WO_ACTIVE_STATUSES في workOrderRouter.ts (خادميّ، لا يُستورَد
 *  للعميل). يُستعمَل لمنتقي «ربط بطلب خدمة» — لا معنى لربط إنتاجٍ بأمرٍ مُسلَّم/ملغى. */
const WO_OPEN_STATUSES = ["RECEIVED", "IN_PROGRESS", "READY"] as const;

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** منتقي الفرع — إن لزم اختياراً صريحاً (needsBranchChoice) يعرض «— اختر الفرع —» إلزامياً،
 *  وإلا يعرض فرع المستخدم/المُختار مباشرةً. مشترك بين وضعَي وصفة/يدوي كي لا يتكرّر. */
function BranchPicker({
  needsChoice, value, branches, onChange,
}: {
  needsChoice: boolean;
  value: number;
  branches: Array<{ id: number | string; name: string | null }>;
  onChange: (v: number | "") => void;
}) {
  return (
    <div className="space-y-1">
      <Label>الفرع {needsChoice && <span className="text-destructive">*</span>}</Label>
      <AppSelect
        className="h-9"
        value={String(needsChoice ? "" : value)}
        onValueChange={(next) => onChange(next ? Number(next) : "")}
      >
        {needsChoice && <option value="">— اختر الفرع —</option>}
        {branches.map((b) => <option key={Number(b.id)} value={Number(b.id)}>{b.name}</option>)}
      </AppSelect>
      {needsChoice && <p className="text-xs text-destructive">يلزم اختيار الفرع قبل الترحيل.</p>}
    </div>
  );
}

/** شريط مقياس (مخزون متاح / إنتاجية). */
function Meter({ value, max, tone, right, label }: { value: number; max: number; tone: "ok" | "warn" | "bad"; right?: string; label?: string }) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const color = tone === "bad" ? "bg-[var(--sem-neg)]" : tone === "warn" ? "bg-[var(--sem-warn)]" : "bg-[var(--sem-pos)]";
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
  // منتقي فرع صريح (نمط PR #288 في Reception.tsx): فرع المستخدم المُسنَد يُستعمَل صامتاً؛ الأدمن/
  // المدير بلا فرع مُسنَد يلزمه اختيارٌ صريح قبل الترحيل — بدل فرعٍ أوّل في القائمة يُختار صامتاً
  // (كان يُنتِج/يستهلك من فرعٍ قد لا يقصده المستخدم إطلاقاً).
  const [branchId, setBranchId] = useState<number | "">("");
  const isElevatedRole = me.data?.role === "admin" || me.data?.role === "manager";
  const noAssignedBranch = me.data != null && me.data.branchId == null;
  const needsBranchChoice = noAssignedBranch && isElevatedRole && branchId === "";
  const effectiveBranch = Number(me.data?.branchId ?? (branchId || null) ?? 1);
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

  // ربط بطلب شغل مفتوح — منتقي بحث حقيقي (يُرسَل linkedWorkOrderId فعلياً للخادم) بدل حقل نصّ
  // حرّ سابق كان يُكتب في الملاحظة فقط بلا ربط فعليّ بالسجل.
  const [workOrderId, setWorkOrderId] = useState<number | null>(null);
  const [woQuery, setWoQuery] = useState("");
  const openWOs = trpc.workOrders.list.useQuery(
    { statuses: [...WO_OPEN_STATUSES], branchId: effectiveBranch || undefined, limit: 200 },
    { enabled: !needsBranchChoice },
  );
  const selectedWO = (openWOs.data ?? []).find((o) => Number(o.id) === workOrderId) ?? null;
  const woMatches = useMemo(() => {
    const rows = openWOs.data ?? [];
    const nq = normalizeSearchText(woQuery.trim());
    const filtered = nq
      ? rows.filter((o) => normalizeSearchText(`${o.orderNumber} ${o.title} ${o.customerName ?? ""}`).includes(nq))
      : rows;
    return filtered.slice(0, 30);
  }, [openWOs.data, woQuery]);

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
  /*
   * **خطأ المعاينة يُعرَض ولا يُبتلَع.** `runPreview` يرفض حالاتٍ مشروعةً برسائل عربية
   * دقيقة تسمّي المكوّن والرقم: «استهلاك «X» (4000.5) ليس عدداً صحيحاً — عدّل الدفعة أو
   * الوصفة» · «الوصفة معطّلة» · «الوصفة بلا مكوّنات» · «وحدة ناتج الوصفة غير صالحة».
   *
   * وكانت الشاشة تُسقط `preview.error` كلّه: `pv` يبقى undefined ⇒ بطاقة الإنتاجية
   * تختفي، وزرّ الترحيل يبقى معطَّلاً أبداً (`disabled={… || !pv || …}`) **بلا سطرٍ واحد
   * يقول لماذا**. فيرى المستعمل دفعةً تعمل عند رقمٍ وتتجمّد عند غيره بلا تفسير — وهو
   * بلاغ المالك: «لا تقبل إلا 100». الرسالة موجودة خادمياً منذ البداية؛ ينقصها العرض.
   */
  const previewErrorMsg = preview.error?.message ?? null;

  /*
   * **سقفُ الإنتاج يُسأل عنه مستقلاً عن الدفعة.** `runPreview` يرمي على الدفعة غير الصالحة
   * ⇒ لا يملك جواباً للسؤال «كم أستطيع؟» في اللحظة التي يُسأل فيها. ولذلك مسارٌ ثانٍ لا
   * يأخذ دفعةً أصلاً: يبقى الرقم المقترَح ظاهراً حتى وقتَ الخطأ، وهو أنفعُ ما يُعرَض عندئذٍ.
   * ولا يتبع `dBatch` عمداً — لا يُعاد جلبُه مع كل ضغطة حرف.
   */
  const capacity = trpc.production.recipeCapacity.useQuery(
    { recipeId: Number(recipeId), branchId: effectiveBranch },
    { enabled: mode === "recipe" && !!recipeId && !needsBranchChoice },
  );
  /*
   * **لا يُعلَن سقفٌ لوصفةٍ معطّلة.** `runPreview` ومسارُ الترحيل يرفضان المعطّلة صراحةً،
   * فإظهارُ «الأقصى الممكن إنتاجه» وزرِّ زرعه بجانب رسالة «الوصفة معطّلة» يجعل الشاشة
   * تناقض نفسها وتدعو إلى فعلٍ محكومٍ بالفشل. (أمسكها Codex على #911: رابطٌ محفوظ
   * `?recipe=` لوصفةٍ معطّلة، أو تعطيلُها من جلسةٍ أخرى والصفحة مفتوحة.)
   */
  const cap = capacity.data?.isActive ? capacity.data : null;

  const create = trpc.production.create.useMutation({
    onSuccess: (r: any) => {
      setClientRequestId(crypto.randomUUID());
      notify.ok("تم ترحيل المستند", `رقم ${r.docNumber} — حُدِّث المخزون.`);
      utils.production.list.invalidate();
      // السقف مشتقٌّ من الرصيد ⇒ يُبطَل مع بقيّة قرّاء المخزون. بدونه يعيش الرقم القديم
      // ٦٠ ثانية (staleTime العام) فيقترح الزرّ دفعةً لم يعد المخزون يحتملها.
      utils.production.recipeCapacity.invalidate();
      utils.inventory.onHand.invalidate();
      utils.inventory.movementsRich.invalidate();
      navigate(`/production/${r.productionOrderId}`);
    },
    onError: (e) => { setError(e.message); notify.err(e); },
  });

  function printOrder() {
    if (!pv) return;
    printProductionDoc({
      branchName, workOrder: selectedWO?.orderNumber ?? null, recipeName: pv.recipeName,
      outputName: pv.outputName ?? "", outputUnit: pv.outputUnitName,
      planned: pv.batch, good: pv.good, scrap: pv.scrap, wasteStdPct: Number(pv.wasteStdPct),
      normalAllow: pv.normalAllow, abnormalUnits: pv.abnormalUnits, yieldPct: pv.yieldPct,
      inputs: pv.inputs.map((i) => ({ name: i.productName ?? "", sku: i.sku, perUnit: i.perOutputBase, consumed: i.consumed, short: i.short })),
      materialsCost: pv.materialsCost, laborCost: pv.laborCost, totalCost: pv.totalCost,
      abnormalLoss: pv.abnormalLoss, unitCost: pv.unitCost, newCost: pv.wavg.newCost,
    }, "order");
  }

  async function submitRecipe() {
    if (needsBranchChoice) return setError("اختر الفرع أولاً.");
    if (!recipeId) return setError("اختر وصفة أولاً.");
    if (!(Number(batch) > 0)) return setError("أدخل عدد الدفعة (عدد موجب).");
    // Ctrl+S يتجاوز الزرّ المعطَّل ⇒ الرسالة هنا يجب أن تقول السبب الحقيقيّ لا «انتظر».
    if (!pv) return setError(previewErrorMsg ?? "انتظر اكتمال المعاينة.");
    if (pv.anyShort) return setError("المخزون لا يكفي لأحد المدخلات — قلّل الدفعة أو جهّز المخزون.");
    setError("");
    const noteParts = [notes.trim(), selectedWO ? `مرتبط بطلب خدمة: ${selectedWO.orderNumber}` : ""].filter(Boolean);
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
      linkedWorkOrderId: workOrderId ?? undefined,
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
    if (needsBranchChoice) return setError("اختر الفرع أولاً.");
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
  // اختصارات: Ctrl+S يرحّل المستند وفق الوضع الحاليّ (وصفة/يدوي)؛ بلا Esc (النموذج مكتظّ بقوائم
  // منسدلة — نمط CustomerNew.tsx §16 يحذّر من تعارض Esc مع إغلاق القائمة). والسبب باقٍ بعد
  // الهجرة إلى AppSelect: Radix Select يبتلع Esc كما كان يفعل <select> الأصليّ.
  useSaveShortcuts({
    onSave: () => void (mode === "recipe" ? submitRecipe() : submitManual()),
    enabled: !create.isPending,
  });
  useUnsavedGuard(
    notes.trim() !== "" ||
      workOrderId != null ||
      (mode === "recipe" ? recipeId !== "" : inputs.length > 0 || outputs.length > 0 || D(mLabor).gt(0)),
  );

  function renderLines(list: Line[], setList: (l: Line[]) => void, kind: "in" | "out") {
    return list.map((l) => {
      const base = lineBase(l);
      const valid = lineValid(l);
      const over = kind === "in" && base.gt(l.stockBase);
      return (
        <div key={l.key} className="grid grid-cols-12 gap-2 items-center border rounded-md p-2">
          <div className="col-span-4"><div className="font-medium text-sm">{l.productName}</div><div className="text-xs text-muted-foreground font-mono" dir="ltr">{l.sku}</div></div>
          <div className="col-span-3">
            <AppSelect className="h-9" value={String(l.productUnitId ?? "")} onValueChange={(value) => { const u = l.units.find((x) => x.productUnitId === Number(value)); setLine(list, setList, l.key, { productUnitId: Number(value), conversionFactor: String(u?.conversionFactor ?? "1") }); }}>
              {l.units.map((u) => <option key={u.productUnitId} value={u.productUnitId}>{u.unitName}{u.isBaseUnit ? " (أساس)" : ` × ${u.conversionFactor}`}</option>)}
            </AppSelect>
          </div>
          <div className="col-span-2"><Input dir="ltr" value={l.qty} onChange={(e) => setLine(list, setList, l.key, { qty: e.target.value })} /></div>
          <div className="col-span-2 text-left text-sm tabular-nums" dir="ltr">{kind === "in" ? fmt(round2(D(l.costPriceBase).times(base)).toString()) : <span className="text-[var(--sem-info)]">{fmt(unitOutCost.toString())}/و</span>}</div>
          <div className="col-span-1 text-left"><button type="button" className="text-destructive text-sm" onClick={() => setList(list.filter((x) => x.key !== l.key))}>حذف</button></div>
          {!valid && <div className="col-span-12 text-xs text-destructive">الكمية يجب أن تُنتج عدداً صحيحاً موجباً من الوحدة الأساس.</div>}
          {over && <div className="col-span-12 text-xs text-[var(--stock-low)]">المتاح {Number(l.stockBase).toLocaleString("en-US")} فقط — سيُرفض إن لم يكفِ.</div>}
        </div>
      );
    });
  }

  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader
        title="الإنتاج / تحويل المخزون"
        description="يُخصَم الورق المُدخَل ويُنتَج المنتج بكلفته الحقيقية. الورق مصدر حقيقة واحد ⇒ لا سالب."
        backHref="/production"
      />

      {/* محدّد الوضع */}
      <div className="inline-flex gap-1 rounded-lg bg-muted p-1">
        <button onClick={() => setMode("recipe")} className={`px-4 py-1.5 rounded-md text-sm font-semibold ${mode === "recipe" ? "bg-background shadow text-foreground" : "text-muted-foreground"}`}>بوصفة (مُوصى)</button>
        <button onClick={() => setMode("manual")} className={`px-4 py-1.5 rounded-md text-sm font-semibold ${mode === "manual" ? "bg-background shadow text-foreground" : "text-muted-foreground"}`}>يدوي (حرّ)</button>
      </div>

      <Card>
        <CardContent className="pt-4">
          <button type="button" className="text-sm text-[var(--sem-info)]" onClick={() => setShowHelp((s) => !s)}>؟ متى أستخدم هذه الشاشة؟</button>
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
                  <AppSelect className="h-9" value={recipeId === "" ? "" : String(recipeId)} onValueChange={(next) => setRecipeId(next ? Number(next) : "")}>
                    <option value="">— اختر وصفة —</option>
                    {(recipes.data ?? []).map((r: any) => <option key={r.id} value={Number(r.id)}>{r.name}</option>)}
                  </AppSelect>
                  {(recipes.data ?? []).length === 0 && <p className="text-xs text-[var(--stock-low)]">لا وصفات مفعّلة. <Link href="/production-recipes" className="underline">أنشئ وصفة</Link> أولاً.</p>}
                </div>
                <BranchPicker needsChoice={needsBranchChoice} value={effectiveBranch} branches={branches.data ?? []} onChange={setBranchId} />
              </CardContent>
            </Card>

            {needsBranchChoice ? (
              <Card><CardContent className="p-6 text-center text-sm text-destructive">اختر الفرع أعلاه أولاً لبدء التشغيل.</CardContent></Card>
            ) : recipeId ? (
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
                        <Input dir="ltr" value={scrap} onChange={(e) => setScrap(e.target.value)} className="border-[var(--stock-low)]" />
                      </div>
                      <div className="text-xl text-muted-foreground pb-2">=</div>
                      <div className="space-y-1">
                        <Label>السليم الناتج</Label>
                        <div className="h-9 flex items-center gap-1 font-bold badge-status-active rounded-md px-3" dir="ltr">{fmt(pv?.good ?? Math.max(0, Math.trunc(Number(batch) || 0) - Math.trunc(Number(scrap) || 0)))} <span className="text-xs text-muted-foreground font-normal">{pv?.outputUnitName}</span></div>
                      </div>
                    </div>
                    {cap && (
                      <div className="rounded-md border bg-muted/30 p-2.5 text-sm flex flex-wrap items-center gap-x-4 gap-y-2">
                        <span className="flex items-center gap-1.5">
                          الأقصى الممكن إنتاجه الآن:
                          <b className="tabular-nums" dir="ltr">{fmtInt(cap.maxBatch)}</b>
                          <span className="text-xs text-muted-foreground">{cap.outputUnitName}</span>
                        </span>
                        {cap.maxBatch > 0 && (
                          <Button type="button" variant="outline" size="sm" onClick={() => setBatch(String(cap.maxBatch))}>
                            استعمل هذا العدد
                          </Button>
                        )}
                        {cap.limitingComponent && (
                          <span className="text-xs text-muted-foreground">المحدِّد: {cap.limitingComponent}</span>
                        )}
                        {cap.batchMultipleNote && (
                          <span className="text-xs text-[var(--sem-warn)]">{cap.batchMultipleNote}</span>
                        )}
                        {cap.maxBatch === 0 && cap.maxByStock > 0 && (
                          <span className="text-xs text-[var(--sem-warn)]">
                            المخزون يكفي {fmtInt(cap.maxByStock)} فقط — دون أصغر دفعة صالحة ({fmtInt(cap.batchMultiple)}).
                          </span>
                        )}
                      </div>
                    )}
                    {previewErrorMsg && (
                      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-sm text-destructive space-y-1">
                        <div className="font-medium">تعذّر حساب هذه الدفعة — الترحيل موقوف:</div>
                        <div>{previewErrorMsg}</div>
                      </div>
                    )}
                    {pv && (
                      <div>
                        <Meter value={pv.good} max={pv.batch || 1} tone={pv.yieldPct >= 1 - Number(pv.wasteStdPct) ? "ok" : "warn"} label="الإنتاجية (Yield)" right={pct(pv.yieldPct)} />
                        <div className="flex gap-4 flex-wrap text-xs text-muted-foreground mt-2">
                          <span>بدأ التشغيل: <b className="text-foreground" dir="ltr">{fmt(pv.batch)}</b></span>
                          <span>مسموح طبيعي: <b className="text-foreground" dir="ltr">{fmt(pv.normalAllow)}</b></span>
                          {pv.abnormalUnits > 0 && <span>هدر غير طبيعي: <b className="text-destructive" dir="ltr">{fmt(pv.abnormalUnits)}</b></span>}
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
                              ? <div className="text-xs font-semibold text-destructive mt-1.5">المتاح أقل بـ {fmt(i.consumed - (i.available ?? 0))} — سيُرفض الترحيل</div>
                              : i.available != null && <div className="text-xs font-semibold text-money-positive mt-1.5 flex items-center gap-1"><Check aria-hidden className="size-3.5" /><span>يكفي — يتبقّى {fmt(i.available - i.consumed)}</span></div>}
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
                      <Label className="flex items-center gap-1">ربط بطلب شغل مفتوح (اختياري) <span title="إن كان الإنتاج لطلب شغل بعينه، اربطه فعلياً لتفادي خصم الورق مرّتين." className="inline-grid place-items-center w-4 h-4 rounded-full bg-muted text-[10px] text-muted-foreground cursor-help">؟</span></Label>
                      {selectedWO ? (
                        <div className="flex h-9 items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 text-sm">
                          <span className="truncate" dir="ltr">{selectedWO.orderNumber} <span className="text-muted-foreground">— {selectedWO.title}</span></span>
                          <button type="button" onClick={() => setWorkOrderId(null)} className="shrink-0 text-muted-foreground hover:text-destructive" aria-label="إلغاء الربط">
                            <X aria-hidden className="size-4" />
                          </button>
                        </div>
                      ) : (
                        <div className="relative">
                          <Input
                            dir="auto"
                            value={woQuery}
                            onChange={(e) => setWoQuery(e.target.value)}
                            placeholder="ابحث برقم الأمر/العنوان/العميل…"
                          />
                          {woQuery.trim() && (
                            <div className="absolute z-10 mt-1 w-full rounded-md border bg-popover shadow-md max-h-48 overflow-auto">
                              {woMatches.length === 0 ? (
                                <div className="px-3 py-2 text-xs text-muted-foreground">لا نتائج.</div>
                              ) : woMatches.map((o) => (
                                <button
                                  key={o.id}
                                  type="button"
                                  onClick={() => { setWorkOrderId(Number(o.id)); setWoQuery(""); }}
                                  className="w-full text-right px-3 py-1.5 hover:bg-accent text-sm border-b last:border-b-0"
                                >
                                  <span className="font-mono text-xs" dir="ltr">{o.orderNumber}</span> — {o.title}
                                  <span className="block text-[11px] text-muted-foreground">{o.customerName ?? "عميل نقدي"}</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {selectedWO && <p className="text-[11px] text-[var(--stock-low)]">تأكّد أن الورق لا يُخصَم مرّتين (هنا وداخل طلب الشغل).</p>}
                    </div>
                  </CardContent>
                </Card>

                <div className="space-y-1 max-w-xl">
                  <Label>ملاحظة (اختياري)</Label>
                  <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value.slice(0, 500))} placeholder="تفاصيل…" />
                </div>

                {error && <p className="text-sm text-destructive">{error}</p>}
                {!error && previewErrorMsg && <p className="text-sm text-destructive">{previewErrorMsg}</p>}
                <div className="flex gap-2 flex-wrap">
                  <Button onClick={submitRecipe} disabled={create.isPending || needsBranchChoice || !pv || pv.anyShort || !(pv.good > 0)}>
                    {create.isPending ? "جارٍ الترحيل…" : needsBranchChoice ? "اختر الفرع أولاً" : previewErrorMsg ? "تعذّر حساب الدفعة" : pv?.anyShort ? "المخزون لا يكفي" : "ترحيل المستند"}
                  </Button>
                  <Button variant="outline" onClick={printOrder} disabled={!pv}><Printer aria-hidden className="size-4" /> طباعة أمر تشغيل</Button>
                  <Link href="/production"><Button variant="ghost">إلغاء</Button></Link>
                </div>
              </>
            ) : (
              <Card><CardContent className="p-6 text-center text-muted-foreground">اختر وصفة لبدء التشغيل، أو <Link href="/production-recipes" className="text-[var(--sem-info)] underline">أنشئ وصفة جديدة</Link>.</CardContent></Card>
            )}
          </div>

          {/* العمود الجانبي: الكلفة + WAVG */}
          <div className="space-y-4 lg:sticky lg:top-4">
            <Card className="border-[var(--sem-info)]">
              <CardHeader><CardTitle className="text-base">الكلفة وتوزيعها</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">كلفة المواد</span><b dir="ltr">{fmt(pv?.materialsCost ?? 0)}</b></div>
                <div className="flex justify-between"><span className="text-muted-foreground">العمالة</span><b dir="ltr">{fmt(pv?.laborCost ?? 0)}</b></div>
                <div className="flex justify-between border-t border-dashed pt-2"><span className="font-semibold">الكلفة الكلية للتشغيل</span><b dir="ltr">{fmt(pv?.totalCost ?? 0)}</b></div>
                <div className="mt-2 p-2 rounded-md bg-muted/50 space-y-1">
                  <div className="text-xs font-semibold text-muted-foreground">معالجة الهدر</div>
                  <div className="flex justify-between text-xs text-money-positive"><span>هدر طبيعي ({fmt(pv?.normalAllow ?? 0)}) — يُمتَص في كلفة السليم</span><b>مُحمَّل</b></div>
                  {pv && pv.abnormalUnits > 0
                    ? <div className="flex justify-between text-xs text-money-negative"><span>هدر غير طبيعي ({fmt(pv.abnormalUnits)}) — خسارة منفصلة</span><b dir="ltr">− {fmt(pv.abnormalLoss)}</b></div>
                    : <div className="flex justify-between text-xs text-muted-foreground"><span>لا هدر غير طبيعي</span><b dir="ltr">0</b></div>}
                </div>
                <div className="flex justify-between items-center mt-2 px-3 py-2 rounded-md badge-status-active">
                  <span className="font-semibold">كلفة الوحدة السليمة</span>
                  <b className="text-lg text-money-positive" dir="ltr">{fmt(pv?.unitCost ?? 0)}</b>
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
                  <div className="flex-1 text-center p-2 rounded-md bg-[var(--sem-info-bg)]">
                    <div className="text-[10px] text-muted-foreground font-bold">يُضاف</div>
                    <div className="text-base font-bold" dir="ltr">+{fmt(pv?.wavg.addQty ?? 0)}</div>
                    <div className="text-[11px] text-muted-foreground" dir="ltr">{fmt(pv?.unitCost ?? 0)}</div>
                  </div>
                  <div className="flex items-center text-muted-foreground">←</div>
                  <div className="flex-1 text-center p-2 rounded-md bg-[var(--sem-pos-bg)]">
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
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
            <Card>
              <CardHeader><CardTitle className="text-base">الفرع</CardTitle></CardHeader>
              <CardContent>
                <BranchPicker needsChoice={needsBranchChoice} value={effectiveBranch} branches={branches.data ?? []} onChange={setBranchId} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">عمالة/تشغيل (اختياري)</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-1">
                  <Label>كلفة العمالة الكلية</Label>
                  <Input dir="ltr" value={mLabor} onChange={(e) => setMLabor(e.target.value)} placeholder="0" />
                </div>
              </CardContent>
            </Card>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            <Card>
              <CardHeader><CardTitle className="text-base">المدخلات (المُستهلَكة)</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <ProductSearchPicker branchId={effectiveBranch} placeholder="ابحث عن منتج مدخل…" onPick={(v, u) => setInputs((p) => [...p, mkLine(v, u)])} />
                {inputs.length > 0 ? renderLines(inputs, setInputs, "in") : <p className="text-xs text-muted-foreground">لم تُضف مدخلات بعد.</p>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">المخرجات (المُنتَجة)</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <ProductSearchPicker branchId={effectiveBranch} placeholder="ابحث عن المنتج الناتج…" onPick={(v, u) => setOutputs((p) => [...p, mkLine(v, u)])} />
                {outputs.length > 0 ? renderLines(outputs, setOutputs, "out") : <p className="text-xs text-muted-foreground">لم تُضف مخرجات بعد.</p>}
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader><CardTitle className="text-base">الإجماليات</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div><div className="text-xs text-muted-foreground">كلفة المواد</div><div className="font-semibold tabular-nums" dir="ltr">{fmt(totalInputCost.toString())}</div></div>
              <div><div className="text-xs text-muted-foreground">العمالة</div><div className="font-semibold tabular-nums" dir="ltr">{fmt(mLabor)}</div></div>
              <div><div className="text-xs text-muted-foreground">الكلفة الكلية</div><div className="font-bold text-[var(--sem-info)] tabular-nums" dir="ltr">{fmt(mTotalCost.toString())}</div></div>
              <div><div className="text-xs text-muted-foreground">كلفة الوحدة الناتجة</div><div className="font-semibold tabular-nums" dir="ltr">{fmt(unitOutCost.toString())}</div></div>
            </CardContent>
          </Card>
          <div className="space-y-1 max-w-xl">
            <Label>ملاحظة (اختياري)</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value.slice(0, 500))} placeholder="تفاصيل…" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button onClick={submitManual} disabled={create.isPending || needsBranchChoice}>
              {create.isPending ? "جارٍ الترحيل…" : needsBranchChoice ? "اختر الفرع أولاً" : "حفظ المستند"}
            </Button>
            <Link href="/production"><Button variant="outline">إلغاء</Button></Link>
          </div>
        </div>
      )}
    </div>
  );
}
