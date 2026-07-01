// يُطبِّق تحديثات المخطّط (بعد db:generate محلياً) على كل قاعدة شركة فعّالة، شركة تلو
// الأخرى — نسخة احتياطية طازجة أولاً ثم بوّابة الهجرة الآمنة الموجودة (بلا تعديل عليها):
// لكل شركة: node scripts/backup.mjs (بـBACKUP_TARGET_URL) ⇒ node scripts/db-migrate-safe.mjs
// (بـDATABASE_URL/DB_NAME لتلك الشركة) ⇒ يستدعي db-migrate-apply.mjs الموجود.
//
// الاستخدام (بعد git pull + pnpm install على الخادم):
//   CONTROL_DATABASE_URL='...' node scripts/migrate-all-companies.mjs
//
// يتوقّف عند أوّل فشل (لا يُكمل لباقي الشركات بمخطّط غير مكتمل) — الشركات المُطبَّقة
// سلفاً تبقى صحيحة (كل شركة معاملة مستقلّة)، وأعِد التشغيل يُكمل الباقي (الهجرات
// idempotent عبر journal drizzle القياسي).
import { execFileSync } from "node:child_process";

function fail(msg) { console.error("✗", msg); process.exit(1); }

if (!process.env.CONTROL_DATABASE_URL) {
  fail("CONTROL_DATABASE_URL غير محدّد.");
}

let companies;
try {
  const out = execFileSync("pnpm", ["exec", "tsx", "server/tenancy/cli/listCompanyConnections.ts"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const lastLine = out.trim().split("\n").filter(Boolean).pop();
  companies = JSON.parse(lastLine);
} catch (e) {
  fail(`فشل جلب قائمة الشركات من erp_control:\n${e?.message ?? e}`);
}

if (companies.length === 0) {
  console.log("• لا شركات فعّالة في erp_control — لا هجرات لتطبيقها.");
  process.exit(0);
}

console.log(`→ تطبيق الهجرات على ${companies.length} شركة/شركات فعّالة…`);
for (const company of companies) {
  const dbName = new URL(company.connectionUrl).pathname.replace(/^\//, "");
  console.log(`\n— الشركة «${company.code}» (${dbName}) —`);

  console.log("  ١) نسخة احتياطية طازجة…");
  try {
    execFileSync(process.execPath, ["scripts/backup.mjs", "--no-rotate"], {
      stdio: "inherit",
      env: { ...process.env, BACKUP_TARGET_URL: company.connectionUrl },
    });
  } catch {
    fail(`فشلت النسخة الاحتياطية للشركة «${company.code}» — أُوقفت العملية قبل أي هجرة (الشركات السابقة سليمة).`);
  }

  console.log("  ٢) بوّابة الهجرة الآمنة…");
  try {
    execFileSync(process.execPath, ["scripts/db-migrate-safe.mjs"], {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: company.connectionUrl, DB_NAME: dbName },
    });
  } catch {
    fail(`فشلت الهجرة للشركة «${company.code}» — أُوقفت العملية (نسختها الاحتياطية جاهزة للاستعادة، الشركات السابقة سليمة).`);
  }
}

console.log(`\n✓ اكتملت الهجرات على كل الشركات الفعّالة (${companies.length}).`);
