import { TRPCError } from "@trpc/server";
import { and, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import {
  accountingEntries,
  accounts,
  branchStock,
  customers,
  deliveryConsignments,
  deliveryParties,
  doubleEntrySettings,
  inventoryMovements,
  invoices,
  journalEntries,
  journalLines,
  onlineOrders,
  openingModeSettings,
  receipts,
  suppliers,
} from "../../drizzle/schema";
import { getDb, type Tx } from "../db";
import {
  ACCOUNT_ROLES,
  ALL_POSTING_PROFILES,
  verifyPostingIntentEvidence,
  type JournalLine,
} from "./accounting/postingEngine";
import { money, round2 } from "./money";
import { entryNotHoldReceiptCond } from "./reception/holdReceipts";

export interface ReconcileResult {
  entity: string;
  id: number;
  expected: string;
  actual: string;
  drift: string;
  /** توسيم اختياري: «متوقع — وضع الافتتاح» للسالب غير المُفتتَح أثناء النافذة الفعّالة (١٨/٧). */
  note?: string;
}

export interface DoubleEntryRoleReconciliation {
  role: string;
  /** صافي الدور المتوقع من الدفتر المبسّط: المدين − الدائن. */
  expected: string;
  /** صافي الدور المكتوب فعلاً في journalLines: المدين − الدائن. */
  actual: string;
  drift: string;
}

export interface DoubleEntryReconciliation {
  scope: {
    kind: "MONTH" | "SHADOW_WINDOW";
    month: string | null;
    branchId: number | null;
    from: string;
    to: string;
  };
  sourceEntryCount: number;
  journalEntryCount: number;
  postedCount: number;
  memoCount: number;
  gapCount: number;
  missingCount: number;
  extraCount: number;
  /** رأس يومية مرتبط بالمصدر لكنه منسوب إلى فرع أو تاريخ قيد مختلف. */
  scopeMismatchCount: number;
  unreconstructableCount: number;
  /** مصادر أمكن بناء نيتها لكن يوميتها لا تطابق الأسطر/الحالة/profile حرفياً. */
  sourceMismatchCount: number;
  /** مجموع القيم المطلقة لانحراف الأدوار. */
  drift: string;
  /** اختلال مجموع اليومية نفسها؛ دفاعٌ ثانٍ عن assertBalanced. */
  journalImbalance: string;
  /** عدد اليوميات التي لا يتساوى مدينها ودائنها؛ لا يسمح الإلغاء بين يوميتين بإخفائه. */
  imbalancedJournalCount: number;
  observedProfiles: string[];
  unobservedProfiles: string[];
  roles: DoubleEntryRoleReconciliation[];
  ok: boolean;
}

export interface ReconcileDoubleEntryInput {
  /** الشهر بصيغة YYYY-MM. */
  month: string;
  /** فرعٌ بعينه، أو null/غياب لكل الفروع. */
  branchId?: number | null;
}

type QueryExecutor = NonNullable<ReturnType<typeof getDb>> | Tx;

function monthDates(month: string): { from: Date; to: Date; fromYmd: string; toYmd: string } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "صيغة الشهر يجب أن تكون YYYY-MM." });
  }
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const fromYmd = `${month}-01`;
  const toYmd = `${month}-${String(lastDay).padStart(2, "0")}`;
  return {
    from: new Date(`${fromYmd}T00:00:00.000Z`),
    to: new Date(`${toYmd}T00:00:00.000Z`),
    fromYmd,
    toYmd,
  };
}

function addNet(target: Map<string, ReturnType<typeof money>>, role: string, debit: string, credit: string) {
  const delta = money(debit).minus(money(credit));
  target.set(role, (target.get(role) ?? money(0)).plus(delta));
}

const journalRoleSet: ReadonlySet<string> = new Set(ACCOUNT_ROLES);

/** Canonical multiset: line splitting and debit/credit wash lines remain visible. */
function canonicalLineMultiset(
  lines: ReadonlyArray<{ role: string; debit: string; credit: string }>,
): string | null {
  const normalized: string[] = [];
  for (const line of lines) {
    const debit = money(line.debit);
    const credit = money(line.credit);
    if (
      !journalRoleSet.has(line.role) ||
      !debit.isFinite() ||
      !credit.isFinite() ||
      debit.isNegative() ||
      credit.isNegative() ||
      !debit.eq(round2(debit)) ||
      !credit.eq(round2(credit)) ||
      debit.isZero() === credit.isZero()
    ) {
      return null;
    }
    const isDebit = !debit.isZero();
    normalized.push(
      `${line.role}\u0000${isDebit ? "D" : "C"}\u0000${(
        isDebit ? debit : credit
      ).toFixed(2)}`,
    );
  }
  return normalized.sort().join("\n");
}

function journalLinesOf(lines: readonly JournalLine[]): Array<{
  role: string;
  debit: string;
  credit: string;
}> {
  return lines.map((line) => ({
    role: line.role,
    debit: String(line.debit),
    credit: String(line.credit),
  }));
}

