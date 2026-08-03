// PriceWaves.tsx (٧/٧/٢٦): موجات تحديث الأسعار — معاينة قبل الالتزام + تطبيق ذرّي + قائمة تاريخية.
// RBAC: مدير+ فقط (productsManagerProcedure على الخادم يفرض).
import { AlertCircle, Eye, Play, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/product/variantBits";
import { PageHeader } from "@/components/PageHeader";
import { confirm } from "@/lib/confirm";
import { fmtDateTime } from "@/lib/date";
import { trpc } from "@/lib/trpc";
import { CategoryOptionList } from "@/lib/categoryTree";

type ChangeType = "INCREASE_PERCENT" | "DECREASE_PERCENT" | "INCREASE_AMOUNT" | "DECREASE_AMOUNT" | "SET_MARGIN";
type Tier = "RETAIL" | "WHOLESALE" | "GOVERNMENT" | "";

const CHANGE_LABELS: Record<ChangeType, string> = {
  INCREASE_PERCENT: "رفع بنسبة (%)",
  DECREASE_PERCENT: "تخفيض بنسبة (%)",
  INCREASE_AMOUNT: "إضافة مبلغ ثابت",
  DECREASE_AMOUNT: "طرح مبلغ ثابت",
  SET_MARGIN: "تعيين هامش على التكلفة (%)",
};

const TIER_LABELS: Record<string, string> = {
  RETAIL: "مفرد",
  WHOLESALE: "جملة",
  GOVERNMENT: "حكومي",
};

export default function PriceWaves() {
  const utils = trpc.useUtils();
  const categoriesQ = trpc.catalog.categories.useQuery();
  // ترقيم تاريخ الموجات: يبدأ بـ٥٠ ويتوسّع بزرّ «تحميل المزيد» — لا صفحة كاملة (السجلّ نادراً يتجاوز
  // بضع عشرات الموجات، والسقف الخادمي ٢٠٠).
  const [historyLimit, setHistoryLimit] = useState(50);
  const wavesQ = trpc.priceWaves.list.useQuery({ limit: historyLimit });

  // ── تفاصيل موجة مطبَّقة (حوار) ──
  const [detailsWaveId, setDetailsWaveId] = useState<number | null>(null);
  const detailsQ = trpc.priceWaves.waveDetails.useQuery(
    { waveId: detailsWaveId! },
    { enabled: detailsWaveId != null },
  );

  // ── فلاتر ──
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [productSearch, setProductSearch] = useState("");
  const [priceTier, setPriceTier] = useState<Tier>("");

  // ── قاعدة التغيير ──
  const [changeType, setChangeType] = useState<ChangeType>("INCREASE_PERCENT");
  const [changeValue, setChangeValue] = useState("5");

  // ── معاينة/تطبيق ──
  const [previewed, setPreviewed] = useState<any>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [reason, setReason] = useState("");
  const [allowBelowCost, setAllowBelowCost] = useState(false);
  const [error, setError] = useState("");

  const filters = useMemo(() => ({
    categoryId: categoryId === "" ? null : Number(categoryId),
    productSearch: productSearch.trim() || null,
    priceTier: priceTier || null,
  }), [categoryId, productSearch, priceTier]);

  const previewM = trpc.priceWaves.preview.useMutation({
    onSuccess: (data) => {
      setPreviewed(data);
      setError("");
    },
    onError: (e) => setError(e.message),
  });

  const applyM = trpc.priceWaves.applyWave.useMutation({
    onSuccess: async () => {
      await utils.priceWaves.list.invalidate();
      setPreviewed(null);
      setName("");
      setDescription("");
      setReason("");
      setAllowBelowCost(false);
    },
    onError: (e) => setError(e.message),
  });

  function doPreview() {
    setError("");
    setPreviewed(null);
    const val = parseFloat(changeValue);
    if (!val || val <= 0) {
      setError("قيمة التغيير يجب أن تكون أكبر من صفر.");
      return;
    }
    previewM.mutate({ filters, changeType, changeValue });
  }

  async function doApply() {
    setError("");
    if (!name.trim()) {
      setError("اسم الموجة مطلوب قبل التطبيق.");
      return;
    }
    if (!previewed || previewed.rows.length === 0) {
      setError("لا صفوف للتطبيق — عاين أوّلاً.");
      return;
    }
    // حارس قبل تنفيذ موجة تسعير فعلية — تعديلٌ جماعيّ لا رجعة عملية سهلة فيه.
    const ok = await confirm({
      variant: "warning",
      title: "تطبيق موجة تسعير",
      description: `سيُحدَّث سعر ${previewed.totalRows} صفّاً فعلياً باسم «${name.trim()}» (${CHANGE_LABELS[changeType]}: ${changeValue}). لا تراجع تلقائي — أنشئ موجة عكسية لاحقاً إن لزم.`,
      confirmText: "تطبيق",
    });
    if (!ok) return;
    applyM.mutate({
      name: name.trim(),
      description: description.trim() || null,
      reason: reason.trim() || null,
      filters,
      changeType,
      changeValue,
      allowBelowCost,
    });
  }

  // Note: use previewM to invoke as query alternative via mutation
  // (React Query recommends `.query()`, but this is triggered on button click).

  const waves = wavesQ.data ?? [];

  return (
    <div className="max-w-7xl mx-auto space-y-4 pb-8">
      <PageHeader
        title="موجات تحديث الأسعار"
        description="تعديل جماعيّ لأسعار البيع بمعاينة قبل الالتزام. السعر التعاقدي وأسعار الفواتير السابقة لا تُمَسّ."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">١. اختر المنتجات وقاعدة التغيير</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="الفئة">
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value === "" ? "" : Number(e.target.value))}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
            >
              <option value="">جميع الفئات</option>
              <CategoryOptionList categories={categoriesQ.data ?? []} />
            </select>
          </Field>
          <Field label="بحث في الاسم/SKU">
            <Input value={productSearch} onChange={(e) => setProductSearch(e.target.value)} placeholder="اسم منتج أو SKU" />
          </Field>
          <Field label="فئة السعر">
            <select
              value={priceTier}
              onChange={(e) => setPriceTier(e.target.value as Tier)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
            >
              <option value="">جميع الفئات</option>
              <option value="RETAIL">مفرد</option>
              <option value="WHOLESALE">جملة</option>
              <option value="GOVERNMENT">حكومي</option>
            </select>
          </Field>

          <Field label="نوع التغيير" required>
            <select
              value={changeType}
              onChange={(e) => setChangeType(e.target.value as ChangeType)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
            >
              {(Object.keys(CHANGE_LABELS) as ChangeType[]).map((k) => (
                <option key={k} value={k}>{CHANGE_LABELS[k]}</option>
              ))}
            </select>
          </Field>
          <Field label="القيمة" required hint={changeType.includes("PERCENT") || changeType === "SET_MARGIN" ? "نسبة مئوية" : "مبلغ بالدينار"}>
            <Input type="number" min={0.01} step="0.01" value={changeValue} onChange={(e) => setChangeValue(e.target.value)} />
          </Field>
          <Field label="&nbsp;">
            <Button onClick={doPreview} disabled={previewM.isPending} className="w-full">
              <RefreshCw aria-hidden className="size-4" />
              {previewM.isPending ? "جارٍ المعاينة…" : "معاينة"}
            </Button>
          </Field>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-md border border-[var(--sem-neg)]/30 bg-[var(--sem-neg-bg)] p-3 text-sm flex items-start gap-2">
          <AlertCircle className="size-4 mt-0.5 shrink-0 text-[var(--sem-neg)]" />
          <div>{error}</div>
        </div>
      )}

      {previewed && (
        <Card>
          <CardHeader className="flex items-center justify-between flex-row">
            <CardTitle className="text-base">
              ٢. معاينة — {previewed.totalRows} صفّ متأثّر
              {previewed.belowCostCount > 0 && (
                <Badge variant="destructive" className="mr-2">{previewed.belowCostCount} تحت التكلفة</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {previewed.rows.length === 0 ? (
              <div className="text-center text-sm text-muted-foreground py-8">لا صفوف مطابقة — عدّل الفلاتر.</div>
            ) : (
              <>
                <div className="overflow-x-auto rounded-md border max-h-96 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-xs text-muted-foreground sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-right font-medium">المنتج</th>
                        <th className="px-3 py-2 text-right font-medium">SKU</th>
                        <th className="px-3 py-2 text-right font-medium">الوحدة</th>
                        <th className="px-3 py-2 text-right font-medium">فئة السعر</th>
                        <th className="px-3 py-2 text-right font-medium">التكلفة</th>
                        <th className="px-3 py-2 text-right font-medium">السعر القديم</th>
                        <th className="px-3 py-2 text-right font-medium">السعر الجديد</th>
                        <th className="px-3 py-2 text-right font-medium">الفرق</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewed.rows.map((r: any, i: number) => {
                        const diff = Number(r.newPrice) - Number(r.oldPrice);
                        return (
                          <tr key={`${r.productUnitId}-${r.priceTier}-${i}`} className={`border-t ${r.belowCost ? "bg-[var(--sem-neg-bg)]" : ""}`}>
                            <td className="px-3 py-2">{r.productName}</td>
                            <td className="px-3 py-2 text-xs text-muted-foreground">{r.sku}</td>
                            <td className="px-3 py-2">{r.unitName}</td>
                            <td className="px-3 py-2">{TIER_LABELS[r.priceTier] || r.priceTier}</td>
                            <td className="px-3 py-2 text-muted-foreground">{Number(r.costPrice).toLocaleString("en-US")}</td>
                            <td className="px-3 py-2">{Number(r.oldPrice).toLocaleString("en-US")}</td>
                            <td className="px-3 py-2 font-medium">{Number(r.newPrice).toLocaleString("en-US")}</td>
                            <td className={`px-3 py-2 ${diff >= 0 ? "text-[var(--sem-pos)]" : "text-[var(--sem-neg)]"}`}>
                              {diff >= 0 ? "+" : ""}{diff.toFixed(2)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 border-t">
                  <Field label="اسم الموجة" required className="md:col-span-3">
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="تحديث بعد رفع الدولار ٧/٧" />
                  </Field>
                  <Field label="سبب التغيير (اختياري)" hint="يُخزَّن في سجلّ كل صفّ" className="md:col-span-3">
                    <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="ارتفاع سعر الدولار من ١٣٥٠ إلى ١٤٠٠" />
                  </Field>
                  <Field label="وصف الموجة (اختياري)" className="md:col-span-3">
                    <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
                  </Field>
                  {previewed.belowCostCount > 0 && (
                    <div className="md:col-span-3 flex items-center gap-2 p-2 rounded border border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)]">
                      <input type="checkbox" checked={allowBelowCost} onChange={(e) => setAllowBelowCost(e.target.checked)} id="allowBelowCost" />
                      <label htmlFor="allowBelowCost" className="text-sm">
                        أُذّن بالتطبيق رغم أن {previewed.belowCostCount} صفّ تحت التكلفة (سياسة استثنائية).
                      </label>
                    </div>
                  )}
                  <div className="md:col-span-3 flex items-center justify-end gap-2">
                    <Button variant="outline" onClick={() => setPreviewed(null)}>إلغاء المعاينة</Button>
                    <Button onClick={doApply} disabled={applyM.isPending || (previewed.belowCostCount > 0 && !allowBelowCost)}>
                      <Play aria-hidden className="size-4" />
                      {applyM.isPending ? "جارٍ التطبيق…" : `تطبيق الموجة (${previewed.totalRows})`}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">تاريخ الموجات المطبَّقة ({waves.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {waves.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-8">لا موجات بعد.</div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-right font-medium">التاريخ</th>
                    <th className="px-3 py-2 text-right font-medium">الاسم</th>
                    <th className="px-3 py-2 text-right font-medium">نوع التغيير</th>
                    <th className="px-3 py-2 text-right font-medium">القيمة</th>
                    <th className="px-3 py-2 text-right font-medium">الصفوف</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {waves.map((w: any) => (
                    <tr key={w.id} className="border-t">
                      <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap tabular-nums" dir="ltr">{fmtDateTime(w.appliedAt)}</td>
                      <td className="px-3 py-2 font-medium">{w.name}</td>
                      <td className="px-3 py-2">{CHANGE_LABELS[w.changeType as ChangeType]}</td>
                      <td className="px-3 py-2">{Number(w.changeValue).toLocaleString("en-US")}</td>
                      <td className="px-3 py-2">{w.totalRows}</td>
                      <td className="px-3 py-2 text-left">
                        <Button size="sm" variant="ghost" onClick={() => setDetailsWaveId(Number(w.id))}>
                          <Eye aria-hidden className="size-3.5" />
                          تفاصيل
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {waves.length >= historyLimit && historyLimit < 200 && (
            <div className="flex justify-center pt-3">
              <Button variant="outline" size="sm" onClick={() => setHistoryLimit((v) => Math.min(200, v + 50))} disabled={wavesQ.isFetching}>
                {wavesQ.isFetching ? "جارٍ التحميل…" : "تحميل المزيد"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={detailsWaveId != null} onOpenChange={(open) => !open && setDetailsWaveId(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>تفاصيل موجة التسعير</DialogTitle>
            <DialogDescription>كل صفٍّ تغيَّر ضمن هذه الموجة — السعر قبل وبعد لكل منتج/وحدة/فئة سعر.</DialogDescription>
          </DialogHeader>
          {detailsQ.isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">جارٍ التحميل…</div>
          ) : (detailsQ.data ?? []).length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">لا صفوف مسجَّلة لهذه الموجة.</div>
          ) : (
            <div className="overflow-x-auto rounded-md border max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-right font-medium">المنتج</th>
                    <th className="px-3 py-2 text-right font-medium">SKU</th>
                    <th className="px-3 py-2 text-right font-medium">الوحدة</th>
                    <th className="px-3 py-2 text-right font-medium">فئة السعر</th>
                    <th className="px-3 py-2 text-right font-medium">السعر القديم</th>
                    <th className="px-3 py-2 text-right font-medium">السعر الجديد</th>
                  </tr>
                </thead>
                <tbody>
                  {(detailsQ.data ?? []).map((r) => (
                    <tr key={r.id} className="border-t">
                      <td className="px-3 py-2">{r.productName ?? "—"}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{r.sku ?? "—"}</td>
                      <td className="px-3 py-2">{r.unitName ?? "—"}</td>
                      <td className="px-3 py-2">{TIER_LABELS[r.priceTier as string] || r.priceTier}</td>
                      <td className="px-3 py-2">{Number(r.oldPrice).toLocaleString("en-US")}</td>
                      <td className="px-3 py-2 font-medium">{Number(r.newPrice).toLocaleString("en-US")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailsWaveId(null)}>إغلاق</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
