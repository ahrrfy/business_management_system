import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  canReviewGovernanceRequest,
  governanceDecisionMessage,
  governanceStatusLabel,
} from "@/components/purchases/purchaseGovernanceUiPolicy";

describe("purchase S5-S7 governance UI policy", () => {
  it("shows that pending requests have not changed money or stock", () => {
    expect(governanceStatusLabel("PENDING")).toContain("بانتظار");
    expect(governanceStatusLabel("REJECTED")).toContain("بلا أثر");
    expect(governanceDecisionMessage("STALE")).toContain("لم يُطبّق أي أثر");
  });

  it("only describes an approved decision as applied", () => {
    expect(governanceDecisionMessage("APPROVED")).toContain("تطبيق الأثر");
    expect(governanceDecisionMessage("REJECTED")).not.toContain("تطبيق الأثر");
  });

  it("visibly blocks maker-checker self review and unknown identity", () => {
    expect(canReviewGovernanceRequest(17, 17)).toBe(false);
    expect(canReviewGovernanceRequest(undefined, 17)).toBe(false);
    expect(canReviewGovernanceRequest(18, "17")).toBe(true);
  });

  it("wires every operational screen to its governed request and decision routers", () => {
    const contracts = [
      [
        "../PurchaseReturnsGovernance.tsx",
        [
          "requestReturn",
          "requestReversal",
          "decideReturn",
          "decideReversal",
          "returnSources",
          "reversalSources",
        ],
      ],
      [
        "../SupplierPaymentsGovernance.tsx",
        [
          "requestPayment",
          "requestRefund",
          "decidePayment",
          "decideRefund",
          "paymentSources",
          "refundSources",
        ],
      ],
      [
        "../PurchaseChargesGovernance.tsx",
        [
          "purchaseCharges.create",
          "requestControl",
          "decideControl",
          "purchaseCharges.sources",
        ],
      ],
      [
        "../PurchaseIntegrityCases.tsx",
        [
          "purchaseIntegrity.open",
          "requestResolution",
          "decideResolution",
          "monthCloseBlockers",
        ],
      ],
    ] as const;
    for (const [path, procedures] of contracts) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      for (const procedure of procedures)
        expect(source, `${path}: ${procedure}`).toContain(procedure);
    }
  });

  it("does not announce request submission as an applied financial effect", () => {
    const requestPages = [
      "../PurchaseReturnsGovernance.tsx",
      "../SupplierPaymentsGovernance.tsx",
      "../PurchaseChargesGovernance.tsx",
      "../PurchaseIntegrityCases.tsx",
    ];
    for (const path of requestPages) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(source).toContain("notify.info");
    }
    const sharedPolicy = readFileSync(
      new URL(
        "../../components/purchases/purchaseGovernanceUiPolicy.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(sharedPolicy).toContain('status === "APPROVED"');
    expect(sharedPolicy).toContain("تطبيق الأثر");
  });

  it("does not offer a payable purchase charge before an obligation lifecycle exists", () => {
    const source = readFileSync(
      new URL(
        "../../components/purchases/PurchaseChargesGovernanceWorkspace.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).not.toContain('<option value="PAYABLE">');
    expect(source).toContain("المصروف الآجل متوقف احترازياً");
    expect(source).toContain('const settlement = "PAID" as const');
  });

  it("يعطّل قرار دفعة المورد لغير صاحب treasury FULL ويشرح السبب", () => {
    const page = readFileSync(
      new URL("../SupplierPaymentsGovernance.tsx", import.meta.url),
      "utf8",
    );
    const workspace = readFileSync(
      new URL(
        "../../components/purchases/SupplierPaymentsGovernanceWorkspace.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    const queue = readFileSync(
      new URL(
        "../../components/purchases/GovernanceApprovalQueue.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(page).toContain('"treasury"');
    expect(page).toContain('"FULL"');
    expect(page).toContain("صلاحية المشتريات تتيح إنشاء الطلب ومتابعته فقط");
    expect(page).toContain("canDecide={canDecide}");
    expect(workspace).toContain("reviewAllowed={canDecide}");
    expect(queue).toContain("reviewAllowed &&");
    expect(queue).toContain("reviewBlockedReason");
  });

  it("يحمّل كل صفحات مصادر السداد والاسترداد ولا يكتفي بأول 200 سجلاً", () => {
    const page = readFileSync(
      new URL("../SupplierPaymentsGovernance.tsx", import.meta.url),
      "utf8",
    );
    expect(page).toContain("paymentSources.useInfiniteQuery");
    expect(page).toContain("refundSources.useInfiniteQuery");
    expect(page).toContain("pages.flatMap((page) => page.rows)");
    expect(page).toContain("paymentSourcesQuery.fetchNextPage()");
    expect(page).toContain("refundSourcesQuery.fetchNextPage()");
    expect(page).toContain("paymentSourcesQuery.hasNextPage");
    expect(page).toContain("refundSourcesQuery.hasNextPage");
  });
});
