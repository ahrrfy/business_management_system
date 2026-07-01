import { eq } from "drizzle-orm";
import { extractInsertId } from "../lib/insertId";
import { decryptSecret, encryptSecret } from "../services/cryptoService";
import { getControlDb } from "./controlDb";
import { companies, type Company } from "./controlSchema";

export interface ResolvedCompany {
  id: number;
  code: string;
  name: string;
  /** اسم قاعدة الشركة الفعلي (بلا حاجة لتفكيك connectionUrl) — يُستعمَل لفلترة ملفات النسخ الاحتياطية الخاصة بها. */
  dbName: string;
  dbHost: string;
  dbPort: number;
  /** عنوان اتصال Drizzle/mysql2 كامل (مع كلمة المرور مفكوكة التشفير) — لا يُسجَّل أبداً في السجلّات. */
  connectionUrl: string;
}

function buildConnectionUrl(row: Company, password: string): string {
  const user = encodeURIComponent(row.dbUser);
  const pw = encodeURIComponent(password);
  return `mysql://${user}:${pw}@${row.dbHost}:${row.dbPort}/${row.dbName}`;
}

function toResolved(row: Company): ResolvedCompany {
  const password = decryptSecret(row.dbPasswordEncrypted);
  if (!password) {
    throw new Error(`تعذّر فكّ تشفير كلمة مرور قاعدة الشركة «${row.code}» — تحقّق من INTEGRATIONS_ENCRYPTION_KEY.`);
  }
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    dbName: row.dbName,
    dbHost: row.dbHost,
    dbPort: row.dbPort,
    connectionUrl: buildConnectionUrl(row, password),
  };
}

// ذاكرة تخزين مؤقت قصيرة (٣٠ث) — تُريح قاعدة التحكّم من استعلام على كل محاولة دخول
// بلا الحاجة لإعادة تشغيل الخادم عند إضافة/تعطيل شركة (تنتهي صلاحيتها بسرعة).
const CACHE_TTL_MS = 30_000;
const codeCache = new Map<string, { at: number; value: ResolvedCompany | null }>();
const idCache = new Map<number, { at: number; value: ResolvedCompany | null }>();

function cached<K>(map: Map<K, { at: number; value: ResolvedCompany | null }>, key: K): ResolvedCompany | null | undefined {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    map.delete(key);
    return undefined;
  }
  return hit.value;
}

/** يحلّ رمز شركة (يُدخله المستخدم في شاشة الدخول) إلى بيانات اتصال قاعدتها. null إن لم توجد/معطَّلة. */
export async function resolveCompanyByCode(code: string): Promise<ResolvedCompany | null> {
  const cachedVal = cached(codeCache, code);
  if (cachedVal !== undefined) return cachedVal;

  const db = getControlDb();
  if (!db) return null;
  const rows = await db.select().from(companies).where(eq(companies.code, code)).limit(1);
  const row = rows[0];
  const resolved = row && row.isActive ? toResolved(row) : null;
  codeCache.set(code, { at: Date.now(), value: resolved });
  return resolved;
}

/** يحلّ معرّف شركة رقمي (من JWT بعد الدخول) إلى بيانات اتصال قاعدتها. */
export async function resolveCompanyById(id: number): Promise<ResolvedCompany | null> {
  const cachedVal = cached(idCache, id);
  if (cachedVal !== undefined) return cachedVal;

  const db = getControlDb();
  if (!db) return null;
  const rows = await db.select().from(companies).where(eq(companies.id, id)).limit(1);
  const row = rows[0];
  const resolved = row && row.isActive ? toResolved(row) : null;
  idCache.set(id, { at: Date.now(), value: resolved });
  return resolved;
}

/** قائمة كل الشركات (بلا كلمات مرور) — لشاشة إدارة المنصّة. */
export async function listCompanies(): Promise<Omit<Company, "dbPasswordEncrypted">[]> {
  const db = getControlDb();
  if (!db) return [];
  const rows = await db.select().from(companies);
  return rows.map(({ dbPasswordEncrypted: _omit, ...rest }) => rest);
}

export interface CreateCompanyInput {
  code: string;
  name: string;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
}

/** يسجّل شركة جديدة في قاعدة التحكّم (تُستدعى من scripts/company-new.mjs بعد توفير قاعدتها الفعلية). */
export async function createCompanyRecord(input: CreateCompanyInput): Promise<number> {
  const db = getControlDb();
  if (!db) throw new Error("CONTROL_DATABASE_URL غير مضبوط — شغّل bootstrap-control-db.mjs أولاً.");
  const dbPasswordEncrypted = encryptSecret(input.dbPassword);
  if (!dbPasswordEncrypted) throw new Error("فشل تشفير كلمة مرور القاعدة.");
  const result = await db.insert(companies).values({
    code: input.code,
    name: input.name,
    dbHost: input.dbHost,
    dbPort: input.dbPort,
    dbName: input.dbName,
    dbUser: input.dbUser,
    dbPasswordEncrypted,
  });
  return extractInsertId(result);
}

/** يُفعّل/يُعطّل شركة (شاشة إدارة المنصّة). يُفرِغ الذاكرة المؤقتة فوراً لتلك الشركة —
 *  تعطيل دخول جديد يسري فوراً بدل انتظار ٣٠ث (الجلسات القائمة تبقى سارية حتى انتهاء
 *  الكوكي — راجع server/tenancy/registry.ts توثيق الحدّ المعروف في تعليق أعلى الملف). */
export async function setCompanyActive(id: number, isActive: boolean): Promise<void> {
  const db = getControlDb();
  if (!db) throw new Error("CONTROL_DATABASE_URL غير مضبوط.");
  await db.update(companies).set({ isActive }).where(eq(companies.id, id));
  idCache.delete(id);
  for (const [code, hit] of Array.from(codeCache.entries())) {
    if (hit.value?.id === id) codeCache.delete(code);
  }
}

/**
 * ⚠️ للاستعمال من سكربتات التشغيل الموثوقة فقط (النسخ الاحتياطي/النشر) — تُعيد كلمات
 * مرور مفكوكة التشفير. لا تُستدعى أبداً من أي مسار يصل إليه طلب HTTP/tRPC.
 */
export async function listActiveCompanyConnections(): Promise<ResolvedCompany[]> {
  const db = getControlDb();
  if (!db) return [];
  const rows = await db.select().from(companies).where(eq(companies.isActive, true));
  return rows.map(toResolved);
}
