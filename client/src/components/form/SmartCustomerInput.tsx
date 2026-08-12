import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { BalanceBadge } from "@/components/BalanceBadge";
import { trpc } from "@/lib/trpc";
import { fmtDate } from "@/lib/date";
import { cn } from "@/lib/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

/**
 * حقل عميل ذكي — v3-add-screens.
 *
 * - يكتب الاسم/الرقم ⇒ يجلب اقتراحات حيّة من العملاء المسجّلين.
 * - عند اختيار عميل: يعرض إحصاءات (عدد الطلبات، آخر طلب، إجمالي الإنفاق إن توفّر).
 * - عند عدم وجود تطابق: يقترح «إنشاء عميل جديد بهذا الاسم/الرقم» — يحفظ تلقائياً
 *   عند الحفظ النهائي لأمر الشغل (لا يحفظ فوراً لتجنّب إنشاء عملاء بلا اكتمال).
 *
 * العقد:
 *  - selected: العميل المختار (id موجود)، أو null إن كان «جديد» أو غير مختار بعد.
 *  - draft: في حال عميل جديد، الاسم والهاتف القابلَين للحفظ التلقائي عند الإرسال.
 */

export interface SmartCustomerValue {
  /** id حقيقي إن اختير عميل قائم. null = جديد / لا شيء. */
  customerId: number | null;
  /** اسم معروض (من العميل القائم أو من الإدخال). */
  name: string;
  /** هاتف معروض (إن وُجد). */
  phone: string | null;
  /** علم «عميل جديد سيُحفظ تلقائياً». */
  isNew: boolean;
}

export interface SmartCustomerInputProps {
  value: SmartCustomerValue;
  onChange: (v: SmartCustomerValue) => void;
  placeholder?: string;
  className?: string;
  /** وضع «الاسم فقط» (طلب المالك): حين يُدار الهاتف خارجياً (قناة واتساب/اتصال عبر حقل ١١ خانة
   *  منفصل)، يعرض هذا المكوّن حقلَ **اسمٍ واحداً** نظيفاً (بمسافات) بلا بحثٍ ولا حقلٍ ثانٍ مكرّر —
   *  يزيل ازدواج «حقلين بنفس الاسم». المطابقة بالهاتف تتمّ خارجياً في شاشة الاستقبال. */
  nameOnly?: boolean;
}

interface CustomerSummary {
  id: number;
  name: string;
  phone: string | null;
  orderCount?: number | null;
  lastOrderAt?: string | null;
  totalSpent?: string | null;
  /** الرصيد الجاري (مقنَّع خادمياً لغير المدير — يعود "0" فيُخفي BalanceBadge). */
  currentBalance?: string | null;
  isVip?: boolean;
  isFrequent?: boolean;
}

const looksLikePhone = (text: string) => {
  const compact = text.replace(/[\s()+-]/g, "");
  return /^\d{6,15}$/.test(compact);
};

