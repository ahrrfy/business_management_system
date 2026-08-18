/**
 * الإقفال السنوي الرسمي للشركة من اليومية المزدوجة.
 * يستهلك طلب إقفال ديسمبر المعلّق بفصل maker/checker، ويعيد فحص الجاهزية تحت أقفال الشركة،
 * ثم يعكس كل رصيد REVENUE/EXPENSE للدورة الحالية إلى الأرباح المحتجزة بقيد 31/12 قبل قفل الفترة.
 * القيد والـsnapshot واعتماد الطلب والقفل ذرّية؛ وأي فشل يرجعها جميعاً.
 */
import { TRPCError } from "@trpc/server";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  accountingEntries,
  accounts,
  doubleEntrySettings,
  financialPeriods,
  journalEntries,
  journalLines,
  monthCloseCertificates,
  monthCloseRequests,
  monthCloseSequence,
  users,
  yearEndReopenRequests,
  yearEndSnapshots,
} from "../../drizzle/schema";
import { extractInsertId } from "../lib/insertId";
import { readInventoryValuation } from "./inventory/valuation";
import type { Tx } from "../db";
import {
  createPostingIntent,
  creditLine,
  debitLine,
  verifyPostingIntentEvidence,
  type AccountRole,
  type JournalLine,
  type PostingSourceComponents,
} from "./accounting/postingEngine";
import { getDoubleEntryRuntime } from "./accounting/journalStore";
import { money, round2, toDbMoney } from "./money";
import { postEntry } from "./ledgerService";
import { lockPeriod } from "./periodLockService";
import { baghdadToday } from "./businessDay";
import { reconcileDoubleEntry } from "./reconcileService";
import { lockCompanyMonthCloseGate } from "./reports/monthCloseGate";
import { createMonthCloseCertificate } from "./reports/monthCloseCertificate";
import { getMonthCloseReadiness } from "./reports/monthCloseReadiness";
import {
  appendMonthCloseEvent,
  advanceMonthCloseSequence,
  assertSequenceReady,
  assertExpectedCloseMonth,
  canonicalCloseJson,
  closeSha256,
  getMonthCloseSequence,
} from "./reports/monthCloseSequence";

const BAGHDAD_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;

export interface CloseYearInput {
  year: number; // مثل 2025
  requestId: number;
  branchId?: number | null; // null = إقفال على مستوى الشركة (مجموع كل الفروع)
  closedBy: number;
}

export interface CloseYearResult {
  snapshotId: number;
  retainedEarningsEntryId: number;
  periodLockId: number;
  certificateId: number;
  certificateNumber: string;
  year: number;
  branchId: number | null;
  totalRevenue: string;
  totalCogs: string;
  totalExpenses: string;
  netProfit: string;
}

