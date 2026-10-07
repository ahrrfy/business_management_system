import { describe, expect, it } from "vitest";
import { customerReadAllowed, customerReceptionCreateAllowed, userHasCrmWriteAccess } from "../../trpc";
import { maskCustomerSensitive } from "../../lib/redact";

describe("customerReadAllowed access check", () => {
  it("allows admin unconditionally", () => {
    expect(customerReadAllowed({ role: "admin" })).toBe(true);
    expect(customerReadAllowed({ role: "admin", permissionsOverride: { crm: "NONE", sales: "NONE" } })).toBe(true);
  });

  it("allows default cashier (who has sales=FULL by default)", () => {
    expect(customerReadAllowed({ role: "cashier" })).toBe(true);
  });

  it("allows cashier even if crm is explicitly set to NONE because sales=FULL", () => {
    expect(
      customerReadAllowed({
        role: "cashier",
        permissionsOverride: { crm: "NONE" },
      }),
    ).toBe(true);
  });

  it("allows print_operator who has pos=FULL or workorders=FULL", () => {
    expect(customerReadAllowed({ role: "print_operator" })).toBe(true);
  });

  it("allows sales_rep who has sales/crm permissions", () => {
    expect(customerReadAllowed({ role: "sales_rep" })).toBe(true);
  });

  it("allows accountant who has crm permissions in allowed roles", () => {
    expect(customerReadAllowed({ role: "accountant" })).toBe(true);
  });

  it("allows an unprivileged role if explicitly granted sales READ or crm READ override", () => {
    expect(
      customerReadAllowed({
        role: "warehouse",
        permissionsOverride: { sales: "READ" },
      }),
    ).toBe(true);

    expect(
      customerReadAllowed({
        role: "warehouse",
        permissionsOverride: { crm: "READ" },
      }),
    ).toBe(true);
  });

  it("allows manager with default permissions", () => {
    expect(customerReadAllowed({ role: "manager" })).toBe(true);
  });

  it("allows cashier with sales=NONE if pos or workorders has READ", () => {
    expect(
      customerReadAllowed({
        role: "cashier",
        permissionsOverride: {
          crm: "NONE",
          sales: "NONE",
          pos: "READ",
        },
      }),
    ).toBe(true);

    expect(
      customerReadAllowed({
        role: "cashier",
        permissionsOverride: {
          crm: "NONE",
          sales: "NONE",
          pos: "NONE",
          workorders: "READ",
        },
      }),
    ).toBe(true);
  });

  it("allows station cashiers (Reception / Print / Retail) even when customers=NONE legacy key is present", () => {
    // كاشير استقبال أوامر شغل — السيناريو الواقعي للبلاغ: crm=NONE + customers=NONE + workorders=FULL
    expect(
      customerReadAllowed({
        role: "cashier",
        permissionsOverride: {
          crm: "NONE",
          customers: "NONE",
          pos: "NONE",
          sales: "NONE",
          workorders: "FULL",
        },
      }),
    ).toBe(true);

    // كاشير طباعة مع customers=NONE
    expect(
      customerReadAllowed({
        role: "cashier",
        permissionsOverride: {
          crm: "NONE",
          customers: "NONE",
          sales: "NONE",
          workorders: "NONE",
          pos: "FULL",
        },
      }),
    ).toBe(true);

    // كاشير تجزئة مع customers=NONE
    expect(
      customerReadAllowed({
        role: "cashier",
        permissionsOverride: {
          crm: "NONE",
          customers: "NONE",
          pos: "NONE",
          workorders: "NONE",
          sales: "FULL",
        },
      }),
    ).toBe(true);

    // فني مطبعة ومشغل محطة الاستقبال
    expect(
      customerReadAllowed({
        role: "print_operator",
        permissionsOverride: {
          crm: "NONE",
          customers: "NONE",
        },
      }),
    ).toBe(true);

    // دور مخصص مبني على user مع منح محطة الاستقبال صراحةً
    expect(
      customerReadAllowed({
        role: "user",
        permissionsOverride: {
          customers: "NONE",
          crm: "NONE",
          workorders: "FULL",
        },
      }),
    ).toBe(true);
  });

  it("denies unprivileged user without relevant permissions or override", () => {
    expect(customerReadAllowed({ role: "warehouse" })).toBe(false);
    expect(customerReadAllowed({ role: "delivery" })).toBe(false);
    expect(customerReadAllowed({ role: "unknown_role" })).toBe(false);
    expect(
      customerReadAllowed({
        role: "manager",
        permissionsOverride: { customers: "NONE" },
      }),
    ).toBe(false);
    expect(
      customerReadAllowed({
        role: "cashier",
        permissionsOverride: {
          crm: "NONE",
          sales: "NONE",
          pos: "NONE",
          workorders: "NONE",
        },
      }),
    ).toBe(false);
  });
});

