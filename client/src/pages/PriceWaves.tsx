// PriceWaves.tsx (٧/٧/٢٦، أُعيد بناؤها ٢٠/٨/٢٦): موجات تحديث الأسعار — عمليةٌ متسلسلة بأربع خطوات.
// RBAC: مدير+ فقط (productsManagerProcedure على الخادم يفرض).
//
// **القاعدة الحاكمة للشاشة: لا يُتخذ قرارٌ على مجموعةٍ غير مرئية.**
// كانت الشاشة بطاقةً واحدة فيها ستّة حقول وزرّ «معاينة»: تكتب في البحث فلا يحدث شيء، وتضغط
// «معاينة» فتظهر آلاف الصفوف بلا أن تعرف أيّ فلترٍ سرى فعلاً. والأسوأ أنّ الخادم كان **يُسقط**
// مصطلح البحث بصمتٍ إن قلّ عن حرفين ⇒ المعاينة تُرجع الكتالوج كلّه والمدير يظنّ أنه صفّى.
//
// الخطوات الأربع تفصل أسئلةً كانت مختلطة:
//   ١ النطاق   — **من** يتأثّر؟ (عدّادٌ حيّ يتحرّك مع كل حرف: «١٢٤ منتجاً · ٣١٨ سعراً»)
//   ٢ القاعدة  — **ماذا** يحدث؟ (مثالٌ حيّ من صنفٍ حقيقيّ في نطاقك، محسوبٌ بنفس دالّة الخادم)
//   ٣ المعاينة — **هل هذا ما تريد؟** (هامش قبل/بعد، استثناءٌ سطريّ، والساقطون بأسبابهم)
//   ٤ التطبيق  — **التزام** (اسم وسبب، وكتابةُ عدد الصفوف بيدك، وبصمةٌ تمنع تطبيق غير ما رأيت)
import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FileSignature,
  Info,
  Play,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";
import {
  DEFAULT_PRICE_ROUND_DENOM,
  PRICE_CHANGE_LABELS,
  PRICE_ROUND_DENOMS,
  PRICE_WAVE_SCOPE_LABELS,
  applyPriceWaveRule,
  isPercentChange,
  marginPct,
  priceRoundDenomLabel,
  type PriceChangeType,
  type PriceWaveScope,
} from "@shared/priceWaveRule";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Field } from "@/components/product/variantBits";
import { PageHeader } from "@/components/PageHeader";
import { Stepper } from "@/components/Stepper";
import {
  PreviewTable,
  SkippedPanel,
  StatTile,
  rowKey,
  type PreviewRow,
  type SkippedRow,
} from "@/components/priceWave/PreviewTable";
import { WaveHistory } from "@/components/priceWave/WaveHistory";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { confirm } from "@/lib/confirm";
import { categoryOptionElements } from "@/lib/categoryTree";
import { priceTierLabel } from "@/lib/labels";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

type Tier = "RETAIL" | "WHOLESALE" | "GOVERNMENT" | "";

const STEPS = ["النطاق", "قاعدة التغيير", "المعاينة", "التطبيق"];
const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

interface PreviewResult {
  rows: PreviewRow[];
  skipped: SkippedRow[];
  fingerprint: string;
  totalRows: number;
  belowCostCount: number;
  roundedCount: number;
  contractCoveredRows: number;
  contractCustomers: number;
  productCount: number;
}

