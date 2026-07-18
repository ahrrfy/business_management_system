import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { AlertCircle, Plus, Printer, ShoppingCart, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Field, MarginBadge } from "@/components/product/variantBits";
import { trpc } from "@/lib/trpc";
import { toArabicDigits } from "@/lib/variants";

/**
 * ServiceForm — تعريف «خِدمة» (لا مخزون) من شاشة إضافة المنتج وتوجيهها لنقطة بيع الطباعة.
 *
 * شريحة print-catalog: المالك يختار «خِدمة» بدل «سلعة»، فيُعرَّف بَند خِدمي أحاديّ المتغيّر
 * (اسم + وحدة + أسعار الفئات) مع:
 *  - توجيه العرض: نقطة بيع الطباعة (productType=PRINT_SERVICE) ⇒ يَظهر فوراً في شبكة الطباعة.
 *  - تكلفة الخدمة: كلفة مباشرة اختيارية + كلفة المواد الخام المُستهلَكة (الوصفة) = COGS عند البيع.
 *  - استهلاك المواد الخام: وصفة (ورق/حبر…) تَخصمها printSaleService ذرّياً عند كل بيع.
 *
 * يُرسِل إلى `catalog.createProduct` بمتغيّر واحد + الراية printService + recipe[].
 */

type RecipeLine = { key: number; variantId: number | ""; qty: string };

const tierLabel = { RETAIL: "مفرد", WHOLESALE: "جملة", GOVERNMENT: "حكومي" } as const;

