// شاشة التحويل بين الفروع — تبويبان: إنشاء سند (بتجربة جدول الفاتورة المتقدمة) وسجلّ السندات.
//
// سلة الأصناف (طلب المالك ١٤/٧): TransferCart تعيد استخدام ProductSearchBar وBulkPicker من طقم
// الفاتورة ⇒ بحث حيّ بالأسهم/Enter + ماسح باركود + «إضافة متعددة» بتحديد جماعي + سطر لكل
// **وحدة** (قطعة/درزن/كرتون) بكميّة ± ومعادلها بالأساس. الأسعار/الخصومات مستبعَدة (لا معنى
// لها في نقل مخزني بلا قيد).
//
// التجميع قبل الإرسال: الخادم يقبل سطراً واحداً لكل متغيّر بالوحدة الأساس ⇒ نجمع أسطر الوحدات
// المختلفة لنفس المتغيّر (درزن ١٢ + قطعة ٣ = ١٥ أساس) في بندٍ واحد.
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TransferCart, computeLineStates, type TransferCartLine } from "@/components/transfer/TransferCart";
import { confirm } from "@/lib/confirm";
import { fmtInt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { ArrowRightLeft, Inbox, PackagePlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import TransfersLog from "@/pages/TransfersLog";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const REASONS = [
  { value: "REBALANCE", label: "إعادة توزيع المخزون" },
  { value: "STOCKOUT", label: "نفاد في الفرع المستلم" },
  { value: "BRANCH_REQ", label: "طلب من الفرع" },
  { value: "SEASONAL", label: "تجهيز موسمي" },
  { value: "RETURN_HQ", label: "إرجاع للمخزن الرئيسي" },
  { value: "OTHER", label: "أخرى" },
] as const;

function genTrf(): string {
  const d = new Date();
  const y = String(d.getFullYear()).slice(-2);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `TRF-${y}${m}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
}

/** يجمع أسطر السلة (وحدات مختلفة) في بندٍ واحد لكل متغيّر بالوحدة الأساس. */
export function aggregateByVariant(lines: TransferCartLine[]): Array<{ variantId: number; baseQuantity: number; name: string; stockBase: number }> {
  const byVariant = new Map<number, { variantId: number; baseQuantity: number; name: string; stockBase: number }>();
  for (const l of lines) {
    const factor = Number(l.conversionFactor) || 1;
    const base = (Number(l.qty) || 0) * factor;
    const cur = byVariant.get(l.variantId);
    if (cur) cur.baseQuantity += base;
    else byVariant.set(l.variantId, { variantId: l.variantId, baseQuantity: base, name: l.name, stockBase: Number(l.stockBase) || 0 });
  }
  return Array.from(byVariant.values());
}

export default function Transfers() {
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();
  const branches = trpc.branches.list.useQuery();
  const [tab, setTab] = useState<"new" | "log">("new");
  const pending = trpc.inventory.transfersPendingIncoming.useQuery(undefined, { refetchInterval: 60_000 });

  const [fromBranchId, setFromBranchId] = useState<number | "">("");
  const [toBranchId, setToBranchId] = useState<number | "">("");
  const [reason, setReason] = useState<string>("REBALANCE");
  const [notes, setNotes] = useState("");
  const [cart, setCart] = useState<TransferCartLine[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [trf, setTrf] = useState(() => genTrf());
  // IDEMPOTENCY (تدقيق ٢/٧): مفتاح ثابت للسند الحالي (يُجدَّد بعد النجاح) ⇒ النقر المزدوج/إعادة
  // الشبكة يُعاد كـreplay على الخادم بدل نقل المخزون بين الفروع مرّتين.
  const [reqId, setReqId] = useState(() => crypto.randomUUID());

  // فروع افتراضية بعد التحميل: المصدر = فرع المستخدم أو الأول، الوجهة = أول فرع مختلف.
  const effectiveFrom =
    fromBranchId || me.data?.branchId || (branches.data?.[0] ? Number(branches.data[0].id) : 0);
  const effectiveTo =
    toBranchId ||
    (branches.data?.find((b) => Number(b.id) !== Number(effectiveFrom))
      ? Number(branches.data.find((b) => Number(b.id) !== Number(effectiveFrom))!.id)
      : 0);

  // F2 يركّز حقل بحث السلة (اختصار الكاشير — ProductSearchBar يعرض الشارة ويترك التركيز للأب).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F2" || tab !== "new") return;
      e.preventDefault();
      document.querySelector<HTMLInputElement>('input[aria-label="بحث المنتجات"]')?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab]);

  // تبديل فرع المصدر يُفرغ السلة (الأرصدة تختلف بين الفروع ⇒ stockBase المخزَّن يصير كاذباً).
  function changeFrom(v: number | "") { setFromBranchId(v); setCart([]); }
  function swap() {
    const f = Number(effectiveFrom), t = Number(effectiveTo);
    setFromBranchId(t); setToBranchId(f); setCart([]);
  }

  const transfer = trpc.inventory.transferBatch.useMutation({
    onSuccess: async (res) => {
      setDone(`أُرسل السند ${res.transferNumber} (${res.lines} صنف) من ${fromName} إلى ${toName} — بالطريق حتى يستلمه الفرع الوجهة بالمطابقة.`);
      setError("");
      setCart([]); setNotes(""); setTrf(genTrf()); setReqId(crypto.randomUUID());
      await Promise.all([
        utils.catalog.forPurchase.invalidate(),
        utils.catalog.posList.invalidate(),
        utils.inventory.movements.invalidate(),
        utils.inventory.movementsRich?.invalidate?.(),
        utils.inventory.transfersList.invalidate(),
        utils.inventory.transfersPendingIncoming.invalidate(),
      ]);
    },
    onError: (e) => { setError(e.message); setDone(""); },
  });

  const fromName = branches.data?.find((b) => Number(b.id) === Number(effectiveFrom))?.name ?? "—";
  const toName = branches.data?.find((b) => Number(b.id) === Number(effectiveTo))?.name ?? "—";

  const aggregated = useMemo(() => aggregateByVariant(cart), [cart]);
  const lineStates = useMemo(() => computeLineStates(cart), [cart]);
  const totalBase = aggregated.reduce((a, x) => a + x.baseQuantity, 0);

  /** أول خطأ يمنع الإرسال (الرسالة تسمّي الصنف) — بالتجميع لا بالسطر (الرصيد مشترك بين الوحدات). */
  const blocking = useMemo(() => {
    const frac = cart.findIndex((_, i) => lineStates[i]?.fractional);
    if (frac >= 0) return `الصنف «${cart[frac].name}»: كمية غير صالحة (لا تُقبل كسور الوحدة الأساس).`;
    const over = aggregated.find((x) => x.baseQuantity > x.stockBase);
    if (over) return `الصنف «${over.name}»: الكمية المطلوبة ${fmtInt(over.baseQuantity)} تتجاوز المتاح في ${fromName} (${fmtInt(over.stockBase)}).`;
    return "";
  }, [cart, lineStates, aggregated, fromName]);

  const valid = cart.length > 0 && !blocking && !!effectiveFrom && !!effectiveTo && effectiveFrom !== effectiveTo;

  async function submit() {
    setError(""); setDone("");
    if (!effectiveFrom || !effectiveTo) return setError("اختر فرعَي المصدر والوجهة.");
    if (effectiveFrom === effectiveTo) return setError("لا يمكن التحويل لنفس الفرع.");
    if (cart.length === 0) return setError("أضِف صنفاً واحداً على الأقل للسند.");
    if (blocking) return setError(blocking);
    if (
      !(await confirm({
        variant: "danger",
        title: `سند تحويل ${trf}: من ${fromName} إلى ${toName}`,
        description: `إرسال السند (${fmtInt(aggregated.length)} صنف، ${fmtInt(totalBase)} وحدة أساس) يخصم من رصيد ${fromName} فوراً ويضع البضاعة «بالطريق» حتى يستلمها ${toName} بالمطابقة. متابعة؟`,
        confirmText: "إرسال السند",
      }))
    )
      return;
    transfer.mutate({
      fromBranchId: Number(effectiveFrom),
      toBranchId: Number(effectiveTo),
      reason: reason as (typeof REASONS)[number]["value"],
      notes: notes.trim() || undefined,
      clientRequestId: reqId,
      items: aggregated.map((x) => ({ variantId: x.variantId, baseQuantity: x.baseQuantity })),
    });
  }

  const branchOption = (b: { id: number | string; name: string; code?: string | null }) => (
    <option key={b.id} value={b.id}>{b.name}{b.code ? ` (${b.code})` : ""}</option>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="تحويل بين الفروع"
        description="بخطوتين: الإرسال يخصم المصدر ويضع البضاعة «بالطريق»، والفرع الوجهة يستلمها بمطابقة فعلية — العجز يُوثَّق على السند."
        actions={<Link href="/inventory" className="text-sm text-muted-foreground">حركات المخزون ←</Link>}
      />

      {/* تبويبا الشاشة: إنشاء سند | سجلّ السندات (مع شارة الوارد بالطريق) */}
      <div className="flex items-center gap-2 border-b">
        <button
          type="button"
          onClick={() => setTab("new")}
          className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px ${tab === "new" ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
        >
          <PackagePlus aria-hidden className="size-4" /> إنشاء تحويل
        </button>
        <button
          type="button"
          onClick={() => setTab("log")}
          className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px ${tab === "log" ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
        >
          <Inbox aria-hidden className="size-4" /> سجلّ التحويلات
          {(pending.data ?? 0) > 0 && (
            <span className="rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 text-xs px-2 py-0.5 tabular-nums">
              {fmtInt(pending.data ?? 0)} بانتظار الاستلام
            </span>
          )}
        </button>
      </div>

      {tab === "log" && <TransfersLog />}

      {tab === "new" && (
      <>
      {/* الفروع: من → إلى + عكس */}
      <Card>
        <CardHeader><CardTitle className="text-base">الفروع</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-3 items-end">
            <div className="space-y-1">
              <Label>من فرع *</Label>
              <select className={selectCls} value={effectiveFrom || ""} onChange={(e) => changeFrom(e.target.value ? Number(e.target.value) : "")}>
                <option value="">— اختر —</option>
                {(branches.data ?? []).map(branchOption)}
              </select>
            </div>
            <div className="flex justify-center pb-1">
              <Button type="button" variant="outline" size="icon" title="عكس الاتجاه" onClick={swap} className="rounded-full">
                <ArrowRightLeft aria-hidden className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-1">
              <Label>إلى فرع *</Label>
              <select className={selectCls} value={effectiveTo || ""} onChange={(e) => setToBranchId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">— اختر —</option>
                {(branches.data ?? []).filter((b) => Number(b.id) !== Number(effectiveFrom)).map(branchOption)}
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* رأس السند: رقم/سبب/مسؤول/ملاحظات */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center justify-between">
            <span>سند تحويل مخزني</span>
            <span className="text-xs font-mono text-muted-foreground" dir="ltr">{trf}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1">
            <Label htmlFor="trf-reason">سبب التحويل</Label>
            <select id="trf-reason" className={selectCls} value={reason} onChange={(e) => setReason(e.target.value)}>
              {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="trf-owner">المسؤول عن التحويل</Label>
            <Input id="trf-owner" value={me.data?.name ?? "—"} readOnly dir="rtl" className="bg-muted/40" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="trf-notes">ملاحظات</Label>
            <Input id="trf-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="اختياري" />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 items-start">
        {/* سلة الأصناف — جدول الفاتورة المتقدمة (بحث حيّ + ماسح + إضافة متعددة) */}
        <TransferCart
          lines={cart}
          setLines={setCart}
          branchId={Number(effectiveFrom)}
          bulkOpen={bulkOpen}
          setBulkOpen={setBulkOpen}
          onNotify={(msg, kind) => (kind === "error" ? notify.err(msg) : notify.ok(msg))}
        />

        {/* ملخّص التحويل (لاصق) */}
        <Card className="lg:sticky lg:top-4">
          <CardHeader className="pb-2"><CardTitle className="text-base">ملخّص التحويل</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">من</span><span className="font-medium">{fromName}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">إلى</span><span className="font-medium">{toName}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">أسطر السلة</span><span className="font-semibold tabular-nums" dir="ltr">{fmtInt(cart.length)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">أصناف السند</span><span className="font-semibold tabular-nums" dir="ltr">{fmtInt(aggregated.length)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">إجمالي الوحدات (أساس)</span><span className="font-semibold tabular-nums" dir="ltr">{fmtInt(totalBase)}</span></div>
            {cart.length > aggregated.length && (
              <p className="text-[11px] text-muted-foreground">وحدات متعددة لنفس الصنف تُدمَج في بندٍ واحد بالوحدة الأساس.</p>
            )}
            {blocking && <p className="text-sm text-destructive" role="alert">{blocking}</p>}
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            {done && <p className="text-sm text-money-positive">{done}</p>}
            <Button className="w-full" onClick={submit} disabled={transfer.isPending || !valid}>
              {transfer.isPending ? "جارٍ الإرسال…" : "إرسال السند (بالطريق)"}
            </Button>
            <Button variant="ghost" className="w-full" onClick={() => { setCart([]); setNotes(""); setError(""); setDone(""); }}>تفريغ السند</Button>
          </CardContent>
        </Card>
      </div>
      </>
      )}
    </div>
  );
}
