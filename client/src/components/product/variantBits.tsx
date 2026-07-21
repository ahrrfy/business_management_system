/**
 * variantBits.tsx — قطع عرض صغيرة لشاشة «إضافة منتج بمتغيّرات».
 * كلها رقيقة وتعتمد منطق `lib/variants.ts` النقيّ المُختبَر.
 */
import { useRef, useState, useId, cloneElement, isValidElement, type ChangeEvent, type ReactNode, type ReactElement } from "react";
import { cn } from "@/lib/utils";
import { code128Svg } from "@/lib/printing/barcode";
import { compressImageDataUrl } from "@/components/form/ImageUploader";
import { ArrowLeft } from "lucide-react";
import { marginPercent, toArabicDigits } from "@/lib/variants";
import { resolveColorHex, normalizeHex } from "@shared/colorBank";

/* ── ColorDot — نقطة اللون الحقيقي ─────────────────────── */
/**
 * يعرض اللون الحقيقي: `hex` الصريح (اختيار المستخدم) إن وُجد، وإلّا يُستنتَج من `name` عبر بنك
 * الألوان المشترك، وإلّا رماديّ محايد. هكذا يظهر أيّ لون يُكتَب بلونه الحقيقي تلقائياً.
 */
export function ColorDot({ name, hex, size = 14 }: { name?: string; hex?: string | null; size?: number }) {
  const resolved = normalizeHex(hex) || resolveColorHex(name);
  const bg = resolved || "#cbd5e1";
  return (
    <span
      className="inline-block shrink-0 rounded-full border"
      style={{ width: size, height: size, background: bg, borderColor: "oklch(0 0 0 / .15)" }}
      title={name || resolved || ""}
    />
  );
}

/* ── ColorPickerDot — سواتش قابل للنقر يفتح منتقي لون النظام ─────────────── */
/**
 * يظهر اللون الحالي (المخصّص أو المُستنتَج من الاسم) كسواتش، والنقر يفتح `<input type=color>`.
 * `onChange(hex)` يضبط لوناً مخصّصاً، و«×» يعيد للتلقائي (null ⇒ يُستنتَج من الاسم).
 */
export function ColorPickerDot({
  name,
  hex,
  onChange,
  size = 20,
}: {
  name?: string;
  hex?: string | null;
  onChange: (hex: string | null) => void;
  size?: number;
}) {
  // مرجع منتقي اللون لإدارة التركيز: زرّ «×» يُفكَّك بمجرّد الضغط (يُعرَض فقط مع لونٍ صريح) فيسقط التركيز
  // للـbody — ننقله للمنتقي قبل التفكيك (WCAG 2.4.3 إدارة التركيز).
  const inputRef = useRef<HTMLInputElement>(null);
  const explicit = normalizeHex(hex);
  const resolved = explicit || resolveColorHex(name);
  const current = resolved || "#cbd5e1";
  const inputVal = /^#[0-9a-fA-F]{6}$/.test(current) ? current : "#000000";
  const title = explicit
    ? `لون مخصّص ${current} — انقر لتغييره`
    : resolved
      ? `لون تلقائي ${current} (من الاسم) — انقر لتخصيصه`
      : "لون غير معروف — انقر لضبط لونه الحقيقي";
  return (
    <span className="inline-flex items-center gap-0.5">
      <span
        className="relative inline-block rounded-full border shadow-sm overflow-hidden transition-shadow hover:ring-2 hover:ring-ring/40 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1"
        style={{ width: size, height: size, background: current, borderColor: "oklch(0 0 0 / .2)" }}
        title={title}
      >
        {/* input type=color شفّاف (opacity-0) يُخفي مخطّط تركيزه ⇒ نُظهر التركيز على السواتش الحاوي
            عبر focus-within (WCAG 2.4.7 — تركيز لوحة المفاتيح كان غير مرئيّ). */}
        <input
          ref={inputRef}
          type="color"
          value={inputVal}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          aria-label={`اللون الحقيقي${name ? ` لـ${name}` : ""}`}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </span>
      {explicit && (
        <button
          type="button"
          onClick={() => { onChange(null); inputRef.current?.focus(); }}
          title="عودة للون التلقائي (من اسم اللون)"
          aria-label="إزالة اللون المخصّص"
          className="text-muted-foreground hover:text-destructive leading-none text-sm"
        >
          ×
        </button>
      )}
    </span>
  );
}

