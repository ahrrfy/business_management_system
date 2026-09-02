import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const service = readFileSync("server/services/delivery/writeoffRequests.ts", "utf8");
const settle = readFileSync("server/services/delivery/settle.ts", "utf8");
const router = readFileSync("server/routers/deliveryRouter.ts", "utf8");
const migration = readFileSync("drizzle/migrations/0309_delivery_writeoff_control_requests.sql", "utf8");

describe("حوكمة شطب عجز COD", () => {
  it("يبقي إنشاء الطلب صفر الأثر ويحوّل المسار القديم إلى طلب", () => {
    const requestSlice = service.slice(
      service.indexOf("export async function requestDeliveryCodWriteOff"),
      service.indexOf("export async function approveDeliveryCodWriteOff"),
    );
    expect(requestSlice).not.toContain("writeOffDeliveryShortfallInTx");
    expect(requestSlice).toContain("basePartyVersion");
    expect(requestSlice).toContain("payloadHash");
    expect(requestSlice).toContain("pendingGuard");
    expect(router).toContain("requestDeliveryCodWriteOff");
    expect(router).not.toContain("writeOffDeliveryShortfall({");
  });

  it("يطبق الأثر داخل معاملة الاعتماد بعد قفل النسخة وفصل المهام", () => {
    const approval = service.slice(service.indexOf("export async function approveDeliveryCodWriteOff"));
    expect(approval).toContain(".for(\"update\")");
    expect(approval).toContain("requestedBy) === actor.userId");
    expect(approval).toContain("basePartyVersion) !== input.expectedVersion");
    expect(approval).toContain("idempotencyHash(lockedRequest.payload)");
    expect(approval).toContain("writeOffDeliveryShortfallInTx");
    expect(approval).toContain('eq(deliveryCodWriteOffRequests.status, "PENDING")');
    expect(approval).toContain("appliedAt: reviewedAt");
    expect(approval).toContain("idempotencyHash(request.payload)");
    expect(settle).toContain("export async function writeOffDeliveryShortfallInTx");
  });

  it("يثبت القيود البنيوية ضد تجاوز maker-checker وإعادة القرار", () => {
    expect(migration).toContain("uq_delivery_cod_writeoff_request_key");
    expect(migration).toContain("uq_delivery_cod_writeoff_pending");
    expect(migration).toContain("uq_delivery_cod_writeoff_decision");
    expect(migration).toContain("chk_delivery_cod_writeoff_evidence");
    expect(migration).toContain("chk_delivery_cod_writeoff_maker_checker");
    expect(migration).toContain("trg_delivery_parties_version_bu");
    expect(router).toContain("approveWriteOffRequest: deliveryManagerProcedure");
    expect(router).toContain("rejectWriteOffRequest: deliveryManagerProcedure");
    expect(service).toContain("assertRequestWriteOffAuthority(actor)");
    expect(service).toContain("assertReviewWriteOffAuthority(actor)");
    expect(router).toContain("reviewAuthorized: true as const");
    expect(settle).toContain("controlRequestAuthorized?: boolean");
    expect(service).toContain('actor.role === "admin"');
    expect(service).toContain("effectiveBranchId");
  });
});
