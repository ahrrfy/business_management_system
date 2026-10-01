import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as schema from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { hrEnterpriseRouter } from "../../routers/hrEnterpriseRouter";
import { truncateTables } from "./__testUtils__";
import * as fs from "fs";
import * as path from "path";

const TABLES = [
  "employeeDocuments",
  "employeePenalties",
  "employeeContracts",
  "employeeSpotBonuses",
  "employeeTransfers",
  "employeeLoanRequests",
  "employeeCustody",
  "employees",
  "users",
  "branches",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function resetDb() {
  await truncateTables(TABLES);
}

// Seed test branches, users, and employees
let emp1Id: number;
let emp2Id: number;
let doc1Id: number;
let doc2Id: number;
let penalty1Id: number;
let penalty2Id: number;
let contract1Id: number;
let contract2Id: number;
let bonus1Id: number;
let bonus2Id: number;
let transfer1Id: number;
let transfer2Id: number;
let loan1Id: number;
let loan2Id: number;
let custody1Id: number;
let custody2Id: number;

async function seedData() {
  const database = db();

  // 1. Branches
  await database.insert(schema.branches).values([
    { id: 1, name: "فرع بغداد الرئيسي", code: "BG-MAIN", type: "MAIN" },
    { id: 2, name: "فرع مبيعات الكرخ", code: "BG-SALES", type: "SALES" },
  ]);

  // 2. Users
  await database.insert(schema.users).values([
    { id: 10, openId: "usr-admin-gm", name: "المدير العام", role: "admin", branchId: null },
    { id: 11, openId: "usr-mgr-b1", name: "مدير فرع 1", role: "manager", branchId: 1 },
    { id: 12, openId: "usr-mgr-b2", name: "مدير فرع 2", role: "manager", branchId: 2 },
    { id: 13, openId: "usr-mgr-none", name: "مدير بدون فرع", role: "manager", branchId: null },
  ]);

  // 3. Employees
  const [e1] = await database.insert(schema.employees).values({
    id: 1001,
    branchId: 1,
    firstName: "علي",
    lastName: "حسين",
    jobTitle: "محاسب",
    salary: "1200000.00",
    allowances: "300000.00",
    annualLeaveBalance: 15,
    isActive: true,
  });
  emp1Id = 1001;

  const [e2] = await database.insert(schema.employees).values({
    id: 1002,
    branchId: 2,
    firstName: "عمر",
    lastName: "فاضل",
    jobTitle: "كاشير",
    salary: "900000.00",
    allowances: "150000.00",
    annualLeaveBalance: 20,
    isActive: true,
  });
  emp2Id = 1002;

  // 4. Documents (with upcoming expiry in 10 days for alert testing)
  const [d1] = await database.insert(schema.employeeDocuments).values({
    employeeId: emp1Id,
    documentType: "WORK_PERMIT",
    title: "تصريح عمل فرع 1",
    documentNumber: "WP-001",
    expiryDate: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10),
    alertDaysBefore: 30,
    status: "ACTIVE",
    createdById: 10,
  });
  doc1Id = d1.insertId;

  const [d2] = await database.insert(schema.employeeDocuments).values({
    employeeId: emp2Id,
    documentType: "RESIDENCY_VISA",
    title: "إقامة فرع 2",
    documentNumber: "RV-002",
    expiryDate: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10),
    alertDaysBefore: 30,
    status: "ACTIVE",
    createdById: 10,
  });
  doc2Id = d2.insertId;

  // 5. Penalties
  const [p1] = await database.insert(schema.employeePenalties).values({
    employeeId: emp1Id,
    branchId: 1,
    penaltyType: "WARNING",
    decisionNumber: "PEN-001",
    decisionDate: "2026-09-01",
    reason: "تأخير غير مبرر",
    status: "APPROVED",
    createdById: 11,
  });
  penalty1Id = p1.insertId;

  const [p2] = await database.insert(schema.employeePenalties).values({
    employeeId: emp2Id,
    branchId: 2,
    penaltyType: "ATTENTION",
    decisionNumber: "PEN-002",
    decisionDate: "2026-09-02",
    reason: "مخالفة زي العمل",
    status: "APPROVED",
    createdById: 12,
  });
  penalty2Id = p2.insertId;

  // 6. Contracts (with probation ending in 10 days for alert testing)
  const probationDate = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const [c1] = await database.insert(schema.employeeContracts).values({
    employeeId: emp1Id,
    branchId: 1,
    contractType: "PROBATION",
    contractNumber: "CON-001",
    startDate: "2026-07-01",
    probationEndDate: probationDate,
    basicSalary: "1200000.00",
    allowances: "300000.00",
    status: "ACTIVE",
    createdById: 11,
  });
  contract1Id = c1.insertId;

  const [c2] = await database.insert(schema.employeeContracts).values({
    employeeId: emp2Id,
    branchId: 2,
    contractType: "PROBATION",
    contractNumber: "CON-002",
    startDate: "2026-07-01",
    probationEndDate: probationDate,
    basicSalary: "900000.00",
    allowances: "150000.00",
    status: "ACTIVE",
    createdById: 12,
  });
  contract2Id = c2.insertId;

  // 7. Spot Bonuses
  const [b1] = await database.insert(schema.employeeSpotBonuses).values({
    employeeId: emp1Id,
    branchId: 1,
    amount: "50000.00",
    reason: "إنجاز جرد سريع",
    status: "APPROVED",
    createdById: 11,
  });
  bonus1Id = b1.insertId;

  const [b2] = await database.insert(schema.employeeSpotBonuses).values({
    employeeId: emp2Id,
    branchId: 2,
    amount: "75000.00",
    reason: "مبيعات استثنائية",
    status: "APPROVED",
    createdById: 12,
  });
  bonus2Id = b2.insertId;

  // 8. Transfers
  const [t1] = await database.insert(schema.employeeTransfers).values({
    employeeId: emp1Id,
    fromBranchId: 1,
    toBranchId: 1,
    fromDepartment: "المبيعات",
    toDepartment: "المحاسبة",
    decisionNumber: "TR-001",
    transferDate: "2026-08-01",
    effectiveDate: "2026-08-01",
    status: "APPROVED",
    createdById: 11,
  });
  transfer1Id = t1.insertId;

  const [t2] = await database.insert(schema.employeeTransfers).values({
    employeeId: emp2Id,
    fromBranchId: 2,
    toBranchId: 2,
    fromDepartment: "الاستقبال",
    toDepartment: "المبيعات",
    decisionNumber: "TR-002",
    transferDate: "2026-08-02",
    effectiveDate: "2026-08-02",
    status: "APPROVED",
    createdById: 12,
  });
  transfer2Id = t2.insertId;

  // 9. Loans
  const [l1] = await database.insert(schema.employeeLoanRequests).values({
    employeeId: emp1Id,
    branchId: 1,
    amount: "200000.00",
    monthlyDeduction: "50000.00",
    installmentsCount: 4,
    status: "APPROVED",
    createdById: 11,
  });
  loan1Id = l1.insertId;

  const [l2] = await database.insert(schema.employeeLoanRequests).values({
    employeeId: emp2Id,
    branchId: 2,
    amount: "150000.00",
    monthlyDeduction: "50000.00",
    installmentsCount: 3,
    status: "APPROVED",
    createdById: 12,
  });
  loan2Id = l2.insertId;

  // 10. Custody
  const [cu1] = await database.insert(schema.employeeCustody).values({
    employeeId: emp1Id,
    branchId: 1,
    itemType: "DEVICE",
    itemName: "حاسوب محمول Dell فرع 1",
    handoverDate: "2026-06-01",
    status: "HELD",
    createdById: 11,
  });
  custody1Id = cu1.insertId;

  const [cu2] = await database.insert(schema.employeeCustody).values({
    employeeId: emp2Id,
    branchId: 2,
    itemType: "DEVICE",
    itemName: "طابعة باركود فرع 2",
    handoverDate: "2026-06-02",
    status: "HELD",
    createdById: 12,
  });
  custody2Id = cu2.insertId;
}

