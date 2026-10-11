import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { salesRepresentativeOptions } from "./salesRepresentatives";

describe("sales representative account identity", () => {
  it("uses the linked user even when an employee ID identifies another user", () => {
    expect(salesRepresentativeOptions([
      { id: 9, userId: 2, fullName: "مندوب", position: "المبيعات", branchName: "الرئيسي" },
      { id: 2, userId: 9, fullName: "موظف آخر" },
      { id: 3, userId: null, fullName: "بدون حساب" },
    ])).toEqual([
      { id: 2, name: "مندوب", position: "المبيعات", branchName: "الرئيسي" },
      { id: 9, name: "موظف آخر", position: undefined, branchName: undefined },
    ]);
  });

  it("preserves the employee label when the display name is missing", () => {
    expect(salesRepresentativeOptions([{ id: 9, userId: 2 }])[0])
      .toMatchObject({ id: 2, name: "موظف #9" });
  });

  it.each(["../../pages/SalesInvoiceNew.tsx", "../pos/CartPanel.tsx"])(
    "wires %s to the linked-account options",
    (sourcePath) => {
      const source = readFileSync(new URL(sourcePath, import.meta.url), "utf8");
      expect(/salesRepresentativeOptions\(\s*(?:employeesQ|empsQ)\.data\?\.rows\s*\?\?\s*\[\]/.test(source)).toBe(true);
    },
  );
});
