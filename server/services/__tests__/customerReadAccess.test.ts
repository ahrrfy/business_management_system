import { describe, expect, it } from "vitest";
import { customerReadAllowed, customerReceptionCreateAllowed, userHasCrmWriteAccess } from "../../trpc";

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

  it("denies unprivileged user without relevant permissions or override", () => {
    expect(customerReadAllowed({ role: "warehouse" })).toBe(false);
    expect(customerReadAllowed({ role: "delivery" })).toBe(false);
    expect(customerReadAllowed({ role: "unknown_role" })).toBe(false);
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

  it("allows cashier to create customer even when crm=NONE if sales=FULL", () => {
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