async function runDoubleEntryReconciliation(
  executor: QueryExecutor | null,
  input: {
    sourceWhere: SQL;
    journalWhere: SQL;
    scope: DoubleEntryReconciliation["scope"];
  },
): Promise<DoubleEntryReconciliation> {
  if (!executor) {
    return {
      scope: input.scope,
      sourceEntryCount: 0,
      journalEntryCount: 0,
      postedCount: 0,
      memoCount: 0,
      gapCount: 0,
      missingCount: 0,
      extraCount: 0,
      scopeMismatchCount: 0,
      unreconstructableCount: 0,
      sourceMismatchCount: 0,
      drift: "0.00",
      journalImbalance: "0.00",
      imbalancedJournalCount: 0,
      observedProfiles: [],
      unobservedProfiles: [...ALL_POSTING_PROFILES],
      roles: [],
      ok: true,
    };
  }

  const sourceRows = await executor
    .select({
      id: accountingEntries.id,
      branchId: accountingEntries.branchId,
      entryDate: accountingEntries.entryDate,
      entryType: accountingEntries.entryType,
      revenue: accountingEntries.revenue,
      cost: accountingEntries.cost,
      profit: accountingEntries.profit,
      amount: accountingEntries.amount,
      taxAmount: accountingEntries.taxAmount,
      postingProfile: accountingEntries.postingProfile,
      postingIntentJson: accountingEntries.postingIntentJson,
      postingIntentHash: accountingEntries.postingIntentHash,
    })
    .from(accountingEntries)
    .where(input.sourceWhere);

  const heads = await executor
    .select({
      id: journalEntries.id,
      entryId: journalEntries.entryId,
      branchId: journalEntries.branchId,
      entryDate: journalEntries.entryDate,
      status: journalEntries.status,
      postingProfile: journalEntries.postingProfile,
    })
    .from(journalEntries)
    .where(input.journalWhere);

  const actualLines = await executor
    .select({
      journalId: journalLines.journalId,
      role: journalLines.role,
      debit: journalLines.debit,
      credit: journalLines.credit,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalId, journalEntries.id))
    .where(input.journalWhere);

  const expectedByRole = new Map<string, ReturnType<typeof money>>();
  const headBySourceId = new Map(
    heads
      .filter((head) => head.entryId != null)
      .map((head) => [Number(head.entryId), head]),
  );
  const headByJournalId = new Map(
    heads.map((head) => [Number(head.id), head]),
  );
  const actualLinesByJournal = new Map<
    number,
    Array<{ role: string; debit: string; credit: string }>
  >();
  for (const line of actualLines) {
    const journalId = Number(line.journalId);
    const bucket = actualLinesByJournal.get(journalId) ?? [];
    bucket.push({
      role: line.role,
      debit: String(line.debit ?? "0"),
      credit: String(line.credit ?? "0"),
    });
    actualLinesByJournal.set(journalId, bucket);
  }
  let unreconstructableCount = 0;
  let sourceMismatchCount = 0;
  const observedProfiles = new Set<string>();
  for (const row of sourceRows) {
    const head = headBySourceId.get(Number(row.id));

    // PostingIntent الجديد لا يمكن إعادة اشتقاق variant الخاص به من accountingEntries؛
    // تحققُه المستقل يكون عند الكتابة + مطابقة الأرصدة التشغيلية. هنا نحافظ على مقارنة
    // legacy فقط، وننسخ صافي أسطر intent إلى جانب expected كي لا نخلق drift زائفاً.
    if (row.postingProfile || row.postingIntentJson || row.postingIntentHash) {
      try {
        const intent = verifyPostingIntentEvidence({
          expectedEntryType: row.entryType,
          postingProfile: row.postingProfile,
          postingIntentJson: row.postingIntentJson,
          postingIntentHash: row.postingIntentHash,
          source: {
            amount: String(row.amount ?? "0"),
            revenue: String(row.revenue ?? "0"),
            cost: String(row.cost ?? "0"),
            profit: String(row.profit ?? "0"),
            taxAmount: String(row.taxAmount ?? "0"),
          },
        });
        const expectedLines = [...intent.lines];
        observedProfiles.add(intent.profile);
        for (const line of expectedLines) {
          addNet(
            expectedByRole,
            line.role,
            String(line.debit),
            String(line.credit),
          );
        }
        if (head) {
          const actualForHead = actualLinesByJournal.get(Number(head.id)) ?? [];
          if (
            head.status !== (expectedLines.length === 0 ? "MEMO" : "POSTED") ||
            head.postingProfile !== intent.profile ||
            canonicalLineMultiset(journalLinesOf(expectedLines)) !==
              canonicalLineMultiset(actualForHead)
          ) {
            sourceMismatchCount += 1;
          }
        }
      } catch {
        unreconstructableCount += 1;
      }
      continue;
    }
    // كل مصدر داخل الدورة الحالية يجب أن يحمل دليلاً canonical. الاشتقاق
    // القديم لا يُقبل بوابةً بديلة بعد القطع ولو كان نوعه من الخرائط الست.
    unreconstructableCount += 1;
  }

  const actualByRole = new Map<string, ReturnType<typeof money>>();
  for (const line of actualLines) {
    if (headByJournalId.get(Number(line.journalId))?.status !== "POSTED") {
      continue;
    }
    const debit = String(line.debit ?? "0");
    const credit = String(line.credit ?? "0");
    addNet(actualByRole, line.role, debit, credit);
  }

  let imbalancedJournalCount = 0;
  let journalImbalance = money(0);
  for (const head of heads) {
    const lines = actualLinesByJournal.get(Number(head.id)) ?? [];
    if (head.status !== "POSTED") {
      if (lines.length > 0) imbalancedJournalCount += 1;
      continue;
    }
    if (lines.length === 0) {
      imbalancedJournalCount += 1;
      continue;
    }
    let debit = money(0);
    let credit = money(0);
    for (const line of lines) {
      debit = debit.plus(money(line.debit));
      credit = credit.plus(money(line.credit));
    }
    const difference = round2(debit.minus(credit).abs());
    if (!difference.isZero()) {
      imbalancedJournalCount += 1;
      journalImbalance = journalImbalance.plus(difference);
    }
  }
  journalImbalance = round2(journalImbalance);

  const roles = Array.from(new Set(Array.from(expectedByRole.keys()).concat(Array.from(actualByRole.keys()))))
    .sort()
    .map((role): DoubleEntryRoleReconciliation => {
      const expected = round2(expectedByRole.get(role) ?? money(0));
      const actual = round2(actualByRole.get(role) ?? money(0));
      return {
        role,
        expected: expected.toFixed(2),
        actual: actual.toFixed(2),
        drift: round2(expected.minus(actual).abs()).toFixed(2),
      };
    });

  const sourceIds = new Set(sourceRows.map((row) => Number(row.id)));
  const journalSourceIds = new Set(heads.map((row) => Number(row.entryId)));
  const sourceById = new Map(sourceRows.map((row) => [Number(row.id), row]));
  const missingCount = sourceRows.reduce((count, row) => count + (journalSourceIds.has(Number(row.id)) ? 0 : 1), 0);
  const extraCount = heads.reduce((count, row) => count + (sourceIds.has(Number(row.entryId)) ? 0 : 1), 0);
  const scopeMismatchCount = heads.reduce((count, head) => {
    const source = sourceById.get(Number(head.entryId));
    if (!source) return count;
    const sourceDate = source.entryDate.toISOString().slice(0, 10);
    const journalDate = head.entryDate.toISOString().slice(0, 10);
    return count + (source.branchId !== head.branchId || sourceDate !== journalDate ? 1 : 0);
  }, 0);
  const gapCount = heads.filter((row) => row.status === "UNMAPPED").length;
  const postedCount = heads.filter((row) => row.status === "POSTED").length;
  const drift = round2(roles.reduce((sum, row) => sum.plus(money(row.drift)), money(0)));
  const ok = gapCount === 0
    && missingCount === 0
    && extraCount === 0
    && scopeMismatchCount === 0
    && unreconstructableCount === 0
    && sourceMismatchCount === 0
    && drift.isZero()
    && journalImbalance.isZero()
    && imbalancedJournalCount === 0;

  return {
    scope: input.scope,
    sourceEntryCount: sourceRows.length,
    journalEntryCount: heads.length,
    postedCount,
    memoCount: heads.filter((row) => row.status === "MEMO").length,
    gapCount,
    missingCount,
    extraCount,
    scopeMismatchCount,
    unreconstructableCount,
    sourceMismatchCount,
    drift: drift.toFixed(2),
    journalImbalance: journalImbalance.toFixed(2),
    imbalancedJournalCount,
    observedProfiles: Array.from(observedProfiles).sort(),
    unobservedProfiles: ALL_POSTING_PROFILES.filter(
      (profile) => !observedProfiles.has(profile),
    ),
    roles,
    ok,
  };
}

