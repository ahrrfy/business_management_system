/**
 * storeCustomerService — «العملاء» في لوحة hPanel: عملاء المتجر الإلكترونيّ (من لهم طلبٌ أونلاين)
 * مع مؤشّراتهم: عدد الطلبات، المُسلَّم، الإنفاق (Σ total غير الملغاة)، آخر طلب، آخر محافظة.
 *
 * بلا تكلفة/ربح (خطّ §٦). المحافظة على مستوى الطلب لا العميل ⇒ نأخذ محافظة أحدث طلب. الإنفاق يستبعد
 * الملغاة (لا قيمة محقَّقة/قيد تنفيذ). عزل الفرع كبقيّة راوتر الطلبات (scopedBranchId؛ المرتفع=كل المتجر).
 */
import { and, eq, sql } from "drizzle-orm";
import { customers, onlineOrders } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { escLike } from "../../lib/sqlLike";
import { money, toDbMoney } from "../money";

/** Date → YYYY-MM-DD بحبيبة يوم بغداد (UTC+3). */
function ymdBaghdad(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  const b = new Date(d.getTime() + 3 * 60 * 60 * 1000);
  return `${b.getUTCFullYear()}-${String(b.getUTCMonth() + 1).padStart(2, "0")}-${String(b.getUTCDate()).padStart(2, "0")}`;
}

export type StoreCustomerSort = "spend" | "recent" | "orders";

export interface StoreCustomerRow {
  customerId: number;
  name: string;
  phone: string | null;
  orders: number;
  deliveredOrders: number;
  spend: string;
  lastOrderYmd: string | null;
  lastGovernorate: string | null;
}

export interface StoreCustomerSummary {
  totalCustomers: number;
  repeatCustomers: number; // > طلبٍ واحد
  repeatRate: number; // repeat / total (0..1)
  totalRevenue: string;
  avgSpend: string;
}

export interface StoreCustomersResult {
  summary: StoreCustomerSummary;
  rows: StoreCustomerRow[];
  total: number;
}

const EMPTY_SUMMARY: StoreCustomerSummary = {
  totalCustomers: 0, repeatCustomers: 0, repeatRate: 0, totalRevenue: "0.00", avgSpend: "0.00",
};

