/**
 * عمليات محفظة المزوّد (ش٩): إيداع، سحب، تعديل باعتمادٍ ثانٍ، كشف حساب، مطابقة يومية.
 *
 * الثابت الحاكم (معيار خروج ش٩): **رصيد الجهاز يُعاد إنتاجه من سجلّ حركاته** —
 * `currentBalance` ليس رقماً مستقلاً بل حاصلُ جمع حركات `digitalWalletTransactions` بإشاراتها،
 * وكل حركة تحمل `balanceAfter` المحسوب تحت القفل. `assertBalanceReproducible` تُثبت ذلك.
 *
 * المعالجة المحاسبية (§٦.١): الإيداع **حركة أصل** لا مشترياتٍ ولا مصروفاً —
 * سند صرف OUT من الخزينة + قيد `DIGITAL_WALLET_DEPOSIT` بصفر أثر P&L.
 *
 * فصل المهام: طلب التعديل (`requestAdjustment`) لا يمسّ الرصيد؛ الاعتماد بمديرٍ **آخر**
 * (`approveAdjustment`) هو ما يُحرّكه — نفس اصطلاح تسوية المخزون وسندات الصرف.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import {
  auditLogs,
  branches,
  digitalProviders,
  digitalWalletReconciliations,
  digitalWalletTransactions,
  digitalWallets,
  receipts,
  suppliers,
  users,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { postEntry } from "../ledgerService";
import { money, sumMoney, toDbMoney } from "../money";
import type { Actor } from "../tx";
import { redactAuditValue } from "../auditService";

/** الحركات التي تزيد الرصيد؛ ما عداها يُنقصه. مصدرُ حقيقةٍ واحد لإشارة كل نوع. */
const INBOUND_TYPES = new Set(["OPENING", "DEPOSIT", "SALE_REVERSAL"]);

function signedAmount(type: string, direction: string, amount: string) {
  // الاتجاه المخزَّن هو الحاكم؛ النوع تصنيفٌ دلاليّ. كلاهما يُكتب معاً ولا ينفصلان.
  return direction === "IN" ? money(amount) : money(amount).neg();
}

async function auditLog(tx: Tx, actor: Actor, action: string, entityId: number, details: unknown): Promise<void> {
  try {
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: actor.branchId,
      action,
      entityType: "digitalWallet",
      entityId: String(entityId),
      newValue: redactAuditValue(details),
    });
  } catch {
    // best-effort
  }
}

/** يقفل المحفظة ويعيد صفّها — كل تغييرِ رصيدٍ يمرّ من هنا. */
async function lockWallet(tx: Tx, walletId: number) {
  const [w] = await tx.select().from(digitalWallets).where(eq(digitalWallets.id, walletId)).for("update");
  if (!w) throw new TRPCError({ code: "NOT_FOUND", message: "المحفظة غير موجودة" });
  return w;
}

function assertWalletBranch(branchId: number, actor: Actor): void {
  if (actor.role !== "admin" && Number(actor.branchId) !== branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "رصيد جهاز المزوّد يخص فرعاً آخر" });
  }
}

