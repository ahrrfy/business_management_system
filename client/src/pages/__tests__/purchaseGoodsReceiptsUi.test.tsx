import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../../components/purchases/GoodsReceiptsWorkspace.tsx", import.meta.url),
  "utf8",
);

describe("واجهة أذون استلام المشتريات S3", () => {
  it("تربط الاستلام بالمراجعة المعتمدة ونسخة الأمر ومفتاح idempotency", () => {
    expect(source).toContain("purchaseOrderRevisionId: Number(order.approvedRevisionId)");
    expect(source).toContain("expectedOrderVersion: Number(order.version)");
    expect(source).toContain("clientRequestId: createKey.current");
    expect(source).toContain("acceptedBaseQuantity");
    expect(source).toContain("rejectedBaseQuantity");
    expect(source).toContain("rejectionReason");
  });

  it("يفصل طلب العكس عن قرار مراجع مستقل ولا يخفي الفشل", () => {
    expect(source).toContain("goodsReceipts.requestReversal.useMutation");
    expect(source).toContain("goodsReceipts.decideReversal.useMutation");
    expect(source).toContain("expectedReceiptVersion: Number(detail.receipt.version)");
    expect(source).toContain("طلباتك الشخصية لا تظهر هنا");
    expect(source).toContain("errorState={{ isError: receipts.isError");
    expect(source).toContain("onRetry: () => void receipts.refetch()");
  });

  it("يفشل مغلقاً بلا فرع ولا يختار أول فرع للأدمن", () => {
    expect(source).toContain('if (me.data?.role === "admin") return');
    expect(source).toContain('option value="">اختر فرعاً</option>');
    expect(source).not.toContain("branches.data?.[0]");
  });
});
