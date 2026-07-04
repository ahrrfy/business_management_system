import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { extractAffectedRows, extractInsertId } from "../lib/insertId";
import { decryptSecret, encryptSecret } from "../services/cryptoService";
import { generateStrongPassword } from "../services/userService";
import { getControlDb } from "./controlDb";
import { companies, companyProvisionRequests, type CompanyProvisionRequest } from "./controlSchema";

const CODE_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;

function requireDb() {
  const db = getControlDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "CONTROL_DATABASE_URL غير مضبوط." });
  return db;
}

export interface CreateProvisionRequestInput {
  code: string;
  name: string;
  adminEmail: string;
  adminUsername: string;
  demo: boolean;
  requestedByAdminId: number;
}

/**
 * ينشئ طلب توفير شركة (لا يُنفّذ التوفير هنا — راجع تعليق companyProvisionRequests في
 * controlSchema.ts). يفحص تفرّد الرمز مقابل الشركات القائمة **وطلبات PENDING/PROCESSING**
 * الأخرى قبل الإدراج (رسالة عربية فورية للحالة الشائعة) — لكن **الضمان الحقيقي** ضدّ
 * سباقٍ متزامن هو قيد `uq_provision_active_code` في DB (فحص التطبيق وحده عرضة لـTOCTOU:
 * طلبان متزامنان قد يمرّان الفحص معاً قبل أن يُدرِج أيّهما — مراجعة عدائية ٣/٧). لذا نلتقط
 * خطأ تكرار المفتاح من الإدراج نفسه ونحوّله لنفس رسالة CONFLICT الودّية. يولّد كلمة مرور
 * عشوائية قوية للمدير الأول ويُعيدها **مرّة واحدة فقط** — لا تُخزَّن مفكوكة التشفير بعدها.
 */
export async function createProvisionRequest(
  input: CreateProvisionRequestInput
): Promise<{ id: number; tempPassword: string }> {
  const db = requireDb();
  const code = input.code.trim().toLowerCase();
  if (!CODE_RE.test(code)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "رمز الشركة بحروف صغيرة/أرقام/شُرَط فقط (kebab-case)، بين حرفين و٤٠ حرفاً.",
    });
  }

  const existingCompany = (await db.select({ id: companies.id }).from(companies).where(eq(companies.code, code)).limit(1))[0];
  if (existingCompany) {
    throw new TRPCError({ code: "CONFLICT", message: "رمز الشركة مستخدَم فعلاً." });
  }
  const pendingSameCode = (
    await db
      .select({ id: companyProvisionRequests.id })
      .from(companyProvisionRequests)
      .where(and(eq(companyProvisionRequests.code, code), inArray(companyProvisionRequests.status, ["PENDING", "PROCESSING"])))
      .limit(1)
  )[0];
  if (pendingSameCode) {
    throw new TRPCError({ code: "CONFLICT", message: "يوجد طلب توفير قيد التنفيذ بهذا الرمز فعلاً." });
  }

  const tempPassword = generateStrongPassword();
  const tempPasswordEncrypted = encryptSecret(tempPassword);
  if (!tempPasswordEncrypted) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "فشل تشفير كلمة المرور المؤقّتة." });
  }

  try {
    const result = await db.insert(companyProvisionRequests).values({
      code,
      name: input.name.trim(),
      adminEmail: input.adminEmail.trim().toLowerCase(),
      adminUsername: input.adminUsername.trim() || "admin",
      demo: input.demo,
      tempPasswordEncrypted,
      requestedByAdminId: input.requestedByAdminId,
    });
    const id = extractInsertId(result);
    return { id, tempPassword };
  } catch (e) {
    // ER_DUP_ENTRY على uq_provision_active_code = طلب PENDING/PROCESSING آخر سبقنا بنفس
    // الرمز في نافذة السباق بين فحص التفرّد أعلاه والإدراج — القيد الحقيقي في DB هو ما
    // أوقف هذا، لا الفحص السابق. نُترجمها لنفس رسالة CONFLICT الودّية بدل رمي خطأ MySQL خام.
    // ⚠️ drizzle-orm يلفّ خطأ mysql2 الحقيقي في DrizzleQueryError.cause (لا e.code مباشرة —
    // نفس علّة db-migrate-apply.mjs المُصلَحة في #110، راجع ذاكرة exchange-sign-toggle).
    const cause = (e as { cause?: { code?: string } } | null)?.cause;
    const errCode = cause?.code ?? (e as { code?: string } | null)?.code;
    if (errCode === "ER_DUP_ENTRY") {
      throw new TRPCError({ code: "CONFLICT", message: "يوجد طلب توفير قيد التنفيذ بهذا الرمز فعلاً." });
    }
    throw e;
  }
}

