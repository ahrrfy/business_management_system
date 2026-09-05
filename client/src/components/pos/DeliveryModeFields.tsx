/**
 * حقول وضع «توصيل» في كاشير التجزئة (م١ PR-B): المحافظة · العنوان · الجهة · الأجرة · مَن يقبضها ·
 * المستلم — في نفس شاشة البيع. المنطق النقيّ (البناء/التحقّق/الاقتراح) في `deliveryMode.ts`.
 *
 *  - المحافظة من `shared/governorates` والتحصيل من `shared/deliveryFeeCollection` (⛔ لا قاموس محلّيّ).
 *  - اختيار المحافظة يقترح الجهة تلقائياً حين تصل `suggestedPartyId` من الخادم، ويقدّر الأجرة —
 *    «المستخدم يعدّل لا يبتدئ».
 *  - `disabledReason` (الأوفلاين) يُعطّل الحقول ويُعلن السبب: لا إسناد بلا حرّاس الخادم الحيّة.
 */
import { Truck } from "lucide-react";
import { Link } from "wouter";
import { AppSelect } from "@/components/ui/AppSelect";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import {
  DELIVERY_FEE_COLLECTIONS,
  DELIVERY_FEE_COLLECTION_HINT_AR,
  DELIVERY_FEE_COLLECTION_LABEL_AR,
  type DeliveryFeeCollection,
} from "@shared/deliveryFeeCollection";
import {
  DELIVERY_ISSUE_AR,
  applyGovernorateSelection,
  applyPartySelection,
  governorateOptions,
  validateDeliveryDraft,
  type DeliveryDraft,
  type DeliveryPartyOption,
} from "./deliveryMode";

export interface DeliveryModeFieldsProps {
  draft: DeliveryDraft;
  onChange: (next: DeliveryDraft) => void;
  /** الجهة المقترَحة لمحافظة المسوّدة (من `delivery.suggestPartyForZone`) — تُطبَّق عند اختيار المحافظة. */
  suggestedPartyId?: number | null;
  /** سببُ تعطيل الوضع (الأوفلاين): يُعرض ويُعطّل الحقول. */
  disabledReason?: string | null;
}

const LABEL = "mb-1 block text-[10px] font-bold text-muted-foreground";

