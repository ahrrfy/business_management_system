import { count, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { DUMMY_STORED, hashPassword, verifyPassword } from "../auth/password";
import { extractInsertId } from "../lib/insertId";
import { getControlDb } from "./controlDb";
import { companies, platformAdmins, type PlatformAdmin } from "./controlSchema";
import { withTenantDb, isMultiTenantModeActive, getDb } from "../db";
import { branches, users, invoices, products, customers } from "../../drizzle/schema";

/** يُنشئ مدير منصّة (لا واجهة لإنشائه — بوّابة بيضة-ودجاجة — يُستدعى من
 *  scripts/platform-admin-new.mjs فقط عبر tsx CLI). */
export async function createPlatformAdmin(input: { email: string; password: string; name: string }): Promise<number> {
  const db = getControlDb();
  if (!db) throw new Error("CONTROL_DATABASE_URL غير مضبوط — شغّل bootstrap-control-db.mjs أولاً.");
  const existing = await db.select().from(platformAdmins).where(eq(platformAdmins.email, input.email)).limit(1);
  if (existing[0]) throw new Error(`مدير منصّة بهذا البريد موجود سلفاً: ${input.email}`);
  const result = await db.insert(platformAdmins).values({
    email: input.email,
    passwordHash: await hashPassword(input.password),
    name: input.name,
  });
  return extractInsertId(result);
}

/** يتحقّق من بيانات اعتماد مدير المنصّة. يُعيد الصفّ عند النجاح، وإلا null (بلا تمييز
 *  زمني بين «بريد غير موجود» و«كلمة خاطئة» — DUMMY_STORED يُلزم scrypt كامل التكلفة
 *  حتى لو لم يوجد الحساب، تماماً كأسلوب authRouter.ts الأساسي). */
export async function verifyPlatformAdminCredentials(email: string, password: string): Promise<PlatformAdmin | null> {
  const db = getControlDb();
  if (!db) return null;
  const rows = await db.select().from(platformAdmins).where(eq(platformAdmins.email, email.trim().toLowerCase())).limit(1);
  const admin = rows[0];
  const ok = await verifyPassword(password, admin?.passwordHash ?? DUMMY_STORED);
  if (!admin || !ok || !admin.isActive) return null;
  return admin;
}

export interface CompanyInspectionResult {
  id: number;
  code: string;
  name: string;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  databaseStatus: "CONNECTED" | "ERROR" | "STANDALONE";
  databaseError: string | null;
  metrics: {
    branchesCount: number;
    usersCount: number;
    activeUsersCount: number;
    invoicesCount: number;
    productsCount: number;
    customersCount: number;
  } | null;
}

/** يفحص بيانات الشركة المحددة ويقيس مؤشرات فروعها ومستخدميها ونشاطها. */
export async function inspectCompany(id: number): Promise<CompanyInspectionResult> {
  const db = getControlDb();
  let companyRow: typeof companies.$inferSelect | undefined;

  if (db) {
    const rows = await db.select().from(companies).where(eq(companies.id, id)).limit(1);
    companyRow = rows[0];
  }

  if (!companyRow) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر فحص بيانات الشركة",
        why: `الشركة رقم ${id} غير مسجّلة في سجل تحكّم المنصّة أو تم حذفها`,
        doThis: "تحقّق من معرّف الشركة من جدول الشركات المسجّلة ثم أعد المحاولة",
      }),
    });
  }

  let metrics: CompanyInspectionResult["metrics"] = null;
  let databaseStatus: CompanyInspectionResult["databaseStatus"] = "CONNECTED";
  let databaseError: string | null = null;

  try {
    if (isMultiTenantModeActive()) {
      metrics = await withTenantDb(id, async (tenantDb) => {
        const [b, u, activeU, inv, p, c] = await Promise.all([
          tenantDb.select({ count: count() }).from(branches),
          tenantDb.select({ count: count() }).from(users),
          tenantDb.select({ count: count() }).from(users).where(eq(users.isActive, true)),
          tenantDb.select({ count: count() }).from(invoices),
          tenantDb.select({ count: count() }).from(products),
          tenantDb.select({ count: count() }).from(customers),
        ]);
        return {
          branchesCount: b[0]?.count ?? 0,
          usersCount: u[0]?.count ?? 0,
          activeUsersCount: activeU[0]?.count ?? 0,
          invoicesCount: inv[0]?.count ?? 0,
          productsCount: p[0]?.count ?? 0,
          customersCount: c[0]?.count ?? 0,
        };
      });
    } else {
      const singleDb = getDb();
      if (singleDb) {
        const [b, u, activeU, inv, p, c] = await Promise.all([
          singleDb.select({ count: count() }).from(branches),
          singleDb.select({ count: count() }).from(users),
          singleDb.select({ count: count() }).from(users).where(eq(users.isActive, true)),
          singleDb.select({ count: count() }).from(invoices),
          singleDb.select({ count: count() }).from(products),
          singleDb.select({ count: count() }).from(customers),
        ]);
        metrics = {
          branchesCount: b[0]?.count ?? 0,
          usersCount: u[0]?.count ?? 0,
          activeUsersCount: activeU[0]?.count ?? 0,
          invoicesCount: inv[0]?.count ?? 0,
          productsCount: p[0]?.count ?? 0,
          customersCount: c[0]?.count ?? 0,
        };
      }
    }
  } catch (err) {
    databaseStatus = "ERROR";
    databaseError = err instanceof Error ? err.message : String(err);
  }

  return {
    id: companyRow.id,
    code: companyRow.code,
    name: companyRow.name,
    dbHost: companyRow.dbHost,
    dbPort: companyRow.dbPort,
    dbName: companyRow.dbName,
    dbUser: companyRow.dbUser,
    isActive: companyRow.isActive,
    createdAt: new Date(companyRow.createdAt).toISOString(),
    updatedAt: new Date(companyRow.updatedAt).toISOString(),
    databaseStatus,
    databaseError,
    metrics,
  };
}

