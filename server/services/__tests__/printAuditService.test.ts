import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { derivePrintAuditOutcome } from "../../../shared/printAudit";
import { getDb } from "../../db";
import { recordDocumentPrintOutcome, requestDocumentPrint } from "../printAuditService";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

beforeEach(async () => {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of ["documentPrintEvents", "receipts", "customers", "users", "branches"]) await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await db().insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }, { id: 2, name: "الثاني", code: "B2", type: "SALES" }]);
  await db().insert(s.users).values([
    { id: 1, openId: "print_actor", name: "طابع الاختبار", role: "manager", branchId: 1, loginMethod: "local", isOwner: false },
    { id: 2, openId: "other_print_actor", name: "طابع آخر", role: "manager", branchId: 1, loginMethod: "local", isOwner: false },
    { id: 3, openId: "global_print_actor", name: "طابع عام", role: "admin", branchId: null, loginMethod: "local", isOwner: false },
  ]);
  await db().insert(s.customers).values([
    { id: 1, name: "عميل الكشف", currentBalance: "0" },
    { id: 2, name: "عميل آخر", currentBalance: "0" },
  ]);
});

describe("سجل تدقيق الطباعة", () => {
  it("يضيف REQUESTED وDIALOG_OPENED كسطرين مستقلين بهوية الخادم", async () => {
    const requested = await requestDocumentPrint({
      requestId: "print-request-001",
      documentType: "CUSTOMER_STATEMENT",
      documentId: 1,
      branchId: 1,
      channel: "BROWSER",
      copies: 1,
    }, { userId: 1, branchId: 1 });
    expect(requested.actorName).toBe("طابع الاختبار");
    await recordDocumentPrintOutcome({ requestId: requested.requestId, outcome: "DIALOG_OPENED" }, { userId: 1, branchId: 1 });
    const events = await db().select().from(s.documentPrintEvents).where(eq(s.documentPrintEvents.requestId, requested.requestId));
    expect(events.map((event) => event.outcome).sort()).toEqual(["DIALOG_OPENED", "REQUESTED"]);
    expect(events.every((event) => event.actorNameSnapshot === "طابع الاختبار")).toBe(true);
  });

  it("يعيد نفس حدث النتيجة عند replay ولا يضاعف السجل", async () => {
    const input = { requestId: "print-request-002", documentType: "CUSTOMER_STATEMENT" as const, documentId: 1, branchId: 1, channel: "PDF" as const, copies: 1 };
    await requestDocumentPrint(input, { userId: 1, branchId: 1 });
    await recordDocumentPrintOutcome({ requestId: input.requestId, outcome: "DIALOG_OPENED" }, { userId: 1, branchId: 1 });
    await recordDocumentPrintOutcome({ requestId: input.requestId, outcome: "DIALOG_OPENED" }, { userId: 1, branchId: 1 });
    expect(await db().select().from(s.documentPrintEvents).where(eq(s.documentPrintEvents.requestId, input.requestId))).toHaveLength(2);
  });

  it("يحفظ FAILED كسطر مستقل برمز مسموح فقط ولا يبدله عند replay", async () => {
    const input = { requestId: "print-failed-001", documentType: "CUSTOMER_STATEMENT" as const, documentId: 1, branchId: 1, channel: "BROWSER" as const, copies: 1 };
    await requestDocumentPrint(input, { userId: 1, branchId: 1 });
    await recordDocumentPrintOutcome({
      requestId: input.requestId,
      outcome: "FAILED",
      failureCode: `NetworkError: ${"07701234567 payload ".repeat(10)}`,
    }, { userId: 1, branchId: 1 });
    await recordDocumentPrintOutcome({ requestId: input.requestId, outcome: "FAILED", failureCode: "POPUP_BLOCKED" }, { userId: 1, branchId: 1 });

    const events = await db().select().from(s.documentPrintEvents).where(eq(s.documentPrintEvents.requestId, input.requestId));
    expect(events).toHaveLength(2);
    const failed = events.find((event) => event.outcome === "FAILED");
    expect(failed?.failureCode).toBe("UNKNOWN");
    expect(failed?.failureCode).not.toContain("07701234567");
    expect(failed?.failureCode?.length).toBeLessThanOrEqual(32);
  });

  it.each(["BROWSER", "PDF"] as const)("يرفض DISPATCHED لقناة %s ويسمح فقط بفتح الحوار", async (channel) => {
    const requestId = `print-browser-${channel.toLowerCase()}`;
    await requestDocumentPrint({
      requestId,
      documentType: "CUSTOMER_STATEMENT",
      documentId: 1,
      branchId: 1,
      channel,
      copies: 1,
    }, { userId: 1, branchId: 1 });

    await expect(recordDocumentPrintOutcome({ requestId, outcome: "DISPATCHED" }, { userId: 1, branchId: 1 }))
      .rejects.toThrow(/مباشر/);
    await recordDocumentPrintOutcome({ requestId, outcome: "DIALOG_OPENED" }, { userId: 1, branchId: 1 });
    expect((await db().select().from(s.documentPrintEvents).where(eq(s.documentPrintEvents.requestId, requestId))).map((event) => event.outcome).sort())
      .toEqual(["DIALOG_OPENED", "REQUESTED"]);
  });

  it("يشتق نتيجة التدقيق من الناقل الفعلي ولا يعد نجاحاً منطقياً دليلاً على إرسال مباشر", () => {
    expect(derivePrintAuditOutcome("BROWSER", { via: "server" })).toEqual({ outcome: "DIALOG_OPENED" });
    expect(derivePrintAuditOutcome("PDF", true)).toEqual({ outcome: "DIALOG_OPENED" });
    expect(derivePrintAuditOutcome("THERMAL", { via: "browser" })).toEqual({ outcome: "DIALOG_OPENED" });
    expect(derivePrintAuditOutcome("THERMAL", true)).toEqual({ outcome: "DIALOG_OPENED" });
    expect(derivePrintAuditOutcome("THERMAL", { via: "thermal" })).toEqual({ outcome: "DISPATCHED" });
    expect(derivePrintAuditOutcome("THERMAL", { via: "server" })).toEqual({ outcome: "DISPATCHED" });
    expect(derivePrintAuditOutcome("SERVER_BRIDGE", { via: "server", ok: true })).toEqual({ outcome: "DISPATCHED" });
    expect(derivePrintAuditOutcome("SERVER_BRIDGE", { via: "server", ok: false })).toEqual({ outcome: "FAILED", failureCode: "PRINT_FAILED" });
    expect(derivePrintAuditOutcome("BROWSER", false)).toEqual({ outcome: "FAILED", failureCode: "POPUP_BLOCKED" });
  });

  it("يقبل DISPATCHED للقناة المباشرة بعد نجاح ناقل صريح", async () => {
    const requestId = "print-direct-success";
    await requestDocumentPrint({
      requestId,
      documentType: "CUSTOMER_STATEMENT",
      documentId: 1,
      branchId: 1,
      channel: "SERVER_BRIDGE",
      copies: 1,
    }, { userId: 1, branchId: 1 });
    await recordDocumentPrintOutcome({ requestId, outcome: "DISPATCHED" }, { userId: 1, branchId: 1 });
    expect((await db().select().from(s.documentPrintEvents).where(eq(s.documentPrintEvents.requestId, requestId))).map((event) => event.outcome).sort())
      .toEqual(["DISPATCHED", "REQUESTED"]);
  });

  it("يجعل replay للطلب مطابقاً حصراً ويرفض تبديل المستند أو المنفذ", async () => {
    const input = { requestId: "print-request-replay", documentType: "CUSTOMER_STATEMENT" as const, documentId: 1, branchId: 1, channel: "BROWSER" as const, copies: 1 };
    const first = await requestDocumentPrint(input, { userId: 1, branchId: 1 });
    const replay = await requestDocumentPrint(input, { userId: 1, branchId: 1 });
    expect(replay.id).toBe(first.id);
    await expect(requestDocumentPrint({ ...input, documentId: 2 }, { userId: 1, branchId: 1 })).rejects.toThrow(/إعادة الطلب/);
    await expect(requestDocumentPrint({ ...input, branchId: 2 }, { userId: 1, branchId: 1 })).rejects.toThrow(/فرع آخر/);
    await expect(requestDocumentPrint(input, { userId: 2, branchId: 1 })).rejects.toThrow(/إعادة الطلب/);
    expect(await db().select().from(s.documentPrintEvents).where(eq(s.documentPrintEvents.requestId, input.requestId))).toHaveLength(1);
  });

  it("لا يعامل branchId=null كبديل شامل عند replay لطلب فرعي", async () => {
    const input = { requestId: "print-request-branch-exact", documentType: "CUSTOMER_STATEMENT" as const, documentId: 1, branchId: 1, channel: "BROWSER" as const, copies: 1 };
    await requestDocumentPrint(input, { userId: 3, branchId: null });
    await expect(requestDocumentPrint({ ...input, branchId: null }, { userId: 3, branchId: null }))
      .rejects.toThrow(/إعادة الطلب/);
  });

  it("يرفض إكمال النتيجة إذا تغير فرع جلسة المنفذ", async () => {
    const requestId = "print-outcome-branch";
    await requestDocumentPrint({
      requestId,
      documentType: "CUSTOMER_STATEMENT",
      documentId: 1,
      branchId: 1,
      channel: "BROWSER",
      copies: 1,
    }, { userId: 1, branchId: 1 });
    await expect(recordDocumentPrintOutcome({ requestId, outcome: "DIALOG_OPENED" }, { userId: 1, branchId: 2 }))
      .rejects.toThrow(/فرع/);
    expect(await db().select().from(s.documentPrintEvents).where(eq(s.documentPrintEvents.requestId, requestId))).toHaveLength(1);
  });

  it("يرفض الطباعة الرسمية لسند معكوس حتى لو بقي اعتماده APPROVED", async () => {
    await db().insert(s.receipts).values({
      id: 50,
      branchId: 1,
      direction: "IN",
      amount: "10.00",
      paymentMethod: "CASH",
      status: "REVERSED",
      approvalStatus: "APPROVED",
      voucherNumber: "RV-REVERSED-50",
      createdBy: 1,
    });
    await expect(requestDocumentPrint({
      requestId: "print-reversed-voucher",
      documentType: "VOUCHER",
      documentId: 50,
      branchId: 1,
      channel: "BROWSER",
      copies: 1,
    }, { userId: 1, branchId: 1 })).rejects.toThrow(/معكوس/);
    expect(await db().select().from(s.documentPrintEvents)).toHaveLength(0);
  });

  it("يرفض تدقيق كشف على فرع غير فرع المنفذ", async () => {
    await expect(requestDocumentPrint({
      requestId: "print-cross-branch",
      documentType: "CUSTOMER_STATEMENT",
      documentId: 1,
      branchId: 2,
      channel: "PDF",
      copies: 1,
    }, { userId: 1, branchId: 1 })).rejects.toThrow(/فرع آخر/);
    expect(await db().select().from(s.documentPrintEvents)).toHaveLength(0);
  });
});
