import { eq } from "drizzle-orm";
import { DUMMY_STORED, hashPassword, verifyPassword } from "../auth/password";
import { extractInsertId } from "../lib/insertId";
import { getControlDb } from "./controlDb";
import { platformAdmins, type PlatformAdmin } from "./controlSchema";

/** يُنشئ مدير منصّة (لا واجهة لإنشائه — بوّابة بيضة-ودجاجة — يُستدعى من
 *  scripts/platform-admin-new.mjs فقط عبر tsx CLI). */
export async function createPlatformAdmin(input: { email: string; password: string; name: string }): Promise<number> {
  const db = getControlDb();
  if (!db) throw new Error("CONTROL_DATABASE_URL غير مضبوط — شغّل bootstrap-control-db.mjs أولاً.");
  const existing = await db.select().from(platformAdmins).where(eq(platformAdmins.email, input.email)).limit(1);
  if (existing[0]) throw new Error(`مدير منصّة بهذا البريد موجود سلفاً: ${input.email}`);
  const result = await db.insert(platformAdmins).values({
    email: input.email,
    passwordHash: hashPassword(input.password),
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
  const ok = verifyPassword(password, admin?.passwordHash ?? DUMMY_STORED);
  if (!admin || !ok || !admin.isActive) return null;
  return admin;
}
