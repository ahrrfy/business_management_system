/**
 * shared/__tests__/atomicPermissions.test.ts
 *
 * مجموعة اختبارات شاملة لشجرة الصلاحيات الذرية والمصفوفة التفاعلية ومحرك الحل والتوافق الرجعي:
 *  ١) فحص الكتالوج والتصنيف (10 قطاعات تشغيلية، 100+ مفتاح ذري).
 *  ٢) فحص مخططات التحقق (Zod Schemas) وصحة المفاتيح والسقوف والبيانات الحساسة.
 *  ٣) فحص القوالب الافتراضية لكافة الأدوار الـ11 + أدوار الكاشير الـ3 للأقسام.
 *  ٤) فحص هرمية الحل والاشتقاق (Resolution Engine Hierarchy) للصلاحيات والسقوف والحجب.
 *  ٥) فحص التوافق الرجعي 100% مع الوحدات الـ29 القديمة ومظاريف الصلاحيات (Envelopes).
 *  ٦) فحص مساعدات واجهة المستخدم (البحث الذكي، الإحصائيات، كشف الاستثناءات، فحص SoD).
 *  ٧) فحص دوال إنفاذ السقوف الرقمية (Caps Enforcement Helpers).
 */

import { describe, expect, it } from "vitest";
import {
  ALL_DOMAINS,
  ALL_ATOMIC_PERMISSION_KEYS,
  ATOMIC_PERMISSION_BY_KEY,
  ATOMIC_PERMISSION_DEFINITIONS,
  DOMAIN_METADATA,
  ROLE_DEFAULT_ATOMIC_PERMISSIONS,
  ROLE_DEFAULT_DATA_MASKING,
  ROLE_DEFAULT_OPERATIONAL_CAPS,
  STANDARD_ACTIONS,
  atomicPermissionKeySchema,
  atomicPermissionsMapSchema,
  checkSodConflicts,
  deriveAtomicFromLegacyModules,
  deriveLegacyModulesFromAtomic,
  filterAtomicOverrides,
  getAtomicPermissionsByDomain,
  getAtomicPermissionsByResource,
  getDomainStats,
  hasAtomicPermission,
  isCreditSaleWithinCap,
  isDiscountAmountWithinCap,
  isDiscountPercentWithinCap,
  isExpenseWithinCap,
  isPaymentVoucherWithinCap,
  isPermissionEnvelope,
  isRefundWithinCap,
  normalizePermissionsInput,
  operationalCapsSchema,
  permissionEnvelopeSchema,
  resolveAtomicPermissions,
  resolveOperationalCaps,
  resolveSensitiveDataMasking,
  searchAtomicPermissions,
  sensitiveDataMaskingSchema,
  type AtomicPermissionsMap,
  type OperationalCaps,
  type SensitiveDataMasking,
} from "../atomicPermissions";

describe("Atomic Permission Catalog & Taxonomy", () => {
  it("يحتوي على كافة القطاعات التشغيلية العشرة بمعلومات وبيانات وصفية كاملة", () => {
    expect(ALL_DOMAINS).toHaveLength(10);
    expect(ALL_DOMAINS).toEqual([
      "pos",
      "reception",
      "workshop",
      "inventory",
      "purchasing",
      "treasury",
      "fieldsales",
      "delivery",
      "hr",
      "governance",
    ]);

    for (const dom of ALL_DOMAINS) {
      const meta = DOMAIN_METADATA[dom];
      expect(meta).toBeDefined();
      expect(meta.key).toBe(dom);
      expect(meta.label).toBeTruthy();
      expect(meta.description).toBeTruthy();
      expect(meta.iconName).toBeTruthy();
      expect(typeof meta.order).toBe("number");
    }
  });

  it("يحتوي على أكثر من 75 مفتاحاً ذرياً مع تفاصيل المورد والفعل والتسمية العربية", () => {
    expect(ATOMIC_PERMISSION_DEFINITIONS.length).toBeGreaterThanOrEqual(75);
    expect(ALL_ATOMIC_PERMISSION_KEYS.length).toBe(ATOMIC_PERMISSION_DEFINITIONS.length);

    for (const def of ATOMIC_PERMISSION_DEFINITIONS) {
      // التحقق من صيغة المفتاح الذري domain.resource.action
      expect(def.key).toMatch(/^[a-z_]+\.[a-z_]+\.[a-z_]+$/);
      expect(def.key.startsWith(`${def.domain}.`)).toBe(true);
      expect(def.resource).toBeTruthy();
      expect(def.action).toBeTruthy();
      expect(def.label).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(["normal", "medium", "high", "critical"]).toContain(def.sensitivity);
      expect(def.legacyModule).toBeTruthy();

      // التحقق من أن المفتاح مسجل في الفهرس السريع
      expect(ATOMIC_PERMISSION_BY_KEY[def.key]).toBe(def);
    }
  });

  it("يحتوي على الأفعال المعيارية الثمانية المشتركة", () => {
    expect(STANDARD_ACTIONS).toHaveLength(8);
    const actionKeys = STANDARD_ACTIONS.map((a) => a.key);
    expect(actionKeys).toEqual([
      "view",
      "create",
      "edit",
      "cancel",
      "print",
      "reprint",
      "export",
      "approve",
    ]);
  });
});

