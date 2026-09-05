/**
 * قسم العميل في وضع «توصيل» بكاشير التجزئة (م١ PR-B): يستبدل «عميل نقدي»/منتقي العميل بآلة
 * «العميل بالهاتف» المشتركة مع الاستقبال — الهاتف ⇒ يُربط/يُنشأ تلقائياً ⇒ يُبلَّغ الأب بالهوية
 * كي يضبط `customerId` التبويب ويملأ المستلم افتراضياً.
 *
 * يُركَّب بمفتاح التبويب (`key={tab.id}`) فتبقى حالة البحث لكلّ تبويبٍ مستقلّة، ويُستأنف الرقم
 * من مسوّدة التبويب عند العودة إليه.
 */
import { useEffect, useRef } from "react";
import { CustomerByPhone } from "@/components/customer/CustomerByPhone";
import { useCustomerByPhone } from "@/components/customer/useCustomerByPhone";
import type { PhoneCustomerTier } from "@/components/customer/customerByPhoneMachine";
import { trpc } from "@/lib/trpc";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";

/** مرآة بوّابة `customers.receptionResolveByPhone` (customerReceptionCreateAllowed في server/trpc.ts):
 *  crm=FULL (الأدوار القياسية) **أو** workorders=FULL (بوّابة محطة الاستقبال) — نفس قائمتَي الاستقبال. */
const CUSTOMER_CREATE_ROLES = ["cashier", "manager", "sales_rep", "print_operator"] as const;
const RECEPTION_STATION_ROLES = ["cashier", "manager", "print_operator"] as const;

export interface DeliveryCustomerIdentity {
  customerId: number | null;
  name: string;
  /** أرقامٌ محلّية (07xxxxxxxxx). */
  phone: string;
  tier: PhoneCustomerTier | null;
}

export interface DeliveryCustomerSectionProps {
  initialPhone: string;
  /** رصيد العميل المربوط إن كان القارئ يملكه (من `customers.get` عند الأب). */
  balance?: string | null;
  onIdentityChange: (identity: DeliveryCustomerIdentity) => void;
}

export function DeliveryCustomerSection({ initialPhone, balance, onIdentityChange }: DeliveryCustomerSectionProps) {
  const me = trpc.auth.me.useQuery();
  const canCreate = me.data != null && (
    moduleAccessAllowed(me.data.role as RoleKey, (me.data.permissionsOverride ?? null) as PermissionMap | null, "crm", "FULL", CUSTOMER_CREATE_ROLES)
    || moduleAccessAllowed(me.data.role as RoleKey, (me.data.permissionsOverride ?? null) as PermissionMap | null, "workorders", "FULL", RECEPTION_STATION_ROLES)
  );
  const api = useCustomerByPhone({ initialPhone });
  const onIdentityChangeRef = useRef(onIdentityChange);
  onIdentityChangeRef.current = onIdentityChange;
  const lastKey = useRef("");
  const { customerId, name } = api.customer;
  const { phone, tier } = api;
  useEffect(() => {
    const key = `${customerId ?? ""}|${name}|${phone}|${tier ?? ""}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    onIdentityChangeRef.current({ customerId, name, phone, tier });
  }, [customerId, name, phone, tier]);

  return <CustomerByPhone api={api} canCreate={canCreate} balance={balance} idPrefix="pos-delivery" />;
}