export function DeliveryModeFields({ draft, onChange, suggestedPartyId = null, disabledReason = null }: DeliveryModeFieldsProps) {
  const disabled = !!disabledReason;
  const partiesQ = trpc.delivery.listParties.useQuery({ activeOnly: true }, { staleTime: 60_000, enabled: !disabled });
  const parties: DeliveryPartyOption[] = (partiesQ.data ?? []).map((p) => ({
    id: Number(p.id),
    name: p.name,
    defaultFee: String(p.defaultFee ?? "0"),
  }));
  const issues = disabled ? [] : validateDeliveryDraft(draft);

  return (
    <section className="space-y-2 rounded-lg border bg-card p-2" aria-label="بيانات التوصيل">
      <div className="flex items-center justify-between gap-2">
        <h2 className="inline-flex items-center gap-1.5 text-xs font-black">
          <Truck aria-hidden className="size-4" /> التوصيل — يُحصَّل عند التسليم
        </h2>
        <Link href="/delivery" className="text-[10px] font-bold text-primary hover:underline">إدارة التوصيل</Link>
      </div>

      {disabledReason && (
        <p role="status" className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-2 py-1 text-[11px] font-bold text-[var(--sem-warn)]">
          {disabledReason}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={LABEL} htmlFor="pos-delivery-governorate">المحافظة</label>
          <AppSelect
            id="pos-delivery-governorate"
            value={draft.governorate}
            onValueChange={(v) => onChange(applyGovernorateSelection(draft, v, { suggestedPartyId, parties }))}
            aria-label="المحافظة"
            className="h-9 text-xs"
            disabled={disabled}
          >
            <option value="">اختر المحافظة</option>
            {governorateOptions().map((g) => (
              <option key={g.value} value={g.value}>{g.label}</option>
            ))}
          </AppSelect>
        </div>
        <div>
          <label className={LABEL} htmlFor="pos-delivery-party">جهة التوصيل</label>
          <AppSelect
            id="pos-delivery-party"
            value={draft.partyId != null ? String(draft.partyId) : ""}
            onValueChange={(v) => onChange(applyPartySelection(draft, parties.find((p) => String(p.id) === v) ?? null))}
            aria-label="جهة التوصيل"
            className="h-9 text-xs"
            disabled={disabled}
          >
            <option value="">{partiesQ.isLoading ? ACTION_LABELS.loading : "اختر مندوباً أو شركة"}</option>
            {parties.map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.name}{p.id === suggestedPartyId ? " — مقترَحة للمنطقة" : ""}
              </option>
            ))}
          </AppSelect>
          {!partiesQ.isLoading && !disabled && parties.length === 0 && (
            <p className="mt-1 text-[10px] font-bold text-[var(--sem-warn)]">
              لا جهات توصيل نشطة — <Link href="/delivery?tab=parties" className="underline">أضِف مندوباً أو شركة</Link> أوّلاً.
            </p>
          )}
        </div>
      </div>

      <div>
        <label className={LABEL} htmlFor="pos-delivery-address">عنوان التوصيل</label>
        <Input
          id="pos-delivery-address"
          value={draft.address}
          onChange={(e) => onChange({ ...draft, address: e.target.value })}
          placeholder="المنطقة والشارع وأقرب نقطة دالّة"
          className="h-9 text-xs"
          disabled={disabled}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={LABEL} htmlFor="pos-delivery-fee">أجرة التوصيل (د.ع)</label>
          <MoneyInput
            id="pos-delivery-fee"
            value={draft.fee}
            // تحرير الأجرة يدوياً يَسِمها feeManual كي لا يطمسها تبديلُ الجهة/المحافظة (تدقيق Codex P1)؛
            // وتفريغُها يُعيدها اشتقاقاً تلقائياً (المستخدم يعدّل لا يبتدئ).
            onChange={(v) => onChange({ ...draft, fee: v, feeManual: v.trim() !== "" })}
            ariaLabel="أجرة التوصيل"
            className="h-9 text-xs"
            disabled={disabled}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="pos-delivery-fee-collection">مَن يقبضها؟</label>
          <AppSelect
            id="pos-delivery-fee-collection"
            value={draft.feeCollection}
            onValueChange={(v) => onChange({ ...draft, feeCollection: v as DeliveryFeeCollection })}
            aria-label="من يقبض أجرة التوصيل"
            className="h-9 text-xs"
            disabled={disabled}
          >
            {DELIVERY_FEE_COLLECTIONS.map((k) => (
              <option key={k} value={k}>{DELIVERY_FEE_COLLECTION_LABEL_AR[k]}</option>
            ))}
          </AppSelect>
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground">{DELIVERY_FEE_COLLECTION_HINT_AR[draft.feeCollection]}</p>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={LABEL} htmlFor="pos-delivery-recipient-name">اسم المستلم</label>
          <Input
            id="pos-delivery-recipient-name"
            value={draft.recipientName}
            onChange={(e) => onChange({ ...draft, recipientName: e.target.value })}
            placeholder="افتراضياً العميل نفسه"
            className="h-9 text-xs"
            disabled={disabled}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="pos-delivery-recipient-phone">هاتف المستلم</label>
          <IntlPhoneInput
            id="pos-delivery-recipient-phone"
            value={draft.recipientPhone}
            onChange={(v) => onChange({ ...draft, recipientPhone: v })}
            ariaLabel="هاتف المستلم"
            className="text-xs"
            disabled={disabled}
          />
        </div>
      </div>

      {issues.length > 0 && (
        <ul className="space-y-0.5 text-[10px] font-bold text-[var(--sem-warn)]" aria-live="polite">
          {issues.map((issue) => <li key={issue}>{DELIVERY_ISSUE_AR[issue]}</li>)}
        </ul>
      )}
    </section>
  );
}
