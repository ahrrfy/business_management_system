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
import { getActiveLock, unlockLatestPeriod } from "../periodLockService";
import {
  approveMonthClose,
  getCompanyCloseActionReadiness,
  hasMonthEndedInBaghdad,
  listMonthCloseRequests,
  rejectMonthClose,
  requestMonthClose,
} from "../reports/monthCloseRequest";
import { lockBranchMonthCloseGate } from "../reports/monthCloseGate";
import { POSTING_POLICY_HASH } from "../accounting/postingEngine";
import { postEntry } from "../ledgerService";
import { money } from "../money";
import {
  certificateExportRows,
  getMonthCloseCertificate,
  verifyMonthCloseCertificate,
} from "../reports/monthCloseCertificate";
import { createVoucher } from "../voucherService";
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
    "idempotencyKeys",
    "monthCloseCertificateEvidence",
    "monthCloseEvents",
    "monthCloseCertificates",
    "monthCloseSequence",
    "monthCloseRequests",
    "payrollAccountingEvents",
    "payrollObligationAllocations",
    "payrollObligations",
    "payrollRemittanceRequests",
    "payrollItems",
    "payrollRuns",
    "doubleEntrySettings",
    "financialPeriods",
    "journalLines",
    "journalEntries",
    "accountingEntries",
    "receipts",
    "voucherCategories",
    "shifts",
    "employees",
    "branches",
    "users",
  ]);
  const d = db();
  await d.insert(s.users).values([
    {
      id: ADMIN,
      openId: "a",
      name: "المالك",
      role: "admin",
      loginMethod: "local",
    },
    {
      id: MGR,
      openId: "m",
      name: "المدير",
      role: "manager",
      loginMethod: "local",
    },
  ]);
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.voucherCategories).values({
    id: 1,
    name: "مصروف اختبار الإقفال",
    direction: "OUT",
    postingRole: "OPERATING_EXPENSE",
  });
  await d.insert(s.monthCloseSequence).values({
    id: 1,
    status: "READY",
    sequenceStartMonth: MONTH,
    nextRequiredMonth: MONTH,
    version: 1,
    bootstrappedAt: new Date("2026-08-01T00:00:00.000Z"),
    bootstrappedBy: ADMIN,
    bootstrapReason: "Test baseline bootstrap",
    bootstrapReference: "TEST-BOOTSTRAP",
  });
}

async function openShift(branchId: number) {
  await db()
    .insert(s.shifts)
    .values({
      userId: MGR,
      branchId,
      status: "OPEN",
      openedAt: new Date("2026-07-10T09:00:00Z"),
      openGuard: `${MGR}:${branchId}:x`,
      openingBalance: "0",
    });
}

async function req(month = MONTH, by = MGR) {
  await db().update(s.monthCloseSequence).set({ nextRequiredMonth: month });
  return withTx(async (tx) =>
    requestMonthClose(tx, { month, requestedBy: by }),
  );
}

async function rowOf(id: number) {
  const r = await db()
    .select()
    .from(s.monthCloseRequests)
    .where(eq(s.monthCloseRequests.id, id));
  return r[0];
}

beforeEach(reset);

