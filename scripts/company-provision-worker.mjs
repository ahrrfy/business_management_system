// عامل توفير الشركات — عملية منفصلة تماماً عن خادم الويب الحيّ (erp-server)، بصلاحيات
// مرتفعة (docker exec + كلمة سرّ MySQL الجذر + تشغيل عمليات فرعية) لا يملكها خادم
// الويب أبداً. يستهلك طلبات أنشأتها شاشة /platform-admin (عبر platformAdminRouter.
// companies.requestCreate) من طابور companyProvisionRequests في قاعدة التحكّم.
//
// تشغيل واحد يعالج **كل** الطلبات PENDING المعلَّقة ثم يخرج (نمط single-shot، لا daemon
// مستمرّ) — يُستدعى دورياً عبر PM2 cron_restart أو Task Scheduler (راجع ecosystem.config.cjs
// تطبيق "erp-provision-worker" — env مختلف تماماً عن "erp-server"، لا تُدمج البيئتين أبداً).
//
// الاستخدام:
//   CONTROL_DATABASE_URL=... DB_CONTAINER=... DB_ROOT_PW=... INTEGRATIONS_ENCRYPTION_KEY=... \
//     node scripts/company-provision-worker.mjs
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { hostPortFromUrl, parseEnvFile, provisionCompany } from "./lib/provisionCompany.mjs";

const MAX_PER_RUN = 10; // حاجز أمان — يمنع حلقة لا نهائية لو تعطّل claim-next بشكل غير متوقّع.

function log(msg) { console.log(msg); }
function fail(msg) { console.error("✗", msg); process.exit(1); }

const controlUrl = process.env.CONTROL_DATABASE_URL;
if (!controlUrl) fail("CONTROL_DATABASE_URL غير مضبوط لهذا العامل — لا معنى لتشغيله بدونه.");
if (!process.env.INTEGRATIONS_ENCRYPTION_KEY) fail("INTEGRATIONS_ENCRYPTION_KEY غير مضبوط — لازم لفكّ تشفير كلمات المرور المؤقّتة.");

const root = process.cwd();
const rootEnvFile = path.join(root, ".env");
const rootEnv = existsSync(rootEnvFile) ? parseEnvFile(readFileSync(rootEnvFile, "utf8")) : new Map();
const baseHostPort = hostPortFromUrl(rootEnv.get("DATABASE_URL") || "mysql://root:erp_root_pw@127.0.0.1:3306/erp");

const dbContainer = process.env.DB_CONTAINER || "erp-mysql";
const rootPw = process.env.DB_ROOT_PW || "erp_root_pw";
const dbHost = process.env.DB_HOST || baseHostPort.host;
const dbPort = Number(process.env.DB_PORT || baseHostPort.port);

function runStep(command, payload) {
  const args = ["exec", "tsx", "server/tenancy/cli/provisionWorkerStep.ts", command];
  let payloadFile;
  if (payload) {
    payloadFile = path.join(os.tmpdir(), `erp-provision-step-${randomBytes(6).toString("hex")}.json`);
    writeFileSync(payloadFile, JSON.stringify(payload));
    args.push(payloadFile);
  }
  try {
    return execFileSync("pnpm", args, {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32",
      env: { ...process.env, CONTROL_DATABASE_URL: controlUrl },
    });
  } finally {
    if (payloadFile) { try { unlinkSync(payloadFile); } catch { /* تجاهل */ } }
  }
}

let processed = 0;
let failed = 0;
for (let i = 0; i < MAX_PER_RUN; i++) {
  const claimOut = runStep("claim-next");
  const lastLine = claimOut.trim().split("\n").filter(Boolean).pop();
  const claimed = lastLine ? JSON.parse(lastLine) : null;
  if (!claimed) break;

  log(`\n• طلب #${claimed.id}: توفير شركة "${claimed.name}" (رمز: ${claimed.code})…`);
  try {
    const { companyId } = await provisionCompany({
      root,
      code: claimed.code,
      name: claimed.name,
      adminEmail: claimed.adminEmail,
      adminPassword: claimed.tempPassword,
      adminUsername: claimed.adminUsername,
      demo: claimed.demo,
      adminMustChangePassword: true,
      dbContainer,
      rootPw,
      dbHost,
      dbPort,
      controlUrl,
      log,
    });
    runStep("mark-done", { id: claimed.id, companyId });
    log(`✓ طلب #${claimed.id} اكتمل — معرّف الشركة: ${companyId}`);
    processed++;
  } catch (e) {
    const errorMessage = e?.message ?? String(e);
    console.error(`✗ طلب #${claimed.id} فشل: ${errorMessage}`);
    try {
      runStep("mark-failed", { id: claimed.id, errorMessage });
    } catch (e2) {
      console.error(`✗ فشل أيضاً تسجيل الفشل لطلب #${claimed.id}:`, e2?.message ?? e2);
    }
    failed++;
  }
}

log(`\nانتهى: ${processed} نجح، ${failed} فشل${processed + failed === 0 ? " — لا طلبات معلَّقة." : "."}`);
if (failed > 0) process.exitCode = 1;
