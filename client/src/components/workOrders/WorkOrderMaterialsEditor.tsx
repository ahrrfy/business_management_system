/**
 * WorkOrderMaterialsEditor — تحرير **بنود** أمر الشغل (إضافة/حذف/تغيير كمّية).
 *
 * الفجوة التي سدّها (بلاغ المالك ١٧/٨/٢٦): لم يكن في النظام أيّ مسارٍ لإضافة منتجٍ لأمر شغلٍ
 * أو حذفه بعد إنشائه — و«الزبائن يعدّلون طلباتهم كثيراً». نمط البحث والإضافة هنا **مطابقٌ
 * لشاشة إنشاء الطلب** (`catalog.posList` + مسح باركود + Enter) عمداً: الموظف لا يتعلّم شيئاً
 * جديداً، وهو جوهر طلب المالك «تصميم مألوف».
 *
 * العقد مع الخادم **تصريحيّ**: نرسل القائمة المطلوبة كاملةً ويشتقّ هو الفروق. لذلك الحفظ
 * idempotent: نقرةٌ مزدوجة أو إعادة إرسالٍ على شبكةٍ متقطّعة لا تُحرّك المخزون مرّتين.
 *
 * الإفصاح قبل الحفظ ليس تزييناً: بعد بدء التنفيذ تكون المواد **استُهلكت فعلاً**، فكل فرقٍ
 * يحرّك المخزون ويُرحَّل قيدَ WIP مُكمِّلاً. الشاشة تقول ذلك صراحةً قبل التأكيد.
 */
import { Plus, Trash2, TriangleAlert } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { BarcodeSearchCue, barcodeSearchInputClass } from "@/components/scan/BarcodeSearchCue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";

export interface EditableMaterial {
  variantId: number;
  baseQuantity: number;
  productName: string;
  sku: string;
}

export interface WorkOrderMaterialsEditorProps {
  workOrderId: number;
  branchId: number;
  orderNumber: string;
  /** حالة الأمر — تحدّد هل للتعديل أثرٌ مخزنيّ (بعد البدء) أم لا. */
  status: string;
  initial: EditableMaterial[];
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}

