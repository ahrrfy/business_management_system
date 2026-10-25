import { expect, it } from "vitest";
import { financialSourceLabel } from "../financialSource";

it.each([
  ["DRAWER", "درج كاشير"],
  ["TREASURY", "خزينة إدارية"],
  ["BANK", "حساب بنكي"],
  ["STOCK", "مخزون"],
  ["OTHER", "مصدر آخر"],
  ["CASH", "نقدي"],
  ["TRANSFER", "تحويل"],
  ["LEGACY", "LEGACY"],
  ["constructor", "constructor"],
])("formats source %s as %s", (code, label) => {
  expect(financialSourceLabel(code)).toBe(label);
});
it("preserves the original unknown source text", () => {
  expect(financialSourceLabel("LEGACY", "المصدر التاريخي")).toBe(
    "المصدر التاريخي",
  );
});