/* ── MarginBadge — شارة هامش الربح (عرضيّ) ─────────────── */
export function MarginBadge({ cost, sell, className }: { cost: number | string; sell: number | string; className?: string }) {
  const m = marginPercent(cost, sell);
  if (!m) return null;
  return (
    <span
      dir="rtl"
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
        m.loss ? "bg-destructive/10 text-destructive" : "bg-emerald-500/15 text-emerald-700",
        className
      )}
    >
      {m.loss ? "خسارة" : "ربح"} {toArabicDigits(Math.abs(m.pct))}٪
    </span>
  );
}

/* ── ScanButton — زر محاكاة ماسح الباركود ─────────────── */
export function ScanButton({ onClick, title = "توليد/مسح باركود" }: { onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-md border bg-card hover:bg-accent text-muted-foreground hover:text-primary transition-colors"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
        <path d="M7 7v10M10 7v10M13 7v10M17 7v10" strokeWidth="1.5" />
      </svg>
    </button>
  );
}

/* ── MiniBarcode — معاينة باركود حقيقية (Code128 SVG) ──── */
export function MiniBarcode({ value, height = 38 }: { value: string; height?: number }) {
  if (!value) return <span className="text-xs text-muted-foreground">— لا باركود —</span>;
  let svg: string | null = null;
  try {
    svg = code128Svg(value, { moduleWidth: 1, height, showText: true }).svg;
  } catch {
    svg = null;
  }
  if (!svg) {
    return (
      <span className="font-mono text-[11px] tracking-widest text-foreground/80" dir="ltr">{value}</span>
    );
  }
  return <div className="max-w-full overflow-hidden" dir="ltr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/* ── Field — تسمية + تلميح حول عنصر تحكّم ──────────────── */
export function Field({
  label,
  hint,
  required,
  children,
  className,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  // اربط التسمية بعنصر التحكّم برمجياً (WCAG 1.3.1/4.1.2): احقن id في الابن (إن لم يكن له id)
  // واستعمله في htmlFor + اربط التلميح عبر aria-describedby ⇒ نقر التسمية يُركّز، وقارئ الشاشة يُعلن الاسم.
  const autoId = useId();
  const hintId = hint ? `${autoId}-hint` : undefined;
  const el = isValidElement(children) ? (children as ReactElement<any>) : null;
  const controlId = el ? (el.props.id ?? autoId) : undefined;
  const control = el
    ? cloneElement(el, {
        id: controlId,
        "aria-describedby": [el.props["aria-describedby"], hintId].filter(Boolean).join(" ") || undefined,
      })
    : children;
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={controlId} className="text-sm font-medium leading-none text-foreground/90">
        {label} {required && <span className="text-destructive">*</span>}
      </label>
      {control}
      {hint && <p id={hintId} className="text-[11px] text-muted-foreground leading-snug">{hint}</p>}
    </div>
  );
}

/* ── ChipInput — مُدخل رقائق (ألوان/قياسات) باقتراحات ──── */
export function ChipInput({
  items,
  onChange,
  placeholder,
  presets,
  withDot,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  presets?: string[];
  withDot?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const add = (raw?: string) => {
    const v = (raw ?? draft).trim();
    if (!v) return;
    if (!items.includes(v)) onChange([...items, v]);
    setDraft("");
  };
  const remove = (v: string) => onChange(items.filter((x) => x !== v));
  return (
    <div className="space-y-2">
      <div
        className="flex flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 min-h-9 shadow-sm focus-within:outline focus-within:outline-2 focus-within:outline-ring"
        onClick={(e) => (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.focus()}
      >
        {items.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
            {withDot && <ColorDot name={v} size={11} />}
            {v}
            <button type="button" onClick={() => remove(v)} className="text-muted-foreground hover:text-destructive leading-none" aria-label={`حذف ${v}`}>
              ×
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && !draft && items.length) {
              remove(items[items.length - 1]);
            }
          }}
          placeholder={items.length ? "" : placeholder}
          className="flex-1 min-w-[90px] bg-transparent text-sm outline-none py-0.5"
        />
      </div>
      {presets && presets.some((p) => !items.includes(p)) && (
        <div className="flex flex-wrap gap-1">
          {presets
            .filter((p) => !items.includes(p))
            .map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => add(p)}
                className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                {withDot && <ColorDot name={p} size={10} />}+ {p}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/* ── ImageSlot — صورة مستقلّة لمتغيّر (لون) مع ضغط قبل التخزين ───── */
export function ImageSlot({
  value,
  onChange,
  label = "صورة هذا اللون",
  size = 88,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  label?: string;
  size?: number;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [studioBusy, setStudioBusy] = useState(false);
  const [studioPreview, setStudioPreview] = useState<{ before: string; after: string } | null>(null);
  async function runStudio() {
    if (!value) return;
    setStudioBusy(true);
    try {
      // تحميل كسول لخطّ الاستوديو. المسار الآمن FLATTEN (خلفية بيضاء موحّدة + إطار + ظلّ).
      const { runFreeStudio } = await import("@/lib/imageStudio/freePipeline");
      const r = await runFreeStudio(value, { safeOnly: true });
      setStudioPreview({ before: value, after: r.dataUrl });
    } finally {
      setStudioBusy(false);
    }
  }
  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) {
      setBusy(true);
      try {
        const raw = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result || ""));
          r.onerror = () => rej(r.error);
          r.readAsDataURL(f);
        });
        // ضغط قبل التخزين (نفس مسار صور المنتج) — علاج «قيمة أطول من المسموح».
        const { dataUrl } = await compressImageDataUrl(raw);
        onChange(dataUrl);
      } finally {
        setBusy(false);
      }
    }
    if (ref.current) ref.current.value = "";
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        {/* زرّ حقيقيّ لا div — دعمٌ أصيل للوحة المفاتيح (Enter/Space) + تركيز + اسمٌ متاح (كان div بنقرٍ فقط). */}
        <button
          type="button"
          onClick={() => ref.current?.click()}
          aria-label={value ? "تغيير صورة هذا اللون" : "رفع صورة هذا اللون"}
          className="relative shrink-0 rounded-lg border overflow-hidden cursor-pointer hover:opacity-90 flex items-center justify-center bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{ width: size, height: size }}
        >
          {value ? (
            <img src={value} alt="" className="w-full h-full object-cover" />
          ) : (
            <span className="font-mono text-[9px] text-muted-foreground">+ صورة</span>
          )}
        </button>
        <div className="text-xs text-muted-foreground">
          <div>{label}</div>
          {busy ? (
            <span className="text-primary">جارٍ الضغط…</span>
          ) : value ? (
            <div className="mt-1 flex gap-2">
              <button type="button" onClick={() => onChange(null)} className="text-destructive hover:underline">إزالة</button>
              <button type="button" onClick={runStudio} disabled={studioBusy} className="text-primary hover:underline">
                {studioBusy ? "جارٍ…" : "استوديو"}
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => ref.current?.click()} className="text-primary hover:underline mt-1">رفع صورة</button>
          )}
        </div>
        <input ref={ref} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={pick} />
      </div>
      {studioPreview && (
        <div className="flex items-center gap-2 rounded-md border p-2">
          <img src={studioPreview.after} alt="بعد (استوديو)" className="size-12 rounded border object-contain" style={{ background: "#ffffff" }} />
          <ArrowLeft aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          <img src={studioPreview.before} alt="قبل" className="size-12 rounded border bg-muted object-contain" />
          <button type="button" onClick={() => { onChange(studioPreview.after); setStudioPreview(null); }} className="text-xs text-primary hover:underline">اعتماد</button>
          <button type="button" onClick={() => setStudioPreview(null)} className="text-xs text-muted-foreground hover:underline">إلغاء</button>
        </div>
      )}
    </div>
  );
}
