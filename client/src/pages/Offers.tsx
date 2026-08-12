// Offers.tsx (٨/٧/٢٦): إدارة العروض والخصومات على المبيعات (بعد gstack-review PR #163).
// RBAC: مدير+ فقط (productsManagerProcedure).
import { AlertCircle, FileEdit, Plus, RotateCcw, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Field } from "@/components/product/variantBits";
import { PageHeader } from "@/components/PageHeader";
import { AppSelect } from "@/components/ui/AppSelect";
import { confirm } from "@/lib/confirm";
import { trpc } from "@/lib/trpc";
import { canSeeGate } from "@/lib/navVisibility";

type PromoType = "PERCENT" | "AMOUNT";
type PromoScope = "ALL" | "CATEGORIES" | "PRODUCTS";
type Tier = "RETAIL" | "WHOLESALE" | "GOVERNMENT" | "";
type ApplicationMode = "AUTO" | "COUPON";
type ChannelFilter = "ALL" | "POS" | "STORE";
/** «ساري» — حالة اشتقاقية من تاريخَي البدء/الانتهاء مقابل اليوم، مستقلّة عن isActive (عرضٌ isActive=true
 *  قد يكون منتهياً تاريخياً أو مجدولاً لاحقاً، ولا يظهر أيّهما حالياً في الجدول). */
type ValidityFilter = "ALL" | "CURRENT" | "SCHEDULED" | "EXPIRED";

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

