import { useEffect, useRef, useState } from "react";
import { Banknote, Check, FileText, Image as ImageIcon, Palette, Ruler, Truck, Layers } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { confirm } from "@/lib/confirm";
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
  if (d.size.trim()) lines.push(`[المقاس] ${d.size.trim()}`);
  if (d.material.trim()) lines.push(`[الخامة] ${d.material.trim()}`);
  if (d.hasDelivery) lines.push(`[توصيل] ${d.deliveryAddress.trim() || "—"}`);
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
  // لقطة القيمة الأساس عند الفتح — لكشف «تغييرات غير محفوظة» قبل الإغلاق بالخطأ.
  const baselineRef = useRef<string>("");

  useEffect(() => {
    if (open) {
      const init = initial ?? emptyCustomization(productName, price);
      setData(init);
      baselineRef.current = JSON.stringify(init);
    }
  }, [open, productName, price, initial]);

  // حارس فقد البيانات: عند محاولة إغلاق نافذة أمر شغل طويلة وفيها تعديلات، أكّد قبل التجاهل.
  async function requestClose() {
    if (JSON.stringify(data) !== baselineRef.current) {
      const ok = await confirm({
        variant: "warning",
        title: "تجاهل التغييرات؟",
        description: "لديك بيانات غير محفوظة في أمر الشغل. الإغلاق سيتجاهلها.",
        confirmText: "تجاهل والإغلاق",
        cancelText: "متابعة التحرير",
      });
      if (!ok) return;
    }
    onCancel();
  }

  const upd = <K extends keyof CustomizationData>(k: K, v: CustomizationData[K]) =>
    setData((d) => ({ ...d, [k]: v }));

  const today = new Date().toISOString().slice(0, 10);
  const grandWithDelivery = D(price).plus(D(data.deliveryCost || 0));
  const remaining = grandWithDelivery.minus(D(data.deposit || 0));

  const [saveError, setSaveError] = useState<string | null>(null);

  function handleSave() {
    setSaveError(null);
    if (!data.title.trim()) {
      setSaveError("عنوان أمر الشغل مطلوب");
      return;
    }
    // حارس عميل: deposit لا يَتجاوز الإجمالي (إصلاح عدائي ٢٣/٦/٢٦). الـmax على input تَحقّق HTML
    // فقط ولا يَحمي من تَعديل state بَرمجياً ⇒ لو غاب هذا الفحص الخادم سيَرمي عند الإرسال.
    const depD = D(data.deposit || 0);
    if (depD.gt(grandWithDelivery)) {
      setSaveError(`العربون (${fmt(depD.toString())}) يَتجاوز إجمالي الصنف (${fmt(grandWithDelivery.toString())})`);
      return;
    }
    if (depD.lt(0)) {
      setSaveError("العربون لا يَكون سالباً");
      return;
    }
    onSave(data);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) void requestClose(); }}>
      <DialogContent dir="rtl" className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Palette aria-hidden className="size-5 text-violet-600" />
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
              <Label htmlFor="cz-size" className="text-xs inline-flex items-center gap-1">
                <Ruler aria-hidden className="size-3.5" /> المقاس
              </Label>
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
              <Label htmlFor="cz-material" className="text-xs inline-flex items-center gap-1">
                <Layers aria-hidden className="size-3.5" /> الخامة
              </Label>
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
              <Label htmlFor="cz-due" className="text-xs">موعد التسليم</Label>
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
              <Truck aria-hidden className="size-4" /> توصيل للعميل
            </label>
            {data.hasDelivery && (
              <div className="grid grid-cols-3 gap-2 pt-1">
                <Input
                  value={data.deliveryAddress}
                  onChange={(e) => upd("deliveryAddress", e.target.value)}
                  placeholder="عنوان التوصيل"
                  className="text-sm col-span-2"
                />
                <MoneyInput
                  value={data.deliveryCost}
                  onChange={(v) => upd("deliveryCost", v)}
                  placeholder="تكلفة التوصيل"
                  className="text-sm"
                  ariaLabel="تكلفة التوصيل"
                />
              </div>
            )}
          </div>

          {/* نصّ التخصيص */}
          <div className="space-y-1.5">
            <Label htmlFor="cz-text" className="text-xs inline-flex items-center gap-1">
              <FileText aria-hidden className="size-3.5" /> نصّ التخصيص / تفاصيل العمل المطلوب
            </Label>
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
              <span className="inline-flex items-center gap-1">
                <ImageIcon aria-hidden className="size-3.5" /> صور النموذج / المرفقات
              </span>
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
              <Label htmlFor="cz-deposit" className="text-xs inline-flex items-center gap-1">
                <Banknote aria-hidden className="size-3.5" /> العربون المدفوع الآن
              </Label>
              <MoneyInput
                id="cz-deposit"
                value={data.deposit}
                onChange={(v) => upd("deposit", v)}
                className="text-sm"
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

        {saveError && (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs font-bold text-destructive">
            {saveError}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onCancel} size="sm">إلغاء</Button>
          <Button onClick={handleSave} size="sm" disabled={!data.title.trim()} className="inline-flex items-center gap-1">
            <Check aria-hidden className="size-4" /> حفظ التخصيص
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
