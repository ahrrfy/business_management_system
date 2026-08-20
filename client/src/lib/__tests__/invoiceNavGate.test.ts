/**
 * تطابق بوّابة **قائمة الفواتير** بين الشاشة والخادم (١٩/٨).
 *
 * الخطر الذي يحرسه: البوّابة معرَّفة مرّتين — نطاقاً في `invoiceViewScopeForUser` (خادم)
 * وشرطَ ظهورٍ في `INVOICE_LIST_GATE` (تنقّل). أيّ انجرافٍ بينهما يُنتج أحد عطبين لا ثالث:
 *  · مدخلٌ ظاهر يُرفَض بـ403 (وعدٌ كاذب في الشريط)،
 *  · أو مدخلٌ مخفيّ يقبله الخادم — وهو بالضبط البلاغ الأصليّ: «الفواتير لا تظهر
 *    للمستخدم المنفّذ ولا يرى حتى فواتيره التي أنشأها هو».
 *
 * الاختبار يقارن القرارين على **كل الأدوار القالبية** بلا استثناء.
 */
import { describe, expect, it } from "vitest";
import { INVOICE_LIST_GATE, canSeeGate } from "../navVisibility";
import { ROLE_TEMPLATES, SECTION_CASHIER_ROLES, resolvePermissions, type RoleKey } from "@shared/permissions";

/** مرآةُ `invoiceViewScopeForUser` (server/trpc.ts) — تُبقى متطابقةً نصّاً. */
function serverGrantsInvoiceList(role: string, override: Record<string, string> | null): boolean {
  if (role === "admin") return true;
  const map = resolvePermissions(role as RoleKey, override as never) as Record<string, string>;
  if (map.sales === "FULL" || map.sales === "READ") return true;
  if (map.workorders === "FULL") return true;
  if (map.pos === "FULL") return true;
  return false;
}

describe("بوّابة قائمة الفواتير — الشاشة تطابق الخادم", () => {
  it("كل دورٍ قالبيّ: قرار الظهور = قرار الخادم", () => {
    const mismatches: string[] = [];
    for (const role of Object.keys(ROLE_TEMPLATES)) {
      const ui = canSeeGate(INVOICE_LIST_GATE, role, null);
      const server = serverGrantsInvoiceList(role, null);
      if (ui !== server) mismatches.push(`${role}: شاشة=${ui} خادم=${server}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("أدوار المحطّات (كاشير التجزئة/الطباعة/الاستقبال): كلٌّ يرى المدخل بنطاقه", () => {
    for (const r of SECTION_CASHIER_ROLES) {
      const override = r.permissions as unknown as Record<string, string>;
      const ui = canSeeGate(INVOICE_LIST_GATE, r.baseRole, override as never);
      const server = serverGrantsInvoiceList(r.baseRole, override);
      expect(ui, `${r.key}: شاشة=${ui} خادم=${server}`).toBe(server);
      // ولا واحدَ منهم محجوبٌ عن فواتيره — جوهر البلاغ.
      expect(ui, `${r.key} يجب أن يرى مدخل فواتيره`).toBe(true);
    }
  });

  it("بلا مبيعات ولا محطّة ⇒ المدخل مخفيّ (البوّابة ليست مفتوحةً للجميع)", () => {
    const denied = { sales: "NONE", workorders: "NONE", pos: "NONE" } as never;
    expect(canSeeGate(INVOICE_LIST_GATE, "manager", denied)).toBe(false);
    expect(serverGrantsInvoiceList("manager", denied as never)).toBe(false);
  });
});