export function SmartCustomerInput({ value, onChange, placeholder, className, nameOnly }: SmartCustomerInputProps) {
  const [q, setQ] = useState(value.name || "");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setQ(value.name || "");
  }, [value.customerId, value.name]);

  // إغلاق عند نقرة خارج المركّب.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // البحث — مُلجم بـ200ms عبر TanStack Query (مفتاح يتغيّر مع q).
  const trimmed = q.trim();
  const enabled = trimmed.length >= 2;
  const summary = trpc.customers.smartSearch.useQuery(
    { q: trimmed, limit: 6 },
    { enabled, staleTime: 30_000 }
  );

  const suggestions = (summary.data ?? []) as CustomerSummary[];

  useEffect(() => {
    if (!value.isNew || !value.phone) return;
    const digits = value.phone.replace(/\D/g, "");
    const exact = suggestions.find((candidate) => (candidate.phone ?? "").replace(/\D/g, "") === digits);
    if (exact) selectCustomer(exact);
  // selectCustomer intentionally uses the current onChange; suggestions are the trigger.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestions, value.isNew, value.phone]);

  const noMatch = enabled && !summary.isLoading && suggestions.length === 0;

  function selectCustomer(c: CustomerSummary) {
    onChange({ customerId: c.id, name: c.name, phone: c.phone, isNew: false });
    setQ(c.name);
    setOpen(false);
  }

  function selectAsNew() {
    const phone = looksLikePhone(trimmed) ? trimmed : null;
    onChange({ customerId: null, name: trimmed, phone, isNew: true });
    setOpen(false);
  }

  function clear() {
    onChange({ customerId: null, name: "", phone: null, isNew: false });
    setQ("");
  }

  const selectedExisting = value.customerId && !value.isNew;
  const selectedStats = selectedExisting
    ? suggestions.find((s) => s.id === value.customerId) || null
    : null;

  // تمييز التطابق (matching) داخل النصّ.
  const renderName = (name: string) => {
    if (!trimmed) return name;
    const idx = name.toLowerCase().indexOf(trimmed.toLowerCase());
    if (idx < 0) return name;
    return (
      <>
        {name.slice(0, idx)}
        <mark className="bg-primary/20 text-foreground rounded px-0.5">{name.slice(idx, idx + trimmed.length)}</mark>
        {name.slice(idx + trimmed.length)}
      </>
    );
  };

  /**
   * ما يُعرَض في حقل «اسم العميل» للعميل الجديد: فارغٌ ما دام الاسم مطابقاً للرقم (أي أنّ
   * المستخدم كتب رقماً ولم يُسمِّ بعد)، وإلّا الاسم نفسه.
   *
   * مُستخرَجٌ خارج JSX عمداً: تركُه تعبيراً داخل `value={…}` يجعل ذكرَ `value.phone` فيه —
   * وهو مجرّد **مقارنة** لا قيمةُ الحقل — يُطابق إشارةَ الهاتف في
   * `scripts/check-form-inputs.mjs` فيُبلَّغ حقلُ الاسم زوراً كحقل هاتفٍ خام. الاستخراج
   * يزيل الإشارة المضلِّلة بلا إضعاف الحارس وبلا أي تغيير سلوكيّ.
   */
  const displayedNewCustomerName = value.name === value.phone ? "" : value.name;

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <div className="relative">
        <Input
          value={q}
          onChange={(e) => {
            const v = e.target.value;
            setQ(v);
            setOpen(true);
            // أي تعديل يصبح مسوّدة فعلية للحفظ. الرقم يُحفظ كهاتف لا كاسم صامت.
            // nameOnly (قناة): الهاتف مُدار خارجياً (حقل ١١ خانة) ⇒ لا نلتقطه من هذا الحقل بل نُبقيه؛
            // ويبقى **البحث الذكيّ فعّالاً** فالكتابة تجد العملاء السابقين وتربطهم (يمنع ازدواج العميل).
            const typed = v.trim();
            const extPhone = value.phone;
            const phone = nameOnly ? extPhone : looksLikePhone(typed) ? typed : null;
            onChange({
              customerId: null,
              name: v,
              phone,
              isNew: typed.length > 0 || (nameOnly === true && !!extPhone),
            });
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder || "ابحث بالاسم أو الرقم — يتعرّف على العملاء السابقين"}
          aria-autocomplete="list"
          aria-expanded={open}
        />
        {value.customerId && (
          <button
            type="button"
            onClick={clear}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-destructive"
            aria-label="مسح اختيار العميل"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        )}
      </div>

      {open && enabled && (
        <div className="absolute z-20 top-full mt-1 w-full rounded-md border bg-popover shadow-md max-h-72 overflow-auto">
          {summary.isLoading && <div className="px-3 py-2 text-sm text-muted-foreground">جارٍ البحث…</div>}

          {!summary.isLoading && suggestions.length > 0 && (
            <ul className="py-1">
              {suggestions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => selectCustomer(s)}
                    className="w-full text-right px-3 py-2 hover:bg-accent flex items-center justify-between gap-2"
                  >
                    <div className="flex flex-col items-start min-w-0">
                      <span className="text-sm font-medium truncate max-w-[200px]">{renderName(s.name)}</span>
                      {s.phone && <span className="text-[11px] text-muted-foreground" dir="ltr">{s.phone}</span>}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {s.isVip && <Badge variant="default" className="text-[10px] bg-amber-500 hover:bg-amber-500">VIP</Badge>}
                      {s.isFrequent && !s.isVip && <Badge variant="secondary" className="text-[10px]">متكرّر</Badge>}
                      {typeof s.orderCount === "number" && (
                        <Badge variant="outline" className="text-[10px]" dir="ltr">
                          {s.orderCount} طلب
                        </Badge>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {noMatch && (
            <button
              type="button"
              onClick={selectAsNew}
              className="w-full text-right px-3 py-2 hover:bg-accent text-sm flex items-center justify-between gap-2"
            >
              <span>
                لا يوجد عميل بهذا الاسم — <span className="text-primary font-medium">إنشاء «{trimmed}» كعميل جديد</span>
              </span>
              <Badge variant="outline" className="text-[10px]">جديد</Badge>
            </button>
          )}
        </div>
      )}

      {/* بطاقة إحصائيّة للعميل المختار. G2 (١١/٨): شارة الرصيد الجاري تُعرض عبر BalanceBadge
          الموحَّد — «لنا عليه ٤٥٠٠ د.ع» أو «له علينا» بلونٍ دلاليّ. مقنَّع خادمياً لغير المدير
          (maskCustomerSensitive في server/lib/redact.ts:63 يعيد "0") ⇒ BalanceBadge لا يعرض
          الشارة عند 0 (بلا showZero)، فالكاشير آمنٌ من رؤية أرقام الذمم. */}
      {selectedExisting && selectedStats && (
        <div className="mt-2 rounded-md border bg-muted/30 p-2 flex flex-wrap items-center gap-3 text-xs">
          <BalanceBadge amount={selectedStats.currentBalance} entityType="customer" />
          <span><span className="text-muted-foreground">الطلبات:</span> <span dir="ltr">{selectedStats.orderCount ?? 0}</span></span>
          {selectedStats.lastOrderAt && (
            <span>
              <span className="text-muted-foreground">آخر طلب:</span> <span dir="ltr">{fmtDate(selectedStats.lastOrderAt)}</span>
            </span>
          )}
          {selectedStats.totalSpent && (
            <span>
              <span className="text-muted-foreground">إجمالي الإنفاق:</span>{" "}
              <span dir="ltr">{Number(selectedStats.totalSpent).toLocaleString("en-US")}</span> د.ع
            </span>
          )}
        </div>
      )}

      {/* الصندوق الرئيسي يلتقط رقماً أو اسماً — لا كليهما معاً. إن كتب المستخدم رقماً (فصار
          الرقم هو نفسه المعروض كـname بلا تمييز) نعرض حقلاً ثانياً صريحاً لاسم العميل، حتى لا
          يُحفظ عميلٌ جديد باسم هو رقم هاتفه فعلياً. */}
      {!nameOnly && value.isNew && !value.customerId && value.phone && (
        <div className="mt-2 space-y-1">
          <label htmlFor="smart-customer-name" className="text-[11px] font-medium text-muted-foreground">
            اسم العميل (اختياري)
          </label>
          <Input
            id="smart-customer-name"
            value={displayedNewCustomerName}
            onChange={(e) => onChange({ ...value, name: e.target.value || value.phone! })}
            placeholder="اكتب اسم العميل"
            className="h-8 text-xs"
          />
        </div>
      )}

      {value.isNew && !value.customerId && trimmed && (
        <div className="mt-2 text-[11px] text-primary">
          سيُحفظ «{value.name}» تلقائياً كعميل جديد عند حفظ الأمر.
        </div>
      )}
    </div>
  );
}
