import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readPage = (name: string) =>
  readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

describe("audited public UX contracts", () => {
  it("keeps the jobs marquee semantic once and delegates modal focus to Dialog", () => {
    const source = readPage("JobApply.tsx");

    expect(source).toContain('<ul className="sr-only">');
    expect(source).toContain('<div className="cj-track" aria-hidden="true">');
    expect(source).toContain("<DialogContent");
    expect(source).toContain("onOpenAutoFocus=");
    expect(source).toContain("<DialogClose asChild>");
    expect(source).not.toContain('role="dialog"');
  });

  it("distinguishes an empty catalog from an empty filtered result", () => {
    const source = readPage("Storefront.tsx");

    expect(source).toContain("const isEmptyCatalog =");
    expect(source).toContain("لا توجد منتجات معروضة حالياً");
    expect(source).toContain("لا توجد نتائج مطابقة للبحث أو الفلاتر");
    expect(source).toContain("مسح البحث والفلاتر");
  });

  it("does not advertise an unsupported purchase-return draft", () => {
    const source = readPage("PurchaseReturnNew.tsx");

    expect(source).toContain(
      'const PURCHASE_RETURN_ACTIONS = ["save", "print", "duplicate", "paste"]',
    );
    expect(source).toContain("availableActions={PURCHASE_RETURN_ACTIONS}");
    expect(source).not.toContain('case "draft":');
    expect(source).not.toContain("handleSaveDraft");
  });

  it("keeps full favorites controls keyboard-focusable and explains their disabled state", () => {
    const source = readFileSync(new URL("../../components/AppLayout.tsx", import.meta.url), "utf8");

    expect(source).toContain("aria-disabled={!favorite && favoritesFull ? true : undefined}");
    expect(source).toContain("? `لا يمكن إضافة ${m.label} إلى المفضلة؛ بلغت الحد الأقصى`");
    expect(source).not.toContain("disabled={!favorite && favoritesFull}");
  });

  it("locks restore controls once a destructive upload starts", () => {
    const source = readPage("Settings.tsx");

    expect(source).not.toContain("AbortController");
    expect(source).not.toContain("cancelRestoreUpload");
    expect(source).not.toContain("onCancelPending=");
    expect(source).toContain("setRestoreUploadStreaming(true)");
    expect(source).toContain("setRestoreUploadStreaming(false)");
  });
});
