import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPlatformAdmin } from "../platformAdminService";
import { closeControlDb } from "../controlDb";

/** نقطة دخول CLI صغيرة تُستدعى من scripts/platform-admin-new.mjs (عبر tsx). تقرأ
 *  مدخلاتها من ملف JSON مؤقّت (لا وسيط CLI خام — نفس سبب registerCompany.ts). */
async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("✗ الاستخدام: tsx createPlatformAdmin.ts <مسار ملف JSON مؤقّت>");
    process.exit(1);
  }
  const input = JSON.parse(readFileSync(filePath, "utf8"));
  const id = await createPlatformAdmin(input);
  console.log(JSON.stringify({ id }));
}

main()
  .then(() => closeControlDb())
  .catch(async (e) => {
    console.error("✗ فشل إنشاء مدير المنصّة:", e?.message ?? e);
    await closeControlDb();
    process.exit(1);
  });
