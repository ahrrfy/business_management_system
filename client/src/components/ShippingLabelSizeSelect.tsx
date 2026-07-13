// منتقي قياس «ملصق الشحن» — إعداد واحد محفوظ محلياً يسري على كل شاشات الطباعة
// (طلبات المتجر/التوصيل/أوامر الشغل). قوالب شائعة + «مخصّص…» بصيغة «عرض×ارتفاع» بالمم.
import { useState } from "react";
import { Ruler } from "lucide-react";
import { Input } from "@/components/ui/input";
import { notify } from "@/lib/notify";
import {
  getSavedShippingLabelSize,
  parseShippingLabelSize,
  saveShippingLabelSize,
  shippingLabelSizeKey,
  SHIPPING_LABEL_MM_MAX,
  SHIPPING_LABEL_MM_MIN,
  SHIPPING_LABEL_PRESETS,
} from "@/lib/printing/shippingLabelSize";

const CUSTOM = "custom";

export function ShippingLabelSizeSelect({ className }: { className?: string }) {
  const [size, setSize] = useState(getSavedShippingLabelSize);
  const key = shippingLabelSizeKey(size);
  const isPreset = SHIPPING_LABEL_PRESETS.some((p) => p.key === key);
  const [custom, setCustom] = useState(!isPreset);
  const [draft, setDraft] = useState(key);

  const applyDraft = () => {
    const parsed = parseShippingLabelSize(draft);
    if (!parsed) {
      notify.err(`قياس غير صالح — اكتب «عرض×ارتفاع» بالمم (${SHIPPING_LABEL_MM_MIN}–${SHIPPING_LABEL_MM_MAX})، مثل 90x130`);
      setDraft(shippingLabelSizeKey(size));
      return;
    }
    saveShippingLabelSize(parsed);
    setSize(parsed);
    setDraft(shippingLabelSizeKey(parsed));
    notify.ok(`قياس ملصق الشحن: ${parsed.widthMm}×${parsed.heightMm} مم`);
  };

  return (
    <div className={`flex items-center gap-1.5 ${className ?? ""}`}>
      <Ruler aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <label className="sr-only" htmlFor="shipping-label-size">قياس ملصق الشحن</label>
      <select
        id="shipping-label-size"
        title="قياس ملصق الشحن (يسري على كل شاشات الطباعة)"
        className="h-9 rounded-md border bg-transparent px-2 text-xs font-bold"
        value={custom ? CUSTOM : key}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setCustom(true);
            setDraft(shippingLabelSizeKey(size));
            return;
          }
          const preset = SHIPPING_LABEL_PRESETS.find((p) => p.key === e.target.value);
          if (!preset) return;
          setCustom(false);
          saveShippingLabelSize(preset.size);
          setSize(preset.size);
          setDraft(preset.key);
        }}
      >
        {SHIPPING_LABEL_PRESETS.map((p) => (
          <option key={p.key} value={p.key}>ملصق {p.label}</option>
        ))}
        <option value={CUSTOM}>قياس مخصّص…</option>
      </select>
      {custom && (
        <Input
          dir="ltr"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={applyDraft}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyDraft(); } }}
          placeholder="90x130"
          aria-label="قياس مخصّص (عرض×ارتفاع بالمم)"
          className="h-9 w-24 text-center text-xs font-bold tabular-nums"
        />
      )}
    </div>
  );
}