/**
 * مطابقة الدفتر المزدوج داخل شهرٍ وفرعٍ محدّدين. المقارنة مستقلّة عن أسطر اليومية: تُعيد تشغيل
 * خريطة الحدث على الدفتر المبسّط، ثم تقارن صافي كل دور بما كُتب فعلاً. بذلك تكشف السطر المعدّل،
 * الرأس المفقود، والفجوة — لا تكتفي بثابت Σمدين=Σدائن الذي قد يمرّ رغم تبديل حسابين.
 */
export async function reconcileDoubleEntry(
  input: ReconcileDoubleEntryInput,
  options?: { tx?: Tx },
): Promise<DoubleEntryReconciliation> {
  const executor = options?.tx ?? getDb();
  const range = monthDates(input.month);
  const branchId = input.branchId ?? null;
  const settings = executor
    ? (
        await executor
          .select({
            cycleId: doubleEntrySettings.shadowCycleId,
          })
          .from(doubleEntrySettings)
          .where(eq(doubleEntrySettings.id, 1))
          .limit(1)
      )[0]
    : undefined;
  const activeCycle = settings?.cycleId ?? null;
  const noCycle = sql`1 = 0`;
  const sourceWhere = and(
    activeCycle
      ? eq(accountingEntries.postingCycleId, activeCycle)
      : noCycle,
    gte(accountingEntries.entryDate, range.from),
    lte(accountingEntries.entryDate, range.to),
    branchId == null ? undefined : eq(accountingEntries.branchId, branchId),
  ) as SQL;
  const journalWhere = and(
    activeCycle ? eq(journalEntries.cycleId, activeCycle) : noCycle,
    eq(journalEntries.sourceType, "ACCOUNTING_ENTRY"),
    gte(journalEntries.entryDate, range.from),
    lte(journalEntries.entryDate, range.to),
    branchId == null ? undefined : eq(journalEntries.branchId, branchId),
  ) as SQL;
  return runDoubleEntryReconciliation(executor, {
    sourceWhere,
    journalWhere,
    scope: {
      kind: "MONTH",
      month: input.month,
      branchId,
      from: range.fromYmd,
      to: range.toYmd,
    },
  });
}

/** نافذة المراقبة الفعلية للبوابة: createdAt منذ بدء SHADOW، فتستثني قيود اليوم السابقة للتفعيل. */
export async function reconcileDoubleEntryShadowWindow(
  input: { from: Date; to: Date; cycleId: string },
  options?: { tx?: Tx },
): Promise<DoubleEntryReconciliation> {
  return runDoubleEntryReconciliation(options?.tx ?? getDb(), {
    sourceWhere: and(
      eq(accountingEntries.postingCycleId, input.cycleId),
      gte(accountingEntries.createdAt, input.from),
      lte(accountingEntries.createdAt, input.to),
    ) as SQL,
    journalWhere: and(
      eq(journalEntries.cycleId, input.cycleId),
      eq(journalEntries.sourceType, "ACCOUNTING_ENTRY"),
      gte(journalEntries.createdAt, input.from),
      lte(journalEntries.createdAt, input.to),
    ) as SQL,
    scope: {
      kind: "SHADOW_WINDOW",
      month: null,
      branchId: null,
      from: input.from.toISOString(),
      to: input.to.toISOString(),
    },
  });
}

/**
 * التحقق من اتساق ذمم العملاء (مُحدَّث بعد إصلاحات ٨/٦):
 *
 * نموذج AR الفعلي: currentBalance يُحدَّث بزيادة نسبية في كل عملية ويظلّ المصدر الموقَّع الصحيح
 * (قد يكون سالباً = المتجر يدين للعميل، بسبب دفع زائد أو مرتجع نقدي بلا رصيد كافٍ).
 *
 * المُتوقَّع المُشتقّ يجب أن يطابق هذا — السابق استعمل GREATEST(.,0) واستثنى المرتجعات،
 * فأنتج «انحرافاً وهمياً» في كل حالة مشروعة:
 *   • مرتجع جزئي على فاتورة آجلة (currentBalance يقلّ، invoice.total لا يقلّ).
 *   • دفع زائد (currentBalance سالب، expected=0).
 *
 * الصيغة الصحيحة (موقَّعة، تتطابق مع ما تكتبه الخدمات على currentBalance):
 *   expected = Σ (invoice.total − invoice.paidAmount) على فواتير غير ملغاة
 *            + Σ RETURN.amount على فواتير العميل  (مخزَّن سالباً ⇒ يطرح المرتجع)
 *            + Σ PAYMENT_OUT.amount على فواتير العميل (مرتجع نقدي مَردّه يَزيد paidAmount عبر returnSale)
 *            + Σ OPENING.amount للعميل (قيد ترسيخ الرصيد الافتتاحي المستورد — import-integration)
 *
 * (returnSale ينقص paidAmount بـcashRefund، فـ(total − paidAmount) يَكبر بـcashRefund؛
 *  PAYMENT_OUT.amount = cashRefund موجباً ⇒ نضيفه فيُلغى هذا الكِبَر، وتبقى RETURN.amount السالبة
 *  هي ما يَطرح أثر المرتجع كاملاً على AR.)
 *
 * (قيد OPENING يكتبه importService عند إنشاء عميل برصيد افتتاحي ⇒ بدونه في الصيغة يصير كل
 *  مستورَدٍ برصيدٍ «انحرافاً» زائفاً دائماً يُغرق هذا التقرير من يوم الاستيراد.)
 */