function createCaller(user: { id: number; role: string; branchId: number | null; isOwner?: boolean }) {
  const context = {
    req: { headers: {} },
    res: { cookie() {}, clearCookie() {} },
    sessionId: null,
    platformAdmin: null,
    user,
  } as unknown as TrpcContext;
  return hrEnterpriseRouter.createCaller(context);
}

describe("GAP-06: Enterprise HR Router Branch Isolation & Layering", () => {
  beforeEach(async () => {
    await resetDb();
    await seedData();
  });

  // ——————————————————————————————————————————————————————————
  // 1. Branch Isolation: Branch 1 Manager CANNOT see Branch 2 Employee
  // ——————————————————————————————————————————————————————————
  describe("Branch 1 Manager querying Branch 2 Employee (Cross-branch leak prevention)", () => {
    it("returns empty list [] when querying Branch 2 employee documents", async () => {
      const b1Caller = createCaller({ id: 11, role: "manager", branchId: 1 });
      const docs = await b1Caller.documents.list({ employeeId: emp2Id });
      expect(docs).toEqual([]);
    });

    it("returns null when attempting to get a Branch 2 employee document by ID", async () => {
      const b1Caller = createCaller({ id: 11, role: "manager", branchId: 1 });
      const doc = await b1Caller.documents.get({ id: doc2Id });
      expect(doc).toBeNull();
    });

    it("filters out Branch 2 documents from expiring documents alerts", async () => {
      const b1Caller = createCaller({ id: 11, role: "manager", branchId: 1 });
      const alerts = await b1Caller.documents.expiryAlerts({ withinDays: 30 });
      expect(alerts.every((a) => a.employeeId === emp1Id)).toBe(true);
      expect(alerts.some((a) => a.employeeId === emp2Id)).toBe(false);
    });

    it("returns empty list [] when querying Branch 2 employee penalties", async () => {
      const b1Caller = createCaller({ id: 11, role: "manager", branchId: 1 });
      const penalties = await b1Caller.penalties.list({ employeeId: emp2Id });
      expect(penalties).toEqual([]);
    });

    it("returns empty list [] when querying Branch 2 employee contracts", async () => {
      const b1Caller = createCaller({ id: 11, role: "manager", branchId: 1 });
      const contracts = await b1Caller.contracts.list({ employeeId: emp2Id });
      expect(contracts).toEqual([]);
    });

    it("filters out Branch 2 contracts from probation alerts", async () => {
      const b1Caller = createCaller({ id: 11, role: "manager", branchId: 1 });
      const alerts = await b1Caller.contracts.probationAlerts({ withinDays: 30 });
      expect(alerts.every((a) => a.employeeId === emp1Id)).toBe(true);
      expect(alerts.some((a) => a.employeeId === emp2Id)).toBe(false);
    });

    it("returns empty list [] when querying Branch 2 employee spot bonuses", async () => {
      const b1Caller = createCaller({ id: 11, role: "manager", branchId: 1 });
      const bonuses = await b1Caller.spotBonuses.list({ employeeId: emp2Id });
      expect(bonuses).toEqual([]);
    });

    it("returns empty list [] when querying Branch 2 employee transfers", async () => {
      const b1Caller = createCaller({ id: 11, role: "manager", branchId: 1 });
      const transfers = await b1Caller.transfers.list({ employeeId: emp2Id });
      expect(transfers).toEqual([]);
    });

    it("returns empty list [] when querying Branch 2 employee loans", async () => {
      const b1Caller = createCaller({ id: 11, role: "manager", branchId: 1 });
      const loans = await b1Caller.loans.list({ employeeId: emp2Id });
      expect(loans).toEqual([]);
    });

    it("returns empty list [] when querying Branch 2 employee custody", async () => {
      const b1Caller = createCaller({ id: 11, role: "manager", branchId: 1 });
      const custody = await b1Caller.custody.list({ employeeId: emp2Id });
      expect(custody).toEqual([]);
    });

    it("rejects leave encashment preview for Branch 2 employee with NOT_FOUND", async () => {
      const b1Caller = createCaller({ id: 11, role: "manager", branchId: 1 });
      await expect(
        b1Caller.leaveEncashment.preview({ employeeId: emp2Id }),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });
  });

  // ——————————————————————————————————————————————————————————
  // 2. Branch 1 Manager querying Branch 1 Employee (Authorized access)
  // ——————————————————————————————————————————————————————————
  describe("Branch 1 Manager querying Branch 1 Employee (Authorized branch access)", () => {
    it("successfully retrieves Branch 1 employee records across all endpoints", async () => {
      const b1Caller = createCaller({ id: 11, role: "manager", branchId: 1 });

      const docs = await b1Caller.documents.list({ employeeId: emp1Id });
      expect(docs.length).toBeGreaterThanOrEqual(1);
      expect(docs[0].title).toBe("تصريح عمل فرع 1");

      const doc = await b1Caller.documents.get({ id: doc1Id });
      expect(doc).not.toBeNull();
      expect(doc?.id).toBe(doc1Id);

      const penalties = await b1Caller.penalties.list({ employeeId: emp1Id });
      expect(penalties.length).toBeGreaterThanOrEqual(1);
      expect(penalties[0].decisionNumber).toBe("PEN-001");

      const contracts = await b1Caller.contracts.list({ employeeId: emp1Id });
      expect(contracts.length).toBeGreaterThanOrEqual(1);
      expect(contracts[0].contractNumber).toBe("CON-001");

      const bonuses = await b1Caller.spotBonuses.list({ employeeId: emp1Id });
      expect(bonuses.length).toBeGreaterThanOrEqual(1);
      expect(bonuses[0].reason).toBe("إنجاز جرد سريع");

      const transfers = await b1Caller.transfers.list({ employeeId: emp1Id });
      expect(transfers.length).toBeGreaterThanOrEqual(1);
      expect(transfers[0].decisionNumber).toBe("TR-001");

      const loans = await b1Caller.loans.list({ employeeId: emp1Id });
      expect(loans.length).toBeGreaterThanOrEqual(1);
      expect(loans[0].amount).toBe("200000.00");

      const custody = await b1Caller.custody.list({ employeeId: emp1Id });
      expect(custody.length).toBeGreaterThanOrEqual(1);
      expect(custody[0].itemName).toBe("حاسوب محمول Dell فرع 1");

      const encashment = await b1Caller.leaveEncashment.preview({ employeeId: emp1Id });
      expect(encashment.unusedDays).toBe(15);
      // gross: 1200000 + 300000 = 1500000. dailyRate = 1500000 / 30 = 50000. encashment = 50000 * 15 = 750000
      expect(Number(encashment.dailyWage)).toBe(50000);
      expect(Number(encashment.encashmentAmount)).toBe(750000);
    });
  });

  // ——————————————————————————————————————————————————————————
  // 3. General Manager / Admin has Cross-Branch Visibility
  // ——————————————————————————————————————————————————————————
  describe("General Manager / Admin (Cross-Branch elevated access)", () => {
    it("can see records for both Branch 1 and Branch 2", async () => {
      const gmCaller = createCaller({ id: 10, role: "admin", branchId: null });

      // Documents
      const b1Docs = await gmCaller.documents.list({ employeeId: emp1Id });
      const b2Docs = await gmCaller.documents.list({ employeeId: emp2Id });
      expect(b1Docs.length).toBeGreaterThanOrEqual(1);
      expect(b2Docs.length).toBeGreaterThanOrEqual(1);

      // Penalties
      const b1Penalties = await gmCaller.penalties.list({ employeeId: emp1Id });
      const b2Penalties = await gmCaller.penalties.list({ employeeId: emp2Id });
      expect(b1Penalties.length).toBeGreaterThanOrEqual(1);
      expect(b2Penalties.length).toBeGreaterThanOrEqual(1);

      // Contracts
      const b1Contracts = await gmCaller.contracts.list({ employeeId: emp1Id });
      const b2Contracts = await gmCaller.contracts.list({ employeeId: emp2Id });
      expect(b1Contracts.length).toBeGreaterThanOrEqual(1);
      expect(b2Contracts.length).toBeGreaterThanOrEqual(1);

      // Spot Bonuses
      const b1Bonuses = await gmCaller.spotBonuses.list({ employeeId: emp1Id });
      const b2Bonuses = await gmCaller.spotBonuses.list({ employeeId: emp2Id });
      expect(b1Bonuses.length).toBeGreaterThanOrEqual(1);
      expect(b2Bonuses.length).toBeGreaterThanOrEqual(1);

      // Transfers
      const b1Transfers = await gmCaller.transfers.list({ employeeId: emp1Id });
      const b2Transfers = await gmCaller.transfers.list({ employeeId: emp2Id });
      expect(b1Transfers.length).toBeGreaterThanOrEqual(1);
      expect(b2Transfers.length).toBeGreaterThanOrEqual(1);

      // Loans
      const b1Loans = await gmCaller.loans.list({ employeeId: emp1Id });
      const b2Loans = await gmCaller.loans.list({ employeeId: emp2Id });
      expect(b1Loans.length).toBeGreaterThanOrEqual(1);
      expect(b2Loans.length).toBeGreaterThanOrEqual(1);

      // Custody
      const b1Custody = await gmCaller.custody.list({ employeeId: emp1Id });
      const b2Custody = await gmCaller.custody.list({ employeeId: emp2Id });
      expect(b1Custody.length).toBeGreaterThanOrEqual(1);
      expect(b2Custody.length).toBeGreaterThanOrEqual(1);

      // Leave Encashment Preview
      const b1Encashment = await gmCaller.leaveEncashment.preview({ employeeId: emp1Id });
      const b2Encashment = await gmCaller.leaveEncashment.preview({ employeeId: emp2Id });
      expect(b1Encashment.unusedDays).toBe(15);
      expect(b2Encashment.unusedDays).toBe(20);

      // Alerts include both branches
      const docAlerts = await gmCaller.documents.expiryAlerts({ withinDays: 30 });
      expect(docAlerts.some((a) => a.employeeId === emp1Id)).toBe(true);
      expect(docAlerts.some((a) => a.employeeId === emp2Id)).toBe(true);

      const contractAlerts = await gmCaller.contracts.probationAlerts({ withinDays: 30 });
      expect(contractAlerts.some((a) => a.employeeId === emp1Id)).toBe(true);
      expect(contractAlerts.some((a) => a.employeeId === emp2Id)).toBe(true);
    });
  });

  // ——————————————————————————————————————————————————————————
  // 4. Fail-closed: User without assigned branch is rejected with FORBIDDEN
  // ——————————————————————————————————————————————————————————
  describe("Fail-closed enforcement for unassigned branch users", () => {
    it("rejects non-admin users who lack an assigned branch with FORBIDDEN", async () => {
      const branchlessCaller = createCaller({ id: 13, role: "manager", branchId: null });

      await expect(
        branchlessCaller.documents.list({ employeeId: emp1Id }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
      });

      await expect(
        branchlessCaller.penalties.list({ employeeId: emp1Id }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
      });

      await expect(
        branchlessCaller.leaveEncashment.preview({ employeeId: emp1Id }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
      });

      await expect(
        branchlessCaller.contracts.list({ employeeId: emp1Id }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });
  });

  // ——————————————————————————————————————————————————————————
  // 5. Architectural Layering Verification: Zero getDb in Router
  // ——————————————————————————————————————————————————————————
  describe("Architectural Layering Compliance (CLAUDE.md:26 & GAP-25)", () => {
    it("confirms hrEnterpriseRouter.ts has zero direct getDb() calls and uses branchScopedProcedure", () => {
      const routerFilePath = path.resolve(__dirname, "../../routers/hrEnterpriseRouter.ts");
      const routerSource = fs.readFileSync(routerFilePath, "utf8");

      // 1. Must NOT import or call getDb
      expect(routerSource).not.toMatch(/\bgetDb\b/);

      // 2. Must NOT query database schema directly in router
      expect(routerSource).not.toMatch(/from\(employees\)/);
      expect(routerSource).not.toMatch(/from\(employee\w+\)/);

      // 3. Must use branchScopedProcedure
      expect(routerSource).toContain("branchScopedProcedure.use(requireModule(\"hr\"");
      expect(routerSource).not.toContain("protectedProcedure.use(requireModule(\"hr\"");
    });
  });
});
