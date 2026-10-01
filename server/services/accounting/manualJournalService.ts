import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  accounts,
  accountingEntries,
  branches,
  customers,
  journalEntries,
  journalLines,
  statutoryAccountingProfiles,
  statutoryAccountMappings,
  suppliers,
  users,
} from "../../../drizzle/schema";
import { getDb, type Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { money, toDbMoney } from "../money";
import { assertPeriodOpen } from "../periodLockService";
import { lockFinancialPostingGate } from "../reports/monthCloseGate";
import { getDoubleEntryRuntime } from "./journalStore";
import { adjustCustomerBalance, adjustSupplierBalance } from "../ledgerService";
import { logAuditTx } from "../auditService";
import { appErrorMessage } from "../../../shared/errors";
import { ACCOUNT_ROLES } from "./postingEngine";
import type { Actor } from "../tx";
import type { TrpcContext } from "../../context";

type AuditContext = Pick<TrpcContext, "user" | "req">;

const accountRoleSet: ReadonlySet<string> = new Set(ACCOUNT_ROLES);

export interface ManualJournalLineInput {
  accountId: number;
  debit: string;
  credit: string;
  notes?: string | null;
  customerId?: number | null;
  supplierId?: number | null;
}

export interface CreateManualJournalInput {
  entryDate: string; // YYYY-MM-DD
  notes: string;
  branchId?: number | null;
  lines: ManualJournalLineInput[];
}

export interface ManualJournalDetail {
  id: number;
  entryId: number | null;
  entryDate: string;
  branchId: number | null;
  branchName: string | null;
  notes: string | null;
  amount: string;
  createdBy: number | null;
  createdByName: string | null;
  createdAt: string;
  lines: Array<{
    id: number;
    accountId: number | null;
    accountCode: string | null;
    accountName: string | null;
    accountType: string | null;
    role: string;
    debit: string;
    credit: string;
    customerId: number | null;
    customerName: string | null;
    supplierId: number | null;
    supplierName: string | null;
  }>;
}

/**
 * إنشاء قيد يومية يدوي متوازن وفق الأصول المحاسبية الصارمة:
 * 1. فحص الفترة المالية المقفلة.
 * 2. قفل الترحيل المشترك.
 * 3. التحقق الرياضي الدقيق: إجمالي المدين = إجمالي الدائن > 0.
 * 4. التحقق من صلاحية الحسابات وربطها بالأدوار النظامية.
 * 5. الترحيل المزدوج لدفتر اليومية والأستاذ مع إثبات التدقيق.
 */
export async function createManualJournal(
  tx: Tx,
  input: CreateManualJournalInput,
  actor: Actor,
  auditContext: AuditContext,
): Promise<{ journalId: number; entryId: number; amount: string }> {
  const notes = input.notes.trim();
  if (notes.length < 5) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذر حفظ قيد اليومية اليدوي",
        why: "بيان القيد (الملاحظات) قصير جداً ولا يوضح سبب التسوية المحاسبية.",
        doThis: "اكتب بياناً واضحاً ومفصلاً للقيد بحد أدنى 5 أحرف يشرح سبب العملية وأطرافها.",
      }),
    });
  }

  if (!input.lines || input.lines.length < 2) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذر حفظ قيد اليومية اليدوي",
        why: "القيد المحاسبي المزدوج يجب أن يتكون من طرفين على الأقل (مدين ودائن).",
        doThis: "أضف سطرين على الأقل للقيد مع تحديد الحسابات ومبالغ المدين والدائن.",
      }),
    });
  }

  const [y, m, d] = input.entryDate.split("-").map(Number);
  const entryDateObj = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  if (isNaN(entryDateObj.getTime())) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تاريخ القيد غير صالح",
        why: `القيمة المدخلة "${input.entryDate}" ليست بصيغة تقويمية صحيحة YYYY-MM-DD.`,
        doThis: "أدخل تاريخاً صحيحاً بصيغة سنة-شهر-يوم.",
      }),
    });
  }

  // 1. فحص حارس الفترات المالية المقفلة وقفل الترحيل
  await lockFinancialPostingGate(tx);
  await assertPeriodOpen(tx, entryDateObj);

  // 2. جلب الحسابات والتحقق من وجودها ونشاطها
  const accountIds = Array.from(new Set(input.lines.map((l) => l.accountId)));
  const accountRows = await tx
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      systemRole: accounts.systemRole,
      isActive: accounts.isActive,
    })
    .from(accounts)
    .where(inArray(accounts.id, accountIds));

  const accountMap = new Map(accountRows.map((r) => [r.id, r]));
  for (const accId of accountIds) {
    const acc = accountMap.get(accId);
    if (!acc) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "حساب محاسبي غير موجود",
          why: `الحساب ذو الرقم المرجعي ${accId} غير مسجل في دليل الحسابات.`,
          doThis: "اختر حساباً صالحاً من قائمة شجرة الحسابات المعتمدة.",
        }),
      });
    }
    if (!acc.isActive) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "الحساب المحاسبي معطل",
          why: `الحساب "${acc.name}" (${acc.code}) موقوف عن الترحيل.`,
          doThis: "قم بتفعيل الحساب من شجرة الحسابات أو اختر حساباً بديلاً نشطاً.",
        }),
      });
    }
    if (!acc.systemRole || !accountRoleSet.has(acc.systemRole)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "الحساب غير مؤهل للترحيل المزدوج",
          why: `الحساب "${acc.name}" (${acc.code}) غير مرتبط بدور نظامي صالح (systemRole).`,
          doThis: "اربط الحساب بدور نظامي معتمد من شجرة الحسابات قبل استخدامه في القيود.",
        }),
      });
    }
  }

  // 3. التحقق الرياضي من مبالغ الأسطر وتوازن القيد
  let totalDebit = money(0);
  let totalCredit = money(0);

  for (let idx = 0; idx < input.lines.length; idx++) {
    const line = input.lines[idx];
    const debit = money(line.debit || 0);
    const credit = money(line.credit || 0);

    if (debit.isNegative() || credit.isNegative()) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "قيمة سالبة في أسطر القيد",
          why: `السطر رقم ${idx + 1} يحتوي على مبالغ سالبة. القيود المحاسبية تسجل بأرقام موجبة في جانبها المخصص.`,
          doThis: "أدخل مبالغ موجبة فقط في عمود المدين أو الدائن، واعتمد الطرف المقابل بدلاً من الإشارة السالبة.",
        }),
      });
    }

    if (debit.isZero() && credit.isZero()) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "سطر صفري في القيد",
          why: `السطر رقم ${idx + 1} مبلغه صفر في كلا الجانبين المدين والدائن.`,
          doThis: "احذف السطر الفارغ أو حدد مبلغه في الجانب المخصص.",
        }),
      });
    }

    if (!debit.isZero() && !credit.isZero()) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "ازدواج في سطر القيد الواحد",
          why: `السطر رقم ${idx + 1} يحتوي على مبلغ في المدين والدائن معاً.`,
          doThis: "ضع المبلغ في جانب واحد فقط (مدين أو دائن) لكل سطر.",
        }),
      });
    }

    totalDebit = totalDebit.add(debit);
    totalCredit = totalCredit.add(credit);
  }

  if (!totalDebit.eq(totalCredit)) {
    const diff = totalDebit.sub(totalCredit).abs();
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "القيد المحاسبي غير متوازن",
        why: `إجمالي المدين (${toDbMoney(totalDebit)}) لا يساوي إجمالي الدائن (${toDbMoney(totalCredit)}). فرق عدم التوازن: ${toDbMoney(diff)}.`,
        doThis: "راجع أرقام الأسطر وتأكد من تطابق مجموع المدين مع مجموع الدائن تماماً.",
      }),
    });
  }

  if (totalDebit.lte(0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "مبلغ القيد الإجمالي صفر",
        why: "لا يمكن ترحيل قيد محاسبي بإجمالي أصفار.",
        doThis: "أدخل مبالغ صحيحة أكبر من الصفر لإتمام القيد.",
      }),
    });
  }

  const effectiveBranchId = input.branchId ?? actor.branchId ?? null;
  const runtime = await getDoubleEntryRuntime(tx);

  // 4. إدراج القيد في جدول الأحداث المحاسبية الموحد accountingEntries
  const userRow = (
    await tx
      .select({ name: sql<string | null>`COALESCE(${users.name}, ${users.username})` })
      .from(users)
      .where(eq(users.id, actor.userId))
      .limit(1)
  )[0];
  const createdByNameSnapshot = userRow?.name ?? null;

  const dedupeKey = `MANUAL_JOURNAL:${randomUUID()}`;
  const [resAe] = await tx.insert(accountingEntries).values({
    entryType: "ADJUST",
    branchId: effectiveBranchId,
    amount: toDbMoney(totalDebit),
    revenue: "0.00",
    cost: "0.00",
    profit: "0.00",
    taxAmount: "0.00",
    entryDate: entryDateObj,
    notes: `قيد يدوي: ${notes}`,
    dedupeKey,
    createdBy: actor.userId,
    createdByNameSnapshot,
    postingProfile: "MANUAL_JOURNAL",
    postingCycleId: runtime.cycleId,
  });
  const entryId = extractInsertId(resAe);

  // 5. إدراج رأس القيد في دفتر اليومية المزدوج journalEntries
  const [resJe] = await tx.insert(journalEntries).values({
    entryId,
    cycleId: runtime.cycleId,
    postingProfile: "MANUAL_JOURNAL",
    entryDate: entryDateObj,
    branchId: effectiveBranchId,
    status: "POSTED",
  });
  const journalId = extractInsertId(resJe);

  // 6. ربط الامتثال النظامي إن وجد دليل معتمد
  const activeStatutory = (
    await tx
      .select({ id: statutoryAccountingProfiles.id })
      .from(statutoryAccountingProfiles)
      .where(eq(statutoryAccountingProfiles.status, "ACTIVE"))
      .limit(1)
  )[0];

  const statutoryMappingMap = new Map<number, number>();
  if (activeStatutory) {
    const mappings = await tx
      .select({
        internalAccountId: statutoryAccountMappings.internalAccountId,
        statutoryAccountId: statutoryAccountMappings.statutoryAccountId,
      })
      .from(statutoryAccountMappings)
      .where(eq(statutoryAccountMappings.profileId, activeStatutory.id));
    for (const m of mappings) {
      statutoryMappingMap.set(Number(m.internalAccountId), Number(m.statutoryAccountId));
    }
  }

  // 7. إدراج سطور اليومية المزدوجة وتحديث الذمم الفرعية (AR/AP) إن وجدت
  for (const line of input.lines) {
    const acc = accountMap.get(line.accountId)!;
    const debit = money(line.debit || 0);
    const credit = money(line.credit || 0);
    const statutoryAccountId = statutoryMappingMap.get(acc.id) ?? null;

    await tx.insert(journalLines).values({
      journalId,
      role: acc.systemRole!,
      accountId: acc.id,
      branchId: effectiveBranchId,
      customerId: line.customerId ?? null,
      supplierId: line.supplierId ?? null,
      debit: toDbMoney(debit),
      credit: toDbMoney(credit),
      statutoryProfileId: activeStatutory ? activeStatutory.id : null,
      statutoryAccountId,
    });

    // تحديث الذمم الفرعية المتصلة:
    // إذا كان الحساب ذمم عملاء AR ورُبط بعميل: المدين يزيد الدين، والدائن يخفضه
    if (acc.systemRole === "AR" && line.customerId) {
      const delta = debit.sub(credit);
      await adjustCustomerBalance(tx, line.customerId, delta);
    }
    // إذا كان الحساب ذمم موردين AP ورُبط بمورد: الدائن يزيد التزامنا، والمدين يخفضه
    if (acc.systemRole === "AP" && line.supplierId) {
      const delta = credit.sub(debit);
      await adjustSupplierBalance(tx, line.supplierId, delta);
    }
  }

  // 8. إثبات التدقيق الرقابي غير القابل للتعديل
  await logAuditTx(tx, auditContext, {
    action: "manualJournal.create",
    entityType: "journalEntries",
    entityId: journalId,
    newValue: {
      journalId,
      entryId,
      entryDate: input.entryDate,
      amount: toDbMoney(totalDebit),
      linesCount: input.lines.length,
      notes,
      branchId: effectiveBranchId,
    },
  });

  return {
    journalId,
    entryId,
    amount: toDbMoney(totalDebit),
  };
}

