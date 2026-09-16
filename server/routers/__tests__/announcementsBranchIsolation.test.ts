import { eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

const TABLES = [
  "auditLogs",
  "announcementReads",
  "announcements",
  "appNotifications",
  "nativePushOutbox",
  "users",
  "branches",
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
    { id: 1, openId: "ann-admin", name: "الأدمن", role: "admin", branchId: 1 },
    { id: 2, openId: "ann-main-manager", name: "مدير الرئيسي", role: "manager", branchId: 1 },
    { id: 3, openId: "ann-sales-manager", name: "مدير المبيعات", role: "manager", branchId: 2 },
    { id: 4, openId: "ann-sales-cashier", name: "كاشير المبيعات", role: "cashier", branchId: 2 },
  ]);
  await db().insert(s.announcements).values([
    {
      id: 101,
      title: "إعلان الرئيسي",
      body: "خاص بالرئيسي",
      audienceType: "BRANCH",
      audienceBranchId: 1,
      createdBy: 1,
    },
    {
      id: 102,
      title: "إعلان المبيعات",
      body: "خاص بالمبيعات",
      audienceType: "BRANCH",
      audienceBranchId: 2,
      createdBy: 1,
    },
    {
      id: 103,
      title: "إعلان عام",
      body: "لكل الفروع",
      audienceType: "ALL",
      requiresAck: true,
      createdBy: 1,
    },
  ]);
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

async function user(id: number) {
  return (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0];
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("عزل إدارة الإعلانات الداخلية حسب الفرع", () => {
  it("list يقصر مدير الفرع على إعلانات فرعه ويحجب الإعلان العام", async () => {
    const caller = appRouter.createCaller(context(await user(2)));
    const rows = await caller.announcements.list({ includeInactive: true, limit: 20 });
    expect(rows.map((row) => Number(row.id))).toEqual([101]);
  });

  it("get يخفي إعلان فرع آخر والإعلان العام عن مدير الفرع", async () => {
    const caller = appRouter.createCaller(context(await user(2)));
    await expect(caller.announcements.get({ id: 102 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.announcements.get({ id: 103 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.announcements.get({ id: 101 })).resolves.toMatchObject({ announcement: { id: 101 } });
  });

  it("setActive لا يغيّر إعلان فرع آخر أو الإعلان العام", async () => {
    const caller = appRouter.createCaller(context(await user(2)));
    await expect(caller.announcements.setActive({ id: 102, isActive: false })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(caller.announcements.setActive({ id: 103, isActive: false })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const protectedRows = await db()
      .select({ id: s.announcements.id, isActive: s.announcements.isActive })
      .from(s.announcements)
      .where(inArray(s.announcements.id, [102, 103]));
    expect(protectedRows).toHaveLength(2);
    expect(protectedRows.every((row) => row.isActive)).toBe(true);

    await expect(caller.announcements.setActive({ id: 101, isActive: false })).resolves.toEqual({ ok: true });
  });

  it("يبقي الأدمن واسع الصلاحية في list/get/setActive", async () => {
    const caller = appRouter.createCaller(context(await user(1)));
    expect((await caller.announcements.list({ includeInactive: true })).map((row) => Number(row.id)).sort()).toEqual([
      101,
      102,
      103,
    ]);
    await expect(caller.announcements.get({ id: 102 })).resolves.toMatchObject({ announcement: { id: 102 } });
    await expect(caller.announcements.get({ id: 103 })).resolves.toMatchObject({ announcement: { id: 103 } });
    await expect(caller.announcements.setActive({ id: 102, isActive: false })).resolves.toEqual({ ok: true });
  });

  it("لا يكسر القراءة الذاتية لمستهدَف فرعٍ أو إعلانٍ عام", async () => {
    const caller = appRouter.createCaller(context(await user(4)));
    const mine = await caller.announcements.mine({ limit: 20 });
    expect(mine.rows.map((row) => Number(row.id)).sort()).toEqual([102, 103]);
    await expect(caller.announcements.markRead({ id: 102 })).resolves.toEqual({ ok: true });
    await expect(caller.announcements.acknowledge({ id: 103 })).resolves.toEqual({ ok: true });
  });
});
