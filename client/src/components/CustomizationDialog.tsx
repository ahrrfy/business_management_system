import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { D, fmt } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * نافذة التخصيص — تجمع مواصفات أمر الشغل لصنف مخصّص في سلّة الاستقبال.
 *
 * المخرج: {title, customizationText, priority, dueDate, hasDelivery, deliveryAddress, deliveryCost,
 *          designImages[], deposit}. السعر يبقى من سعر الصنف (لا يُتغيّر من هنا).
 *
 * المقاس/الخامة يُحفظان كسطرين مهيكلَين في صدر `customizationText` ⇒ تظهران كرقائق في السلّة وفي
 * بطاقة الطابور بلا حقول جديدة في الـschema.
 */
export type CustomizationData = {
  title: string;
  size: string;
  material: string;
  customizationText: string;
  priority: "LOW" | "NORMAL" | "URGENT";
  dueDate: string; // YYYY-MM-DD
  hasDelivery: boolean;
  deliveryAddress: string;
  deliveryCost: string;
  designImages: ImageItem[];
  deposit: string;
};

export function emptyCustomization(productName: string, price: string): CustomizationData {
  return {
    title: productName,
    size: "",
    material: "",
    customizationText: "",
    priority: "NORMAL",
    dueDate: "",
    hasDelivery: false,
    deliveryAddress: "",
    deliveryCost: "0",
    designImages: [],
    deposit: price,
  };
}

/** تركيب نصّ التخصيص النهائي مع رؤوس مهيكلة (مقاس/خامة/توصيل) + ملاحظة العميل. */
export function composeCustomizationText(d: CustomizationData): string {
  const lines: string[] = [];
  if (d.size.trim()) lines.push(`📐 ${d.size.trim()}`);
  if (d.material.trim()) lines.push(`🧱 ${d.material.trim()}`);
  if (d.hasDelivery) lines.push(`🚚 توصيل${d.deliveryAddress.trim() ? ` — ${d.deliveryAddress.trim()}` : ""}`);
  if (d.customizationText.trim()) {
    if (lines.length) lines.push("---");
    lines.push(d.customizationText.trim());
  }
  return lines.join("\n");
}

