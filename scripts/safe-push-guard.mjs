/**
 * بروتوكول الدفع الآمن (Safe Push Guard) — يُستدعى آلياً من `.husky/pre-push`.
 *
 * القواعد المُلزِمة:
 * 1. منع الدفع المباشر إلى `refs/heads/main` منعاً باتاً؛ كل تغيير يمرّ عبر فرع + PR
 *    حتى تعمل فحوصات CI الكاملة (8 شوارد + الفحص الأمني) ومراجعة Codex الآلية قبل الدمج.
 *    (مخرج طوارئ المالك حصراً: `ALLOW_DIRECT_MAIN_PUSH=1`).
 * 2. فحص الالتزامات المدفوعة فعلياً (`localSha` من عقد `pre-push` القياسي) مقابل `origin/main`،
 *    والإغلاق الآمن (fail-closed) إذا تعذّر الوصول إلى `origin/main` أو حساب قاعدة الدمج.
 * 3. التحقق من تطابق شجرة العمل الحالية (`HEAD` والملفات المتتبَّعة) مع `localSha` المدفوع،
 *    وتشغيل اختبارات الوحدة المتأثرة المسجّلة في `vitest.unit.config.ts` قبل السماح بالدفع.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
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

  const isMainRefName = (ref) =>
    ref === "main" || ref === "heads/main" || ref === "refs/heads/main";

  const cliTargetsMain = cliArgs.some((arg) => {
    const raw = String(arg ?? "").trim();
    const cleaned = raw.replace(/^\+/, "");
    return (
      isMainRefName(cleaned) ||
      cleaned.endsWith(":main") ||
      cleaned.endsWith(":heads/main") ||
      cleaned.endsWith(":refs/heads/main") ||
      raw === "--mirror" ||
      raw === "--all"
    );
  });

  const stdinTargetsMain = normalizedRefs.some(isMainRefName);

  const cleanBranch = String(currentBranch).trim();
  const implicitMainPush =
    normalizedRefs.length === 0 &&
    !cliArgs.some((a) => String(a).includes(":")) &&
    isMainRefName(cleanBranch);

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

function defaultGetHeadSha() {
  const res = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return res.status === 0 ? res.stdout.trim() : "";
}

function defaultGetTrackedStatus() {
  const res = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  );
  return res.status === 0 ? res.stdout.trim() : "DIRTY_STATUS_ERROR";
}

export function assertCheckoutMatchesPushedShas({
  shas = [],
  headSha = defaultGetHeadSha(),
  trackedStatus = defaultGetTrackedStatus(),
} = {}) {
  const cleanHead = String(headSha ?? "").trim();
  if (shas.length > 0 && !cleanHead) {
    const err = new Error(
      "تعذّر التحقق من بصمة HEAD الحالية في شجرة العمل قبل الدفع.",
    );
    err.code = "PUSH_GUARD_HEAD_MISMATCH";
    throw err;
  }
  for (const sha of shas) {
    if (sha === "HEAD") continue;
    if (sha !== cleanHead) {
      const err = new Error(
        `الالتزام المدفوع (${sha}) لا يطابق رأس شجرة العمل الحالية (${cleanHead || "غير معروف"})؛ انتقل إلى الالتزام المدفوع قبل الدفع حتى تعمل الاختبارات على الشجرة المدفوعة فعلياً.`,
      );
      err.code = "PUSH_GUARD_HEAD_MISMATCH";
      throw err;
    }
  }
  if (String(trackedStatus ?? "").trim().length > 0) {
    const err = new Error(
      "توجد تعديلات غير ملتزمة في الملفات المتتبعة أثناء الدفع؛ التزم التعديلات أو احفظها (git stash) حتى تطابق شجرة العمل الالتزام المدفوع بالضبط.",
    );
    err.code = "PUSH_GUARD_DIRTY_WORKTREE";
    throw err;
  }
}

export function defaultVerifyCheckoutMatchesSha(sha) {
  const headSha = defaultGetHeadSha();
  if (!headSha) {
    return {
      ok: false,
      code: "PUSH_GUARD_HEAD_MISMATCH",
      reason: "تعذّر التحقق من بصمة HEAD الحالية في شجرة العمل قبل الدفع.",
    };
  }

  if (sha && sha !== "HEAD") {
    const targetRes = spawnSync(
      "git",
      ["rev-parse", "--verify", `${sha}^{commit}`],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
      },
    );
    const targetSha = targetRes.status === 0 ? targetRes.stdout.trim() : "";
    if (!targetSha || headSha !== targetSha) {
      return {
        ok: false,
        code: "PUSH_GUARD_HEAD_MISMATCH",
        reason: `الالتزام المدفوع (${sha.slice(0, 12)}) لا يطابق HEAD المفحوص حالياً في شجرة العمل (${headSha.slice(0, 12) || "unknown"}). تحقّق من الفرع المطلوب قبل الدفع لضمان تشغيل الاختبارات على نفس الكود المدفوع.`,
      };
    }
  }

  const trackedStatus = defaultGetTrackedStatus();
  if (trackedStatus.length > 0) {
    return {
      ok: false,
      code: "PUSH_GUARD_DIRTY_WORKTREE",
      reason:
        "توجد تعديلات غير ملتزمة في شجرة العمل تختلف عن الالتزام المدفوع؛ التزم بتعديلاتك أو اعزلها (git stash) قبل الدفع لضمان تطابق فحص الاختبارات مع الالتزام المدفوع.",
    };
  }
  return { ok: true };
}

function stripConfigComments(text) {
  return String(text ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
}

function extractRegisteredUnitTests(unitConfigText) {
  const uncommented = stripConfigComments(unitConfigText);
  const matches = [];
  const re = /["']([^"'\r\n]+\.test\.(?:[cm]?jsx?|[cm]?tsx?))["']/g;
  let m;
  while ((m = re.exec(uncommented)) !== null) {
    matches.push(m[1].replace(/\\/g, "/"));
  }
  return matches;
}

function isRegisteredInUnitConfig(unitConfigText, candidateRelPath) {
  const normalized = candidateRelPath.replace(/\\/g, "/");
  const uncommented = stripConfigComments(unitConfigText);
  return (
    uncommented.includes(`"${normalized}"`) ||
    uncommented.includes(`'${normalized}'`)
  );
}

function defaultReadRepoFile(relPath) {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
  } catch {
    return "";
  }
}

function resolveTestImportSpecifier(testRelPath, rawSpecifier) {
  const specifier = String(rawSpecifier ?? "")
    .trim()
    .split(/[?#]/)[0]
    .replace(/\\/g, "/");
  if (!specifier) return null;
  let resolved = "";
  if (specifier.startsWith("@/")) {
    resolved = `client/src/${specifier.slice(2)}`;
  } else if (specifier.startsWith("@shared/")) {
    resolved = `shared/${specifier.slice(8)}`;
  } else if (specifier.startsWith(".")) {
    const testDir = path.posix.dirname(testRelPath.replace(/\\/g, "/"));
    resolved = path.posix.normalize(path.posix.join(testDir, specifier));
  } else {
    return null;
  }
  const normalizedResolved = resolved.replace(/\\/g, "/");
  const resolvedNoExt = normalizedResolved.replace(
    /\.(?:[cm]?jsx?|[cm]?tsx?)$/,
    "",
  );
  return {
    resolved: normalizedResolved,
    resolvedNoExt,
  };
}

function doesTestImportSourceFile(
  testRelPath,
  testContent,
  sourceNormalized,
  sourceNoExt,
) {
  if (!testContent) return false;
  const uncommented = stripConfigComments(testContent);
  const specifiers = new Set();
  const patterns = [
    /\bfrom\s+["']([^"'\r\n]+)["']/g,
    /\bimport\s+["']([^"'\r\n]+)["']/g,
    /\b(?:import|require|vi\.(?:do)?mock)\s*\(\s*["']([^"'\r\n]+)["']/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(uncommented)) !== null) {
      specifiers.add(m[1]);
    }
  }
  const isIndexFile = path.posix.basename(sourceNoExt) === "index";
  const indexDir = isIndexFile ? path.posix.dirname(sourceNoExt) : "";
  for (const spec of specifiers) {
    const target = resolveTestImportSpecifier(testRelPath, spec);
    if (!target) continue;
    if (
      target.resolved === sourceNormalized ||
      target.resolvedNoExt === sourceNoExt ||
      (isIndexFile && target.resolvedNoExt === indexDir)
    ) {
      return true;
    }
  }
  return false;
}

function deriveCandidateUnitTestsForSourceFile(
  relPath,
  registeredTests = [],
  readTestFile = defaultReadRepoFile,
) {
  const normalized = relPath.replace(/\\/g, "/");
  if (
    normalized === "scripts/safe-push-guard.mjs" ||
    normalized === "scripts/safe-merge.mjs" ||
    normalized === "scripts/deploy.mjs" ||
    normalized === "scripts/deploy.test.mjs" ||
    normalized === ".husky/pre-push"
  ) {
    return ["scripts/__tests__/safeDeliveryProtocols.test.ts"];
  }
  if (
    normalized === ".github/workflows/ci.yml" ||
    normalized === "scripts/ci-policy.mjs"
  ) {
    return [
      "scripts/__tests__/ciCriticalPathWorkflow.test.ts",
      "scripts/__tests__/safeDeliveryProtocols.test.ts",
    ];
  }
  if (
    normalized === ".github/workflows/security.yml" ||
    normalized === "osv-scanner.toml"
  ) {
    return ["scripts/__tests__/dependencySecurityWorkflow.test.ts"];
  }
  if (normalized === ".github/workflows/ci-failure-diagnostics.yml") {
    return ["scripts/__tests__/ciFailureDiagnosticsWorkflow.test.ts"];
  }
  if (!/\.(?:[cm]?jsx?|[cm]?tsx?)$/.test(normalized)) {
    return [];
  }
  const parsed = path.posix.parse(normalized);
  const baseName = parsed.name;
  const dir = parsed.dir;
  if (!dir || !baseName) return [];
  const sourceNoExt = `${dir}/${baseName}`;
  const exactCandidates = [
    `${dir}/${baseName}.test.ts`,
    `${dir}/${baseName}.test.tsx`,
    `${dir}/${baseName}.unit.test.ts`,
    `${dir}/${baseName}.unit.test.tsx`,
    `${dir}/__tests__/${baseName}.test.ts`,
    `${dir}/__tests__/${baseName}.test.tsx`,
    `${dir}/__tests__/${baseName}.unit.test.ts`,
    `${dir}/__tests__/${baseName}.unit.test.tsx`,
  ];
  const colocatedPrefix = `${dir}/${baseName}.`;
  const subdirPrefix = `${dir}/__tests__/${baseName}.`;
  const matchedRegistered = registeredTests.filter((testPath) => {
    if (
      testPath.startsWith(colocatedPrefix) ||
      testPath.startsWith(subdirPrefix)
    ) {
      return true;
    }
    if (typeof readTestFile === "function") {
      const testContent = readTestFile(testPath);
      if (
        doesTestImportSourceFile(
          testPath,
          testContent,
          normalized,
          sourceNoExt,
        )
      ) {
        return true;
      }
    }
    return false;
  });
  return Array.from(new Set([...exactCandidates, ...matchedRegistered]));
}

export function collectModifiedUnitTestsForPush({
  stdinEntries = [],
  unitConfigText = "",
  runDiff = defaultDiffRunner,
  fileExists = (relPath) => fs.existsSync(path.join(REPO_ROOT, relPath)),
  readFile = defaultReadRepoFile,
  verifyCheckoutMatchesSha = null,
  headSha = undefined,
  trackedStatus = undefined,
} = {}) {
  const shas = resolvePushedCommitShas(stdinEntries);
  if (shas.length === 0) {
    return [];
  }

  if (
    headSha !== undefined ||
    trackedStatus !== undefined ||
    (!verifyCheckoutMatchesSha && runDiff === defaultDiffRunner)
  ) {
    assertCheckoutMatchesPushedShas({
      shas,
      headSha: headSha ?? defaultGetHeadSha(),
      trackedStatus: trackedStatus ?? defaultGetTrackedStatus(),
    });
  }

  if (!unitConfigText || !unitConfigText.trim()) {
    const err = new Error(
      "تعذّر قراءة ملف vitest.unit.config.ts للتحقق من اختبارات الوحدة قبل الدفع.",
    );
    err.code = "PUSH_GUARD_UNIT_CONFIG_MISSING";
    throw err;
  }

  const checkoutVerifier =
    verifyCheckoutMatchesSha ??
    (runDiff === defaultDiffRunner
      ? defaultVerifyCheckoutMatchesSha
      : () => ({ ok: true }));

  const changedFiles = new Set();
  for (const sha of shas) {
    const checkoutCheck = checkoutVerifier(sha);
    if (!checkoutCheck || checkoutCheck.ok === false) {
      const err = new Error(
        checkoutCheck?.reason ||
          `الالتزام المدفوع (${sha}) لا يطابق شجرة العمل الحالية؛ لا يمكن التحقق من اختبارات الوحدة بأمان.`,
      );
      err.code = checkoutCheck?.code || "PUSH_GUARD_WORKTREE_MISMATCH";
      throw err;
    }

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
      .map((f) => f.trim().replace(/\\/g, "/"))
      .filter(Boolean);
    for (const file of lines) {
      changedFiles.add(file);
    }
  }

  const registeredTests = extractRegisteredUnitTests(unitConfigText);
  const testContentCache = new Map();
  const cachedReadTestFile =
    typeof readFile === "function"
      ? (testPath) => {
          if (!testContentCache.has(testPath)) {
            testContentCache.set(testPath, String(readFile(testPath) ?? ""));
          }
          return testContentCache.get(testPath);
        }
      : null;

  const matchedTestsSet = new Set();
  for (const file of changedFiles) {
    if (/\.test\.(?:[cm]?jsx?|[cm]?tsx?)$/.test(file)) {
      if (isRegisteredInUnitConfig(unitConfigText, file)) {
        matchedTestsSet.add(file);
      }
      continue;
    }
    for (const candidate of deriveCandidateUnitTestsForSourceFile(
      file,
      registeredTests,
      cachedReadTestFile,
    )) {
      if (isRegisteredInUnitConfig(unitConfigText, candidate)) {
        matchedTestsSet.add(candidate);
      }
    }
  }

  const matchedTests = [];
  for (const testFile of matchedTestsSet) {
    if (!fileExists(testFile)) {
      const err = new Error(
        `الملف الاختباري المتأثر «${testFile}» في الالتزام المدفوع غير موجود في شجرة العمل الحالية؛ تحقّق من الفرع الحالي قبل الدفع.`,
      );
      err.code = "PUSH_GUARD_WORKTREE_MISMATCH";
      throw err;
    }
    matchedTests.push(testFile);
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

  const blockedForceCli = evaluatePrePushPolicy({
    remoteRefs: [],
    currentBranch: "feature/test",
    cliArgs: ["origin", "+main"],
    env: {},
  });
  assert.equal(blockedForceCli.allowed, false);
  assert.equal(blockedForceCli.code, "DIRECT_MAIN_PUSH_FORBIDDEN");

  const blockedHeadsMain = evaluatePrePushPolicy({
    remoteRefs: [],
    currentBranch: "feature/test",
    cliArgs: ["origin", "HEAD:heads/main"],
    env: {},
  });
  assert.equal(blockedHeadsMain.allowed, false);
  assert.equal(blockedHeadsMain.code, "DIRECT_MAIN_PUSH_FORBIDDEN");

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

  // Verify pushed commit SHAs are diffed instead of assuming HEAD, and commented-out config lines are ignored
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
    unitConfigText:
      '// "client/src/lib/commentedOut.test.ts"\ninclude: ["scripts/__tests__/safeDeliveryProtocols.test.ts", "scripts/__tests__/ciCriticalPathWorkflow.test.ts", "client/src/lib/lazyWithRetry.test.ts", "client/src/pages/Treasury.permissionCache.test.tsx"]',
    runDiff: (sha) => {
      diffedShas.push(sha);
      return {
        status: 0,
        stdout:
          "scripts/__tests__/safeDeliveryProtocols.test.ts\n.github/workflows/ci.yml\nclient/src/lib/commentedOut.ts\nclient/src/lib/lazyWithRetry.ts\nclient/src/pages/Treasury.tsx\n",
      };
    },
    fileExists: () => true,
  });
  assert.deepEqual(diffedShas, ["1111111111111111111111111111111111111111"]);
  assert.deepEqual(collected, [
    "scripts/__tests__/safeDeliveryProtocols.test.ts",
    "scripts/__tests__/ciCriticalPathWorkflow.test.ts",
    "client/src/lib/lazyWithRetry.test.ts",
    "client/src/pages/Treasury.permissionCache.test.tsx",
  ]);

  // Verify differently named source file (e.g. TreasuryHub.tsx) matches registered test importing it
  const importedByTest = collectModifiedUnitTestsForPush({
    stdinEntries: [
      {
        localRef: "refs/heads/feat/treasury-hub",
        localSha: "4444444444444444444444444444444444444444",
        remoteRef: "refs/heads/feat/treasury-hub",
        remoteSha: "0000000000000000000000000000000000000000",
      },
    ],
    unitConfigText:
      'include: ["client/src/pages/Treasury.permissionCache.test.tsx"]',
    runDiff: () => ({
      status: 0,
      stdout: "client/src/pages/TreasuryHub.tsx\n",
    }),
    fileExists: () => true,
  });
  assert.deepEqual(importedByTest, [
    "client/src/pages/Treasury.permissionCache.test.tsx",
  ]);

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
        unitConfigText:
          'include: ["scripts/__tests__/safeDeliveryProtocols.test.ts"]',
        runDiff: () => ({
          status: 128,
          stderr: "fatal: ambiguous argument 'origin/main'",
        }),
        fileExists: () => true,
      }),
    (err) => err?.code === "PUSH_GUARD_BASE_DIFF_FAILED",
  );

  // Verify fail-closed when pushed localSha does not match checked-out worktree
  assert.throws(
    () =>
      collectModifiedUnitTestsForPush({
        stdinEntries: [
          {
            localRef: "refs/heads/feat/other",
            localSha: "3333333333333333333333333333333333333333",
            remoteRef: "refs/heads/feat/other",
            remoteSha: "0000000000000000000000000000000000000000",
          },
        ],
        unitConfigText:
          'include: ["scripts/__tests__/safeDeliveryProtocols.test.ts"]',
        runDiff: () => ({
          status: 0,
          stdout: "scripts/__tests__/safeDeliveryProtocols.test.ts\n",
        }),
        fileExists: () => true,
        verifyCheckoutMatchesSha: () => ({
          ok: false,
          reason: "HEAD mismatch with pushed localSha",
        }),
      }),
    (err) => err?.code === "PUSH_GUARD_WORKTREE_MISMATCH",
  );

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
        unitConfigText:
          'include: ["scripts/__tests__/safeDeliveryProtocols.test.ts"]',
        runDiff: () => ({
          status: 0,
          stdout: "scripts/__tests__/safeDeliveryProtocols.test.ts\n",
        }),
        fileExists: () => true,
        headSha: "9999999999999999999999999999999999999999",
        trackedStatus: "",
      }),
    (err) => err?.code === "PUSH_GUARD_HEAD_MISMATCH",
  );

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
        unitConfigText:
          'include: ["scripts/__tests__/safeDeliveryProtocols.test.ts"]',
        runDiff: () => ({
          status: 0,
          stdout: "scripts/__tests__/safeDeliveryProtocols.test.ts\n",
        }),
        fileExists: () => true,
        headSha: "1111111111111111111111111111111111111111",
        trackedStatus: " M scripts/__tests__/safeDeliveryProtocols.test.ts",
      }),
    (err) => err?.code === "PUSH_GUARD_DIRTY_WORKTREE",
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
    console.error(
      `\n⛔ [${error?.code ?? "PUSH_GUARD_ERROR"}] ${error?.message ?? error}\n`,
    );
    process.exit(1);
  }

  if (modifiedUnitTests.length > 0) {
    console.log(
      `▶ [بروتوكول الدفع الآمن] تشغيل ${modifiedUnitTests.length} ملف اختبار وحدة متأثر قبل الدفع…`,
    );
    const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const testRes = spawnSync(
      pnpmCmd,
      [
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.unit.config.ts",
        ...modifiedUnitTests,
      ],
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
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main();
}