/** تطبيع تاريخ عمود `date` (يعود Date حقيقياً عبر superjson، منتصف ليل UTC) إلى YYYY-MM-DD. */
function toYmd(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

const CHANNEL_LABEL: Record<string, string> = { POS: "نقطة البيع", STORE: "المتجر الإلكتروني" };
const APPLICATION_LABEL: Record<string, string> = { AUTO: "تلقائي", COUPON: "بكوبون" };

export default function Offers() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const canManage = canSeeGate({ roles: ["manager"], module: "campaigns", level: "FULL" }, me.data?.role, (me.data?.permissionsOverride ?? null) as any);
  const [includeInactive, setIncludeInactive] = useState(false);
  const listQ = trpc.salesPromotions.list.useQuery({ includeInactive });
  const campaignsQ = trpc.crm.campaigns.list.useQuery();
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState("");
  // فلاتر عميلية على القائمة (channel/validity) — لا تحتاج استدعاءً خادمياً جديداً؛ list يعيد كل
  // أعمدة الجدول أصلاً (isStoreManaged/applicationMode/effectiveFrom/effectiveTo).
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("ALL");
  const [validityFilter, setValidityFilter] = useState<ValidityFilter>("ALL");
  // تعديل عرضٍ قائم — null = نموذج إنشاء جديد.
  const [editingId, setEditingId] = useState<number | null>(null);

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
  const [campaignId, setCampaignId] = useState("");
  const [applicationMode, setApplicationMode] = useState<ApplicationMode>("AUTO");
  const [channel, setChannel] = useState<"POS" | "STORE">("POS");
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
  const updateM = trpc.salesPromotions.update.useMutation({
    onSuccess: async () => { await utils.salesPromotions.list.invalidate(); setShowForm(false); resetForm(); },
    onError: (e) => setError(e.message),
  });
  const deactivateM = trpc.salesPromotions.deactivate.useMutation({
    onSuccess: async () => { await utils.salesPromotions.list.invalidate(); },
    onError: (e) => setError(e.message),
  });
  const reactivateM = trpc.salesPromotions.reactivate.useMutation({
    onSuccess: async () => { await utils.salesPromotions.list.invalidate(); },
    onError: (e) => setError(e.message),
  });

  function resetForm() {
    setName(""); setDescription(""); setType("PERCENT"); setDiscountPercent("10"); setDiscountAmount("");
    setScope("ALL"); setEffectiveFrom(todayYmd()); setEffectiveTo(""); setCustomerTier(""); setMinLineAmount("");
    setPriority("0"); setTargets([]); setProductPicker(""); setError("");
    setCampaignId(""); setApplicationMode("AUTO"); setChannel("POS"); setEditingId(null);
  }

  /** يفتح النموذج بحالة تعديل مُعبَّأة من صفّ القائمة — النطاق/الأهداف/النوع تبقى كما أُنشئت (الخادم
   *  يرفضها في `update`؛ عرضٌ جديد هو الطريق لتغييرها هيكلياً). */
  function startEdit(p: any) {
    setEditingId(Number(p.id));
    setName(p.name ?? "");
    setDescription(p.description ?? "");
    setType(p.type);
    setDiscountPercent(p.type === "PERCENT" ? String(p.discountPercent ?? "0") : "10");
    setDiscountAmount(p.type === "AMOUNT" ? String(p.discountAmount ?? "0") : "");
    setScope(p.scope);
    setEffectiveFrom(toYmd(p.effectiveFrom));
    setEffectiveTo(toYmd(p.effectiveTo));
    setCustomerTier((p.customerTier ?? "") as Tier);
    setMinLineAmount(p.minLineAmount && Number(p.minLineAmount) > 0 ? String(p.minLineAmount) : "");
    setPriority(String(p.priority ?? 0));
    setCampaignId(p.campaignId ? String(p.campaignId) : "");
    setApplicationMode(p.applicationMode ?? "AUTO");
    setChannel(p.isStoreManaged ? "STORE" : "POS");
    setTargets([]); // النطاق للعرض فقط أثناء التعديل — التغيير الفعلي يتطلّب عرضاً جديداً
    setError("");
    setShowForm(true);
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
    // النطاق/الأهداف تُفحص في الإنشاء فقط — التعديل لا يغيّرها (targets مُفرَّغة عمداً في startEdit).
    if (editingId == null && scope !== "ALL" && targets.length === 0) return "أضف هدفاً واحداً على الأقلّ.";
    return null;
  }

  function submit() {
    setError("");
    const err = validate();
    if (err) { setError(err); return; }
    if (editingId != null) {
      updateM.mutate({
        promotionId: editingId,
        name: name.trim(),
        description: description.trim() || null,
        discountPercent: type === "PERCENT" ? discountPercent : undefined,
        discountAmount: type === "AMOUNT" ? discountAmount : undefined,
        effectiveFrom,
        effectiveTo: effectiveTo || null,
        customerTier: customerTier || null,
        minLineAmount: minLineAmount || undefined,
        priority: parseInt(priority, 10) || 0,
        applicationMode,
        channel,
      });
      return;
    }
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
      campaignId: campaignId ? Number(campaignId) : null,
      applicationMode,
      channel,
      targets: scope === "ALL" ? undefined : targets.map((t) => ({
        categoryId: t.kind === "category" ? t.id : null,
        productId: t.kind === "product" ? t.id : null,
        variantId: null,
      })),
    });
  }

  async function doDeactivate(p: any) {
    const ok = await confirm({
      variant: "warning",
      title: "تعطيل العرض",
      description: `سيتوقّف تطبيق «${p.name}» على مبيعات جديدة فوراً. يمكن إعادة تفعيله لاحقاً.`,
      confirmText: "تعطيل",
    });
    if (!ok) return;
    deactivateM.mutate({ promotionId: Number(p.id) });
  }

  const list = useMemo(() => {
    const today = todayYmd();
    return (listQ.data ?? [])
      .map((p: any) => p)
      .filter((p) => {
        if (channelFilter !== "ALL" && (p.isStoreManaged ? "STORE" : "POS") !== channelFilter) return false;
        if (validityFilter !== "ALL") {
          const from = toYmd(p.effectiveFrom);
          const to = p.effectiveTo ? toYmd(p.effectiveTo) : null;
          const scheduled = from > today;
          const expired = to != null && to < today;
          if (validityFilter === "SCHEDULED" && !scheduled) return false;
          if (validityFilter === "EXPIRED" && !expired) return false;
          if (validityFilter === "CURRENT" && (scheduled || expired)) return false;
        }
        return true;
      });
  }, [listQ.data, channelFilter, validityFilter]);

  return (
    <div className="max-w-6xl mx-auto space-y-4 pb-8">
      <PageHeader
        title="العروض والخصومات"
        description="محرك موحّد لعروض نقطة البيع والمتجر والكوبونات، مرتبط بالحملة وقابل للتدقيق. السعر التعاقدي يفوز دائماً."
        actions={canManage ?
          <Button onClick={() => { if (showForm) { setShowForm(false); resetForm(); } else { resetForm(); setShowForm(true); } }}>
            {showForm ? <><X aria-hidden className="size-4" /> إلغاء</> : <><Plus aria-hidden className="size-4" /> عرض جديد</>}
          </Button> : undefined
        }
      />

      {showForm && (
        <Card>
          <CardHeader><CardTitle className="text-base">{editingId != null ? "تعديل عرض" : "إنشاء عرض جديد"}</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="اسم العرض" required className="md:col-span-3">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="عودة المدارس" dir="auto" />
            </Field>
            <Field label="الوصف (اختياري)" className="md:col-span-3">
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
            </Field>
            <Field label="نوع الخصم" required hint={editingId != null ? "ثابت منذ الإنشاء — أنشئ عرضاً جديداً لتغييره" : undefined}>
              <select value={type} onChange={(e) => setType(e.target.value as PromoType)} disabled={editingId != null} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm disabled:opacity-60">
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
            <Field label="الحملة (اختياري)" hint={editingId != null ? "ثابتة منذ الإنشاء" : undefined}>
              <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} disabled={editingId != null} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm disabled:opacity-60">
                <option value="">عرض مستقل</option>
                {(campaignsQ.data ?? []).map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
              </select>
            </Field>
            <Field label="طريقة التطبيق" hint="الكوبون لا يعمل تلقائياً">
              <select value={applicationMode} onChange={(e) => setApplicationMode(e.target.value as ApplicationMode)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                <option value="AUTO">تلقائي</option>
                <option value="COUPON">بكوبون صالح فقط</option>
              </select>
            </Field>
            <Field label="قناة العرض">
              <select value={channel} onChange={(e) => setChannel(e.target.value as "POS" | "STORE")} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                <option value="POS">نقطة البيع</option>
                <option value="STORE">المتجر الإلكتروني</option>
              </select>
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
            {editingId != null ? (
              <Field label="النطاق" className="md:col-span-3" hint="ثابت منذ الإنشاء — أنشئ عرضاً جديداً لتغيير النطاق أو أهدافه">
                <Badge variant="secondary">{scope === "ALL" ? "جميع المنتجات" : scope === "CATEGORIES" ? "فئات محدَّدة" : "منتجات محدَّدة"}</Badge>
              </Field>
            ) : (
              <>
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
              </>
            )}
            {error && (
              <div className="md:col-span-3 rounded-md border border-[var(--sem-neg)]/30 bg-[var(--sem-neg-bg)] p-3 text-sm flex items-start gap-2">
                <AlertCircle className="size-4 mt-0.5 shrink-0 text-[var(--sem-neg)]" />
                <div>{error}</div>
              </div>
            )}
            <div className="md:col-span-3 flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setShowForm(false); resetForm(); }}>إلغاء</Button>
              <Button onClick={submit} disabled={createM.isPending || updateM.isPending}>
                {createM.isPending || updateM.isPending ? "جارٍ الحفظ…" : editingId != null ? "حفظ التعديلات" : "حفظ العرض"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex items-center justify-between flex-row">
          <CardTitle className="text-base">العروض ({list.length})</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <AppSelect value={channelFilter} onValueChange={(v) => setChannelFilter(v as ChannelFilter)} className="h-8 w-36" size="sm">
              <option value="ALL">كل القنوات</option>
              <option value="POS">نقطة البيع</option>
              <option value="STORE">المتجر الإلكتروني</option>
            </AppSelect>
            <AppSelect value={validityFilter} onValueChange={(v) => setValidityFilter(v as ValidityFilter)} className="h-8 w-36" size="sm">
              <option value="ALL">كل الحالات</option>
              <option value="CURRENT">ساري الآن</option>
              <option value="SCHEDULED">مجدول لاحقاً</option>
              <option value="EXPIRED">منتهٍ تاريخياً</option>
            </AppSelect>
            <label className="text-xs text-muted-foreground flex items-center gap-2">
              <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
              تضمين المعطَّلة
            </label>
          </div>
        </CardHeader>
        <CardContent>
          {list.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-12">لا عروض مطابقة للفلاتر.</div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-right font-medium">الاسم</th>
                    <th className="px-3 py-2 text-right font-medium">النوع</th>
                    <th className="px-3 py-2 text-right font-medium">الخصم</th>
                    <th className="px-3 py-2 text-right font-medium">النطاق</th>
                    <th className="px-3 py-2 text-right font-medium">القناة</th>
                    <th className="px-3 py-2 text-right font-medium">التطبيق</th>
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
                      <td className="px-3 py-2 text-xs">{CHANNEL_LABEL[p.isStoreManaged ? "STORE" : "POS"]}</td>
                      <td className="px-3 py-2 text-xs">{APPLICATION_LABEL[p.applicationMode as string] ?? p.applicationMode}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground" dir="ltr">
                        {toYmd(p.effectiveFrom)} — {p.effectiveTo ? toYmd(p.effectiveTo) : "مستمرّ"}
                      </td>
                      <td className="px-3 py-2">{p.priority}</td>
                      <td className="px-3 py-2">
                        {p.isActive ? <Badge variant="default">نشط</Badge> : <Badge variant="secondary">معطَّل</Badge>}
                      </td>
                      <td className="px-3 py-2 text-left">
                        {canManage && (
                          <div className="flex items-center justify-end gap-1">
                            <Button size="sm" variant="ghost" onClick={() => startEdit(p)}>
                              <FileEdit aria-hidden className="size-3.5" />
                              تعديل
                            </Button>
                            {p.isActive ? (
                              <Button size="sm" variant="ghost" onClick={() => doDeactivate(p)} disabled={deactivateM.isPending}>
                                تعطيل
                              </Button>
                            ) : (
                              <Button size="sm" variant="ghost" onClick={() => reactivateM.mutate({ promotionId: Number(p.id) })} disabled={reactivateM.isPending}>
                                <RotateCcw aria-hidden className="size-3.5" />
                                تفعيل
                              </Button>
                            )}
                          </div>
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