/** يُنشئ حركة محفظة ويُحدّث الرصيد ذرّياً. القلب المشترك لكل عمليات ش٩. */
async function applyWalletMovement(
  tx: Tx,
  input: {
    walletId: number;
    type: "OPENING" | "DEPOSIT" | "WITHDRAWAL" | "ADJUSTMENT" | "SALE_CONSUMPTION" | "SALE_REVERSAL";
    amount: string;
    direction: "IN" | "OUT";
    transactionNumber: string;
    clientRequestId: string;
    receiptId?: number | null;
    notes?: string | null;
    status?: "ACTIVE" | "PENDING_APPROVAL";
    approvedBy?: number | null;
  },
  actor: Actor,
): Promise<{ transactionId: number; balanceAfter: string }> {
  const w = await lockWallet(tx, input.walletId);
  assertWalletBranch(Number(w.branchId), actor);
  if (!w.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: `المحفظة «${w.name}» معطَّلة` });

  const delta = signedAmount(input.type, input.direction, input.amount);
  if (money(input.amount).lte(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ يجب أن يكون أكبر من صفر" });
  }
  const next = money(w.currentBalance).plus(delta);
  if (next.lt(0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `العملية تجعل رصيد «${w.name}» سالباً (المتوفّر ${w.currentBalance})`,
    });
  }
  // السحب لا يمسّ المحجوز: المحجوز التزامٌ لعمليات بيعٍ جارية، فلا يُسحب من تحتها.
  if (input.direction === "OUT" && next.lt(money(w.reservedBalance))) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `لا يمكن السحب تحت الرصيد المحجوز (${w.reservedBalance}) — أنهِ عمليات البيع الجارية أوّلاً`,
    });
  }

  const res = await tx.insert(digitalWalletTransactions).values({
    walletId: input.walletId,
    branchId: Number(w.branchId),
    type: input.type,
    direction: input.direction,
    amount: toDbMoney(money(input.amount)),
    balanceAfter: toDbMoney(next),
    transactionNumber: input.transactionNumber,
    clientRequestId: input.clientRequestId,
    receiptId: input.receiptId ?? null,
    status: input.status ?? "ACTIVE",
    approvedBy: input.approvedBy ?? null,
    createdBy: actor.userId,
    notes: input.notes ?? null,
  });
  const transactionId = extractInsertId(res);

  await tx
    .update(digitalWallets)
    .set({ currentBalance: toDbMoney(next) })
    .where(eq(digitalWallets.id, input.walletId));

  return { transactionId, balanceAfter: toDbMoney(next) };
}

/* ────────── الإيداع (§٦.١) ────────── */

export async function deposit(
  tx: Tx,
  input: {
    walletId: number;
    amount: string;
    paymentMethod: "CASH" | "TRANSFER";
    clientRequestId: string;
    notes?: string | null;
  },
  actor: Actor,
): Promise<{ transactionId: number; receiptId: number; balanceAfter: string }> {
  const w = await lockWallet(tx, input.walletId);
  const amount = money(input.amount);

  const [prov] = await tx
    .select({ supplierName: suppliers.name })
    .from(digitalProviders)
    .innerJoin(suppliers, eq(digitalProviders.supplierId, suppliers.id))
    .where(eq(digitalProviders.id, Number(w.providerId)))
    .limit(1);

  // سند صرف OUT من الخزينة (لا من درج الكاشير) — النقد خرج فعلاً إلى جهاز المزوّد.
  const receiptRes = await tx.insert(receipts).values({
    branchId: Number(w.branchId),
    shiftId: null,
    direction: "OUT",
    amount: toDbMoney(amount),
    paymentMethod: input.paymentMethod,
    cashBucket: input.paymentMethod === "CASH" ? "TREASURY" : null,
    referenceNumber: input.clientRequestId,
    status: "COMPLETED",
    partyType: "OTHER",
    description: `إيداع رصيد في محفظة «${w.name}» لدى ${prov?.supplierName ?? "مزوّد"}${input.notes ? " — " + input.notes : ""}`,
    createdBy: actor.userId,
  });
  const receiptId = extractInsertId(receiptRes);

  const mv = await applyWalletMovement(
    tx,
    {
      walletId: input.walletId,
      type: "DEPOSIT",
      amount: toDbMoney(amount),
      direction: "IN",
      transactionNumber: `DWD-${input.walletId}-${receiptId}`,
      clientRequestId: input.clientRequestId,
      receiptId,
      notes: input.notes ?? null,
    },
    actor,
  );

  // حركة أصل: صفر أثر P&L — ليست مشترياتٍ ولا مصروفاً (§٦.١).
  await postEntry(tx, {
    entryType: "DIGITAL_WALLET_DEPOSIT",
    branchId: Number(w.branchId),
    receiptId,
    digitalWalletId: input.walletId,
    amount,
    revenue: money(0),
    cost: money(0),
    profit: money(0),
    dedupeKey: `DIGITAL:WDEP:${mv.transactionId}`,
    notes: "إيداع رصيد محفظة كروت",
    createdBy: actor.userId,
  });

  await auditLog(tx, actor, "digitalCards.wallet.deposit", input.walletId, {
    amount: toDbMoney(amount),
    balanceAfter: mv.balanceAfter,
  });
  return { ...mv, receiptId };
}

/* ────────── السحب ────────── */

