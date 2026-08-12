import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

function db() {
  const database = getDb();
  if (!database) throw new Error("DATABASE_URL not set for tests");
  return database;
}

async function callerFor(id: number) {
  const user = (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0];
  return appRouter.createCaller({ req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any);
}

beforeEach(async () => {
  const database = db();
  await database.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of ["taskEvents", "tasks", "waKeywordRules", "serviceTypes", "users", "branches"]) {
    await database.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await database.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await database.insert(s.branches).values([
    { id: 1, name: "Main", code: "MAIN", type: "MAIN" },
    { id: 2, name: "Second", code: "SECOND", type: "SALES" },
  ]);
  await database.insert(s.users).values([
    { id: 1, openId: "admin", name: "Admin", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "manager", name: "Manager", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "cashier-main", name: "Cashier main", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "cashier-second", name: "Cashier second", role: "cashier", loginMethod: "local", branchId: 2 },
  ]);
});

describe("task assignment branch integrity", () => {
  it("rejects assigning a branch task to a non-manager employee in another branch", async () => {
    const cashier = await callerFor(3);
    const manager = await callerFor(2);

    await expect(cashier.tasks.create({ branchId: 1, title: "Cross branch", assignedTo: 4 }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });

    const task = await cashier.tasks.create({ branchId: 1, title: "Main branch" });
    await expect(manager.tasks.assign({ taskId: task.taskId, assignedTo: 4 }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
