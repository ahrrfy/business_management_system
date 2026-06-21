/**
 * اختبار وحدة نقيّ (بلا قاعدة) لبوّابة RBAC في البحث الشامل — `canSeeType`.
 *
 * يثبّت إصلاح تسريب PII (مراجعة عدائية): رؤية الموظفين تُحكَم بخريطة صلاحيات HR
 * المحسوبة (قالب الدور + permissionsOverride) لا باسم الدور الأساس — مطابِقةً تماماً
 * لـ requireModule("hr","READ")، وإدارة المستخدمين للأدمن فقط.
 */
import { describe, expect, it } from "vitest";
import { canSeeType } from "../globalSearchService";

describe("canSeeType — RBAC للموظف/المستخدم (يحلّ permissionsOverride)", () => {
  it("الأدمن يرى كل شيء", () => {
    expect(canSeeType("admin", "EMPLOYEE")).toBe(true);
    expect(canSeeType("admin", "USER")).toBe(true);
  });

  it("إدارة المستخدمين (USER) للأدمن فقط", () => {
    for (const role of ["manager", "accountant", "auditor", "cashier", "warehouse", "user"]) {
      expect(canSeeType(role, "USER")).toBe(false);
    }
  });

  it("الموظفون يُحكَمون بوحدة hr المحسوبة (FULL أو READ) لا باسم الدور", () => {
    expect(canSeeType("manager", "EMPLOYEE")).toBe(true); // hr: FULL
    expect(canSeeType("accountant", "EMPLOYEE")).toBe(true); // hr: READ
    expect(canSeeType("auditor", "EMPLOYEE")).toBe(true); // hr: READ
    expect(canSeeType("cashier", "EMPLOYEE")).toBe(false); // hr: NONE
    expect(canSeeType("warehouse", "EMPLOYEE")).toBe(false); // hr: NONE
    expect(canSeeType("user", "EMPLOYEE")).toBe(false); // hr: NONE
  });

  it("override يَجبّ القالب: مدير أُلغِيت عنه hr لا يرى الموظفين (سدّ تسريب PII)", () => {
    expect(canSeeType("manager", "EMPLOYEE", { hr: "NONE" })).toBe(false);
  });

  it("override يَمنح: كاشير مُنح hr=FULL يرى الموظفين (لا حجب خاطئ)", () => {
    expect(canSeeType("cashier", "EMPLOYEE", { hr: "FULL" })).toBe(true);
  });

  it("سلوك الأنواع الأخرى غير متأثّر: الكاشير يرى المنتجات لا الموردين/المشتريات/المصاريف", () => {
    expect(canSeeType("cashier", "PRODUCT")).toBe(true);
    expect(canSeeType("cashier", "SUPPLIER")).toBe(false);
    expect(canSeeType("cashier", "PURCHASE_ORDER")).toBe(false);
    expect(canSeeType("cashier", "EXPENSE")).toBe(false);
  });
});