export async function withdraw(
  tx: Tx,
  input: {
    walletId: number;
    amount: string;
    paymentMethod: "CASH" | "TRANSFER";
    clientRequestId: string;
    notes?: string | null;
  },
  actor: Actor,
): Promise<{ transactionId: number; receiptId: number; balanceAfter: string }> {
  const w = await lockWallet(tx, input.walletId);
  const amount = money(input.amount);

  // سند قبض IN إلى الخزينة — الرصيد عاد من جهاز المزوّد إلينا.
  const receiptRes = await tx.insert(receipts).values({
    branchId: Number(w.branchId),
    shiftId: null,
    direction: "IN",
    amount: toDbMoney(amount),
    paymentMethod: input.paymentMethod,
    cashBucket: input.paymentMethod === "CASH" ? "TREASURY" : null,
    referenceNumber: input.clientRequestId,
    status: "COMPLETED",
    partyType: "OTHER",
    description: `سحب رصيد من محفظة «${w.name}»${input.notes ? " — " + input.notes : ""}`,
    createdBy: actor.userId,
  });
  const receiptId = extractInsertId(receiptRes);

  const mv = await applyWalletMovement(
    tx,
    {
      walletId: input.walletId,
      type: "WITHDRAWAL",
      amount: toDbMoney(amount),
      direction: "OUT",
      transactionNumber: `DWW-${input.walletId}-${receiptId}`,
      clientRequestId: input.clientRequestId,
      receiptId,
      notes: input.notes ?? null,
    },
    actor,
  );

  await postEntry(tx, {
    entryType: "DIGITAL_WALLET_WITHDRAWAL",
    branchId: Number(w.branchId),
    receiptId,
    digitalWalletId: input.walletId,
    amount,
    revenue: money(0),
    cost: money(0),
    profit: money(0),
    dedupeKey: `DIGITAL:WWDR:${mv.transactionId}`,
    notes: "سحب رصيد محفظة كروت",
    createdBy: actor.userId,
  });

  await auditLog(tx, actor, "digitalCards.wallet.withdraw", input.walletId, {
    amount: toDbMoney(amount),
    balanceAfter: mv.balanceAfter,
  });
  return { ...mv, receiptId };
}

/* ────────── التعديل باعتمادٍ ثانٍ (SOD) ────────── */

/**
 * طلب تعديل رصيد — **لا يمسّ الرصيد إطلاقاً**. يُنشئ حركةً بحالة `PENDING_APPROVAL`
 * تبقى محايدةً حتى يعتمدها مديرٌ **آخر**. سببُ الفصل: تعديل الرصيد يدوياً هو الباب
 * الوحيد لتغطية عجزٍ أو اختلاس، فلا يُترك لفاعلٍ واحد.
 */