describe("طلب إقفال الشهر واعتماده (ش٥ب)", () => {
  it("٠أ) حدّ الشهر يتبدّل عند 21:00Z (منتصف ليل بغداد) لا منتصف ليل UTC", async () => {
    const beforeBaghdadMidnight = new Date("2026-08-31T20:59:59.999Z");
    const atBaghdadMidnight = new Date("2026-08-31T21:00:00.000Z");

    expect(hasMonthEndedInBaghdad("2026-08", beforeBaghdadMidnight)).toBe(
      false,
    );
    expect(hasMonthEndedInBaghdad("2026-08", atBaghdadMidnight)).toBe(true);
    await db()
      .update(s.monthCloseSequence)
      .set({ nextRequiredMonth: "2026-08" });

    await expect(
      withTx(async (tx) =>
        requestMonthClose(tx, {
          month: "2026-08",
          requestedBy: MGR,
          now: beforeBaghdadMidnight,
        }),
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "لا يُقفَل شهرٌ لم ينتهِ بعد.",
    });
    expect(await db().select().from(s.monthCloseRequests)).toHaveLength(0);

    // عند منتصف ليل بغداد صار آب شهراً منتهياً، رغم أن تاريخ UTC ما يزال 31 آب.
    await expect(
      withTx(async (tx) =>
        requestMonthClose(tx, {
          month: "2026-08",
          requestedBy: MGR,
          now: atBaghdadMidnight,
        }),
      ),
    ).resolves.toMatchObject({ id: expect.any(Number) });

    await expect(
      withTx(async (tx) =>
        requestMonthClose(tx, {
          month: "2026-09",
          requestedBy: MGR,
          now: atBaghdadMidnight,
        }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

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
    try {
      await req();
    } catch (e) {
      caught = e;
    }
    expect(isDupEntry(caught)).toBe(true);
  });

  it("٤) الطالب نفسه يعتمد ⇒ FORBIDDEN (فصل المهام)", async () => {
    const { id } = await req();
    await expect(
      withTx(async (tx) =>
        approveMonthClose(tx, { requestId: id, decidedBy: MGR }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await rowOf(id)).status).toBe("PENDING_APPROVAL");
  });

  it("٥) اعتمادٌ سليم ⇒ يقفل الفترة فعلاً ويربط الطلب بالقفل", async () => {
    const { id } = await req();
    const out = await withTx(async (tx) =>
      approveMonthClose(tx, { requestId: id, decidedBy: ADMIN }),
    );

    const row = await rowOf(id);
    expect(row.status).toBe("APPROVED");
    expect(Number(row.decidedBy)).toBe(ADMIN);
    expect(Number(row.lockedPeriodId)).toBe(out.periodId);
    expect(out.certificateId).toBeGreaterThan(0);

    await withTx(async (tx) => {
      const lock = await getActiveLock(tx);
      expect(lock).not.toBeNull();
      expect(lock!.cutoffDate).toBe("2026-07-31"); // نهاية الشهر
      expect(lock!.closeMonth).toBe(MONTH);
      expect(lock!.closeRevision).toBe(1);
      const certificate = await getMonthCloseCertificate(tx, out.certificateId);
      expect(Number(certificate.row.periodId)).toBe(out.periodId);
      expect(certificate.evidence.length).toBeGreaterThan(0);
      expect(
        new Set(certificate.evidence.map((item) => item.datasetCode)),
      ).toEqual(
        new Set([
          "ACCOUNTING_ENTRIES",
          "JOURNAL",
          "ROLE_BALANCES",
          "WIP_WORK_ORDERS",
          "APPROVAL_READINESS",
          "CLOSE_INTEGRITY",
        ]),
      );
      const verification = await verifyMonthCloseCertificate(
        tx,
        out.certificateId,
      );
      expect(verification).toMatchObject({
        integrity: "VERIFIED",
        lifecycle: "ACTIVE",
      });
      const exportRows = certificateExportRows(
        certificate.row,
        certificate.evidence,
        verification,
      );
      expect(
        exportRows.filter((item) => item.section.startsWith("EVIDENCE_META:")),
      ).toHaveLength(certificate.evidence.length);
      for (const chunk of certificate.evidence) {
        const prefix = `EVIDENCE_DATA:${chunk.datasetCode}:${chunk.chunkNo}`;
        const reconstructed = exportRows
          .filter((item) => item.section.startsWith(prefix))
          .map((item) => item.value)
          .join("");
        expect(reconstructed).toBe(chunk.referenceCanonical);
      }
      expect(exportRows.every((item) => item.value.length <= 30_000)).toBe(
        true,
      );
    });
    const [sequence] = await db().select().from(s.monthCloseSequence);
    expect(sequence).toMatchObject({
      activeThroughMonth: MONTH,
      nextRequiredMonth: "2026-08",
      activePeriodId: out.periodId,
      activeCertificateId: out.certificateId,
      version: 2,
    });
  });

  it("٦) وردية فُتحت **بعد** الطلب ⇒ الاعتماد يفشل (الفحص حيٌّ لا مخزَّن) — حاسم", async () => {
    const { id } = await req();
    await openShift(1); // بين الطلب والاعتماد

    await expect(
      withTx(async (tx) =>
        approveMonthClose(tx, { requestId: id, decidedBy: ADMIN }),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect((await rowOf(id)).status).toBe("PENDING_APPROVAL");
    await withTx(async (tx) => expect(await getActiveLock(tx)).toBeNull()); // لم يُقفَل شيء
  });

  it("٦ب) وردية تُفتَح بالتزامن مع الاعتماد تتسلسل قبله؛ يراها الفحص داخل tx ولا يُقفَل شيء", async () => {
    const { id } = await req();
    let releaseWriter!: () => void;
    let markInserted!: () => void;
    const inserted = new Promise<void>((resolve) => {
      markInserted = resolve;
    });
    const holdWriter = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });

    const writer = withTx(async (tx) => {
      await lockBranchMonthCloseGate(tx, 2);
      await tx.insert(s.shifts).values({
        userId: MGR,
        branchId: 2,
        status: "OPEN",
        // 23:59 Baghdad on 31 July; 23:59Z would already be 1 August locally.
        openedAt: new Date("2026-07-31T20:59:00Z"),
        openGuard: `${MGR}:2:concurrent-close-test`,
        openingBalance: "0",
      });
      markInserted();
      await holdWriter;
    });
    await inserted;

    const approval = withTx(async (tx) =>
      approveMonthClose(tx, { requestId: id, decidedBy: ADMIN }),
    );
    // إن كانت بوابة الشركة غير مشتركة، قد يكتمل الاعتماد بينما كتابة الوردية غير ملتزمة.
    const premature = await Promise.race([
      approval.then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<"blocked">((resolve) =>
        setTimeout(() => resolve("blocked"), 75),
      ),
    ]);
    expect(premature).toBe("blocked");

    releaseWriter();
    await writer;
    await expect(approval).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect((await rowOf(id)).status).toBe("PENDING_APPROVAL");
    await withTx(async (tx) => expect(await getActiveLock(tx)).toBeNull());
  });

  it("٧) رفضٌ بسببٍ ⇒ REJECTED ويحرّر الشهر لطلبٍ جديد", async () => {
    const { id } = await req();
    await withTx(async (tx) =>
      rejectMonthClose(tx, {
        requestId: id,
        decidedBy: ADMIN,
        reason: "بانتظار مطابقة الخزينة",
      }),
    );
    expect((await rowOf(id)).status).toBe("REJECTED");
    // pendingGuard صار NULL ⇒ طلبٌ جديدٌ لنفس الشهر مسموح.
    const again = await req();
    expect(again.id).toBeGreaterThan(id);
  });

  it("٨) رفضٌ بلا سببٍ كافٍ ⇒ يُرفض", async () => {
    const { id } = await req();
    await expect(
      withTx(async (tx) =>
        rejectMonthClose(tx, { requestId: id, decidedBy: ADMIN, reason: "لا" }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("٩) اعتماد طلبٍ محسومٍ مسبقاً ⇒ يُرفض (لا قفلَ مزدوج)", async () => {
    const { id } = await req();
    await withTx(async (tx) =>
      approveMonthClose(tx, { requestId: id, decidedBy: ADMIN }),
    );
    await expect(
      withTx(async (tx) =>
        approveMonthClose(tx, { requestId: id, decidedBy: ADMIN }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("١٠) وردية مفتوحة في **فرعٍ آخر** تحجب الطلب — القفل عامّ فالجاهزية عامّة — حاسم", async () => {
    await openShift(2); // فرع المبيعات، والطالب مدير الرئيسي
    await expect(req()).rejects.toThrow(TRPCError);
    expect(await db().select().from(s.monthCloseRequests)).toHaveLength(0);
  });

  it("١١) بعد التزام الإقفال لا يُنشأ سند معلّق بأثر رجعي داخل الشهر المقفَل", async () => {
    const { id } = await req();
    await withTx(async (tx) =>
      approveMonthClose(tx, { requestId: id, decidedBy: ADMIN }),
    );

    await expect(
      createVoucher(
        {
          voucherType: "PAYMENT",
          branchId: 1,
          amount: "2000000.00",
          paymentMethod: "TRANSFER",
          partyType: "OTHER",
          voucherCategoryId: 1,
          counterpartyName: "طرف اختبار",
          description: "سند رجعي بعد الإقفال",
          referenceNumber: "MONTH-CLOSE-RACE-1",
          voucherDate: "2026-07-15",
          clientRequestId: "month-close-backdated-pending",
        },
        { userId: MGR, branchId: 1, role: "manager" },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("١٢) فتح الشهر يفصل الاعتماد التاريخي عن القفل الحي ويسمح بطلبٍ وإقفالٍ جديدين", async () => {
    const first = await req();
    const firstClose = await withTx(async (tx) =>
      approveMonthClose(tx, { requestId: first.id, decidedBy: ADMIN }),
    );

    let listed = await withTx(async (tx) => listMonthCloseRequests(tx));
    expect(listed.find((r) => r.id === first.id)).toMatchObject({
      status: "APPROVED",
      locked: true,
    });

    // pendingGuard تحرّر عند الاعتماد، لكن القفل الحي يظلّ الحارس المالي: لا طلب عالق قبل الفتح.
    await expect(req()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await db().select().from(s.monthCloseRequests)).toHaveLength(1);

    await withTx(async (tx) =>
      unlockLatestPeriod(tx, {
        expectedPeriodId: firstClose.periodId,
        actorId: ADMIN,
        reason: "Reopen month for corrected close test",
      }),
    );
    listed = await withTx(async (tx) => listMonthCloseRequests(tx));
    expect(listed.find((r) => r.id === first.id)).toMatchObject({
      status: "APPROVED",
      lockedPeriodId: firstClose.periodId,
      locked: false,
    });

    const second = await req();
    const secondClose = await withTx(async (tx) =>
      approveMonthClose(tx, { requestId: second.id, decidedBy: ADMIN }),
    );
    expect(secondClose.periodId).not.toBe(firstClose.periodId);
    expect(secondClose.revision).toBe(2);

    await withTx(async (tx) => {
      await expect(
        verifyMonthCloseCertificate(tx, firstClose.certificateId),
      ).resolves.toMatchObject({
        integrity: "VERIFIED",
        lifecycle: "SUPERSEDED",
      });
      await expect(
        verifyMonthCloseCertificate(tx, secondClose.certificateId),
      ).resolves.toMatchObject({
        integrity: "VERIFIED",
        lifecycle: "ACTIVE",
      });
    });

    listed = await withTx(async (tx) => listMonthCloseRequests(tx));
    expect(listed.find((r) => r.id === second.id)).toMatchObject({
      status: "APPROVED",
      locked: true,
    });
    expect(listed.find((r) => r.id === first.id)).toMatchObject({
      status: "APPROVED",
      locked: false,
    });
  });

  it("١٣) جاهزية فعل الإقفال تفحص الشركة كلها ولا تسرّب تفاصيل الفرع الحاجز", async () => {
    await openShift(2);
    const action = await withTx((tx) =>
      getCompanyCloseActionReadiness(tx, MONTH),
    );

    expect(action).toEqual({ month: MONTH, blocked: true });
    expect(Object.keys(action).sort()).toEqual(["blocked", "month"]);
  });

  it("١٤) ديسمبر في ACTIVE لا يُقفَل خارج مسار الإقفال السنوي", async () => {
    const cycleId = "december-active-cycle";
    const openingHash = "b".repeat(64);
    await db()
      .insert(s.doubleEntrySettings)
      .values({
        id: 1,
        mode: "ACTIVE",
        shadowCycleId: cycleId,
        shadowOpeningHash: openingHash,
        policyApprovalReference: "DECEMBER-ACTIVE-TEST",
        policyApprovalPolicyHash: POSTING_POLICY_HASH,
        policyApprovalCycleId: cycleId,
        policyApprovalOpeningHash: openingHash,
        policyAccountantName: "Test accountant",
        policyApprovedAt: new Date("2025-12-31T00:00:00.000Z"),
        policyApprovedBy: ADMIN,
        updatedBy: ADMIN,
      });
    const december = await req("2025-12");

    await expect(
      withTx((tx) =>
        approveMonthClose(tx, { requestId: december.id, decidedBy: ADMIN }),
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "إقفال ديسمبر في وضع ACTIVE يتم حصراً من شاشة الإقفال السنوي بعد ترحيل قيد الإقفال.",
    });
    expect((await rowOf(december.id)).status).toBe("PENDING_APPROVAL");
    await withTx(async (tx) => expect(await getActiveLock(tx)).toBeNull());
  });

  it("١٥) لا يُطلب إقفال شهر فيه موظف مستحق بلا اعتماد استحقاق الرواتب", async () => {
    await db().insert(s.employees).values({
      id: 40,
      branchId: 2,
      firstName: "موظف",
      lastName: "إقفال",
      isActive: true,
      employmentStatus: "active",
      hireDate: "2026-01-01",
    });
    await expect(req()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("استحقاق الرواتب الشهري"),
    });
    expect(await db().select().from(s.monthCloseRequests)).toHaveLength(0);

    await db()
      .insert(s.payrollRuns)
      .values({
        id: 40,
        period: MONTH,
        status: "approved",
        employeeCount: 1,
        totalGross: "0",
        totalNet: "0",
        accrualDate: "2026-07-31",
        revisionNo: 0,
        legalPolicyHash: "a".repeat(64),
        approvalSnapshotHash: "b".repeat(64),
      });
    await db()
      .insert(s.payrollItems)
      .values({
        runId: 40,
        employeeId: 40,
        revisionNo: 0,
        payType: "monthly",
        snapshotHash: "c".repeat(64),
      });
    await expect(req()).resolves.toMatchObject({ id: expect.any(Number) });
  });

  it("ACTIVE blocks a monthly certificate when a source is missing or unreconstructable", async () => {
    await withTx((tx) =>
      postEntry(tx, {
        entryType: "ADJUST",
        branchId: null,
        amount: money(0),
        entryDate: new Date("2026-07-20T00:00:00.000Z"),
        dedupeKey: "MONTH-CLOSE:UNMAPPED-SOURCE",
      }),
    );
    const { id } = await req();
    const cycleId = "month-close-active-cycle";
    const openingHash = "a".repeat(64);
    await db()
      .update(s.doubleEntrySettings)
      .set({
        mode: "ACTIVE",
        shadowCycleId: cycleId,
        shadowOpeningHash: openingHash,
        policyApprovalReference: "MONTH-CLOSE-ACTIVE-TEST",
        policyApprovalPolicyHash: POSTING_POLICY_HASH,
        policyApprovalCycleId: cycleId,
        policyApprovalOpeningHash: openingHash,
        policyAccountantName: "Test accountant",
        policyApprovedAt: new Date("2026-07-31T00:00:00.000Z"),
        policyApprovedBy: ADMIN,
        updatedBy: ADMIN,
      });
    await db()
      .update(s.accountingEntries)
      .set({ postingCycleId: cycleId })
      .where(eq(s.accountingEntries.dedupeKey, "MONTH-CLOSE:UNMAPPED-SOURCE"));

    await expect(
      withTx((tx) =>
        approveMonthClose(tx, { requestId: id, decidedBy: ADMIN }),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await rowOf(id)).status).toBe("PENDING_APPROVAL");
    await withTx(async (tx) => expect(await getActiveLock(tx)).toBeNull());
  });
});
