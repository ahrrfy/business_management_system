// Offers.tsx (٨/٧/٢٦): إدارة العروض والخصومات على المبيعات (بعد gstack-review PR #163).
// RBAC: مدير+ فقط (productsManagerProcedure).
import { AlertCircle, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Field } from "@/components/product/variantBits";
import { PageHeader } from "@/components/PageHeader";
import { trpc } from "@/lib/trpc";

type PromoType = "PERCENT" | "AMOUNT";
type PromoScope = "ALL" | "CATEGORIES" | "PRODUCTS";
type Tier = "RETAIL" | "WHOLESALE" | "GOVERNMENT" | "";

interface TargetPick {
  kind: "category" | "product";
  id: number;
  label: string;
}

function todayYmd(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function Offers() {
  const utils = trpc.useUtils();
  const [includeInactive, setIncludeInactive] = useState(false);
  const listQ = trpc.salesPromotions.list.useQuery({ includeInactive });
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState("");

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<PromoType>("PERCENT");
  const [discountPercent, setDiscountPercent] = useState("10");
  const [discountAmount, setDiscountAmount] = useState("");
  const [scope, setScope] = useState<PromoScope>("ALL");
  const [effectiveFrom, setEffectiveFrom] = useState(todayYmd());
  const [effectiveTo, setEffectiveTo] = useState("");
  const [customerTier, setCustomerTier] = useState<Tier>("");
  const [minLineAmount, setMinLineAmount] = useState("");
  const [priority, setPriority] = useState("0");
  const [targets, setTargets] = useState<TargetPick[]>([]);
  const [productPicker, setProductPicker] = useState("");

  const productSearchQ = trpc.bundles.searchComponents.useQuery(
    { q: productPicker, limit: 20 },
    { enabled: scope === "PRODUCTS" && productPicker.trim().length >= 2, staleTime: 5_000 },
  );
  const categoriesQ = trpc.catalog.categories.useQuery(undefined, { enabled: scope === "CATEGORIES" });

  const createM = trpc.salesPromotions.create.useMutation({
    onSuccess: async () => { await utils.salesPromotions.list.invalidate(); setShowForm(false); resetForm(); },
    onError: (e) => setError(e.message),
  });
  const deactivateM = trpc.salesPromotions.deactivate.useMutation({
    onSuccess: async () => { await utils.salesPromotions.list.invalidate(); },
    onError: (e) => setError(e.message),
  });

  function resetForm() {
    setName(""); setDescription(""); setType("PERCENT"); setDiscountPercent("10"); setDiscountAmount("");
    setScope("ALL"); setEffectiveFrom(todayYmd()); setEffectiveTo(""); setCustomerTier(""); setMinLineAmount("");
    setPriority("0"); setTargets([]); setProductPicker(""); setError("");
  }

  function addProductTarget(productId: number, label: string) {
    if (targets.some((t) => t.kind === "product" && t.id === productId)) return;
    setTargets((prev) => [...prev, { kind: "product", id: productId, label }]);
    setProductPicker("");
  }
  function addCategoryTarget(cid: number, label: string) {
    if (targets.some((t) => t.kind === "category" && t.id === cid)) return;
    setTargets((prev) => [...prev, { kind: "category", id: cid, label }]);
  }
  function removeTarget(idx: number) { setTargets((prev) => prev.filter((_, i) => i !== idx)); }

  function validate(): string | null {
    if (!name.trim()) return "اسم العرض مطلوب.";
    if (type === "PERCENT") {
      const p = parseFloat(discountPercent) || 0;
      if (p <= 0 || p > 100) return "نسبة الخصم بين 0 و100 (حصريّاً > 0).";
    } else {
      const a = parseFloat(discountAmount) || 0;
      if (a <= 0) return "المبلغ الثابت يجب أن يكون أكبر من صفر.";
    }
    if (!effectiveFrom) return "تاريخ البدء مطلوب.";
    if (effectiveTo && effectiveTo < effectiveFrom) return "تاريخ الانتهاء أقدم من البدء.";
    if (scope !== "ALL" && targets.length === 0) return "أضف هدفاً واحداً على الأقلّ.";
    return null;
  }

  function submit() {
    setError("");
    const err = validate();
    if (err) { setError(err); return; }
    createM.mutate({
      name: name.trim(),
      description: description.trim() || null,
      type,
      discountPercent: type === "PERCENT" ? discountPercent : undefined,
      discountAmount: type === "AMOUNT" ? discountAmount : undefined,
      scope,
      effectiveFrom,
      effectiveTo: effectiveTo || null,
      customerTier: customerTier || null,
      minLineAmount: minLineAmount || undefined,
      priority: parseInt(priority, 10) || 0,
      targets: scope === "ALL" ? undefined : targets.map((t) => ({
        categoryId: t.kind === "category" ? t.id : null,
        productId: t.kind === "product" ? t.id : null,
        variantId: null,
      })),
    });
  }

  const list = useMemo(() => (listQ.data ?? []).map((p: any) => p), [listQ.data]);

  return (
    <div className="max-w-6xl mx-auto space-y-4 pb-8">
      <PageHeader
        title="العروض والخصومات"
        description="خصمٌ تلقائي في الكاشير — يُطبَّق آلياً على السعر المعروض للعميل. السعر التعاقدي يفوز دائماً."
        actions={
          <Button onClick={() => setShowForm((v) => !v)}>
            {showForm ? <><X aria-hidden className="size-4" /> إلغاء</> : <><Plus aria-hidden className="size-4" /> عرض جديد</>}
          </Button>
        }
      />

      {showForm && (
        <Card>
          <CardHeader><CardTitle className="text-base">إنشاء عرض جديد</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="اسم العرض" required className="md:col-span-3">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="عودة المدارس" dir="auto" />
            </Field>
            <Field label="الوصف (اختياري)" className="md:col-span-3">
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
            </Field>
            <Field label="نوع الخصم" required>
              <select value={type} onChange={(e) => setType(e.target.value as PromoType)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                <option value="PERCENT">نسبة (%)</option>
                <option value="AMOUNT">مبلغ ثابت (لكل وحدة)</option>
              </select>
            </Field>
            {type === "PERCENT" ? (
              <Field label="نسبة الخصم" required hint="من ١ إلى ١٠٠">
                <Input type="number" min={1} max={100} step="0.01" value={discountPercent} onChange={(e) => setDiscountPercent(e.target.value)} />
              </Field>
            ) : (
              <Field label="المبلغ (لكل وحدة)" required>
                <MoneyInput value={discountAmount} onChange={setDiscountAmount} placeholder="500" />
              </Field>
            )}
            <Field label="أولوية" hint="الأعلى يفوز عند تعارض عروض">
              <Input type="number" min={0} max={999} value={priority} onChange={(e) => setPriority(e.target.value)} />
            </Field>
            <Field label="من تاريخ" required>
              <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
            </Field>
            <Field label="إلى تاريخ" hint="اتركه فارغاً لعرض مستمرّ">
              <Input type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} />
            </Field>
            <Field label="فئة العميل (اختياري)">
              <select value={customerTier} onChange={(e) => setCustomerTier(e.target.value as Tier)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                <option value="">جميع الفئات</option>
                <option value="RETAIL">مفرد</option>
                <option value="WHOLESALE">جملة</option>
                <option value="GOVERNMENT">حكومي</option>
              </select>
            </Field>
            <Field label="الحدّ الأدنى لسعر الوحدة (اختياري)" className="md:col-span-2">
              <MoneyInput value={minLineAmount} onChange={setMinLineAmount} placeholder="0" />
            </Field>
            <Field label="النطاق" required className="md:col-span-3">
              <div className="flex gap-2 flex-wrap">
                {(["ALL", "CATEGORIES", "PRODUCTS"] as PromoScope[]).map((s) => (
                  <Button key={s} type="button" variant={scope === s ? "default" : "outline"} size="sm" onClick={() => { setScope(s); setTargets([]); }}>
                    {s === "ALL" ? "جميع المنتجات" : s === "CATEGORIES" ? "فئات محدَّدة" : "منتجات محدَّدة"}
                  </Button>
                ))}
              </div>
            </Field>
            {scope === "CATEGORIES" && (
              <Field label="اختر الفئات" className="md:col-span-3">
                <div className="flex flex-wrap gap-2 mb-2">
                  {(categoriesQ.data ?? []).filter((c: any) => !targets.some((t) => t.kind === "category" && t.id === c.id)).map((c: any) => (
                    <Button key={c.id} type="button" variant="outline" size="sm" onClick={() => addCategoryTarget(c.id, c.name)}>+ {c.name}</Button>
                  ))}
                </div>
              </Field>
            )}
            {scope === "PRODUCTS" && (
              <Field label="ابحث عن منتج (≥ حرفَين)" className="md:col-span-3">
                <Input value={productPicker} onChange={(e) => setProductPicker(e.target.value)} placeholder="اسم أو SKU" />
                {productPicker.trim().length >= 2 && (productSearchQ.data?.items ?? []).length > 0 && (
                  <div className="mt-1 max-h-48 overflow-auto rounded-md border">
                    {(productSearchQ.data?.items ?? []).map((r) => (
                      <button key={r.variantId} type="button" onClick={() => addProductTarget(r.productId, r.productName)} className="w-full text-right px-3 py-2 hover:bg-accent text-sm block">
                        {r.productName} <span className="text-muted-foreground">— {r.sku}</span>
                      </button>
                    ))}
                  </div>
                )}
              </Field>
            )}
            {scope !== "ALL" && targets.length > 0 && (
              <div className="md:col-span-3 flex flex-wrap gap-1">
                {targets.map((t, i) => (
                  <Badge key={`${t.kind}-${t.id}`} variant="secondary" className="gap-1">
                    {t.kind === "category" ? "فئة" : "منتج"}: {t.label}
                    <button onClick={() => removeTarget(i)} aria-label="حذف"><X className="size-3" /></button>
                  </Badge>
                ))}
              </div>
            )}
            {error && (
              <div className="md:col-span-3 rounded-md border border-red-500/40 bg-red-50 dark:bg-red-950/40 p-3 text-sm flex items-start gap-2">
                <AlertCircle className="size-4 mt-0.5 shrink-0 text-red-600" />
                <div>{error}</div>
              </div>
            )}
            <div className="md:col-span-3 flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setShowForm(false); resetForm(); }}>إلغاء</Button>
              <Button onClick={submit} disabled={createM.isPending}>{createM.isPending ? "جارٍ الحفظ…" : "حفظ العرض"}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex items-center justify-between flex-row">
          <CardTitle className="text-base">العروض ({list.length})</CardTitle>
          <label className="text-xs text-muted-foreground flex items-center gap-2">
            <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
            تضمين المعطَّلة
          </label>
        </CardHeader>
        <CardContent>
          {list.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-12">لا عروض بعد.</div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-right font-medium">الاسم</th>
                    <th className="px-3 py-2 text-right font-medium">النوع</th>
                    <th className="px-3 py-2 text-right font-medium">الخصم</th>
                    <th className="px-3 py-2 text-right font-medium">النطاق</th>
                    <th className="px-3 py-2 text-right font-medium">من — إلى</th>
                    <th className="px-3 py-2 text-right font-medium">أولوية</th>
                    <th className="px-3 py-2 text-right font-medium">الحالة</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((p: any) => (
                    <tr key={p.id} className="border-t">
                      <td className="px-3 py-2 font-medium">{p.name}</td>
                      <td className="px-3 py-2">{p.type === "PERCENT" ? "نسبة" : "مبلغ ثابت"}</td>
                      <td className="px-3 py-2">
                        {p.type === "PERCENT" ? `${p.discountPercent}٪` : `${Number(p.discountAmount).toLocaleString("en-US")} د.ع`}
                      </td>
                      <td className="px-3 py-2">{p.scope === "ALL" ? "الكل" : p.scope === "CATEGORIES" ? "فئات" : "منتجات"}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {String(p.effectiveFrom).slice(0, 10)} — {p.effectiveTo ? String(p.effectiveTo).slice(0, 10) : "مستمرّ"}
                      </td>
                      <td className="px-3 py-2">{p.priority}</td>
                      <td className="px-3 py-2">
                        {p.isActive ? <Badge variant="default">نشط</Badge> : <Badge variant="secondary">معطَّل</Badge>}
                      </td>
                      <td className="px-3 py-2 text-left">
                        {p.isActive && (
                          <Button size="sm" variant="ghost" onClick={() => deactivateM.mutate({ promotionId: Number(p.id) })} disabled={deactivateM.isPending}>
                            تعطيل
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
