#!/usr/bin/env node
/**
 * حارس CASH-CORE: يَرفض أيّ كَتابة مُباشرة على `receipts` خارج `cashOps.ts`.
 *
 * المَنطق: cashOps هو نُقطة الدخول الوَحيدة لحركات النَقد. أي insert/update مُباشر
 * على جَدول receipts خارج cashOps.ts يَكسر الـinvariants (idempotency, balanceAfter
 * snapshot, atomic audit). الحارس يَفحص الـregex ويَرفض pre-commit.
 *
 * **مَرحلة POC (الآن):** warning فقط — لا يَرفض. التَفعيل في المَرحلة أ بَعد إكمال
 * استبدال كل الخدمات لتَستدعي cashOps.execute.
 *
 * **التَجاوز:** ALLOW_CASH_DIRECT=1 (للهجرة فقط).
 */
import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

const ROOT = process.cwd();
const SERVER = join(ROOT, "server");
// المَلفات المَسموح لها بالكَتابة المُباشرة على receipts (نُقطة الدخول + الترحيل).
const ALLOWED = new Set([
  "server/services/cashOps.ts",
  "server/services/cashReconcile.ts", // قراءة فقط لكن للوضوح
  "scripts/migrate-cash-to-buckets.mjs",
]);

// خِلال مَرحلة الانتقال (POC + المَرحلة أ): الخدمات الموجودة تَكتب مُباشرة لكن تُعطى مُهلة.
// كل مَلَف يَتم تَهجيره يُحذَف من هذه القائمة. الهَدف: قائمة فارغة بَعد إكمال CASH-CORE.
const PENDING_MIGRATION = new Set([
  "server/services/saleService.ts",
  "server/services/returnService.ts",
  "server/services/expenseService.ts",
  "server/services/shiftService.ts",
  "server/services/voucherService.ts",
  "server/services/workOrderService.ts",
  "server/services/purchaseService.ts",
  "server/services/purchaseReturnsService.ts",
]);

const RX = /\.insert\(\s*receipts\b|\.update\(\s*receipts\b/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "dist" || name === "__tests__") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function relRepo(p) {
  return p.slice(ROOT.length + 1).split(sep).join("/");
}

function main() {
  if (process.env.ALLOW_CASH_DIRECT === "1") {
    console.log("⚠️  ALLOW_CASH_DIRECT=1 ⇒ تَخطّي حارس cash-direct-writes (للهجرة).");
    return 0;
  }
  const files = walk(SERVER);
  const violations = [];
  for (const f of files) {
    const rel = relRepo(f);
    if (ALLOWED.has(rel)) continue;
    const content = readFileSync(f, "utf8");
    if (!RX.test(content)) continue;
    if (PENDING_MIGRATION.has(rel)) {
      // قائمة الانتقال: warning فقط
      console.warn(`⏳  ${rel}: يَكتب على receipts مُباشرة (مَوقَّت — مُنتظَر هَجره إلى cashOps.execute).`);
      continue;
    }
    // ملف غير مُتوقَّع ⇒ خَرق صَريح
    violations.push(rel);
  }

  if (violations.length > 0) {
    console.error("\n⛔ حارس CASH-CORE: مَلفات تَكتب على `receipts` خارج cashOps:");
    for (const v of violations) console.error(`   - ${v}`);
    console.error("\nالحَل: استَخدم cashOps.execute() بَدلاً من tx.insert(receipts).");
    console.error("أو أَضِف المَلَف إلى ALLOWED في scripts/lint-cash-direct-writes.mjs لو كان مَقصوداً.\n");
    return 1;
  }
  console.log("✓ حارس CASH-CORE: لا كَتابات مُباشرة غير مُصرَّح بها.");
  return 0;
}

process.exit(main());
