import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INBOUND_ENABLED_PAYMENT_METHODS,
  INBOUND_TELECOM_DISABLED_MESSAGE,
  inboundPaymentRejectionMessage,
  isInboundPaymentMethodEnabled,
} from "@shared/inboundPaymentPolicy";

const readPage = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

describe("سياسة القبض خارج نقاط البيع", () => {
  it("مصدر حقيقة واحد: المدعوم مسموح والمجهول مرفوض", () => {
    for (const method of INBOUND_ENABLED_PAYMENT_METHODS) {
      expect(isInboundPaymentMethodEnabled(method)).toBe(true);
    }
    expect(isInboundPaymentMethodEnabled("TELECOM")).toBe(false);
    expect(isInboundPaymentMethodEnabled("FUTURE_PROVIDER")).toBe(false);
    expect(isInboundPaymentMethodEnabled(null)).toBe(false);
    expect(inboundPaymentRejectionMessage("TELECOM")).toBe(INBOUND_TELECOM_DISABLED_MESSAGE);
  });

  it("سند القبض يعرض الطرق المدعومة كلّها بلا قائمة موازية مُقفلة", () => {
    const source = readPage("_VoucherFormShared.tsx");
    expect(source).toContain("disabled={!isInboundPaymentMethodEnabled(m.value)}");
    expect(source).not.toContain("CASH_METHODS");
    expect(source).not.toContain('if (isReceipt && method !== "CASH")');
  });

  it("تحصيل القسط يفصل المنشئ عن المؤكد ويعرض طابور الاعتماد بكل حالاته", () => {
    const source = readPage("InstallmentPlans.tsx");
    expect(source).toContain("POS_METHODS.map");
    expect(source).toContain("trpc.installments.initiateExternalPayment.useMutation");
    expect(source).toContain("trpc.installments.confirmExternalPayment.useMutation");
    expect(source).toContain("trpc.installments.pendingExternalPayments.useQuery");
    expect(source).toContain("PendingExternalPaymentsPanel");
    expect(source).toContain("<LoadingState");
    expect(source).toContain("<ErrorState");
    expect(source).toContain("لا توجد محاولات غير نقدية بانتظار الاعتماد أو السداد");
    expect(source).toContain("إرسال لاعتماد موظف مستقل");
    expect(source).toContain("اعتماد الدفع كموظف مستقل");
    expect(source).toContain("if (!approval?.canConfirm)");
    expect(source).toContain("externalAttempt?.confirmed === true");
    expect(source).toContain("referenceNumber: method === \"CASH\" ? undefined : reference.trim()");
    expect(source).toContain("cardLastFour: method === \"CARD\" ? cardLastFour : undefined");
    expect(source).toContain("externalPaymentAttemptId:");
    expect(source).toContain("deviceId:");
  });

  it("إنشاء الخطة يفرض فاتورة معلقة ويشتق الإجمالي من متبقيها", () => {
    const source = readPage("InstallmentPlans.tsx");
    expect(source).toContain('balanceState: "OUTSTANDING"');
    expect(source).toContain("invoiceId != null");
    expect(source).toContain("invoiceOutstanding(selected)");
    expect(source).toContain("clientRequestId: createClientRequestId");
    expect(source).toContain("readOnly");
  });

  it("سحب المحفظة بالتحويل يجمع مرجع الحوالة ويُمرّره (لا UUID داخليّ)", () => {
    const source = readFileSync(new URL("../digitalCards/WalletOpsDialogs.tsx", import.meta.url), "utf8");
    expect(source).not.toContain('mode === "withdraw" && method !== "CASH"');
    expect(source).toContain("referenceNumber: reference.trim()");
    expect(source).toContain('id="wm-reference"');
  });
});
