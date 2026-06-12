/**
 * StocktakeNew — معالج إنشاء جلسة جرد جديدة (/stocktakes/new).
 *
 * شريحة «الجرد والتسوية» (W3) — مرجع التصميم: jrd-wizard.jsx من حزمة التسليم.
 * ثلاث خطوات: (١) النطاق والفرع ← (٢) عمّال الجرد وتقسيم المناطق ← (٣) إعدادات التدقيق والتأكيد،
 * ثم شاشة «روابط العدّ ورموز الدخول» (PIN يظهر مرة واحدة + رابط /count/<code> + نسخ/واتساب).
 *
 * prefill: ?variants=1,2,3&name=… (من بطاقة الجرد الدوري/انحرافات reconcile) ⇒ نطاق MANUAL مُعبّأ.
 *
 * قرارات معتمدة (README §١٢): جرد أعمى مُثبَّت دائماً؛ الحدود الافتراضية 5٪ / 25,000 / 150,000 د.ع
 * (تعديلها للمدير+ فقط — الخادم يتجاهلها لغيره)؛ العدّ المكرر VERIFY افتراضياً؛ البيع لا يتوقف.
 *
 * مصادر البيانات:
 *  - الأصناف (FULL/MANUAL): trpc.inventory.onHand (يحترم عزل الفرع خادمياً).
 *  - المستخدمون (تكليف USER): trpc.stocktakes.assignableUsers — warehouseProcedure، قائمة منسدلة
 *    لكل الأدوار المخوّلة؛ الإدخال اليدوي لمعرّف الحساب يبقى بديلاً عند فشل التحميل.
 *  - الفئات (CATEGORY): trpc.catalog.categories — النطاق مفعَّل، والخادم يحلّ أصناف الفئات لحظة الإنشاء.
 *
 * التوزيع على التكليفات: MANUAL وحده يُرسل variantIds صريحة (كتل متساوية محلياً)؛
 * FULL/MOVING/CATEGORY لا يرسلون variantIds إطلاقاً — الخادم يوزّع غير المُسنَد كتلاً متساوية على كل التكليفات.
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { openWhatsApp } from "@/lib/whatsapp";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";

/* ───────────────────────── ثوابت ───────────────────────── */

type StScope = "FULL" | "MOVING" | "CATEGORY" | "MANUAL";
type Method = "PIN" | "USER";
type DupPolicy = "VERIFY" | "BLOCK";

const SCOPE_TYPE_LABEL: Record<StScope, string> = {
  FULL: "جرد شامل للفرع",
  MOVING: "الأصناف المتحركة",
  CATEGORY: "حسب الفئة",
  MANUAL: "أصناف مختارة",
};

/** تسمية دور الحساب في منتقي تكليف USER (مخرج assignableUsers: {id,name,role}). */
const USER_ROLE_LABEL: Record<string, string> = {
  admin: "مدير النظام",
  manager: "مدير فرع",
  warehouse: "أمين مخزن",
  cashier: "كاشير",
};

/** الحدود الافتراضية المعتمدة من المالك (README §١٢). */
const DEFAULT_THRESHOLD_PCT = "5";
const DEFAULT_THRESHOLD_VALUE = "25000";
const DEFAULT_DUAL_THRESHOLD = "150000";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const nf = (n: number | null | undefined) => Number(n ?? 0).toLocaleString("ar-IQ-u-nu-latn");

/** مبلغ صحيح/عشري حتى منزلتين — يُرسَل نصاً (عقد §٣: thresholds strings). */
const isMoneyStr = (s: string) => /^\d+(\.\d{1,2})?$/.test(s.trim());

const fmtMoneyLabel = (s: string) =>
  isMoneyStr(s) ? `${Number(s).toLocaleString("ar-IQ-u-nu-latn")} د.ع` : "—";

interface WorkerRow {
  key: string;
  name: string;
  method: Method;
  userId: string; // نصّ خام من المدخل — يُحوَّل عند الإرسال (ليس مالاً)
  zone: string;
}

/** مخرج create حسب العقد §٣. */
interface CreateResult {
  sessionId: number;
  code: string;
  itemCount: number;
  assignments: Array<{
    assignmentId: number;
    name: string;
    method: Method;
    zone: string | null;
    /** يظهر مرة واحدة فقط — لا يُخزَّن إلا hash في الخادم. */
    pin?: string;
    itemCount: number;
  }>;
}

/** يحوّل نصاً «id,id,…» إلى قائمة معرّفات فريدة صحيحة موجبة. */
function parseIds(csv: string): number[] {
  const ids = csv
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return Array.from(new Set(ids));
}

/**
 * قراءة prefill مرة واحدة من شريط العنوان: ?variants=1,2&name=…
 * أو — لقوائم كبيرة (تفادي URL عملاق) — ?prefillKey=<مفتاح> تشير لقائمة محفوظة في sessionStorage.
 * prefillKey له الأولوية إن وُجد.
 */