describe("customerReceptionCreateAllowed access check", () => {
  it("allows admin unconditionally", () => {
    expect(customerReceptionCreateAllowed({ role: "admin" })).toBe(true);
  });

  it("allows cashier with default permissions (sales=FULL)", () => {
    expect(customerReceptionCreateAllowed({ role: "cashier" })).toBe(true);
  });

  it("allows cashier to create customer even when crm=NONE if workorders=FULL", () => {
    expect(
      customerReceptionCreateAllowed({
        role: "cashier",
        permissionsOverride: { crm: "NONE" },
      }),
    ).toBe(true);
  });

  it("allows print_operator with pos=FULL or workorders=FULL", () => {
    expect(customerReceptionCreateAllowed({ role: "print_operator" })).toBe(true);
  });

  it("allows user with legacy override customers=FULL", () => {
    expect(
      customerReceptionCreateAllowed({
        role: "warehouse",
        permissionsOverride: { customers: "FULL" },
      }),
    ).toBe(true);
  });

  it("allows station cashiers with sales=FULL or pos=FULL even when crm=NONE", () => {
    expect(
      customerReceptionCreateAllowed({
        role: "cashier",
        permissionsOverride: { crm: "NONE", sales: "FULL", workorders: "NONE", pos: "NONE" },
      }),
    ).toBe(true);

    expect(
      customerReceptionCreateAllowed({
        role: "cashier",
        permissionsOverride: { crm: "NONE", pos: "FULL", sales: "NONE", workorders: "NONE" },
      }),
    ).toBe(true);

    expect(
      customerReceptionCreateAllowed({
        role: "user",
        permissionsOverride: { sales: "FULL" },
      }),
    ).toBe(true);

    expect(
      customerReceptionCreateAllowed({
        role: "user",
        permissionsOverride: { pos: "FULL" },
      }),
    ).toBe(true);

    expect(
      customerReceptionCreateAllowed({
        role: "user",
        permissionsOverride: { workorders: "FULL" },
      }),
    ).toBe(true);
  });

  it("denies unprivileged user without FULL permission in crm/sales/pos/workorders", () => {
    expect(customerReceptionCreateAllowed({ role: "warehouse" })).toBe(false);
    expect(
      customerReceptionCreateAllowed({
        role: "cashier",
        permissionsOverride: {
          crm: "NONE",
          sales: "NONE",
          pos: "NONE",
          workorders: "NONE",
        },
      }),
    ).toBe(false);
  });
});

describe("maskCustomerSensitive masking contracts and options", () => {
  const sampleCustomer = {
    id: 42,
    name: "مكتبة النجاح",
    phone: "07701234567",
    creditLimit: "500000.00",
    currentBalance: "120000.00",
    openingBalance: "50000.00",
    notes: "عميل قديم",
  };

  it("returns null or undefined as-is", () => {
    expect(maskCustomerSensitive(null, "cashier")).toBeNull();
    expect(maskCustomerSensitive(undefined, "cashier")).toBeUndefined();
    expect(maskCustomerSensitive(null, "admin")).toBeNull();
  });

  it("preserves all sensitive fields for elevated roles (admin and manager)", () => {
    const forAdmin = maskCustomerSensitive({ ...sampleCustomer }, "admin");
    expect(forAdmin.creditLimit).toBe("500000.00");
    expect(forAdmin.currentBalance).toBe("120000.00");
    expect(forAdmin.openingBalance).toBe("50000.00");

    const forManager = maskCustomerSensitive({ ...sampleCustomer }, "manager");
    expect(forManager.creditLimit).toBe("500000.00");
    expect(forManager.currentBalance).toBe("120000.00");
    expect(forManager.openingBalance).toBe("50000.00");
  });

  it("masks creditLimit, currentBalance, and openingBalance for non-elevated roles without options", () => {
    const masked = maskCustomerSensitive({ ...sampleCustomer }, "cashier");
    expect(masked.id).toBe(42);
    expect(masked.name).toBe("مكتبة النجاح");
    expect(masked.phone).toBe("07701234567");
    expect(masked.creditLimit).toBeNull();
    expect(masked.currentBalance).toBe("0");
    expect(masked.openingBalance).toBe("0");
  });

  it("masks fields when role is null or undefined without options", () => {
    const masked = maskCustomerSensitive({ ...sampleCustomer }, null);
    expect(masked.creditLimit).toBeNull();
    expect(masked.currentBalance).toBe("0");
    expect(masked.openingBalance).toBe("0");
  });

  it("preserves creditLimit when preserveCreditLimit: true is specified", () => {
    const withPositiveLimit = maskCustomerSensitive(
      { ...sampleCustomer, creditLimit: "750000.00" },
      "cashier",
      { preserveCreditLimit: true },
    );
    expect(withPositiveLimit.creditLimit).toBe("750000.00");
    expect(withPositiveLimit.currentBalance).toBe("0");
    expect(withPositiveLimit.openingBalance).toBe("0");

    const withZeroLimit = maskCustomerSensitive(
      { ...sampleCustomer, creditLimit: "0" },
      "cashier",
      { preserveCreditLimit: true },
    );
    expect(withZeroLimit.creditLimit).toBe("0");
    expect(withZeroLimit.currentBalance).toBe("0");

    const withNullLimit = maskCustomerSensitive(
      { ...sampleCustomer, creditLimit: null },
      "cashier",
      { preserveCreditLimit: true },
    );
    expect(withNullLimit.creditLimit).toBeNull();
  });

  it("preserves both creditLimit and currentBalance when requested for cashiering", () => {
    const cashierResult = maskCustomerSensitive(
      { ...sampleCustomer, creditLimit: "0", currentBalance: "35000.00" },
      "cashier",
      { preserveCreditLimit: true, preserveCurrentBalance: true },
    );
    expect(cashierResult.creditLimit).toBe("0");
    expect(cashierResult.currentBalance).toBe("35000.00");
    // openingBalance must still be masked to 0
    expect(cashierResult.openingBalance).toBe("0");
  });

  it("correctly preserves negative balance (advance credit owed to customer) when preserveCurrentBalance: true", () => {
    const cashierResult = maskCustomerSensitive(
      { ...sampleCustomer, currentBalance: "-15000.00" },
      "cashier",
      { preserveCreditLimit: true, preserveCurrentBalance: true },
    );
    expect(cashierResult.currentBalance).toBe("-15000.00");
  });
});

