/**
 * تدقيق Codex (م٤) — صفُّ تدقيق إنشاء السند يحمل **فرعَ السند** لا فرعَ الفاعل.
 *
 * العطب: أدمنٌ عابرُ الفروع **بلا فرعٍ مُسنَد** يُنشئ سنداً على `voucherBranchId` (اختاره صراحةً
 * من القائمة الخادميّة)، لكنّ `logAudit(ctx, …)` كان يشتقّ الفرعَ من `ctx.user.branchId` (= null)
 * ⇒ صفُّ تدقيقٍ بفرعٍ `NULL` يختفي من استعلامات التدقيق المفلترة بالفرع (`auditRouter`).
 *
 * الإصلاح: تمرير `branchId: voucherBranchId` صراحةً إلى `logAudit`. هذان الاختباران يمرّان عبر
 * الراوتر (`appRouter.vouchers.create`) — حيث يعيش `logAudit` — لا عبر الخدمة مباشرةً.
 *
 * ملاحظةٌ تشغيليّة: قبضُ الأدمن النقديّ يذهب إلى **الخزينة** (`cashBucket=TREASURY`, `shiftId=null`)
 * عبر `shiftIdForCashTx` فلا يلزمه فتحُ وردية — فالسيناريو قابلٌ للتشغيل بلا بذرِ وردية.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

const TABLES = [
  "auditLogs",
  "accountingEntries",
  "idempotencyKeys",
  "receipts",
  "customers",
  "suppliers",
  "shifts",
  "branches",
  "users",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  const connection = db();
  await connection.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) await connection.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await connection.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  await db().insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await db().insert(s.users).values([
    // أدمنٌ عابرُ الفروع **بلا فرعٍ مُسنَد** — قلبُ سيناريو العطب.
    { id: 1, openId: "vab-admin-unassigned", name: "أدمن بلا فرع", role: "admin", branchId: null, loginMethod: "local" },
    // أدمنٌ **مُسنَدٌ للفرع ١** — يُثبت أنّ الأثرَ يتبع فرعَ السند (٢) لا فرعَ الفاعل (١).
    { id: 2, openId: "vab-admin-branch1", name: "أدمن الفرع ١", role: "admin", branchId: 1, loginMethod: "local" },
  ]);
  await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0.00" });
}

function context(user: s.User) {
  return {
    req: { headers: {} },
    res: { cookie() {}, clearCookie() {} },
    user,
    sessionId: null,
    platformAdmin: null,
  } as any;
}

async function user(id: number): Promise<s.User> {
  return (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0]!;
}

async function auditBranchFor(receiptId: number): Promise<number | null | undefined> {
  const rows = await db()
    .select({ branchId: s.auditLogs.branchId })
    .from(s.auditLogs)
    .where(
      and(
        eq(s.auditLogs.action, "voucher.receipt.create"),
        eq(s.auditLogs.entityId, String(receiptId)),
      ),
    )
    .limit(1);
  return rows[0]?.branchId;
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("تدقيق إنشاء السند — الفرعُ يتبع السندَ لا الفاعل (تدقيق Codex م٤)", () => {
  it("أدمنٌ بلا فرعٍ مُسنَد ينشئ سنداً على الفرع ٢ ⇒ صفُّ التدقيق بفرع ٢ لا NULL", async () => {
    const caller = appRouter.createCaller(context(await user(1)));
    const res = await caller.vouchers.create({
      voucherType: "RECEIPT",
      branchId: 2,
      amount: "30.00",
      paymentMethod: "CASH",
      partyType: "CUSTOMER",
      partyId: 1,
      description: "قبض من عميل — أدمن بلا فرع",
      clientRequestId: "vab-unassigned-admin-1",
    });

    // السندُ أُنشئ فعلاً على الفرع ٢.
    const receipt = (
      await db().select({ branchId: s.receipts.branchId }).from(s.receipts).where(eq(s.receipts.id, res.receiptId)).limit(1)
    )[0];
    expect(receipt?.branchId).toBe(2);

    // العطبُ الأصليّ: كان NULL هنا فيختفي الصفُّ من تدقيق الفرع. الإصلاح: فرعُ السند صراحةً.
    expect(await auditBranchFor(res.receiptId)).toBe(2);
  });

  it("أدمنٌ مُسنَدٌ للفرع ١ ينشئ سنداً على الفرع ٢ ⇒ التدقيق بفرع السند (٢) لا فرع الفاعل (١)", async () => {
    const caller = appRouter.createCaller(context(await user(2)));
    const res = await caller.vouchers.create({
      voucherType: "RECEIPT",
      branchId: 2,
      amount: "45.00",
      paymentMethod: "CASH",
      partyType: "CUSTOMER",
      partyId: 1,
      description: "قبض من عميل — أدمن الفرع ١ على الفرع ٢",
      clientRequestId: "vab-branch1-admin-on-branch2",
    });

    // يُثبت أنّ الأثرَ يستعمل `voucherBranchId` لا `actorBranchId`/`ctx.user.branchId`.
    expect(await auditBranchFor(res.receiptId)).toBe(2);
  });
});