export async function requestAdjustment(
  tx: Tx,
  input: { walletId: number; amount: string; direction: "IN" | "OUT"; reason: string; clientRequestId: string },
  actor: Actor,
): Promise<{ transactionId: number }> {
  const w = await lockWallet(tx, input.walletId);
  if (!w.isActive) {
    throw new TRPCError({ code: "CONFLICT", message: "المحفظة معطّلة ولا تقبل تعديلات جديدة" });
  }
  const amount = money(input.amount);
  if (amount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ يجب أن يكون أكبر من صفر" });
  const reason = input.reason.trim();
  if (!reason) throw new TRPCError({ code: "BAD_REQUEST", message: "سبب التعديل مطلوب" });

  const res = await tx.insert(digitalWalletTransactions).values({
    walletId: input.walletId,
    branchId: Number(w.branchId),
    type: "ADJUSTMENT",
    direction: input.direction,
    amount: toDbMoney(amount),
    // الرصيد **لم يتغيّر بعد**: نُثبّت الرصيد الحاليّ كمرجع، ويُعاد حسابه عند الاعتماد تحت القفل.
    balanceAfter: w.currentBalance,
    transactionNumber: `DWA-${input.walletId}-${input.clientRequestId.slice(0, 12)}`,
    clientRequestId: input.clientRequestId,
    status: "PENDING_APPROVAL",
    createdBy: actor.userId,
    notes: reason,
  });
  const transactionId = extractInsertId(res);

  await auditLog(tx, actor, "digitalCards.wallet.adjustRequested", input.walletId, {
    amount: toDbMoney(amount),
    direction: input.direction,
  });
  return { transactionId };
}

export async function approveAdjustment(
  tx: Tx,
  input: { transactionId: number },
  actor: Actor,
): Promise<{ transactionId: number; balanceAfter: string }> {
  const [pending] = await tx
    .select()
    .from(digitalWalletTransactions)
    .where(eq(digitalWalletTransactions.id, input.transactionId))
    .for("update");
  if (!pending) throw new TRPCError({ code: "NOT_FOUND", message: "طلب التعديل غير موجود" });
  if (pending.status !== "PENDING_APPROVAL") {
    throw new TRPCError({ code: "CONFLICT", message: "الطلب عولِج مسبقاً" });
  }
  // فصل المهام: المُعتمِد ≠ الطالب. مالك النظام وحده مستثنى بصفته المرجع النهائي.
  if (Number(pending.createdBy) === actor.userId && !actor.isOwner) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا يعتمد التعديل من طلبه — يلزم مديرٌ آخر",
    });
  }

  const walletId = Number(pending.walletId);
  const w = await lockWallet(tx, walletId);
  assertWalletBranch(Number(w.branchId), actor);
  const delta = signedAmount(pending.type, pending.direction, pending.amount);
  const next = money(w.currentBalance).plus(delta);
  if (next.lt(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الاعتماد يجعل الرصيد سالباً — راجِع المبلغ" });
  }
  if (pending.direction === "OUT" && next.lt(money(w.reservedBalance))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الاعتماد ينزل بالرصيد تحت المحجوز" });
  }

  await tx
    .update(digitalWalletTransactions)
    .set({ status: "ACTIVE", approvedBy: actor.userId, approvedAt: new Date(), balanceAfter: toDbMoney(next) })
    .where(and(eq(digitalWalletTransactions.id, input.transactionId), eq(digitalWalletTransactions.status, "PENDING_APPROVAL")));

  await tx.update(digitalWallets).set({ currentBalance: toDbMoney(next) }).where(eq(digitalWallets.id, walletId));

  await postEntry(tx, {
    entryType: "DIGITAL_WALLET_ADJUSTMENT",
    branchId: Number(w.branchId),
    digitalWalletId: walletId,
    amount: money(pending.amount),
    revenue: money(0),
    cost: money(0),
    profit: money(0),
    dedupeKey: `DIGITAL:WADJ:${input.transactionId}`,
    notes: `تعديل رصيد محفظة (${pending.direction}) — ${pending.notes ?? ""}`.trim(),
    createdBy: actor.userId,
  });

  await auditLog(tx, actor, "digitalCards.wallet.adjustApproved", walletId, {
    transactionId: input.transactionId,
    balanceAfter: toDbMoney(next),
  });
  return { transactionId: input.transactionId, balanceAfter: toDbMoney(next) };
}

export async function rejectAdjustment(
  tx: Tx,
  input: { transactionId: number; reason?: string | null },
  actor: Actor,
): Promise<void> {
  const [pending] = await tx
    .select()
    .from(digitalWalletTransactions)
    .where(eq(digitalWalletTransactions.id, input.transactionId))
    .for("update");
  if (!pending) throw new TRPCError({ code: "NOT_FOUND", message: "طلب التعديل غير موجود" });
  if (pending.status !== "PENDING_APPROVAL") {
    throw new TRPCError({ code: "CONFLICT", message: "الطلب عولِج مسبقاً" });
  }
  await tx
    .update(digitalWalletTransactions)
    .set({ status: "REVERSED", approvedBy: actor.userId, approvedAt: new Date() })
    .where(and(eq(digitalWalletTransactions.id, input.transactionId), eq(digitalWalletTransactions.status, "PENDING_APPROVAL")));
  await auditLog(tx, actor, "digitalCards.wallet.adjustRejected", Number(pending.walletId), {
    transactionId: input.transactionId,
    reason: input.reason ?? null,
  });
}

/* ────────── كشف الحساب ────────── */

