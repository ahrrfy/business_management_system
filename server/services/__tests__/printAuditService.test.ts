import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { recordDocumentPrintOutcome, requestDocumentPrint } from "../printAuditService";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

beforeEach(async () => {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of ["documentPrintEvents", "customers", "users", "branches"]) await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await db().insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }, { id: 2, name: "الثاني", code: "B2", type: "SALES" }]);
  await db().insert(s.users).values({ id: 1, openId: "print_actor", name: "طابع الاختبار", role: "manager", branchId: 1, loginMethod: "local", isOwner: false });
  await db().insert(s.customers).values({ id: 1, name: "عميل الكشف", currentBalance: "0" });
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
