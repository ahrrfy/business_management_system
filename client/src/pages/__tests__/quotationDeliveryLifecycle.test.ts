import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const detail = read("../QuotationDetail.tsx");
const deliveryDialog = read("../../components/DocumentWhatsAppDialog.tsx");

describe("مسار تسليم عرض السعر عبر واتساب", () => {
  it("لا يوسم العرض مُرسَلاً قبل نجاح تسليم PDF، ولا يحوّل القبول إلى بيع", () => {
    expect(deliveryDialog).toContain("onDocumentSent?: () => void;");
    expect(deliveryDialog).toContain('if (value === "SENT" || value === "DELIVERED" || value === "READ")');
    expect(deliveryDialog).toContain("const documentSentNotifiedRef = useRef(false);");
    expect(deliveryDialog).toContain("if (!documentSentNotifiedRef.current)");
    expect(deliveryDialog).toContain("onDocumentSent?.();");

    expect(detail).toContain("const markQuotationSentAfterDelivery");
    expect(detail).toContain('if (q.data?.status !== "DRAFT" || !canManage) return;');
    expect(detail).toContain('setStatus.mutate({ quotationId, status: "SENT" });');
    expect(detail).toContain("onDocumentSent={markQuotationSentAfterDelivery}");
    expect(detail).toContain("لا ينشئ فاتورة ولا يحجز مخزوناً");
  });
});