export type ProvisionRequestPublic = Omit<CompanyProvisionRequest, "tempPasswordEncrypted">;

function toPublic(row: CompanyProvisionRequest): ProvisionRequestPublic {
  const { tempPasswordEncrypted: _omit, ...rest } = row;
  return rest;
}

/** حالة طلب توفير واحد (بلا كلمة المرور) — لاستطلاع شاشة /platform-admin. */
export async function getProvisionRequestStatus(id: number): Promise<ProvisionRequestPublic | null> {
  const db = requireDb();
  const row = (await db.select().from(companyProvisionRequests).where(eq(companyProvisionRequests.id, id)).limit(1))[0];
  return row ? toPublic(row) : null;
}

/** آخر طلبات التوفير (بلا كلمات مرور) — لجدول «آخر الطلبات» في الشاشة. */
export async function listRecentProvisionRequests(limit = 20): Promise<ProvisionRequestPublic[]> {
  const db = requireDb();
  const rows = await db
    .select()
    .from(companyProvisionRequests)
    .orderBy(desc(companyProvisionRequests.createdAt))
    .limit(limit);
  return rows.map(toPublic);
}

export interface ClaimedProvisionRequest {
  id: number;
  code: string;
  name: string;
  adminEmail: string;
  adminUsername: string;
  demo: boolean;
  tempPassword: string;
}

/**
 * ⚠️ للعامل المنفصل (`company-provision-worker.mjs`) فقط — لا يُستدعى أبداً من مسار
 * HTTP/tRPC. يطالب (claim) بأقدم طلب PENDING عبر UPDATE شرطي (`WHERE status='PENDING'`)
 * فيمنع سباقاً لو شُغِّلت نسختان من العامل بالتزامن (لن تفوز إلا نسخة واحدة على نفس
 * الصفّ — تحديث SQL شرطي ذرّي على مستوى الصفّ). يُعيد كلمة المرور **مفكوكة التشفير**.
 */
export async function claimNextPendingRequest(): Promise<ClaimedProvisionRequest | null> {
  const db = requireDb();
  const candidates = await db
    .select({ id: companyProvisionRequests.id })
    .from(companyProvisionRequests)
    .where(eq(companyProvisionRequests.status, "PENDING"))
    .orderBy(companyProvisionRequests.createdAt)
    .limit(5);

  for (const candidate of candidates) {
    const claim = await db
      .update(companyProvisionRequests)
      .set({ status: "PROCESSING", startedAt: new Date() })
      .where(and(eq(companyProvisionRequests.id, candidate.id), eq(companyProvisionRequests.status, "PENDING")));
    if (extractAffectedRows(claim) !== 1) continue; // نسخة أخرى سبقتنا لهذا الصفّ — جرّب التالي

    const row = (
      await db.select().from(companyProvisionRequests).where(eq(companyProvisionRequests.id, candidate.id)).limit(1)
    )[0];
    if (!row || !row.tempPasswordEncrypted) continue;
    const tempPassword = decryptSecret(row.tempPasswordEncrypted);
    if (!tempPassword) continue;
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      adminEmail: row.adminEmail,
      adminUsername: row.adminUsername,
      demo: row.demo,
      tempPassword,
    };
  }
  return null;
}

/** يُنجز طلباً بنجاح — يمسح كلمة المرور المؤقّتة فوراً (لا حاجة لها بعد الآن). */
export async function markProvisionRequestDone(id: number, resultCompanyId: number): Promise<void> {
  const db = requireDb();
  await db
    .update(companyProvisionRequests)
    .set({ status: "DONE", resultCompanyId, completedAt: new Date(), tempPasswordEncrypted: null })
    .where(eq(companyProvisionRequests.id, id));
}

/** يفشل طلباً — يُبقي كلمة المرور المشفّرة (تتيح إعادة محاولة الطلب نفسه لاحقاً). */
export async function markProvisionRequestFailed(id: number, errorMessage: string): Promise<void> {
  const db = requireDb();
  await db
    .update(companyProvisionRequests)
    .set({ status: "FAILED", errorMessage: errorMessage.slice(0, 4000), completedAt: new Date() })
    .where(eq(companyProvisionRequests.id, id));
}
