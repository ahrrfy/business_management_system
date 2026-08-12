import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  canActivate,
  CURRENT_ENTRY_TYPES,
  REQUIRED_MAPPED_ENTRY_TYPE_COUNT,
} from "../accounting/activationGate";
import {
  activateDoubleEntry,
  startDoubleEntryShadow,
} from "../accounting/doubleEntrySettings";
import { getDoubleEntryMode, writeJournal, writeJournalGap } from "../accounting/journalStore";
import { MAPPED_ENTRY_TYPES, postingLinesFor } from "../accounting/postingEngine";
import { reconcileDoubleEntry } from "../reconcileService";
import { withTx } from "../tx";
import { truncateTables } from "./__testUtils__";

const ADMIN_ID = 1;
const BRANCH_MAIN = 1;
const BRANCH_SALES = 2;
const NOW = new Date("2026-08-31T00:00:00.000Z");
const THIRTY_DAYS_AGO = new Date("2026-08-01T00:00:00.000Z");
const originalMappedTypes = new Set(MAPPED_ENTRY_TYPES);

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

function auditContext(ip = "127.0.0.1") {
  return {
    user: { id: ADMIN_ID, role: "admin", branchId: BRANCH_MAIN },
    req: { headers: {}, ip },
  } as never;
}

async function reset() {
  await truncateTables([
    "auditLogs",
    "journalLines",
    "journalEntries",
    "accountingEntries",
    "doubleEntrySettings",
    "branches",
    "users",
  ]);
  await db().insert(s.users).values({
    id: ADMIN_ID,
    openId: "double-entry-admin",
    name: "المدير العام",
    role: "admin",
    loginMethod: "local",
  });
  await db().insert(s.branches).values([
    { id: BRANCH_MAIN, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: BRANCH_SALES, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  MAPPED_ENTRY_TYPES.clear();
  for (const entryType of originalMappedTypes) MAPPED_ENTRY_TYPES.add(entryType);
}

function makeMappingCoverageComplete() {
  for (const entryType of CURRENT_ENTRY_TYPES) MAPPED_ENTRY_TYPES.add(entryType);
}

async function insertSale(input: {
  branchId?: number;
  entryDate?: string;
  createdAt?: Date;
  amount?: string;
}) {
  const rows = await db()
    .insert(s.accountingEntries)
    .values({
      entryType: "SALE",
      branchId: input.branchId ?? BRANCH_MAIN,
      entryDate: new Date(`${input.entryDate ?? "2026-08-15"}T00:00:00.000Z`),
      amount: input.amount ?? "100.00",
      revenue: input.amount ?? "100.00",
      cost: "0.00",
      profit: input.amount ?? "100.00",
      createdAt: input.createdAt ?? new Date("2026-08-15T12:00:00.000Z"),
    })
    .$returningId();
  return Number(rows[0].id);
}

async function writeSaleJournal(entryId: number, input?: { branchId?: number; entryDate?: string; amount?: string }) {
  await withTx(async (tx) =>
    writeJournal(
      tx,
      entryId,
      new Date(`${input?.entryDate ?? "2026-08-15"}T00:00:00.000Z`),
      input?.branchId ?? BRANCH_MAIN,
      postingLinesFor({ entryType: "SALE", amount: input?.amount ?? "100.00", revenue: input?.amount ?? "100.00" }),
    ),
  );
}

async function seedShadow(startedAt = THIRTY_DAYS_AGO) {
  await db().insert(s.doubleEntrySettings).values({
    id: 1,
    mode: "SHADOW",
    shadowStartedAt: startedAt,
    updatedBy: ADMIN_ID,
  });
}

beforeEach(reset);
afterEach(() => {
  MAPPED_ENTRY_TYPES.clear();
  for (const entryType of originalMappedTypes) MAPPED_ENTRY_TYPES.add(entryType);
});

describe("reconcileDoubleEntry — نطاق الشهر والفرع", () => {
  it("يعزل الشهر والفرع ويعيد انحرافاً صفرياً للقيد المطابق", async () => {
    const inScope = await insertSale({ branchId: BRANCH_MAIN, entryDate: "2026-08-15" });
    await writeSaleJournal(inScope);

    const otherBranch = await insertSale({ branchId: BRANCH_SALES, entryDate: "2026-08-15", amount: "900.00" });
    await writeSaleJournal(otherBranch, { branchId: BRANCH_SALES, amount: "900.00" });
    const otherMonth = await insertSale({ branchId: BRANCH_MAIN, entryDate: "2026-07-31", amount: "700.00" });
    await writeSaleJournal(otherMonth, { entryDate: "2026-07-31", amount: "700.00" });

    const result = await reconcileDoubleEntry({ month: "2026-08", branchId: BRANCH_MAIN });

    expect(result.sourceEntryCount).toBe(1);
    expect(result.journalEntryCount).toBe(1);
    expect(result.gapCount).toBe(0);
    expect(result.missingCount).toBe(0);
    expect(result.drift).toBe("0.00");
    expect(result.ok).toBe(true);
    expect(result.roles).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "AR", expected: "100.00", actual: "100.00", drift: "0.00" }),
      expect.objectContaining({ role: "SALES_STATIONERY", expected: "-100.00", actual: "-100.00", drift: "0.00" }),
    ]));
  });

  it("يكشف السطر المعدّل والحدث المفقود والفجوة بلا إخفاء", async () => {
    const tampered = await insertSale({ amount: "100.00" });
    await writeSaleJournal(tampered);
    await db()
      .update(s.journalLines)
      .set({ credit: "90.00" })
      .where(and(eq(s.journalLines.role, "SALES_STATIONERY"), eq(s.journalLines.credit, "100.00")));

    await insertSale({ amount: "25.00" }); // لا رأس يومية ⇒ حدث مفقود.
    const gapEntry = await insertSale({ amount: "10.00" });
    await withTx(async (tx) =>
      writeJournalGap(tx, gapEntry, new Date("2026-08-15T00:00:00.000Z"), BRANCH_MAIN, "فجوة اختبار"),
    );

    const result = await reconcileDoubleEntry({ month: "2026-08", branchId: BRANCH_MAIN });

    expect(result.sourceEntryCount).toBe(3);
    expect(result.journalEntryCount).toBe(2);
    expect(result.gapCount).toBe(1);
    expect(result.missingCount).toBe(1);
    expect(result.journalImbalance).toBe("10.00");
    expect(result.drift).toBe("80.00");
    expect(result.ok).toBe(false);
  });

  it("يرفض شهراً غير صالح بدل توسيع النطاق صامتاً", async () => {
    await expect(reconcileDoubleEntry({ month: "2026-13", branchId: BRANCH_MAIN }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("canActivate — بوابة ACTIVE", () => {
  it("تقبل حدّ 30 يوماً بالضبط عند صفر فجوات وانحراف و31/31 خريطة", async () => {
    makeMappingCoverageComplete();
    await seedShadow();

    const gate = await canActivate({ now: NOW });

    expect(gate.ok).toBe(true);
    expect(gate.shadowDays).toBe(30);
    expect(gate.mappedTypes).toBe(REQUIRED_MAPPED_ENTRY_TYPE_COUNT);
    expect(gate.unmappedEntryTypes).toEqual([]);
    expect(gate.blockers).toEqual([]);
  });

  it("تحجب قبل 30 يوماً ولو بثانية واحدة", async () => {
    makeMappingCoverageComplete();
    await seedShadow(new Date(NOW.getTime() - 30 * 86_400_000 + 1_000));

    const gate = await canActivate({ now: NOW });

    expect(gate.ok).toBe(false);
    expect(gate.blockers.map((b) => b.key)).toContain("SHADOW_DURATION");
  });

  it("تحجب إذا لم تكن الخرائط 31/31", async () => {
    await seedShadow();
    const gate = await canActivate({ now: NOW });
    expect(gate.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "MAPPING_COVERAGE", actual: originalMappedTypes.size, required: 31 }),
    ]));
  });

  it("تحجب النوع الـ32 اللاحق للخطة ولو اكتملت الأنواع القديمة 31/31", async () => {
    for (const entryType of CURRENT_ENTRY_TYPES) {
      if (entryType !== "DELIVERY_FEE_HELD") MAPPED_ENTRY_TYPES.add(entryType);
    }
    await seedShadow();

    const gate = await canActivate({ now: NOW });

    expect(gate.mappedTypes).toBe(31);
    expect(gate.unmappedEntryTypes).toEqual(["DELIVERY_FEE_HELD"]);
    expect(gate.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "MAPPING_COVERAGE" }),
    ]));
  });

  it("تحجب فجوة أو حدثاً مفقوداً أو انحرافاً في أي فرع خلال نافذة الظل", async () => {
    makeMappingCoverageComplete();
    await seedShadow();

    const drifted = await insertSale({ branchId: BRANCH_SALES, createdAt: new Date("2026-08-10T00:00:00.000Z") });
    await writeSaleJournal(drifted, { branchId: BRANCH_SALES });
    await db().update(s.journalLines).set({ credit: "99.00" }).where(eq(s.journalLines.role, "SALES_STATIONERY"));

    const gapEntry = await insertSale({ createdAt: new Date("2026-08-11T00:00:00.000Z") });
    await withTx(async (tx) =>
      writeJournalGap(tx, gapEntry, new Date("2026-08-11T00:00:00.000Z"), BRANCH_MAIN, "فجوة"),
    );
    await insertSale({ createdAt: new Date("2026-08-12T00:00:00.000Z") });

    const gate = await canActivate({ now: NOW });
    const keys = gate.blockers.map((b) => b.key);
    expect(keys).toEqual(expect.arrayContaining(["UNMAPPED_GAPS", "MISSING_JOURNALS", "RECONCILIATION_DRIFT"]));
  });

  it("تحجب يوميةً مرتبطة بالمصدر لكنها منسوبة إلى فرع مختلف", async () => {
    makeMappingCoverageComplete();
    await seedShadow();
    const entryId = await insertSale({ branchId: BRANCH_MAIN, createdAt: new Date("2026-08-15T12:00:00.000Z") });
    await writeSaleJournal(entryId, { branchId: BRANCH_SALES });

    const gate = await canActivate({ now: NOW });

    expect(gate.scopeMismatchCount).toBe(1);
    expect(gate.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "JOURNAL_SCOPE_MISMATCH" }),
    ]));
  });

  it("تحجب إن لم يكن الوضع SHADOW أو فُقد تاريخ بدايته", async () => {
    await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "OFF", shadowStartedAt: null });
    let gate = await canActivate({ now: NOW });
    expect(gate.blockers.map((b) => b.key)).toEqual(expect.arrayContaining(["MODE", "SHADOW_START"]));

    await db().update(s.doubleEntrySettings).set({ mode: "SHADOW", shadowStartedAt: null }).where(eq(s.doubleEntrySettings.id, 1));
    gate = await canActivate({ now: NOW });
    expect(gate.blockers.map((b) => b.key)).toContain("SHADOW_START");
  });
});