describe("Zod Validation Schemas", () => {
  it("atomicPermissionKeySchema: يقبل المفاتيح النظامية ويرفض الصيغ غير المتوافقة", () => {
    expect(atomicPermissionKeySchema.safeParse("pos.invoice.create").success).toBe(true);
    expect(atomicPermissionKeySchema.safeParse("treasury.voucher_in.cancel").success).toBe(true);
    expect(atomicPermissionKeySchema.safeParse("inventory.stocktake.approve").success).toBe(true);

    // صيغ غير صالحة
    expect(atomicPermissionKeySchema.safeParse("pos_invoice_create").success).toBe(false);
    expect(atomicPermissionKeySchema.safeParse("pos.invoice").success).toBe(false);
    expect(atomicPermissionKeySchema.safeParse("Pos.Invoice.Create").success).toBe(false);
    expect(atomicPermissionKeySchema.safeParse("pos.invoice.create.now").success).toBe(false);
    expect(atomicPermissionKeySchema.safeParse("").success).toBe(false);
  });

  it("atomicPermissionsMapSchema: يتحقق من خريطة الصلاحيات الثنائية", () => {
    const validMap = {
      "pos.invoice.create": true,
      "pos.invoice.void": false,
    };
    expect(atomicPermissionsMapSchema.safeParse(validMap).success).toBe(true);

    const invalidMap = {
      "pos.invoice.create": "YES", // ليس boolean
    };
    expect(atomicPermissionsMapSchema.safeParse(invalidMap).success).toBe(false);
  });

  it("operationalCapsSchema: يقبل الأرقام والمبالغ المالية العشرية ويرفض السوالب والصيغ التالفة", () => {
    const validCaps: OperationalCaps = {
      maxDiscountPercent: 15,
      maxDiscountAmountIqd: "50000.00",
      maxCreditSaleLimitIqd: "500000.00",
      maxPaymentVoucherAmountIqd: "1000000.00",
      maxExpenseVoucherAmountIqd: "25000.00",
      maxRefundAmountIqd: "25000.00",
    };
    expect(operationalCapsSchema.safeParse(validCaps).success).toBe(true);

    // قيم غير محدودة (null)
    const unlimitedCaps: OperationalCaps = {
      maxDiscountPercent: 100,
      maxDiscountAmountIqd: null,
      maxCreditSaleLimitIqd: null,
    };
    expect(operationalCapsSchema.safeParse(unlimitedCaps).success).toBe(true);

    // نسبة سالبة أو تتجاوز 100
    expect(operationalCapsSchema.safeParse({ maxDiscountPercent: -5 }).success).toBe(false);
    expect(operationalCapsSchema.safeParse({ maxDiscountPercent: 105 }).success).toBe(false);

    // مبلغ بصيغة سالبة أو تالفة
    expect(operationalCapsSchema.safeParse({ maxDiscountAmountIqd: "-1000" }).success).toBe(false);
    expect(operationalCapsSchema.safeParse({ maxDiscountAmountIqd: "abc" }).success).toBe(false);
  });

  it("sensitiveDataMaskingSchema: يتحقق من أعلام حجب البيانات الحساسة", () => {
    const validMasking: SensitiveDataMasking = {
      maskPurchaseCost: true,
      maskProfitMargin: true,
      maskSupplierPhone: false,
      maskCustomerContact: false,
    };
    expect(sensitiveDataMaskingSchema.safeParse(validMasking).success).toBe(true);
    expect(sensitiveDataMaskingSchema.safeParse({ maskPurchaseCost: null }).success).toBe(true);
  });

  it("permissionEnvelopeSchema: يتحقق من المظروف المركب للصلاحيات والسقوف", () => {
    const envelope = {
      modules: { pos: "FULL", sales: "READ" },
      atomic: { "pos.shift.open": true },
      caps: { maxDiscountPercent: 5 },
      masking: { maskPurchaseCost: true },
    };
    expect(permissionEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });
});

describe("Role Default Templates & Section Cashiers", () => {
  it("يوفر قوالب الصلاحيات الافتراضية لكافة الأدوار الـ11 الأساسية", () => {
    const expectedRoles = [
      "admin",
      "manager",
      "accountant",
      "cashier",
      "warehouse",
      "purchasing",
      "print_operator",
      "sales_rep",
      "auditor",
      "courier",
      "user",
    ];

    for (const r of expectedRoles) {
      expect(ROLE_DEFAULT_ATOMIC_PERMISSIONS[r]).toBeDefined();
      expect(ROLE_DEFAULT_OPERATIONAL_CAPS[r]).toBeDefined();
      expect(ROLE_DEFAULT_DATA_MASKING[r]).toBeDefined();
    }
  });

  it("يوفر قوالب مخصصة لأدوار كاشير الأقسام الثلاثة (retail_cashier, print_cashier, reception_clerk)", () => {
    const sectionRoles = ["retail_cashier", "print_cashier", "reception_clerk"];
    for (const sr of sectionRoles) {
      expect(ROLE_DEFAULT_ATOMIC_PERMISSIONS[sr]).toBeDefined();
      expect(ROLE_DEFAULT_OPERATIONAL_CAPS[sr]).toBeDefined();
      expect(ROLE_DEFAULT_DATA_MASKING[sr]).toBeDefined();
    }

    // كاشير التجزئة: لا يملك أوامر الشغل
    expect(ROLE_DEFAULT_ATOMIC_PERMISSIONS.retail_cashier["reception.order.create"]).toBe(false);
    expect(ROLE_DEFAULT_ATOMIC_PERMISSIONS.retail_cashier["pos.invoice.create"]).toBe(true);

    // كاشير الطباعة: يملك نقاط البيع وخدمات الطباعة، ولا يملك طلبيات التجزئة
    expect(ROLE_DEFAULT_ATOMIC_PERMISSIONS.print_cashier["pos.invoice.create"]).toBe(true);
    expect(ROLE_DEFAULT_ATOMIC_PERMISSIONS.print_cashier["workshop.job.view"]).toBe(true);

    // موظف الاستقبال: يملك أوامر الشغل والعربون، ولا يملك إصدار مبيعات نقدية مباشرة
    expect(ROLE_DEFAULT_ATOMIC_PERMISSIONS.reception_clerk["reception.order.create"]).toBe(true);
    expect(ROLE_DEFAULT_ATOMIC_PERMISSIONS.reception_clerk["reception.deposit.collect"]).toBe(true);
    expect(ROLE_DEFAULT_ATOMIC_PERMISSIONS.reception_clerk["pos.invoice.create"]).toBe(false);
  });

  it("قالب مدير النظام (admin) يمنح وصولاً كاملاً لكل المفاتيح وسقوفاً غير محدودة", () => {
    const adminPerms = ROLE_DEFAULT_ATOMIC_PERMISSIONS.admin;
    for (const key of ALL_ATOMIC_PERMISSION_KEYS) {
      expect(adminPerms[key]).toBe(true);
    }

    const adminCaps = ROLE_DEFAULT_OPERATIONAL_CAPS.admin;
    expect(adminCaps.maxDiscountPercent).toBe(100);
    expect(adminCaps.maxDiscountAmountIqd).toBeNull();
    expect(adminCaps.maxCreditSaleLimitIqd).toBeNull();

    const adminMasking = ROLE_DEFAULT_DATA_MASKING.admin;
    expect(adminMasking.maskPurchaseCost).toBe(false);
    expect(adminMasking.maskProfitMargin).toBe(false);
  });

  it("قالب المستخدم العام (user) يطبق مبدأ الحد الأدنى من الصلاحيات (Least Privilege)", () => {
    const userPerms = ROLE_DEFAULT_ATOMIC_PERMISSIONS.user;
    expect(userPerms["pos.invoice.create"]).toBe(false);
    expect(userPerms["treasury.voucher_out.create"]).toBe(false);
    expect(userPerms["inventory.adjustment.approve"]).toBe(false);
    expect(userPerms["inventory.balance.view"]).toBe(true); // استعلام رصيد أساسي فقط

    const userCaps = ROLE_DEFAULT_OPERATIONAL_CAPS.user;
    expect(userCaps.maxDiscountPercent).toBe(0);
    expect(userCaps.maxCreditSaleLimitIqd).toBe("0.00");
  });

  it("قالب الكاشير يمنح البيع والطباعة ويحجب العمليات الحساسة (إلغاء وتعديل الأسعار وتجاوز السقوف)", () => {
    const cashierPerms = ROLE_DEFAULT_ATOMIC_PERMISSIONS.cashier;
    expect(cashierPerms["pos.invoice.create"]).toBe(true);
    expect(cashierPerms["pos.invoice.print"]).toBe(true);
    expect(cashierPerms["pos.invoice.reprint"]).toBe(true);
    expect(cashierPerms["pos.return.create"]).toBe(true);
    expect(cashierPerms["pos.invoice.void"]).toBe(false); // ممنوع الإلغاء
    expect(cashierPerms["pos.price.override"]).toBe(false); // ممنوع تعديل السعر
    expect(cashierPerms["governance.limit.override"]).toBe(false);

    const cashierCaps = ROLE_DEFAULT_OPERATIONAL_CAPS.cashier;
    expect(cashierCaps.maxDiscountPercent).toBe(5);
    expect(cashierCaps.maxDiscountAmountIqd).toBe("25000.00");
    expect(cashierCaps.maxCreditSaleLimitIqd).toBe("0.00"); // نقدي فقط!
  });

  it("قالب المدقق (auditor) يمنح القراءة فقط في كافة المجالات ويحجب كافة أفعال التعديل والكتابة", () => {
    const auditorPerms = ROLE_DEFAULT_ATOMIC_PERMISSIONS.auditor;
    expect(auditorPerms["pos.invoice.view"]).toBe(true);
    expect(auditorPerms["inventory.balance.view"]).toBe(true);
    expect(auditorPerms["governance.audit.view"]).toBe(true);
    expect(auditorPerms["governance.cost_margin.view"]).toBe(true);

    // حجب الكتابة
    expect(auditorPerms["pos.invoice.create"]).toBe(false);
    expect(auditorPerms["treasury.voucher_in.create"]).toBe(false);
    expect(auditorPerms["inventory.stocktake.create"]).toBe(false);
    expect(auditorPerms["hr.payroll.disburse"]).toBe(false);
  });
});

describe("Resolution Engine (الاشتقاق والحل الهرمي)", () => {
  it("resolveAtomicPermissions: يدمج القالب مع الدور المخصص واستثناءات المستخدم", () => {
    // 1. افتراضي الكاشير
    const base = resolveAtomicPermissions("cashier");
    expect(base["pos.invoice.create"]).toBe(true);
    expect(base["pos.invoice.void"]).toBe(false);

    // 2. دور مخصص يسمح بالكاشير ولكنه يمنح إلغاء الفواتير
    const customRole: AtomicPermissionsMap = {
      "pos.invoice.void": true,
    };
    const resolvedRole = resolveAtomicPermissions("cashier", customRole);
    expect(resolvedRole["pos.invoice.create"]).toBe(true);
    expect(resolvedRole["pos.invoice.void"]).toBe(true);

    // 3. استثناء فردي للمستخدم يسلب منه طباعة الباركود ويمنحه فتح الدرج
    const userOverrides: AtomicPermissionsMap = {
      "inventory.barcode.print": false,
      "pos.drawer.open": true,
    };
    const resolvedUser = resolveAtomicPermissions("cashier", customRole, userOverrides);
    expect(resolvedUser["pos.invoice.create"]).toBe(true);
    expect(resolvedUser["pos.invoice.void"]).toBe(true);
    expect(resolvedUser["inventory.barcode.print"]).toBe(false);
    expect(resolvedUser["pos.drawer.open"]).toBe(true);
  });

  it("resolveAtomicPermissions: يتعامل بأمان مع الأدوار غير المعروفة بالسقوط الآمن لدور user", () => {
    const unknown = resolveAtomicPermissions("non_existent_role");
    expect(unknown["inventory.balance.view"]).toBe(true);
    expect(unknown["pos.invoice.create"]).toBe(false);
  });

  it("resolveOperationalCaps: يحل السقوف الهرمية ويحافظ على القيم المخصصة والصفرية وغير المحدودة", () => {
    const baseCaps = resolveOperationalCaps("cashier");
    expect(baseCaps.maxDiscountPercent).toBe(5);
    expect(baseCaps.maxCreditSaleLimitIqd).toBe("0.00");

    // رفع سقف الخصم لدور الكاشير المتميز
    const roleCaps: OperationalCaps = {
      maxDiscountPercent: 10,
      maxDiscountAmountIqd: "50000.00",
    };
    const resolvedRoleCaps = resolveOperationalCaps("cashier", roleCaps);
    expect(resolvedRoleCaps.maxDiscountPercent).toBe(10);
    expect(resolvedRoleCaps.maxDiscountAmountIqd).toBe("50000.00");
    expect(resolvedRoleCaps.maxCreditSaleLimitIqd).toBe("0.00"); // موروث

    // استثناء فردي للمستخدم بمنحه بيع آجل حتى 100,000 د.ع
    const userCaps: OperationalCaps = {
      maxCreditSaleLimitIqd: "100000.00",
    };
    const resolvedUserCaps = resolveOperationalCaps("cashier", roleCaps, userCaps);
    expect(resolvedUserCaps.maxDiscountPercent).toBe(10);
    expect(resolvedUserCaps.maxCreditSaleLimitIqd).toBe("100000.00");
  });

  it("resolveSensitiveDataMasking: يحل ضوابط حجب البيانات ويدمج الاستثناءات بدقة", () => {
    const baseMasking = resolveSensitiveDataMasking("cashier");
    expect(baseMasking.maskPurchaseCost).toBe(true);
    expect(baseMasking.maskCustomerContact).toBe(false);

    // استثناء فردي يسمح للكاشير برؤية تكلفة الشراء
    const userMasking: SensitiveDataMasking = {
      maskPurchaseCost: false,
    };
    const resolved = resolveSensitiveDataMasking("cashier", null, userMasking);
    expect(resolved.maskPurchaseCost).toBe(false);
    expect(resolved.maskProfitMargin).toBe(true);
  });

  it("hasAtomicPermission: يتحقق بشكل صحيح وآمن من وجود الصلاحية", () => {
    const perms: AtomicPermissionsMap = {
      "pos.invoice.create": true,
      "pos.invoice.void": false,
    };
    expect(hasAtomicPermission(perms, "pos.invoice.create")).toBe(true);
    expect(hasAtomicPermission(perms, "pos.invoice.void")).toBe(false);
    expect(hasAtomicPermission(perms, "inventory.balance.view")).toBe(false);
    expect(hasAtomicPermission(null, "pos.invoice.create")).toBe(false);
    expect(hasAtomicPermission(undefined, "pos.invoice.create")).toBe(false);
  });
});

describe("Backward Compatibility (التوافق الرجعي 100% مع الوحدات الـ29)", () => {
  it("deriveLegacyModulesFromAtomic: يشتق مستويات FULL / READ / NONE بدقة", () => {
    // 1. خريطة الأدمن تشتق FULL على جميع الوحدات
    const adminAtomic = ROLE_DEFAULT_ATOMIC_PERMISSIONS.admin;
    const adminModules = deriveLegacyModulesFromAtomic(adminAtomic);
    expect(adminModules.sales).toBe("FULL");
    expect(adminModules.pos).toBe("FULL");
    expect(adminModules.inventory).toBe("FULL");
    expect(adminModules.treasury).toBe("FULL");

    // 2. خريطة المدقق تشتق READ
    const auditorAtomic = ROLE_DEFAULT_ATOMIC_PERMISSIONS.auditor;
    const auditorModules = deriveLegacyModulesFromAtomic(auditorAtomic);
    expect(auditorModules.sales).toBe("READ");
    expect(auditorModules.inventory).toBe("READ");
    expect(auditorModules.treasury).toBe("READ");

    // 3. خريطة الكاشير: FULL على المبيعات ونقطة البيع، وREAD على المخزون
    const cashierAtomic = ROLE_DEFAULT_ATOMIC_PERMISSIONS.cashier;
    const cashierModules = deriveLegacyModulesFromAtomic(cashierAtomic);
    expect(cashierModules.sales).toBe("FULL");
    expect(cashierModules.pos).toBe("FULL");
    expect(cashierModules.inventory).toBe("READ");
  });

  it("deriveAtomicFromLegacyModules: يحول خريطة الوحدات القديمة إلى صلاحيات ذرية متوافقة", () => {
    const legacy = {
      sales: "FULL" as const,
      pos: "NONE" as const,
      inventory: "READ" as const,
    };
    const derived = deriveAtomicFromLegacyModules(legacy, "cashier");
    // المبيعات FULL => إنشاء الفاتورة متاح
    expect(derived["pos.invoice.create"]).toBe(true);
    // pos هي NONE => ورديات الـPOS محجوبة
    expect(derived["pos.shift.open"]).toBe(false);
    // inventory هي READ => استعلام الرصيد متاح فقط
    expect(derived["inventory.balance.view"]).toBe(true);
    expect(derived["inventory.transfer.create"]).toBe(false);
  });

  it("isPermissionEnvelope: يكشف بدقة بنية المظروف الموسع", () => {
    expect(isPermissionEnvelope({ atomic: {} })).toBe(true);
    expect(isPermissionEnvelope({ caps: {} })).toBe(true);
    expect(isPermissionEnvelope({ masking: {} })).toBe(true);
    expect(isPermissionEnvelope({ modules: {} })).toBe(true);

    expect(isPermissionEnvelope(null)).toBe(false);
    expect(isPermissionEnvelope("string")).toBe(false);
    expect(isPermissionEnvelope([])).toBe(false);
    expect(isPermissionEnvelope({ sales: "FULL" })).toBe(false);
  });

  it("normalizePermissionsInput: يطبع كافة أشكال المدخلات (قديم، ذري، مظروف)", () => {
    // 1. مدخل مظروف كامل
    const env = {
      atomic: { "pos.invoice.create": true },
      caps: { maxDiscountPercent: 12 },
      masking: { maskPurchaseCost: false },
    };
    const normEnv = normalizePermissionsInput(env, "cashier");
    expect(normEnv.atomic["pos.invoice.create"]).toBe(true);
    expect(normEnv.caps.maxDiscountPercent).toBe(12);
    expect(normEnv.masking.maskPurchaseCost).toBe(false);

    // 2. مدخل ذري مسطح
    const atomicFlat = {
      "pos.invoice.create": true,
      "pos.invoice.void": true,
    };
    const normAtomic = normalizePermissionsInput(atomicFlat, "cashier");
    expect(normAtomic.atomic["pos.invoice.void"]).toBe(true);
    expect(normAtomic.legacy.sales).toBe("FULL");

    // 3. مدخل وحدات قديمة مسطحة
    const legacyFlat = {
      sales: "READ" as const,
      pos: "NONE" as const,
    };
    const normLegacy = normalizePermissionsInput(legacyFlat, "user");
    expect(normLegacy.legacy.sales).toBe("READ");
    expect(normLegacy.atomic["pos.invoice.create"]).toBe(false);
    expect(normLegacy.atomic["pos.invoice.view"]).toBe(true);
  });
});

describe("UI & Ergonomics Helpers", () => {
  it("getAtomicPermissionsByDomain: يسترجع الصلاحيات الخاصة بقطاع محدد", () => {
    const posKeys = getAtomicPermissionsByDomain("pos");
    expect(posKeys.length).toBeGreaterThan(0);
    expect(posKeys.every((d) => d.domain === "pos")).toBe(true);

    const hrKeys = getAtomicPermissionsByDomain("hr");
    expect(hrKeys.length).toBeGreaterThan(0);
    expect(hrKeys.every((d) => d.domain === "hr")).toBe(true);
  });

  it("getAtomicPermissionsByResource: يسترجع الصلاحيات التابعة لمورد محدد", () => {
    const shiftKeys = getAtomicPermissionsByResource("pos", "shift");
    expect(shiftKeys.length).toBe(2);
    expect(shiftKeys.map((s) => s.action).sort()).toEqual(["close", "open"]);
  });

  it("searchAtomicPermissions: يدعم البحث الذكي بالعربية والإنجليزية ويصون المسافات", () => {
    // بحث بالعربية
    const printMatches = searchAtomicPermissions("طباعة");
    expect(printMatches.length).toBeGreaterThan(0);

    const discountMatches = searchAtomicPermissions("خصم");
    expect(discountMatches.length).toBeGreaterThan(0);

    // بحث بمفتاح إنجليزي
    const voidMatches = searchAtomicPermissions("pos.invoice.void");
    expect(voidMatches.length).toBe(1);
    expect(voidMatches[0].key).toBe("pos.invoice.void");

    // بحث بكلمات مفصولة بمسافة عربية (مثل "أمر شغل")
    const orderMatches = searchAtomicPermissions("أمر شغل");
    expect(orderMatches.length).toBeGreaterThan(0);

    // بحث فارغ يرجع الكل
    expect(searchAtomicPermissions("").length).toBe(ATOMIC_PERMISSION_DEFINITIONS.length);
  });

  it("getDomainStats: يحسب العدادات والنسب المئوية بدقة", () => {
    const cashierPerms = ROLE_DEFAULT_ATOMIC_PERMISSIONS.cashier;
    const stats = getDomainStats(cashierPerms, "pos");
    expect(stats.total).toBe(getAtomicPermissionsByDomain("pos").length);
    expect(stats.granted).toBeGreaterThan(0);
    expect(stats.percent).toBeGreaterThan(0);
    expect(stats.percent).toBeLessThanOrEqual(100);
  });

  it("filterAtomicOverrides: يكشف ويميز التخصيصات الفردية عن القالب الأساسي", () => {
    const base = ROLE_DEFAULT_ATOMIC_PERMISSIONS.cashier;
    const current = {
      ...base,
      "pos.invoice.void": true, // استثناء ممنوح
      "pos.invoice.create": false, // استثناء مسلوب
    };

    const diff = filterAtomicOverrides(current, base);
    expect(diff["pos.invoice.void"].overridden).toBe(true);
    expect(diff["pos.invoice.void"].granted).toBe(true);
    expect(diff["pos.invoice.void"].baseGranted).toBe(false);

    expect(diff["pos.invoice.create"].overridden).toBe(true);
    expect(diff["pos.invoice.create"].granted).toBe(false);
    expect(diff["pos.invoice.create"].baseGranted).toBe(true);

    expect(diff["pos.invoice.reprint"].overridden).toBe(false);
  });

  it("checkSodConflicts: يرصد تعارضات فصل المهام (Maker/Checker) بدقة", () => {
    // دور يحتوي على إنشاء سند واعتماد سند في آن واحد (خطر SoD)
    const dangerousPerms: AtomicPermissionsMap = {
      "treasury.voucher_out.create": true,
      "treasury.voucher_out.approve": true,
    };
    const conflicts = checkSodConflicts(dangerousPerms);
    expect(conflicts.length).toBeGreaterThan(0);
    const voucherConflict = conflicts.find((c) => c.group === "voucher");
    expect(voucherConflict).toBeDefined();

    // دور سليم: إنشاء فقط
    const safePerms: AtomicPermissionsMap = {
      "treasury.voucher_out.create": true,
      "treasury.voucher_out.approve": false,
    };
    expect(checkSodConflicts(safePerms).find((c) => c.group === "voucher")).toBeUndefined();
  });
});

describe("Caps Enforcement Helpers (فحص السقوف الرقمية)", () => {
  const caps: Required<OperationalCaps> = {
    maxDiscountPercent: 10,
    maxDiscountAmountIqd: "50000.00",
    maxCreditSaleLimitIqd: "100000.00",
    maxPaymentVoucherAmountIqd: "1000000.00",
    maxExpenseVoucherAmountIqd: "25000.00",
    maxRefundAmountIqd: "50000.00",
  };

  it("isDiscountPercentWithinCap: يرفض الخصم المتجاوز للنسبة", () => {
    expect(isDiscountPercentWithinCap(5, caps)).toBe(true);
    expect(isDiscountPercentWithinCap(10, caps)).toBe(true);
    expect(isDiscountPercentWithinCap(10.5, caps)).toBe(false);
  });

  it("isDiscountAmountWithinCap: يرفض الخصم المتجاوز للمبلغ بالدينار", () => {
    expect(isDiscountAmountWithinCap("25000.00", caps)).toBe(true);
    expect(isDiscountAmountWithinCap(50000, caps)).toBe(true);
    expect(isDiscountAmountWithinCap("50000.01", caps)).toBe(false);
  });

  it("isCreditSaleWithinCap: يضبط سقف البيع الآجل", () => {
    expect(isCreditSaleWithinCap("90000.00", caps)).toBe(true);
    expect(isCreditSaleWithinCap("100000.00", caps)).toBe(true);
    expect(isCreditSaleWithinCap("150000.00", caps)).toBe(false);
  });

  it("isPaymentVoucherWithinCap: يضبط سقف سندات الصرف", () => {
    expect(isPaymentVoucherWithinCap("500000.00", caps)).toBe(true);
    expect(isPaymentVoucherWithinCap("1000000.00", caps)).toBe(true);
    expect(isPaymentVoucherWithinCap("1000001.00", caps)).toBe(false);
  });

  it("isExpenseWithinCap: يضبط سقف المصروفات التشغيلية", () => {
    expect(isExpenseWithinCap("20000.00", caps)).toBe(true);
    expect(isExpenseWithinCap("25000.00", caps)).toBe(true);
    expect(isExpenseWithinCap("30000.00", caps)).toBe(false);
  });

  it("isRefundWithinCap: يضبط سقف المرتجعات النقدية الفورية", () => {
    expect(isRefundWithinCap("45000.00", caps)).toBe(true);
    expect(isRefundWithinCap("50000.00", caps)).toBe(true);
    expect(isRefundWithinCap("50001.00", caps)).toBe(false);
  });
});

describe("Milestone 1 Remediation Invariants & Edge Cases", () => {
  const ALL_29_LEGACY_MODULES = [
    "pos", "sales", "purchases", "inventory", "workorders", "channels", "treasury", "expenses",
    "reports", "assets", "hr", "commissions", "consignments", "reservations", "digital_cards",
    "gifts", "catalogAnomalies", "courier", "announcements", "users", "settings", "customers",
    "crm", "campaigns", "collections", "store", "productStudio", "products", "suppliers", "tasks",
  ];

  it("Fix 1: يشتق كافة الوحدات الـ29/30 بالكامل مع صلاحيات المدير الإدارية", () => {
    const adminAtomic = ROLE_DEFAULT_ATOMIC_PERMISSIONS.admin;
    const adminDerived = deriveLegacyModulesFromAtomic(adminAtomic);

    // التحقق من اشتقاق كل الوحدات الـ29/30
    for (const mod of ALL_29_LEGACY_MODULES) {
      expect(adminDerived[mod]).toBe("FULL");
    }

    // المدير يشتق FULL على products وreports
    const managerAtomic = ROLE_DEFAULT_ATOMIC_PERMISSIONS.manager;
    const managerDerived = deriveLegacyModulesFromAtomic(managerAtomic);
    expect(managerDerived.products).toBe("FULL");
    expect(managerDerived.reports).toBe("FULL");

    // المدقق لا يملك FULL على أي وحدة إطلاقاً
    const auditorAtomic = ROLE_DEFAULT_ATOMIC_PERMISSIONS.auditor;
    const auditorDerived = deriveLegacyModulesFromAtomic(auditorAtomic);
    const fullAuditor = Object.entries(auditorDerived).filter(([_, l]) => l === "FULL");
    expect(fullAuditor).toHaveLength(0);
  });

  it("Fix 2: normalizePermissionsInput يتعامل مع الكائن الفارغ {} بالسقوط لقيم الدور الافتراضية", () => {
    const normAdmin = normalizePermissionsInput({}, "admin");
    expect(Object.keys(normAdmin.legacy).length).toBeGreaterThanOrEqual(29);
    expect(normAdmin.legacy.sales).toBe("FULL");
    expect(normAdmin.legacy.products).toBe("FULL");
    expect(normAdmin.atomic["pos.invoice.create"]).toBe(true);

    const normManager = normalizePermissionsInput({}, "manager");
    expect(normManager.legacy.products).toBe("FULL");
    expect(normManager.legacy.reports).toBe("FULL");
  });

  it("Fix 3: حماية دوال المساعدة ضد مدخلات null وundefined دون إلقاء استثناءات", () => {
    expect(() => checkSodConflicts(null)).not.toThrow();
    expect(checkSodConflicts(null)).toEqual([]);
    expect(checkSodConflicts(undefined)).toEqual([]);

    expect(() => filterAtomicOverrides(null, null)).not.toThrow();
    const overrides = filterAtomicOverrides(null, null);
    expect(overrides["pos.invoice.create"].overridden).toBe(false);

    expect(() => searchAtomicPermissions(null)).not.toThrow();
    expect(searchAtomicPermissions(null)).toHaveLength(104);
    expect(searchAtomicPermissions(undefined)).toHaveLength(104);

    expect(() => deriveLegacyModulesFromAtomic(null)).not.toThrow();
    const nullDerived = deriveLegacyModulesFromAtomic(null);
    expect(nullDerived.sales).toBe("NONE");

    expect(() => deriveAtomicFromLegacyModules(null)).not.toThrow();
    const nullAtomic = deriveAtomicFromLegacyModules(null);
    expect(nullAtomic["inventory.balance.view"]).toBe(true);
  });

  it("Fix 4: حماية السقوف المالية ضد تسريب NaN وInfinity", () => {
    // التحقق من الرفض التلقائي لـ NaN و Infinity حتى عند عدم وجود سقف
    expect(isDiscountAmountWithinCap(NaN, null)).toBe(false);
    expect(isDiscountAmountWithinCap(Infinity, null)).toBe(false);
    expect(isDiscountAmountWithinCap(-Infinity, null)).toBe(false);
    expect(isDiscountAmountWithinCap("invalid", null)).toBe(false);
    expect(isDiscountAmountWithinCap("", null)).toBe(false);

    expect(isCreditSaleWithinCap(NaN, null)).toBe(false);
    expect(isCreditSaleWithinCap(Infinity, null)).toBe(false);

    expect(isPaymentVoucherWithinCap(NaN, null)).toBe(false);
    expect(isPaymentVoucherWithinCap(Infinity, null)).toBe(false);

    expect(isExpenseWithinCap(NaN, null)).toBe(false);
    expect(isExpenseWithinCap(Infinity, null)).toBe(false);

    expect(isRefundWithinCap(NaN, null)).toBe(false);
    expect(isRefundWithinCap(Infinity, null)).toBe(false);

    expect(isDiscountPercentWithinCap(NaN, null)).toBe(false);
    expect(isDiscountPercentWithinCap(Infinity, null)).toBe(false);
  });

  it("Fix 5: إلزام سقف الخصم بنطاق 0-100% بدقة صارمة حتى بدون قيود", () => {
    expect(isDiscountPercentWithinCap(101, null)).toBe(false);
    expect(isDiscountPercentWithinCap(500, null)).toBe(false);
    expect(isDiscountPercentWithinCap(-1, null)).toBe(false);
    expect(isDiscountPercentWithinCap(100, null)).toBe(true);
    expect(isDiscountPercentWithinCap(0, null)).toBe(true);
    expect(isDiscountPercentWithinCap(50, null)).toBe(true);
  });

  it("Fix 6: تطبيع البحث العربي وطي التاء المربوطة والهمزات (normalizeSearchText)", () => {
    const withTaa = searchAtomicPermissions("طباعة");
    const withHaa = searchAtomicPermissions("طباعه");
    expect(withTaa.length).toBeGreaterThan(0);
    expect(withHaa.length).toBe(withTaa.length);

    const withHamza = searchAtomicPermissions("أمر");
    const withoutHamza = searchAtomicPermissions("امر");
    expect(withHamza.length).toBeGreaterThan(0);
    expect(withoutHamza.length).toBe(withHamza.length);
  });
});