function readPrefill(): { variantIds: number[]; name: string } {
  try {
    const p = new URLSearchParams(window.location.search);
    const name = p.get("name") ?? "";
    const key = p.get("prefillKey");
    if (key) {
      const raw = sessionStorage.getItem(key);
      if (raw) {
        try {
          const arr = JSON.parse(raw);
          const ids = Array.isArray(arr)
            ? Array.from(new Set(arr.map((n: unknown) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)))
            : [];
          return { variantIds: ids, name };
        } catch {
          /* مفتاح تالف — نسقط إلى variants */
        }
      }
    }
    return { variantIds: parseIds(p.get("variants") ?? ""), name };
  } catch {
    return { variantIds: [], name: "" };
  }
}

/* ───────────────────────── الصفحة ───────────────────────── */

export default function StocktakeNew() {
  const [, navigate] = useLocation();
  const [prefill] = useState(readPrefill);

  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const isManagerPlus = role === "admin" || role === "manager";
  const isWarehouseOnly = role === "warehouse";

  const branchesQ = trpc.branches.list.useQuery();

  /* ─── حالة المعالج ─── */
  const [step, setStep] = useState(0);
  const [name, setName] = useState(prefill.name);
  const [branchId, setBranchId] = useState<number>(0);
  const [scopeType, setScopeType] = useState<StScope>(prefill.variantIds.length > 0 ? "MANUAL" : "FULL");
  const [movingDays, setMovingDays] = useState("30");
  const [manualIds, setManualIds] = useState<number[]>(prefill.variantIds);
  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [pickQ, setPickQ] = useState("");

  const [workers, setWorkers] = useState<WorkerRow[]>([
    { key: "w1", name: "", method: "PIN", userId: "", zone: "" },
  ]);

  const [thresholdPct, setThresholdPct] = useState(DEFAULT_THRESHOLD_PCT);
  const [thresholdValue, setThresholdValue] = useState(DEFAULT_THRESHOLD_VALUE);
  const [dualThreshold, setDualThreshold] = useState(DEFAULT_DUAL_THRESHOLD);
  const [directUnderThreshold, setDirectUnderThreshold] = useState(true);
  const [waNotify, setWaNotify] = useState(true);
  const [dupPolicy, setDupPolicy] = useState<DupPolicy>("VERIFY");
  const [notes, setNotes] = useState("");

  const [created, setCreated] = useState<CreateResult | null>(null);

  /* الفرع الافتراضي: فرع المستخدم ثم أول فرع. دور المخزن مُقيَّد بفرعه (الخادم يُجبره أيضاً). */
  const branches = branchesQ.data ?? [];
  const effectiveBranchId =
    branchId ||
    (isWarehouseOnly && me.data?.branchId ? Number(me.data.branchId) : 0) ||
    (me.data?.branchId ? Number(me.data.branchId) : 0) ||
    (branches[0]?.id ?? 0);
  const branchName = branches.find((b) => b.id === effectiveBranchId)?.name ?? "—";

  /* أصناف الفرع (للنطاق الشامل وعدّاده + منتقي MANUAL) — بحث محلي فوق حمولة واحدة. */
  const onHandQ = trpc.inventory.onHand.useQuery(
    { branchId: effectiveBranchId, limit: 1000 },
    { enabled: effectiveBranchId > 0 && (scopeType === "FULL" || scopeType === "MANUAL") }
  );
  const onHand = onHandQ.data ?? [];

  /* قائمة الفئات (لنطاق CATEGORY). */
  const categoriesQ = trpc.catalog.categories.useQuery(undefined, { enabled: scopeType === "CATEGORY" });
  const categoryOptions = categoriesQ.data ?? [];

  /* حسابات قابلة للتكليف (USER) — warehouseProcedure: متاحة لكل الأدوار المخوّلة. */
  const wantsUser = workers.some((w) => w.method === "USER");
  const usersQ = trpc.stocktakes.assignableUsers.useQuery(undefined, { enabled: wantsUser });
  const userOptions = usersQ.data ?? [];

  /* عدّاد أصناف النطاق: FULL من onHand، MANUAL من الاختيار، MOVING يُحدَّد عند الإنشاء. */
  const scopeCount: number | null =
    scopeType === "FULL"
      ? onHandQ.isLoading
        ? null
        : onHand.length
      : scopeType === "MANUAL"
        ? manualIds.length
        : null;

  /* قائمة المنتقي (MANUAL) مفلترة محلياً. */
  const pickList = useMemo(() => {
    const q = pickQ.trim().toLowerCase();
    const rows = !q
      ? onHand
      : onHand.filter(
          (r) =>
            (r.productName ?? "").toLowerCase().includes(q) ||
            (r.variantName ?? "").toLowerCase().includes(q) ||
            (r.sku ?? "").toLowerCase().includes(q)
        );
    return rows.slice(0, 200);
  }, [onHand, pickQ]);

  /* أصناف مختارة غير ظاهرة في قائمة الفرع الحالي (prefill من شاشة أخرى مثلاً). */
  const unknownSelected = useMemo(() => {
    const known = new Set(onHand.map((r) => Number(r.variantId)));
    return manualIds.filter((id) => !known.has(id));
  }, [onHand, manualIds]);

  /* توزيع الأصناف على العمّال — لنطاق MANUAL فقط: كتل متتالية بالتساوي (بترتيب الاختيار).
     FULL/MOVING/CATEGORY لا تُرسَل لهم variantIds إطلاقاً — الخادم يوزّع غير المُسنَد
     كتلاً متساوية على كل التكليفات لحظة الإنشاء. */
  const validWorkers = workers.filter((w) => w.name.trim() !== "");
  const distribution = useMemo<number[][] | null>(() => {
    if (scopeType !== "MANUAL") return null;
    const ids = manualIds;
    const n = Math.max(validWorkers.length, 1);
    const chunks: number[][] = Array.from({ length: n }, () => []);
    const size = Math.ceil(ids.length / n) || 1;
    ids.forEach((id, i) => {
      chunks[Math.min(Math.floor(i / size), n - 1)].push(id);
    });
    return chunks;
  }, [scopeType, manualIds, validWorkers.length]);

  /* ─── التحقق لكل خطوة ─── */
  const stepError = (): string | null => {
    if (step === 0) {
      if (!effectiveBranchId) return "اختر الفرع.";
      if (scopeType === "CATEGORY" && categoryIds.length === 0) return "اختر فئة واحدة على الأقل.";
      if (scopeType === "MANUAL" && manualIds.length === 0) return "اختر صنفاً واحداً على الأقل.";
      if (scopeType === "FULL" && !onHandQ.isLoading && onHand.length === 0)
        return "لا أصناف في هذا الفرع — لا يمكن بدء جرد شامل.";
      return null;
    }
    if (step === 1) {
      if (validWorkers.length === 0) return "أضف عاملاً واحداً على الأقل (بالاسم).";
      for (const w of validWorkers) {
        if (w.method === "USER") {
          const id = Number(w.userId);
          if (!Number.isInteger(id) || id <= 0)
            return `حدّد حساب المستخدم للعامل «${w.name.trim()}» (تكليف بحساب داخل النظام).`;
        }
      }
      return null;
    }
    if (isManagerPlus) {
      if (!isMoneyStr(thresholdPct)) return "حدّ النسبة غير صالح — رقم موجب حتى منزلتين.";
      if (!isMoneyStr(thresholdValue)) return "حدّ القيمة غير صالح — رقم موجب حتى منزلتين.";
      if (!isMoneyStr(dualThreshold)) return "حدّ الاعتماد المزدوج غير صالح — رقم موجب حتى منزلتين.";
    }
    return null;
  };
  const canNext = stepError() === null;

  /* ─── الإنشاء ─── */
  const utils = trpc.useUtils();
  const createMut = trpc.stocktakes.create.useMutation({
    onSuccess: (res) => {
      utils.stocktakes.list.invalidate();
      utils.stocktakes.stats.invalidate();
      setCreated(res as unknown as CreateResult);
      notify.ok(`أُنشئت جلسة الجرد ${(res as unknown as CreateResult).code}`);
    },
    onError: (e) => notify.err(e),
  });

  function handleCreate() {
    const err = stepError();
    if (err) {
      notify.warn(err);
      return;
    }
    const assignments = validWorkers.map((w, i) => ({
      name: w.name.trim(),
      method: w.method,
      userId: w.method === "USER" ? Number(w.userId) : undefined,
      zone: w.zone.trim() || undefined,
      // التوزيع الصريح لنطاق MANUAL فقط (distribution = null لغيره)؛
      // FULL/MOVING/CATEGORY: الخادم يوزّع غير المُسنَد كتلاً متساوية على كل التكليفات.
      variantIds:
        distribution && validWorkers.length > 1 && (distribution[i]?.length ?? 0) > 0
          ? distribution[i]
          : undefined,
    }));

    createMut.mutate({
      name: name.trim() || `${SCOPE_TYPE_LABEL[scopeType]} — ${branchName}`,
      branchId: effectiveBranchId,
      scopeType,
      movingDays: scopeType === "MOVING" ? Number(movingDays) : undefined,
      categoryIds: scopeType === "CATEGORY" ? categoryIds : undefined,
      variantIds: scopeType === "MANUAL" ? manualIds : undefined,
      blind: true, // مُثبَّت — قرار معتمد (README §١٢)
      // الحدود تُرسَل للمدير+ فقط؛ الخادم يتجاهلها لغيره ويطبّق الافتراضيات (عقد §٣).
      ...(isManagerPlus
        ? {
            thresholdPct: thresholdPct.trim(),
            thresholdValue: thresholdValue.trim(),
            dualThreshold: dualThreshold.trim(),
          }
        : {}),
      directUnderThreshold,
      waNotify,
      dupPolicy,
      notes: notes.trim() || undefined,
      assignments,
    });
  }

  /* ─── شاشة النجاح: الروابط ورموز الدخول ─── */
  if (created) {
    return <CreatedLinksScreen created={created} sessionName={name.trim() || `${SCOPE_TYPE_LABEL[scopeType]} — ${branchName}`} />;
  }

  const steps = ["النطاق والفرع", "عمّال الجرد وتقسيم المناطق", "إعدادات التدقيق والتأكيد"];

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {/* شريط الرجوع */}
      <div className="flex items-center gap-2 text-sm">
        <Link href="/stocktakes" className="font-semibold text-primary hover:underline">
          → جلسات الجرد
        </Link>
        <span className="text-border">/</span>
        <span className="text-muted-foreground">جلسة جرد جديدة</span>
      </div>
      <h1 className="text-2xl font-bold">جلسة جرد جديدة</h1>

      {/* مؤشر الخطوات */}
      <div className="flex items-center gap-2">
        {steps.map((s, i) => (
          <span key={s} className={`flex items-center gap-2 ${i > 0 ? "flex-1" : ""}`}>
            {i > 0 && <span className={`h-px flex-1 ${i <= step ? "bg-primary" : "bg-border"}`} />}
            <span className="flex items-center gap-2">
              <span
                className={`grid size-7 place-items-center rounded-full text-xs font-bold ${
                  i < step
                    ? "bg-emerald-500 text-white"
                    : i === step
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                }`}
              >
                {i < step ? "✓" : nf(i + 1)}
              </span>
              <span className={`text-sm font-semibold ${i === step ? "" : "text-muted-foreground"}`}>{s}</span>
            </span>
          </span>
        ))}
      </div>

      {/* ───── الخطوة ١: النطاق ───── */}
      {step === 0 && (
        <Card>
          <CardContent className="space-y-5 p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>اسم الجلسة (اختياري)</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: الجرد النصف سنوي" />
              </div>
              <div className="space-y-1.5">
                <Label>الفرع</Label>
                <select
                  className={selectCls}
                  value={effectiveBranchId}
                  disabled={isWarehouseOnly}
                  onChange={(e) => {
                    setBranchId(Number(e.target.value));
                  }}
                >
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                {isWarehouseOnly && (
                  <p className="text-[11px] text-muted-foreground">دور المخزن مُقيَّد بفرعه — يُطبَّق خادمياً.</p>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>نطاق الجرد</Label>
              <p className="text-xs text-muted-foreground">يُلتقط الرصيد الدفتري لحظة بدء الجلسة كأساس للمقارنة.</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {(
                  [
                    ["FULL", "جرد شامل للفرع", "كل أصناف الفرع — مناسب للجرد الدوري الكبير", false],
                    ["MOVING", "الأصناف المتحركة فقط", "ما عليه حركة بيع/شراء خلال فترة — أسرع وأعلى أثراً", false],
                    ["CATEGORY", "حسب الفئة / القسم", "فئات محددة مثل الورق أو الأحبار — يحلّ الخادم أصنافها لحظة الإنشاء", false],
                    ["MANUAL", "أصناف مختارة يدوياً", "قائمة تُنتقى صنفاً صنفاً", false],
                  ] as Array<[StScope, string, string, boolean]>
                ).map(([key, label, desc, disabled]) => (
                  <button
                    key={key}
                    type="button"
                    disabled={disabled}
                    title={disabled ? "يُفعَّل فور توفّر قائمة الفئات — استعمل «أصناف مختارة يدوياً»" : ""}
                    onClick={() => setScopeType(key)}
                    className={`rounded-lg border p-3 text-right transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      scopeType === key
                        ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                        : "border-border hover:bg-muted/50"
                    }`}
                  >
                    <p className="text-sm font-bold">{label}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
                  </button>
                ))}
              </div>
            </div>

            {scopeType === "MOVING" && (
              <div className="space-y-1.5">
                <Label>فترة الحركة</Label>
                <select
                  className={`${selectCls} max-w-xs`}
                  value={movingDays}
                  onChange={(e) => setMovingDays(e.target.value)}
                >
                  <option value="7">آخر 7 أيام</option>
                  <option value="30">آخر 30 يوماً</option>
                  <option value="90">آخر 90 يوماً</option>
                </select>
              </div>
            )}

            {scopeType === "CATEGORY" && (
              <div className="space-y-1.5">
                <Label>الفئات المشمولة</Label>
                {categoriesQ.isLoading ? (
                  <p className="text-xs text-muted-foreground">جارٍ تحميل الفئات…</p>
                ) : categoryOptions.length === 0 ? (
                  <p className="text-xs text-amber-700">لا فئات معرّفة في النظام — استعمل «أصناف مختارة يدوياً».</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {categoryOptions.map((c) => {
                      const id = Number(c.id);
                      const on = categoryIds.includes(id);
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() =>
                            setCategoryIds((prev) => (on ? prev.filter((x) => x !== id) : [...prev, id]))
                          }
                          className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                            on
                              ? "border-primary bg-primary/10 font-semibold text-primary"
                              : "border-border hover:bg-muted/50"
                          }`}
                        >
                          {on ? "✓ " : ""}
                          {c.name}
                        </button>
                      );
                    })}
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground">
                  أصناف الفئات تُحلّ خادمياً لحظة الإنشاء (اللقطة الدفترية) وتُوزَّع كتلاً متساوية على كل العمّال.
                </p>
              </div>
            )}

            {scopeType === "MANUAL" && (
              <div className="space-y-1.5">
                <Label>اختيار الأصناف</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={pickQ}
                    onChange={(e) => setPickQ(e.target.value)}
                    placeholder="بحث بالاسم أو SKU…"
                    className="max-w-sm"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pickList.length === 0}
                    onClick={() =>
                      setManualIds((prev) => Array.from(new Set([...prev, ...pickList.map((r) => Number(r.variantId))])))
                    }
                  >
                    تحديد المعروض ({nf(pickList.length)})
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={manualIds.length === 0}
                    onClick={() => setManualIds([])}
                  >
                    مسح التحديد
                  </Button>
                </div>
                <div className="max-h-56 overflow-auto rounded-lg border">
                  {onHandQ.isLoading && (
                    <p className="p-4 text-center text-sm text-muted-foreground">جارٍ تحميل أصناف الفرع…</p>
                  )}
                  {pickList.map((r) => {
                    const vid = Number(r.variantId);
                    const on = manualIds.includes(vid);
                    return (
                      <label
                        key={vid}
                        className="flex cursor-pointer items-center gap-2.5 border-b px-3 py-2 text-sm last:border-0 hover:bg-muted/50"
                      >
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={on}
                          onChange={() =>
                            setManualIds(on ? manualIds.filter((x) => x !== vid) : [...manualIds, vid])
                          }
                        />
                        <span className="font-semibold">{r.productName}</span>
                        <span className="text-xs text-muted-foreground">
                          {[r.variantName, r.color, r.size].filter(Boolean).join(" / ")}
                        </span>
                        <span className="mr-auto font-mono text-xs text-muted-foreground" dir="ltr">
                          {r.sku}
                        </span>
                      </label>
                    );
                  })}
                  {!onHandQ.isLoading && pickList.length === 0 && (
                    <p className="p-4 text-center text-sm text-muted-foreground">لا أصناف مطابقة للبحث.</p>
                  )}
                </div>
                {unknownSelected.length > 0 && (
                  <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    {nf(unknownSelected.length)} من الأصناف المختارة (إحالة مسبقة) غير ظاهرة في قائمة هذا الفرع —
                    تبقى ضمن النطاق ويتحقق الخادم منها عند الإنشاء.
                  </p>
                )}
              </div>
            )}

            <div className="flex items-center justify-between rounded-lg bg-muted/60 px-4 py-2.5 text-sm">
              <span className="font-semibold">أصناف ضمن النطاق:</span>
              {scopeCount == null ? (
                <span className="inline-block rounded-full border bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
                  {scopeType === "MOVING" ? "تُحدَّد عند الإنشاء حسب الحركة الفعلية" : "جارٍ الحساب…"}
                </span>
              ) : (
                <span
                  className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
                    scopeCount > 0
                      ? "bg-blue-50 text-blue-700 border-blue-200"
                      : "bg-rose-50 text-rose-700 border-rose-200"
                  }`}
                >
                  {nf(scopeCount)} صنفاً
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ───── الخطوة ٢: العمّال والمناطق ───── */}
      {step === 1 && (
        <Card>
          <CardContent className="space-y-4 p-5">
            <p className="text-sm text-muted-foreground">
              قسّم النطاق بين العمّال — نطاقات «شامل / متحركة / فئة» يوزّعها الخادم كتلاً متساوية على كل
              العمّال لحظة الإنشاء، و«أصناف مختارة» تُوزَّع هنا بالتساوي حسب ترتيب الاختيار. عامل «الرابط
              الخارجي» يدخل برمز PIN دون حساب — مناسب للعمّال الموسميين.
            </p>
            {workers.map((w, idx) => {
              const dist = distribution?.[validWorkers.findIndex((v) => v.key === w.key)] ?? null;
              return (
                <div key={w.key} className="space-y-3 rounded-lg border p-4">
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="space-y-1.5">
                      <Label>العامل {nf(idx + 1)}</Label>
                      <Input
                        value={w.name}
                        placeholder="اسم عامل الجرد"
                        className="w-56"
                        onChange={(e) =>
                          setWorkers(workers.map((x) => (x.key === w.key ? { ...x, name: e.target.value } : x)))
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>طريقة الدخول</Label>
                      <select
                        className={`${selectCls} w-64`}
                        value={w.method}
                        onChange={(e) =>
                          setWorkers(
                            workers.map((x) =>
                              x.key === w.key ? { ...x, method: e.target.value as Method, userId: "" } : x
                            )
                          )
                        }
                      >
                        <option value="PIN">رابط خارجي + رمز PIN (بلا حساب)</option>
                        <option value="USER">حساب مستخدم داخل النظام</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>المنطقة (وصف مكاني)</Label>
                      <Input
                        value={w.zone}
                        placeholder="مثال: الرفوف الأمامية"
                        className="w-48"
                        onChange={(e) =>
                          setWorkers(workers.map((x) => (x.key === w.key ? { ...x, zone: e.target.value } : x)))
                        }
                      />
                    </div>
                    <div className="mr-auto flex items-center gap-2 pb-1">
                      <span className="inline-block rounded-full border bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700 border-blue-200">
                        {w.name.trim() === ""
                          ? "—"
                          : dist
                            ? `${nf(dist.length)} صنفاً`
                            : "يُوزَّع بالتساوي عند الإنشاء"}
                      </span>
                      {workers.length > 1 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setWorkers(workers.filter((x) => x.key !== w.key))}
                        >
                          حذف
                        </Button>
                      )}
                    </div>
                  </div>

                  {w.method === "USER" && (
                    <div className="space-y-1.5">
                      <Label>حساب المستخدم</Label>
                      <select
                        className={`${selectCls} max-w-sm`}
                        value={w.userId}
                        onChange={(e) =>
                          setWorkers(workers.map((x) => (x.key === w.key ? { ...x, userId: e.target.value } : x)))
                        }
                      >
                        <option value="">— اختر حساباً —</option>
                        {userOptions.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name} ({USER_ROLE_LABEL[u.role] ?? u.role})
                          </option>
                        ))}
                      </select>
                      {usersQ.isLoading ? (
                        <p className="text-[11px] text-muted-foreground">جارٍ تحميل الحسابات…</p>
                      ) : usersQ.isError ? (
                        <p className="text-[11px] text-amber-700">
                          تعذّر تحميل قائمة الحسابات — أعد المحاولة، أو استعمل رابط PIN الخارجي بدل الحساب.
                        </p>
                      ) : null}
                    </div>
                  )}
                </div>
              );
            })}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setWorkers([
                  ...workers,
                  { key: `w${workers.length + 1}-${Date.now()}`, name: "", method: "PIN", userId: "", zone: "" },
                ])
              }
            >
              + إضافة عامل
            </Button>
            {scopeType !== "MANUAL" && validWorkers.length > 1 && (
              <p className="rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-800">
                نطاق «{SCOPE_TYPE_LABEL[scopeType]}» يحلّه الخادم لحظة الإنشاء ويوزّعه كتلاً متساوية على كل
                العمّال تلقائياً.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ───── الخطوة ٣: الإعدادات والتأكيد ───── */}
      {step === 2 && (
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-5 p-5">
              {/* جرد أعمى — مُثبَّت دائماً (قرار معتمد) */}
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-bold">
                    جرد أعمى (موصى به){" "}
                    <span className="mr-1 inline-block rounded-full border bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                      مُثبَّت دائماً
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    يُخفي الرصيد الدفتري عن عامل الجرد — يكشف الفروقات الحقيقية ويمنع نسخ الرقم الدفتري.
                  </p>
                </div>
                <Switch checked disabled aria-label="جرد أعمى" />
              </div>

              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-bold">تسوية مباشرة للفروقات ضمن الحدّ</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    الفروقات الصغيرة تُعلَّم للاعتماد تلقائياً، وما يتجاوز الحدّ يستوجب قرار مشرف صراحةً.
                  </p>
                </div>
                <Switch checked={directUnderThreshold} onCheckedChange={setDirectUnderThreshold} />
              </div>

              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-bold">إشعارات واتساب</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    للمسؤول عند تسليم العدّ واكتمال الجلسة، وللعامل عند طلب إعادة العدّ — عبر أزرار wa.me.
                  </p>
                </div>
                <Switch checked={waNotify} onCheckedChange={setWaNotify} />
              </div>

              {/* الحدود الثلاثة — تظهر وتُعدَّل للمدير+ فقط */}
              {isManagerPlus ? (
                <>
                  <div className={`grid gap-4 sm:grid-cols-2 ${!directUnderThreshold ? "pointer-events-none opacity-40" : ""}`}>
                    <div className="space-y-1.5">
                      <Label>حدّ النسبة</Label>
                      <div className="flex items-center gap-2">
                        <Input
                          value={thresholdPct}
                          onChange={(e) => setThresholdPct(e.target.value)}
                          className="w-24 text-center"
                          dir="ltr"
                          inputMode="decimal"
                        />
                        <span className="text-sm text-muted-foreground">٪</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        فرق أعلى من هذه النسبة من الرصيد الدفتري = يتجاوز الحدّ
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label>حدّ القيمة</Label>
                      <div className="flex items-center gap-2">
                        <Input
                          value={thresholdValue}
                          onChange={(e) => setThresholdValue(e.target.value)}
                          className="w-32 text-center"
                          dir="ltr"
                          inputMode="decimal"
                        />
                        <span className="text-sm text-muted-foreground">د.ع</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        فرق قيمته بالتكلفة أعلى من هذا المبلغ = يتجاوز الحدّ
                      </p>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>حدّ الاعتماد المزدوج (توقيعان)</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        value={dualThreshold}
                        onChange={(e) => setDualThreshold(e.target.value)}
                        className="w-36 text-center"
                        dir="ltr"
                        inputMode="decimal"
                      />
                      <span className="text-sm text-muted-foreground">د.ع</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      فرق تتجاوز قيمته هذا المبلغ يستوجب توقيع مسؤولَين مختلفَين قبل التنفيذ — حماية للجميع
                    </p>
                  </div>
                </>
              ) : (
                <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  تعديل الحدود صلاحية مشرف فأعلى — تُطبَّق القيم الافتراضية المعتمدة (5٪ أو 25,000 د.ع للتسوية
                  المباشرة، و150,000 د.ع للتوقيعين).
                </p>
              )}

              {/* سياسة العدّ المكرر */}
              <div className="space-y-1.5">
                <Label>العدّ المكرر — صنف عدّه زميل سابقاً</Label>
                <p className="text-xs text-muted-foreground">
                  العدّ التحقّقي لا يستبدل عدّ الزميل: إن تطابقا زادت الموثوقية، وإن اختلفا يُرفع تعارض يفصل فيه
                  المسؤول
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(
                    [
                      [
                        "VERIFY",
                        "سماح كعدّ تحقّقي (موصى به)",
                        "يُسجّل عدّاً ثانياً مستقلاً ويُقارن آلياً — التعارض يُرفع للمراجعة",
                      ],
                      ["BLOCK", "منع تام", "الصنف المعدود يُقفل على بقية العمّال نهائياً"],
                    ] as Array<[DupPolicy, string, string]>
                  ).map(([key, label, desc]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setDupPolicy(key)}
                      className={`rounded-lg border p-3 text-right transition-colors ${
                        dupPolicy === key
                          ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                          : "border-border hover:bg-muted/50"
                      }`}
                    >
                      <p className="text-sm font-bold">{label}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>ملاحظات (اختياري)</Label>
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="ملاحظة تُحفظ مع الجلسة" />
              </div>

              <div className="rounded-lg border bg-muted/40 p-3.5 text-sm">
                <p className="font-bold">الحركة أثناء الجرد: البيع مستمر، بلا إيقاف.</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  أيّ بيع/شراء يقع بعد عدّ الصنف يُرصَد ويُصحَّح آلياً في شاشة المراجعة مع تنبيه واضح — لا توقف
                  للعمل ولا فروقات زائفة.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* ملخّص قبل الإنشاء */}
          <Card>
            <CardHeader>
              <p className="text-sm font-bold">ملخّص الجلسة قبل الإنشاء</p>
            </CardHeader>
            <CardContent className="pt-0">
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                <SummaryRow k="الفرع" v={branchName} />
                <SummaryRow
                  k="النطاق"
                  v={
                    scopeType === "MOVING"
                      ? `${SCOPE_TYPE_LABEL.MOVING} — آخر ${nf(Number(movingDays))} يوماً`
                      : scopeCount == null
                        ? SCOPE_TYPE_LABEL[scopeType]
                        : `${SCOPE_TYPE_LABEL[scopeType]} — ${nf(scopeCount)} صنفاً`
                  }
                />
                <SummaryRow k="عمّال الجرد" v={validWorkers.map((w) => w.name.trim()).join("، ") || "—"} />
                <SummaryRow k="الجرد الأعمى" v="مُفعَّل (مُثبَّت)" />
                <SummaryRow
                  k="الاعتماد المباشر"
                  v={
                    directUnderThreshold
                      ? isManagerPlus
                        ? `ضمن ${nf(Number(thresholdPct))}٪ أو ${fmtMoneyLabel(thresholdValue)}`
                        : "ضمن الحدود الافتراضية"
                      : "مراجعة إلزامية للكل"
                  }
                />
                <SummaryRow k="توقيعان فوق" v={isManagerPlus ? fmtMoneyLabel(dualThreshold) : "الحدّ الافتراضي (150,000 د.ع)"} />
                <SummaryRow k="العدّ المكرر" v={dupPolicy === "VERIFY" ? "عدّ تحقّقي" : "منع تام"} />
                <SummaryRow k="إشعارات واتساب" v={waNotify ? "مُفعَّلة" : "متوقفة"} />
              </dl>
            </CardContent>
          </Card>
        </div>
      )}

      {/* أزرار التنقّل */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={() => (step === 0 ? navigate("/stocktakes") : setStep(step - 1))}>
          {step === 0 ? "إلغاء" : "→ السابق"}
        </Button>
        {step < 2 ? (
          <Button
            disabled={!canNext}
            title={stepError() ?? ""}
            onClick={() => {
              const err = stepError();
              if (err) {
                notify.warn(err);
                return;
              }
              setStep(step + 1);
            }}
          >
            التالي ←
          </Button>
        ) : (
          <Button size="lg" disabled={!canNext || createMut.isPending} onClick={handleCreate}>
            {createMut.isPending ? "جارٍ الإنشاء…" : "إنشاء الجلسة وبدء العدّ"}
          </Button>
        )}
      </div>
    </div>
  );
}

/* ───────────── شاشة النجاح: الروابط ورموز الدخول ───────────── */

function CreatedLinksScreen({ created, sessionName }: { created: CreateResult; sessionName: string }) {
  const countLink = `${window.location.origin}/count/${created.code}`;

  async function copyText(text: string, okMsg: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify.ok(okMsg);
    } catch {
      notify.warn("تعذّر النسخ التلقائي — انسخ النص يدوياً.");
    }
  }

  function waMessage(a: CreateResult["assignments"][number]): string {
    const lines = [
      `🧮 *جلسة جرد — ${sessionName}*`,
      `العامل: ${a.name}`,
      `المنطقة: ${a.zone || "كامل النطاق"} · ${nf(a.itemCount)} صنفاً`,
      "",
      "رابط العدّ:",
      countLink,
      a.pin ? `رمز الدخول PIN: ${a.pin}` : "ادخل بحسابك في النظام — ستظهر لك مهمة العدّ.",
      "",
      "يُدخَل العدد الفعلي المعدود فقط — دون النظر لأي رقم دفتري.",
    ];
    return lines.join("\n");
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card>
        <CardContent className="p-8 text-center">
          <div className="mx-auto grid size-14 place-items-center rounded-full bg-emerald-100 text-2xl">✓</div>
          <h1 className="mt-3 text-xl font-bold">
            أُنشئت الجلسة <span className="font-mono" dir="ltr">{created.code}</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            شارك روابط العدّ مع العمّال — كلٌّ يرى أصناف منطقته فقط، دون الرصيد الدفتري.
            النطاق: {nf(created.itemCount)} صنفاً.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <p className="text-base font-semibold">روابط العدّ ورموز الدخول</p>
          <p className="text-xs text-amber-800">
            ⚠ رموز PIN تظهر هنا مرة واحدة فقط — انسخها الآن. يمكن إعادة توليد رمز عامل من شاشة المتابعة.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">
            {created.assignments.map((a) => (
              <div key={a.assignmentId} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <p className="font-bold">{a.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {a.zone || "كامل النطاق"} · {nf(a.itemCount)} صنفاً
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="max-w-[260px] truncate rounded-md border border-dashed bg-muted px-2.5 py-1.5 font-mono text-xs"
                    dir="ltr"
                    title={countLink}
                  >
                    {countLink}
                  </span>
                  {a.method === "PIN" && a.pin ? (
                    <span className="rounded-md bg-primary/10 px-2.5 py-1.5 font-mono text-sm font-bold text-primary" dir="ltr">
                      PIN {a.pin}
                    </span>
                  ) : (
                    <span className="inline-block rounded-full border bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
                      يدخل بحسابه — تظهر له مهمة العدّ
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      copyText(
                        a.pin ? `${countLink}\nرمز الدخول PIN: ${a.pin}` : countLink,
                        `نُسخ رابط العدّ${a.pin ? " ورمز PIN" : ""} للعامل ${a.name}`
                      )
                    }
                  >
                    نسخ
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-emerald-700"
                    onClick={() => openWhatsApp(null, waMessage(a))}
                  >
                    واتساب
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap justify-center gap-2">
        <Button asChild variant="outline">
          <Link href="/stocktakes">العودة للقائمة</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href={`/stocktakes/${created.sessionId}/sheets`}>🖨 قوائم عدّ ورقية</Link>
        </Button>
        <Button asChild>
          <Link href={`/stocktakes/${created.sessionId}`}>متابعة العدّ الحيّ</Link>
        </Button>
      </div>
    </div>
  );
}

function SummaryRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-dashed pb-1.5">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="font-semibold">{v}</dd>
    </div>
  );
}
