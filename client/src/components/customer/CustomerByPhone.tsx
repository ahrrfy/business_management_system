/**
 * «العميل بالهاتف» — القسمان اللذان كانا مضمَّنين في شاشة الاستقبال (رقم الهاتف + هوية العميل)
 * مكوّناً قابلاً لإعادة الاستعمال (م١ PR-B): الهاتف مفتاح الهوية، عميلٌ موجود يُربط فوراً، ورقمٌ جديد
 * يفتح الاسم وحده والإنشاءُ تلقائيّ عند «حفظ وربط» (أو Enter) بلا خطوةٍ منفصلة.
 *
 * كلّ الحالة عند الخطّاف `useCustomerByPhone` (يمرَّر كاملاً في `api`) — هذا الملفّ عرضٌ محض.
 */
import type { ReactNode } from "react";
import { BadgeCheck, LoaderCircle, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhoneDigitsInput } from "@/components/form/PhoneDigitsInput";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import { ACTION_LABELS } from "@shared/actionLabels";
import { canSubmitNewCustomer, resolutionNotice } from "./customerByPhoneMachine";
import type { CustomerByPhoneApi } from "./useCustomerByPhone";

const TONE_CLS = {
  muted: "text-muted-foreground",
  warn: "text-[var(--sem-warn)]",
  info: "text-[var(--sem-info)]",
  positive: "text-money-positive",
  destructive: "text-destructive",
} as const;

export interface CustomerByPhoneProps {
  api: CustomerByPhoneApi;
  /** مرآة بوّابة `customers.receptionResolveByPhone` الخادمية — بلاها لا إنشاء. */
  canCreate: boolean;
  /** أرقام الخطوات في رأسَي القسمين (الاستقبال: «٢» و«٣»)؛ يُهمَل حين يغيب. */
  steps?: { phone: string; identity: string } | null;
  /** عنصرٌ إضافيّ في رأس قسم الهوية (الاستقبال: منتقي فئة السعر). */
  identityHeaderExtra?: ReactNode;
  /** يظهر زرّ «الملف» حين يملك القارئ سياق العميل. */
  onOpenProfile?: (customerId: number) => void;
  /** رصيد العميل المربوط إن كان متاحاً للقارئ (الكاشير يعرضه؛ الاستقبال لا يكشف الأرصدة). */
  balance?: string | null;
  /** بادئة معرّفات العناوين (aria-labelledby) — تبقى «reception» في الاستقبال. */
  idPrefix?: string;
}

