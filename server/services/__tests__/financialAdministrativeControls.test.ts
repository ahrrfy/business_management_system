import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createVoucher } from "../voucher/create";

const actor = { userId: 1, branchId: 1, role: "manager" } as const;

function db() {
  const connection = getDb();
  if (!connection) throw new Error("DATABASE_URL not set for tests");
  return connection;
}

beforeEach(async () => {
  const connection = db();
  await connection.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of ["idempotencyKeys", "accountingEntries", "receipts", "voucherCategories", "branches", "users"]) {
    await connection.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await connection.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await connection.insert(s.branches).values({ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" });
  await connection.insert(s.users).values({
    id: 1,
    openId: "financial_admin_controls",
    name: "مدير",
    role: "manager",
    loginMethod: "local",
    branchId: 1,
  });
  await connection.insert(s.voucherCategories).values({
    id: 11,
    name: "إيرادات إدارية اختبارية",
    direction: "IN",
    postingRole: "OTHER_REVENUE",
  });
});

describe("الضوابط الإدارية لمصدر النقد", () => {
  it("قبض نقد من طرف حر موثق ينفذ فوراً ويثبت أثره المالي في الخزينة الإدارية (المسار الأول)", async () => {
    const result = await createVoucher({
      voucherType: "RECEIPT",
      branchId: 1,
      amount: "750000",
      paymentMethod: "CASH",
      partyType: "OTHER",
      voucherCategoryId: 11,
      counterpartyName: "تمويل موثق من المالك",
      referenceNumber: "OWNER-FUND-2026-001",
      description: "تمويل خزينة خارج المبيعات",
      attachmentUrl: "https://example.test/owner-fund-2026-001.jpg",
      clientRequestId: "financial-admin-receipt-001",
    }, actor);

    expect(result.approvalStatus).toBe("APPROVED");
    const rows = await db().select().from(s.receipts);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("COMPLETED");
    expect(rows[0].cashBucket).toBe("TREASURY");
    expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
  });

  it("قبض حر بلا توثيق مسبق ينفذ فوراً في الخزينة طالما حُددت فئته المحاسبية وطرفه (المسار الأول)", async () => {
    const result = await createVoucher({
      voucherType: "RECEIPT",
      branchId: 1,
      amount: "750000",
      paymentMethod: "CASH",
      partyType: "OTHER",
      voucherCategoryId: 11,
      counterpartyName: "طرف غير معروف",
      description: "تمويل غير موثق",
      clientRequestId: "financial-admin-receipt-002",
    }, actor);

    expect(result.approvalStatus).toBe("APPROVED");
    const rows = await db().select().from(s.receipts);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("COMPLETED");
    expect(rows[0].cashBucket).toBe("TREASURY");
    expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
  });

  it("يرفض تأريخ السند في المستقبل", async () => {
    await expect(createVoucher({
      voucherType: "RECEIPT",
      branchId: 1,
      amount: "1000",
      paymentMethod: "CASH",
      partyType: "OTHER",
      voucherCategoryId: 11,
      counterpartyName: "مالك المنشأة",
      referenceNumber: "OWNER-FUND-FUTURE",
      description: "تاريخ غير مسموح",
      voucherDate: "2099-01-01",
      clientRequestId: "financial-admin-receipt-003",
    }, actor)).rejects.toThrow();

    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });
});
