/**
 * قسم العميل وفئة السعر في شاشة الاستقبال:
 * يجمع بين «العميل بالهاتف» (CustomerByPhone) وزرّ ونافذة «منتقي العملاء الشامل» (CustomerSelectionDialog).
 * يتيح لكاشير الاستقبال البحث بالاسم أو الهاتف، اختيار عميل، إنشاء عميل سريع، وتطبيق الفئات والبيع الآجل.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import { Users, Sparkles } from "lucide-react";
import { CustomerByPhone } from "@/components/customer/CustomerByPhone";
import type { CustomerByPhoneApi } from "@/components/customer/useCustomerByPhone";
import { CustomerSelectionDialog } from "@/components/pos/CustomerSelectionDialog";
import { CustomerDossierDrawer } from "@/components/crm/CustomerDossierDrawer";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import type { Tier } from "@/components/pos/posShared";
import type { PhoneCustomerTier } from "@/components/customer/customerByPhoneMachine";
import {
  isValidIqMobile,
  toLocalIqMobileDigits,
} from "@/components/form/PhoneDigitsInput";

export interface ReceptionCustomerSectionProps {
  phoneCustomer: CustomerByPhoneApi;
  canCreateCustomer: boolean;
  canReadCustomerContext: boolean;
  effectiveTier: Tier;
  tierOverride: Tier | null;
  setTierOverride: (tier: Tier | null) => void;
  setHydratedAutomaticTier: (tier: Tier | null) => void;
  setDeferred: (deferred: boolean) => void;
  clearCouponIfApplied: () => void;
  setCustomerContextId?: (id: number | null) => void;
}

export function ReceptionCustomerSection({
  phoneCustomer,
  canCreateCustomer,
  canReadCustomerContext,
  effectiveTier,
  tierOverride,
  setTierOverride,
  setHydratedAutomaticTier,
  setDeferred,
  clearCouponIfApplied,
  setCustomerContextId,
}: ReceptionCustomerSectionProps) {
  const [showPicker, setShowPicker] = useState(false);
  const [showDossier, setShowDossier] = useState(false);
  const utils = trpc.useUtils();

  const customerId = phoneCustomer.customer.customerId;

  const fetchedCustomer = trpc.customers.get.useQuery(
    { customerId: customerId ?? 0 },
    { enabled: !!customerId && canReadCustomerContext, staleTime: 60_000 },
  );

  const selectedCustomer =
    fetchedCustomer.data ??
    (customerId
      ? ({
          id: customerId,
          name: phoneCustomer.customer.name,
          phone: phoneCustomer.phone || phoneCustomer.customer.phone || "",
          defaultPriceTier: phoneCustomer.tier ?? "RETAIL",
          creditLimit: phoneCustomer.creditLimit || null,
          currentBalance: null,
          customerType: "فرد",
        } as any)
      : null);

  const handleSelectCustomer = async (
    id: number | null,
    picked?:
      | RouterOutputs["customers"]["smartSearch"][number]
      | RouterOutputs["customers"]["list"][number]
      | null,
  ) => {
    if (id == null) {
      phoneCustomer.resetCustomer();
      setTierOverride(null);
      setHydratedAutomaticTier(null);
      setDeferred(false);
      clearCouponIfApplied();
      return;
    }

    let target = picked;
    if (!target || target.id !== id) {
      try {
        const fetched = await utils.customers.get.fetch({ customerId: id });
        if (fetched) target = fetched as any;
      } catch {
        try {
          const res = await utils.customers.receptionResolveById.fetch({
            customerId: id,
          });
          if (res && res.status === "RESOLVED") {
            target = {
              id: res.customerId,
              name: "",
              phone: "",
              defaultPriceTier: res.defaultPriceTier,
            } as any;
          }
        } catch {
          // ignore
        }
      }
    }

    const name = target?.name ?? "";
    const rawPhone = target?.phone ?? "";
    const localDigits = toLocalIqMobileDigits(rawPhone);
    const phone = isValidIqMobile(localDigits) ? localDigits : "";
    const tier =
      (target?.defaultPriceTier as PhoneCustomerTier | undefined) ?? "RETAIL";
    const creditLimit =
      target?.creditLimit != null ? String(target.creditLimit) : "";
    const isCashOnly = creditLimit !== "" && Number(creditLimit) === 0;
    const deferredEligible = !isCashOnly;

    phoneCustomer.linkCustomer({
      customerId: id,
      name,
      phone,
      tier,
      creditLimit,
      deferredEligible,
    });

    setTierOverride(null);
    setHydratedAutomaticTier(tier as Tier);
    setDeferred(false);
    clearCouponIfApplied();
  };

  return (
    <>
      <CustomerByPhone
        api={phoneCustomer}
        canCreate={canCreateCustomer}
        steps={{ phone: "٢", identity: "٣" }}
        idPrefix="reception"
        onOpenProfile={
          canReadCustomerContext && setCustomerContextId
            ? (id) => setCustomerContextId(id)
            : undefined
        }
        onOpenPicker={() => setShowPicker(true)}
        phoneHeaderExtra={
          <div className="flex items-center gap-1.5">
            {customerId != null && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowDossier(true)}
                className="h-6 gap-1 px-2 text-[10px] font-bold border-primary/30 text-primary hover:bg-primary/10 hover:text-primary shrink-0"
                title="فتح ملف الزبون الشامل 360°"
              >
                <Sparkles className="size-3" aria-hidden />
                <span>360°</span>
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowPicker(true)}
              className="h-6 gap-1 px-2 text-[10px] font-bold border-primary/30 text-primary hover:bg-primary/10 hover:text-primary shrink-0"
              title="بحث في السجل واختيار عميل أو تسجيل عميل جديد"
            >
              <Users className="size-3" aria-hidden />
              بحث في السجل / اختيار عميل
            </Button>
          </div>
        }
        identityHeaderExtra={
          <div className="flex items-center gap-1">
            <span className="text-[9px] font-semibold text-muted-foreground">
              فئة السعر
            </span>
            <AppSelect
              value={effectiveTier}
              onValueChange={(value) => {
                setTierOverride(value as Tier);
                clearCouponIfApplied();
              }}
              aria-label="فئة السعر"
              className="h-7 w-20 text-[10px] font-bold"
            >
              <option value="RETAIL">مفرد</option>
              <option value="WHOLESALE">جملة</option>
              <option value="GOVERNMENT">حكومي</option>
            </AppSelect>
          </div>
        }
      />

      <CustomerSelectionDialog
        open={showPicker}
        onOpenChange={setShowPicker}
        canCreate={canCreateCustomer}
        customerId={customerId}
        selectedCustomer={selectedCustomer}
        effectiveTier={effectiveTier}
        tierOverride={tierOverride}
        onSelectCustomer={handleSelectCustomer}
        onSelectTier={(tier) => {
          setTierOverride(tier);
          clearCouponIfApplied();
        }}
      />

      {customerId != null && (
        <CustomerDossierDrawer
          customerId={customerId}
          open={showDossier}
          onClose={() => setShowDossier(false)}
        />
      )}
    </>
  );
}
