import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const page = readFileSync(resolve(process.cwd(), "client/src/pages/QuotationNew.tsx"), "utf8");

describe("QuotationNew source request contract", () => {
  it("hydrates only reviewed store requests and submits the source link with the formal quotation", () => {
    expect(page).toContain("prepareOfficialQuotation.useQuery");
    expect(page).toContain("storefrontQuoteRequestId: sourceQuoteRequestId ?? undefined");
    expect(page).toContain("item.isCurrentCatalogLine");
    expect(page).toContain("راجع الأسعار والكميات والتوفر قبل الحفظ");
  });
});
