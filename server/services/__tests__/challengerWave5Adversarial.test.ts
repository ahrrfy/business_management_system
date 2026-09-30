import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { syncDocumentExpiry, listEmployeeDocuments } from "../employeeDocumentService";
import {
  assignEmployeeCustody,
  returnEmployeeCustody,
} from "../employeeCustodyService";

async function seedEmp(opts: {
  branchId?: number;
  branchName?: string;
  employeeId?: number;
} = {}) {
  const db = getDb();
  if (!db) throw new Error("Database not connected");
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  const branchId = opts.branchId ?? 701;
  const employeeId = opts.employeeId ?? 7701;

  await db.insert(s.branches).values({
    id: branchId,
    name: opts.branchName ?? "فرع التحدي التجريبي",
    code: `B-${branchId}`,
    type: "SALES",
  }).onDuplicateKeyUpdate({ set: { name: opts.branchName ?? "فرع التحدي التجريبي" } });

  await db.insert(s.employees).values({
    id: employeeId,
    branchId,
    firstName: "سجاد",
    lastName: "التحدي",
    department: "المستودع",
    position: "أمين مخزن",
    salary: "900000.00",
    allowances: "0.00",
    employmentStatus: "active",
    payType: "monthly",
  }).onDuplicateKeyUpdate({
    set: {
      branchId,
      employmentStatus: "active",
    },
  });

  return { db, branchId, employeeId };
}

