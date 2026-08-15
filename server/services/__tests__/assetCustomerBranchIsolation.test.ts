/**
 * DB integration coverage for the two branch-sensitive workspaces fixed here.
 * The authenticated principal is the sole scope source: request IDs may narrow,
 * never widen. Cross-branch detail/mutation IDs are deliberately masked as NOT_FOUND.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { approveVoucher } from "../voucherService";

const TABLES = [
  "idempotencyKeys",
  "auditLogs",
  "accountingEntries",
  "receipts",
  "assetDocuments",
  "assetMaintenance",
  "assetCustodyLog",
  "fixedAssets",
  "kioskDevices",
  "customerNotes",
  "employees",
  "customers",
  "users",
  "branches",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  const database = db();
  await database.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) await database.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await database.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const database = db();
  await database.insert(schema.branches).values([
    { id: 1, name: "Branch one", code: "SEC-B1", type: "MAIN" },
    { id: 2, name: "Branch two", code: "SEC-B2", type: "SALES" },
  ]);
  await database.insert(schema.users).values([
    { id: 1, openId: "scope-admin", name: "Admin", role: "admin", branchId: 1 },
    { id: 2, openId: "scope-manager-1", name: "Manager one", role: "manager", branchId: 1 },
    { id: 3, openId: "scope-manager-2", name: "Manager two", role: "manager", branchId: 2 },
    { id: 4, openId: "scope-manager-none", name: "Branchless manager", role: "manager", branchId: null },
    { id: 5, openId: "scope-owner", name: "Owner", role: "manager", branchId: 1, isOwner: true },
  ]);
  await database.insert(schema.employees).values([
    { id: 11, firstName: "One", lastName: "Employee", email: "scope-e1@test.local", branchId: 1 },
    { id: 22, firstName: "Two", lastName: "Employee", email: "scope-e2@test.local", branchId: 2 },
  ]);
  await database.insert(schema.kioskDevices).values([
    {
      id: 91,
      branchId: 1,
      label: "Branch one device",
      tokenHash: "1".repeat(64),
      tokenPrefix: "scope-b1",
    },
    {
      id: 92,
      branchId: 2,
      label: "Branch two device",
      tokenHash: "2".repeat(64),
      tokenPrefix: "scope-b2",
    },
  ]);
  await database.insert(schema.customers).values({ id: 100, name: "Shared customer", customerType: "شركة" });
  await database.insert(schema.fixedAssets).values([
    {
      id: 101,
      code: "AST-SCOPE-1",
      name: "Branch one asset",
      category: "computers",
      branchId: 1,
      custodianId: 11,
      linkedDeviceId: 91,
      purchaseDate: "2025-01-01",
      purchaseValue: "1000",
      usefulLifeYears: 5,
      status: "active",
    },
    {
      id: 202,
      code: "AST-SCOPE-2",
      name: "Branch two asset",
      category: "devices",
      branchId: 2,
      custodianId: 22,
      linkedDeviceId: 92,
      purchaseDate: "2025-01-01",
      purchaseValue: "2000",
      usefulLifeYears: 5,
      status: "maintenance",
    },
    {
      id: 303,
      code: "AST-SCOPE-HQ",
      name: "Company asset",
      category: "furniture",
      branchId: null,
      purchaseDate: "2025-01-01",
      purchaseValue: "3000",
      usefulLifeYears: 5,
      status: "active",
    },
    {
      id: 404,
      code: "AST-SCOPE-D1",
      name: "Disposed one",
      category: "devices",
      branchId: 1,
      purchaseDate: "2020-01-01",
      purchaseValue: "4000",
      usefulLifeYears: 3,
      status: "disposed",
      disposalDate: "2025-01-01",
      disposalValue: "10",
    },
    {
      id: 505,
      code: "AST-SCOPE-D2",
      name: "Disposed two",
      category: "devices",
      branchId: 2,
      purchaseDate: "2020-01-01",
      purchaseValue: "5000",
      usefulLifeYears: 3,
      status: "disposed",
      disposalDate: "2025-01-01",
      disposalValue: "10",
    },
  ]);
  await database.insert(schema.assetCustodyLog).values([
    { assetId: 101, employeeId: 11, fromDate: "2025-01-01" },
    { assetId: 202, employeeId: 22, fromDate: "2025-01-01" },
  ]);
  await database.insert(schema.assetMaintenance).values([
    { assetId: 101, maintDate: "2026-08-01", type: "Branch one maintenance" },
    { assetId: 202, maintDate: "2026-08-02", type: "Branch two maintenance" },
  ]);
  await database.insert(schema.assetDocuments).values([
    { id: 1001, assetId: 101, title: "Branch one document", dataUrl: "data:text/plain;base64,MQ==" },
    { id: 2002, assetId: 202, title: "Branch two document", dataUrl: "data:text/plain;base64,Mg==" },
  ]);
  await database.insert(schema.customerNotes).values([
    {
      id: 10001,
      customerId: 100,
      note: "Branch one note",
      followUpDate: "2026-08-01",
      createdBy: 2,
      branchId: 1,
    },
    {
      id: 20002,
      customerId: 100,
      note: "Branch two note",
      followUpDate: "2026-08-01",
      createdBy: 3,
      branchId: 2,
    },
  ]);
}

async function user(id: number) {
  return (await db().select().from(schema.users).where(eq(schema.users.id, id)).limit(1))[0];
}

async function caller(id: number) {
  const context = {
    req: { headers: {} },
    res: { cookie() {}, clearCookie() {} },
    sessionId: null,
    platformAdmin: null,
    user: await user(id),
  } as unknown as TrpcContext;
  return appRouter.createCaller(context);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("assets company and branch scope", () => {
  it("limits every read surface to the authenticated manager branch", async () => {
    const scoped = await caller(2);
    const [list, dashboard, custody, disposal, options] = await Promise.all([
      scoped.assets.list({ includeDisposed: true }),
      scoped.assets.dashboard(),
      scoped.assets.custodyReport(),
      scoped.assets.disposalLog(),
      scoped.assets.formOptions(),
    ]);

    expect(list.map((row) => row.id).sort()).toEqual([101, 404]);
    expect(dashboard.kpis.totalAssets).toBe(1);
    expect(dashboard.recentMaintenance.map((row) => row.assetId)).toEqual([101]);
    expect(custody.byEmployee.flatMap((row) => row.items.map((item) => item.id))).toEqual([101]);
    expect(disposal.map((row) => row.id)).toEqual([404]);
    expect(options.branches.map((row) => row.id)).toEqual([1]);
    expect(options.employees.map((row) => row.id)).toEqual([11]);
    expect(await scoped.assets.list({ branchId: 2, includeDisposed: true })).toEqual([]);
  });

  it("masks cross-branch details and related writes while preserving company-wide admin/owner authority", async () => {
    const scoped = await caller(2);
    await expect(scoped.assets.get({ id: 202 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      scoped.assets.update({
        id: 202,
        name: "Forbidden",
        category: "devices",
        branchId: 2,
        purchaseDate: "2025-01-01",
        purchaseValue: "2000",
        usefulLifeYears: 5,
        depreciationMethod: "sl",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.assets.handover({ assetId: 202, employeeId: 11 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.assets.addMaintenance({ assetId: 202, type: "Forbidden" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.assets.returnFromMaintenance({ assetId: 202 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.assets.dispose({ assetId: 202, kind: "retired", date: "2026-08-01" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.assets.addDocument({ assetId: 202, title: "Forbidden", dataUrl: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.assets.deleteDocument({ docId: 2002 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      scoped.assets.create({
        name: "Cross branch",
        category: "computers",
        branchId: 2,
        purchaseDate: "2026-01-01",
        purchaseValue: "1",
        usefulLifeYears: 1,
        depreciationMethod: "sl",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const now = new Date();
    await scoped.assets.postDepreciation({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 });
    const depreciationEntries = await db().select({ key: schema.accountingEntries.dedupeKey }).from(schema.accountingEntries);
    expect(depreciationEntries.some((entry) => entry.key?.startsWith("DEPR:202:"))).toBe(false);

    const [adminList, ownerList, adminDetail, ownerDetail] = await Promise.all([
      (await caller(1)).assets.list({ includeDisposed: true }),
      (await caller(5)).assets.list({ includeDisposed: true }),
      (await caller(1)).assets.get({ id: 202 }),
      (await caller(5)).assets.get({ id: 202 }),
    ]);
    expect(adminList).toHaveLength(5);
    expect(ownerList).toHaveLength(5);
    expect(adminDetail.id).toBe(202);
    expect(ownerDetail.id).toBe(202);
  });

  it("keeps branch transfers referentially and financially scoped for company-wide actors", async () => {
    const admin = await caller(1);
    await expect(
      admin.assets.update({
        id: 101,
        name: "Invalid linked transfer",
        category: "computers",
        branchId: 2,
        purchaseDate: "2025-01-01",
        purchaseValue: "1000",
        usefulLifeYears: 5,
        depreciationMethod: "sl",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await db().insert(schema.fixedAssets).values({
      id: 606,
      code: "AST-SCOPE-MOVE",
      name: "Movable asset",
      category: "computers",
      branchId: 1,
      purchaseDate: "2025-01-01",
      purchaseValue: "1000",
      usefulLifeYears: 5,
      status: "active",
    });
    await db().insert(schema.receipts).values([
      {
        branchId: 1, cashBucket: "TREASURY", direction: "IN", amount: "10000.00",
        paymentMethod: "CASH", status: "COMPLETED", approvalStatus: "APPROVED",
        referenceNumber: "SCOPE-MOVE-FUND-1", createdBy: 1,
      },
      {
        branchId: 2, cashBucket: "TREASURY", direction: "IN", amount: "10000.00",
        paymentMethod: "CASH", status: "COMPLETED", approvalStatus: "APPROVED",
        referenceNumber: "SCOPE-MOVE-FUND-2", createdBy: 1,
      },
      {
        branchId: 1, cashBucket: "TREASURY", direction: "OUT", amount: "1000.00",
        paymentMethod: "CASH", status: "COMPLETED", approvalStatus: "APPROVED",
        referenceNumber: "ASSET-ACQ-606", createdBy: 1,
      },
    ]);
    const moved = await admin.assets.update({
      id: 606,
      name: "Movable asset",
      category: "computers",
      branchId: 2,
      purchaseDate: "2025-01-01",
      purchaseValue: "1500",
      usefulLifeYears: 5,
      depreciationMethod: "sl",
    });
    expect(moved).toMatchObject({ branchId: 1, paymentPending: true });
    const [request] = await db().select().from(schema.receipts)
      .where(eq(schema.receipts.referenceNumber, "ASSET-REACQ-606-1"));
    await approveVoucher(Number(request.id), { userId: 5, branchId: 1, role: "manager" });
    const finalized = await admin.assets.get({ id: 606 });
    expect(finalized.branchId).toBe(2);

    const entries = await db()
      .select({ key: schema.accountingEntries.dedupeKey, branchId: schema.accountingEntries.branchId })
      .from(schema.accountingEntries);
    expect(entries.find((entry) => entry.key?.startsWith("ASSET_ACQREV:606:"))?.branchId).toBe(1);
    expect(entries.find((entry) => entry.key?.startsWith("ASSET_REACQ:606:"))?.branchId).toBe(2);
  });

  it("redacts legacy cross-branch custodian/device links instead of leaking their identities", async () => {
    await db().update(schema.fixedAssets).set({ custodianId: 22, linkedDeviceId: 92 }).where(eq(schema.fixedAssets.id, 101));
    await db().update(schema.assetCustodyLog).set({ employeeId: 22 }).where(eq(schema.assetCustodyLog.assetId, 101));

    const scoped = await caller(2);
    const [list, detail, adminDetail] = await Promise.all([
      scoped.assets.list({ includeDisposed: true }),
      scoped.assets.get({ id: 101 }),
      (await caller(1)).assets.get({ id: 101 }),
    ]);
    expect(list.find((row) => row.id === 101)).toMatchObject({ custodianId: null, custodianName: null, linkedDeviceId: null });
    expect(detail).toMatchObject({ custodianId: null, custodianName: null, linkedDeviceId: null, custody: [] });
    expect(adminDetail.custodianId).toBe(22);
    expect(adminDetail.linkedDeviceId).toBe(92);
    expect(adminDetail.custody.map((row) => row.employeeId)).toEqual([22]);
  });

  it("fails a branchless manager closed before any DB result is exposed", async () => {
    const branchless = await caller(4);
    await expect(branchless.assets.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(branchless.assets.dashboard()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(branchless.assets.get({ id: 101 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns custody inside the manager branch, closes history, audits, and preserves the device link", async () => {
    const returned = await (await caller(2)).assets.returnCustody({ assetId: 101 });
    expect(returned).toMatchObject({ id: 101, custodianId: null, linkedDeviceId: 91 });
    expect(returned.custody).toHaveLength(1);
    expect(returned.custody[0].toDate).not.toBeNull();

    const audits = await db()
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "asset.custody.return"));
    expect(audits).toHaveLength(1);
    expect(Number(audits[0].entityId)).toBe(101);
  });

  it("masks cross-branch custody return and fails a branchless manager closed", async () => {
    await expect((await caller(2)).assets.returnCustody({ assetId: 202 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await caller(4)).assets.returnCustody({ assetId: 101 })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const [branchTwo] = await db().select().from(schema.fixedAssets).where(eq(schema.fixedAssets.id, 202));
    expect(branchTwo).toMatchObject({ custodianId: 22, linkedDeviceId: 92 });
  });

  it("allows admin and owner company-wide custody returns", async () => {
    const adminReturned = await (await caller(1)).assets.returnCustody({ assetId: 202 });
    const ownerReturned = await (await caller(5)).assets.returnCustody({ assetId: 101 });

    expect(adminReturned).toMatchObject({ id: 202, custodianId: null, linkedDeviceId: 92 });
    expect(ownerReturned).toMatchObject({ id: 101, custodianId: null, linkedDeviceId: 91 });
  });

  it("rejects disposed assets, assets without custody, and repeated returns without duplicating history", async () => {
    const manager = await caller(2);
    await manager.assets.returnCustody({ assetId: 101 });
    await expect(manager.assets.returnCustody({ assetId: 101 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect((await caller(1)).assets.returnCustody({ assetId: 303 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect((await caller(1)).assets.returnCustody({ assetId: 404 })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const rows = await db()
      .select()
      .from(schema.assetCustodyLog)
      .where(eq(schema.assetCustodyLog.assetId, 101));
    expect(rows).toHaveLength(1);
    expect(rows[0].toDate).not.toBeNull();
  });
});

describe("customer notes company and branch scope", () => {
  it("isolates list and dueToday while admin and owner retain company-wide reads", async () => {
    const scoped = await caller(2);
    const [list, due, adminList, ownerDue] = await Promise.all([
      scoped.customerNotes.list({ customerId: 100, includeResolved: true, limit: 100 }),
      scoped.customerNotes.dueToday(),
      (await caller(1)).customerNotes.list({ customerId: 100, includeResolved: true, limit: 100 }),
      (await caller(5)).customerNotes.dueToday(),
    ]);
    expect(list.rows.map((row) => row.id)).toEqual([10001]);
    expect(due.map((row) => row.id)).toEqual([10001]);
    expect(adminList.rows.map((row) => row.id).sort()).toEqual([10001, 20002]);
    expect(ownerDue.map((row) => row.id).sort()).toEqual([10001, 20002]);
  });

  it("binds create to the authenticated user/customer/branch and masks all cross-branch mutations", async () => {
    const scoped = await caller(2);
    const created = await scoped.customerNotes.create({ customerId: 100, note: "Own branch note" });
    const [stored] = await db().select().from(schema.customerNotes).where(eq(schema.customerNotes.id, created.id));
    expect(stored).toMatchObject({ customerId: 100, createdBy: 2, branchId: 1 });

    await expect(scoped.customerNotes.create({ customerId: 100, note: "Cross branch", branchId: 2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(scoped.customerNotes.update({ noteId: 20002, note: "Cross branch" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.customerNotes.resolve({ noteId: 20002, isResolved: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.customerNotes.delete({ noteId: 20002 })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const [unchanged] = await db().select().from(schema.customerNotes).where(eq(schema.customerNotes.id, 20002));
    expect(unchanged).toMatchObject({ note: "Branch two note", isResolved: false, branchId: 2 });

    await (await caller(1)).customerNotes.update({ noteId: 20002, note: "Admin update" });
    const [adminUpdated] = await db().select().from(schema.customerNotes).where(eq(schema.customerNotes.id, 20002));
    expect(adminUpdated.note).toBe("Admin update");
  });

  it("fails branchless reads and writes closed with no branch-one fallback", async () => {
    const branchless = await caller(4);
    await expect(branchless.customerNotes.list({ customerId: 100, includeResolved: true, limit: 100 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(branchless.customerNotes.dueToday()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(branchless.customerNotes.create({ customerId: 100, note: "No fallback" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const rows = await db().select().from(schema.customerNotes);
    expect(rows).toHaveLength(2);
  });
});
