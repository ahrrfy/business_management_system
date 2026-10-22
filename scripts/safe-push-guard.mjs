/**
 * بروتوكول الدفع الآمن (Safe Push Guard) — يُستدعى آلياً من `.husky/pre-push`.
 *
 * القواعد المُلزِمة:
 * 1. منع الدفع المباشر إلى `refs/heads/main` منعاً باتاً؛ كل تغيير يمرّ عبر فرع + PR
 *    حتى تعمل فحوصات CI الكاملة (8 شوارد + الفحص الأمني) ومراجعة Codex الآلية قبل الدمج.
 *    (مخرج طوارئ المالك حصراً: `ALLOW_DIRECT_MAIN_PUSH=1`).
 * 2. تشغيل أي اختبارات وحدة (`vitest.unit.config.ts`) تأثرت في فرق الفرع مقابل `origin/main`
 *    قبل السماح بالدفع.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parsePrePushStdin(stdinText = "") {
  return String(stdinText)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha };
    })
    .filter((entry) => Boolean(entry.remoteRef));
}

export function evaluatePrePushPolicy({
  remoteRefs = [],
  currentBranch = "",
  cliArgs = [],
  env = process.env,
} = {}) {
  if (env?.ALLOW_DIRECT_MAIN_PUSH === "1") {
    return { allowed: true, code: "OK_BYPASS" };
  }

  const normalizedRefs = remoteRefs.map((r) =>
    typeof r === "string" ? r.trim() : String(r?.remoteRef ?? "").trim(),
  );

  const cliTargetsMain = cliArgs.some((arg) => {
    const trimmed = String(arg ?? "").trim();
    return (
      trimmed === "main" ||
      trimmed === "refs/heads/main" ||
      trimmed.endsWith(":main") ||
      trimmed.endsWith(":refs/heads/main")
    );
  });

  const stdinTargetsMain = normalizedRefs.some(
    (ref) => ref === "refs/heads/main" || ref === "main",
  );

  const implicitMainPush =
    normalizedRefs.length === 0 &&
    !cliArgs.some((a) => String(a).includes(":")) &&
    String(currentBranch).trim() === "main";

  if (stdinTargetsMain || cliTargetsMain || implicitMainPush) {
    return {
      allowed: false,
      code: "DIRECT_MAIN_PUSH_FORBIDDEN",
      reason:
        "يُحظر الدفع المباشر إلى الفرع المحمي main. ادفع إلى فرع جلسة/ميزة ثم افتح طلب دمج (PR) وادمج عبر البروتوكول الآمن (pnpm pr:merge) بعد اخضرار CI ومعالجة الملاحظات.",
    };
  }

  return { allowed: true, code: "OK" };
}

export function runSafePushSelftest() {
  const blockedStdin = evaluatePrePushPolicy({
    remoteRefs: ["refs/heads/main"],
    currentBranch: "feature/test",
    env: {},
  });
  assert.equal(blockedStdin.allowed, false);
  assert.equal(blockedStdin.code, "DIRECT_MAIN_PUSH_FORBIDDEN");

  const blockedImplicit = evaluatePrePushPolicy({
    remoteRefs: [],
    currentBranch: "main",
    env: {},
  });
  assert.equal(blockedImplicit.allowed, false);
  assert.equal(blockedImplicit.code, "DIRECT_MAIN_PUSH_FORBIDDEN");

  const blockedCli = evaluatePrePushPolicy({
    remoteRefs: [],
    currentBranch: "feature/test",
    cliArgs: ["origin", "HEAD:refs/heads/main"],
    env: {},
  });
  assert.equal(blockedCli.allowed, false);
  assert.equal(blockedCli.code, "DIRECT_MAIN_PUSH_FORBIDDEN");

  const allowedBranch = evaluatePrePushPolicy({
    remoteRefs: ["refs/heads/fix/ui-density"],
    currentBranch: "fix/ui-density",
    env: {},
  });
  assert.equal(allowedBranch.allowed, true);
  assert.equal(allowedBranch.code, "OK");

  const allowedBypass = evaluatePrePushPolicy({
    remoteRefs: ["refs/heads/main"],
    currentBranch: "main",
    env: { ALLOW_DIRECT_MAIN_PUSH: "1" },
  });
  assert.equal(allowedBypass.allowed, true);
  assert.equal(allowedBypass.code, "OK_BYPASS");

  console.log("safe-push-guard selftest: OK");
}

function getCurrentBranch() {
  const res = spawnSync("git", ["symbolic-ref", "--short", "-q", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return res.status === 0 ? res.stdout.trim() : "";
}

function readStdinIfPiped() {
  if (process.stdin.isTTY) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function getModifiedUnitTests() {
  const unitConfigPath = path.join(REPO_ROOT, "vitest.unit.config.ts");
  if (!fs.existsSync(unitConfigPath)) return [];
  const unitConfigText = fs.readFileSync(unitConfigPath, "utf8");
  const diffRes = spawnSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", "origin/main...HEAD"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (diffRes.status !== 0) return [];
  return diffRes.stdout
    .split(/\r?\n/)
    .map((f) => f.trim().replace(/\\/g, "/"))
    .filter(
      (f) =>
        (f.endsWith(".test.ts") || f.endsWith(".test.tsx")) &&
        unitConfigText.includes(`"${f}"`) &&
        fs.existsSync(path.join(REPO_ROOT, f)),
    );
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) {
    runSafePushSelftest();
    return;
  }

  const stdinText = readStdinIfPiped();
  const parsedRefs = parsePrePushStdin(stdinText);
  const currentBranch = getCurrentBranch();
  const decision = evaluatePrePushPolicy({
    remoteRefs: parsedRefs.map((r) => r.remoteRef),
    currentBranch,
    cliArgs: args,
    env: process.env,
  });

  if (!decision.allowed) {
    console.error(`\n⛔ [${decision.code}] ${decision.reason}`);
    console.error(
      "   المسار المعتمد: git push -u origin <فرعك> ← gh pr create ← pnpm pr:merge <رقم-الطلب>\n",
    );
    process.exit(1);
  }

  if (process.env.SKIP_PRE_PUSH_UNIT_TESTS !== "1") {
    const changedUnitTests = getModifiedUnitTests();
    if (changedUnitTests.length > 0) {
      console.log(
        `▶ فحص اختبارات الوحدة المتأثرة قبل الدفع (${changedUnitTests.length} ملف)...`,
      );
      const testRes = spawnSync(
        "pnpm",
        [
          "exec",
          "cross-env",
          "TZ=UTC",
          "vitest",
          "run",
          "--config",
          "vitest.unit.config.ts",
          ...changedUnitTests,
        ],
        {
          cwd: REPO_ROOT,
          stdio: "inherit",
          shell: process.platform === "win32",
        },
      );
      if (testRes.status !== 0) {
        console.error(
          "\n⛔ فشل أحد اختبارات الوحدة المتأثرة — أصلحه قبل الدفع.",
        );
        process.exit(testRes.status ?? 1);
      }
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main();
}
