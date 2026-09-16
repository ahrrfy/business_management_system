import { useState, useEffect, useRef } from "react";
import {
  UserRound,
  BadgeCheck,
  LoaderCircle,
  X,
  UserPlus,
  Users,
  Smartphone,
} from "lucide-react";
import { PhoneDigitsInput } from "@/components/form/PhoneDigitsInput";
import { useCustomerByPhone } from "@/components/customer/useCustomerByPhone";
import { canSubmitNewCustomer } from "@/components/customer/customerByPhoneMachine";
import { PrintCustomerCombo } from "@/components/printPos/PrintCustomerCombo";
import { trpc } from "@/lib/trpc";

export interface PrintCustomerPhoneSectionProps {
  C: Record<string, string>;
  customerId: number | null;
  setCustomerId: (id: number | null) => void;
  contactName: string;
  setContactName: (name: string) => void;
  contactPhone: string;
  setContactPhone: (phone: string) => void;
}

export function PrintCustomerPhoneSection({
  C,
  customerId,
  setCustomerId,
  contactName,
  setContactName,
  contactPhone,
  setContactPhone,
}: PrintCustomerPhoneSectionProps) {
  const [pickerMode, setPickerMode] = useState<"PHONE" | "COMBO">("PHONE");
  const [typedGuestName, setTypedGuestName] = useState(contactName);

  // صلاحية الإنشاء السريع للعملاء
  const me = trpc.auth.me.useQuery(undefined, { staleTime: 300_000 });
  const canCreate = me.data != null;

  // استعلام العميل المسجل إذا كان محددًا بواسطة customerId
  const pickedCustomer = trpc.customers.get.useQuery(
    { customerId: customerId ?? 0 },
    { enabled: customerId != null, staleTime: 60_000 },
  );

  // آلة العميل بالهاتف المشتركة
  const api = useCustomerByPhone({
    initialPhone: contactPhone,
  });

  // مزامنة الاسم المطبوع محلياً
  useEffect(() => {
    setTypedGuestName(contactName);
  }, [contactName]);

  // مزامنة رقم الهاتف عند تغييره من الخارج (مثل تبديل التبويبات)
  const lastExternalPhone = useRef(contactPhone);
  useEffect(() => {
    if (contactPhone !== lastExternalPhone.current) {
      lastExternalPhone.current = contactPhone;
      if (contactPhone !== api.phone) {
        api.setPhone(contactPhone);
      }
    }
  }, [contactPhone, api]);

  // مزامنة حالة العميل المربوط تلقائياً إلى الأب
  useEffect(() => {
    if (api.customer.customerId) {
      setCustomerId(api.customer.customerId);
      if (api.customer.name) {
        setContactName(api.customer.name);
      }
      if (api.phone) {
        setContactPhone(api.phone);
        lastExternalPhone.current = api.phone;
      }
    } else if (api.resolution === "NEEDS_NAME" || api.resolution === "EMPTY") {
      setCustomerId(null);
    }
  }, [api.customer.customerId, api.customer.name, api.phone, api.resolution, setCustomerId, setContactName, setContactPhone]);

  // مزامنة تغييرات الهاتف إلى الأب
  const handlePhoneChange = (digits: string) => {
    api.setPhone(digits);
    setContactPhone(digits);
    lastExternalPhone.current = digits;
    if (!digits || digits !== api.phone) {
      setCustomerId(null);
    }
  };

  // تفريغ بيانات العميل
  const handleClearCustomer = () => {
    api.setPhone("");
    setContactPhone("");
    lastExternalPhone.current = "";
    setCustomerId(null);
    setContactName("");
    setTypedGuestName("");
  };

  // حفظ العميل الجديد وربطه فوراً
  const handleSaveAndLink = async () => {
    const nameToSave = api.customer.name.trim() || typedGuestName.trim();
    if (!nameToSave || !api.isValidPhone) return;
    const res = await api.resolve(nameToSave, true);
    if (res && res.customerId) {
      setCustomerId(res.customerId);
      setContactName(res.name ?? nameToSave);
      setContactPhone(api.phone);
      lastExternalPhone.current = api.phone;
    }
  };

  const isResolved = api.resolution === "RESOLVED" && (api.customer.customerId != null || customerId != null);
  const displayName = api.customer.name || pickedCustomer.data?.name || contactName;
  const canSubmit = canSubmitNewCustomer(api, { canCreate, pending: api.isPending }) ||
    (api.resolution === "NEEDS_NAME" && typedGuestName.trim().length >= 2 && !api.isPending && canCreate);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        flexShrink: 0,
        boxSizing: "border-box",
      }}
    >
      {/* زر التبديل بين وضع البحث بالهاتف الموحد ووضع قائمة المسجلين */}
      <div
        style={{
          display: "flex",
          gap: 2,
          background: C.muted,
          padding: 2,
          borderRadius: 7,
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={() => setPickerMode("PHONE")}
          title="إدخال الهاتف بالأرقام والتحقق التلقائي"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            height: 26,
            padding: "0 7px",
            borderRadius: 5,
            border: "none",
            background: pickerMode === "PHONE" ? C.primary : "transparent",
            color: pickerMode === "PHONE" ? "#fff" : C.fg,
            fontSize: 11,
            fontWeight: 700,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          <Smartphone size={12} />
          <span>بالهاتف</span>
        </button>
        <button
          type="button"
          onClick={() => setPickerMode("COMBO")}
          title="بحث بالاسم من قائمة العملاء المسجلين"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            height: 26,
            padding: "0 7px",
            borderRadius: 5,
            border: "none",
            background: pickerMode === "COMBO" ? C.primary : "transparent",
            color: pickerMode === "COMBO" ? "#fff" : C.fg,
            fontSize: 11,
            fontWeight: 700,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          <Users size={12} />
          <span>قائمة</span>
        </button>
      </div>

      {pickerMode === "COMBO" ? (
        <div style={{ width: 230, flexShrink: 0 }}>
          <PrintCustomerCombo C={C as any} customerId={customerId} setCustomerId={setCustomerId} />
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {/* حقل الهاتف العراقي مجزأ خانة لكل رقم مع الترميز الدولي الثابت +964 */}
          <div style={{ flexShrink: 0 }}>
            <PhoneDigitsInput
              value={api.phone}
              onChange={handlePhoneChange}
              ariaLabel="رقم هاتف الزبون"
            />
          </div>

          {/* حالة التحقق والربط / اسم العميل */}
          {api.resolution === "CHECKING" ? (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                height: 32,
                padding: "0 10px",
                borderRadius: 6,
                background: C.muted,
                color: C.mutedFg,
                fontSize: 11,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              <LoaderCircle size={13} className="animate-spin" />
              <span>جارٍ التحقق…</span>
            </div>
          ) : isResolved ? (
            /* عميل موجود أو تم حفظه بنجاح */
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                height: 32,
                padding: "0 10px",
                borderRadius: 6,
                border: "1.5px solid var(--sem-pos, #10b981)",
                background: "var(--sem-pos-bg, rgba(16, 185, 129, 0.12))",
                color: "var(--sem-pos, #059669)",
                fontSize: 12,
                fontWeight: 800,
                flexShrink: 0,
              }}
            >
              <UserRound size={14} />
              <span style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {displayName || "عميل مربوط"}
              </span>
              <BadgeCheck size={14} className="text-emerald-600" />
              <button
                type="button"
                onClick={handleClearCustomer}
                title="إلغاء ربط العميل وتفريغ الهاتف"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "inherit",
                  padding: 2,
                  marginRight: 2,
                }}
              >
                <X size={13} />
              </button>
            </div>
          ) : api.resolution === "NEEDS_NAME" ? (
            /* رقم جديد — إدخال الاسم للحفظ التلقائي في العملاء */
            <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
              <input
                type="text"
                autoFocus
                placeholder="اسم العميل الجديد"
                value={api.customer.name || typedGuestName}
                onChange={(e) => {
                  api.setCustomerName(e.target.value);
                  setTypedGuestName(e.target.value);
                  setContactName(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSubmit) {
                    e.preventDefault();
                    void handleSaveAndLink();
                  }
                }}
                style={{
                  width: 130,
                  height: 32,
                  padding: "0 8px",
                  borderRadius: 6,
                  border: `1.5px solid ${C.primary}`,
                  background: C.card,
                  color: C.fg,
                  fontSize: 12,
                  fontFamily: "inherit",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
              <button
                type="button"
                disabled={!canSubmit}
                onClick={() => void handleSaveAndLink()}
                title="حفظ العميل في النظام وربطه بالطلب الحالي (Enter)"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  height: 32,
                  padding: "0 8px",
                  borderRadius: 6,
                  border: "none",
                  background: canSubmit ? C.primary : C.muted,
                  color: canSubmit ? "#fff" : C.mutedFg,
                  fontSize: 11,
                  fontWeight: 800,
                  cursor: canSubmit ? "pointer" : "not-allowed",
                  fontFamily: "inherit",
                  whiteSpace: "nowrap",
                }}
              >
                <UserPlus size={13} />
                <span>حفظ وربط</span>
              </button>
            </div>
          ) : (
            /* في حال لم يكتمل الرقم بعد — حقل اختياري لاسم الزبون (عابر) */
            <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
              <input
                type="text"
                placeholder="اسم الزبون (اختياري)"
                value={typedGuestName}
                onChange={(e) => {
                  setTypedGuestName(e.target.value);
                  setContactName(e.target.value);
                  api.setCustomerName(e.target.value);
                }}
                style={{
                  width: 120,
                  height: 32,
                  padding: "0 8px",
                  borderRadius: 6,
                  border: `1px solid ${C.border}`,
                  background: C.card,
                  color: C.fg,
                  fontSize: 12,
                  fontFamily: "inherit",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