export async function statement(
  db: DB,
  input: { walletId: number; from?: string; to?: string; limit?: number },
) {
  const creator = alias(users, "digitalWalletCreator");
  const approver = alias(users, "digitalWalletApprover");
  const conds = [eq(digitalWalletTransactions.walletId, input.walletId)];
  if (input.from) conds.push(gte(digitalWalletTransactions.createdAt, new Date(`${input.from}T00:00:00Z`)));
  if (input.to) conds.push(lt(digitalWalletTransactions.createdAt, new Date(`${input.to}T00:00:00Z`)));

  const rows = await db
    .select({
      id: digitalWalletTransactions.id,
      transactionNumber: digitalWalletTransactions.transactionNumber,
      type: digitalWalletTransactions.type,
      direction: digitalWalletTransactions.direction,
      amount: digitalWalletTransactions.amount,
      balanceAfter: digitalWalletTransactions.balanceAfter,
      status: digitalWalletTransactions.status,
      invoiceId: digitalWalletTransactions.invoiceId,
      receiptId: digitalWalletTransactions.receiptId,
      notes: digitalWalletTransactions.notes,
      createdAt: digitalWalletTransactions.createdAt,
      createdBy: digitalWalletTransactions.createdBy,
      createdByName: creator.name,
      createdByUsername: creator.username,
      approvedBy: digitalWalletTransactions.approvedBy,
      approvedByName: approver.name,
      approvedByUsername: approver.username,
      approvedAt: digitalWalletTransactions.approvedAt,
    })
    .from(digitalWalletTransactions)
    .leftJoin(creator, eq(digitalWalletTransactions.createdBy, creator.id))
    .leftJoin(approver, eq(digitalWalletTransactions.approvedBy, approver.id))
    .where(and(...conds))
    .orderBy(desc(digitalWalletTransactions.id))
    .limit(Math.min(input.limit ?? 200, 500));

  return rows;
}

/**
 * معيار خروج ش٩: الرصيد المخزَّن = مجموع الحركات **الفعّالة** بإشاراتها.
 * طلبات التعديل المعلّقة والمرفوضة لا تدخل الحساب (لم تمسّ الرصيد أصلاً).
 */
export async function reproduceBalance(db: DB, walletId: number): Promise<string> {
  const rows = await db
    .select({
      type: digitalWalletTransactions.type,
      direction: digitalWalletTransactions.direction,
      amount: digitalWalletTransactions.amount,
    })
    .from(digitalWalletTransactions)
    .where(and(eq(digitalWalletTransactions.walletId, walletId), eq(digitalWalletTransactions.status, "ACTIVE")))
    .orderBy(asc(digitalWalletTransactions.id));
  return toDbMoney(sumMoney(rows.map((r) => signedAmount(r.type, r.direction, r.amount))));
}

export async function assertBalanceReproducible(db: DB, walletId: number): Promise<boolean> {
  const [w] = await db
    .select({ currentBalance: digitalWallets.currentBalance })
    .from(digitalWallets)
    .where(eq(digitalWallets.id, walletId))
    .limit(1);
  if (!w) return false;
  return money(await reproduceBalance(db, walletId)).eq(money(w.currentBalance));
}

/* ────────── المطابقة اليومية (§٥.١١) ────────── */

/**
 * تسجيل الرصيد الفعليّ الظاهر على جهاز المزوّد ومقارنته بالمتوقَّع.
 * **لا تُعدّل الرصيد إطلاقاً** — معالجة الفرق تكون بطلب `ADJUSTMENT` مستقلّ باعتمادٍ ثانٍ.
 */
export async function reconcile(
  tx: Tx,
  input: { walletId: number; businessDate: string; actualBalance: string; notes?: string | null },
  actor: Actor,
): Promise<{ reconciliationId: number; expectedBalance: string; variance: string; status: string }> {
  const w = await lockWallet(tx, input.walletId);
  assertWalletBranch(Number(w.branchId), actor);
  const expected = money(w.currentBalance);
  const actual = money(input.actualBalance);
  if (actual.lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "الرصيد الفعليّ لا يكون سالباً" });
  const variance = actual.minus(expected); // موقَّع: سالب = عجز، موجب = زيادة.
  const status = variance.isZero() ? "MATCHED" : "VARIANCE_OPEN";

  const [existing] = await tx
    .select({ id: digitalWalletReconciliations.id })
    .from(digitalWalletReconciliations)
    .where(
      and(
        eq(digitalWalletReconciliations.walletId, input.walletId),
        eq(digitalWalletReconciliations.businessDate, input.businessDate),
      ),
    )
    .limit(1);
  if (existing) {
    throw new TRPCError({ code: "CONFLICT", message: "سُجّلت مطابقة لهذه المحفظة في هذا اليوم" });
  }

  const res = await tx.insert(digitalWalletReconciliations).values({
    walletId: input.walletId,
    branchId: Number(w.branchId),
    businessDate: input.businessDate,
    expectedBalance: toDbMoney(expected),
    actualBalance: toDbMoney(actual),
    variance: toDbMoney(variance),
    status: status as "MATCHED" | "VARIANCE_OPEN",
    countedBy: actor.userId,
    notes: input.notes ?? null,
  });
  const reconciliationId = extractInsertId(res);

  await auditLog(tx, actor, "digitalCards.wallet.reconciled", input.walletId, {
    businessDate: input.businessDate,
    variance: toDbMoney(variance),
    status,
  });

  return { reconciliationId, expectedBalance: toDbMoney(expected), variance: toDbMoney(variance), status };
}