export default function PriceWaves() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const categoriesQ = trpc.catalog.categories.useQuery();

  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  // ── ١) النطاق ──
  const [scope, setScope] = useState<PriceWaveScope>("FILTERED");
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [productSearch, setProductSearch] = useState("");
  const [priceTier, setPriceTier] = useState<Tier>("");
  const [productIds, setProductIds] = useState<number[]>([]);
  const [pickedNames, setPickedNames] = useState<Record<number, string>>({});
  const [pickQuery, setPickQuery] = useState("");

  // ── ٢) القاعدة ──
  const [changeType, setChangeType] =
    useState<PriceChangeType>("INCREASE_PERCENT");
  const [changeValue, setChangeValue] = useState("5");
  const [roundToDenom, setRoundToDenom] = useState<number>(
    DEFAULT_PRICE_ROUND_DENOM,
  );

  // ── ٣) المعاينة ──
  const [previewed, setPreviewed] = useState<PreviewResult | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [showSkipped, setShowSkipped] = useState(false);

  // ── ٤) الالتزام ──
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [reason, setReason] = useState("");
  const [allowBelowCost, setAllowBelowCost] = useState(false);

  const debouncedSearch = useDebouncedValue(productSearch, 220);

  const filters = useMemo(
    () => ({
      scope,
      categoryId:
        scope === "FILTERED" && categoryId !== "" ? Number(categoryId) : null,
      productSearch:
        scope === "FILTERED" ? debouncedSearch.trim() || null : null,
      priceTier: (priceTier || null) as Exclude<Tier, ""> | null,
      productIds: scope === "SELECTED" && productIds.length ? productIds : null,
    }),
    [scope, categoryId, debouncedSearch, priceTier, productIds],
  );

  /** مرآةُ حارس النطاق الخادميّ (W6) — تمنع نداءً محكوماً عليه بالرفض، وتشرح السبب قبله. */
  const scopeError: string | null = useMemo(() => {
    if (
      scope === "FILTERED" &&
      !filters.categoryId &&
      !filters.productSearch &&
      !filters.priceTier
    ) {
      return "لم تحدّد أيّ فلتر. اختر «كل الكتالوج» صراحةً إن كنت تقصد إعادة تسعير الكتالوج كلّه.";
    }
    if (scope === "SELECTED" && !productIds.length)
      return "اختر منتجاً واحداً على الأقل.";
    return null;
  }, [scope, filters, productIds.length]);

  const scopeQ = trpc.priceWaves.scopeCount.useQuery(
    { filters },
    {
      enabled: scopeError == null,
      placeholderData: keepPreviousData,
      staleTime: 5_000,
    },
  );

  // ── منتقي المنتجات (وضع SELECTED) ──
  const branchesQ = trpc.branches.list.useQuery(undefined, {
    enabled: scope === "SELECTED",
  });
  const branchId =
    me.data?.branchId != null
      ? Number(me.data.branchId)
      : branchesQ.data?.length
        ? Number(branchesQ.data[0].id)
        : null;
  const debouncedPick = useDebouncedValue(pickQuery, 220);
  const pickQ = trpc.catalog.adminList.useQuery(
    { branchId: branchId ?? 0, q: debouncedPick.trim(), limit: 20 },
    {
      enabled:
        scope === "SELECTED" &&
        branchId != null &&
        debouncedPick.trim().length > 0,
      placeholderData: keepPreviousData,
    },
  );

  const previewM = trpc.priceWaves.preview.useMutation({
    onSuccess: (data) => {
      setPreviewed(data as PreviewResult);
      setExcluded(new Set());
      setShowSkipped(false);
      setError("");
      setStep(2);
    },
    onError: (e) => setError(e.message),
  });

  const applyM = trpc.priceWaves.applyWave.useMutation({
    onSuccess: async (res) => {
      await utils.priceWaves.list.invalidate();
      await utils.priceWaves.scopeCount.invalidate();
      // الموجة غيّرت أسعاراً ⇒ كلّ قراءةٍ للكتالوج صارت قديمة. بلا هذا يظلّ `catalog.byUnitIds`
      // مخزَّناً (staleTime عامّ) فيطبع جسرُ الملصقات **الأسعار السابقة** — أي الملصق الكاذب
      // الذي وُجد الجسر أصلاً ليستبدله.
      await utils.catalog.invalidate();
      setInfo(
        `طُبِّقت الموجة «${name.trim()}» على ${res.totalRows} صفّاً` +
          (res.excludedRows ? ` (استُثني ${res.excludedRows})` : "") +
          `. يمكنك التراجع عنها من التاريخ أدناه، وطباعة ملصقات الأصناف المتأثّرة من تفاصيلها.`,
      );
      resetWizard();
    },
    onError: (e) => setError(e.message),
  });

  function resetWizard() {
    setPreviewed(null);
    setExcluded(new Set());
    setName("");
    setDescription("");
    setReason("");
    setAllowBelowCost(false);
    setStep(0);
  }

  // أيّ تعديلٍ على النطاق أو القاعدة يُبطل معاينةً قائمة — لا يبقى جدولٌ يصف حالةً لم تعد قائمة.
  useEffect(() => {
    setPreviewed(null);
    setExcluded(new Set());
  }, [
    scope,
    categoryId,
    debouncedSearch,
    priceTier,
    productIds,
    changeType,
    changeValue,
    roundToDenom,
  ]);

  const percentMode = isPercentChange(changeType);

  /** تحقّق الخطوة الحالية — زرّ «التالي» يُعطَّل ويشرح السبب في `title` (نمط StocktakeNew). */
  function stepError(): string | null {
    if (step === 0) {
      if (scopeError) return scopeError;
      if (scopeQ.isLoading) return "جارٍ حساب النطاق…";
      if ((scopeQ.data?.priceRows ?? 0) === 0)
        return "لا أسعار ضمن هذا النطاق — عدّل الفلاتر.";
      return null;
    }
    if (step === 1) {
      const v = Number(changeValue);
      if (!Number.isFinite(v) || v <= 0)
        return "قيمة التغيير يجب أن تكون أكبر من صفر.";
      if (percentMode && v > 1000) return "النسبة تتجاوز الحدّ الأقصى (1000٪).";
      if (changeType === "DECREASE_PERCENT" && v >= 100)
        return "تخفيضٌ 100٪ أو أكثر يُفرّغ السعر.";
      return null;
    }
    if (step === 2) {
      if (!previewed) return "عاين أوّلاً.";
      if (activeRows.length === 0)
        return "استثنيتَ كل الصفوف — أعِد صفّاً واحداً على الأقل.";
      return null;
    }
    return null;
  }

  const activeRows = useMemo(
    () =>
      previewed ? previewed.rows.filter((r) => !excluded.has(rowKey(r))) : [],
    [previewed, excluded],
  );
  const activeBelowCost = activeRows.filter((r) => r.belowCost).length;
  // التغطية التعاقدية تُشتقّ من **الصفوف الحيّة** بعد الاستثناء: عددٌ محسوبٌ على المجموعة
  // الأصلية يبقى معروضاً بعد أن يستثني المدير صفوفاً، فيكذب على تقدير أثر الإيراد.
  const activeContractUnits = useMemo(
    () =>
      new Set(
        activeRows.filter((r) => r.contractCovered).map((r) => r.productUnitId),
      ).size,
    [activeRows],
  );
  // عدد العملاء دقيقٌ للمجموعة الكاملة فقط — الخادم لا يُرسل عملاء كل وحدة (بيانات طرفٍ ثالث
  // لا داعي لتسريبها للشاشة). فإن استُثني صفٌّ مغطًّى نعرض الوحدات بلا رقم عملاء، بدل رقمٍ
  // لم يعد صحيحاً: لا نُخمّن ولا نُبقي رقماً قديماً.
  const contractCountExact =
    previewed != null && activeContractUnits === previewed.contractCoveredRows;
  const avgChangePct = useMemo(() => {
    if (!activeRows.length) return 0;
    const sum = activeRows.reduce((acc, r) => {
      const o = Number(r.oldPrice);
      return acc + (o > 0 ? ((Number(r.newPrice) - o) / o) * 100 : 0);
    }, 0);
    return Math.round((sum / activeRows.length) * 10) / 10;
  }, [activeRows]);

  /** المثال الحيّ — نفس الدالّة النقيّة التي يحسب بها الخادم، على صنفٍ حقيقيّ من نطاق المدير. */
  const liveExample = useMemo(() => {
    const s = scopeQ.data?.sample;
    const v = Number(changeValue);
    if (!s || !Number.isFinite(v) || v <= 0) return null;
    const rule = { changeType, changeValue: String(changeValue), roundToDenom };
    const withRound = applyPriceWaveRule(s.price, s.unitCost, rule);
    const withoutRound = applyPriceWaveRule(s.price, s.unitCost, {
      ...rule,
      roundToDenom: 0,
    });
    return { sample: s, withRound, withoutRound };
  }, [scopeQ.data?.sample, changeType, changeValue, roundToDenom]);

  const scopeChips = useMemo(() => {
    const chips: string[] = [PRICE_WAVE_SCOPE_LABELS[scope]];
    if (scope === "FILTERED") {
      if (categoryId !== "") {
        const cat = (categoriesQ.data ?? []).find(
          (c: any) => Number(c.id) === Number(categoryId),
        );
        chips.push(`الفئة: ${cat?.name ?? categoryId} (وأقسامها)`);
      }
      if (debouncedSearch.trim()) chips.push(`بحث: ${debouncedSearch.trim()}`);
    }
    if (scope === "SELECTED") chips.push(`${productIds.length} منتجاً مختاراً`);
    chips.push(
      priceTier ? `فئة السعر: ${priceTierLabel(priceTier)}` : "كل فئات السعر",
    );
    chips.push(`${PRICE_CHANGE_LABELS[changeType]}: ${changeValue}`);
    chips.push(priceRoundDenomLabel(roundToDenom));
    return chips;
  }, [
    scope,
    categoryId,
    categoriesQ.data,
    debouncedSearch,
    productIds.length,
    priceTier,
    changeType,
    changeValue,
    roundToDenom,
  ]);

  function doPreview() {
    setError("");
    const err = stepError();
    if (err) {
      setError(err);
      return;
    }
    previewM.mutate({
      filters,
      changeType,
      changeValue: String(changeValue),
      roundToDenom,
    });
  }

  async function doApply() {
    setError("");
    if (!name.trim()) {
      setError("اسم الموجة مطلوب قبل التطبيق.");
      return;
    }
    if (!previewed || activeRows.length === 0) {
      setError("لا صفوف للتطبيق — عاين أوّلاً.");
      return;
    }
    if ((activeBelowCost > 0 || activeRows.length > 200) && !reason.trim()) {
      setError(
        activeBelowCost > 0
          ? "أدخل سبب التغيير — الموجة تُنزل أسعاراً تحت التكلفة."
          : "أدخل سبب التغيير — الموجة تمسّ أكثر من 200 صفّ.",
      );
      return;
    }
    // حارسٌ قبل تعديلٍ جماعيّ حقيقيّ: كتابةُ عدد الصفوف بيدك تُجبر على قراءته.
    const ok = await confirm({
      variant: "danger",
      title: "تطبيق موجة تسعير",
      description:
        `سيتغيّر سعر ${activeRows.length} صفّاً فعلياً باسم «${name.trim()}» ` +
        `(${PRICE_CHANGE_LABELS[changeType]}: ${changeValue}، ${priceRoundDenomLabel(roundToDenom)})` +
        (activeBelowCost ? ` — منها ${activeBelowCost} تحت التكلفة.` : ".") +
        " يمكن التراجع عنها لاحقاً من تاريخ الموجات.",
      confirmText: "تطبيق",
      requireText: String(activeRows.length),
      requireTextLabel: `اكتب عدد الصفوف (${activeRows.length}) للتأكيد`,
    });
    if (!ok) return;
    applyM.mutate({
      name: name.trim(),
      description: description.trim() || null,
      reason: reason.trim() || null,
      filters,
      changeType,
      changeValue: String(changeValue),
      roundToDenom,
      allowBelowCost,
      expectedFingerprint: previewed.fingerprint,
      excluded: previewed.rows
        .filter((r) => excluded.has(rowKey(r)))
        .map((r) => ({
          productUnitId: r.productUnitId,
          priceTier: r.priceTier as "RETAIL" | "WHOLESALE" | "GOVERNMENT",
        })),
    });
  }

  function togglePicked(id: number, label: string) {
    setProductIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
    setPickedNames((prev) => ({ ...prev, [id]: label }));
  }

  const nextDisabled = stepError() != null;

  return (
    <div className="mx-auto max-w-7xl space-y-4 pb-8">
      <PageHeader
        title="موجات تحديث الأسعار"
        description="تعديل جماعيّ لأسعار البيع بأربع خطوات: من يتأثّر، ماذا يحدث، معاينة، التزام. السعر التعاقدي وأسعار الفواتير السابقة لا تُمَسّ."
      />

      <Card>
        <CardHeader className="pb-3">
          <Stepper
            steps={STEPS}
            current={step}
            onStepClick={(i) => setStep(i)}
          />
        </CardHeader>
        <CardContent className="space-y-4">
          {/* ══════════ خطوة ١: النطاق ══════════ */}
          {step === 0 && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <Field
                  label="نطاق الموجة"
                  required
                  hint="«كل الكتالوج» اختيارٌ واعٍ لا نتيجةَ فلترٍ فارغ"
                >
                  <AppSelect
                    value={scope}
                    onValueChange={(v) => setScope(v as PriceWaveScope)}
                  >
                    {(
                      Object.keys(PRICE_WAVE_SCOPE_LABELS) as PriceWaveScope[]
                    ).map((s) => (
                      <option key={s} value={s}>
                        {PRICE_WAVE_SCOPE_LABELS[s]}
                      </option>
                    ))}
                  </AppSelect>
                </Field>

                {scope === "FILTERED" && (
                  <>
                    <Field
                      label="الفئة"
                      hint="تشمل الأقسام الفرعية للفئة المختارة"
                    >
                      <AppSelect
                        value={categoryId === "" ? "" : String(categoryId)}
                        onValueChange={(v) =>
                          setCategoryId(v === "" ? "" : Number(v))
                        }
                      >
                        <option value="">جميع الفئات</option>
                        {categoryOptionElements(categoriesQ.data ?? [])}
                      </AppSelect>
                    </Field>
                    <Field
                      label="بحث في الاسم/SKU/الباركود"
                      hint="يعمل بالتطبيع العربي — «ازرق» تجد «أزرق»"
                    >
                      <div className="relative">
                        <Search
                          aria-hidden
                          className="pointer-events-none absolute inset-y-0 right-2 my-auto size-4 text-muted-foreground"
                        />
                        <Input
                          value={productSearch}
                          onChange={(e) => setProductSearch(e.target.value)}
                          placeholder="اسم منتج أو SKU أو امسح باركوداً"
                          className="pr-8"
                        />
                      </div>
                    </Field>
                  </>
                )}

                <Field label="فئة السعر" hint="فارغ = كل الفئات المسعَّرة">
                  <AppSelect
                    value={priceTier}
                    onValueChange={(v) => setPriceTier(v as Tier)}
                  >
                    <option value="">جميع فئات السعر</option>
                    <option value="RETAIL">مفرد</option>
                    <option value="WHOLESALE">جملة</option>
                    <option value="GOVERNMENT">حكومي</option>
                  </AppSelect>
                </Field>
              </div>

              {scope === "SELECTED" && (
                <div className="space-y-2 rounded-md border p-3">
                  <Field label="ابحث وأضِف منتجات" hint="حتى 500 منتج">
                    <Input
                      value={pickQuery}
                      onChange={(e) => setPickQuery(e.target.value)}
                      placeholder="اكتب اسماً أو SKU ثم اختر من النتائج"
                    />
                  </Field>
                  {pickQ.data?.rows?.length ? (
                    <div className="max-h-44 overflow-auto rounded border">
                      {Array.from(
                        new Map(
                          pickQ.data.rows.map((r: any) => [
                            Number(r.productId),
                            r,
                          ]),
                        ).values(),
                      ).map((r: any) => {
                        const id = Number(r.productId);
                        const on = productIds.includes(id);
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => togglePicked(id, r.productName)}
                            className={cn(
                              "flex w-full items-center justify-between gap-2 border-b px-3 py-1.5 text-right text-sm last:border-b-0 hover:bg-accent",
                              on && "bg-accent/60",
                            )}
                          >
                            <span>{r.productName}</span>
                            {on ? (
                              <CheckCircle2
                                aria-hidden
                                className="size-4 text-[var(--sem-pos)]"
                              />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  {productIds.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {productIds.map((id) => (
                        <Badge key={id} variant="secondary" className="gap-1">
                          {pickedNames[id] ?? `#${id}`}
                          <button
                            type="button"
                            onClick={() =>
                              setProductIds((prev) =>
                                prev.filter((p) => p !== id),
                              )
                            }
                            aria-label="إزالة"
                          >
                            <X aria-hidden className="size-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* العدّاد الحيّ — الترياق المباشر للفلتر الساقط بصمت. */}
              <div
                className={cn(
                  "flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm",
                  scope === "ALL"
                    ? "border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]"
                    : "border-[var(--sem-info)]/30 bg-[var(--sem-info-bg)]",
                )}
                aria-live="polite"
              >
                <Info
                  aria-hidden
                  className="size-4 shrink-0 text-[var(--sem-info)]"
                />
                {scopeError ? (
                  <span>{scopeError}</span>
                ) : scopeQ.isLoading ? (
                  <span className="text-muted-foreground">
                    جارٍ حساب النطاق…
                  </span>
                ) : (
                  <span>
                    سيتأثّر{" "}
                    <b className="tabular-nums">
                      {nf.format(scopeQ.data?.products ?? 0)}
                    </b>{" "}
                    منتجاً ·{" "}
                    <b className="tabular-nums">
                      {nf.format(scopeQ.data?.priceRows ?? 0)}
                    </b>{" "}
                    سعراً
                    {scopeQ.isFetching && (
                      <span className="mr-2 text-xs text-muted-foreground">
                        (تحديث…)
                      </span>
                    )}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* ══════════ خطوة ٢: القاعدة ══════════ */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <Field label="نوع التغيير" required>
                  <AppSelect
                    value={changeType}
                    onValueChange={(v) => setChangeType(v as PriceChangeType)}
                  >
                    {(
                      Object.keys(PRICE_CHANGE_LABELS) as PriceChangeType[]
                    ).map((k) => (
                      <option key={k} value={k}>
                        {PRICE_CHANGE_LABELS[k]}
                      </option>
                    ))}
                  </AppSelect>
                </Field>
                <Field
                  label="القيمة"
                  required
                  hint={percentMode ? "نسبة مئوية" : "مبلغ بالدينار"}
                >
                  <MoneyInput
                    value={changeValue}
                    onChange={setChangeValue}
                    decimals={percentMode ? 2 : 0}
                    expectedRange={
                      percentMode ? { min: 0.01, max: 1000 } : { min: 1 }
                    }
                    ariaLabel="قيمة التغيير"
                  />
                </Field>
                <Field
                  label="تقريب السعر الناتج"
                  hint="السوق العراقي لا يتعامل بأقلّ من 250 د.ع"
                >
                  <AppSelect
                    value={String(roundToDenom)}
                    onValueChange={(v) => setRoundToDenom(Number(v))}
                  >
                    {PRICE_ROUND_DENOMS.map((d) => (
                      <option key={d} value={String(d)}>
                        {priceRoundDenomLabel(d)}
                      </option>
                    ))}
                  </AppSelect>
                </Field>
              </div>

              {changeType === "SET_MARGIN" && (
                <div className="rounded-md border border-[var(--sem-info)]/30 bg-[var(--sem-info-bg)] p-3 text-sm">
                  <Info
                    aria-hidden
                    className="ml-1 inline size-4 text-[var(--sem-info)]"
                  />
                  يُحسب السعر من <b>تكلفة الوحدة</b> (تكلفة الأساس × معامل
                  التحويل)، والبكجات من وصفتها لا من عمود تكلفتها الصفريّ.
                  الأصناف بلا تكلفة معروفة تظهر في «الصفوف الساقطة» بسببها.
                </div>
              )}

              {/* المثال الحيّ — من صنفٍ حقيقيّ في نطاقك، بنفس دالّة حساب الخادم. */}
              {liveExample && (
                <div className="rounded-md border p-3 text-sm">
                  <div className="mb-1 text-xs font-medium text-muted-foreground">
                    مثالٌ حيّ من نطاقك
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <b>{liveExample.sample.productName}</b>
                    <span className="text-muted-foreground">
                      — {liveExample.sample.unitName} ·{" "}
                      {priceTierLabel(liveExample.sample.priceTier)}
                    </span>
                    <span dir="ltr" className="tabular-nums">
                      {nf.format(Number(liveExample.sample.price))}
                    </span>
                    <ArrowLeft
                      aria-hidden
                      className="size-3.5 text-muted-foreground"
                    />
                    {liveExample.withoutRound.newPrice && roundToDenom > 0 && (
                      <>
                        <span
                          dir="ltr"
                          className="tabular-nums text-muted-foreground line-through"
                        >
                          {nf.format(Number(liveExample.withoutRound.newPrice))}
                        </span>
                        <ArrowLeft
                          aria-hidden
                          className="size-3.5 text-muted-foreground"
                        />
                      </>
                    )}
                    <b dir="ltr" className="tabular-nums">
                      {liveExample.withRound.newPrice
                        ? nf.format(Number(liveExample.withRound.newPrice))
                        : nf.format(Number(liveExample.sample.price))}
                    </b>
                    {/* «لا تغيير» وحدها تبدو عطلاً؛ السبب الحقيقيّ غالباً أنّ حبيبة التقريب أكبر من
                        أثر النسبة (رفعٌ ٥٪ على ٢٥٠ د.ع = ٢٦٢٫٥ ⇒ يعود إلى ٢٥٠). قُلها صراحةً. */}
                    {!liveExample.withRound.newPrice && (
                      <span className="text-xs text-[var(--sem-warn)]">
                        {roundToDenom > 0 && liveExample.withoutRound.newPrice
                          ? `لا تغيير — التقريب لأقرب ${nf.format(roundToDenom)} يبتلع هذه الزيادة. صغّر وحدة التقريب أو كبّر القيمة.`
                          : "لا تغيير على هذا الصنف بهذه القاعدة."}
                      </span>
                    )}
                    {liveExample.withRound.newPrice &&
                      liveExample.sample.unitCost && (
                        <span className="text-xs text-muted-foreground">
                          (الهامش:{" "}
                          {marginPct(
                            liveExample.sample.price,
                            liveExample.sample.unitCost,
                          ) ?? "—"}
                          %{" ← "}
                          {marginPct(
                            liveExample.withRound.newPrice,
                            liveExample.sample.unitCost,
                          ) ?? "—"}
                          %)
                        </span>
                      )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ══════════ خطوة ٣: المعاينة ══════════ */}
          {step === 2 && previewed && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1">
                {scopeChips.map((c) => (
                  <Badge
                    key={c}
                    variant="outline"
                    className="text-[11px] font-normal"
                  >
                    {c}
                  </Badge>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <StatTile
                  label="صفوف ستتغيّر"
                  value={nf.format(activeRows.length)}
                />
                <StatTile
                  label="منتجات"
                  value={nf.format(previewed.productCount)}
                />
                <StatTile
                  label="متوسّط التغيّر"
                  value={`${avgChangePct}%`}
                  tone={avgChangePct >= 0 ? "pos" : "neg"}
                />
                <StatTile
                  label="تحت التكلفة"
                  value={nf.format(activeBelowCost)}
                  tone={activeBelowCost ? "neg" : undefined}
                />
                <StatTile
                  label="مستثناة"
                  value={nf.format(excluded.size)}
                  tone={excluded.size ? "warn" : undefined}
                />
                {previewed.roundedCount > 0 && (
                  <StatTile
                    label="عدّله التقريب"
                    value={nf.format(previewed.roundedCount)}
                  />
                )}
              </div>

              {/* تنبيه: الترويسة تقول «السعر التعاقدي لا يُمَسّ» — وهو صحيح، لكنّ الصمت عن **الحجم**
                  يُخفي معلومةً مالية: مديرٌ يرفع ١٠٪ ظانّاً أنّ الإيراد يرتفع ١٠٪، بينما عملاؤه
                  المتعاقدون (وهم غالباً الأكبر) يدفعون سعرهم القديم. الرقم لا يمنع ولا يغيّر —
                  يجعل الأثر الحقيقيّ مرئياً قبل الالتزام. */}
              {activeContractUnits > 0 && (
                <div className="flex items-start gap-2 rounded-md border border-[var(--sem-info)]/30 bg-[var(--sem-info-bg)] p-3 text-sm">
                  <FileSignature
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-[var(--sem-info)]"
                  />
                  <div>
                    <b className="tabular-nums">
                      {nf.format(activeContractUnits)}
                    </b>{" "}
                    وحدةً ضمن هذه الموجة لها <b>سعرٌ تعاقديّ نشط</b>
                    {contractCountExact ? (
                      <>
                        {" "}
                        مع{" "}
                        <b className="tabular-nums">
                          {nf.format(previewed.contractCustomers)}
                        </b>{" "}
                        عميلاً
                      </>
                    ) : (
                      " مع عملاء متعاقدين"
                    )}{" "}
                    — أسعارهم <b>لن تتغيّر</b> بهذه الموجة (السعر التعاقدي يفوز
                    دائماً). احتسِب ذلك عند تقدير أثر الزيادة على الإيراد.
                  </div>
                </div>
              )}

              <SkippedPanel
                skipped={previewed.skipped}
                open={showSkipped}
                onToggle={() => setShowSkipped((v) => !v)}
              />

              {previewed.rows.length === 0 ? (
                <div className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
                  لا صفّ يتغيّر بهذه القاعدة — راجع النطاق أو القيمة.
                </div>
              ) : (
                <PreviewTable
                  rows={previewed.rows}
                  excluded={excluded}
                  onToggle={(k) =>
                    setExcluded((prev) => {
                      const next = new Set(prev);
                      if (next.has(k)) next.delete(k);
                      else next.add(k);
                      return next;
                    })
                  }
                  onSetMany={(keys, on) =>
                    setExcluded((prev) => {
                      const next = new Set(prev);
                      for (const k of keys) {
                        if (on) next.add(k);
                        else next.delete(k);
                      }
                      return next;
                    })
                  }
                />
              )}
            </div>
          )}

          {/* ══════════ خطوة ٤: الالتزام ══════════ */}
          {step === 3 && previewed && (
            <div className="space-y-4">
              <div className="rounded-md border border-[var(--sem-info)]/30 bg-[var(--sem-info-bg)] p-3 text-sm">
                سيتغيّر سعر <b className="tabular-nums">{activeRows.length}</b>{" "}
                صفّاً في{" "}
                <b className="tabular-nums">
                  {new Set(activeRows.map((r) => r.productId)).size}
                </b>{" "}
                منتجاً.
                {excluded.size > 0 && (
                  <>
                    {" "}
                    استُثني <b className="tabular-nums">{excluded.size}</b>{" "}
                    صفّاً بيدك.
                  </>
                )}
                {previewed.skipped.length > 0 && (
                  <>
                    {" "}
                    وسقط{" "}
                    <b className="tabular-nums">
                      {previewed.skipped.length}
                    </b>{" "}
                    صفّاً بأسبابٍ موضّحة في المعاينة.
                  </>
                )}
              </div>

              <Field label="اسم الموجة" required className="md:col-span-3">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={`${PRICE_CHANGE_LABELS[changeType]} ${changeValue} — ${new Date().toLocaleDateString("en-GB")}`}
                />
              </Field>
              <Field
                label={
                  activeBelowCost > 0 || activeRows.length > 200
                    ? "سبب التغيير"
                    : "سبب التغيير (اختياري)"
                }
                required={activeBelowCost > 0 || activeRows.length > 200}
                hint="يُخزَّن في سجلّ كل صفّ ويظهر في تاريخ سعر المنتج"
              >
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="ارتفاع سعر الدولار من 1350 إلى 1400"
                />
              </Field>
              <Field label="وصف الموجة (اختياري)">
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                />
              </Field>

              {activeBelowCost > 0 && (
                <label className="flex items-start gap-2 rounded border border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] p-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={allowBelowCost}
                    onChange={(e) => setAllowBelowCost(e.target.checked)}
                  />
                  <span>
                    أُذّن بالتطبيق رغم أنّ {activeBelowCost} صفّاً سعره الجديد{" "}
                    <b>تحت تكلفة وحدته</b> (سياسة استثنائية). استثنِ تلك الصفوف
                    من المعاينة إن لم تكن مقصودة.
                  </span>
                </label>
              )}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-[var(--sem-neg)]/30 bg-[var(--sem-neg-bg)] p-3 text-sm"
            >
              <AlertCircle
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-[var(--sem-neg)]"
              />
              <div>{error}</div>
            </div>
          )}

          {/* شريط التنقّل */}
          <div className="flex items-center justify-between gap-2 border-t pt-3">
            <Button
              variant="outline"
              onClick={() => (step === 0 ? resetWizard() : setStep(step - 1))}
              disabled={applyM.isPending}
            >
              <ArrowRight aria-hidden className="size-4" />
              {step === 0 ? "تفريغ" : "السابق"}
            </Button>

            {step === 1 ? (
              <Button
                onClick={doPreview}
                disabled={previewM.isPending || nextDisabled}
                title={stepError() ?? ""}
              >
                <RefreshCw
                  aria-hidden
                  className={cn("size-4", previewM.isPending && "animate-spin")}
                />
                {previewM.isPending ? "جارٍ المعاينة…" : "معاينة"}
              </Button>
            ) : step === 3 ? (
              <Button
                onClick={() => void doApply()}
                disabled={applyM.isPending || activeRows.length === 0}
              >
                <Play aria-hidden className="size-4" />
                {applyM.isPending
                  ? "جارٍ التطبيق…"
                  : `تطبيق الموجة (${activeRows.length})`}
              </Button>
            ) : (
              <Button
                onClick={() => setStep(step + 1)}
                disabled={nextDisabled}
                title={stepError() ?? ""}
              >
                {STEPS[step + 1]}
                <ArrowLeft aria-hidden className="size-4" />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {info && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] p-3 text-sm"
        >
          <CheckCircle2
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-[var(--sem-pos)]"
          />
          <div className="flex-1">{info}</div>
          <button type="button" onClick={() => setInfo("")} aria-label="إخفاء">
            <X aria-hidden className="size-4" />
          </button>
        </div>
      )}

      <WaveHistory onError={setError} onInfo={setInfo} />
    </div>
  );
}
