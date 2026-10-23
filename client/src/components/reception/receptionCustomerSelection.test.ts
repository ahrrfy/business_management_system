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
const readReceptionHeader = () =>
  readFileSync(new URL("./ReceptionWorkspaceHeader.tsx", import.meta.url), "utf8");
const readCustomerSection = () =>
  readFileSync(new URL("./ReceptionCustomerSection.tsx", import.meta.url), "utf8");
const readCustomerByPhone = () =>
  readFileSync(new URL("../customer/CustomerByPhone.tsx", import.meta.url), "utf8");
const readSelectionDialog = () =>
  readFileSync(new URL("../pos/CustomerSelectionDialog.tsx", import.meta.url), "utf8");

describe("تكامل اختيار العميل في كاشير الاستقبال (Reception Customer Selection)", () => {
  it("شاشة الاستقبال تستورد وتستخدم ReceptionCustomerSection لربط واختيار العميل", () => {
    const reception = readReception();
    const header = readReceptionHeader();

    // الشاشة تمرّر عقد العميل إلى الرأس المستخرج الذي يعرض المكون الموحد.
    expect(reception).toContain("import { ReceptionWorkspaceHeader } from \"@/components/reception/ReceptionWorkspaceHeader\";");
    expect(reception).toContain("<ReceptionWorkspaceHeader");
    expect(header).toContain("import { ReceptionCustomerSection } from \"@/components/reception/ReceptionCustomerSection\";");
    expect(header).toContain("<ReceptionCustomerSection");
    // تأكيد تمرير الخطافات والدوال نفسها في الوصلتين، لا في مكون غير موصول بالشاشة.
    for (const source of [reception, header]) {
      expect(source).toContain("phoneCustomer={phoneCustomer}");
      expect(source).toContain("canCreateCustomer={canCreateCustomer}");
      expect(source).toContain("canReadCustomerContext={canReadCustomerContext}");
      expect(source).toContain("effectiveTier={effectiveTier}");
      expect(source).toContain("tierOverride={tierOverride}");
      expect(source).toContain("setTierOverride={setTierOverride}");
      expect(source).toContain("setHydratedAutomaticTier={setHydratedAutomaticTier}");
      expect(source).toContain("setDeferred={setDeferred}");
      expect(source).toContain("clearCouponIfApplied={clearCouponIfApplied}");
      expect(source).toContain("setCustomerContextId={setCustomerContextId}");
    }
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

  it("CustomerSelectionDialog يجعل معامل الألوان C اختيارياً ويمرر كائن العميل عند الاختيار ويدعم canCreate", () => {
    const dialog = readSelectionDialog();

    expect(dialog).toContain("C?: C;");
    expect(dialog).toContain("C = POS_COLORS");
    expect(dialog).toContain("canCreate?: boolean;");
    expect(dialog).toContain("canCreate = true");
    expect(dialog).toContain("{canCreate && (");
    expect(dialog).toContain("handlePick(c.id, c)");
    expect(dialog).toContain("handlePick(id, data as any)");
  });

  it("قسم عميل الاستقبال يمرر صلاحية canCreate إلى CustomerSelectionDialog ويطبّع رقم الهاتف", () => {
    const section = readCustomerSection();

    expect(section).toContain("canCreate={canCreateCustomer}");
    expect(section).toContain("toLocalIqMobileDigits");
    expect(section).toContain("isValidIqMobile");
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