export async function closeYear(
  tx: Tx,
  input: CloseYearInput,
): Promise<CloseYearResult> {
  const { year, requestId, closedBy } = input;
  const branchId = input.branchId ?? null;
  if (year < 2020 || year > 2100) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "السنة خارج النطاق المعقول",
    });
  }
  // financialPeriods قفلٌ شركي عام بلا branchId؛ إقفال فرع منفرد ثم قفل الشركة كلها ادعاءٌ كاذب
  // عن نطاق المستند ويعرّض بقية الفروع للإقفال. الإقفال السنوي الرسمي لذلك شركي فقط.
  if (branchId != null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "الإقفال السنوي الرسمي على مستوى الشركة كلها فقط؛ قفل الفترة عام ولا يدعم إقفال فرع منفرد",
    });
  }

  // حارس السنة الجارية/المستقبلية (تدقيق ١٧/٧): إقفال 2026 في منتصفها يضع cutoff=2026-12-31 فيقفل
  // كل قيود البيع/الشراء/الدفع حتى نهاية السنة (assertPeriodOpen) — تعطّل تشغيليّ شامل بنقرة واحدة.
  // السوق عراقي: تنتهي السنة عند منتصف ليل بغداد، لا بعده بثلاث ساعات وفق UTC.
  const currentYear = Number(baghdadToday().slice(0, 4));
  if (year >= currentYear) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `لا يمكن إقفال سنة لم تنتهِ بعد (${year}) — أقصى سنة قابلة للإقفال ${currentYear - 1}`,
    });
  }

  // All current-state reads below are serialized against financial writers.
  await lockCompanyMonthCloseGate(tx);

  // بياناتٌ تاريخية من النسخة القديمة قد تحمل snapshots فرعية؛ لا نخلطها بالإقفال الرسمي الشركي.
  const anyBranch = await tx
    .select({ id: yearEndSnapshots.id })
    .from(yearEndSnapshots)
    .where(
      and(
        eq(yearEndSnapshots.year, year),
        sql`${yearEndSnapshots.branchId} IS NOT NULL`,
      ),
    )
    .limit(1);
  if (anyBranch[0]) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `توجد لقطة إقفال فرعية قديمة لسنة ${year} — صحّحها قبل الإقفال الرسمي على مستوى الشركة`,
    });
  }

  // اللقطة السابقة لا تُعدَّل. إعادة الإقفال مسموحة فقط إذا فُتحت أحدث مراجعة
  // بمسار maker/checker وأنشأ اعتمادها عكساً دفترياً مطابقاً.
  const existing = await tx
    .select()
    .from(yearEndSnapshots)
    .where(
      and(
        eq(yearEndSnapshots.year, year),
        eq(yearEndSnapshots.scopeKey, "COMPANY"),
        sql`${yearEndSnapshots.branchId} IS NULL`,
      ),
    )
    .orderBy(desc(yearEndSnapshots.revision), desc(yearEndSnapshots.id))
    .for("update")
    .limit(1);
  const previousSnapshot = existing[0] ?? null;
  const previousReopen = previousSnapshot
    ? (
        await tx
          .select()
          .from(yearEndReopenRequests)
          .where(
            and(
              eq(yearEndReopenRequests.snapshotId, Number(previousSnapshot.id)),
              eq(yearEndReopenRequests.status, "APPROVED"),
            ),
          )
          .orderBy(desc(yearEndReopenRequests.id))
          .for("update")
          .limit(1)
      )[0]
    : null;
  if (previousSnapshot && !previousReopen) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `السنة ${year} مقفلة بالمراجعة ${previousSnapshot.revision}. يلزم طلب فتح سنوي واعتماده قبل إعادة الإقفال.`,
    });
  }
  if (previousReopen) {
    const [reopenedPeriod] = await tx
      .select({ status: financialPeriods.status })
      .from(financialPeriods)
      .where(eq(financialPeriods.id, Number(previousReopen.periodId)))
      .for("update")
      .limit(1);
    if (
      reopenedPeriod?.status !== "ARCHIVED" ||
      previousReopen.reversalEntryId == null ||
      previousReopen.reopenEventId == null
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "أثر فتح نهاية السنة غير مكتمل (الفترة/العكس/حدث السلسلة)؛ لا يجوز إنشاء مراجعة جديدة.",
      });
    }
  }
  const snapshotRevision = Number(previousSnapshot?.revision ?? 0) + 1;

  // إعدادات الدفتر تُقفل قبل صف الطلب، بنفس ترتيب مسار اعتماد إقفال الشهر، منعاً لانقلاب الأقفال.
  const closingMonth = `${year}-12`;
  const sequence = await getMonthCloseSequence(tx, { forUpdate: true });
  assertExpectedCloseMonth(sequence, closingMonth);

  const [settings] = await tx
    .select({
      mode: doubleEntrySettings.mode,
      cycleId: doubleEntrySettings.shadowCycleId,
      shadowStartedAt: doubleEntrySettings.shadowStartedAt,
    })
    .from(doubleEntrySettings)
    .where(eq(doubleEntrySettings.id, 1))
    .for("update")
    .limit(1);
  // لا نؤجل تحقق tuple/hash إلى postEntry: سنة بصافي صفري قد لا تحتاج قيد إقفال أصلاً،
  // لكنها تبقى عملية رسمية لا يجوز أن تعتمد ديسمبر إن كان ACTIVE نفسه غير موثّق.
  const runtime = await getDoubleEntryRuntime(tx);
  if (
    runtime.mode !== "ACTIVE" ||
    settings?.mode !== "ACTIVE" ||
    !settings.cycleId ||
    !settings.shadowStartedAt ||
    runtime.cycleId !== settings.cycleId
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "الإقفال السنوي الرسمي يتطلب دفتراً مزدوجاً في وضع ACTIVE ودورةً محاسبيةً موثقة",
    });
  }
  const [closeRequest] = await tx
    .select()
    .from(monthCloseRequests)
    .where(eq(monthCloseRequests.id, requestId))
    .for("update")
    .limit(1);
  if (!closeRequest) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "طلب إقفال ديسمبر غير موجود",
    });
  }
  if (
    closeRequest.month !== closingMonth ||
    closeRequest.status !== "PENDING_APPROVAL"
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `يلزم طلب إقفال معلّق لشهر ${closingMonth} نفسه قبل الإقفال السنوي`,
    });
  }
  if (Number(closeRequest.requestedBy) === closedBy) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا يعتمد طالب إقفال ديسمبر طلبه السنوي بنفسه (فصل المهام)",
    });
  }
  if (
    closeRequest.requestedSequenceVersion == null ||
    Number(closeRequest.requestedSequenceVersion) !== sequence.version ||
    closeRequest.closeRevision == null
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "تغير تسلسل الإقفال منذ إنشاء طلب ديسمبر؛ أنشئ طلباً جديداً.",
    });
  }
  if (Number(closeRequest.closeRevision) !== snapshotRevision) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `مراجعة طلب ديسمبر (${closeRequest.closeRevision}) لا تطابق مراجعة السنة التالية المطلوبة (${snapshotRevision}).`,
    });
  }

  // نفس بوابة الشركة التي تحمي الإقفال الشهري، ثم إعادة فحص الحواجز حيّاً تحت أقفال صفوفها.
  const readiness = await getMonthCloseReadiness(
    { month: closingMonth, branchId: null },
    { tx, lockBlockers: true },
  );
  if (readiness.blocked) {
    const blockers = readiness.items
      .filter((item) => item.status === "BLOCK")
      .map((item) => item.label)
      .join(" · ");
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `لا يمكن إقفال السنة ${year} — حواجز ديسمبر قائمة: ${blockers}`,
    });
  }

  const cutoffDate = `${year}-12-31`;
  const yearStartDate = new Date(Date.UTC(year, 0, 1));
  const cutoffDateValue = new Date(Date.UTC(year, 11, 31));

  // لا تكفي مقارنة YYYY-MM-DD: بدء الدورة في ظهر 1/1 يضيّع حركات الصباح، ولقطة الافتتاح
  // لا تحمل P&L كي تعوّضها. الحد هنا هو منتصف ليل بغداد الدقيق (21:00Z من اليوم السابق).
  const requiredCoverageStart = new Date(
    Date.UTC(year, 0, 1) - BAGHDAD_UTC_OFFSET_MS,
  );
  const cycleStartedAt = new Date(settings.shadowStartedAt);
  if (cycleStartedAt.getTime() > requiredCoverageStart.getTime()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `دورة الدفتر الحالية بدأت في ${cycleStartedAt.toISOString()} بعد بداية سنة ${year} في بغداد (${requiredCoverageStart.toISOString()})؛ لا يجوز تخمين أرصدة الإقفال`,
    });
  }

  // الإقفال الرسمي لا يكتفي بعدّ UNMAPPED: كل شهر في السنة والدورة الحالية يجب أن يمرّ
  // بعقد evidence نفسه (مصدر مفقود/زائد، نطاق، hash/profile/lines، وتوازن كل يومية).
  const annualIntegrity = {
    gapCount: 0,
    missingCount: 0,
    extraCount: 0,
    scopeMismatchCount: 0,
    unreconstructableCount: 0,
    sourceMismatchCount: 0,
    imbalancedJournalCount: 0,
    drift: money(0),
    journalImbalance: money(0),
    trialBalanceDifference: money(0),
    ok: true,
  };
  let decemberIntegrity: Awaited<
    ReturnType<typeof reconcileDoubleEntry>
  > | null = null;
  for (let monthNumber = 1; monthNumber <= 12; monthNumber += 1) {
    const month = `${year}-${String(monthNumber).padStart(2, "0")}`;
    const reconciliation = await reconcileDoubleEntry(
      { month, branchId: null },
      { tx },
    );
    if (monthNumber === 12) decemberIntegrity = reconciliation;
    const trialBalanceDifference = round2(
      reconciliation.roles.reduce(
        (sum, role) => sum.plus(money(role.actual)),
        money(0),
      ),
    );
    annualIntegrity.gapCount += reconciliation.gapCount;
    annualIntegrity.missingCount += reconciliation.missingCount;
    annualIntegrity.extraCount += reconciliation.extraCount;
    annualIntegrity.scopeMismatchCount += reconciliation.scopeMismatchCount;
    annualIntegrity.unreconstructableCount +=
      reconciliation.unreconstructableCount;
    annualIntegrity.sourceMismatchCount += reconciliation.sourceMismatchCount;
    annualIntegrity.imbalancedJournalCount +=
      reconciliation.imbalancedJournalCount;
    annualIntegrity.drift = annualIntegrity.drift.plus(
      money(reconciliation.drift),
    );
    annualIntegrity.journalImbalance = annualIntegrity.journalImbalance.plus(
      money(reconciliation.journalImbalance),
    );
    annualIntegrity.trialBalanceDifference =
      annualIntegrity.trialBalanceDifference.plus(trialBalanceDifference);
    annualIntegrity.ok =
      annualIntegrity.ok &&
      reconciliation.ok &&
      trialBalanceDifference.isZero();
  }
  annualIntegrity.drift = round2(annualIntegrity.drift);
  annualIntegrity.journalImbalance = round2(annualIntegrity.journalImbalance);
  annualIntegrity.trialBalanceDifference = round2(
    annualIntegrity.trialBalanceDifference,
  );
  if (!annualIntegrity.ok) {
    const details = [
      `فجوات=${annualIntegrity.gapCount}`,
      `مصادر مفقودة=${annualIntegrity.missingCount}`,
      `يوميات زائدة=${annualIntegrity.extraCount}`,
      `اختلاف نطاق=${annualIntegrity.scopeMismatchCount}`,
      `دليل غير قابل للتحقق=${annualIntegrity.unreconstructableCount}`,
      `اختلاف دليل المصدر=${annualIntegrity.sourceMismatchCount}`,
      `يوميات غير متوازنة/فارغة=${annualIntegrity.imbalancedJournalCount}`,
      `انحراف الأدوار=${annualIntegrity.drift.toFixed(2)}`,
      `اختلال اليوميات=${annualIntegrity.journalImbalance.toFixed(2)}`,
    ];
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `لا يمكن إقفال ${year}: سلامة اليومية المزدوجة للدورة الحالية لم تمر (${details.join("، ")})`,
    });
  }

  // إن كان ديسمبر مقفلاً مسبقاً، يجب فتحه أولاً: قيد الإقفال نفسه مؤرّخ 31/12 ويجب أن يسبق القفل.
  const [existingCovering] = await tx
    .select({
      id: financialPeriods.id,
      cutoffDate: financialPeriods.cutoffDate,
    })
    .from(financialPeriods)
    .where(
      and(
        eq(financialPeriods.status, "LOCKED"),
        gte(financialPeriods.cutoffDate, cutoffDate),
      ),
    )
    .limit(1);
  if (existingCovering) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `الفترة مقفلة حتى ${existingCovering.cutoffDate}؛ افتح ديسمبر مؤقتاً لترحيل قيد إقفال السنة ثم أعد الإقفال`,
    });
  }

  // ٢. أرصدة P&L الرسمية من اليومية المزدوجة للدورة الحالية فقط. قيد إقفال سابق لا يدخل وعاءه.
  const balances = await tx
    .select({
      role: journalLines.role,
      accountType: accounts.type,
      balance: sql<string>`COALESCE(SUM(${journalLines.debit} - ${journalLines.credit}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalId))
    .innerJoin(accounts, eq(accounts.systemRole, journalLines.role))
    .where(
      and(
        eq(journalEntries.cycleId, settings.cycleId),
        eq(journalEntries.sourceType, "ACCOUNTING_ENTRY"),
        eq(journalEntries.status, "POSTED"),
        gte(journalEntries.entryDate, yearStartDate),
        lte(journalEntries.entryDate, cutoffDateValue),
        inArray(accounts.type, ["REVENUE", "EXPENSE"]),
        or(
          isNull(journalEntries.postingProfile),
          ne(journalEntries.postingProfile, "ADJUST_YEAR_CLOSE"),
        ),
      ),
    )
    .groupBy(journalLines.role, accounts.type);
  let revenue = money(0);
  let cogs = money(0);
  let expenses = money(0);
  const closingLines: JournalLine[] = [];
  const closingRoleDebits: Partial<Record<AccountRole, string>> = {};
  const closingRoleCredits: Partial<Record<AccountRole, string>> = {};
  for (const row of balances) {
    const role = row.role as AccountRole;
    const balance = round2(money(row.balance)); // مدين − دائن
    if (row.accountType === "REVENUE") revenue = revenue.minus(balance);
    else if (role === "COGS") cogs = cogs.plus(balance);
    else expenses = expenses.plus(balance);

    // عكس رصيد كل حساب P&L إلى الصفر، لا تجميعٌ مبهم في حساب وسيط.
    if (balance.gt(0)) {
      closingLines.push(creditLine(role, balance));
      closingRoleCredits[role] = toDbMoney(balance);
    } else if (balance.lt(0)) {
      closingLines.push(debitLine(role, balance.abs()));
      closingRoleDebits[role] = toDbMoney(balance.abs());
    }
  }
  revenue = round2(revenue);
  cogs = round2(cogs);
  expenses = round2(expenses);
  const netProfit = round2(revenue.minus(cogs).minus(expenses));
  if (netProfit.gt(0)) {
    closingLines.push(creditLine("RETAINED_EARNINGS", netProfit));
    closingRoleCredits.RETAINED_EARNINGS = toDbMoney(netProfit);
  } else if (netProfit.lt(0)) {
    closingLines.push(debitLine("RETAINED_EARNINGS", netProfit.abs()));
    closingRoleDebits.RETAINED_EARNINGS = toDbMoney(netProfit.abs());
  }
  // هذه المكونات مشتقة من أرصدة المصدر أعلاه، لا من closingLines؛ تمريرها في الموضعين
  // يثبت أن intent المختوم وحقائق المصدر المستقلة متطابقان في ACTIVE.
  const postingSourceComponents: PostingSourceComponents = {
    roleDebits: closingRoleDebits,
    roleCredits: closingRoleCredits,
  };

  // ٣. رحّل قيد الإقفال الصفري في الدفتر المبسّط قبل lock؛ أثره الحقيقي في أسطر intent فقط.
  const closingDate = new Date(Date.UTC(year, 11, 31, 0, 0, 0));
  const zeroEffectClose = closingLines.length === 0;
  const closePostingProfile = zeroEffectClose
    ? ("ADJUST_YEAR_CLOSE_ZERO" as const)
    : ("ADJUST_YEAR_CLOSE" as const);
  const closePostingSourceComponents = zeroEffectClose
    ? undefined
    : postingSourceComponents;
  const dedupeKey =
    snapshotRevision === 1
      ? `YEAR_CLOSE:${year}:0`
      : `YEAR_CLOSE:${year}:R${snapshotRevision}`;
  await postEntry(tx, {
    entryType: "ADJUST",
    dedupeKey,
    branchId: null,
    revenue: money(0),
    cost: money(0),
    profit: money(0),
    amount: money(0),
    postingIntent: createPostingIntent(
      closePostingProfile,
      "ADJUST",
      closingLines,
      closePostingSourceComponents,
    ),
    postingSourceComponents: closePostingSourceComponents,
    entryDate: closingDate,
    notes: zeroEffectClose
      ? `إقفال صفري موثق لسنة ${year} بلا أرصدة إيراد أو مصروف قائمة`
      : `إقفال حسابات الإيرادات والمصروفات لسنة ${year} إلى الأرباح المحتجزة`,
  });
  const [found] = await tx
    .select({ id: accountingEntries.id })
    .from(accountingEntries)
    .where(eq(accountingEntries.dedupeKey, dedupeKey))
    .limit(1);
  if (!found) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "تعذر تثبيت مرجع قيد إقفال نهاية السنة.",
    });
  }
  const retainedEarningsEntryId = Number(found.id);

  // ٤. بعد نجاح القيد فقط يُقفل 31/12؛ أي فشل لاحق يرجع الاثنين داخل المعاملة نفسها.
  const closedAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
  const periodLock = await lockPeriod(tx, {
    cutoffDate,
    lockedBy: closedBy,
    lockedAt: closedAt,
    closeMonth: closingMonth,
    closeRevision: Number(closeRequest.closeRevision),
    predecessorPeriodId: sequence.activePeriodId,
    notes: `إقفال سنة ${year} (الشركة كاملة)`,
  });

  await tx
    .update(monthCloseRequests)
    .set({
      status: "APPROVED",
      decidedBy: closedBy,
      decidedAt: closedAt,
      lockedPeriodId: periodLock.id,
      pendingGuard: null,
    })
    .where(eq(monthCloseRequests.id, requestId));

  // ٤. snapshot
  // لقطة قيمة المخزون لحظة الإقفال (تدقيق ٢٧/٧، H5): أصل المخزون في الميزانية يُقرأ حيّاً بلا
  // تاريخ، فبلا هذه اللقطة تكون ميزانيةُ السنة المقفلة **غير قابلةٍ لإعادة الإنتاج** — تُحسب من
  // مخزون اليوم لا من مخزون تاريخ الإقفال. تُخزَّن في `snapshotData` (عمود قائم ⇒ بلا هجرة).
  const inventoryValuation = await readInventoryValuation(tx);
  const snapshotData = JSON.stringify({
    closedAt: closedAt.toISOString(),
    inventoryValue: inventoryValuation.total,
    inventoryValueByBranch: inventoryValuation.branches,
    method: "official-double-entry-year-close",
    branchScope: "company-wide",
    cycleId: settings.cycleId,
    postingProfile: closePostingProfile,
    zeroEffectClose,
    revision: snapshotRevision,
    supersedesSnapshotId: previousSnapshot ? Number(previousSnapshot.id) : null,
    previousReopenRequestId: previousReopen ? Number(previousReopen.id) : null,
    previousReversalEntryId: previousReopen?.reversalEntryId
      ? Number(previousReopen.reversalEntryId)
      : null,
  });
  const snapRes = await tx.insert(yearEndSnapshots).values({
    year,
    scopeKey: "COMPANY",
    revision: snapshotRevision,
    branchId,
    supersedesSnapshotId: previousSnapshot ? Number(previousSnapshot.id) : null,
    closedAt,
    closedBy,
    totalRevenue: toDbMoney(revenue),
    totalCogs: toDbMoney(cogs),
    totalExpenses: toDbMoney(expenses),
    netProfit: toDbMoney(netProfit),
    retainedEarningsEntryId,
    snapshotData,
  });
  const snapshotId = extractInsertId(snapRes);

  const certificate = await createMonthCloseCertificate(tx, {
    kind: "YEAR_END",
    request: {
      id: Number(closeRequest.id),
      month: closeRequest.month,
      readinessSnapshot: closeRequest.readinessSnapshot,
      requestedBy: Number(closeRequest.requestedBy),
      requestedAt: closeRequest.requestedAt,
    },
    revision: Number(closeRequest.closeRevision),
    periodId: periodLock.id,
    approvedBy: closedBy,
    approvedAt: closedAt,
    approvalReadiness: readiness,
    runtime,
    doubleEntryIntegrity: decemberIntegrity
      ? {
          ...decemberIntegrity,
          trialBalanceDifference: toDbMoney(
            decemberIntegrity.roles.reduce(
              (sum, role) => sum.plus(money(role.actual)),
              money(0),
            ),
          ),
        }
      : null,
    yearEndSnapshotId: snapshotId,
    retainedEarningsEntryId,
    yearEndEvidence: {
      year,
      cycleId: settings.cycleId,
      retainedEarningsEntryId,
      closePostingProfile,
      zeroEffectClose,
      totalRevenue: toDbMoney(revenue),
      totalCogs: toDbMoney(cogs),
      totalExpenses: toDbMoney(expenses),
      netProfit: toDbMoney(netProfit),
      annualIntegrity: {
        gapCount: annualIntegrity.gapCount,
        missingCount: annualIntegrity.missingCount,
        extraCount: annualIntegrity.extraCount,
        scopeMismatchCount: annualIntegrity.scopeMismatchCount,
        unreconstructableCount: annualIntegrity.unreconstructableCount,
        sourceMismatchCount: annualIntegrity.sourceMismatchCount,
        imbalancedJournalCount: annualIntegrity.imbalancedJournalCount,
        drift: toDbMoney(annualIntegrity.drift),
        journalImbalance: toDbMoney(annualIntegrity.journalImbalance),
        trialBalanceDifference: toDbMoney(
          annualIntegrity.trialBalanceDifference,
        ),
        ok: annualIntegrity.ok,
      },
      revision: snapshotRevision,
      supersedesSnapshotId: previousSnapshot
        ? Number(previousSnapshot.id)
        : null,
      priorReopenRequestId: previousReopen ? Number(previousReopen.id) : null,
      priorReversalEntryId: previousReopen?.reversalEntryId
        ? Number(previousReopen.reversalEntryId)
        : null,
    },
  });

  await advanceMonthCloseSequence(tx, {
    state: sequence,
    month: closingMonth,
    revision: Number(closeRequest.closeRevision),
    periodId: periodLock.id,
    requestId: Number(closeRequest.id),
    certificateId: certificate.id,
    actorId: closedBy,
    occurredAt: closedAt,
  });

  return {
    snapshotId,
    retainedEarningsEntryId,
    periodLockId: periodLock.id,
    certificateId: certificate.id,
    certificateNumber: certificate.certificateNumber,
    year,
    branchId,
    totalRevenue: revenue.toFixed(2),
    totalCogs: cogs.toFixed(2),
    totalExpenses: expenses.toFixed(2),
    netProfit: netProfit.toFixed(2),
  };
}

export interface RequestYearEndReopenInput {
  snapshotId: number;
  requestedBy: number;
  reason: string;
  clientRequestId: string;
  now?: Date;
}

export interface DecideYearEndReopenInput {
  requestId: number;
  decidedBy: number;
  decisionReason: string;
  now?: Date;
}

function exactSecond(value: Date): Date {
  return new Date(Math.floor(value.getTime() / 1_000) * 1_000);
}

function reopenPayloadHash(
  snapshotId: number,
  requestedBy: number,
  reason: string,
): string {
  return closeSha256(
    canonicalCloseJson({ version: 1, snapshotId, requestedBy, reason }),
  );
}

function assertDecisionReason(value: string): string {
  const reason = value.trim();
  if (reason.length < 5) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سبب القرار إلزامي (٥ أحرف على الأقل).",
    });
  }
  return reason;
}

/**
 * Maker requests reopening the latest active company year-close revision.
 * The request itself has zero financial effect and is replay-safe by clientRequestId + payload hash.
 */
export async function requestYearEndReopen(
  tx: Tx,
  input: RequestYearEndReopenInput,
) {
  const reason = input.reason.trim();
  const clientRequestId = input.clientRequestId.trim();
  if (reason.length < 10) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سبب فتح نهاية السنة إلزامي ومفصل (١٠ أحرف على الأقل).",
    });
  }
  if (!clientRequestId || clientRequestId.length > 64) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "معرّف طلب فتح نهاية السنة غير صالح.",
    });
  }
  const requestHash = reopenPayloadHash(
    input.snapshotId,
    input.requestedBy,
    reason,
  );
  await lockCompanyMonthCloseGate(tx);

  const [replay] = await tx
    .select()
    .from(yearEndReopenRequests)
    .where(eq(yearEndReopenRequests.clientRequestId, clientRequestId))
    .for("update")
    .limit(1);
  if (replay) {
    if (replay.requestPayloadHash !== requestHash) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "أُعيد استعمال معرّف الطلب بحمولة مختلفة.",
      });
    }
    return { ...replay, replayed: true as const };
  }

  const state = await getMonthCloseSequence(tx, { forUpdate: true });
  assertSequenceReady(state);
  const [snapshot] = await tx
    .select()
    .from(yearEndSnapshots)
    .where(eq(yearEndSnapshots.id, input.snapshotId))
    .for("update")
    .limit(1);
  if (!snapshot) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "لقطة نهاية السنة غير موجودة.",
    });
  }
  if (snapshot.scopeKey !== "COMPANY" || snapshot.branchId != null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "لا يدعم المسار الرسمي فتح لقطة فرعية إرثية.",
    });
  }

  const [latestSnapshot] = await tx
    .select({ id: yearEndSnapshots.id })
    .from(yearEndSnapshots)
    .where(
      and(
        eq(yearEndSnapshots.year, snapshot.year),
        eq(yearEndSnapshots.scopeKey, "COMPANY"),
      ),
    )
    .orderBy(desc(yearEndSnapshots.revision), desc(yearEndSnapshots.id))
    .for("update")
    .limit(1);
  if (Number(latestSnapshot?.id) !== Number(snapshot.id)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "لا يجوز فتح مراجعة سنوية متقادمة؛ اختر أحدث مراجعة فقط.",
    });
  }

  const [certificate] = await tx
    .select()
    .from(monthCloseCertificates)
    .where(
      and(
        eq(monthCloseCertificates.yearEndSnapshotId, Number(snapshot.id)),
        eq(monthCloseCertificates.kind, "YEAR_END"),
      ),
    )
    .for("update")
    .limit(1);
  if (!certificate) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "اللقطة لا تحمل شهادة نهاية سنة موثقة؛ لا يمكن فتحها بهذا المسار.",
    });
  }
  const [period] = await tx
    .select()
    .from(financialPeriods)
    .where(eq(financialPeriods.id, Number(certificate.periodId)))
    .for("update")
    .limit(1);
  const closingMonth = `${snapshot.year}-12`;
  if (
    !period ||
    period.status !== "LOCKED" ||
    period.closeMonth !== closingMonth ||
    Number(period.closeRevision) !== Number(snapshot.revision) ||
    Number(certificate.revision) !== Number(snapshot.revision) ||
    state.activeThroughMonth !== closingMonth ||
    state.activePeriodId !== Number(period.id) ||
    state.activeCertificateId !== Number(certificate.id) ||
    state.nextRequiredMonth !== `${snapshot.year + 1}-01`
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "لقطة/شهادة/قفل نهاية السنة ليست واجهة الإقفال النشطة نفسها؛ أعد تحميل الحالة.",
    });
  }
  if (
    snapshot.retainedEarningsEntryId == null ||
    Number(snapshot.retainedEarningsEntryId) !==
      Number(certificate.retainedEarningsEntryId)
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "لقطة نهاية السنة لا تحمل قيد أرباح محتجزة قابلاً للعكس المطابق؛ يلزم تصحيح حوكمي صريح.",
    });
  }
  const [pending] = await tx
    .select({ id: yearEndReopenRequests.id })
    .from(yearEndReopenRequests)
    .where(eq(yearEndReopenRequests.pendingSnapshotId, Number(snapshot.id)))
    .for("update")
    .limit(1);
  if (pending) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `يوجد طلب فتح معلّق لهذه المراجعة (#${pending.id}).`,
    });
  }

  const requestedAt = exactSecond(input.now ?? new Date());
  const result = await tx.insert(yearEndReopenRequests).values({
    year: snapshot.year,
    snapshotId: Number(snapshot.id),
    certificateId: Number(certificate.id),
    periodId: Number(period.id),
    status: "PENDING_APPROVAL",
    pendingSnapshotId: Number(snapshot.id),
    clientRequestId,
    requestPayloadHash: requestHash,
    requestedBy: input.requestedBy,
    requestedAt,
    reason,
  });
  const id = extractInsertId(result);
  const [created] = await tx
    .select()
    .from(yearEndReopenRequests)
    .where(eq(yearEndReopenRequests.id, id))
    .limit(1);
  if (!created) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "تعذر استرجاع طلب فتح نهاية السنة بعد إنشائه.",
    });
  }
  return { ...created, replayed: false as const };
}

