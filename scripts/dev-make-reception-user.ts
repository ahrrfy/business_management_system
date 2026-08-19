/**
 * حسابُ **موظّف استقبال** للتحقّق البصريّ (١٩/٨) — قراءةُ الشاشات بعينه لا بعين المدير.
 *
 * يُنشأ بمسار النظام نفسه: دورُ `cashier` + تخصيصُ قالب `reception_clerk` الحاكم
 * (`sales:READ` · `pos:NONE`) من `shared/permissions.ts` — لا حقنَ صلاحياتٍ بيدي.
 *
 * ⛔ تطويريٌّ محض: يرفض أيّ قاعدةٍ لا ينتهي اسمُها بـ`_dev`.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import * as s from "../drizzle/schema";
import { getDb } from "../server/db";
import { hashPassword } from "../server/auth/password";
import { SECTION_CASHIER_ROLES } from "../shared/permissions";

const url = process.env.DATABASE_URL ?? "";
if (!/_dev(\?|$)/.test(url)) {
  console.error("قاعدةٌ غير تطويرية — رُفض:", url.replace(/:[^:@]*@/, ":***@"));
  process.exit(1);
}

const EMAIL = "reception@alroya.local";
const PASSWORD = process.env.RECEPTION_DEV_PASSWORD;
if (!PASSWORD || PASSWORD.length < 12) {
  console.error("اضبط RECEPTION_DEV_PASSWORD (١٢ محرفاً فأكثر) قبل التشغيل.");
  process.exit(1);
}

async function main() {
  const db = getDb()!;
  const preset = SECTION_CASHIER_ROLES.find((p) => p.key === "reception_clerk");
  if (!preset) throw new Error("قالب reception_clerk غير موجود في shared/permissions.ts");

  const hash = await hashPassword(PASSWORD);
  const existing = (await db.select().from(s.users).where(eq(s.users.email, EMAIL)).limit(1))[0];

  if (existing) {
    await db.update(s.users).set({
      role: preset.baseRole as never,
      permissionsOverride: preset.permissions as never,
      passwordHash: hash,
      isActive: true,
      branchId: 1,
    }).where(eq(s.users.id, existing.id));
    console.log(`حُدِّث الحساب #${existing.id}`);
  } else {
    const r = await db.insert(s.users).values({
      openId: "dev-reception",
      name: "سارة — موظفة استقبال",
      email: EMAIL,
      role: preset.baseRole as never,
      permissionsOverride: preset.permissions as never,
      loginMethod: "local",
      passwordHash: hash,
      branchId: 1,
      isActive: true,
      jobTitle: preset.label,
    } as never);
    console.log("أُنشئ الحساب:", (r as never as { insertId: number }).insertId ?? (r as never as [{ insertId: number }])[0].insertId);
  }

  const row = (await db.select().from(s.users).where(eq(s.users.email, EMAIL)).limit(1))[0];
  console.log({ id: row.id, name: row.name, role: row.role, branchId: row.branchId });
  console.log("الصلاحيات:", JSON.stringify(row.permissionsOverride));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
