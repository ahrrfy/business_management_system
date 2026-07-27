// شجرة الحسابات — خدمة قراءة (P0، الدفتر المزدوج). قراءةٌ فقط في هذه المرحلة: الجدول بياناتٌ مرجعية
// تُبذَر بالهجرة 0115. الربط بالمفهوم القائم عبر systemRole (أساس محرّك القيود P1 لاحقاً).
import { asc } from "drizzle-orm";
import { accounts } from "../../drizzle/schema";
import { getDb } from "../db";

export type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";

export interface AccountRow {
  id: number;
  code: string;
  name: string;
  type: AccountType;
  parentId: number | null;
  systemRole: string | null;
  isActive: boolean;
  sortOrder: number;
}

const TYPE_LABEL: Record<AccountType, string> = {
  ASSET: "الأصول",
  LIABILITY: "الالتزامات",
  EQUITY: "حقوق الملكية",
  REVENUE: "الإيرادات",
  EXPENSE: "المصروفات",
};
const TYPE_ORDER: AccountType[] = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"];

/** كل الحسابات مرتّبةً (type ثم sortOrder). */
export async function listAccounts(): Promise<AccountRow[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db.select().from(accounts).orderBy(asc(accounts.sortOrder));
  return rows.map((r) => ({
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    type: r.type as AccountType,
    parentId: r.parentId == null ? null : Number(r.parentId),
    systemRole: r.systemRole ?? null,
    isActive: !!r.isActive,
    sortOrder: Number(r.sortOrder),
  }));
}

/** الشجرة مجموعةً حسب النوع (لعرض الواجهة) — لكل نوعٍ عنوانُه العربيّ وحساباته مرتّبة. */
export async function chartOfAccounts(): Promise<
  { type: AccountType; label: string; rows: AccountRow[] }[]
> {
  const all = await listAccounts();
  return TYPE_ORDER.map((type) => ({
    type,
    label: TYPE_LABEL[type],
    rows: all.filter((a) => a.type === type),
  })).filter((g) => g.rows.length > 0);
}