export default function ServiceForm() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const categoriesQ = trpc.catalog.categories.useQuery();
  const materialsQ = trpc.catalog.materialsForRecipe.useQuery({});

  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [unitName, setUnitName] = useState("خدمة");
  const [sku, setSku] = useState("");
  const [retail, setRetail] = useState("");
  const [wholesale, setWholesale] = useState("");
  const [government, setGovernment] = useState("");
  const [directCost, setDirectCost] = useState("");
  const [showInPrintPos, setShowInPrintPos] = useState(true);
  const [showInReception, setShowInReception] = useState(false);
  const [consumesMaterials, setConsumesMaterials] = useState(false);
  const [lineSeq, setLineSeq] = useState(2);
  const [lines, setLines] = useState<RecipeLine[]>([{ key: 1, variantId: "", qty: "1" }]);
  const [error, setError] = useState("");

  const materials = materialsQ.data ?? [];
  const matById = useMemo(() => new Map(materials.map((m) => [m.variantId, m])), [materials]);

  // كلفة المواد المُقدَّرة لكل وحدة خدمة (مجموع كلفة كل مادة × كميتها).
  const materialsCost = useMemo(() => {
    if (!consumesMaterials) return 0;
    return lines.reduce((sum, l) => {
      if (l.variantId === "") return sum;
      const m = matById.get(l.variantId);
      const q = parseFloat(l.qty) || 0;
      return sum + (m ? (parseFloat(m.costPrice) || 0) * q : 0);
    }, 0);
  }, [consumesMaterials, lines, matById]);
  const totalCost = (parseFloat(directCost) || 0) + materialsCost;

  const create = trpc.catalog.createProduct.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.catalog.posList.invalidate(),
        utils.catalog.adminList.invalidate(),
        utils.printPos.services.invalidate(),
      ]);
      navigate("/products");
    },
    onError: (e) => setError(e.message),
  });

  const addLine = () => {
    setLines((ls) => [...ls, { key: lineSeq, variantId: "", qty: "1" }]);
    setLineSeq((s) => s + 1);
  };
  const patchLine = (key: number, patch: Partial<RecipeLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key: number) => setLines((ls) => (ls.length <= 1 ? ls : ls.filter((l) => l.key !== key)));

  function autoSku(): string {
    const base = (sku.trim() || `SVC-${name.trim().slice(0, 6) || "X"}`).toUpperCase().replace(/[^A-Z0-9-]/g, "");
    return base || "SVC";
  }

  function validate(): string | null {
    if (!name.trim()) return "اسم الخدمة مطلوب.";
    if (!unitName.trim()) return "وحدة الخدمة مطلوبة (مثل: ورقة / صورة / خدمة).";
    if (!retail.trim() && !wholesale.trim() && !government.trim()) return "حدّد سعر بيع واحداً على الأقل.";
    if (consumesMaterials) {
      const chosen = lines.filter((l) => l.variantId !== "");
      if (!chosen.length) return "اختر مادةً واحدة على الأقل أو أوقِف «تستهلك مواد خام».";
      for (const l of chosen) {
        if (!(parseFloat(l.qty) > 0)) return "كمية كل مادة يجب أن تكون أكبر من صفر.";
      }
      const ids = chosen.map((l) => l.variantId);
      if (new Set(ids).size !== ids.length) return "مادة مكرّرة في الوصفة — ادمج كميتها في سطر واحد.";
    }
    return null;
  }

  function save() {
    setError("");
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    const prices = [
      ...(retail.trim() ? [{ priceTier: "RETAIL" as const, price: retail.trim() }] : []),
      ...(wholesale.trim() ? [{ priceTier: "WHOLESALE" as const, price: wholesale.trim() }] : []),
      ...(government.trim() ? [{ priceTier: "GOVERNMENT" as const, price: government.trim() }] : []),
    ];
    const recipe = consumesMaterials
      ? lines
          .filter((l) => l.variantId !== "" && parseFloat(l.qty) > 0)
          .map((l) => ({ inputVariantId: l.variantId as number, qtyPerOutputBase: l.qty.trim() }))
      : undefined;
    create.mutate({
      name: name.trim(),
      categoryId: categoryId === "" ? undefined : Number(categoryId),
      isService: true,
      printService: showInPrintPos,
      showInReception,
      recipe,
      variants: [
        {
          sku: autoSku(),
          costPrice: directCost.trim() || "0",
          isActive: true,
          units: [{ unitName: unitName.trim(), conversionFactor: "1", isBaseUnit: true, prices }],
        },
      ],
    });
  }

  return (
    <div className="space-y-4">
      {/* ── بيانات الخدمة ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">بيانات الخدمة</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            خِدمة بلا مخزون (تصوير، تجليد، تصميم…). تُعرَض ويُحاسَب عليها كوحدة واحدة بأسعار الفئات.
          </p>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="اسم الخدمة" required className="md:col-span-2" hint="يظهر في شبكة نقطة البيع والفاتورة.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="تصوير A4 أبيض/أسود" dir="auto" />
          </Field>
          <Field label="الفئة / التبويب" hint="تُجمَّع الخدمات بتبويبات حسب الفئة في الشاشة.">
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value === "" ? "" : Number(e.target.value))}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
            >
              <option value="">— بلا فئة —</option>
              {(categoriesQ.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Field label="الوحدة" required hint="ورقة / صورة / نسخة / خدمة…">
            <Input value={unitName} onChange={(e) => setUnitName(e.target.value)} placeholder="ورقة" dir="auto" />
          </Field>
          <Field label="رمز الخدمة (SKU)" hint="يُولَّد تلقائياً من الاسم إن تُرك فارغاً.">
            <Input value={sku} onChange={(e) => setSku(e.target.value.toUpperCase())} dir="ltr" placeholder="PSVC-CP-A4-BW" />
          </Field>
        </CardContent>
      </Card>

      {/* ── توجيه العرض ── */}
      <Card>
        <CardHeader><CardTitle className="text-base">توجيه العرض (أين تُباع الخدمة؟)</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <label className="flex items-start gap-3 rounded-lg border p-3 cursor-pointer hover:bg-muted/30">
            <Switch checked={showInPrintPos} onCheckedChange={setShowInPrintPos} className="mt-0.5" />
            <span className="flex items-center gap-2 text-sm">
              <Printer aria-hidden className="size-4 text-[var(--sem-info)]" />
              <span>
                <b>نقطة بيع الطباعة والاستنساخ</b>
                <span className="block text-xs text-muted-foreground">
                  {showInPrintPos
                    ? "تَظهر هذه الخدمة في شبكة «خدمات طباعة» وتُباع عبر كاشير الطباعة."
                    : "خِدمة عامّة بلا مخزون — لن تَظهر في شبكة خدمات الطباعة."}
                </span>
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3 rounded-lg border p-3 cursor-pointer hover:bg-muted/30">
            <Switch checked={showInReception} onCheckedChange={setShowInReception} className="mt-0.5" />
            <span className="flex items-center gap-2 text-sm">
              <Users aria-hidden className="size-4 text-violet-600" />
              <span>
                <b>خدمة العملاء (الاستقبال)</b>
                <span className="block text-xs text-muted-foreground">
                  {showInReception
                    ? "تَظهر أيضاً في كاشير الاستقبال وتُباع عبره — تُخصَم موادها كما في الطباعة تماماً."
                    : "لن تَظهر في كاشير الاستقبال."}
                </span>
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

      {/* ── التسعير والتكلفة ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShoppingCart aria-hidden className="size-4" /> الأسعار والتكلفة
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Field label="سعر المفرد (د.ع)" required hint="السعر الافتراضي للبيع.">
            <Input value={retail} onChange={(e) => setRetail(e.target.value)} dir="ltr" placeholder="250" inputMode="numeric" />
          </Field>
          <Field label="سعر الجملة (اختياري)">
            <Input value={wholesale} onChange={(e) => setWholesale(e.target.value)} dir="ltr" placeholder="—" inputMode="numeric" />
          </Field>
          <Field label="سعر الحكومي (اختياري)">
            <Input value={government} onChange={(e) => setGovernment(e.target.value)} dir="ltr" placeholder="—" inputMode="numeric" />
          </Field>
          <Field label="تكلفة مباشرة (اختياري)" hint="كلفة لا تأتي من مادة مخزنية (عمالة/تشغيل).">
            <Input value={directCost} onChange={(e) => setDirectCost(e.target.value)} dir="ltr" placeholder="0" inputMode="numeric" />
          </Field>
          <div className="col-span-2 md:col-span-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted-foreground border-t pt-3">
            <span>كلفة المواد المُقدَّرة: <b className="text-foreground" dir="ltr">{toArabicDigits(Math.round(materialsCost))}</b> د.ع</span>
            <span>إجمالي التكلفة/وحدة: <b className="text-foreground" dir="ltr">{toArabicDigits(Math.round(totalCost))}</b> د.ع</span>
            <span className="flex items-center gap-1">الهامش على المفرد: <MarginBadge cost={totalCost} sell={retail} /></span>
          </div>
        </CardContent>
      </Card>

      {/* ── المواد الخام (الوصفة) ── */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">المواد الخام المُستهلَكة</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              هل تَستهلك هذه الخدمة موادّ من المخزون (ورق/حبر…)؟ تُخصَم تلقائياً عند كل بيع وتُحتسَب كلفتها.
            </p>
          </div>
          <div className="flex items-center gap-2 h-9 shrink-0">
            <Switch checked={consumesMaterials} onCheckedChange={setConsumesMaterials} />
            <span className="text-xs text-muted-foreground">{consumesMaterials ? "نعم" : "لا"}</span>
          </div>
        </CardHeader>
        {consumesMaterials && (
          <CardContent className="space-y-2">
            {materials.length === 0 && (
              <div className="rounded-md border border-amber-300/40 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                لا توجد مواد مخزنية بعد. أضِف المواد (ورق/حبر) كـ«سلعة» أولاً ثم ارجِع لتعريف الوصفة.
              </div>
            )}
            <div className="hidden md:grid grid-cols-12 gap-2 px-1 text-[11px] font-semibold text-muted-foreground">
              <span className="col-span-7">المادة</span>
              <span className="col-span-3">الكمية لكل وحدة خدمة</span>
              <span className="col-span-2 text-center">حذف</span>
            </div>
            {lines.map((l) => {
              const m = l.variantId === "" ? null : matById.get(l.variantId);
              return (
                <div key={l.key} className="grid grid-cols-2 md:grid-cols-12 gap-2 items-center border-t pt-2 md:border-0 md:pt-0">
                  <select
                    value={l.variantId}
                    onChange={(e) => patchLine(l.key, { variantId: e.target.value === "" ? "" : Number(e.target.value) })}
                    className="md:col-span-7 h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                  >
                    <option value="">— اختر مادة —</option>
                    {materials.map((mat) => (
                      <option key={mat.variantId} value={mat.variantId}>
                        {mat.productName}{mat.variantName ? ` — ${mat.variantName}` : ""} ({mat.unitName})
                      </option>
                    ))}
                  </select>
                  <div className="md:col-span-3 flex items-center gap-1.5">
                    <Input
                      className="h-8 text-sm"
                      dir="ltr"
                      inputMode="decimal"
                      value={l.qty}
                      onChange={(e) => patchLine(l.key, { qty: e.target.value })}
                      placeholder="1"
                    />
                    {m && <span className="text-[11px] text-muted-foreground whitespace-nowrap">{m.unitName}</span>}
                  </div>
                  <div className="md:col-span-2 flex items-center justify-center">
                    <button
                      type="button"
                      onClick={() => removeLine(l.key)}
                      disabled={lines.length <= 1}
                      className="text-muted-foreground hover:text-destructive disabled:opacity-30"
                      aria-label="حذف المادة"
                    >
                      <X aria-hidden className="size-4" />
                    </button>
                  </div>
                </div>
              );
            })}
            <Button type="button" variant="outline" size="sm" onClick={addLine} className="mt-1">
              <Plus aria-hidden className="size-4 me-1" /> مادة أخرى
            </Button>
          </CardContent>
        )}
      </Card>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="whitespace-pre-wrap break-words">{error}</span>
        </div>
      )}

      {/* ── شريط الحفظ ── */}
      <div className="flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
        <div className="text-xs text-muted-foreground hidden sm:flex items-center gap-2">
          ستُحفظ خِدمة واحدة
          {showInPrintPos && <Badge variant="secondary" className="bg-[var(--sem-info-bg)] text-[var(--sem-info)]">نقطة الطباعة</Badge>}
          {consumesMaterials && <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-700">{toArabicDigits(lines.filter((l) => l.variantId !== "").length)} مادة</Badge>}
        </div>
        <Button type="button" size="sm" onClick={save} disabled={create.isPending}>
          {create.isPending ? "جارٍ الحفظ…" : "حفظ الخدمة"}
        </Button>
      </div>
    </div>
  );
}
