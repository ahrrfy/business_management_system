/* ============================================================================
 * تقرير: تفصيل حساب العميل بالحسابات المحاسبيّة (Tier-3 #6، ٢٧/٨)
 *
 * الغرض: يستهلك أبعادَ Tier-3 #2 (`journalLines.customerId` + `journalLines.accountId`)
 * ليُظهر — على مستوى **الدفتر المزدوج** لا الفاتورة — أيّ حساباتٍ تحمل حركاتٍ لعميلٍ معيّن
 * وبأيّ صافٍ. هذا منظورٌ محاسبيٌّ يُكمِّل `customerStatement` القائم (المبنيّ على الفواتير
 * والإيصالات) بعرضٍ حاكمٍ: «رصيد العميل في AR» ≠ الفاتورة المفتوحة إن كانت هناك حركاتٌ
 * في حساباتٍ أخرى (خصم مكتسب، رد مرتجع، تعديلات، إلخ).
 *
 * السلوك المُتوقَّع:
 *   • الدفتر المزدوج OFF افتراضياً في الإنتاج ⇒ الجدولُ فارغٌ للجميع (لا كذبٌ في التقرير).
 *   • في وضع SHADOW/ACTIVE ⇒ يعرض تفصيلاً حقيقياً بحسب ما كتب `postingEngine`.
 *   • الأسطر بلا `accountId` (السجلاّت التاريخيّة قبل Tier-3 #2) تُستبعَد صراحةً —
 *     يُغطّيها كاشف Tier-3 #5.
 *
 * القراءةُ فقط، لا كتابة.
 * ========================================================================== */
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { accounts, journalEntries, journalLines } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money } from "../money";

export interface CustomerJournalAccountRow {
  accountId: number;
  code: string;
  name: string;
  type: string;
  systemRole: string | null;
  debitTotal: string;
  creditTotal: string;
  net: string;
  lineCount: number;
}

export interface CustomerJournalBreakdown {
  customerId: number;
  from: string | null;
  to: string | null;
  branchId: number | null;
  rows: CustomerJournalAccountRow[];
  totalDebit: string;
  totalCredit: string;
  totalNet: string;
}

export interface CustomerJournalBreakdownInput {
  customerId: number;
  from?: string | null;
  to?: string | null;
  branchId?: number | null;
}

export async function getCustomerJournalBreakdown(
  input: CustomerJournalBreakdownInput,
): Promise<CustomerJournalBreakdown> {
  const db = getDb();
  const empty: CustomerJournalBreakdown = {
    customerId: input.customerId,
    from: input.from ?? null,
    to: input.to ?? null,
    branchId: input.branchId ?? null,
    rows: [],
    totalDebit: "0.00",
    totalCredit: "0.00",
    totalNet: "0.00",
  };
  if (!db) return empty;

  const conds = [
    eq(journalLines.customerId, input.customerId),
    eq(journalEntries.status, "POSTED"),
    // الأسطر بلا accountId (تاريخية) خارج نطاق التقرير — Tier-3 #5 يكشفها.
    sql`${journalLines.accountId} IS NOT NULL`,
  ];
  if (input.from) conds.push(gte(journalEntries.entryDate, new Date(`${input.from}T00:00:00Z`)));
  if (input.to) conds.push(lte(journalEntries.entryDate, new Date(`${input.to}T23:59:59Z`)));
  if (input.branchId != null) conds.push(eq(journalEntries.branchId, input.branchId));

  const rows = await db
    .select({
      accountId: journalLines.accountId,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      systemRole: accounts.systemRole,
      debitTotal: sql<string>`COALESCE(SUM(${journalLines.debit}), 0)`,
      creditTotal: sql<string>`COALESCE(SUM(${journalLines.credit}), 0)`,
      lineCount: sql<number>`COUNT(*)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(...conds))
    .groupBy(
      journalLines.accountId,
      accounts.code,
      accounts.name,
      accounts.type,
      accounts.systemRole,
    );

  const mapped = rows.map((r): CustomerJournalAccountRow => {
    const debit = money(String(r.debitTotal ?? 0));
    const credit = money(String(r.creditTotal ?? 0));
    return {
      accountId: Number(r.accountId),
      code: r.code,
      name: r.name,
      type: r.type,
      systemRole: r.systemRole,
      debitTotal: debit.toFixed(2),
      creditTotal: credit.toFixed(2),
      net: debit.sub(credit).toFixed(2),
      lineCount: Number(r.lineCount ?? 0),
    };
  });

  // ترتيبٌ محاسبيّ مألوف: أولاً بالنوع (ASSET/LIABILITY/…) ثم بالكود لأنّه شجرة الحسابات.
  mapped.sort((a, b) => a.type.localeCompare(b.type) || a.code.localeCompare(b.code));

  const totalDebit = mapped.reduce((acc, r) => acc.add(money(r.debitTotal)), money(0));
  const totalCredit = mapped.reduce((acc, r) => acc.add(money(r.creditTotal)), money(0));

  return {
    customerId: input.customerId,
    from: input.from ?? null,
    to: input.to ?? null,
    branchId: input.branchId ?? null,
    rows: mapped,
    totalDebit: totalDebit.toFixed(2),
    totalCredit: totalCredit.toFixed(2),
    totalNet: totalDebit.sub(totalCredit).toFixed(2),
  };
}