/** استعراض القيود اليدوية مع كامل أسطرها وأطرافها */
export async function listManualJournals(opts: {
  from?: string;
  to?: string;
  branchId?: number;
  limit?: number;
  offset?: number;
}) {
  const db = getDb();
  if (!db) return { rows: [], total: 0 };

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const whereConditions = [
    eq(journalEntries.postingProfile, "MANUAL_JOURNAL"),
  ];

  if (opts.branchId) {
    whereConditions.push(eq(journalEntries.branchId, opts.branchId));
  }
  if (opts.from) {
    const [y, m, d] = opts.from.split("-").map(Number);
    whereConditions.push(gte(journalEntries.entryDate, new Date(Date.UTC(y, m - 1, d))));
  }
  if (opts.to) {
    const [y, m, d] = opts.to.split("-").map(Number);
    whereConditions.push(lte(journalEntries.entryDate, new Date(Date.UTC(y, m - 1, d))));
  }

  const whereClause = and(...whereConditions);

  const totalCountResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(journalEntries)
    .where(whereClause);
  const total = Number(totalCountResult[0]?.count ?? 0);

  const heads = await db
    .select({
      id: journalEntries.id,
      entryId: journalEntries.entryId,
      entryDate: journalEntries.entryDate,
      branchId: journalEntries.branchId,
      branchName: branches.name,
      notes: accountingEntries.notes,
      amount: accountingEntries.amount,
      createdBy: accountingEntries.createdBy,
      createdByName: accountingEntries.createdByNameSnapshot,
      createdAt: journalEntries.createdAt,
    })
    .from(journalEntries)
    .leftJoin(branches, eq(branches.id, journalEntries.branchId))
    .leftJoin(accountingEntries, eq(accountingEntries.id, journalEntries.entryId))
    .where(whereClause)
    .orderBy(desc(journalEntries.entryDate), desc(journalEntries.id))
    .limit(limit)
    .offset(offset);

  if (heads.length === 0) {
    return { rows: [], total };
  }

  const journalIds = heads.map((h) => h.id);
  const lines = await db
    .select({
      id: journalLines.id,
      journalId: journalLines.journalId,
      accountId: journalLines.accountId,
      accountCode: accounts.code,
      accountName: accounts.name,
      accountType: accounts.type,
      role: journalLines.role,
      debit: journalLines.debit,
      credit: journalLines.credit,
      customerId: journalLines.customerId,
      customerName: customers.name,
      supplierId: journalLines.supplierId,
      supplierName: suppliers.name,
    })
    .from(journalLines)
    .leftJoin(accounts, eq(accounts.id, journalLines.accountId))
    .leftJoin(customers, eq(customers.id, journalLines.customerId))
    .leftJoin(suppliers, eq(suppliers.id, journalLines.supplierId))
    .where(inArray(journalLines.journalId, journalIds));

  const linesByJournal = new Map<number, typeof lines>();
  for (const l of lines) {
    const list = linesByJournal.get(l.journalId) ?? [];
    list.push(l);
    linesByJournal.set(l.journalId, list);
  }

  const rows: ManualJournalDetail[] = heads.map((h) => ({
    id: h.id,
    entryId: h.entryId,
    entryDate: h.entryDate instanceof Date ? h.entryDate.toISOString().slice(0, 10) : String(h.entryDate),
    branchId: h.branchId,
    branchName: h.branchName,
    notes: h.notes,
    amount: h.amount ?? "0.00",
    createdBy: h.createdBy,
    createdByName: h.createdByName,
    createdAt: h.createdAt instanceof Date ? h.createdAt.toISOString() : String(h.createdAt),
    lines: (linesByJournal.get(h.id) ?? []).map((l) => ({
      id: l.id,
      accountId: l.accountId,
      accountCode: l.accountCode,
      accountName: l.accountName,
      accountType: l.accountType,
      role: l.role,
      debit: l.debit,
      credit: l.credit,
      customerId: l.customerId,
      customerName: l.customerName,
      supplierId: l.supplierId,
      supplierName: l.supplierName,
    })),
  }));

  return { rows, total };
}
