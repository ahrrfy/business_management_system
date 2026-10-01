import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { truncateTables } from "./__testUtils__";
import {
  createManualJournal,
  listManualJournals,
} from "../accounting/manualJournalService";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const mockActor = {
  userId: 1,
  branchId: 1,
  role: "accountant" as const,
  name: "المحاسب المعتمد",
  isOwner: false,
};

const mockAuditContext = {
  user: {
    id: 1,
    name: "المحاسب المعتمد",
    role: "accountant" as const,
  },
  req: {
    ip: "127.0.0.1",
    headers: {},
  },
};

async function resetDb() {
  await truncateTables([
    "journalLines",
    "journalEntries",
    "accountingEntries",
    "doubleEntrySettings",
    "financialPeriods",
    "auditLogs",
    "customers",
    "suppliers",
    "branches",
    "users",
    "accounts",
  ]);

  // بذر الفرع والمستخدم
  await db().insert(s.branches).values({ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({
    id: 1,
    openId: "test_accountant",
    name: "المحاسب المعتمد",
    role: "accountant",
    branchId: 1,
    isActive: true,
  });

  // بذر الحسابات التشغيلية للتجربة
  await db().insert(s.accounts).values([
    {
      id: 10,
      code: "1100",
      name: "الصندوق",
      type: "ASSET",
      systemRole: "CASH",
      isActive: true,
      sortOrder: 1,
    },
    {
      id: 20,
      code: "1300",
      name: "ذمم العملاء",
      type: "ASSET",
      systemRole: "AR",
      isActive: true,
      sortOrder: 2,
    },
    {
      id: 30,
      code: "2100",
      name: "ذمم الموردين",
      type: "LIABILITY",
      systemRole: "AP",
      isActive: true,
      sortOrder: 3,
    },
    {
      id: 40,
      code: "5100",
      name: "مصاريف إيجار",
      type: "EXPENSE",
      systemRole: "RENT",
      isActive: true,
      sortOrder: 4,
    },
    {
      id: 50,
      code: "9999",
      name: "حساب معطل",
      type: "EXPENSE",
      systemRole: "OPERATING_EXPENSE",
      isActive: false,
      sortOrder: 5,
    },
  ]);
}

describe("manualJournalService — القيود اليومية اليدوية المتوازنة", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("يرفض القيد غير المتوازن (المدين لا يساوي الدائن)", async () => {
    await expect(
      withTx((tx) =>
        createManualJournal(
          tx,
          {
            entryDate: "2026-10-01",
            notes: "تسوية إيجار غير متوازنة",
            branchId: 1,
            lines: [
              { accountId: 40, debit: "500000.00", credit: "0.00" },
              { accountId: 10, debit: "0.00", credit: "450000.00" },
            ],
          },
          mockActor,
          mockAuditContext,
        ),
      ),
    ).rejects.toThrow(/القيد المحاسبي غير متوازن/);
  });

  it("يرفض القيد الذي يقل عدد أسطره عن سطرين", async () => {
    await expect(
      withTx((tx) =>
        createManualJournal(
          tx,
          {
            entryDate: "2026-10-01",
            notes: "قيد بسطر واحد",
            branchId: 1,
            lines: [{ accountId: 10, debit: "100000.00", credit: "0.00" }],
          },
          mockActor,
          mockAuditContext,
        ),
      ),
    ).rejects.toThrow(/طرفين على الأقل/);
  });

  it("يرفض القيد الذي يتضمن مبالغ سالبة", async () => {
    await expect(
      withTx((tx) =>
        createManualJournal(
          tx,
          {
            entryDate: "2026-10-01",
            notes: "قيد بمبالغ سالبة",
            branchId: 1,
            lines: [
              { accountId: 40, debit: "-100000.00", credit: "0.00" },
              { accountId: 10, debit: "0.00", credit: "-100000.00" },
            ],
          },
          mockActor,
          mockAuditContext,
        ),
      ),
    ).rejects.toThrow(/قيمة سالبة/);
  });

  it("يرفض استخدام حساب محاسبي معطل", async () => {
    await expect(
      withTx((tx) =>
        createManualJournal(
          tx,
          {
            entryDate: "2026-10-01",
            notes: "قيد بحساب معطل",
            branchId: 1,
            lines: [
              { accountId: 50, debit: "100000.00", credit: "0.00" },
              { accountId: 10, debit: "0.00", credit: "100000.00" },
            ],
          },
          mockActor,
          mockAuditContext,
        ),
      ),
    ).rejects.toThrow(/الحساب المحاسبي معطل/);
  });

  it("يرفض الترحيل في فترة مالية مقفلة", async () => {
    // قفل الفترة المالية حتى نهاية سبتمبر
    await db().insert(s.financialPeriods).values({
      cutoffDate: "2026-09-30",
      status: "LOCKED",
      lockedBy: 1,
      notes: "إقفال شهري سبتمبر",
    });

    await expect(
      withTx((tx) =>
        createManualJournal(
          tx,
          {
            entryDate: "2026-09-15",
            notes: "تسوية تاريخية في فترة مقفلة",
            branchId: 1,
            lines: [
              { accountId: 40, debit: "100000.00", credit: "0.00" },
              { accountId: 10, debit: "0.00", credit: "100000.00" },
            ],
          },
          mockActor,
          mockAuditContext,
        ),
      ),
    ).rejects.toThrow(/مُقفَلة/);
  });

  it("يرحل القيد المتوازن بنجاح ويحدث دفتر اليومية والأستاذ وسجل التدقيق", async () => {
    const res = await withTx((tx) =>
      createManualJournal(
        tx,
        {
          entryDate: "2026-10-01",
          notes: "إثبات سداد إيجار نقداً من الصندوق",
          branchId: 1,
          lines: [
            { accountId: 40, debit: "350000.00", credit: "0.00" },
            { accountId: 10, debit: "0.00", credit: "350000.00" },
          ],
        },
        mockActor,
        mockAuditContext,
      ),
    );

    expect(res.journalId).toBeGreaterThan(0);
    expect(res.entryId).toBeGreaterThan(0);
    expect(res.amount).toBe("350000.00");

    // التحقق من الإدراج في دفتر الأحداث المبسط
    const [ae] = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.id, res.entryId));
    expect(ae).toBeDefined();
    expect(ae.entryType).toBe("ADJUST");
    expect(ae.amount).toBe("350000.00");

    // التحقق من دفتر اليومية المزدوج
    const [je] = await db()
      .select()
      .from(s.journalEntries)
      .where(eq(s.journalEntries.id, res.journalId));
    expect(je).toBeDefined();
    expect(je.status).toBe("POSTED");
    expect(je.postingProfile).toBe("MANUAL_JOURNAL");

    // التحقق من أسطر القيد المزدوج
    const lines = await db()
      .select()
      .from(s.journalLines)
      .where(eq(s.journalLines.journalId, res.journalId));
    expect(lines).toHaveLength(2);

    const rentLine = lines.find((l) => l.role === "RENT");
    const cashLine = lines.find((l) => l.role === "CASH");
    expect(rentLine?.debit).toBe("350000.00");
    expect(rentLine?.credit).toBe("0.00");
    expect(cashLine?.debit).toBe("0.00");
    expect(cashLine?.credit).toBe("350000.00");

    // التحقق من سجل التدقيق
    const [audit] = await db()
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.entityId, String(res.journalId)));
    expect(audit).toBeDefined();
    expect(audit.action).toBe("manualJournal.create");
  });

  it("يحدث ذمة العميل والمورد الفرعية بدقة عند إدراج أسطر AR/AP", async () => {
    // بذر عميل ومورد
    const [custRes] = await db().insert(s.customers).values({
      name: "عميل تجريبي",
      phone: "07700000001",
      currentBalance: "100000.00",
    });
    const customerId = custRes.insertId;

    const [suppRes] = await db().insert(s.suppliers).values({
      name: "مورد تجريبي",
      phone: "07700000002",
      currentBalance: "200000.00",
    });
    const supplierId = suppRes.insertId;

    // قيد: تسوية تخفيض ذمة العميل (Credit AR = -50,000) وزيادة ذمة المورد (Credit AP = +50,000)
    await withTx((tx) =>
      createManualJournal(
        tx,
        {
          entryDate: "2026-10-01",
          notes: "تسوية ذمم مشتركة للعميل والمورد",
          branchId: 1,
          lines: [
            { accountId: 20, debit: "0.00", credit: "50000.00", customerId },
            { accountId: 30, debit: "50000.00", credit: "0.00", supplierId },
          ],
        },
        mockActor,
        mockAuditContext,
      ),
    );

    // رصيد العميل يجب أن ينخفض بمقدار 50,000 (100,000 - 50,000 = 50,000)
    const [cust] = await db()
      .select()
      .from(s.customers)
      .where(eq(s.customers.id, customerId));
    expect(Number(cust.currentBalance)).toBe(50000);

    // رصيد المورد يجب أن ينخفض بالمدين بمقدار 50,000 (200,000 - 50,000 = 150,000)
    const [supp] = await db()
      .select()
      .from(s.suppliers)
      .where(eq(s.suppliers.id, supplierId));
    expect(Number(supp.currentBalance)).toBe(150000);
  });

  it("يسترجع قائمة القيود اليدوية مع التفاصيل عبر listManualJournals", async () => {
    await withTx((tx) =>
      createManualJournal(
        tx,
        {
          entryDate: "2026-10-01",
          notes: "قيد تجريبي للاستعراض",
          branchId: 1,
          lines: [
            { accountId: 40, debit: "120000.00", credit: "0.00" },
            { accountId: 10, debit: "0.00", credit: "120000.00" },
          ],
        },
        mockActor,
        mockAuditContext,
      ),
    );

    const list = await listManualJournals({ branchId: 1 });
    expect(list.total).toBe(1);
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0].amount).toBe("120000.00");
    expect(list.rows[0].lines).toHaveLength(2);
    expect(list.rows[0].lines[0].accountName).toBe("مصاريف إيجار");
  });
});
