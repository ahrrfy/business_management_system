import "dotenv/config";
import { readFileSync } from "node:fs";
import { createCompanyRecord } from "../registry";
import { closeControlDb } from "../controlDb";

/**
 * نقطة دخول CLI صغيرة تُستدعى من `scripts/company-new.mjs` (عبر tsx) لتسجيل شركة
 * في قاعدة التحكّم بعد توفير قاعدتها الفعلية. تقرأ مدخلاتها كـJSON من **ملف مؤقّت**
 * (لا كوسيط CLI خام) — تمرير JSON (مسافات/علامات اقتباس/عربي) كوسيط خام عبر
 * execFileSync على ويندوز (shell:true) يُفسِد الاقتباس فيُنتج JSON.parse تالفاً.
 */
async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("✗ الاستخدام: tsx registerCompany.ts <مسار ملف JSON مؤقّت>");
    process.exit(1);
  }
  const input = JSON.parse(readFileSync(filePath, "utf8"));
  const id = await createCompanyRecord(input);
  console.log(JSON.stringify({ id }));
}

main()
  .then(() => closeControlDb())
  .catch(async (e) => {
    console.error("✗ فشل تسجيل الشركة:", e?.message ?? e);
    await closeControlDb();
    process.exit(1);
  });