/**
 * Checker approval: archive the active year lock, reverse the retained entry line-for-line,
 * then rewind the serialized frontier to December in the same transaction.
 */
export async function approveYearEndReopen(
  tx: Tx,
  input: DecideYearEndReopenInput,
): Promise<{
  requestId: number;
  year: number;
  snapshotId: number;
  reversalEntryId: number;
  reopenEventId: number;
  nextRequiredMonth: string;
}> {
  const decisionReason = assertDecisionReason(input.decisionReason);
  await lockCompanyMonthCloseGate(tx);
  const state = await getMonthCloseSequence(tx, { forUpdate: true });
  assertSequenceReady(state);
  const runtime = await getDoubleEntryRuntime(tx);
  if (runtime.mode !== "ACTIVE" || !runtime.cycleId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "عكس نهاية السنة يتطلب الدفتر ACTIVE والدورة الأصلية نفسها.",
    });
  }

  const [request] = await tx
    .select()
    .from(yearEndReopenRequests)
    .where(eq(yearEndReopenRequests.id, input.requestId))
    .for("update")
    .limit(1);
  if (!request) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "طلب فتح نهاية السنة غير موجود.",
    });
  }
  if (request.status !== "PENDING_APPROVAL") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "طلب فتح نهاية السنة محسوم مسبقاً.",
    });
  }
  if (Number(request.requestedBy) === input.decidedBy) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا يعتمد طالب فتح نهاية السنة طلبه بنفسه (فصل المهام).",
    });
  }

  const [snapshot] = await tx
    .select()
    .from(yearEndSnapshots)
    .where(eq(yearEndSnapshots.id, Number(request.snapshotId)))
    .for("update")
    .limit(1);
  const [certificate] = await tx
    .select()
    .from(monthCloseCertificates)
    .where(eq(monthCloseCertificates.id, Number(request.certificateId)))
    .for("update")
    .limit(1);
  const [period] = await tx
    .select()
    .from(financialPeriods)
    .where(eq(financialPeriods.id, Number(request.periodId)))
    .for("update")
    .limit(1);
  const closingMonth = `${request.year}-12`;
  if (
    !snapshot ||
    !certificate ||
    !period ||
    certificate.kind !== "YEAR_END" ||
    Number(certificate.yearEndSnapshotId) !== Number(snapshot.id) ||
    Number(certificate.periodId) !== Number(period.id) ||
    Number(snapshot.revision) !== Number(certificate.revision) ||
    period.status !== "LOCKED" ||
    period.closeMonth !== closingMonth ||
    state.activeThroughMonth !== closingMonth ||
    state.activePeriodId !== Number(period.id) ||
    state.activeCertificateId !== Number(certificate.id)
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "تغيرت واجهة إقفال نهاية السنة منذ إنشاء الطلب؛ ارفضه وأنشئ طلباً جديداً.",
    });
  }
  if (
    snapshot.retainedEarningsEntryId == null ||
    Number(snapshot.retainedEarningsEntryId) !==
      Number(certificate.retainedEarningsEntryId)
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "مرجع قيد نهاية السنة مفقود أو غير متطابق.",
    });
  }

  const retainedEntryId = Number(snapshot.retainedEarningsEntryId);
  const [retainedEntry] = await tx
    .select()
    .from(accountingEntries)
    .where(eq(accountingEntries.id, retainedEntryId))
    .for("update")
    .limit(1);
  const [retainedJournal] = await tx
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.entryId, retainedEntryId))
    .for("update")
    .limit(1);
  const closePostingProfile = retainedEntry?.postingProfile;
  const zeroEffectClose = closePostingProfile === "ADJUST_YEAR_CLOSE_ZERO";
  const validCloseProfile =
    closePostingProfile === "ADJUST_YEAR_CLOSE" || zeroEffectClose;
  if (
    !retainedEntry ||
    retainedEntry.entryType !== "ADJUST" ||
    !validCloseProfile ||
    retainedEntry.postingCycleId !== runtime.cycleId ||
    !retainedJournal ||
    retainedJournal.status !== (zeroEffectClose ? "MEMO" : "POSTED") ||
    retainedJournal.postingProfile !== closePostingProfile ||
    retainedJournal.cycleId !== runtime.cycleId
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "قيد نهاية السنة المحتفظ به ليس قيد إقفال فعلياً أو صفرياً صالحاً في الدورة الحالية.",
    });
  }
  const sourceLines = await tx
    .select()
    .from(journalLines)
    .where(eq(journalLines.journalId, Number(retainedJournal.id)))
    .orderBy(journalLines.id)
    .for("update");
  if (
    (zeroEffectClose && sourceLines.length !== 0) ||
    (!zeroEffectClose && sourceLines.length === 0)
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: zeroEffectClose
        ? "قيد الإقفال الصفري يحتوي أسطر يومية غير متوقعة."
        : "قيد نهاية السنة بلا أسطر قابلة للعكس.",
    });
  }
  let sealedIntent;
  try {
    sealedIntent = verifyPostingIntentEvidence({
      expectedEntryType: "ADJUST",
      postingProfile: retainedEntry.postingProfile,
      postingIntentJson: retainedEntry.postingIntentJson,
      postingIntentHash: retainedEntry.postingIntentHash,
    });
  } catch {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "بصمة intent لقيد نهاية السنة غير صالحة؛ حُجب العكس.",
    });
  }
  const actualCanonical = canonicalCloseJson(
    sourceLines
      .map((line) => ({
        role: line.role,
        debit: line.debit,
        credit: line.credit,
      }))
      .sort(
        (left, right) =>
          left.role.localeCompare(right.role) ||
          left.debit.localeCompare(right.debit) ||
          left.credit.localeCompare(right.credit),
      ),
  );
  const sealedCanonical = canonicalCloseJson(
    sealedIntent.lines.map((line) => ({
      role: line.role,
      debit: line.debit,
      credit: line.credit,
    })),
  );
  if (actualCanonical !== sealedCanonical) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "أسطر اليومية الحالية لا تطابق intent المختوم لقيد نهاية السنة.",
    });
  }

  const reversalLines: JournalLine[] = [];
  const roleDebits: Partial<Record<AccountRole, string>> = {};
  const roleCredits: Partial<Record<AccountRole, string>> = {};
  const addComponent = (
    target: Partial<Record<AccountRole, string>>,
    role: AccountRole,
    amount: string,
  ) => {
    target[role] = toDbMoney(money(target[role] ?? 0).plus(money(amount)));
  };
  for (const line of sourceLines) {
    const role = line.role as AccountRole;
    if (money(line.debit).gt(0)) {
      reversalLines.push(creditLine(role, line.debit));
      addComponent(roleCredits, role, line.debit);
    } else if (money(line.credit).gt(0)) {
      reversalLines.push(debitLine(role, line.credit));
      addComponent(roleDebits, role, line.credit);
    } else {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "قيد نهاية السنة يحوي سطراً صفرياً غير قابل للعكس.",
      });
    }
  }
  const postingSourceComponents: PostingSourceComponents | undefined =
    zeroEffectClose
      ? undefined
      : {
          roleDebits,
          roleCredits,
        };

  await tx
    .update(financialPeriods)
    .set({ status: "ARCHIVED" })
    .where(
      and(
        eq(financialPeriods.id, Number(period.id)),
        eq(financialPeriods.status, "LOCKED"),
      ),
    );

  const reversalDedupeKey = `YEAR_CLOSE_REVERSAL:${snapshot.id}`;
  await postEntry(tx, {
    entryType: "ADJUST",
    dedupeKey: reversalDedupeKey,
    branchId: null,
    revenue: money(0),
    cost: money(0),
    profit: money(0),
    amount: money(0),
    postingIntent: createPostingIntent(
      zeroEffectClose ? "ADJUST_YEAR_CLOSE_ZERO" : "ADJUST_YEAR_CLOSE",
      "ADJUST",
      reversalLines,
      postingSourceComponents,
    ),
    postingSourceComponents,
    entryDate: new Date(Date.UTC(request.year, 11, 31)),
    notes: `عكس مطابق لقيد إقفال سنة ${request.year} — اللقطة #${snapshot.id}، الطلب #${request.id}`,
    createdBy: input.decidedBy,
  });
  const [reversalEntry] = await tx
    .select({ id: accountingEntries.id })
    .from(accountingEntries)
    .where(eq(accountingEntries.dedupeKey, reversalDedupeKey))
    .limit(1);
  if (!reversalEntry) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "تعذر تثبيت مرجع قيد عكس نهاية السنة.",
    });
  }

  const predecessorPeriod = period.predecessorPeriodId
    ? (
        await tx
          .select()
          .from(financialPeriods)
          .where(eq(financialPeriods.id, Number(period.predecessorPeriodId)))
          .for("update")
          .limit(1)
      )[0]
    : null;
  const predecessorCertificate = predecessorPeriod
    ? (
        await tx
          .select({ id: monthCloseCertificates.id })
          .from(monthCloseCertificates)
          .where(
            eq(monthCloseCertificates.periodId, Number(predecessorPeriod.id)),
          )
          .for("update")
          .limit(1)
      )[0]
    : null;
  const nextRequiredMonth = closingMonth;
  const activeThroughMonth = predecessorPeriod?.closeMonth ?? null;
  const activePeriodId = predecessorPeriod
    ? Number(predecessorPeriod.id)
    : null;
  const activeCertificateId = predecessorCertificate
    ? Number(predecessorCertificate.id)
    : null;
  const version = state.version + 1;
  await tx
    .update(monthCloseSequence)
    .set({
      activeThroughMonth,
      nextRequiredMonth,
      activePeriodId,
      activeCertificateId,
      version,
    })
    .where(eq(monthCloseSequence.id, 1));

  const decidedAt = exactSecond(input.now ?? new Date());
  const event = await appendMonthCloseEvent(
    tx,
    {
      ...state,
      activeThroughMonth,
      nextRequiredMonth,
      activePeriodId,
      activeCertificateId,
      version,
    },
    {
      eventKey: `YEAR_END:REOPEN:${request.id}`,
      eventType: "UNLOCK",
      month: closingMonth,
      periodId: Number(period.id),
      certificateId: Number(certificate.id),
      actorId: input.decidedBy,
      occurredAt: decidedAt,
      reason: decisionReason,
      payload: {
        kind: "YEAR_END_REVERSAL",
        requestId: Number(request.id),
        snapshotId: Number(snapshot.id),
        revision: Number(snapshot.revision),
        retainedEarningsEntryId: retainedEntryId,
        reversalEntryId: Number(reversalEntry.id),
        closePostingProfile: zeroEffectClose
          ? "ADJUST_YEAR_CLOSE_ZERO"
          : "ADJUST_YEAR_CLOSE",
        zeroEffectClose,
        predecessorPeriodId: activePeriodId,
        predecessorMonth: activeThroughMonth,
        nextRequiredMonth,
      },
    },
  );

  await tx
    .update(yearEndReopenRequests)
    .set({
      status: "APPROVED",
      pendingSnapshotId: null,
      decidedBy: input.decidedBy,
      decidedAt,
      decisionReason,
      reversalEntryId: Number(reversalEntry.id),
      reopenEventId: event.id,
    })
    .where(
      and(
        eq(yearEndReopenRequests.id, Number(request.id)),
        eq(yearEndReopenRequests.status, "PENDING_APPROVAL"),
      ),
    );

  return {
    requestId: Number(request.id),
    year: request.year,
    snapshotId: Number(snapshot.id),
    reversalEntryId: Number(reversalEntry.id),
    reopenEventId: event.id,
    nextRequiredMonth,
  };
}