export async function getStoreCustomers(input: {
  scopedBranchId: number | null;
  q?: string;
  sort?: StoreCustomerSort;
  limit?: number;
  offset?: number;
}): Promise<StoreCustomersResult> {
  const db = getDb();
  if (!db) return { summary: EMPTY_SUMMARY, rows: [], total: 0 };
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 200);
  const offset = Math.max(input.offset ?? 0, 0);
  const sort: StoreCustomerSort = input.sort ?? "spend";

  // JOIN داخليّ ⇒ عملاء لهم طلبٌ أونلاين فقط. شرط الفرع في ON (undefined يُسقطه drizzle).
  const orderBranch = input.scopedBranchId != null ? eq(onlineOrders.branchId, input.scopedBranchId) : undefined;
  const joinOn = and(eq(onlineOrders.customerId, customers.id), orderBranch);

  const q = input.q?.trim();
  // تهريب حارفَي البدل %/_ في LIKE (اتّفاقية المستودع escLike + ESCAPE '!'، كـcustomerService) — وإلا
  // فسّرها MySQL بدلاً فطابق «0771_2345» عميلاً غير المقصود، و«%» طابق الكلّ (مراجعة عدائية ١٣/٧).
  const like = q ? `%${escLike(q)}%` : undefined;
  const qCond = q
    ? sql`(${customers.name} LIKE ${like} ESCAPE '!' OR ${customers.searchNorm} LIKE ${like} ESCAPE '!' OR ${customers.phone} LIKE ${like} ESCAPE '!')`
    : undefined;

  const spendExpr = sql`COALESCE(SUM(CASE WHEN ${onlineOrders.status} <> 'CANCELLED' THEN ${onlineOrders.total} ELSE 0 END), 0)`;
  // كاسر تعادلٍ ثابت (customers.id) على كل فرع فرزٍ ⇒ ترتيبٌ كليّ حتميّ فيثبُت الترقيم (limit/offset)
  // ولا يتكرّر/يُتخطّى عميلٌ عند تساوي قيم الفرز (شائع: إنفاق 0 لمن طلباته كلّها ملغاة — مراجعة ١٣/٧).
  const orderByExpr =
    sort === "recent" ? sql`MAX(${onlineOrders.orderDate}) DESC, ${customers.id} ASC`
      : sort === "orders" ? sql`COUNT(${onlineOrders.id}) DESC, ${customers.id} ASC`
        : sql`${spendExpr} DESC, ${customers.id} ASC`;

  const govSub = input.scopedBranchId != null
    ? sql<string | null>`(SELECT o2.governorate FROM onlineOrders o2 WHERE o2.customerId = ${customers.id} AND o2.branchId = ${input.scopedBranchId} ORDER BY o2.orderDate DESC LIMIT 1)`
    : sql<string | null>`(SELECT o2.governorate FROM onlineOrders o2 WHERE o2.customerId = ${customers.id} ORDER BY o2.orderDate DESC LIMIT 1)`;

  const rowsRaw = await db
    .select({
      customerId: customers.id,
      name: customers.name,
      phone: customers.phone,
      orders: sql<number>`COUNT(${onlineOrders.id})`,
      deliveredOrders: sql<number>`COALESCE(SUM(${onlineOrders.status} = 'DELIVERED'), 0)`,
      spend: sql<string>`${spendExpr}`,
      lastOrderDate: sql<string>`MAX(${onlineOrders.orderDate})`,
      lastGovernorate: govSub,
    })
    .from(customers)
    .innerJoin(onlineOrders, joinOn)
    .where(qCond)
    .groupBy(customers.id)
    .orderBy(orderByExpr)
    .limit(limit)
    .offset(offset);

  const rows: StoreCustomerRow[] = rowsRaw.map((r) => ({
    customerId: Number(r.customerId),
    name: r.name,
    phone: r.phone ?? null,
    orders: Number(r.orders),
    deliveredOrders: Number(r.deliveredOrders),
    spend: toDbMoney(money(r.spend ?? "0")),
    lastOrderYmd: ymdBaghdad(r.lastOrderDate),
    lastGovernorate: r.lastGovernorate ?? null,
  }));

  // عدد العملاء المطابقين (للترقيم)
  const [cnt] = await db
    .select({ n: sql<number>`COUNT(DISTINCT ${customers.id})` })
    .from(customers)
    .innerJoin(onlineOrders, joinOn)
    .where(qCond);
  const total = Number(cnt?.n ?? 0);

  // ملخّص عامّ (غير مُقيَّد بالبحث) — عبر تجميعٍ لكل عميل
  const perCustomer = db
    .select({
      cid: onlineOrders.customerId,
      cnt: sql<number>`COUNT(*)`.as("cnt"),
      spend: sql<string>`${spendExpr}`.as("spend"),
    })
    .from(onlineOrders)
    .where(orderBranch)
    .groupBy(onlineOrders.customerId)
    .as("pc");
  const [sm] = await db
    .select({
      totalCustomers: sql<number>`COUNT(*)`,
      repeatCustomers: sql<number>`COALESCE(SUM(${perCustomer.cnt} > 1), 0)`,
      totalRevenue: sql<string>`COALESCE(SUM(${perCustomer.spend}), 0)`,
    })
    .from(perCustomer);

  const totalCustomers = Number(sm?.totalCustomers ?? 0);
  const repeatCustomers = Number(sm?.repeatCustomers ?? 0);
  const totalRevenue = toDbMoney(money(sm?.totalRevenue ?? "0"));
  const summary: StoreCustomerSummary = {
    totalCustomers,
    repeatCustomers,
    repeatRate: totalCustomers > 0 ? repeatCustomers / totalCustomers : 0,
    totalRevenue,
    avgSpend: totalCustomers > 0 ? toDbMoney(money(totalRevenue).dividedBy(totalCustomers)) : "0.00",
  };

  return { summary, rows, total };
}
