import { describe, expect, it } from "vitest";
import {
  EXCHANGE_CONTROL_SCOPE_DISCLOSURE,
  exchangeDoubleEntryRoleLabel,
  doubleEntryRoleLabel,
  OPENING_ALLOCATION_ROLES,
  allocationKey,
} from "./doubleEntryRoleLabels";

describe("exchange double-entry labels", () => {
  it("يفصل النقد الفعلي عن الذمم المدينة والدائنة بكل عملة", () => {
    expect(exchangeDoubleEntryRoleLabel("FOREIGN_CASH_USD")).toContain("نقد دولار فعلي");
    expect(exchangeDoubleEntryRoleLabel("EXCHANGE_RECEIVABLE_IQD")).toContain("مدينة — دينار");
    expect(exchangeDoubleEntryRoleLabel("EXCHANGE_RECEIVABLE_USD")).toContain("مدينة — دولار");
    expect(exchangeDoubleEntryRoleLabel("EXCHANGE_PAYABLE_IQD")).toContain("دائنة — دينار");
    expect(exchangeDoubleEntryRoleLabel("EXCHANGE_PAYABLE_USD")).toContain("دائنة — دولار");
  });

  it("يصرّح بأن control للشركة والحيازة للفرع", () => {
    expect(EXCHANGE_CONTROL_SCOPE_DISCLOSURE).toContain("مستوى الشركة");
    expect(EXCHANGE_CONTROL_SCOPE_DISCLOSURE).toContain("حسب الفرع");
    expect(exchangeDoubleEntryRoleLabel("UNKNOWN")).toBeNull();
  });

  it("يطابق تسميات الأدوار المحاسبية الشاملة ومفتاح التخصيص", () => {
    expect(doubleEntryRoleLabel("AR")).toBe("ذمم العملاء");
    expect(doubleEntryRoleLabel("AP")).toBe("ذمم الموردين");
    expect(doubleEntryRoleLabel("CASH")).toBe("النقد");
    expect(doubleEntryRoleLabel("UNKNOWN")).toBe("UNKNOWN");
    expect(OPENING_ALLOCATION_ROLES).toContain("CAPITAL");
    expect(allocationKey(null, "CAPITAL")).toBe("GLOBAL:CAPITAL");
    expect(allocationKey(3, "OWNER_CURRENT")).toBe("3:OWNER_CURRENT");
  });
});