export async function reconcileCustomerBalances(): Promise<ReconcileResult[]> {
  const db = getDb();
  if (!db) return [];

  // قيود OPENING للعملاء (الرصيد الافتتاحي المستورد) — تُضاف إلى المُتوقَّع من الفواتير.
  const openingSum = await db
    .select({
      customerId: accountingEntries.customerId,
      opening: sql<string>`COALESCE(SUM(CAST(${accountingEntries.amount} AS DECIMAL(15,2))), 0)`,
    })
    .from(accountingEntries)
    .where(
      and(
        sql`${accountingEntries.customerId} IS NOT NULL`,
        eq(accountingEntries.entryType, "OPENING")
      )
    )
    .groupBy(accountingEntries.customerId);
  const openingMap = new Map(openingSum.map((r) => [Number(r.customerId), String(r.opening ?? "0")]));

  // سندات العميل المستقلّة (B1): PAYMENT_IN/PAYMENT_OUT مع customerId وبلا invoiceId.
  // - voucher RECEIPT (PAYMENT_IN) ⇒ adjustCustomerBalance(-amount) ⇒ AR ينقص ⇒ نطرحها من المُتوقَّع.
  // - voucher PAYMENT (PAYMENT_OUT) ⇒ adjustCustomerBalance(+amount) ⇒ AR يزيد ⇒ نضيفها.
  // الفلتر invoiceId IS NULL إلزامي: PAYMENT_IN على فاتورة (sale.pay) محسوبة أصلاً عبر paidAmount،
  // وضمّها هنا يكرّر الحساب. cancelVoucher يكتب قيداً تعويضياً بلا invoiceId أيضاً فينصافر صافي السندات
  // المستقلّة المُلغاة إلى صفر. التناظر مع reconcileSupplierBalances الذي يضمّ الاتجاهين أصلاً.
  //
  // ⛔ استثناء قيود إيصالات الاحتجاز السابقة للفاتورة (V5+V6 — ش٤ وحّدت البصمة):
  // عربون أمر الشغل (receipt.workOrderId NOT NULL) **وعربون/ردّ مسوّدة الاستقبال** (إيصالٌ
  // مربوطٌ بصفّ orderPayments). كلاهما ليس تسديداً للذمة (لا فاتورة موجودة بعدُ) بل أمانة على
  // عملٍ مستقبلي، ولا يُحدِّث customers.currentBalance عند القبض. ضمّه في voucherSum يُنتج
  // drift = depositAmount. الحارس بنيوي ثابت لا يعتمد على mutability (A1، ١٩/٦/٢٦): قيد
  // PAYMENT_IN للعربون يبقى invoiceId=NULL مدى الحياة (append-only صارم)، والمال يصل الفاتورة
  // عبر invoice.paidAmount عند التثبيت/التسليم. الردود (PAYMENT_OUT) بنفس البصمة فتنصافر.
  // المصدر الواحد: entryNotHoldReceiptCond في reception/holdReceipts.ts.
  const voucherSum = await db
    .select({
      customerId: accountingEntries.customerId,
      net: sql<string>`COALESCE(SUM(CASE
        WHEN ${accountingEntries.entryType} = 'PAYMENT_IN'  THEN -CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'PAYMENT_OUT' THEN  CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        ELSE 0 END), 0)`,
    })
    .from(accountingEntries)
    .where(
      and(
        sql`${accountingEntries.customerId} IS NOT NULL`,
        sql`${accountingEntries.invoiceId} IS NULL`,
        inArray(accountingEntries.entryType, ["PAYMENT_IN", "PAYMENT_OUT"]),
        entryNotHoldReceiptCond(accountingEntries.receiptId),
      )
    )
    .groupBy(accountingEntries.customerId);
  const voucherMap = new Map(voucherSum.map((r) => [Number(r.customerId), String(r.net ?? "0")]));

  // مع عمود returnedTotal، الصيغة تبسّطت كثيراً:
  //   AR_per_invoice = total - paidAmount - returnedTotal (موقَّع، لا GREATEST(.,0))
  // CANCELLED وSUPERSEDED مستندان نهائيان بلا ذمة: البديلة وحدها تحمل الالتزام بعد التصحيح.
  const invSum = await db
    .select({
      customerId: invoices.customerId,
      arGross: sql<string>`
        COALESCE(SUM(CASE
          WHEN ${invoices.status} NOT IN ('CANCELLED', 'SUPERSEDED')
          THEN CAST(${invoices.total} AS DECIMAL(15,2))
             - CAST(${invoices.paidAmount} AS DECIMAL(15,2))
             - CAST(${invoices.returnedTotal} AS DECIMAL(15,2))
          ELSE 0
        END), 0)
      `,
    })
    .from(invoices)
    .where(sql`${invoices.customerId} IS NOT NULL`)
    .groupBy(invoices.customerId);

  const actuals = await db
    .select({ id: customers.id, balance: customers.currentBalance })
    .from(customers);
  const actualMap = new Map(actuals.map((c) => [Number(c.id), String(c.balance ?? "0")]));
  const invMap = new Map(invSum.map((r) => [Number(r.customerId), String(r.arGross ?? "0")]));

  // كل عميل له فاتورة أو قيد افتتاحي أو سند مستقلّ أو رصيد غير صفري.
  const seen = new Set<number>();
  for (const row of invSum) seen.add(Number(row.customerId));
  for (const row of openingSum) seen.add(Number(row.customerId));
  for (const row of voucherSum) seen.add(Number(row.customerId));
  for (const c of actuals) if (money(c.balance ?? "0").abs().gt(0)) seen.add(Number(c.id));

  const issues: ReconcileResult[] = [];
  for (const customerId of Array.from(seen)) {
    const expected = money(invMap.get(customerId) ?? "0")
      .plus(money(openingMap.get(customerId) ?? "0"))
      .plus(money(voucherMap.get(customerId) ?? "0"));
    const actual = money(actualMap.get(customerId) ?? "0");
    const drift = expected.minus(actual).abs();
    if (drift.greaterThan("0.01")) {
      issues.push({
        entity: "customer",
        id: customerId,
        expected: expected.toFixed(2),
        actual: actual.toFixed(2),
        drift: drift.toFixed(2),
      });
    }
  }
  return issues;
}