export function WorkOrderMaterialsEditor({
  workOrderId, branchId, orderNumber, status, initial, onSaved, onCancel,
}: WorkOrderMaterialsEditorProps) {
  const [rows, setRows] = useState<EditableMaterial[]>(initial);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);

  // المواد استُهلكت لحظة «بدء التنفيذ» ⇒ التعديل بعدها يحرّك المخزون والدفتر فعلاً.
  const consumed = status === "IN_PROGRESS" || status === "READY";

  const posList = trpc.catalog.posList.useQuery(
    { branchId, tier: "RETAIL", query: search, limit: 20 },
    { enabled: search.trim().length >= 2, staleTime: 15_000 },
  );

  const setMaterials = trpc.workOrders.setMaterials.useMutation({
    onSuccess: async (res) => {
      notify.ok(
        res.stockAdjusted
          ? `حُفظت البنود — عُدِّل المخزون تبعاً للفرق (كلفة المواد ${res.materialsCost}).`
          : "حُفظت البنود.",
      );
      await onSaved();
    },
    onError: (e) => notify.err(e),
  });

  /** الفرق مقابل الأصل — يُعرَض قبل الحفظ فلا يُفاجأ الموظف بأثرٍ لم يتوقّعه. */
  const diff = useMemo(() => {
    const before = new Map(initial.map((m) => [m.variantId, m.baseQuantity]));
    const after = new Map(rows.map((m) => [m.variantId, m.baseQuantity]));
    const names = new Map([...initial, ...rows].map((m) => [m.variantId, m.productName]));
    const out: Array<{ variantId: number; name: string; from: number; to: number }> = [];
    const ids = Array.from(new Set([...Array.from(before.keys()), ...Array.from(after.keys())]));
    for (const id of ids) {
      const from = before.get(id) ?? 0;
      const to = after.get(id) ?? 0;
      if (from !== to) out.push({ variantId: id, name: names.get(id) ?? `#${id}`, from, to });
    }
    return out;
  }, [initial, rows]);

  function addVariant(r: { variantId: number; productName: string; sku: string }) {
    setRows((prev) => {
      const existing = prev.find((x) => x.variantId === r.variantId);
      if (existing) {
        return prev.map((x) => (x.variantId === r.variantId ? { ...x, baseQuantity: x.baseQuantity + 1 } : x));
      }
      return [...prev, { variantId: r.variantId, baseQuantity: 1, productName: r.productName, sku: r.sku }];
    });
    setSearch("");
    searchRef.current?.focus();
  }

  function setQty(variantId: number, next: number) {
    // الحذف بإسقاط الصنف لا بصفر — مرآةٌ لعقد الخادم (يرفض الكمّية الصفرية صراحةً).
    if (next <= 0) return setRows((prev) => prev.filter((x) => x.variantId !== variantId));
    setRows((prev) => prev.map((x) => (x.variantId === variantId ? { ...x, baseQuantity: Math.trunc(next) } : x)));
  }

  async function save() {
    if (!diff.length) return notify.info("لا تغييرات لحفظها.");
    const lines = diff.map((d) =>
      d.from === 0 ? `إضافة ${d.name} (${d.to})`
      : d.to === 0 ? `حذف ${d.name} (${d.from})`
      : `${d.name}: ${d.from} ← ${d.to}`,
    );
    if (
      !(await confirm({
        variant: consumed ? "danger" : "info",
        title: `حفظ بنود الأمر ${orderNumber}`,
        description: consumed
          ? `${lines.join(" · ")}. الأمر قيد التنفيذ والمواد مخصومةٌ سلفاً ⇒ سيُعدَّل المخزون بالفرق ويُسجَّل قيدٌ مُكمِّل. متابعة؟`
          : `${lines.join(" · ")}. لم يبدأ التنفيذ بعد ⇒ لا أثر على المخزون. متابعة؟`,
        confirmText: "حفظ البنود",
      }))
    ) return;

    setMaterials.mutate({
      workOrderId,
      materials: rows.map((r) => ({ variantId: r.variantId, baseQuantity: r.baseQuantity })),
    });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">تعديل بنود الأمر</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {consumed && (
          <div className="badge-stock-low flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs">
            <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
            <span>
              الأمر قيد التنفيذ والمواد مخصومةٌ من المخزون — كل زيادةٍ تُخصَم إضافةً، وكل نقصٍ يعود للرفّ،
              ويُسجَّل قيدٌ مُكمِّل. لا تعديل صامت.
            </span>
          </div>
        )}

        {/* البحث بنفس نمط شاشة الإنشاء — مسح باركود أو اسم/SKU. */}
        <div className="space-y-1">
          <Label htmlFor="wom-search">أضِف مادة (باركود أو اسم/SKU)</Label>
          <div className="relative">
            <Input
              id="wom-search"
              ref={searchRef}
              value={search}
              dir="auto"
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const first = (posList.data ?? [])[0];
                  if (first) addVariant(first as never);
                }
              }}
              placeholder="امسح الباركود (Enter للإضافة) أو ابحث بالاسم/الـSKU"
              className={barcodeSearchInputClass}
            />
            <BarcodeSearchCue />
          </div>
          {search.trim().length >= 2 && (
            <div className="max-h-56 overflow-auto rounded-md border">
              {(posList.data ?? []).length === 0 && !posList.isFetching && (
                <div className="px-3 py-2 text-xs text-muted-foreground">لا نتائج.</div>
              )}
              {(posList.data ?? []).map((r: any) => (
                <button
                  key={`${r.variantId}-${r.productUnitId}`}
                  type="button"
                  onClick={() => addVariant(r)}
                  className="flex w-full items-center justify-between border-b px-3 py-1.5 text-right text-sm last:border-b-0 hover:bg-accent"
                >
                  <span className="flex flex-col items-start">
                    <span>{r.productName}</span>
                    <span className="text-[11px] text-muted-foreground" dir="ltr">{r.sku} · {r.unitName}</span>
                  </span>
                  <Badge variant="outline" dir="ltr">{r.stockBase} متوفّر</Badge>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-start font-medium">المادة</th>
                <th className="px-3 py-2 text-start font-medium">SKU</th>
                <th className="w-44 px-3 py-2 text-center font-medium">الكمية (أساس)</th>
                <th className="w-12 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.variantId} className="border-t">
                  <td className="px-3 py-2">{m.productName}</td>
                  <td className="px-3 py-2 font-mono text-xs" dir="ltr">{m.sku}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1" dir="ltr">
                      <Button size="sm" variant="outline" className="h-8 w-8 p-0 font-black"
                        aria-label={`أنقص كمية ${m.productName}`}
                        onClick={() => setQty(m.variantId, m.baseQuantity - 1)}>−</Button>
                      <Input dir="ltr" inputMode="numeric" className="h-8 w-20 text-center font-bold tabular-nums"
                        value={String(m.baseQuantity)} aria-label={`كمية ${m.productName}`}
                        onChange={(e) => setQty(m.variantId, parseInt(e.target.value.replace(/[^\d]/g, ""), 10) || 0)} />
                      <Button size="sm" variant="outline" className="h-8 w-8 p-0 font-black"
                        aria-label={`زد كمية ${m.productName}`}
                        onClick={() => setQty(m.variantId, m.baseQuantity + 1)}>+</Button>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <Button size="sm" variant="ghost" aria-label={`احذف ${m.productName}`}
                      onClick={() => setQty(m.variantId, 0)}>
                      <Trash2 aria-hidden className="size-4 text-destructive" />
                    </Button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={4} className="p-6 text-center text-muted-foreground">لا مواد — ابحث أعلاه لإضافة مادة.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {diff.length > 0 && (
          <div className="rounded-md border bg-muted/30 p-3 text-xs">
            <div className="mb-1 font-bold">سيُحفَظ التغيير التالي:</div>
            <ul className="space-y-0.5">
              {diff.map((d) => (
                <li key={d.variantId} className="tabular-nums">
                  {d.from === 0 ? (
                    <span className="flex items-center gap-1"><Plus aria-hidden className="size-3" />{d.name} ({d.to})</span>
                  ) : d.to === 0 ? (
                    <span className="text-destructive">حذف {d.name} ({d.from})</span>
                  ) : (
                    <span>{d.name}: {d.from} ← {d.to}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={setMaterials.isPending || diff.length === 0}>
            {setMaterials.isPending ? "جارٍ الحفظ…" : "حفظ البنود"}
          </Button>
          <Button variant="outline" onClick={onCancel} disabled={setMaterials.isPending}>إلغاء</Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default WorkOrderMaterialsEditor;
