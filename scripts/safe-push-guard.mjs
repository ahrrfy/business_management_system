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
  return spawnSync("git", ["diff", "--name-status", `origin/main...${sha}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

function parseDiffOutputEntries(rawLine) {
  const trimmed = String(rawLine ?? "").trim();
  if (!trimmed) return [];
  if (trimmed.includes("\t")) {
    const parts = trimmed
      .split("\t")
      .map((p) => p.trim().replace(/\\/g, "/"))
      .filter(Boolean);
    if (parts.length >= 2 && /^[ACDMRTUXB]\d*$/i.test(parts[0])) {
      const code = parts[0].toUpperCase();
      if (code.startsWith("R") && parts.length >= 3) {
        return [
          { path: parts[1], isDeleted: true },
          { path: parts[2], isDeleted: false },
        ];
      }
      if (code.startsWith("C") && parts.length >= 3) {
        return [
          { path: parts[1], isDeleted: false },
          { path: parts[2], isDeleted: false },
        ];
      }
      return [{ path: parts[1], isDeleted: code.startsWith("D") }];
    }
  }
  return [{ path: trimmed.replace(/\\/g, "/"), isDeleted: false }];
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

const MODULE_SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

function resolveModuleImportSpecifier(importerRelPath, rawSpecifier) {
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
    const importerDir = path.posix.dirname(importerRelPath.replace(/\\/g, "/"));
    resolved = path.posix.normalize(
      importerDir === "."
        ? specifier
        : path.posix.join(importerDir, specifier),
    );
  } else if (
    /^(?:client|server|shared|scripts|drizzle|\.github|\.husky)\//.test(
      specifier,
    )
  ) {
    resolved = path.posix.normalize(specifier);
  } else {
    return null;
  }
  const normalizedResolved = resolved
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "");
  if (!normalizedResolved || normalizedResolved.startsWith("..")) {
    return null;
  }
  const resolvedNoExt = normalizedResolved.replace(
    /\.(?:[cm]?jsx?|[cm]?tsx?)$/,
    "",
  );
  return {
    resolved: normalizedResolved,
    resolvedNoExt,
  };
}

const NON_JS_ASSET_EXT_RE =
  /\.(?:css|scss|sass|less|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|eot|mp[34]|wav|pdf|sql|md|ya?ml|toml|html|json)$/i;
const JS_TS_MODULE_EXT_RE = /\.(?:[cm]?jsx?|[cm]?tsx?)$/;

function parseModuleDependencies(moduleRelPath, rawContent) {
  if (!rawContent) return null;
  const normalizedModulePath = moduleRelPath.replace(/\\/g, "/");
  const uncommented = stripConfigComments(rawContent);
  const collapsed = uncommented.replace(
    /\b(?:join|resolve)\s*\(([^)]+)\)/g,
    (full) => full.replace(/["'`]\s*,\s*["'`]/g, "/"),
  );

  const specifiers = new Set();
  const patterns = [
    /\bfrom\s+["']([^"'\r\n]+)["']/g,
    /\bimport\s+["']([^"'\r\n]+)["']/g,
    /\b(?:import|require|vi\.(?:doM|m)ock|vi\.importActual)\s*\(\s*["']([^"'\r\n]+)["']/g,
    /["'`]((?:\.\.?\/|@\/|@shared\/|(?:client|server|shared|scripts|drizzle|\.github|\.husky)\/)[^"'`\r\n${}]+)["'`]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(collapsed)) !== null) {
      specifiers.add(m[1]);
    }
  }

  const targets = [];
  const seenResolved = new Set();
  for (const spec of specifiers) {
    const target = resolveModuleImportSpecifier(normalizedModulePath, spec);
    if (!target || seenResolved.has(target.resolved)) continue;
    seenResolved.add(target.resolved);
    targets.push(target);
  }

  const runtimeCollapsed = collapsed
    .replace(
      /\b(?:import|export)\s+type\s+(?:\*(?:\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*)?|\{[^{};]*\}|[A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+["'][^"'\r\n]+["']/g,
      "",
    )
    .replace(/\btypeof\s+import\s*\(\s*["'][^"'\r\n]+["']\s*\)/g, "");
  const runtimeSpecifiers = new Set();
  const runtimePatterns = [
    /\bfrom\s+["']([^"'\r\n]+)["']/g,
    /\bimport\s+["']([^"'\r\n]+)["']/g,
    /\b(?:import|require|vi\.(?:doM|m)ock|vi\.importActual)\s*\(\s*["']([^"'\r\n]+)["']/g,
  ];
  for (const re of runtimePatterns) {
    let m;
    while ((m = re.exec(runtimeCollapsed)) !== null) {
      runtimeSpecifiers.add(m[1]);
    }
  }

  const runtimeTargets = [];
  const seenRuntimeResolved = new Set();
  for (const spec of runtimeSpecifiers) {
    const target = resolveModuleImportSpecifier(normalizedModulePath, spec);
    if (!target || seenRuntimeResolved.has(target.resolved)) continue;
    seenRuntimeResolved.add(target.resolved);
    runtimeTargets.push(target);
  }

  const isTestOrHelperModule =
    /\.(?:test|spec)\.[^/]+$/i.test(normalizedModulePath) ||
    /(?:^|\/)(?:__tests__|tests?|test-utils)\//i.test(normalizedModulePath);
  let fsMeta = null;
  if (
    isTestOrHelperModule &&
    /\b(?:readFile|readdir)(?:Sync)?\b/.test(collapsed)
  ) {
    const rawDir = path.posix.dirname(normalizedModulePath);
    const moduleDir = rawDir === "." ? "" : rawDir;
    const fileLiterals = new Set();
    const fileLiteralRe = /["'`]([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)["'`]/g;
    let m;
    while ((m = fileLiteralRe.exec(collapsed)) !== null) {
      const cleaned = m[1].replace(/^(?:\.\.\/|\.\/)+/, "");
      if (cleaned) fileLiterals.add(cleaned);
    }

    const dirVars = new Map([
      ["__dirname", moduleDir],
      ["import.meta.dirname", moduleDir],
      ["process.cwd()", ""],
    ]);
    const resolveRepoSubpath = (baseDir, relSegment) => {
      const normalizedJoined = path.posix
        .normalize(
          baseDir ? path.posix.join(baseDir, relSegment) : relSegment,
        )
        .replace(/^(?:\.\/)+/, "")
        .replace(/\/+$/, "");
      if (normalizedJoined === ".") return "";
      if (normalizedJoined.startsWith("..")) return null;
      return normalizedJoined;
    };

    const varAssignRe =
      /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:path\.)?(?:resolve|join)\s*\(\s*(__dirname|import\.meta\.dirname|process\.cwd\(\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,\s*["'`]([^"'`\r\n]+)["'`])?\s*\)/g;
    let vm;
    while ((vm = varAssignRe.exec(collapsed)) !== null) {
      const varName = vm[1];
      const baseExpr = vm[2];
      const relArg = vm[3] ?? "";
      if (!dirVars.has(baseExpr)) continue;
      const resolvedDir = resolveRepoSubpath(dirVars.get(baseExpr), relArg);
      if (resolvedDir !== null) {
        dirVars.set(varName, resolvedDir);
      }
    }

    const enumeratedDirs = new Set();
    if (/\breaddir(?:Sync)?\b/.test(collapsed)) {
      for (const [varName, resolvedDir] of dirVars.entries()) {
        if (
          varName !== "__dirname" &&
          varName !== "import.meta.dirname" &&
          varName !== "process.cwd()" &&
          resolvedDir &&
          !/\.[A-Za-z0-9]+$/.test(path.posix.basename(resolvedDir))
        ) {
          enumeratedDirs.add(resolvedDir);
        }
      }
      const joinCallRe =
        /\b(?:path\.)?(?:resolve|join)\s*\(\s*(__dirname|import\.meta\.dirname|process\.cwd\(\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*,\s*["'`]([^"'`\r\n]+)["'`]\s*\)/g;
      let jm;
      while ((jm = joinCallRe.exec(collapsed)) !== null) {
        const baseExpr = jm[1];
        const relArg = jm[2];
        if (!dirVars.has(baseExpr)) continue;
        const resolvedDir = resolveRepoSubpath(dirVars.get(baseExpr), relArg);
        if (
          resolvedDir &&
          !/\.[A-Za-z0-9]+$/.test(path.posix.basename(resolvedDir))
        ) {
          enumeratedDirs.add(resolvedDir);
        }
      }
    }

    const baseDirs = new Set([moduleDir]);
    for (const resolvedDir of dirVars.values()) {
      if (resolvedDir) baseDirs.add(resolvedDir);
    }
    if (path.posix.basename(moduleDir) === "__tests__") {
      const parentDir = path.posix.dirname(moduleDir);
      baseDirs.add(parentDir === "." ? "" : parentDir);
    }
    const templatePrefixRe = /`((?:\.\.?\/)+[A-Za-z0-9_./-]*)\$\{/g;
    let tm;
    while ((tm = templatePrefixRe.exec(collapsed)) !== null) {
      const resolvedBase = path.posix
        .normalize(
          moduleDir ? path.posix.join(moduleDir, tm[1]) : tm[1],
        )
        .replace(/\/+$/, "");
      if (
        resolvedBase &&
        resolvedBase !== "." &&
        !resolvedBase.startsWith("..")
      ) {
        baseDirs.add(resolvedBase);
      }
    }

    fsMeta = {
      fileLiterals,
      enumeratedDirs,
      baseDirs,
    };
  }

  return {
    moduleRelPath: normalizedModulePath,
    collapsed,
    targets,
    runtimeTargets,
    fsMeta,
    resolvedDeps: null,
  };
}

function doesParsedModuleReferenceSource(
  parsedMod,
  sourceNormalized,
  sourceNoExt,
) {
  if (!parsedMod) return false;
  const { collapsed, targets, fsMeta } = parsedMod;

  if (
    collapsed.includes(`"${sourceNormalized}"`) ||
    collapsed.includes(`'${sourceNormalized}'`) ||
    collapsed.includes(`\`${sourceNormalized}\``) ||
    collapsed.includes(`"./${sourceNormalized}"`) ||
    collapsed.includes(`'./${sourceNormalized}'`) ||
    collapsed.includes(`/${sourceNormalized}"`) ||
    collapsed.includes(`/${sourceNormalized}'`) ||
    collapsed.includes(`/${sourceNormalized}\``)
  ) {
    return true;
  }

  const isIndexFile =
    Boolean(sourceNoExt) && path.posix.basename(sourceNoExt) === "index";
  const rawIndexDir = isIndexFile ? path.posix.dirname(sourceNoExt) : "";
  const indexDir = rawIndexDir === "." ? "" : rawIndexDir;
  for (const target of targets) {
    if (
      target.resolved === sourceNormalized ||
      (Boolean(sourceNoExt) && target.resolvedNoExt === sourceNoExt) ||
      (isIndexFile && Boolean(indexDir) && target.resolvedNoExt === indexDir)
    ) {
      return true;
    }
  }

  if (fsMeta) {
    const sourceBase = path.posix.basename(sourceNormalized);
    const isGenericIndex = /^index\.[^.]+$/i.test(sourceBase);
    for (const cleaned of fsMeta.fileLiterals) {
      if (cleaned === sourceNormalized) {
        return true;
      }
      if (
        !isGenericIndex &&
        (cleaned === sourceBase || sourceNormalized.endsWith(`/${cleaned}`))
      ) {
        return true;
      }
    }

    for (const enumDir of fsMeta.enumeratedDirs) {
      if (sourceNormalized.startsWith(`${enumDir}/`)) {
        return true;
      }
    }

    for (const baseDir of fsMeta.baseDirs) {
      const prefix = baseDir ? `${baseDir}/` : "";
      if (!prefix || !sourceNormalized.startsWith(prefix)) continue;
      const relWithExt = sourceNormalized.slice(prefix.length);
      const relNoExt =
        sourceNoExt && sourceNoExt.startsWith(prefix)
          ? sourceNoExt.slice(prefix.length)
          : "";
      if (
        collapsed.includes(`"${relWithExt}"`) ||
        collapsed.includes(`'${relWithExt}'`) ||
        collapsed.includes(`\`${relWithExt}\``)
      ) {
        return true;
      }
      if (
        relNoExt &&
        path.posix.basename(relNoExt) !== "index" &&
        (collapsed.includes(`"${relNoExt}"`) ||
          collapsed.includes(`'${relNoExt}'`) ||
          collapsed.includes(`\`${relNoExt}\``))
      ) {
        return true;
      }
    }
  }

  return false;
}

let cachedDefaultRepoModuleGraph = null;

function buildTransitiveModuleGraph(readFile, useDiskStat = false) {
  const fileContentCache = new Map();
  const diskExistsCache = new Map();
  const parsedModuleCache = new Map();
  const resolvedTargetCache = new Map();
  const closureCache = new Map();

  const readCached = (relPath) => {
    const normalized = String(relPath ?? "").replace(/\\/g, "/");
    if (!normalized) return "";
    if (!fileContentCache.has(normalized)) {
      fileContentCache.set(normalized, String(readFile(normalized) ?? ""));
    }
    return fileContentCache.get(normalized);
  };

  const moduleFileExists = (relPath) => {
    const normalized = String(relPath ?? "").replace(/\\/g, "/");
    if (!normalized) return false;
    if (!useDiskStat) {
      return Boolean(readCached(normalized));
    }
    if (!diskExistsCache.has(normalized)) {
      const stat = fs.statSync(path.join(REPO_ROOT, normalized), {
        throwIfNoEntry: false,
      });
      diskExistsCache.set(normalized, stat?.isFile() === true);
    }
    return diskExistsCache.get(normalized);
  };

  const resolveTargetToExistingModule = (target) => {
    const cacheKey = target.resolved;
    if (resolvedTargetCache.has(cacheKey)) {
      return resolvedTargetCache.get(cacheKey);
    }
    if (NON_JS_ASSET_EXT_RE.test(target.resolved)) {
      resolvedTargetCache.set(cacheKey, null);
      return null;
    }
    let found = null;
    if (
      JS_TS_MODULE_EXT_RE.test(target.resolved) &&
      moduleFileExists(target.resolved)
    ) {
      found = target.resolved;
    } else if (target.resolvedNoExt) {
      for (const ext of MODULE_SOURCE_EXTENSIONS) {
        const candidate = `${target.resolvedNoExt}${ext}`;
        if (moduleFileExists(candidate)) {
          found = candidate;
          break;
        }
      }
      if (!found) {
        for (const ext of MODULE_SOURCE_EXTENSIONS) {
          const indexCandidate = `${target.resolvedNoExt}/index${ext}`;
          if (moduleFileExists(indexCandidate)) {
            found = indexCandidate;
            break;
          }
        }
      }
    }
    resolvedTargetCache.set(cacheKey, found);
    return found;
  };

  const getParsedModule = (relPath) => {
    const normalized = String(relPath ?? "").replace(/\\/g, "/");
    if (!normalized) return null;
    if (!parsedModuleCache.has(normalized)) {
      parsedModuleCache.set(
        normalized,
        parseModuleDependencies(normalized, readCached(normalized)),
      );
    }
    const parsed = parsedModuleCache.get(normalized);
    if (parsed && parsed.resolvedDeps === null) {
      const deps = [];
      for (const target of parsed.runtimeTargets) {
        const depPath = resolveTargetToExistingModule(target);
        if (depPath && depPath !== normalized) {
          deps.push(depPath);
        }
      }
      parsed.resolvedDeps = deps;
    }
    return parsed;
  };

  const getReachableClosure = (entryTestPath) => {
    const normalizedEntry = String(entryTestPath ?? "").replace(/\\/g, "/");
    if (closureCache.has(normalizedEntry)) {
      return closureCache.get(normalizedEntry);
    }
    const visitedPaths = new Set([normalizedEntry]);
    const queue = [normalizedEntry];
    const reachableParsed = [];
    while (queue.length > 0) {
      const current = queue.shift();
      const parsed = getParsedModule(current);
      if (!parsed) continue;
      reachableParsed.push(parsed);
      for (const depPath of parsed.resolvedDeps) {
        if (!visitedPaths.has(depPath)) {
          visitedPaths.add(depPath);
          queue.push(depPath);
        }
      }
    }
    const closure = { visitedPaths, reachableParsed };
    closureCache.set(normalizedEntry, closure);
    return closure;
  };

  return {
    doesTestReferenceSource(testPath, sourceNormalized, sourceNoExt) {
      const { visitedPaths, reachableParsed } = getReachableClosure(testPath);
      if (visitedPaths.has(sourceNormalized)) {
        return true;
      }
      for (const parsedMod of reachableParsed) {
        if (
          doesParsedModuleReferenceSource(
            parsedMod,
            sourceNormalized,
            sourceNoExt,
          )
        ) {
          return true;
        }
      }
      return false;
    },
  };
}

function createTransitiveModuleGraph(readFile) {
  if (typeof readFile !== "function") {
    return null;
  }
  if (readFile === defaultReadRepoFile) {
    if (!cachedDefaultRepoModuleGraph) {
      cachedDefaultRepoModuleGraph = buildTransitiveModuleGraph(
        defaultReadRepoFile,
        true,
      );
    }
    return cachedDefaultRepoModuleGraph;
  }
  return buildTransitiveModuleGraph(readFile, false);
}

function deriveCandidateUnitTestsForSourceFile(
  relPath,
  registeredTests = [],
  readTestFileOrGraph = defaultReadRepoFile,
) {
  const normalized = relPath.replace(/\\/g, "/");
  const explicitCandidates = [];
  if (
    normalized === "scripts/safe-push-guard.mjs" ||
    normalized === "scripts/safe-merge.mjs" ||
    normalized === "scripts/deploy.mjs" ||
    normalized === "scripts/deploy.test.mjs" ||
    normalized === ".husky/pre-push"
  ) {
    explicitCandidates.push("scripts/__tests__/safeDeliveryProtocols.test.ts");
  } else if (
    normalized === ".github/workflows/ci.yml" ||
    normalized === "scripts/ci-policy.mjs"
  ) {
    explicitCandidates.push(
      "scripts/__tests__/ciCriticalPathWorkflow.test.ts",
      "scripts/__tests__/safeDeliveryProtocols.test.ts",
    );
  } else if (
    normalized === ".github/workflows/security.yml" ||
    normalized === "osv-scanner.toml"
  ) {
    explicitCandidates.push(
      "scripts/__tests__/dependencySecurityWorkflow.test.ts",
    );
  } else if (normalized === ".github/workflows/ci-failure-diagnostics.yml") {
    explicitCandidates.push(
      "scripts/__tests__/ciFailureDiagnosticsWorkflow.test.ts",
    );
  }

  const parsed = path.posix.parse(normalized);
  const baseName = parsed.name;
  const dir = parsed.dir;
  const isJsTs = /\.(?:[cm]?jsx?|[cm]?tsx?)$/.test(normalized);
  const sourceNoExt =
    isJsTs && baseName ? (dir ? `${dir}/${baseName}` : baseName) : "";

  const exactCandidates =
    isJsTs && baseName
      ? dir
        ? [
            `${dir}/${baseName}.test.ts`,
            `${dir}/${baseName}.test.tsx`,
            `${dir}/${baseName}.unit.test.ts`,
            `${dir}/${baseName}.unit.test.tsx`,
            `${dir}/__tests__/${baseName}.test.ts`,
            `${dir}/__tests__/${baseName}.test.tsx`,
            `${dir}/__tests__/${baseName}.unit.test.ts`,
            `${dir}/__tests__/${baseName}.unit.test.tsx`,
          ]
        : [
            `${baseName}.test.ts`,
            `${baseName}.test.tsx`,
            `${baseName}.unit.test.ts`,
            `${baseName}.unit.test.tsx`,
            `__tests__/${baseName}.test.ts`,
            `__tests__/${baseName}.test.tsx`,
            `__tests__/${baseName}.unit.test.ts`,
            `__tests__/${baseName}.unit.test.tsx`,
          ]
      : [];

  const colocatedPrefix =
    isJsTs && baseName ? (dir ? `${dir}/${baseName}.` : `${baseName}.`) : "";
  const subdirPrefix =
    isJsTs && baseName
      ? dir
        ? `${dir}/__tests__/${baseName}.`
        : `__tests__/${baseName}.`
      : "";

  const moduleGraph =
    readTestFileOrGraph &&
    typeof readTestFileOrGraph === "object" &&
    typeof readTestFileOrGraph.doesTestReferenceSource === "function"
      ? readTestFileOrGraph
      : createTransitiveModuleGraph(readTestFileOrGraph);

  const matchedRegistered = registeredTests.filter((testPath) => {
    if (
      (colocatedPrefix && testPath.startsWith(colocatedPrefix)) ||
      (subdirPrefix && testPath.startsWith(subdirPrefix))
    ) {
      return true;
    }
    if (
      moduleGraph &&
      moduleGraph.doesTestReferenceSource(testPath, normalized, sourceNoExt)
    ) {
      return true;
    }
    return false;
  });

  return Array.from(
    new Set([
      ...explicitCandidates,
      ...exactCandidates,
      ...matchedRegistered,
    ]),
  );
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
  const deletedFiles = new Set();
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
    const rawLines = String(diffRes.stdout ?? "").split(/\r?\n/);
    for (const rawLine of rawLines) {
      for (const entry of parseDiffOutputEntries(rawLine)) {
        if (!entry.path) continue;
        changedFiles.add(entry.path);
        if (entry.isDeleted) {
          deletedFiles.add(entry.path);
        } else {
          deletedFiles.delete(entry.path);
        }
      }
    }
  }

  const registeredTests = extractRegisteredUnitTests(unitConfigText);
  const moduleGraph = createTransitiveModuleGraph(readFile);

  const matchedTestsSet = new Set();
  for (const file of changedFiles) {
    if (/\.test\.(?:[cm]?jsx?|[cm]?tsx?)$/.test(file)) {
      if (isRegisteredInUnitConfig(unitConfigText, file)) {
        matchedTestsSet.add(file);
        if (!deletedFiles.has(file)) {
          continue;
        }
      }
    }
    for (const candidate of deriveCandidateUnitTestsForSourceFile(
      file,
      registeredTests,
      moduleGraph,
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

export function createUnitTestCommands(testPaths, maxCommandLength = 24000) {
  // Invoke the local CLI directly: pnpm.cmd adds cmd.exe's much smaller limit.
  const command = process.execPath;
  const baseArgs = [
    path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "--config",
    "vitest.unit.config.ts",
    "--maxWorkers=4",
  ];
  const commands = [];
  let args = [...baseArgs];
  const sizeOf = (values) =>
    [command, ...values].reduce((size, value) => size + value.length + 3, 0);
  for (const testPath of testPaths) {
    if (sizeOf([...args, testPath]) > maxCommandLength) {
      if (args.length === baseArgs.length)
        throw new Error("Unit test path exceeds the process argument limit");
      commands.push({ command, args });
      args = [...baseArgs];
    }
    args.push(testPath);
  }
  if (args.length > baseArgs.length) commands.push({ command, args });
  return commands;
}

export function runSafePushSelftest() {
  const longTestPaths = Array.from(
    { length: 500 },
    (_, index) =>
      `client/src/components/${"nested/".repeat(8)}test-${index}.test.tsx`,
  );
  longTestPaths.push("client/src/test with spaces & literal.test.ts");
  const commands = createUnitTestCommands(longTestPaths);
  assert.ok(commands.length > 1);
  assert.deepEqual(
    commands.flatMap(({ args }) => args.slice(5)),
    longTestPaths,
  );
  assert.ok(
    commands.every(
      ({ command, args }) =>
        command === process.execPath &&
        [command, ...args].reduce(
          (size, value) => size + value.length + 3,
          0,
        ) <= 24000,
    ),
  );
  assert.deepEqual(createUnitTestCommands([]), []);
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

  // Verify source and non-TS files read via readFileSync in registered tests are matched
  const readByTest = collectModifiedUnitTestsForPush({
    stdinEntries: [
      {
        localRef: "refs/heads/feat/delivery-center",
        localSha: "5555555555555555555555555555555555555555",
        remoteRef: "refs/heads/feat/delivery-center",
        remoteSha: "0000000000000000000000000000000000000000",
      },
    ],
    unitConfigText:
      'include: ["client/src/components/PageTabs.test.tsx", "client/src/components/reception/ReceptionDuplicateAlert.test.tsx", "client/src/components/ui/layering.test.ts", "server/services/__tests__/permissionParity.test.ts"]',
    runDiff: () => ({
      status: 0,
      stdout:
        "client/src/pages/DeliveryCenter.tsx\nclient/src/components/reception/ReceptionDuplicateAlert.css\nclient/src/components/ui/select.tsx\nserver/routers/commissionsRouter.ts\n",
    }),
    fileExists: () => true,
  });
  assert.deepEqual(readByTest, [
    "client/src/components/PageTabs.test.tsx",
    "server/services/__tests__/permissionParity.test.ts",
    "client/src/components/reception/ReceptionDuplicateAlert.test.tsx",
    "client/src/components/ui/layering.test.ts",
  ]);

  const enumeratedByTest = collectModifiedUnitTestsForPush({
    stdinEntries: [
      {
        localRef: "refs/heads/feat/commissions-router",
        localSha: "6666666666666666666666666666666666666666",
        remoteRef: "refs/heads/feat/commissions-router",
        remoteSha: "0000000000000000000000000000000000000000",
      },
    ],
    unitConfigText:
      'include: ["server/services/__tests__/permissionParity.test.ts"]',
    runDiff: () => ({
      status: 0,
      stdout: "server/routers/commissionsRouter.ts\n",
    }),
    fileExists: () => true,
  });
  assert.deepEqual(enumeratedByTest, [
    "server/services/__tests__/permissionParity.test.ts",
  ]);

  // Verify deleted and renamed source files (--name-status D and R100) still trigger affected tests
  const deletedOrRenamedSource = collectModifiedUnitTestsForPush({
    stdinEntries: [
      {
        localRef: "refs/heads/feat/delete-treasury-hub",
        localSha: "7777777777777777777777777777777777777777",
        remoteRef: "refs/heads/feat/delete-treasury-hub",
        remoteSha: "0000000000000000000000000000000000000000",
      },
    ],
    unitConfigText:
      'include: ["client/src/pages/Treasury.permissionCache.test.tsx", "client/src/components/PageTabs.test.tsx"]',
    runDiff: () => ({
      status: 0,
      stdout:
        "D\tclient/src/pages/TreasuryHub.tsx\nR100\tclient/src/pages/DeliveryCenter.tsx\tclient/src/pages/DeliveryRenamed.tsx\n",
    }),
    fileExists: () => true,
  });
  assert.deepEqual(deletedOrRenamedSource, [
    "client/src/pages/Treasury.permissionCache.test.tsx",
    "client/src/components/PageTabs.test.tsx",
  ]);

  // Verify transitive multi-hop source imports (e.g. invoiceReceipt.test.ts -> invoiceReceipt.ts -> paymentMethod.ts -> inboundPaymentPolicy.ts)
  const transitiveRealRepoMatch = collectModifiedUnitTestsForPush({
    stdinEntries: [
      {
        localRef: "refs/heads/feat/payment-method",
        localSha: "8888888888888888888888888888888888888888",
        remoteRef: "refs/heads/feat/payment-method",
        remoteSha: "0000000000000000000000000000000000000000",
      },
    ],
    unitConfigText:
      'include: ["client/src/lib/printing/invoiceReceipt.test.ts", "client/src/lib/lazyWithRetry.test.ts"]',
    runDiff: () => ({
      status: 0,
      stdout: "client/src/lib/paymentMethod.ts\n",
    }),
    fileExists: () => true,
  });
  assert.deepEqual(transitiveRealRepoMatch, [
    "client/src/lib/printing/invoiceReceipt.test.ts",
  ]);

  // Verify cycle-safe multi-hop + barrel index + deleted leaf detection via custom readFile graph
  const syntheticFiles = new Map([
    [
      "client/src/features/alpha.test.ts",
      'import { runAlpha } from "./alphaService";\n',
    ],
    [
      "client/src/features/alphaService.ts",
      'import { betaHelper } from "./betaHelper";\nexport const runAlpha = () => betaHelper();\n',
    ],
    [
      "client/src/features/betaHelper.ts",
      'import { runAlpha } from "./alphaService";\nimport { barrelFn } from "@/lib/barrel";\nexport const betaHelper = () => barrelFn ?? runAlpha;\n',
    ],
    [
      "client/src/lib/barrel/index.ts",
      'export { deepLeaf } from "./deepLeaf";\nexport { removedHelper } from "./removedHelper";\n',
    ],
    ["client/src/lib/barrel/deepLeaf.ts", "export const deepLeaf = 42;\n"],
  ]);
  const cyclicTransitiveMatch = collectModifiedUnitTestsForPush({
    stdinEntries: [
      {
        localRef: "refs/heads/feat/deep-leaf",
        localSha: "9999999999999999999999999999999999999991",
        remoteRef: "refs/heads/feat/deep-leaf",
        remoteSha: "0000000000000000000000000000000000000000",
      },
    ],
    unitConfigText:
      'include: ["client/src/features/alpha.test.ts", "client/src/features/unrelated.test.ts"]',
    runDiff: () => ({
      status: 0,
      stdout: "D\tclient/src/lib/barrel/removedHelper.ts\n",
    }),
    readFile: (relPath) => syntheticFiles.get(relPath) ?? "",
    fileExists: () => true,
  });
  assert.deepEqual(cyclicTransitiveMatch, [
    "client/src/features/alpha.test.ts",
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
    for (const { command, args: testArgs } of createUnitTestCommands(
      modifiedUnitTests,
    )) {
      const testRes = spawnSync(command, testArgs, {
        cwd: REPO_ROOT,
        stdio: "inherit",
        shell: false,
        env: { ...process.env, TZ: "UTC" },
      });
      if (testRes.status !== 0) {
        console.error(
          "\n⛔ [PRE_PUSH_UNIT_TEST_FAILED] فشل أحد اختبارات الوحدة المتأثرة؛ تم إيقاف الدفع لحماية CI.\n",
        );
        process.exit(testRes.status ?? 1);
      }
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
