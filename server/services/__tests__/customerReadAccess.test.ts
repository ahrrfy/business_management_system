import { describe, expect, it } from "vitest";
import { customerReadAllowed } from "../../trpc";

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
