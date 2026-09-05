import { describe, expect, it } from "vitest";
import {
  canSubmitNewCustomer,
  creditLimitPayload,
  initialCustomerByPhoneState,
  onNameTyped,
  onPhoneChanged,
  onResolveError,
  onResolveResult,
  onResolveStart,
  phaseForPhone,
  resolutionNotice,
  sanitizeCreditLimitInput,
  type PhoneResolveResult,
} from "./customerByPhoneMachine";

const resolved = (over: Partial<PhoneResolveResult> = {}): PhoneResolveResult => ({
  status: "RESOLVED",
  customerId: 42,
  name: "أحمد",
  phone: "07701234567",
  defaultPriceTier: "WHOLESALE",
  created: false,
  deferredEligible: true,
  ...over,
});

describe("آلة «العميل بالهاتف» — الهاتف مفتاح الهوية", () => {
  it("يميّز الفارغ من الناقص من المكتمل (07 + ٩ أرقام)", () => {
    expect(phaseForPhone("")).toBe("EMPTY");
    expect(phaseForPhone("0770")).toBe("INCOMPLETE");
    expect(phaseForPhone("0770123456")).toBe("INCOMPLETE");
    expect(phaseForPhone("07701234567")).toBe("READY");
    expect(phaseForPhone("06701234567")).toBe("INCOMPLETE");
  });

  it("تغيّر الهاتف يُسقط الفئة والأهليّة دائماً ويدخل CHECKING فور اكتمال الرقم", () => {
    const linked = onResolveResult(onPhoneChanged(initialCustomerByPhoneState(), "07701234567"), resolved());
    expect(linked.resolution).toBe("RESOLVED");
    expect(linked.tier).toBe("WHOLESALE");
    expect(linked.deferredEligible).toBe(true);

    const retyped = onPhoneChanged(linked, "0770123456");
    expect(retyped.resolution).toBe("INCOMPLETE");
    expect(retyped.customer).toEqual({ customerId: null, name: "", phone: "0770123456", isNew: false });
    expect(retyped.tier).toBeNull();
    expect(retyped.deferredEligible).toBe(false);

    const complete = onPhoneChanged(retyped, "07709999999");
    expect(complete.resolution).toBe("CHECKING");
    expect(complete.customer).toEqual({ customerId: null, name: "", phone: "07709999999", isNew: true });

    const cleared = onPhoneChanged(complete, "");
    expect(cleared.resolution).toBe("EMPTY");
    expect(cleared.customer.customerId).toBeNull();
    expect(cleared.customer.phone).toBeNull();
  });

  it("رقمٌ جديد بلا اسم ⇒ NEEDS_NAME ويُبقي الاسم المكتوب؛ ثمّ الحفظ بالاسم يربطه مُنشأً", () => {
    const checking = onPhoneChanged(initialCustomerByPhoneState(), "07701234567");
    const needsName = onResolveResult(checking, resolved({ status: "NEEDS_NAME", customerId: null, name: null, defaultPriceTier: "RETAIL", deferredEligible: false }));
    expect(needsName.resolution).toBe("NEEDS_NAME");
    expect(needsName.customer.isNew).toBe(true);
    expect(canSubmitNewCustomer(needsName, { canCreate: true, pending: false })).toBe(false);

    const typed = onNameTyped(needsName, "سارة");
    expect(canSubmitNewCustomer(typed, { canCreate: true, pending: false })).toBe(true);
    expect(canSubmitNewCustomer(typed, { canCreate: false, pending: false })).toBe(false);
    expect(canSubmitNewCustomer(typed, { canCreate: true, pending: true })).toBe(false);
    expect(canSubmitNewCustomer(onNameTyped(needsName, "س"), { canCreate: true, pending: false })).toBe(false);

    const started = onResolveStart(typed);
    expect(started.resolution).toBe("CHECKING");
    // الردّ ما زال يحمل الاسم المكتوب — يُبقيه إن غاب اسم الخادم.
    const created = onResolveResult(started, resolved({ customerId: 77, name: null, created: true, defaultPriceTier: "RETAIL", deferredEligible: false }), "سارة");
    expect(created.resolution).toBe("RESOLVED");
    expect(created.customer).toEqual({ customerId: 77, name: "سارة", phone: "07701234567", isNew: false });
    expect(created.tier).toBe("RETAIL");
    expect(created.deferredEligible).toBe(false);
  });

  it("خطأ الخادم يُعرض كما هو، وبلا نصّ يسقط إلى رسالةٍ افتراضية", () => {
    const checking = onPhoneChanged(initialCustomerByPhoneState(), "07701234567");
    expect(onResolveError(checking, "هذا الرقم مرتبط بعميل معطّل").error).toBe("هذا الرقم مرتبط بعميل معطّل");
    expect(resolutionNotice(onResolveError(checking, "هذا الرقم مرتبط بعميل معطّل"))).toEqual({ tone: "destructive", text: "هذا الرقم مرتبط بعميل معطّل" });
    expect(onResolveError(checking, undefined).error).toBe("تعذّر التحقق من رقم العميل");
  });

  it("نصوص الحالة تحت الحقل بألوانها الدلاليّة", () => {
    const s0 = initialCustomerByPhoneState();
    expect(resolutionNotice(s0)).toEqual({ tone: "muted", text: "اكتب ١١ رقماً؛ سنبحث عن العميل تلقائياً." });
    expect(resolutionNotice(onPhoneChanged(s0, "077")).tone).toBe("warn");
    expect(resolutionNotice(onPhoneChanged(s0, "07701234567")).text).toBe("جارٍ التحقق");
    expect(resolutionNotice(onResolveResult(onPhoneChanged(s0, "07701234567"), resolved())).tone).toBe("positive");
  });

  it("حدّ الائتمان: فارغ/unlimited لا يُرسَل، والرقم يُرسَل نصّاً، والمدخل يُعقَّم أرقاماً ونقطة", () => {
    expect(creditLimitPayload("")).toBeUndefined();
    expect(creditLimitPayload("  ")).toBeUndefined();
    expect(creditLimitPayload("unlimited")).toBeUndefined();
    expect(creditLimitPayload("0")).toBe("0");
    expect(creditLimitPayload(" 250000 ")).toBe("250000");
    expect(sanitizeCreditLimitInput("25,000.5 دينار")).toBe("25000.5");
  });
});
