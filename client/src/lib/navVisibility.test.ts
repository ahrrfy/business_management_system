// canSeeGate — بوّابة رؤية التنقّل/التبويبات (تدقيق ١٧/٧، خطر #11).
// الخلل المُعالَج: بوّابة module-only كانت تعيد true فراغياً (roleOk صحيح فراغياً بلا قيود دور)
// فتُظهر التبويب لكل الأدوار وإن رفضها الخادم بـ403؛ ولم تكن تستشير قالب الدور (المنح الصريح فقط).
import { describe, expect, it } from "vitest";
import { canSeeGate } from "./navVisibility";

describe("canSeeGate — قيود الدور", () => {
  it("بلا بوّابة ⇒ مرئي للكل", () => {
    expect(canSeeGate(undefined, "cashier", null)).toBe(true);
  });
  it("adminOnly: admin فقط، ولا يُفتح بمنح وحدة", () => {
    expect(canSeeGate({ adminOnly: true }, "admin", null)).toBe(true);
    expect(canSeeGate({ adminOnly: true }, "manager", null)).toBe(false);
    expect(canSeeGate({ adminOnly: true, module: "users" }, "cashier", { users: "FULL" })).toBe(false);
  });
  it("managerOnly: admin/manager فقط", () => {
    expect(canSeeGate({ managerOnly: true }, "manager", null)).toBe(true);
    expect(canSeeGate({ managerOnly: true }, "cashier", null)).toBe(false);
  });
  it("roles: الدور ضمن القائمة أو admin", () => {
    expect(canSeeGate({ roles: ["accountant"] }, "accountant", null)).toBe(true);
    expect(canSeeGate({ roles: ["accountant"] }, "admin", null)).toBe(true);
    expect(canSeeGate({ roles: ["accountant"] }, "cashier", null)).toBe(false);
  });
});

describe("canSeeGate — بوّابة الوحدة (الإصلاح الجوهريّ)", () => {
  it("module-only: دورٌ بلا القالب ولا منح صريح ⇒ محجوب (كان مرئياً فراغياً)", () => {
    // الكاشير reports=NONE قالبياً ⇒ تبويب تقارير module-only يجب أن يُحجب.
    expect(canSeeGate({ module: "reports" }, "cashier", null)).toBe(false);
  });
  it("module-only: دورٌ يملك القالب ⇒ مرئي (لا إفراط في الحجب)", () => {
    // الكاشير crm=FULL قالبياً ⇒ تبويب crm module-only يبقى مرئياً.
    expect(canSeeGate({ module: "crm" }, "cashier", null)).toBe(true);
  });
  it("module-only: admin يمرّ دائماً", () => {
    expect(canSeeGate({ module: "reports" }, "admin", null)).toBe(true);
  });
  it("module-only: منح صريح (override) يفتح رغم القالب NONE", () => {
    expect(canSeeGate({ module: "reports", level: "READ" }, "cashier", { reports: "READ" })).toBe(true);
  });
});

describe("canSeeGate — {roles + module}: مرآة requireModuleGate", () => {
  it("دورٌ خارج القائمة بقالبٍ يملك الوحدة لكن بلا منح صريح ⇒ محجوب (يطابق 403 الخادم)", () => {
    // الكاشير collections=READ قالبياً لكنه خارج [manager] ⇒ requireModuleGate يرفضه بلا منح صريح.
    expect(canSeeGate({ roles: ["manager"], module: "collections", level: "READ" }, "cashier", null)).toBe(false);
  });
  it("منح صريح للدور خارج القائمة ⇒ مرئي", () => {
    expect(
      canSeeGate({ roles: ["manager"], module: "collections", level: "READ" }, "cashier", { collections: "READ" }),
    ).toBe(true);
  });
  it("دورٌ ضمن القائمة بقالبٍ كافٍ ⇒ مرئي", () => {
    expect(canSeeGate({ roles: ["manager"], module: "collections", level: "READ" }, "manager", null)).toBe(true);
  });
});
