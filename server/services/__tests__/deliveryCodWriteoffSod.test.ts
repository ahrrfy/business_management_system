/**
 * فصل المهام سلوكياً لاعتماد/رفض طلب شطب عهدة COD (requestedBy !== actor.userId).
 *
 * الحاجة: `deliveryCodWriteoffRequests.test.ts` القائم يتحقق نصّياً فقط
 * (`readFileSync(...).toContain("requestedBy) === actor.userId")`) — يمرّ حتى لو كان الحارس
 * ميتاً/معلَّقاً بتعليق. وهذا الحارس هو **الحاجز الوحيد**: `deliveryAdminProcedure` (بوّابة فتح
 * الطلب) = `deliveryManagerProcedure.use(requireAdmin)` تعريفاً — أي أدمن يفتح طلباً يجتاز
 * تلقائياً `deliveryManagerProcedure` (بوّابة الاعتماد/الرفض) لأنها الأوسع، فلا جدار أدوارٍ خلف
 * الفحص هنا. المسار المستعمَل: الشطب **السائب** (بلا consignmentId) — يمرّ بنفس فحص
 * requestedBy===actor.userId تماماً بلا حاجة لجهاز dispatch/courier-deliver الكامل.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  approveDeliveryCodWriteOff,
  rejectDeliveryCodWriteOff,
  requestDeliveryCodWriteOff,
} from "../delivery/writeoffRequests";

const TABLES = [
  "deliveryCodWriteOffRequests",
  "deliveryLedgerEntries",
  "accountingEntries",
  "idempotencyKeys",
  "deliveryParties",
  "branches",
  "users",
];

const ADMIN_A = { userId: 10, branchId: 1, role: "admin" };
const ADMIN_B = { userId: 11, branchId: 1, role: "admin" };

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}
async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: ADMIN_A.userId, openId: "sod-a", name: "أدمن أ", email: "sod-a@t.test", role: "admin", loginMethod: "local", branchId: 1 },
    { id: ADMIN_B.userId, openId: "sod-b", name: "أدمن ب", email: "sod-b@t.test", role: "admin", loginMethod: "local", branchId: 1 },
  ]);
  // branchId مطلوبٌ صراحةً هنا: requestDeliveryCodWriteOff يرفض party.branchId==null.
  await d.insert(s.deliveryParties).values([
    { id: 1, name: "مندوب", partyType: "INDIVIDUAL", branchId: 1, defaultFee: "0.00", currentBalance: "1000.00" },
  ]);
}
beforeEach(async () => {
  await reset();
  await seed();
});

function openReq(requestKey: string) {
  return requestDeliveryCodWriteOff({
    branchId: 1, partyId: 1, amount: "500.00", reason: "عجز مثبت بمحضر مطابقة",
    evidenceNote: "محضر مطابقة عهدة موقّع من طرفين", requestKey,
  }, ADMIN_A);
}

describe("حوكمة شطب عجز COD — فصل المهام سلوكياً (الطالب لا يعتمد طلبه)", () => {
  it("نفس الأدمن الذي فتح الطلب: الاعتماد والرفض كلاهما FORBIDDEN، والطلب يبقى PENDING بلا أثر", async () => {
    const req = await openReq("sod-req-same-1");

    await expect(approveDeliveryCodWriteOff(
      { id: req.id, expectedVersion: req.basePartyVersion, decisionKey: "sod-dec-same-a" },
      ADMIN_A,
    )).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(rejectDeliveryCodWriteOff(
      { id: req.id, expectedVersion: req.basePartyVersion, decisionKey: "sod-dec-same-r", reason: "سببٌ تجريبي للرفض" },
      ADMIN_A,
    )).rejects.toMatchObject({ code: "FORBIDDEN" });

    const stillPending = (await db().select().from(s.deliveryCodWriteOffRequests).where(eq(s.deliveryCodWriteOffRequests.id, req.id)))[0];
    expect(stillPending.status).toBe("PENDING");
    const party = (await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, 1)))[0];
    expect(party.currentBalance).toBe("1000.00");
  });

  it("أدمن آخر يعتمد الطلب: ينجح، العهدة تنخفض فعلاً، وreviewedBy يخالف requestedBy", async () => {
    const req = await openReq("sod-req-diff-1");
    const approved = await approveDeliveryCodWriteOff(
      { id: req.id, expectedVersion: req.basePartyVersion, decisionKey: "sod-dec-diff-a" },
      ADMIN_B,
    );
    expect(approved.request.status).toBe("APPROVED");

    const row = (await db().select().from(s.deliveryCodWriteOffRequests).where(eq(s.deliveryCodWriteOffRequests.id, req.id)))[0];
    expect(row.status).toBe("APPROVED");
    expect(Number(row.reviewedBy)).toBe(ADMIN_B.userId);
    expect(Number(row.requestedBy)).toBe(ADMIN_A.userId);

    const party = (await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, 1)))[0];
    expect(party.currentBalance).toBe("500.00"); // 1000 - 500 شُطبت فعلاً.
  });

  it("أدمن آخر يرفض الطلب: ينجح بلا أثرٍ ماليّ، وreviewedBy يخالف requestedBy", async () => {
    const req = await openReq("sod-req-diff-2");
    const rejected = await rejectDeliveryCodWriteOff(
      { id: req.id, expectedVersion: req.basePartyVersion, decisionKey: "sod-dec-diff-r", reason: "دليلٌ غير كافٍ" },
      ADMIN_B,
    );
    expect(rejected.request.status).toBe("REJECTED");
    expect(Number((await db().select().from(s.deliveryCodWriteOffRequests).where(eq(s.deliveryCodWriteOffRequests.id, req.id)))[0].reviewedBy)).toBe(ADMIN_B.userId);
    const party = (await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, 1)))[0];
    expect(party.currentBalance).toBe("1000.00"); // الرفض لا يُطبِّق أثراً.
  });
});