const SIZE_CHIPS = ["A4", "A3", "A5", "1×3 م", "2×3 م", "1×2 م", "50×70 سم"];
const MATERIAL_CHIPS = ["فينيل لامع 340غ", "ستيكر شفاف 500", "كرتون لامع 300غ", "فلكس 510غ", "أكريليك"];
const PRIORITIES: { v: CustomizationData["priority"]; label: string; cls: string }[] = [
  { v: "LOW", label: "منخفض", cls: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30 hover:bg-emerald-500/20" },
  { v: "NORMAL", label: "عادي", cls: "bg-sky-500/10 text-sky-700 border-sky-500/30 hover:bg-sky-500/20" },
  { v: "URGENT", label: "عاجل", cls: "bg-destructive/10 text-destructive border-destructive/30 hover:bg-destructive/20" },
];

interface Props {
  open: boolean;
  productName: string;
  price: string;
  initial?: CustomizationData;
  onCancel: () => void;
  onSave: (data: CustomizationData) => void;
}

export function CustomizationDialog({ open, productName, price, initial, onCancel, onSave }: Props) {
  const [data, setData] = useState<CustomizationData>(() => initial ?? emptyCustomization(productName, price));

  useEffect(() => {
    if (open) setData(initial ?? emptyCustomization(productName, price));
  }, [open, productName, price, initial]);

  const upd = <K extends keyof CustomizationData>(k: K, v: CustomizationData[K]) =>
    setData((d) => ({ ...d, [k]: v }));

  const today = new Date().toISOString().slice(0, 10);
  const grandWithDelivery = D(price).plus(D(data.deliveryCost || 0));
  const remaining = grandWithDelivery.minus(D(data.deposit || 0));

  function handleSave() {
    if (!data.title.trim()) return;
    onSave(data);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent dir="rtl" className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="text-lg" aria-hidden>🎨</span>
            تخصيص: {productName}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* العنوان */}
          <div className="space-y-1.5">
            <Label htmlFor="cz-title" className="text-xs">عنوان أمر الشغل *</Label>
            <Input
              id="cz-title"
              value={data.title}
              onChange={(e) => upd("title", e.target.value)}
              placeholder="مثال: بنر افتتاح 3 متر"
              className="text-sm"
            />
          </div>

          {/* المقاس + الخامة */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cz-size" className="text-xs">📐 المقاس</Label>
              <Input
                id="cz-size"
                value={data.size}
                onChange={(e) => upd("size", e.target.value)}
                placeholder="1×3 م"
                className="text-sm"
              />
              <div className="flex flex-wrap gap-1.5 pt-1">
                {SIZE_CHIPS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => upd("size", s)}
                    className="px-2 py-0.5 text-[11px] border rounded-md bg-muted/40 hover:bg-muted"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cz-material" className="text-xs">🧱 الخامة</Label>
              <Input
                id="cz-material"
                value={data.material}
                onChange={(e) => upd("material", e.target.value)}
                placeholder="فينيل لامع 340غ"
                className="text-sm"
              />
              <div className="flex flex-wrap gap-1.5 pt-1">
                {MATERIAL_CHIPS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => upd("material", m)}
                    className="px-2 py-0.5 text-[11px] border rounded-md bg-muted/40 hover:bg-muted"
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* الأولوية + موعد التسليم */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">الأولوية</Label>
              <div className="flex gap-1.5">
                {PRIORITIES.map((p) => (
                  <button
                    key={p.v}
                    type="button"
                    onClick={() => upd("priority", p.v)}
                    className={cn(
                      "flex-1 px-3 py-1.5 text-xs font-bold border rounded-md transition-colors",
                      p.cls,
                      data.priority === p.v ? "ring-2 ring-offset-1" : "opacity-70",
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cz-due" className="text-xs">⏱ موعد التسليم</Label>
              <Input
                id="cz-due"
                type="date"
                min={today}
                value={data.dueDate}
                onChange={(e) => upd("dueDate", e.target.value)}
                className="text-sm"
                dir="ltr"
              />
            </div>
          </div>

          {/* التوصيل */}
          <div className="space-y-2 rounded-lg border p-3 bg-muted/30">
            <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer select-none">
              <input
                type="checkbox"
                checked={data.hasDelivery}
                onChange={(e) => upd("hasDelivery", e.target.checked)}
                className="size-4"
              />
              🚚 توصيل للعميل
            </label>
            {data.hasDelivery && (
              <div className="grid grid-cols-3 gap-2 pt-1">
                <Input
                  value={data.deliveryAddress}
                  onChange={(e) => upd("deliveryAddress", e.target.value)}
                  placeholder="عنوان التوصيل"
                  className="text-sm col-span-2"
                />
                <Input
                  type="number"
                  min="0"
                  value={data.deliveryCost}
                  onChange={(e) => upd("deliveryCost", e.target.value)}
                  placeholder="تكلفة التوصيل"
                  className="text-sm tabular-nums"
                  dir="ltr"
                />
              </div>
            )}
          </div>

          {/* نصّ التخصيص */}
          <div className="space-y-1.5">
            <Label htmlFor="cz-text" className="text-xs">📝 نصّ التخصيص / تفاصيل العمل المطلوب</Label>
            <Textarea
              id="cz-text"
              value={data.customizationText}
              onChange={(e) => upd("customizationText", e.target.value)}
              placeholder="مثال: تصميم الافتتاح الكبير + خصومات 30% + شعار المطعم + موقع وهاتف."
              rows={4}
              className="text-sm resize-y"
            />
          </div>

          {/* صور النموذج */}
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center justify-between">
              <span>🖼 صور النموذج / المرفقات</span>
              <span className="text-[10px] text-muted-foreground font-normal">حد أقصى ١٠ صور</span>
            </Label>
            <ImageUploader value={data.designImages} onChange={(v) => upd("designImages", v)} maxItems={10} />
          </div>

          {/* العربون والمتبقّي */}
          <div className="rounded-lg border bg-primary/5 p-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">إجمالي الصنف{data.hasDelivery && " + التوصيل"}:</span>
              <span className="font-bold tabular-nums" dir="ltr">{fmt(grandWithDelivery.toString())} د.ع</span>
            </div>
            <div className="space-y-1">
              <Label htmlFor="cz-deposit" className="text-xs">💵 العربون المدفوع الآن</Label>
              <Input
                id="cz-deposit"
                type="number"
                min="0"
                max={grandWithDelivery.toString()}
                value={data.deposit}
                onChange={(e) => upd("deposit", e.target.value)}
                className="text-sm tabular-nums"
                dir="ltr"
              />
            </div>
            <div className="flex items-center justify-between text-xs pt-1 border-t">
              <span className="text-muted-foreground">المتبقّي بعد العربون:</span>
              <Badge variant={remaining.lte(0) ? "default" : "secondary"} className="font-bold tabular-nums" dir="ltr">
                {fmt(remaining.toString())} د.ع
              </Badge>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onCancel} size="sm">إلغاء</Button>
          <Button onClick={handleSave} size="sm" disabled={!data.title.trim()}>
            ✓ حفظ التخصيص
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