export function CustomerByPhone({ api, canCreate, steps, identityHeaderExtra, onOpenProfile, balance, idPrefix = "customer-by-phone" }: CustomerByPhoneProps) {
  const notice = resolutionNotice(api);
  const canSubmit = canSubmitNewCustomer(api, { canCreate, pending: api.isPending });
  const submitNewCustomer = () => { void api.resolve(api.customer.name, true); };
  const stepBubble = (n: string) => (
    <span className="grid size-5 place-items-center rounded-full bg-primary text-[10px] font-black text-primary-foreground">{n}</span>
  );

  return (
    <>
      {/* الهاتف هو مفتاح الهوية في كل القنوات، لا حقل تابع لواتساب وحده. */}
      <section className="rounded-lg border bg-card p-2" aria-labelledby={`${idPrefix}-phone-title`}>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {steps && stepBubble(steps.phone)}
            <h2 id={`${idPrefix}-phone-title`} className="text-xs font-black">رقم هاتف العميل</h2>
            <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[9px] font-black text-destructive">إلزامي</span>
          </div>
          {api.resolution === "CHECKING" && (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-muted-foreground">
              <LoaderCircle aria-hidden className="size-3 animate-spin" /> {ACTION_LABELS.verifying}
            </span>
          )}
        </div>
        <PhoneDigitsInput
          value={api.phone}
          onChange={api.setPhone}
          ariaLabel="رقم هاتف العميل العراقي"
          className="max-w-full"
        />
        <div className="mt-1.5 min-h-4 text-[10px] font-semibold">
          {api.resolution !== "CHECKING" && <span className={TONE_CLS[notice.tone]}>{notice.text}</span>}
        </div>
      </section>

      {/* نتيجة واحدة: بطاقة عميل مرتبطة أو حقل الاسم للرقم الجديد. لا قوائم عائمة فوق البحث. */}
      <section className="rounded-lg border bg-card p-2" aria-labelledby={`${idPrefix}-customer-title`}>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {steps && stepBubble(steps.identity)}
            <h2 id={`${idPrefix}-customer-title`} className="text-xs font-black">هوية العميل</h2>
          </div>
          {identityHeaderExtra}
        </div>

        {api.customer.customerId ? (
          <div className="flex min-h-12 items-center gap-2 rounded-md border border-money-positive/40 bg-money-positive/10 px-2.5 py-1.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-money-positive/15 text-money-positive">
              <UserRound aria-hidden className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-xs font-black">{api.customer.name}</span>
                <BadgeCheck aria-label="عميل موثوق" className="size-3.5 shrink-0 text-money-positive" />
              </div>
              <div className="text-[10px] font-semibold text-muted-foreground" dir="ltr">{api.phone}</div>
              <div className={cn("text-[9px] font-bold", api.deferredEligible ? "text-money-positive" : "text-[var(--sem-warn)]")}>
                {api.deferredEligible ? "مرتبط · البيع بدون عربون متاح" : "مرتبط · نقديٌّ فقط (حدّ ائتمانه صفر)"}
              </div>
              {balance != null && (
                <div className="text-[10px] font-bold text-muted-foreground">
                  الرصيد: <span dir="ltr" className="tabular-nums">{fmt(balance)}</span> د.ع
                </div>
              )}
            </div>
            {onOpenProfile && (
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[10px]" onClick={() => onOpenProfile(api.customer.customerId!)}>
                الملف
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="flex min-h-12 items-center gap-1.5">
              <Input
                value={api.customer.name}
                onChange={(event) => api.setCustomerName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canSubmit) {
                    event.preventDefault();
                    submitNewCustomer();
                  }
                }}
                disabled={!api.isValidPhone || api.resolution === "CHECKING"}
                placeholder={api.isValidPhone ? "اسم العميل الجديد" : "أكمل الهاتف أولاً"}
                aria-label="اسم العميل"
                className="h-9 min-w-0 flex-1 text-xs font-bold"
              />
              <Button
                type="button"
                size="sm"
                disabled={!canSubmit}
                onClick={submitNewCustomer}
                className="h-9 shrink-0 px-3 text-[11px] font-black"
              >
                حفظ وربط
              </Button>
            </div>
            {/* «حدّ الائتمان» عند الإنشاء — لكلّ من يملك صلاحية إنشاء عميل الاستقبال (كاشير + مدير).
                الافتراض "0" (نقديّ فقط) لا يُغيَّر إلّا إذا كتب المستعمل قيمة صراحةً. */}
            {api.resolution === "NEEDS_NAME" && canCreate && (
              <div className="flex items-center gap-1.5">
                <Input
                  value={api.creditLimit}
                  onChange={(e) => api.setCreditLimit(e.target.value)}
                  disabled={!api.isValidPhone}
                  placeholder="حدّ ائتمان اختياريّ (اتركه فارغاً للنقديّ فقط)"
                  aria-label="حدّ الائتمان للعميل الجديد"
                  className="h-8 min-w-0 flex-1 text-[11px] tabular-nums"
                  dir="ltr"
                />
                <span className="shrink-0 text-[10px] text-muted-foreground">د.ع</span>
              </div>
            )}
          </div>
        )}
        {!canCreate && (
          <p className="mt-1 text-[10px] font-bold text-destructive">صلاحية ربط عميل الاستقبال غير مفعّلة لهذا الدور.</p>
        )}
      </section>
    </>
  );
}