describe("Empirical Challenger Wave 5 — GAP-20 & GAP-19 Verification", () => {
  // =========================================================================
  // GAP-20: Document Expiry Synchronization
  // =========================================================================
  describe("GAP-20: Document Expiry Synchronization", () => {
    it("Step 1-5: past expiry becomes EXPIRED, idempotent, future remains ACTIVE", async () => {
      const { db, employeeId } = await seedEmp({ employeeId: 7701, branchId: 701 });

      // Clean up previous documents
      await db.delete(s.employeeDocuments).where(eq(s.employeeDocuments.employeeId, employeeId));

      // 1. Insert document with expiryDate = "2025-01-01" and status = "ACTIVE"
      const [docExpiredRes] = await db.insert(s.employeeDocuments).values({
        employeeId,
        documentType: "NATIONAL_ID",
        title: "بطاقة وطنية منتهية",
        expiryDate: "2025-01-01",
        status: "ACTIVE",
      });
      const expiredDocId = docExpiredRes.insertId;

      // 2. Call syncDocumentExpiry()
      const sync1 = await syncDocumentExpiry();
      expect(sync1.updatedCount).toBeGreaterThanOrEqual(1);

      // 3. Query DB directly: verify status is now "EXPIRED"
      const [docExpiredInDb] = await db
        .select()
        .from(s.employeeDocuments)
        .where(eq(s.employeeDocuments.id, expiredDocId));
      expect(docExpiredInDb.status).toBe("EXPIRED");

      // 4. Call syncDocumentExpiry() again: verify idempotency (updatedCount: 0)
      const sync2 = await syncDocumentExpiry();
      expect(sync2.updatedCount).toBe(0);

      // 5. Insert document with future expiry (2030-01-01): verify it remains "ACTIVE"
      const [docFutureRes] = await db.insert(s.employeeDocuments).values({
        employeeId,
        documentType: "PASSPORT",
        title: "جواز سفر ساري المفعول",
        expiryDate: "2030-01-01",
        status: "ACTIVE",
      });
      const futureDocId = docFutureRes.insertId;

      // Run sync again
      const sync3 = await syncDocumentExpiry();
      expect(sync3.updatedCount).toBe(0);

      // Verify future doc in DB remains ACTIVE
      const [docFutureInDb] = await db
        .select()
        .from(s.employeeDocuments)
        .where(eq(s.employeeDocuments.id, futureDocId));
      expect(docFutureInDb.status).toBe("ACTIVE");
    });

    it("Adversarial: document with null expiryDate remains ACTIVE and is never set to EXPIRED", async () => {
      const { db, employeeId } = await seedEmp({ employeeId: 7702, branchId: 701 });

      const [res] = await db.insert(s.employeeDocuments).values({
        employeeId,
        documentType: "EDUCATION_CERTIFICATE",
        title: "شهادة تخرج دائمة بلا انتهاء",
        expiryDate: null,
        status: "ACTIVE",
      });

      const syncRes = await syncDocumentExpiry();
      const [doc] = await db
        .select()
        .from(s.employeeDocuments)
        .where(eq(s.employeeDocuments.id, res.insertId));
      expect(doc.status).toBe("ACTIVE");
    });

    it("Adversarial: listEmployeeDocuments automatically synchronizes expired documents", async () => {
      const { db, employeeId, branchId } = await seedEmp({ employeeId: 7703, branchId: 701 });

      const [res] = await db.insert(s.employeeDocuments).values({
        employeeId,
        documentType: "WORK_PERMIT",
        title: "إجازة سوق قديمة",
        expiryDate: "2024-06-01",
        status: "ACTIVE",
      });

      // Calling listEmployeeDocuments should sync automatically
      const docs = await listEmployeeDocuments(employeeId, branchId);
      const matched = docs.find((d) => d.id === res.insertId);
      expect(matched).toBeDefined();
      expect(matched!.status).toBe("EXPIRED");
      expect(matched!.calculatedStatus).toBe("EXPIRED");

      // Verify in DB directly
      const [docInDb] = await db
        .select()
        .from(s.employeeDocuments)
        .where(eq(s.employeeDocuments.id, res.insertId));
      expect(docInDb.status).toBe("EXPIRED");
    });
  });

  // =========================================================================
  // GAP-19: Custody Loss / Damage Financial Flow
  // =========================================================================
  describe("GAP-19: Custody Loss / Damage Financial Flow", () => {
    it("Damaged custody with damageAmount = 45000 creates balanced accounting entry and active employee advance", async () => {
      const { db, employeeId, branchId } = await seedEmp({ employeeId: 7704, branchId: 701 });
      const actor = { userId: 1, role: "admin", branchId } as any;

      // Hand over custody item
      const res = await assignEmployeeCustody(actor, {
        employeeId,
        itemType: "TOOL",
        itemName: "ماكينة قص ورق كهربائية",
        handoverDate: "2026-06-01",
      });
      const custodyId = res.id;

      // Return custody item as DAMAGED with damageAmount = 45000
      const ret = await returnEmployeeCustody(actor, {
        id: custodyId,
        actualReturnDate: "2026-06-15",
        conditionAtReturn: "كسر في نصل القص الرئيسي",
        returnNotes: "تلف بسبب سوء استخدام المشغل",
        status: "DAMAGED",
        damageAmount: "45000",
      });

      expect(ret.status).toBe("DAMAGED");
      expect(ret.accountingEntryId).toBeTypeOf("number");
      expect(ret.advanceId).toBeTypeOf("number");

      // 1. Query accountingEntries where dedupeKey = `CUSTODY_LOSS:<id>`
      const [entry] = await db
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.dedupeKey, `CUSTODY_LOSS:${custodyId}`));

      expect(entry).toBeDefined();
      expect(entry.id).toBe(ret.accountingEntryId);
      expect(entry.entryType).toBe("ADJUST");
      expect(entry.dedupeKey).toBe(`CUSTODY_LOSS:${custodyId}`);
      expect(Number(entry.amount)).toBe(45000);
      expect(entry.notes).toContain("تعويض عهدة تالفة");

      // Check double-entry journal balance if journal lines exist
      const journalEntry = await db
        .select()
        .from(s.journalEntries)
        .where(eq(s.journalEntries.entryId, entry.id))
        .limit(1);

      if (journalEntry.length > 0) {
        const lines = await db
          .select()
          .from(s.journalLines)
          .where(eq(s.journalLines.journalId, journalEntry[0].id));
        const totalDebit = lines.reduce((sum, l) => sum + Number(l.debit), 0);
        const totalCredit = lines.reduce((sum, l) => sum + Number(l.credit), 0);
        expect(totalDebit).toBe(totalCredit);
        expect(totalDebit).toBe(45000);
      }

      // 2. Query employeeAdvances for employee: verify row created with amount = 45000.00 and status = ACTIVE
      const [adv] = await db
        .select()
        .from(s.employeeAdvances)
        .where(eq(s.employeeAdvances.id, ret.advanceId!));

      expect(adv).toBeDefined();
      expect(adv.employeeId).toBe(employeeId);
      expect(adv.status).toBe("ACTIVE");
      expect(Number(adv.amount)).toBe(45000);
      expect(Number(adv.remaining)).toBe(45000);
      expect(adv.note).toContain("تعويض عهدة تالفة");
    });

    it("Backward compatibility: returning DAMAGED with 0 or null damageAmount creates NO accounting entry or advance", async () => {
      const { db, employeeId, branchId } = await seedEmp({ employeeId: 7705, branchId: 701 });
      const actor = { userId: 1, role: "admin", branchId } as any;

      // 1. Test with damageAmount = 0
      const res1 = await assignEmployeeCustody(actor, {
        employeeId,
        itemType: "DEVICE",
        itemName: "شاحن بطارية",
        handoverDate: "2026-06-01",
      });

      const ret1 = await returnEmployeeCustody(actor, {
        id: res1.id,
        actualReturnDate: "2026-06-16",
        status: "DAMAGED",
        damageAmount: "0",
      });

      expect(ret1.status).toBe("DAMAGED");
      expect(ret1.accountingEntryId).toBeNull();
      expect(ret1.advanceId).toBeNull();

      // Verify no accounting entry
      const entries1 = await db
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.dedupeKey, `CUSTODY_LOSS:${res1.id}`));
      expect(entries1.length).toBe(0);

      // 2. Test with damageAmount = null / undefined
      const res2 = await assignEmployeeCustody(actor, {
        employeeId,
        itemType: "KEY",
        itemName: "مفتاح الباب الجانبي",
        handoverDate: "2026-06-01",
      });

      const ret2 = await returnEmployeeCustody(actor, {
        id: res2.id,
        actualReturnDate: "2026-06-16",
        status: "DAMAGED",
        damageAmount: null,
      });

      expect(ret2.status).toBe("DAMAGED");
      expect(ret2.accountingEntryId).toBeNull();
      expect(ret2.advanceId).toBeNull();

      const entries2 = await db
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.dedupeKey, `CUSTODY_LOSS:${res2.id}`));
      expect(entries2.length).toBe(0);
    });

    it("Adversarial: LOST custody with damageAmount creates accounting entry and advance", async () => {
      const { db, employeeId, branchId } = await seedEmp({ employeeId: 7706, branchId: 701 });
      const actor = { userId: 1, role: "admin", branchId } as any;

      const res = await assignEmployeeCustody(actor, {
        employeeId,
        itemType: "DEVICE",
        itemName: "قارئ باركود لاسلكي",
        handoverDate: "2026-06-01",
      });

      const ret = await returnEmployeeCustody(actor, {
        id: res.id,
        actualReturnDate: "2026-06-17",
        status: "LOST",
        damageAmount: "120000",
      });

      expect(ret.status).toBe("LOST");
      expect(ret.accountingEntryId).toBeTypeOf("number");
      expect(ret.advanceId).toBeTypeOf("number");

      const [entry] = await db
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.dedupeKey, `CUSTODY_LOSS:${res.id}`));
      expect(entry).toBeDefined();
      expect(Number(entry.amount)).toBe(120000);
      expect(entry.notes).toContain("تعويض عهدة مفقودة");

      const [adv] = await db
        .select()
        .from(s.employeeAdvances)
        .where(eq(s.employeeAdvances.id, ret.advanceId!));
      expect(adv).toBeDefined();
      expect(Number(adv.amount)).toBe(120000);
    });

    it("Adversarial: normal RETURNED custody does NOT create financial entry even if damageAmount is provided", async () => {
      const { db, employeeId, branchId } = await seedEmp({ employeeId: 7707, branchId: 701 });
      const actor = { userId: 1, role: "admin", branchId } as any;

      const res = await assignEmployeeCustody(actor, {
        employeeId,
        itemType: "VEHICLE",
        itemName: "دراجة نارية للتوصيل",
        handoverDate: "2026-06-01",
      });

      const ret = await returnEmployeeCustody(actor, {
        id: res.id,
        actualReturnDate: "2026-06-18",
        status: "RETURNED",
        damageAmount: "50000", // Erroneously supplied for an intact return
      });

      expect(ret.status).toBe("RETURNED");
      expect(ret.accountingEntryId).toBeNull();
      expect(ret.advanceId).toBeNull();

      const entries = await db
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.dedupeKey, `CUSTODY_LOSS:${res.id}`));
      expect(entries.length).toBe(0);
    });

    it("Adversarial: attempting to return already settled custody is rejected with BAD_REQUEST", async () => {
      const { employeeId, branchId } = await seedEmp({ employeeId: 7708, branchId: 701 });
      const actor = { userId: 1, role: "admin", branchId } as any;

      const res = await assignEmployeeCustody(actor, {
        employeeId,
        itemType: "TOOL",
        itemName: "ميزان إلكتروني حساس",
        handoverDate: "2026-06-01",
      });

      // First return succeeds
      await returnEmployeeCustody(actor, {
        id: res.id,
        actualReturnDate: "2026-06-19",
        status: "DAMAGED",
        damageAmount: "30000",
      });

      // Second return on same custody MUST be rejected
      await expect(
        returnEmployeeCustody(actor, {
          id: res.id,
          actualReturnDate: "2026-06-20",
          status: "DAMAGED",
          damageAmount: "30000",
        }),
      ).rejects.toThrow();
    });
  });
});
