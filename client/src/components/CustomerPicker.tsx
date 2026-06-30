import { balanceOptionText } from "@/components/BalanceBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { D } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import Decimal from "decimal.js";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

type Tier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";

const TIER_LABEL: Record<Tier, string> = { RETAIL: "مفرد", WHOLESALE: "جملة", GOVERNMENT: "حكومي" };
const TIER_KEYS = Object.keys(TIER_LABEL) as Tier[];

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** سطرٌ بسيط label-فوق-حقل لنموذج «إضافة عميل» المنبثق — يربط htmlFor تلقائياً. */
function LabeledField({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

export interface CustomerPickerProps {
  customerId: number | null;
  onCustomerChange: (id: number | null) => void;
  /** ذمة العميل الحالية (إن وجد) لعرضها كشارة بجوار اسمه. */
  balance?: string | null;
}

/**
 * اختيار عميل بـ«بحث خادمي» (S5 ٣٠/٦) بدل تحميل ٥٠٠ عميل عند الإقلاع.
 * - فارغ ⇒ «عميل نقدي» (الافتراضي). اكتب حرفين ⇒ اقتراحات حيّة من smartSearch.
 * - اختر ⇒ يُثبَّت اسم العميل + شارة الذمة + زرّ مسح (X).
 * - زرّ + لإضافة عميل جديد كما كان.
 */
export default function CustomerPicker({ customerId, onCustomerChange, balance }: CustomerPickerProps) {
  const utils = trpc.useUtils();

  // اسم/هاتف للعميل المختار: نَجلبه عبر `customers.get` (تنفيذ واحد بـid، رخيص جداً، cached ٦٠ث).
  const fetchedCustomer = trpc.customers.get.useQuery(
    { customerId: customerId ?? 0 },
    { enabled: customerId != null, staleTime: 60_000 },
  );

  // البحث الخادمي — debounced ٢٠٠ms عبر TanStack Query (المفتاح يتغيّر مع q).
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // إغلاق عند نقرة خارج المركّب.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const trimmed = q.trim();
  const enabled = trimmed.length >= 2 && customerId == null;
  const summary = trpc.customers.smartSearch.useQuery(
    { q: trimmed, limit: 8 },
    { enabled, staleTime: 30_000 },
  );
  const suggestions = useMemo(() => summary.data ?? [], [summary.data]);

  // «إضافة جديد» منبثق (يَبقى كما كان).
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [tier, setTier] = useState<Tier>("RETAIL");
  const [err, setErr] = useState("");

  const create = trpc.customers.create.useMutation({
    onSuccess: async (r) => {
      await utils.customers.smartSearch.invalidate();
      await utils.customers.get.invalidate();
      onCustomerChange(r.id);
      setShowNew(false);
      setName("");
      setPhone("");
      setTier("RETAIL");
      setErr("");
      setQ("");
    },
    onError: (e) => setErr(e.message),
  });

  function pickSuggestion(id: number) {
    onCustomerChange(id);
    setQ("");
    setOpen(false);
  }

  function clearPick() {
    onCustomerChange(null);
    setQ("");
  }

  const selectedName = fetchedCustomer.data?.name ?? null;
  const selectedTier = (fetchedCustomer.data?.defaultPriceTier ?? "RETAIL") as Tier;

  return (
    <div className="space-y-1" ref={wrapRef}>
      <div className="flex items-center justify-between">
        <Label>العميل (اختياري — مطلوب للبيع الآجل)</Label>
        {customerId != null && balance != null && (
          <span
            className={`text-xs rounded-full px-2 py-0.5 ${
              // §٥: مقارنة Decimal لا Number (يتفادى دقّة float على 0.1+0.2 ≠ 0.3).
              D(balance).gt(0) ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"
            }`}
            title="رصيد ذمة العميل"
          >
            ذمة: <span dir="ltr">{D(balance).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber().toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 2 })}</span>
          </span>
        )}
      </div>

      {customerId != null ? (
        // الحالة: عميل مختار ⇒ بطاقة مَختصرة + زرّ مسح + زرّ +.
        <div className="flex gap-2">
          <div className="flex-1 flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 h-9 text-sm">
            <span className="truncate">
              {selectedName ?? `#${customerId}`} <span className="text-muted-foreground">({TIER_LABEL[selectedTier]})</span>
            </span>
            <button
              type="button"
              onClick={clearPick}
              className="text-xs text-muted-foreground hover:text-destructive shrink-0"
              aria-label="إلغاء اختيار العميل (عميل نقدي)"
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setShowNew((v) => !v)}>
            {showNew ? "إلغاء" : "+"}
          </Button>
        </div>
      ) : (
        // الحالة: بلا اختيار ⇒ بحث خادمي. الإقلاع بلا أيّ جَلب (حتى يُكتب حَرفان).
        <div className="relative flex gap-2">
          <Input
            className="flex-1"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            placeholder="عميل نقدي — أو ابحث (اسم/هاتف) للبيع الآجل"
            aria-autocomplete="list"
            aria-expanded={open}
          />
          <Button type="button" variant="outline" size="sm" onClick={() => setShowNew((v) => !v)}>
            {showNew ? "إلغاء" : "+"}
          </Button>

          {open && enabled && (
            <div className="absolute z-20 top-full mt-1 right-0 w-[calc(100%-2.5rem)] rounded-md border bg-popover shadow-md max-h-72 overflow-auto">
              {summary.isLoading && <div className="px-3 py-2 text-sm text-muted-foreground">جارٍ البحث…</div>}
              {!summary.isLoading && suggestions.length === 0 && (
                <div className="px-3 py-2 text-sm text-muted-foreground">لا نتائج — اكتب اسماً/هاتفاً مختلفاً أو أضِف جديداً.</div>
              )}
              {!summary.isLoading && suggestions.length > 0 && (
                <ul className="py-1">
                  {suggestions.map((s) => {
                    const tierKey = (s.defaultPriceTier ?? "RETAIL") as Tier;
                    return (
                      <li key={s.id}>
                        <button
                          type="button"
                          onClick={() => pickSuggestion(s.id)}
                          className="w-full text-right px-3 py-2 hover:bg-accent flex items-center justify-between gap-2"
                        >
                          <span className="truncate">
                            {s.name} ({TIER_LABEL[tierKey]})
                            {balanceOptionText(s.currentBalance, "customer")}
                          </span>
                          {s.phone && <span className="text-[11px] text-muted-foreground shrink-0" dir="ltr">{s.phone}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {showNew && (
        // container query (@container/customer-form): التخطيط responsive لعرض الحاوية لا viewport
        // ⇒ في منبثقة الكاشير الضيّقة (٣٤٠px) عمودٌ واحد، وفي أي حاوية أوسع مستقبلاً ٣ أعمدة
        // تلقائياً. يُصلح bug الأصل (md:grid-cols-4 كان يُفعَّل بعرض النافذة فتنضغط الحقول).
        <div className="@container/customer-form space-y-3 pt-3 border-t">
          <div className="text-xs font-bold text-foreground">عميل جديد</div>
          <div className="grid grid-cols-1 gap-3 @sm/customer-form:grid-cols-3">
            <LabeledField id="cp-newName" label="اسم العميل *">
              <Input id="cp-newName" placeholder="مثلاً: أحمد محمد" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </LabeledField>
            <LabeledField id="cp-newPhone" label="الهاتف">
              <Input id="cp-newPhone" dir="ltr" placeholder="07XXXXXXXXX" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </LabeledField>
            <LabeledField id="cp-newTier" label="فئة السعر">
              <select id="cp-newTier" className={selectCls} value={tier} onChange={(e) => setTier(e.target.value as Tier)}>
                {TIER_KEYS.map((t) => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
              </select>
            </LabeledField>
          </div>
          {err && <p className="text-xs text-destructive">{err}</p>}
          <Button
            type="button"
            className="w-full"
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate({ name: name.trim(), phone: phone.trim() || undefined, defaultPriceTier: tier })}
          >
            {create.isPending ? "جارٍ الحفظ…" : "حفظ العميل"}
          </Button>
        </div>
      )}
    </div>
  );
}