export async function listReconciliations(db: DB, filters: { walletId?: number; branchId?: number | null; status?: string }) {
  const counter = alias(users, "digitalReconciliationCounter");
  const reviewer = alias(users, "digitalReconciliationReviewer");
  const conds = [];
  if (filters.walletId != null) conds.push(eq(digitalWalletReconciliations.walletId, filters.walletId));
  if (filters.branchId != null) conds.push(eq(digitalWalletReconciliations.branchId, filters.branchId));
  if (filters.status) {
    conds.push(eq(digitalWalletReconciliations.status, filters.status as "MATCHED" | "VARIANCE_OPEN" | "RESOLVED"));
  }
  return db
    .select({
      id: digitalWalletReconciliations.id,
      walletId: digitalWalletReconciliations.walletId,
      walletName: digitalWallets.name,
      branchName: branches.name,
      businessDate: digitalWalletReconciliations.businessDate,
      expectedBalance: digitalWalletReconciliations.expectedBalance,
      actualBalance: digitalWalletReconciliations.actualBalance,
      variance: digitalWalletReconciliations.variance,
      status: digitalWalletReconciliations.status,
      notes: digitalWalletReconciliations.notes,
      countedBy: digitalWalletReconciliations.countedBy,
      countedByName: counter.name,
      countedByUsername: counter.username,
      reviewedBy: digitalWalletReconciliations.reviewedBy,
      reviewedByName: reviewer.name,
      reviewedByUsername: reviewer.username,
      reviewedAt: digitalWalletReconciliations.reviewedAt,
      createdAt: digitalWalletReconciliations.createdAt,
    })
    .from(digitalWalletReconciliations)
    .innerJoin(digitalWallets, eq(digitalWalletReconciliations.walletId, digitalWallets.id))
    .innerJoin(branches, eq(digitalWalletReconciliations.branchId, branches.id))
    .leftJoin(counter, eq(digitalWalletReconciliations.countedBy, counter.id))
    .leftJoin(reviewer, eq(digitalWalletReconciliations.reviewedBy, reviewer.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(digitalWalletReconciliations.businessDate))
    .limit(200);
}

/** يربط فرقاً مُعالَجاً بتعديلٍ معتمَد ويقفل المطابقة. */
export async function resolveVariance(
  tx: Tx,
  input: { reconciliationId: number; adjustmentTransactionId: number },
  actor: Actor,
): Promise<void> {
  const [rec] = await tx
    .select()
    .from(digitalWalletReconciliations)
    .where(eq(digitalWalletReconciliations.id, input.reconciliationId))
    .for("update");
  if (!rec) throw new TRPCError({ code: "NOT_FOUND", message: "المطابقة غير موجودة" });
  assertWalletBranch(Number(rec.branchId), actor);
  if (rec.status !== "VARIANCE_OPEN") {
    throw new TRPCError({ code: "CONFLICT", message: "لا فرق مفتوحاً في هذه المطابقة" });
  }
  const [adj] = await tx
    .select({
      id: digitalWalletTransactions.id,
      walletId: digitalWalletTransactions.walletId,
      status: digitalWalletTransactions.status,
      type: digitalWalletTransactions.type,
      amount: digitalWalletTransactions.amount,
      direction: digitalWalletTransactions.direction,
      notes: digitalWalletTransactions.notes,
      createdAt: digitalWalletTransactions.createdAt,
      approvedAt: digitalWalletTransactions.approvedAt,
    })
    .from(digitalWalletTransactions)
    .where(eq(digitalWalletTransactions.id, input.adjustmentTransactionId))
    .limit(1);
  if (!adj || adj.type !== "ADJUSTMENT" || adj.status !== "ACTIVE") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "يلزم تعديلٌ معتمَد لمعالجة الفرق" });
  }
  if (Number(adj.walletId) !== Number(rec.walletId)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "التعديل يخصّ محفظةً أخرى" });
  }

  const variance = money(rec.variance);
  const expectedDirection = variance.gt(0) ? "IN" : "OUT";
  if (variance.isZero() || adj.direction !== expectedDirection || !money(adj.amount).eq(variance.abs())) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "التعديل لا يطابق فرق المطابقة في المبلغ أو الاتجاه",
    });
  }
  const usedMarker = /\[RECONCILIATION:\d+\]/;
  if (usedMarker.test(adj.notes ?? "")) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "استُخدم هذا التعديل سابقاً لإغلاق مطابقة أخرى",
    });
  }
  if (!adj.approvedAt || adj.createdAt < rec.createdAt) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "يجب أن يكون التعديل معتمداً ومُنشأً لمعالجة هذه المطابقة",
    });
  }

  const adjustmentMarker = `[RECONCILIATION:${input.reconciliationId}]`;
  const reconciliationMarker = `[ADJUSTMENT:${input.adjustmentTransactionId}]`;
  await tx
    .update(digitalWalletTransactions)
    .set({ notes: [adj.notes?.trim(), adjustmentMarker].filter(Boolean).join(" ") })
    .where(eq(digitalWalletTransactions.id, input.adjustmentTransactionId));

  await tx
    .update(digitalWalletReconciliations)
    .set({
      status: "RESOLVED",
      reviewedBy: actor.userId,
      reviewedAt: new Date(),
      notes: [rec.notes?.trim(), reconciliationMarker].filter(Boolean).join(" "),
    })
    .where(eq(digitalWalletReconciliations.id, input.reconciliationId));
  await auditLog(tx, actor, "digitalCards.wallet.varianceResolved", Number(rec.walletId), {
    reconciliationId: input.reconciliationId,
    adjustmentTransactionId: input.adjustmentTransactionId,
  });
}