/**
 * التحقّق من اتساق ذمم الموردين (AP). النموذج: suppliers.currentBalance (موجب = ندين للمورد)
 * يُحدَّث بزيادة نسبية ذرّية في كل عملية. المُتوقَّع المُشتقّ من قيود الدفتر للمورد:
 *   AP = Σ PURCHASE.amount − Σ PAYMENT_OUT.amount − Σ EXCHANGE_SETTLE.amount + Σ PAYMENT_IN.amount + Σ RETURN.amount
 *      + Σ OPENING.amount (قيد ترسيخ الرصيد الافتتاحي المستورد — import-integration)
 *   (EXCHANGE_SETTLE = تسديد مورد عبر الصيرفة يَخفض AP كـPAYMENT_OUT؛ EXCHANGE_FEE/FX_DIFF تَحملان
 *    supplierId للتقرير لكنهما لا يَمسّان currentBalance فتَسقطان في ELSE 0 بلا انحراف.)
 *   (RETURN.amount مخزَّن سالباً ⇒ يَطرح المرتجع؛ PAYMENT_IN = استرداد نقدي من المورد يَزيد AP العاكس).
 * يكشف أي انحراف صامت في AP (الذي لم يكن مُتحقَّقاً منه آلياً قبل هذا).
 */
export async function reconcileSupplierBalances(): Promise<ReconcileResult[]> {
  const db = getDb();
  if (!db) return [];

  const entrySum = await db
    .select({
      supplierId: accountingEntries.supplierId,
      ap: sql<string>`COALESCE(SUM(CASE
        WHEN ${accountingEntries.purchaseLiabilityAccount} = 'CASH_CLEARING' THEN 0
        WHEN ${accountingEntries.entryType} = 'PURCHASE'    THEN CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'PAYMENT_OUT' THEN -CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'PAYMENT_IN'  THEN CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'RETURN'      THEN CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'OPENING'     THEN CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'EXCHANGE_SETTLE' THEN -CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        ELSE 0 END), 0)`,
    })
    .from(accountingEntries)
    .where(sql`${accountingEntries.supplierId} IS NOT NULL`)
    .groupBy(accountingEntries.supplierId);

  const actuals = await db.select({ id: suppliers.id, balance: suppliers.currentBalance }).from(suppliers);
  const apMap = new Map(entrySum.map((r) => [Number(r.supplierId), String(r.ap ?? "0")]));
  const actualMap = new Map(actuals.map((s) => [Number(s.id), String(s.balance ?? "0")]));

  const seen = new Set<number>();
  for (const r of entrySum) seen.add(Number(r.supplierId));
  for (const s of actuals) if (money(s.balance ?? "0").abs().gt(0)) seen.add(Number(s.id));

  const issues: ReconcileResult[] = [];
  for (const supplierId of Array.from(seen)) {
    const expected = money(apMap.get(supplierId) ?? "0");
    const actual = money(actualMap.get(supplierId) ?? "0");
    const drift = expected.minus(actual).abs();
    if (drift.greaterThan("0.01")) {
      issues.push({ entity: "supplier", id: supplierId, expected: expected.toFixed(2), actual: actual.toFixed(2), drift: drift.toFixed(2) });
    }
  }
  return issues;
}

/**
 * التحقّق من اتساق عهدة جهات التوصيل (COD float). النموذج: deliveryParties.currentBalance
 * (موجب = الجهة مدينة بنقد COD غير مورَّد) يُحدَّث ذرّياً في كل عملية. المُتوقَّع من الدفتر:
 *   float = Σ DELIVERY_DISPATCH − Σ DELIVERY_REMIT − Σ DELIVERY_WRITEOFF  (لكل جهة)
 * (DELIVERY_FEE لا يَمسّ العهدة — مصروف منفصل؛ والإيراد مُعترَف به مرّة واحدة بقيد SALE.)
 * يَكشف أي انحراف صامت في العهدة. ثابتٌ مكافئ: Σ currentBalance == Σ (codAmount−collectedAmount)
 * للإرساليات DISPATCHED/PARTIAL (تُتحقَّق ضمنياً عبر هذه الصيغة لأن الخدمة تكتب الاثنين معاً).
 */
export async function reconcileDeliveryFloat(): Promise<ReconcileResult[]> {
  const db = getDb();
  if (!db) return [];

  const entrySum = await db
    .select({
      partyId: accountingEntries.deliveryPartyId,
      float: sql<string>`COALESCE(SUM(CASE
        WHEN ${accountingEntries.entryType} = 'DELIVERY_DISPATCH' THEN  CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'DELIVERY_REMIT'    THEN -CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'DELIVERY_WRITEOFF' THEN -CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        ELSE 0 END), 0)`,
    })
    .from(accountingEntries)
    .where(sql`${accountingEntries.deliveryPartyId} IS NOT NULL`)
    .groupBy(accountingEntries.deliveryPartyId);

  const actuals = await db.select({ id: deliveryParties.id, balance: deliveryParties.currentBalance }).from(deliveryParties);
  const floatMap = new Map(entrySum.map((r) => [Number(r.partyId), String(r.float ?? "0")]));
  const actualMap = new Map(actuals.map((p) => [Number(p.id), String(p.balance ?? "0")]));

  const seen = new Set<number>();
  for (const r of entrySum) seen.add(Number(r.partyId));
  for (const p of actuals) if (money(p.balance ?? "0").abs().gt(0)) seen.add(Number(p.id));

  const issues: ReconcileResult[] = [];
  for (const partyId of Array.from(seen)) {
    const expected = money(floatMap.get(partyId) ?? "0");
    const actual = money(actualMap.get(partyId) ?? "0");
    const drift = expected.minus(actual).abs();
    if (drift.greaterThan("0.01")) {
      issues.push({ entity: "deliveryParty", id: partyId, expected: expected.toFixed(2), actual: actual.toFixed(2), drift: drift.toFixed(2) });
    }
  }
  return issues;
}

/**
 * التحقق من سلامة مخزون الفروع — كاشفَين مستقلَّين:
 *
 *   1) **الرصيد السالب** (`entity: "stock"`): `branchStock.quantity < 0`. أثناء نافذة وضع الافتتاح
 *      يُوسَم السالبُ غير المُفتتَح «متوقّع» لا يُخفى (كي لا يطمس الضجيجُ الانحرافاتِ الحقيقية).
 *
 *   2) **مطابقة الحركات ↔ الرصيد** (`entity: "movementDrift"` — P1-#3-ب، ٢٥/٨): لكل (متغيّر ×
 *      فرع) يجب أن يكون `Σ signedDelta = branchStock.quantity`. هذا الثابت أصبح ممكناً بعد
 *      P1-#3-أ (عمود `signedDelta` + backfill 0265). يكشف:
 *        - تحديثاً مباشراً على `branchStock` بلا حركة (خرقٌ للطبقة الخدميّة).
 *        - حركةً فُقدت (إخفاقٌ في المعاملة).
 *        - فسادَ بياناتٍ تراكمي.
 *
 *      ملاحظاتٌ صريحة على الصفوف الحدّية:
 *        - `unknownDeltas > 0` = حركاتٌ قبل الهجرة لم يُستطع اشتقاق إشارتها من نصّها (نمطُ الوسم
 *          غير مطابق) ⇒ المجموع غيرُ حاسم، نُبلَّغ به بدل ابتلاعه.
 *        - سالبٌ متوقّع بوسم وضع الافتتاح: يظهر مرّتَين — مرّةً كـstock ومرّة كـmovementDrift إن
 *          كان الرصيد لا يطابق الحركات — ولا اجتزال بينهما (كاشفان مستقلَّان بنيوياً).
 */
