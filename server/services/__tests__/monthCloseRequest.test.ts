/**
 * ش٥ب: طلب إقفال الشهر واعتماده — قرارا المالك (١١/٨) هما العقد المُختبَر:
 *   «المدير يطلُب، والأدمن/المالك يُقفل» · «لا تجاوز للحاجز إطلاقاً».
 *
 * أحسم اختبارين هنا يحرسان ثغرتين حقيقيتين لا تجميلاً:
 *   ٦) وردية تُفتَح **بعد** الطلب ⇒ الاعتماد يفشل — الفحص حيٌّ لا لقطةٌ مخزَّنة.
 *  ١٠) وردية مفتوحة في **فرعٍ آخر** تحجب الطلب — القفل عامّ فالجاهزية عامّة.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { isDupEntry } from "../../../shared/errorMap.ar";
import { getDb } from "../../db";
import { getActiveLock } from "../periodLockService";
import {
  approveMonthClose,
  rejectMonthClose,
  requestMonthClose,
} from "../reports/monthCloseRequest";
import { withTx } from "../tx";
import { truncateTables } from "./__testUtils__";

const MONTH = "2026-07";
const MGR = 2;
const ADMIN = 1;

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function reset() {
  await truncateTables([
    "monthCloseRequests",
    "financialPeriods",
    "journalLines",
    "journalEntries",
    "accountingEntries",
    "receipts",
    "shifts",
    "branches",
    "users",
  ]);
  const d = db();
  await d.insert(s.users).values([
    { id: ADMIN, openId: "a", name: "المالك", role: "admin", loginMethod: "local" },
    { id: MGR, openId: "m", name: "المدير", role: "manager", loginMethod: "local" },
  ]);
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
}

async function openShift(branchId: number) {
  await db().insert(s.shifts).values({
    userId: MGR, branchId, status: "OPEN", openedAt: new Date("2026-07-10T09:00:00Z"),
    openGuard: `${MGR}:${branchId}:x`, openingBalance: "0",
  });
}

async function req(month = MONTH, by = MGR) {
  return withTx(async (tx) => requestMonthClose(tx, { month, requestedBy: by }));
}

async function rowOf(id: number) {
  const r = await db().select().from(s.monthCloseRequests).where(eq(s.monthCloseRequests.id, id));
  return r[0];
}

beforeEach(reset);

describe("طلب إقفال الشهر واعتماده (ش٥ب)", () => {
  it("١) شهرٌ سالك ⇒ الطلب يُسجَّل معلَّقاً بلقطة جاهزية", async () => {
    const { id } = await req();
    const row = await rowOf(id);
    expect(row.status).toBe("PENDING_APPROVAL");
    expect(Number(row.requestedBy)).toBe(MGR);
    expect(JSON.parse(row.readinessSnapshot).blocked).toBe(false);
    // لم يُقفَل شيءٌ بمجرّد الطلب.
    await withTx(async (tx) => expect(await getActiveLock(tx)).toBeNull());
  });

  it("٢) وردية مفتوحة ⇒ الطلب يُرفَض خادمياً (لا تجاوز)", async () => {
    await openShift(1);
    await expect(req()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.monthCloseRequests)).toHaveLength(0);
  });

  it("٣) طلبان معلَّقان لنفس الشهر ⇒ يمنعهما قيد القاعدة لا فحصٌ تطبيقيّ", async () => {
    await req();
    let caught: unknown;
    try { await req(); } catch (e) { caught = e; }
    expect(isDupEntry(caught)).toBe(true);
  });

  it("٤) الطالب نفسه يعتمد ⇒ FORBIDDEN (فصل المهام)", async () => {
    const { id } = await req();
    await expect(
      withTx(async (tx) => approveMonthClose(tx, { requestId: id, decidedBy: MGR })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await rowOf(id)).status).toBe("PENDING_APPROVAL");
  });

  it("٥) اعتمادٌ سليم ⇒ يقفل الفترة فعلاً ويربط الطلب بالقفل", async () => {
    const { id } = await req();
    const out = await withTx(async (tx) => approveMonthClose(tx, { requestId: id, decidedBy: ADMIN }));

    const row = await rowOf(id);
    expect(row.status).toBe("APPROVED");
    expect(Number(row.decidedBy)).toBe(ADMIN);
    expect(Number(row.lockedPeriodId)).toBe(out.periodId);

    await withTx(async (tx) => {
      const lock = await getActiveLock(tx);
      expect(lock).not.toBeNull();
      expect(lock!.cutoffDate).toBe("2026-07-31"); // نهاية الشهر
    });
  });

  it("٦) وردية فُتحت **بعد** الطلب ⇒ الاعتماد يفشل (الفحص حيٌّ لا مخزَّن) — حاسم", async () => {
    const { id } = await req();
    await openShift(1); // بين الطلب والاعتماد

    await expect(
      withTx(async (tx) => approveMonthClose(tx, { requestId: id, decidedBy: ADMIN })),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect((await rowOf(id)).status).toBe("PENDING_APPROVAL");
    await withTx(async (tx) => expect(await getActiveLock(tx)).toBeNull()); // لم يُقفَل شيء
  });

  it("٧) رفضٌ بسببٍ ⇒ REJECTED ويحرّر الشهر لطلبٍ جديد", async () => {
    const { id } = await req();
    await withTx(async (tx) =>
      rejectMonthClose(tx, { requestId: id, decidedBy: ADMIN, reason: "بانتظار مطابقة الخزينة" }),
    );
    expect((await rowOf(id)).status).toBe("REJECTED");
    // pendingGuard صار NULL ⇒ طلبٌ جديدٌ لنفس الشهر مسموح.
    const again = await req();
    expect(again.id).toBeGreaterThan(id);
  });

  it("٨) رفضٌ بلا سببٍ كافٍ ⇒ يُرفض", async () => {
    const { id } = await req();
    await expect(
      withTx(async (tx) => rejectMonthClose(tx, { requestId: id, decidedBy: ADMIN, reason: "لا" })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("٩) اعتماد طلبٍ محسومٍ مسبقاً ⇒ يُرفض (لا قفلَ مزدوج)", async () => {
    const { id } = await req();
    await withTx(async (tx) => approveMonthClose(tx, { requestId: id, decidedBy: ADMIN }));
    await expect(
      withTx(async (tx) => approveMonthClose(tx, { requestId: id, decidedBy: ADMIN })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("١٠) وردية مفتوحة في **فرعٍ آخر** تحجب الطلب — القفل عامّ فالجاهزية عامّة — حاسم", async () => {
    await openShift(2); // فرع المبيعات، والطالب مدير الرئيسي
    await expect(req()).rejects.toThrow(TRPCError);
    expect(await db().select().from(s.monthCloseRequests)).toHaveLength(0);
  });
});
