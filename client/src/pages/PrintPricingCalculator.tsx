// حاسبة تسعير الطباعة الرقمية (Digital) — تقدير حيّ للكلفة والسعر المقترح. محصورة بالمدير
// (تبويب managerOnly في PrintHub + الخادم managerProcedure). كل الحساب المالي على الخادم
// (decimal.js) — الواجهة تعرض فقط. المطبعة ديجيتال: صغير المقاس بالوجه، عريض (فلكس) بالمتر².
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { Calculator, Settings2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { PageHeader } from "@/components/PageHeader";
import { MoneyInput } from "@/components/form/MoneyInput";
import { formatIqd } from "@/lib/money";
import { trpc, type RouterInputs } from "@/lib/trpc";
import {
  COLOR_MODE_AR,
  COLOR_MODES,
  PAPER_SIZE_CODES,
  PAPER_SIZES,
  type ColorMode,
  type PaperSizeCode,
} from "@shared/printPricing";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

type EstimateInput = RouterInputs["printPricing"]["estimate"];

/** ترتيب المقاس ضمن قائمة ISO القانونية (لفرز القوائم). */
const sizeOrder = (c: string) => PAPER_SIZE_CODES.indexOf(c as PaperSizeCode);
const sizeLabel = (c: string) => PAPER_SIZES.find((s) => s.code === c)?.label ?? c;

/** نسبة هامش صالحة للإرسال (رقم موجب ≤ ٣ منازل). */
const isValidMargin = (s: string) => /^\d+(\.\d{1,3})?$/.test(s);
/** قياس متر موجب (> 0). */
const isPositiveDim = (s: string) => /^\d*\.?\d+$/.test(s) && Number(s) > 0;

export default function PrintPricingCalculator() {
  const bundle = trpc.printPricing.settings.useQuery();

  const [category, setCategory] = useState<"SMALL" | "WIDE">("SMALL");
  // صغير المقاس
  const [paperSize, setPaperSize] = useState<PaperSizeCode | "">("");
  const [colorMode, setColorMode] = useState<ColorMode>("COLOR");
  const [sides, setSides] = useState<1 | 2>(1);
  const [copies, setCopies] = useState(100);
  const [pagesPerCopy, setPagesPerCopy] = useState(1);
  const [paperUpchargeId, setPaperUpchargeId] = useState<number | "">("");
  // عريض
  const [mediaId, setMediaId] = useState<number | "">("");
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [quantity, setQuantity] = useState(1);
  // مشترك
  const [finishingIds, setFinishingIds] = useState<number[]>([]);
  const [applySetupFee, setApplySetupFee] = useState(true);
  const [marginOverride, setMarginOverride] = useState("");

  const settings = bundle.data?.settings;
  const facePrices = bundle.data?.facePrices ?? [];
  const activePapers = (bundle.data?.paperUpcharges ?? []).filter((p) => p.isActive);
  const activeMedia = (bundle.data?.wideMedia ?? []).filter((m) => m.isActive);
  const activeFinishings = (bundle.data?.finishings ?? []).filter((f) => f.isActive);
  const isMarginMode = settings?.pricingMode === "MARGIN";
  const hasSetupFee = Number(settings?.setupFee ?? "0") > 0;

  // المقاسات المُسعّرة للنمط الحاليّ (المقاس غير المُسعَّر لا يُعرَض — الخادم يرفضه أيضاً).
  const pricedSizes = useMemo(
    () =>
      facePrices
        .filter((f) => f.colorMode === colorMode)
        .map((f) => f.paperSize)
        .sort((a, b) => sizeOrder(a) - sizeOrder(b)),
    [facePrices, colorMode],
  );
  // لو المقاس المختار لم يعُد مُسعّراً لهذا النمط، صفّره.
  useEffect(() => {
    if (paperSize && !pricedSizes.includes(paperSize)) setPaperSize("");
  }, [pricedSizes, paperSize]);

  function toggleFinishing(id: number, checked: boolean) {
    setFinishingIds((prev) => (checked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)));
  }

  // بناء مدخل التقدير (أو null إن ناقصاً) — يُرسَل للخادم للحساب.
  const input: EstimateInput | null = useMemo(() => {
    const common = {
      applySetupFee,
      marginPercentOverride: isMarginMode && marginOverride && isValidMargin(marginOverride) ? marginOverride : null,
    };
    if (category === "SMALL") {
      if (!paperSize || copies < 1 || pagesPerCopy < 1) return null;
      return {
        category: "SMALL",
        paperSize,
        colorMode,
        sides,
        copies,
        pagesPerCopy,
        paperUpchargeId: paperUpchargeId === "" ? null : paperUpchargeId,
        finishingIds,
        ...common,
      };
    }
    if (mediaId === "" || !isPositiveDim(width) || !isPositiveDim(height) || quantity < 1) return null;
    return {
      category: "WIDE",
      mediaId,
      width,
      height,
      quantity,
      finishingIds,
      ...common,
    };
  }, [
    category, paperSize, colorMode, sides, copies, pagesPerCopy, paperUpchargeId,
    mediaId, width, height, quantity, finishingIds, applySetupFee, marginOverride, isMarginMode,
  ]);

  // إزالة الاهتزاز (debounce) قبل الاستعلام — حساب حيّ بلا ضغط لكل ضغطة.
  const [debounced, setDebounced] = useState<EstimateInput | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(input), 300);
    return () => clearTimeout(t);
  }, [input]);

  const estimate = trpc.printPricing.estimate.useQuery(debounced as EstimateInput, {
    enabled: debounced != null,
    retry: false,
  });
  const result = estimate.data;

  return (
    <div className="space-y-4">
      <PageHeader
        title="حاسبة تسعير الطباعة"
        icon={<Calculator aria-hidden className="size-6 text-primary" />}
        description="تقدير كلفة وسعر الطباعة الرقمية — بالوجه (المقاس × النمط، الورق مشمول) أو بالمتر المربّع للعريض. الأرقام من الإعدادات."
        actions={
          <Link href="/work-orders?tab=print-pricing-settings">
            <Button variant="outline" size="sm">
              <Settings2 aria-hidden className="size-4 ms-1" /> إعدادات التسعير
            </Button>
          </Link>
        }
      />

      {bundle.isLoading ? (
        <Card><CardContent className="p-6 text-center text-muted-foreground">جارٍ تحميل الإعدادات…</CardContent></Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* ─── المدخلات ─── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">تفاصيل الطلب</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* الفئة */}
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={category === "SMALL" ? "default" : "outline"}
                  className="flex-1"
                  onClick={() => setCategory("SMALL")}
                >
                  صغير المقاس (بالوجه)
                </Button>
                <Button
                  type="button"
                  variant={category === "WIDE" ? "default" : "outline"}
                  className="flex-1"
                  onClick={() => setCategory("WIDE")}
                >
                  عريض / فلكس (بالمتر²)
                </Button>
              </div>

              {category === "SMALL" ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label>النمط</Label>
                    <select className={selectCls} value={colorMode} onChange={(e) => setColorMode(e.target.value as ColorMode)}>
                      {COLOR_MODES.map((m) => (
                        <option key={m} value={m}>{COLOR_MODE_AR[m]}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label>المقاس (ISO)</Label>
                    <select className={selectCls} value={paperSize} onChange={(e) => setPaperSize(e.target.value as PaperSizeCode)}>
                      <option value="">— اختر مقاساً مُسعّراً —</option>
                      {pricedSizes.map((s) => (
                        <option key={s} value={s}>{sizeLabel(s)}</option>
                      ))}
                    </select>
                    {pricedSizes.length === 0 && (
                      <p className="text-xs text-amber-600">لا مقاسات مُسعّرة لهذا النمط — أضِفها في الإعدادات.</p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label>الأوجه</Label>
                    <select className={selectCls} value={sides} onChange={(e) => setSides(Number(e.target.value) === 2 ? 2 : 1)}>
                      <option value={1}>وجه واحد</option>
                      <option value={2}>وجهان</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label>عدد النسخ</Label>
                    <Input type="number" min={1} value={copies} onChange={(e) => setCopies(Math.max(1, Number(e.target.value) || 0))} />
                  </div>
                  <div className="space-y-1">
                    <Label>الصفحات لكل نسخة</Label>
                    <Input type="number" min={1} value={pagesPerCopy} onChange={(e) => setPagesPerCopy(Math.max(1, Number(e.target.value) || 0))} />
                  </div>
                  <div className="space-y-1">
                    <Label>ورق مميّز (اختياري)</Label>
                    <select className={selectCls} value={paperUpchargeId} onChange={(e) => setPaperUpchargeId(e.target.value === "" ? "" : Number(e.target.value))}>
                      <option value="">— بدون (ورق قياسيّ) —</option>
                      {activePapers.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1 col-span-2">
                    <Label>الوسيط</Label>
                    <select className={selectCls} value={mediaId} onChange={(e) => setMediaId(e.target.value === "" ? "" : Number(e.target.value))}>
                      <option value="">— اختر وسيطاً —</option>
                      {activeMedia.map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                    {activeMedia.length === 0 && (
                      <p className="text-xs text-amber-600">لا وسائط عريضة مُعرّفة — أضِفها في الإعدادات.</p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label>العرض (متر)</Label>
                    <MoneyInput value={width} onChange={setWidth} decimals={3} ariaLabel="العرض بالمتر" placeholder="0.00" />
                  </div>
                  <div className="space-y-1">
                    <Label>الارتفاع (متر)</Label>
                    <MoneyInput value={height} onChange={setHeight} decimals={3} ariaLabel="الارتفاع بالمتر" placeholder="0.00" />
                  </div>
                  <div className="space-y-1">
                    <Label>الكمية</Label>
                    <Input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 0))} />
                  </div>
                </div>
              )}

              {/* التشطيب */}
              {activeFinishings.length > 0 && (
                <div className="space-y-2">
                  <Label>خيارات التشطيب</Label>
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {activeFinishings.map((f) => (
                      <label key={f.id} className="flex items-center gap-2 rounded-md border border-border p-2 text-sm">
                        <Checkbox checked={finishingIds.includes(f.id)} onCheckedChange={(c) => toggleFinishing(f.id, c === true)} />
                        <span className="flex-1">{f.name}</span>
                        <span className="text-xs text-muted-foreground">{formatIqd(f.price)}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* التجهيز + الهامش */}
              <div className="flex flex-wrap items-center gap-4 border-t border-border pt-3">
                {hasSetupFee && (
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={applySetupFee} onCheckedChange={(c) => setApplySetupFee(c === true)} />
                    <span>احتساب رسم التجهيز ({formatIqd(settings?.setupFee)})</span>
                  </label>
                )}
                {isMarginMode && (
                  <div className="flex items-center gap-2">
                    <Label className="whitespace-nowrap">هامش الربح ٪</Label>
                    <Input
                      className="w-24"
                      inputMode="decimal"
                      value={marginOverride}
                      onChange={(e) => setMarginOverride(e.target.value.replace(/[^\d.]/g, ""))}
                      placeholder={settings?.defaultMarginPercent ?? "0"}
                    />
                    <span className="text-xs text-muted-foreground">الافتراضي {settings?.defaultMarginPercent ?? "0"}٪</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* ─── النتيجة ─── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                تفصيل الكلفة والسعر المقترح
                {estimate.isFetching && <Loader2 aria-hidden className="size-4 animate-spin text-muted-foreground" />}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!debounced ? (
                <p className="py-8 text-center text-sm text-muted-foreground">أكمل تفاصيل الطلب لعرض التقدير.</p>
              ) : estimate.isError ? (
                <p className="py-8 text-center text-sm text-amber-600">{estimate.error?.message}</p>
              ) : !result ? (
                <p className="py-8 text-center text-sm text-muted-foreground">جارٍ الحساب…</p>
              ) : (
                <div className="space-y-4">
                  {/* مؤشرات */}
                  <div className="flex flex-wrap gap-2 text-xs">
                    {result.category === "SMALL" ? (
                      <>
                        <Metric label="الأوجه المطبوعة" value={String(result.faces)} />
                        <Metric label="الأوراق" value={String(result.sheets)} />
                        <Metric label="النسخ" value={String(result.units)} />
                      </>
                    ) : (
                      <>
                        <Metric label="المساحة" value={`${result.areaSqm} م²`} />
                        <Metric label="الكمية" value={String(result.units)} />
                      </>
                    )}
                  </div>

                  {/* تفصيل الأسطر */}
                  <div className="overflow-hidden rounded-lg border border-border">
                    <table className="w-full text-sm">
                      <tbody>
                        {result.lines.map((l) => (
                          <tr key={l.key} className="border-b border-border last:border-0">
                            <td className="p-2.5">
                              <div className="font-medium">{l.label}</div>
                              {l.detail && <div className="text-xs text-muted-foreground">{l.detail}</div>}
                            </td>
                            <td className="p-2.5 text-left font-medium tabular-nums whitespace-nowrap">{formatIqd(l.amount)}</td>
                          </tr>
                        ))}
                        <tr className="bg-muted/40 font-semibold">
                          <td className="p-2.5">إجمالي الكلفة</td>
                          <td className="p-2.5 text-left tabular-nums whitespace-nowrap">{formatIqd(result.totalCost)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  {/* السعر المقترح */}
                  <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">
                        السعر المقترح
                        {result.pricingMode === "MARGIN" ? ` (هامش ${result.marginPercent}٪)` : " (بيع مباشر)"}
                      </span>
                      <span className="text-2xl font-bold tabular-nums">{formatIqd(result.suggestedPrice)}</span>
                    </div>
                    <div className="flex items-center justify-between border-t border-primary/20 pt-2">
                      <span className="text-sm text-muted-foreground">سعر الوحدة الواحدة</span>
                      <span className="text-lg font-semibold tabular-nums">{formatIqd(result.unitPrice)}</span>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-1.5">
      <span className="text-muted-foreground">{label}: </span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}