export async function reconcileInventory(): Promise<ReconcileResult[]> {
  const db = getDb();
  if (!db) return [];

  const negativeRows = await db
    .select()
    .from(branchStock)
    .where(sql`${branchStock.quantity} < 0`);

  // «وضع الافتتاح» (١٨/٧): أثناء النافذة الفعّالة يكون السالبُ غير المُفتتَح متوقَّعاً بحكم التصميم
  // (بيع نقدي مسموح قبل الجرد الافتتاحي) — يُوسَم لا يُخفى، كي لا يطمس الضجيجُ الانحرافاتِ الحقيقية
  // (سالبُ صنفٍ مُفتتَح = انحراف فعلي دائماً).
  let windowActive = false;
  if (negativeRows.length) {
    const om = (await db.select().from(openingModeSettings).where(eq(openingModeSettings.id, 1)).limit(1))[0];
    windowActive = !!om?.enabled && om.endsAt != null && om.endsAt.getTime() > Date.now();
  }

  const negativeIssues: ReconcileResult[] = negativeRows.map((s) => ({
    entity: "stock",
    id: Number(s.variantId),
    expected: ">=0",
    actual: String(s.quantity),
    drift: String(Math.abs(Number(s.quantity))),
    ...(windowActive && s.openedAt == null ? { note: "متوقع — وضع الافتتاح (بانتظار الجرد الافتتاحي)" } : {}),
  }));

  // 2) مطابقة الحركات ↔ الرصيد. LEFT JOIN كي نلتقط (variant × branch) بلا حركات (يجب أن يكون
  // الرصيد صفراً في هذه الحالة). GROUP BY على (variantId, branchId, quantity) — quantity في المجموعة
  // كي يظهر مباشرةً في SELECT بلا aggregate. HAVING يُصفّي الصفوف الصحيحة (drift=0 AND unknown=0)
  // فلا يعود التقرير بضجيج «كلّ الأصناف مطابقة».
  const rawDrifts = await db.execute(sql`
    SELECT
      bs.variantId AS variantId,
      bs.branchId AS branchId,
      CAST(bs.quantity AS SIGNED) AS actual,
      CAST(COALESCE(SUM(im.signedDelta), 0) AS SIGNED) AS expected,
      CAST(SUM(CASE WHEN im.id IS NOT NULL AND im.signedDelta IS NULL THEN 1 ELSE 0 END) AS SIGNED) AS unknownDeltas
    FROM branchStock bs
    LEFT JOIN inventoryMovements im
      ON im.variantId = bs.variantId AND im.branchId = bs.branchId
    GROUP BY bs.variantId, bs.branchId, bs.quantity
    HAVING NOT (bs.quantity = COALESCE(SUM(im.signedDelta), 0)
      AND SUM(CASE WHEN im.id IS NOT NULL AND im.signedDelta IS NULL THEN 1 ELSE 0 END) = 0)
  `);
  const driftRows = (Array.isArray(rawDrifts) ? rawDrifts[0] : (rawDrifts as { rows?: unknown }).rows) as
    | Array<{ variantId: number; branchId: number; actual: number | string; expected: number | string; unknownDeltas: number | string }>
    | undefined;

  const driftIssues: ReconcileResult[] = [];
  for (const r of driftRows ?? []) {
    const actual = Number(r.actual);
    const expected = Number(r.expected);
    const unknownDeltas = Number(r.unknownDeltas);
    const drift = actual - expected;
    const parts: string[] = [`فرع ${Number(r.branchId)}`];
    if (unknownDeltas > 0) {
      parts.push(`${unknownDeltas} حركة بلا signedDelta (قبل 0265) ⇒ المجموع غير حاسم`);
    } else {
      parts.push("كلّ الحركات موقَّعة ⇒ انحراف حقيقيّ");
    }
    driftIssues.push({
      entity: "movementDrift",
      id: Number(r.variantId),
      expected: String(expected),
      actual: String(actual),
      drift: String(Math.abs(drift)),
      note: parts.join(" · "),
    });
  }

  return [...negativeIssues, ...driftIssues];
}

/** التحقق من سلامة قيد الأرباح: revenue - cost == profit لكل قيد. */
export async function reconcileLedgerProfit(): Promise<ReconcileResult[]> {
  const db = getDb();
  if (!db) return [];

  const entries = await db
    .select({
      id: accountingEntries.id,
      revenue: accountingEntries.revenue,
      cost: accountingEntries.cost,
      profit: accountingEntries.profit,
    })
    .from(accountingEntries)
    .where(
      and(
        // LEDGER-PROFIT (تدقيق ٢/٧): الثابت profit=revenue−cost لا يصحّ إلا لقيود البيع (SALE) ومرتجع
        // البيع (RETURN بلا supplierId) — وهي وحدها تحمل ثلاثية P&L متّسقة. قيود PURCHASE ومرتجع الشراء
        // تُعبّئ cost فقط (revenue/profit=0 افتراضاً) فكانت تُفلَّق كانحرافٍ زائف يُغرِق التقرير بالضجيج.
        inArray(accountingEntries.entryType, ["SALE", "RETURN"]),
        sql`(${accountingEntries.entryType} <> 'RETURN' OR ${accountingEntries.supplierId} IS NULL)`,
        sql`${accountingEntries.revenue} IS NOT NULL`,
        sql`${accountingEntries.cost} IS NOT NULL`,
        sql`${accountingEntries.profit} IS NOT NULL`
      )
    );

  return entries
    .filter((e) => {
      const expected = money(String(e.revenue ?? 0)).minus(money(String(e.cost ?? 0)));
      return money(String(e.profit ?? 0))
        .minus(expected)
        .abs()
        .greaterThan("0.01");
    })
    .map((e) => {
      const expected = money(String(e.revenue ?? 0)).minus(money(String(e.cost ?? 0)));
      return {
        entity: "ledger",
        id: Number(e.id),
        expected: expected.toFixed(2),
        actual: String(e.profit ?? 0),
        drift: money(String(e.profit ?? 0)).minus(expected).abs().toFixed(2),
      };
    });
}