describe("تغيير وضع الدفتر — انتقالات ذرّية مُدقّقة", () => {
  it("OFF → SHADOW فقط: يثبت البداية والفاعل وسجل التدقيق داخل المعاملة", async () => {
    await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "OFF" });

    await withTx(async (tx) =>
      startDoubleEntryShadow(tx, { actorId: ADMIN_ID, now: NOW, auditContext: auditContext() }),
    );

    const settings = (await db().select().from(s.doubleEntrySettings))[0];
    expect(settings.mode).toBe("SHADOW");
    expect(settings.shadowStartedAt?.toISOString()).toBe(NOW.toISOString());
    expect(Number(settings.updatedBy)).toBe(ADMIN_ID);
    const logs = await db().select().from(s.auditLogs);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("doubleEntry.shadow.start");
  });

  it("يمنع تكرار بدء الظل ويمنع OFF → ACTIVE", async () => {
    await seedShadow();
    await expect(withTx(async (tx) =>
      startDoubleEntryShadow(tx, { actorId: ADMIN_ID, now: NOW, auditContext: auditContext() }),
    )).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await db().update(s.doubleEntrySettings).set({ mode: "OFF", shadowStartedAt: null }).where(eq(s.doubleEntrySettings.id, 1));
    await expect(withTx(async (tx) =>
      activateDoubleEntry(tx, { actorId: ADMIN_ID, now: NOW, auditContext: auditContext() }),
    )).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await db().select().from(s.doubleEntrySettings))[0].mode).toBe("OFF");
  });

  it("SHADOW → ACTIVE لا يتم إلا بعد اجتياز البوابة ويُدقَّق", async () => {
    makeMappingCoverageComplete();
    await seedShadow();

    const result = await withTx(async (tx) =>
      activateDoubleEntry(tx, { actorId: ADMIN_ID, now: NOW, auditContext: auditContext() }),
    );

    expect(result.gate.ok).toBe(true);
    expect((await db().select().from(s.doubleEntrySettings))[0].mode).toBe("ACTIVE");
    expect((await db().select().from(s.auditLogs))[0].action).toBe("doubleEntry.activate");
  });

  it("مانعٌ واحد يُرجع محاولة SHADOW → ACTIVE بلا تغييرٍ ولا تدقيق", async () => {
    makeMappingCoverageComplete();
    await seedShadow(new Date(NOW.getTime() - 29 * 86_400_000));

    await expect(withTx(async (tx) =>
      activateDoubleEntry(tx, { actorId: ADMIN_ID, now: NOW, auditContext: auditContext() }),
    )).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect((await db().select().from(s.doubleEntrySettings))[0].mode).toBe("SHADOW");
    expect(await db().select().from(s.auditLogs)).toHaveLength(0);
  });

  it("فشل سجل التدقيق يُرجع تغيير الوضع كله", async () => {
    await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "OFF" });
    const tooLongIp = "x".repeat(200);

    await expect(withTx(async (tx) =>
      startDoubleEntryShadow(tx, { actorId: ADMIN_ID, now: NOW, auditContext: auditContext(tooLongIp) }),
    )).rejects.toBeTruthy();

    expect((await db().select().from(s.doubleEntrySettings))[0].mode).toBe("OFF");
    expect(await db().select().from(s.auditLogs)).toHaveLength(0);
  });

  it("تنتظر ACTIVE معاملة مالية جارية ثم ترى فجوتها قبل القرار", async () => {
    makeMappingCoverageComplete();
    await seedShadow();

    let releaseWriter!: () => void;
    const writerCanCommit = new Promise<void>((resolve) => { releaseWriter = resolve; });
    let writerHasLock!: () => void;
    const writerLocked = new Promise<void>((resolve) => { writerHasLock = resolve; });

    const writer = withTx(async (tx) => {
      expect(await getDoubleEntryMode(tx)).toBe("SHADOW");
      const inserted = await tx
        .insert(s.accountingEntries)
        .values({
          entryType: "SALE",
          branchId: BRANCH_MAIN,
          entryDate: new Date("2026-08-30T00:00:00.000Z"),
          amount: "12.00",
          revenue: "12.00",
          cost: "0.00",
          profit: "12.00",
          createdAt: new Date("2026-08-30T12:00:00.000Z"),
        })
        .$returningId();
      await writeJournalGap(
        tx,
        Number(inserted[0].id),
        new Date("2026-08-30T00:00:00.000Z"),
        BRANCH_MAIN,
        "فجوة متزامنة",
      );
      writerHasLock();
      await writerCanCommit;
    });
    await writerLocked;

    let activationSettled = false;
    const activation = withTx(async (tx) =>
      activateDoubleEntry(tx, { actorId: ADMIN_ID, now: NOW, auditContext: auditContext() }),
    ).finally(() => { activationSettled = true; });

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(activationSettled).toBe(false);

    releaseWriter();
    await writer;
    await expect(activation).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await db().select().from(s.doubleEntrySettings))[0].mode).toBe("SHADOW");
  });
});
