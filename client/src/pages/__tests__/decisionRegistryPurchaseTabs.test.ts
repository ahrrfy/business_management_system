/**
 * روابطُ سجلّ القرارات إلى `PurchasesHub` — يقيس أنّ كلَّ `/purchases?tab=…` في السجلّ يسمّي تبويباً
 * **مُسجَّلاً فعلاً** في الشاشة. `PageTabs` يسقط بصمتٍ إلى أوّل تبويبٍ مرئيّ حين لا يطابق الاسم،
 * فكان رابطا عكس الاستلام وعكس فاتورة المورّد يفتحان تبويباً آخر (Codex على #1004).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allDecisions, decisionSpec } from "@shared/decisionRegistry";

const hub = readFileSync(new URL("../PurchasesHub.tsx", import.meta.url), "utf8");
const hubTabs = new Set(Array.from(hub.matchAll(/value:\s*"([a-z][a-z-]*)"/g), (m) => m[1]));

describe("روابط السجل الى تبويبات المشتريات", () => {
  it("يقرأ تبويبات PurchasesHub فعلا (لا قائمة مكتوبة تشيخ)", () => {
    expect(hubTabs.has("goods-receipt-reversals")).toBe(true);
    expect(hubTabs.has("supplier-invoice-approvals")).toBe(true);
    expect(hubTabs.has("returns-governance")).toBe(true);
  });

  it("كل رابط /purchases?tab= في السجل يسمي تبويبا مسجلا", () => {
    const purchaseTabLinks = allDecisions()
      .map((d) => ({ kind: d.kind, href: d.href(1) }))
      .filter((x) => x.href.startsWith("/purchases?tab="));
    expect(purchaseTabLinks.length).toBeGreaterThanOrEqual(7);
    for (const { kind, href } of purchaseTabLinks) {
      const tab = href.slice("/purchases?tab=".length);
      expect(hubTabs.has(tab), `${kind} → ${href}`).toBe(true);
    }
  });

  it("عكس الاستلام وعكس فاتورة المورد يفتحان تبويبيهما الحقيقيين", () => {
    expect(decisionSpec("purchase.goodsReceipt.reversal")!.href(5)).toBe("/purchases?tab=goods-receipt-reversals");
    expect(decisionSpec("purchase.supplierInvoice.reversal")!.href(5)).toBe("/purchases?tab=supplier-invoice-approvals");
  });

  // معرّفُ طلب المرتجع ليس معرّفَ مرتجع: `/purchase-returns/:id` يطلب `purchaseReturns.id` الذي لا يوجد قبل الاعتماد.
  it("طلب مرتجع الشراء المعلق يقود الى طابور الحوكمة لا الى صفحة مرتجع لا وجود له", () => {
    expect(decisionSpec("purchase.return.decide")!.href(123)).toBe("/purchases?tab=returns-governance");
    // عكسُ المرتجع يحمل معرّفَ مرتجعٍ قائم فعلاً — رابطُه المباشر يبقى.
    expect(decisionSpec("purchase.return.reversal")!.href(123)).toBe("/purchase-returns/123");
  });
});
