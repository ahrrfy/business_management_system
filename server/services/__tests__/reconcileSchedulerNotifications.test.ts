import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { FinancialReconciliationSummary } from "../reports/reconcileSummary";
import { notifyReconciliationDrift } from "../reconcileScheduler";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

const cleanSections: FinancialReconciliationSummary["sections"] = {
  customers: { issueCount: 0, balanced: true },
  suppliers: { issueCount: 0, balanced: true },
  delivery: { issueCount: 0, balanced: true },
  inventory: { issueCount: 0, balanced: true },
  ledger: { issueCount: 0, balanced: true },
  onlineOrders: { issueCount: 0, balanced: true },
  journalOrphans: { issueCount: 0, balanced: true },
};

beforeEach(async () => {
  const database = db();
  await database.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of ["nativePushOutbox", "webPushOutbox", "appNotifications", "appNotificationPreferences", "users"]) {
    await database.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await database.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await database.insert(s.users).values([
    { id: 1, openId: "admin-active", name: "الأدمن", role: "admin", isActive: true },
    { id: 2, openId: "owner-active", name: "المالك", role: "user", isOwner: true, isActive: true },
    { id: 3, openId: "manager-active", name: "المدير", role: "manager", isActive: true },
    { id: 4, openId: "admin-disabled", name: "أدمن معطل", role: "admin", isActive: false },
  ]);
});

describe("تنبيه فحص التسوية الليلي", () => {
  it("لا يكتب شيئاً عند الاتزان ويبلغ الأدمن والمالك فقط عند وجود فرق بلا تكرار يومي", async () => {
    const clean: FinancialReconciliationSummary = {
      runAt: "2026-09-01T02:10:00.000Z",
      totalIssueCount: 0,
      balanced: true,
      sections: cleanSections,
    };
    await notifyReconciliationDrift(clean, new Date(clean.runAt));
    expect(await db().select().from(s.appNotifications)).toHaveLength(0);

    const drift: FinancialReconciliationSummary = {
      ...clean,
      totalIssueCount: 3,
      balanced: false,
      sections: {
        ...cleanSections,
        inventory: { issueCount: 3, balanced: false },
      },
    };
    await notifyReconciliationDrift(drift, new Date(drift.runAt));
    await notifyReconciliationDrift(drift, new Date(drift.runAt));

    const notices = await db().select().from(s.appNotifications);
    expect(notices).toHaveLength(2);
    expect(notices.map((row) => row.userId).sort()).toEqual([1, 2]);
    for (const notice of notices) {
      expect(notice).toMatchObject({
        kind: "SYSTEM",
        family: "ADMIN",
        title: "تسوية مالية تحتاج معالجة",
        route: "/reconcile",
        requiresAction: true,
      });
      expect(notice.body).toContain("3 فروق");
    }
  });
});