/**
 * Tier-2 #4 (٢٦/٨) — **سلامة الربط بين طلب المتجر والإرسالية.**
 *
 * `deliveryConsignments.sourceType='ONLINE_ORDER'` + `sourceId=onlineOrders.id` رابطُ
 * منشئي الطرد الأصليّ. الحالات الحاكمة التي يجب أن تظلّ متّسقة، وأيّ انحراف بينها يعني
 * عرضاً مكذوباً للعميل والموظّف معاً (يظهر «شُحن» بلا إرسالية، أو «مُسلَّم» بلا تسليم):
 *
 *   1) **طلبٌ SHIPPED/DELIVERED بلا إرسالية** — إن كان في نطاق العقد الحديث فقط:
 *      يشترط env `ONLINE_ORDER_CONSIGNMENT_REQUIRED_FROM` (ISO date). قبل هذا التاريخ
 *      كان `setOnlineOrderStatus` يسمح بشحنةٍ مباشرةً بلا إرسالية (مسار قديم مدعوم في
 *      `courier.ts:147-170` و`courierPerformance.ts:178-206`). غياب المتغيّر ⇒ نُعطّل
 *      هذا الكاشف بالكامل (fail-open) لأنّ الكشفَ الكاذب على تاريخٍ كامل أسوأ من عدم
 *      الفحص. الجذر: Codex P2 #3 على PR #823.
 *
 *   2) **حالتان طرفيّتان (Terminal)**: DELIVERED و RETURNED و CANCELLED (مطابقٌ لـ
 *      `delivery/guards.ts:37-39`). كلٌّ من الحدَّين قد يصير طرفيّاً بمعزل عن الآخر:
 *      إلغاءُ بيعٍ بعد التسليم يترك الإرسالية DELIVERED والطلب CANCELLED — هذا مسارٌ
 *      مدعوم (`sale/cancel.ts:710-722`) لا تحذير. الجذر: Codex P2 #4 على PR #823.
 *
 *   3) **الاتّجاهان معاً**: نفحص عدم التطابق من طرف الطلب **ومن طرف الإرسالية**. كان
 *      الفحص من طرف الطلب وحده يترك «الإرسالية DELIVERED والطلب لا يزال SHIPPED» بلا
 *      كشف — الزبون يرى في المتجر «قيد التوصيل» بينما المندوب أثبت التسليم. الجذر:
 *      Codex P2 #5 على PR #823.
 *
 *   4) **تعارض جهة التوصيل**: `onlineOrders.deliveryPartyId ≠ deliveryConsignments.partyId`.
 *
 * القراءةُ فقط، دون كتابةٍ في جداول الأعمال — الإصلاح يدويٌّ (المدير يفتح الطلب ويصحّح).
 */

/** الحالات الطرفيّة للإرسالية — مطابقة لـ`delivery/guards.ts:37-39`. */
const TERMINAL_PARCEL_STATUSES = new Set(["DELIVERED", "RETURNED", "CANCELLED"]);

export async function reconcileOnlineOrderConsignmentSync(): Promise<ReconcileResult[]> {
  const db = getDb();
  if (!db) return [];
  const issues: ReconcileResult[] = [];

  // 1) طلبٌ SHIPPED/DELIVERED بلا إرسالية — يحكمه cutover env: بلا cutover لا كاشف.
  const cutoverRaw = process.env.ONLINE_ORDER_CONSIGNMENT_REQUIRED_FROM;
  const cutover = cutoverRaw ? new Date(cutoverRaw) : null;
  if (cutover && !isNaN(cutover.getTime())) {
    const orphanShipped = await db
      .select({ id: onlineOrders.id, orderNumber: onlineOrders.orderNumber, status: onlineOrders.status })
      .from(onlineOrders)
      .leftJoin(
        deliveryConsignments,
        and(
          eq(deliveryConsignments.sourceType, "ONLINE_ORDER"),
          eq(deliveryConsignments.sourceId, onlineOrders.id),
        ),
      )
      .where(and(
        inArray(onlineOrders.status, ["SHIPPED", "DELIVERED"]),
        gte(onlineOrders.createdAt, cutover),
        sql`${deliveryConsignments.id} IS NULL`,
      ));
    for (const row of orphanShipped) {
      issues.push({
        entity: "orderShippedWithoutConsignment",
        id: Number(row.id),
        expected: "consignment-exists",
        actual: "none",
        drift: "1",
        note: `طلب ${row.orderNumber} حالته ${row.status} بلا إرسالية مُنشَأة`,
      });
    }
  }

  // 2/3/4) الحالات المزدوجة — INNER JOIN.
  const linked = await db
    .select({
      orderId: onlineOrders.id,
      orderNumber: onlineOrders.orderNumber,
      orderStatus: onlineOrders.status,
      orderPartyId: onlineOrders.deliveryPartyId,
      consignmentId: deliveryConsignments.id,
      consignmentNumber: deliveryConsignments.consignmentNumber,
      parcelStatus: deliveryConsignments.parcelStatus,
      consignmentPartyId: deliveryConsignments.partyId,
    })
    .from(onlineOrders)
    .innerJoin(
      deliveryConsignments,
      and(
        eq(deliveryConsignments.sourceType, "ONLINE_ORDER"),
        eq(deliveryConsignments.sourceId, onlineOrders.id),
      ),
    );

  for (const row of linked) {
    // 2) طلب DELIVERED × إرسالية ≠ DELIVERED (باقٍ حرفياً — لا تسليمَ يُعدّ مُنجَزاً حتى تُختم الإرسالية).
    if (row.orderStatus === "DELIVERED" && row.parcelStatus !== "DELIVERED") {
      issues.push({
        entity: "orderDeliveredConsignmentNotDelivered",
        id: Number(row.orderId),
        expected: "parcelStatus=DELIVERED",
        actual: `parcelStatus=${row.parcelStatus}`,
        drift: "1",
        note: `طلب ${row.orderNumber} مُسلَّم لكن الإرسالية ${row.consignmentNumber} حالتها ${row.parcelStatus}`,
      });
    }

    // 3) طلب CANCELLED × إرسالية غير طرفيّة (Codex P2 #4: DELIVERED مقبولٌ إذا أُلغيَ البيع لاحقاً).
    if (row.orderStatus === "CANCELLED" && !TERMINAL_PARCEL_STATUSES.has(row.parcelStatus)) {
      issues.push({
        entity: "orderCancelledConsignmentLive",
        id: Number(row.orderId),
        expected: "parcelStatus∈{DELIVERED,CANCELLED,RETURNED}",
        actual: `parcelStatus=${row.parcelStatus}`,
        drift: "1",
        note: `طلب ${row.orderNumber} مُلغى لكن الإرسالية ${row.consignmentNumber} حيّة بحالة ${row.parcelStatus}`,
      });
    }

    // 3-عكسي) إرسالية DELIVERED × طلب لا يذكر أنه مُسلَّم أو مُلغى (Codex P2 #5).
    if (row.parcelStatus === "DELIVERED" && row.orderStatus !== "DELIVERED" && row.orderStatus !== "CANCELLED") {
      issues.push({
        entity: "consignmentDeliveredOrderNotDelivered",
        id: Number(row.orderId),
        expected: "orderStatus∈{DELIVERED,CANCELLED}",
        actual: `orderStatus=${row.orderStatus}`,
        drift: "1",
        note: `الإرسالية ${row.consignmentNumber} مُسلَّمة لكن الطلب ${row.orderNumber} حالته ${row.orderStatus}`,
      });
    }

    // 3-عكسي ب) إرسالية CANCELLED/RETURNED × طلب لا يزال قبل-طرفيّ.
    if (
      (row.parcelStatus === "CANCELLED" || row.parcelStatus === "RETURNED") &&
      row.orderStatus !== "CANCELLED" && row.orderStatus !== "DELIVERED"
    ) {
      issues.push({
        entity: "consignmentTerminalOrderPreTerminal",
        id: Number(row.orderId),
        expected: "orderStatus∈{CANCELLED,DELIVERED}",
        actual: `orderStatus=${row.orderStatus}`,
        drift: "1",
        note: `الإرسالية ${row.consignmentNumber} حالتها ${row.parcelStatus} لكن الطلب ${row.orderNumber} حالته ${row.orderStatus}`,
      });
    }

    // 4) تعارض جهة التوصيل.
    if (
      row.orderPartyId != null &&
      Number(row.orderPartyId) !== Number(row.consignmentPartyId)
    ) {
      issues.push({
        entity: "orderConsignmentPartyMismatch",
        id: Number(row.orderId),
        expected: `partyId=${row.consignmentPartyId}`,
        actual: `partyId=${row.orderPartyId}`,
        drift: "1",
        note: `طلب ${row.orderNumber}: الطلب يذكر جهة ${row.orderPartyId} والإرسالية ${row.consignmentNumber} مُسنَدةٌ للجهة ${row.consignmentPartyId}`,
      });
    }
  }

  return issues;
}

