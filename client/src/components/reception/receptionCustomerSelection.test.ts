import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  initialCustomerByPhoneState,
  onCustomerLinked,
  onCustomerReset,
  onPhoneChanged,
} from "@/components/customer/customerByPhoneMachine";

const readReception = () =>
  readFileSync(new URL("../../pages/Reception.tsx", import.meta.url), "utf8");
const readCustomerSection = () =>
  readFileSync(new URL("./ReceptionCustomerSection.tsx", import.meta.url), "utf8");
const readCustomerByPhone = () =>
  readFileSync(new URL("../customer/CustomerByPhone.tsx", import.meta.url), "utf8");
const readSelectionDialog = () =>
  readFileSync(new URL("../pos/CustomerSelectionDialog.tsx", import.meta.url), "utf8");

describe("تكامل اختيار العميل في كاشير الاستقبال (Reception Customer Selection)", () => {
  it("شاشة الاستقبال تستورد وتستخدم ReceptionCustomerSection لربط واختيار العميل", () => {
    const reception = readReception();

    // تأكيد استيراد المكون الموحد
    expect(reception).toContain("import { ReceptionCustomerSection } from \"@/components/reception/ReceptionCustomerSection\";");
    // تأكيد تمرير الخطافات والدوال المطلوبة للمكون
    expect(reception).toContain("<ReceptionCustomerSection");
    expect(reception).toContain("phoneCustomer={phoneCustomer}");
    expect(reception).toContain("canCreateCustomer={canCreateCustomer}");
    expect(reception).toContain("canReadCustomerContext={canReadCustomerContext}");
    expect(reception).toContain("effectiveTier={effectiveTier}");
    expect(reception).toContain("tierOverride={tierOverride}");
    expect(reception).toContain("setTierOverride={setTierOverride}");
    expect(reception).toContain("setHydratedAutomaticTier={setHydratedAutomaticTier}");
    expect(reception).toContain("setDeferred={setDeferred}");
    expect(reception).toContain("clearCouponIfApplied={clearCouponIfApplied}");
    expect(reception).toContain("setCustomerContextId={setCustomerContextId}");
  });

  it("قسم عميل الاستقبال يحتوي على زر فتح منتقي العملاء ونافذة الاختيار", () => {
    const section = readCustomerSection();

    // زر البحث في السجل / اختيار عميل
    expect(section).toContain("بحث في السجل / اختيار عميل");
    expect(section).toContain("<Users");
    expect(section).toContain("onClick={() => setShowPicker(true)}");

    // تضمين نافذة الاختيار CustomerSelectionDialog
    expect(section).toContain("<CustomerSelectionDialog");
    expect(section).toContain("open={showPicker}");
    expect(section).toContain("onOpenChange={setShowPicker}");
    expect(section).toContain("onSelectCustomer={handleSelectCustomer}");
    expect(section).toContain("onSelectTier=");

    // تضمين CustomerByPhone
    expect(section).toContain("<CustomerByPhone");
    expect(section).toContain("phoneHeaderExtra=");
    expect(section).toContain("identityHeaderExtra=");
  });

  it("مكون CustomerByPhone يدعم الزر الإضافي في رأس الهاتف وزر التغيير", () => {
    const cbp = readCustomerByPhone();

    expect(cbp).toContain("phoneHeaderExtra?: ReactNode;");
    expect(cbp).toContain("onOpenPicker?: () => void;");
    expect(cbp).toContain("{phoneHeaderExtra}");
    expect(cbp).toContain("تغيير");
  });

  it("CustomerSelectionDialog يجعل معامل الألوان C اختيارياً ويمرر كائن العميل عند الاختيار", () => {
    const dialog = readSelectionDialog();

    expect(dialog).toContain("C?: C;");
    expect(dialog).toContain("C = POS_COLORS");
    expect(dialog).toContain("handlePick(c.id, c)");
  });

  it("آلة الحالة: ربط عميل بالكامل يثبت الهوية كـ RESOLVED ويحدث الفئة والآجل", () => {
    const s0 = initialCustomerByPhoneState();
    expect(s0.resolution).toBe("EMPTY");

    const linked = onCustomerLinked(s0, {
      customerId: 50,
      name: "مؤسسة النور التعليمية",
      phone: "07709876543",
      tier: "WHOLESALE",
      deferredEligible: true,
    });

    expect(linked.resolution).toBe("RESOLVED");
    expect(linked.customer.customerId).toBe(50);
    expect(linked.customer.name).toBe("مؤسسة النور التعليمية");
    expect(linked.customer.phone).toBe("07709876543");
    expect(linked.phone).toBe("07709876543");
    expect(linked.tier).toBe("WHOLESALE");
    expect(linked.deferredEligible).toBe(true);
  });

  it("آلة الحالة: اختيار العميل النقدي يفرغ الهاتف وهوية العميل ويرجع الحالة إلى EMPTY", () => {
    const s0 = initialCustomerByPhoneState();
    const linked = onCustomerLinked(s0, {
      customerId: 50,
      name: "مؤسسة النور التعليمية",
      phone: "07709876543",
      tier: "WHOLESALE",
      deferredEligible: true,
    });

    const reset = onCustomerReset();
    expect(reset.resolution).toBe("EMPTY");
    expect(reset.customer.customerId).toBeNull();
    expect(reset.customer.name).toBe("");
    expect(reset.customer.phone).toBeNull();
    expect(reset.phone).toBe("");
    expect(reset.tier).toBeNull();
    expect(reset.deferredEligible).toBe(false);
  });
});
