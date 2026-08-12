/**
 * Adversarial branch-isolation coverage for HR surfaces.
 * The authenticated principal is the only authority source: request branch IDs
 * may narrow an admin query, but cannot move a branch-scoped manager elsewhere.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { getJobApplicantCvByKey } from "../jobApplicantCvService";
import { mapDeviceUserToEmployee } from "../hrDevices/punchStore";
import { truncateTables } from "./__testUtils__";

const BRANCH_ONE_CV_KEY = "A".repeat(43);

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function seed() {
  const database = db();
  await database.insert(schema.branches).values([
    { id: 1, name: "Branch one", code: "HR-SCOPE-B1", type: "MAIN" },
    { id: 2, name: "Branch two", code: "HR-SCOPE-B2", type: "SALES" },
  ]);
  await database.insert(schema.users).values([
    { id: 1, openId: "hr-scope-admin", name: "Admin", role: "admin", branchId: 1 },
    { id: 2, openId: "hr-scope-manager-1", name: "Manager one", role: "manager", branchId: 1 },
    { id: 3, openId: "hr-scope-manager-2", name: "Manager two", role: "manager", branchId: 2 },
    { id: 4, openId: "hr-scope-manager-none", name: "Branchless manager", role: "manager", branchId: null },
    { id: 5, openId: "hr-scope-owner", name: "Owner", role: "manager", branchId: 1, isOwner: true },
  ]);
  await database.insert(schema.employees).values([
    { id: 11, firstName: "One", lastName: "Employee", branchId: 1, payType: "monthly", salary: "1000" },
    { id: 22, firstName: "Two", lastName: "Employee", branchId: 2, payType: "monthly", salary: "2000" },
    { id: 33, firstName: "HQ", lastName: "Employee", branchId: null, payType: "monthly", salary: "3000" },
  ]);
  await database.insert(schema.jobVacancies).values([
    { id: 51, title: "Branch one role", branchId: 1, isPublished: true },
    { id: 52, title: "Branch two role", branchId: 2, isPublished: true },
    { id: 53, title: "HQ role", branchId: null, isPublished: false },
  ]);
  await database.insert(schema.jobApplicants).values([
    { id: 61, name: "Branch one applicant", branchId: 1, vacancyId: 51 },
    { id: 62, name: "Branch two applicant", branchId: 2, vacancyId: 52 },
    { id: 63, name: "Unassigned applicant", vacancyId: null },
    { id: 64, name: "Branch one general applicant", branchId: 1, vacancyId: null },
  ]);
  await database.insert(schema.jobApplicantCvFiles).values({
    applicantId: 61,
    publicKey: BRANCH_ONE_CV_KEY,
    fileName: "branch-one.pdf",
    mimeType: "application/pdf",
    sizeBytes: 8,
    bytes: Buffer.from("%PDF-ok"),
  });
  await database.insert(schema.hrFingerprintDevices).values([
    { id: 101, name: "Branch one device", branchId: 1, serialNumber: "HR-SCOPE-SN-1", enabled: false },
    { id: 202, name: "Branch two device", branchId: 2, serialNumber: "HR-SCOPE-SN-2", enabled: false },
    { id: 303, name: "Unassigned device", branchId: null, serialNumber: "HR-SCOPE-SN-3", enabled: false },
  ]);
  await database.insert(schema.hrDeviceUsers).values([
    { id: 1001, deviceId: 101, enrollId: 1, name: "One", employeeId: 11 },
    { id: 2002, deviceId: 202, enrollId: 2, name: "Two", employeeId: 22 },
  ]);
  await database.insert(schema.hrAttendancePunches).values([
    { id: 1101, deviceId: 101, serialNumber: "HR-SCOPE-SN-1", enrollId: 1, punchAt: "2026-08-12 08:00:00", employeeId: 11 },
    { id: 2202, deviceId: 202, serialNumber: "HR-SCOPE-SN-2", enrollId: 2, punchAt: "2026-08-12 08:01:00", employeeId: 22 },
  ]);
  await database.insert(schema.hrDeviceCommands).values([
    { id: 1111, deviceId: 101, cmd: "getdevinfo", createdBy: 2 },
    { id: 2222, deviceId: 202, cmd: "getdevinfo", createdBy: 3 },
  ]);
}

async function resetAndSeed() {
  await truncateTables([
    "auditLogs",
    "hrDeviceCommands",
    "hrAttendancePunches",
    "hrDeviceUsers",
    "hrFingerprintDevices",
    "jobApplicantCvFiles",
    "jobApplicants",
    "jobVacancies",
    "employees",
    "branches",
    "users",
  ]);
  await seed();
}

async function caller(id: number) {
  const [user] = await db().select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
  const context = {
    req: { headers: {} },
    res: { cookie() {}, clearCookie() {} },
    sessionId: null,
    platformAdmin: null,
    user,
  } as unknown as TrpcContext;
  return appRouter.createCaller(context);
}

beforeEach(resetAndSeed);

describe("employee branch isolation", () => {
  it("limits manager reads and writes, derives creates from the principal, and masks cross-branch IDs", async () => {
    const scoped = await caller(2);
    const list = await scoped.employees.list({ includeInactive: true });
    expect(list.rows.map((row) => row.id)).toEqual([11]);

    const options = await scoped.employees.formOptions();
    expect(options.branches.map((branch) => branch.id)).toEqual([1]);
    expect(options.managers.map((manager) => manager.id)).toEqual([11]);

    await expect(scoped.employees.get({ id: 22 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.employees.list({ branchId: 2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      scoped.employees.update({
        id: 22,
        firstName: "Forbidden",
        lastName: "Employee",
        branchId: 2,
        payType: "monthly",
        salary: "2000",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.employees.setStatus({ id: 22, status: "leave" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.employees.setStatus({ id: 11, status: "terminated" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/مسار إنهاء الخدمة الرسمي/),
    });
    await expect(scoped.employees.delete({ id: 22 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      scoped.employees.update({
        id: 11,
        firstName: "One",
        lastName: "Employee",
        branchId: 2,
        payType: "monthly",
        salary: "1000",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      scoped.employees.create({ firstName: "Cross", lastName: "Branch", branchId: 2, payType: "monthly" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const created = await scoped.employees.create({ firstName: "Scoped", lastName: "Create", payType: "monthly" });
    expect(created?.branchId).toBe(1);
    await expect(
      scoped.employees.create({ firstName: "Bad", lastName: "Manager", managerId: 22, payType: "monthly" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("preserves company-wide admin/owner authority and fails closed for a branchless manager", async () => {
    const admin = await caller(1);
    const owner = await caller(5);
    expect((await admin.employees.list({ includeInactive: true })).rows).toHaveLength(3);
    expect((await owner.employees.list({ includeInactive: true })).rows).toHaveLength(3);
    expect((await admin.employees.get({ id: 22 })).id).toBe(22);
    expect((await owner.employees.get({ id: 22 })).id).toBe(22);
    await expect((await caller(4)).employees.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("recruitment branch isolation", () => {
  it("scopes vacancies, applicants, counts, and every applicant/vacancy mutation", async () => {
    const scoped = await caller(2);
    expect((await scoped.recruitment.vacancyList()).map((row) => row.id)).toEqual([51]);
    expect((await scoped.recruitment.list()).map((row) => row.id)).toEqual([64, 61]);
    expect(await scoped.recruitment.vacancyCounts()).toEqual({ 51: 1 });

    await expect(scoped.recruitment.get({ id: 62 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.recruitment.updateStage({ id: 62, stage: "review" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.recruitment.setRating({ id: 62, rating: 5 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.recruitment.vacancyGet({ id: 52 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.recruitment.vacancyPublish({ id: 52, isPublished: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.recruitment.vacancyDelete({ id: 52 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.recruitment.vacancyUpdate({ id: 51, title: "Move", branchId: 2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(scoped.recruitment.vacancyCreate({ title: "Cross branch", branchId: 2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(scoped.recruitment.create({ name: "Cross branch", branchId: 2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(scoped.recruitment.create({ name: "Cross vacancy", vacancyId: 52 })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const vacancy = await scoped.recruitment.vacancyCreate({ title: "Scoped vacancy" });
    expect(vacancy?.branchId).toBe(1);
    const applicant = await scoped.recruitment.create({ name: "Scoped applicant", vacancyId: vacancy!.id });
    expect(applicant?.vacancyId).toBe(vacancy!.id);
    expect(applicant?.branchId).toBe(1);
    const general = await scoped.recruitment.create({ name: "Scoped general applicant" });
    expect(general?.branchId).toBe(1);
    expect(general?.vacancyId).toBeNull();
    const publicGeneral = await scoped.recruitment.submit({ name: "Public general applicant", branchId: 1 });
    expect(publicGeneral).toMatchObject({ branchId: 1, vacancyId: null, source: "external" });
    await expect(scoped.recruitment.submit({ name: "Unknown branch", branchId: 999_999 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await scoped.recruitment.vacancyDelete({ id: vacancy!.id });
    expect(await scoped.recruitment.get({ id: applicant!.id })).toMatchObject({ branchId: 1, vacancyId: null });
  });

  it("keeps admin/owner company-wide and rejects branchless HR users", async () => {
    expect(await (await caller(1)).recruitment.vacancyList()).toHaveLength(3);
    expect(await (await caller(5)).recruitment.list()).toHaveLength(4);
    await expect((await caller(4)).recruitment.vacancyList()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("never returns CV bytes to a manager outside the vacancy branch", async () => {
    expect(await getJobApplicantCvByKey(BRANCH_ONE_CV_KEY, { branchId: 1 })).toMatchObject({
      fileName: "branch-one.pdf",
    });
    expect(await getJobApplicantCvByKey(BRANCH_ONE_CV_KEY, { branchId: 2 })).toBeNull();
    expect(await getJobApplicantCvByKey(BRANCH_ONE_CV_KEY, { branchId: null })).toMatchObject({
      publicKey: BRANCH_ONE_CV_KEY,
    });
  });
});

describe("HR device branch isolation", () => {
  it("scopes device inventory, punches, users, commands, writes, and mappings", async () => {
    const scoped = await caller(2);
    expect((await scoped.hrDevices.list()).map((row) => row.id)).toEqual([101]);
    expect(await scoped.hrDevices.migrationStatus()).toEqual({ total: 1, migrated: 0, pending: 1 });
    expect((await scoped.hrDevices.punchesList({})).rows.map((row) => row.id)).toEqual([1101]);

    await expect(scoped.hrDevices.get({ id: 202 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.hrDevices.deviceUsers({ deviceId: 202 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.hrDevices.commandsList({ deviceId: 202 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.hrDevices.employeeLinks({ employeeId: 22 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.hrDevices.update({ id: 202, name: "Forbidden", branchId: 2 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.hrDevices.update({ id: 101, name: "Move", branchId: 2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(scoped.hrDevices.migrate({ id: 202 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.hrDevices.deleteDevice({ id: 202 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.hrDevices.approveDevice({ id: 303, branchId: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.hrDevices.create({ name: "Cross device", branchId: 2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(scoped.hrDevices.mapUser({ deviceId: 101, enrollId: 1, employeeId: 22 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      mapDeviceUserToEmployee(101, 99, 22, null, { branchId: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped.hrDevices.processFolds()).rejects.toMatchObject({ code: "FORBIDDEN" });

    const created = await scoped.hrDevices.create({ name: "Scoped device" });
    expect(created?.branchId).toBe(1);
    await expect(
      (await caller(1)).hrDevices.mapUser({ deviceId: 101, enrollId: 1, employeeId: 22 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("keeps admin/owner visibility and rejects users with no assigned branch", async () => {
    expect(await (await caller(1)).hrDevices.list()).toHaveLength(3);
    expect(await (await caller(5)).hrDevices.list()).toHaveLength(3);
    await expect((await caller(4)).hrDevices.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