/**
 * Tier-3 #5 (٢٧/٨) — **حارس أيتام journalLines**: يمسك خرقَ عقد الكاتب بعد Tier-3 #2/#4.
 *
 * بعد أن أصبحت `journalLines.accountId` و`journalLines.customerId`/`supplierId`/… تُملأ
 * تلقائياً من رأس القيد (`writeJournal` يجلب الأبعاد قبل الإدراج)، أيُّ سطرٍ يظهر بـ
 * `accountId=NULL` رغم أنّ الرأس `POSTED` يعني واحداً من:
 *   • كتابةٌ قديمة سبقت الهجرات ولم يمسّها backfill (تسريبٌ من `_legacy/`).
 *   • كتابةٌ جديدة بـ`role` لا يُطابق أيّ `accounts.systemRole` (drift مُنشأ خدمياً).
 *   • تعديلٌ يدويّ صامت على الجدول (خرقُ الطبقة).
 * الحارس يعمل شهرياً في `reconcileScheduler` — رصدٌ مبكّرٌ يمنع تراكم الفجوة.
 *
 * **الحالات الطرفيّة المُستَبعَدة عمداً:**
 *   - `journalEntries.status='UNMAPPED'` أو `'MEMO'`: هذه رؤوسٌ بلا أسطر أو بأسطرٍ لا
 *     تدخل ميزان المراجعة — لا يُطبَّق عليها العقد ولا نحاسبها هنا.
 *   - `sourceType='SHADOW_OPENING'`: قد تحمل روِلاً بلا حسابٍ مطابق (بيانات استيراد
 *     تاريخية) — نستثنيها لأنّ backfill هجرة 0270 يُغطّي ما يمكن تغطيته.
 *
 * القراءةُ فقط، دون كتابةٍ — الإصلاحُ يدويّ (إضافة الحساب في `accounts` أو تصحيح الرأس).
 */
export async function reconcileOrphanJournalLines(): Promise<ReconcileResult[]> {
  const db = getDb();
  if (!db) return [];

  const orphans = await db
    .select({
      lineId: journalLines.id,
      role: journalLines.role,
      journalId: journalLines.journalId,
      entryId: journalEntries.entryId,
      sourceType: journalEntries.sourceType,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalId))
    .where(and(
      sql`${journalLines.accountId} IS NULL`,
      eq(journalEntries.status, "POSTED"),
      sql`${journalEntries.sourceType} = 'ACCOUNTING_ENTRY'`,
    ));

  const issues: ReconcileResult[] = [];
  // نجمعُ روِلاً غير معروف مرّةً واحدة (قد يظهر آلاف الأسطر بنفس role الشاذّ ⇒ ضجيج).
  const rolesWithoutAccount = new Set<string>();
  for (const row of orphans) {
    if (!rolesWithoutAccount.has(row.role)) {
      const [accountMatch] = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.systemRole, row.role))
        .limit(1);
      if (!accountMatch) rolesWithoutAccount.add(row.role);
    }
    const roleHasAccount = !rolesWithoutAccount.has(row.role);
    issues.push({
      entity: roleHasAccount ? "journalLineMissingBackfill" : "journalLineUnknownRole",
      id: Number(row.lineId),
      expected: "accountId=<accounts.id>",
      actual: "NULL",
      drift: "1",
      note: roleHasAccount
        ? `سطرٌ في القيد ${row.entryId} بـrole=${row.role} — الحساب موجود لكنّ backfill لم يشمله (يُصلَح بإعادة كتابة).`
        : `سطرٌ في القيد ${row.entryId} بـrole=${row.role} — لا حسابَ بهذا systemRole (drift في الخريطة).`,
    });
  }

  return issues;
}
