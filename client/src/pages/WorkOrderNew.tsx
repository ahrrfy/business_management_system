import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { D, fmt, round2 } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

type Mat = { key: number; variantId: number; label: string; baseQuantity: string; costPriceBase: string };

export default function WorkOrderNew() {
  const [, navigate] = useLocation();
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();

  const branches = trpc.branches.list.useQuery();
  const customersQ = trpc.customers.list.useQuery();
  const [branchId, setBranchId] = useState<number | "">("");
  const [customerId, setCustomerId] = useState<number | "">("");
  const [baseVariantId, setBaseVariantId] = useState<number | "">("");
  const [title, setTitle] = useState("");
  const [customizationText, setCustomizationText] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [laborCost, setLaborCost] = useState("0");
  const [salePrice, setSalePrice] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [search, setSearch] = useState("");
  const [matSearch, setMatSearch] = useState("");
  const [mats, setMats] = useState<Mat[]>([]);
  const [seq, setSeq] = useState(1);
  const [error, setError] = useState("");

  // Quick-add customer
  const [showNewCust, setShowNewCust] = useState(false);
  const [newCustName, setNewCustName] = useState("");
  const [newCustPhone, setNewCustPhone] = useState("");

  const effectiveBranch =
    branchId || me.data?.branchId || (branches.data?.[0] ? Number(branches.data[0].id) : 1);

  const baseCatalog = trpc.catalog.forPurchase.useQuery(
    { branchId: Number(effectiveBranch), query: search.trim() || undefined, limit: 30 },
    { enabled: !!effectiveBranch && (search.trim().length > 0 || !!baseVariantId) }
  );
  const matCatalog = trpc.catalog.forPurchase.useQuery(
    { branchId: Number(effectiveBranch), query: matSearch.trim() || undefined, limit: 30 },
    { enabled: !!effectiveBranch && matSearch.trim().length > 0 }
  );

  const baseVariantInfo = useMemo(() => {
    const data = baseCatalog.data ?? [];
    return data.find((r) => r.variantId === baseVariantId && r.isBaseUnit) ?? data.find((r) => r.variantId === baseVariantId);
  }, [baseCatalog.data, baseVariantId]);

  const createCustomer = trpc.customers.create.useMutation({
    onSuccess: async (r) => {
      await utils.customers.list.invalidate();
      setCustomerId(r.id);
      setShowNewCust(false);
      setNewCustName("");
      setNewCustPhone("");
    },
    onError: (e) => setError(e.message),
  });

  const create = trpc.workOrders.create.useMutation({
    onSuccess: async (r) => {
      await utils.workOrders.list.invalidate();
      navigate(`/work-orders/${r.workOrderId}`);
    },
    onError: (e) => setError(e.message),
  });

  function addMat(row: NonNullable<typeof matCatalog.data>[number]) {
    if (!row.isBaseUnit) return; // مواد تُعدّ بالوحدة الأساس
    setMats((prev) => {
      if (prev.some((m) => m.variantId === row.variantId)) return prev;
      return [
        ...prev,
        {
          key: seq,
          variantId: row.variantId,
          label: `${row.productName}${row.variantName ? " — " + row.variantName : row.color ? " — " + row.color : ""} (${row.sku})`,
          baseQuantity: "1",
          costPriceBase: String(row.costPriceBase),
        },
      ];
    });
    setSeq((s) => s + 1);
    setMatSearch("");
  }
  const patchMat = (k: number, patch: Partial<Mat>) => setMats((p) => p.map((m) => (m.key === k ? { ...m, ...patch } : m)));
  const removeMat = (k: number) => setMats((p) => p.filter((m) => m.key !== k));

  const totals = useMemo(() => {
    const matCost = mats.reduce((acc, m) => acc.plus(D(m.costPriceBase).times(D(m.baseQuantity || "0"))), D(0));
    const total = round2(matCost).plus(D(laborCost || "0"));
    return { materialsCost: round2(matCost).toFixed(2), totalCost: round2(total).toFixed(2) };
  }, [mats, laborCost]);

  function submit() {
    setError("");
    if (!effectiveBranch) return setError("اختر الفرع.");
    if (!baseVariantId) return setError("اختر المنتج الأساس.");
    if (!title.trim()) return setError("عنوان الأمر مطلوب.");
    if (!salePrice.trim() || D(salePrice).lte(0)) return setError("سعر البيع مطلوب وموجب.");
    const qty = Math.trunc(Number(quantity || "0"));
    if (!Number.isInteger(qty) || qty <= 0) return setError("الكمية يجب أن تكون عدداً صحيحاً موجباً.");
    for (const m of mats) {
      const q = Math.trunc(Number(m.baseQuantity || "0"));
      if (!Number.isInteger(q) || q <= 0) return setError(`كمية «${m.label}» يجب أن تكون عدداً صحيحاً موجباً.`);
    }
    create.mutate({
      branchId: Number(effectiveBranch),
      customerId: customerId ? Number(customerId) : null,
      baseVariantId: Number(baseVariantId),
      title: title.trim(),
      customizationText: customizationText.trim() || null,
      quantity: qty,
      laborCost: D(laborCost || "0").toFixed(2),
      salePrice: D(salePrice).toFixed(2),
      dueDate: dueDate || null,
      materials: mats.map((m) => ({ variantId: m.variantId, baseQuantity: Math.trunc(Number(m.baseQuantity)) })),
    });
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">أمر شغل جديد</h1>
        <Link href="/work-orders" className="text-sm text-muted-foreground">← رجوع لأوامر الشغل</Link>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">بيانات الأمر</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label>الفرع *</Label>
            <select className={selectCls} value={effectiveBranch} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
              {(branches.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label>العميل (اختياري — مطلوب للبيع الآجل)</Label>
            <div className="flex gap-2">
              <select
                className={selectCls + " flex-1"}
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value ? Number(e.target.value) : "")}
              >
                <option value="">— عميل عابر —</option>
                {(customersQ.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <Button type="button" variant="outline" size="sm" onClick={() => setShowNewCust((v) => !v)}>+</Button>
            </div>
            {showNewCust && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2 pt-2">
                <Input placeholder="اسم العميل *" value={newCustName} onChange={(e) => setNewCustName(e.target.value)} />
                <Input dir="ltr" placeholder="الهاتف" value={newCustPhone} onChange={(e) => setNewCustPhone(e.target.value)} />
                <Button
                  type="button"
                  size="sm"
                  disabled={!newCustName.trim() || createCustomer.isPending}
                  onClick={() => createCustomer.mutate({ name: newCustName.trim(), phone: newCustPhone.trim() || undefined })}
                >
                  {createCustomer.isPending ? "جارٍ…" : "حفظ"}
                </Button>
              </div>
            )}
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label>عنوان الأمر *</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثال: درع تكريم — مناسبة تخرّج" />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label>تفاصيل التخصيص (نقش/طباعة)</Label>
            <Textarea rows={2} value={customizationText} onChange={(e) => setCustomizationText(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">المنتج الأساس</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Label>ابحث عن المنتج (درع، إطار، …)</Label>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="اكتب للبحث…" />
          {search.trim() && (
            <div className="border rounded-md max-h-60 overflow-auto divide-y">
              {(baseCatalog.data ?? []).filter((r) => r.isBaseUnit).map((r) => (
                <button
                  key={r.variantId}
                  type="button"
                  className={`w-full text-right p-2 text-sm hover:bg-accent flex items-center justify-between gap-2 ${baseVariantId === r.variantId ? "bg-accent" : ""}`}
                  onClick={() => { setBaseVariantId(r.variantId); setSearch(""); }}
                >
                  <span>{r.productName}{r.variantName ? ` — ${r.variantName}` : r.color ? ` — ${r.color}` : ""}</span>
                  <span className="text-xs text-muted-foreground font-mono" dir="ltr">{r.sku} · متاح {r.stockBase}</span>
                </button>
              ))}
            </div>
          )}
          {baseVariantInfo && (
            <div className="rounded-md bg-muted/40 p-3 text-sm flex items-center justify-between">
              <div>
                <div className="font-medium">{baseVariantInfo.productName}{baseVariantInfo.variantName ? ` — ${baseVariantInfo.variantName}` : ""}</div>
                <div className="text-xs text-muted-foreground font-mono" dir="ltr">{baseVariantInfo.sku}</div>
              </div>
              <div className="text-xs text-muted-foreground">متاح {baseVariantInfo.stockBase} {baseVariantInfo.unitName}</div>
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1">
              <Label>الكمية *</Label>
              <Input dir="ltr" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>سعر البيع الإجمالي *</Label>
              <Input dir="ltr" value={salePrice} onChange={(e) => setSalePrice(e.target.value)} placeholder="0" />
            </div>
            <div className="space-y-1">
              <Label>تاريخ الاستحقاق</Label>
              <Input type="date" dir="ltr" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">المواد المُستهلَكة من المخزون (اختياري)</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">تُحسب بالوحدة الأساس فقط، وتُخصم من المخزون عند بدء التنفيذ.</p>
          <Input value={matSearch} onChange={(e) => setMatSearch(e.target.value)} placeholder="ابحث عن مادة (حبر، ورق، …)" />
          {matSearch.trim() && (
            <div className="border rounded-md max-h-48 overflow-auto divide-y">
              {(matCatalog.data ?? []).filter((r) => r.isBaseUnit).map((r) => (
                <button
                  key={r.variantId}
                  type="button"
                  className="w-full text-right p-2 text-sm hover:bg-accent flex items-center justify-between gap-2"
                  onClick={() => addMat(r)}
                >
                  <span>{r.productName}{r.variantName ? ` — ${r.variantName}` : ""}</span>
                  <span className="text-xs text-muted-foreground font-mono" dir="ltr">{r.sku} · كلفة {r.costPriceBase}</span>
                </button>
              ))}
            </div>
          )}
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">المادة</th>
                <th className="p-2 w-24">كمية (أساس)</th>
                <th className="p-2 w-32 text-left">كلفة السطر</th>
                <th className="p-2 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {mats.map((m) => (
                <tr key={m.key} className="border-t">
                  <td className="p-2">{m.label}</td>
                  <td className="p-2"><Input dir="ltr" className="h-8" value={m.baseQuantity} onChange={(e) => patchMat(m.key, { baseQuantity: e.target.value })} /></td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(D(m.costPriceBase).times(D(m.baseQuantity || "0")).toFixed(2))}</td>
                  <td className="p-2"><Button variant="ghost" size="sm" onClick={() => removeMat(m.key)}>✕</Button></td>
                </tr>
              ))}
              {mats.length === 0 && (
                <tr><td colSpan={4} className="p-4 text-center text-muted-foreground">لا مواد. أمر طباعة/خدمة صرفة بلا استهلاك مواد.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6 grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <div className="space-y-1">
            <Label>كلفة العمالة</Label>
            <Input dir="ltr" value={laborCost} onChange={(e) => setLaborCost(e.target.value)} placeholder="0" />
          </div>
          <div className="text-sm">
            <div className="text-muted-foreground">كلفة المواد (تقديرية)</div>
            <div className="font-medium tabular-nums" dir="ltr">{totals.materialsCost}</div>
          </div>
          <div className="text-sm">
            <div className="text-muted-foreground">إجمالي الكلفة (مواد + عمالة)</div>
            <div className="font-semibold tabular-nums" dir="ltr">{totals.totalCost}</div>
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={submit} disabled={create.isPending}>{create.isPending ? "جارٍ الحفظ…" : "حفظ الأمر"}</Button>
        <Link href="/work-orders"><Button variant="outline">إلغاء</Button></Link>
      </div>
    </div>
  );
}