/** اعتماد طلب تصحيح مطابق وإغلاق فرق الرصيد في معاملة واحدة. */
export async function approveAndResolveVariance(
  tx: Tx,
  input: { reconciliationId: number; adjustmentTransactionId: number },
  actor: Actor,
): Promise<{ transactionId: number; balanceAfter: string }> {
  const approved = await approveAdjustment(tx, { transactionId: input.adjustmentTransactionId }, actor);
  // إذا لم يطابق الطلبُ الفرقَ أو المحفظةَ تتراجع المعاملة كلها، بما فيها الاعتماد وحركة الرصيد.
  await resolveVariance(tx, input, actor);
  return approved;
}

/* ────────── تنبيه الرصيد المنخفض ────────── */

/** محافظ نزل متاحُها (الرصيد − المحجوز) تحت حدّ مزوّدها — شارةٌ تشغيلية للمدير. */
export async function lowBalanceWallets(db: DB, branchId: number | null) {
  const conds = [
    eq(digitalWallets.isActive, true),
    sql`${digitalProviders.lowBalanceThreshold} > 0`,
    lte(
      sql`${digitalWallets.currentBalance} - ${digitalWallets.reservedBalance}`,
      digitalProviders.lowBalanceThreshold,
    ),
  ];
  if (branchId != null) conds.push(eq(digitalWallets.branchId, branchId));

  return db
    .select({
      walletId: digitalWallets.id,
      walletName: digitalWallets.name,
      branchId: digitalWallets.branchId,
      branchName: branches.name,
      providerName: suppliers.name,
      currentBalance: digitalWallets.currentBalance,
      reservedBalance: digitalWallets.reservedBalance,
      threshold: digitalProviders.lowBalanceThreshold,
    })
    .from(digitalWallets)
    .innerJoin(digitalProviders, eq(digitalWallets.providerId, digitalProviders.id))
    .innerJoin(suppliers, eq(digitalProviders.supplierId, suppliers.id))
    .innerJoin(branches, eq(digitalWallets.branchId, branches.id))
    .where(and(...conds))
    .orderBy(asc(digitalWallets.id));
}
