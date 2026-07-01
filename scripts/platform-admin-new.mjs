// إنشاء مدير منصّة (تعدّد الشركات) — بوّابة بيضة-ودجاجة: لا واجهة لإنشاء أوّل مدير،
// يُنفَّذ مرّة عبر هذا السكربت مباشرةً على الخادم من قِبل المالك/المُشغِّل.
//
// الاستخدام:
//   CONTROL_DATABASE_URL='mysql://...' node scripts/platform-admin-new.mjs <بريد> <اسم> <كلمة سر>
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function fail(msg) { console.error("✗", msg); process.exit(1); }

const [, , email, name, password] = process.argv;
if (!email || !name || !password) {
  fail("الاستخدام: node scripts/platform-admin-new.mjs <بريد> \"<اسم>\" <كلمة سر>");
}
if (!process.env.CONTROL_DATABASE_URL) {
  fail("CONTROL_DATABASE_URL غير محدّد. شغّل scripts/bootstrap-control-db.mjs أولاً.");
}

const payloadFile = path.join(os.tmpdir(), `erp-platform-admin-new-${randomBytes(6).toString("hex")}.json`);
writeFileSync(payloadFile, JSON.stringify({ email: email.trim().toLowerCase(), name, password }));
try {
  const out = execFileSync(
    "pnpm",
    ["exec", "tsx", "server/tenancy/cli/createPlatformAdmin.ts", payloadFile],
    { encoding: "utf8", shell: process.platform === "win32", env: process.env }
  );
  const lastLine = out.trim().split("\n").filter(Boolean).pop();
  const { id } = JSON.parse(lastLine);
  console.log(`✓ مدير منصّة جاهز: ${email} (معرّف: ${id})`);
  console.log(`  يدخل من /platform-admin ببريده وكلمة مروره.`);
} catch (e) {
  fail(`فشل الإنشاء:\n${e?.message ?? e}`);
} finally {
  try { unlinkSync(payloadFile); } catch { /* تجاهل */ }
}
