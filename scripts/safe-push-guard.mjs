/**
 * بروتوكول الدفع الآمن (Safe Push Guard) — يُستدعى آلياً من `.husky/pre-push`.
 *
 * القواعد المُلزِمة:
 * 1. منع الدفع المباشر إلى `refs/heads/main` منعاً باتاً؛ كل تغيير يمرّ عبر فرع + PR
 *    حتى تعمل فحوصات CI الكاملة (8 شوارد + الفحص الأمني) ومراجعة Codex الآلية قبل الدمج.
 *    (مخرج طوارئ المالك حصراً: `ALLOW_DIRECT_MAIN_PUSH=1`).
 * 2. فحص الالتزامات المدفوعة فعلياً (`localSha` من عقد `pre-push` القياسي) مقابل `origin/main`،
 *    والإغلاق الآمن (fail-closed) إذا تعذّر الوصول إلى `origin/main` أو حساب قاعدة الدمج.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZERO_OID_RE = /^0+$/;

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

export function resolvePushedCommitShas(stdinEntries = []) {
  if (!Array.isArray(stdinEntries) || stdinEntries.length === 0) {
    return ["HEAD"];
  }
  const shas = [];
  const seen = new Set();
  for (const entry of stdinEntries) {
    const sha = String(entry?.localSha ?? "").trim();
    if (!sha || ZERO_OID_RE.test(sha)) continue;
    if (!seen.has(sha)) {
      seen.add(sha);
      shas.push(sha);
    }
  }
  return shas;
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

function defaultDiffRunner(sha) {
  return spawnSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", `origin/main...${sha}`],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
}

export function collectModifiedUnitTestsForPush({
  stdinEntries = [],
  unitConfigText = "",
  runDiff = defaultDiffRunner,
  fileExists = (relPath) => fs.existsSync(path.join(REPO_ROOT, relPath)),
} = {}) {
  const shas = resolvePushedCommitShas(stdinEntries);
  if (shas.length === 0) {
    return [];
  }

  if (!unitConfigText || !unitConfigText.trim()) {
    const err = new Error("تعذّر قراءة ملف vitest.unit.config.ts للتحقق من اختبارات الوحدة قبل الدفع.");
    err.code = "PUSH_GUARD_UNIT_CONFIG_MISSING";
    throw err;
  }

  const changedFiles = new Set();
  for (const sha of shas) {
    const diffRes = runDiff(sha);
    if (!diffRes || diffRes.status !== 0) {
      const stderr = String(diffRes?.stderr ?? "").trim();
      const err = new Error(
        `تعذّر حساب الفرق مقابل origin/main للالتزام المدفوع (${sha}). نفّذ «git fetch origin main» وتأكد من توفر التاريخ الكامل قبل الدفع.${stderr ? ` (${stderr})` : ""}`,
      );
      err.code = "PUSH_GUARD_BASE_DIFF_FAILED";
      throw err;
    }
    const lines = String(diffRes.stdout ?? "")
      .split(/\r?\n/)
      .map((f) => f.trim())
      .filter(Boolean);
    for (const file of lines) {
      changedFiles.add(file);
    }
  }

  const matchedTests = [];
  for (const file of changedFiles) {
    if (!/\.test\.tsx?$/.test(file)) continue;
    if (!unitConfigText.includes(`"${file}"`) && !unitConfigText.includes(`'${file}'`)) {
      continue;
    }
    if (!fileExists(file)) {
      const err = new Error(
        `الملف الاختباري المتأثر «${file}» في الالتزام المدفوع غير موجود في شجرة العمل الحالية؛ تحقّق من الفرع الحالي قبل الدفع.`,
      );
      err.code = "PUSH_GUARD_WORKTREE_MISMATCH";
      throw err;
    }
    matchedTests.push(file);
  }

  return matchedTests;
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

  // Verify pushed commit SHAs are diffed instead of assuming HEAD
  const diffedShas = [];
  const collected = collectModifiedUnitTestsForPush({
    stdinEntries: [
      {
        localRef: "refs/heads/feat/a",
        localSha: "1111111111111111111111111111111111111111",
        remoteRef: "refs/heads/feat/a",
        remoteSha: "0000000000000000000000000000000000000000",
      },
      {
        localRef: "(delete)",
        localSha: "0000000000000000000000000000000000000000",
        remoteRef: "refs/heads/feat/old",
        remoteSha: "2222222222222222222222222222222222222222",
      },
    ],
    unitConfigText: 'include: ["scripts/__tests__/safeDeliveryProtocols.test.ts"]',
    runDiff: (sha) => {
      diffedShas.push(sha);
      return { status: 0, stdout: "scripts/__tests__/safeDeliveryProtocols.test.ts\n" };
    },
    fileExists: () => true,
  });
  assert.deepEqual(diffedShas, ["1111111111111111111111111111111111111111"]);
  assert.deepEqual(collected, ["scripts/__tests__/safeDeliveryProtocols.test.ts"]);

  // Verify fail-closed when origin/main comparison fails
  assert.throws(
    () =>
      collectModifiedUnitTestsForPush({
        stdinEntries: [
          {
            localRef: "refs/heads/feat/a",
            localSha: "1111111111111111111111111111111111111111",
            remoteRef: "refs/heads/feat/a",
            remoteSha: "0000000000000000000000000000000000000000",
          },
        ],
        unitConfigText: 'include: ["scripts/__tests__/safeDeliveryProtocols.test.ts"]',
        runDiff: () => ({ status: 128, stderr: "fatal: ambiguous argument 'origin/main'" }),
        fileExists: () => true,
      }),
    (err) => err?.code === "PUSH_GUARD_BASE_DIFF_FAILED",
  );

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

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) {
    runSafePushSelftest();
    return;
  }

  const stdinText = readStdinIfPiped();
  const stdinEntries = parsePrePushStdin(stdinText);
  const currentBranch = getCurrentBranch();

  const decision = evaluatePrePushPolicy({
    remoteRefs: stdinEntries,
    currentBranch,
    cliArgs: args,
    env: process.env,
  });

  if (!decision.allowed) {
    console.error(`\n⛔ [${decision.code}] ${decision.reason}\n`);
    process.exit(1);
  }

  if (process.env.SKIP_PRE_PUSH_UNIT_TESTS === "1") {
    return;
  }

  const unitConfigPath = path.join(REPO_ROOT, "vitest.unit.config.ts");
  const unitConfigText = fs.existsSync(unitConfigPath)
    ? fs.readFileSync(unitConfigPath, "utf8")
    : "";

  let modifiedUnitTests = [];
  try {
    modifiedUnitTests = collectModifiedUnitTestsForPush({
      stdinEntries,
      unitConfigText,
    });
  } catch (error) {
    console.error(`\n⛔ [${error?.code ?? "PUSH_GUARD_ERROR"}] ${error?.message ?? error}\n`);
    process.exit(1);
  }

  if (modifiedUnitTests.length > 0) {
    console.log(
      `▶ [بروتوكول الدفع الآمن] تشغيل ${modifiedUnitTests.length} ملف اختبار وحدة متأثر قبل الدفع…`,
    );
    const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const testRes = spawnSync(
      pnpmCmd,
      ["exec", "vitest", "run", "--config", "vitest.unit.config.ts", ...modifiedUnitTests],
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
        shell: process.platform === "win32",
        env: { ...process.env, TZ: "UTC" },
      },
    );
    if (testRes.status !== 0) {
      console.error(
        "\n⛔ [PRE_PUSH_UNIT_TEST_FAILED] فشل أحد اختبارات الوحدة المتأثرة؛ تم إيقاف الدفع لحماية CI.\n",
      );
      process.exit(testRes.status ?? 1);
    }
  }
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main();
}