export async function rejectYearEndReopen(
  tx: Tx,
  input: DecideYearEndReopenInput,
): Promise<{ requestId: number; status: "REJECTED" }> {
  const decisionReason = assertDecisionReason(input.decisionReason);
  await lockCompanyMonthCloseGate(tx);
  const [request] = await tx
    .select()
    .from(yearEndReopenRequests)
    .where(eq(yearEndReopenRequests.id, input.requestId))
    .for("update")
    .limit(1);
  if (!request) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "طلب فتح نهاية السنة غير موجود.",
    });
  }
  if (request.status !== "PENDING_APPROVAL") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "طلب فتح نهاية السنة محسوم مسبقاً.",
    });
  }
  if (Number(request.requestedBy) === input.decidedBy) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا يرفض طالب فتح نهاية السنة طلبه بنفسه (فصل المهام).",
    });
  }
  await tx
    .update(yearEndReopenRequests)
    .set({
      status: "REJECTED",
      pendingSnapshotId: null,
      decidedBy: input.decidedBy,
      decidedAt: exactSecond(input.now ?? new Date()),
      decisionReason,
    })
    .where(eq(yearEndReopenRequests.id, Number(request.id)));
  return { requestId: Number(request.id), status: "REJECTED" };
}

export async function listYearEndReopenRequests(
  tx: Tx,
  filters: {
    year?: number;
    snapshotId?: number;
    pendingOnly?: boolean;
  } = {},
) {
  const where = [];
  if (filters.year != null)
    where.push(eq(yearEndReopenRequests.year, filters.year));
  if (filters.snapshotId != null)
    where.push(eq(yearEndReopenRequests.snapshotId, filters.snapshotId));
  if (filters.pendingOnly)
    where.push(eq(yearEndReopenRequests.status, "PENDING_APPROVAL"));
  const rows = await tx
    .select()
    .from(yearEndReopenRequests)
    .where(where.length ? and(...where) : sql`1=1`)
    .orderBy(desc(yearEndReopenRequests.id))
    .limit(200);
  const userIds = Array.from(
    new Set(
      rows.flatMap((row) =>
        row.decidedBy == null
          ? [Number(row.requestedBy)]
          : [Number(row.requestedBy), Number(row.decidedBy)],
      ),
    ),
  );
  const people = userIds.length
    ? await tx
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const names = new Map(people.map((row) => [Number(row.id), row.name]));
  return rows.map((row) => ({
    ...row,
    requestedByName: names.get(Number(row.requestedBy)) ?? "مستخدم",
    decidedByName:
      row.decidedBy == null
        ? null
        : (names.get(Number(row.decidedBy)) ?? "مستخدم"),
  }));
}

/** قائمة الإقفالات السابقة (للعرض في الواجهة). */
export async function listSnapshots(
  tx: Tx,
  filters: { year?: number; branchId?: number | null } = {},
) {
  const where = [];
  if (filters.year != null) where.push(eq(yearEndSnapshots.year, filters.year));
  if (filters.branchId !== undefined) {
    where.push(
      filters.branchId === null
        ? sql`${yearEndSnapshots.branchId} IS NULL`
        : eq(yearEndSnapshots.branchId, filters.branchId),
    );
  }
  const rows = await tx
    .select()
    .from(yearEndSnapshots)
    .where(where.length ? and(...where) : sql`1=1`)
    .orderBy(
      sql`${yearEndSnapshots.year} DESC, ${yearEndSnapshots.branchId} ASC`,
      desc(yearEndSnapshots.revision),
    );
  return rows;
}
