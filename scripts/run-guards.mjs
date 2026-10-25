#!/usr/bin/env node
/**
 * المشغّل المتوازي لحزمة الحرّاس (`pnpm check:guards` — Wave D3).
 *
 * السبب:
 * تسلسلُ ٤٩ حارساً واحداً تلو الآخر كان يستهلك ~٣.٥–٤ دقائق في كل `pre-commit` و`safe-merge`،
 * معظمها زمنُ تشغيل عمليات متتابعة وفحص ملفات مستقلة للقراءة فقط.
 *
 * التصميم:
 *   • قائمةٌ صريحة ومُصدَّرة `REGISTERED_GUARDS` يقرأها `check-guards-registered.mjs` للتحقّق
 *     المتبادل مع `package.json` و`.github/workflows/ci.yml`.
 *   • جدولةُ الحرّاس الأثقل أوّلاً (LPT: `check:test-types`, `check:lint`, `check:authz`, `check:orphans`…)
 *     داخل حوض عمّال محدود التوازي (`min(cpus, 6)`) لحماية الذاكرة مع تقليص زمن الجدار إلى <٦٠ ثانية.
 *   • تنفيذٌ مباشر عبر `process.execPath` بلا غلاف صدفة (`shell: false`) لتفادي عبء `cmd.exe`/`pnpm`
 *     وضمان وراثة نسخة Node.js المُتحقَّق منها.
 *   • تخزينُ مخرجات كلّ حارسٍ مستقلّةً وطباعةُ ملخّصٍ حتميّ ومفصّل عند الانتهاء.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

export const REGISTERED_GUARDS = [
  "check:emoji",
  "check:tashkeel",
  "check:money-schemas",
  "check:form-inputs",
  "check:branch",
  "check:migrations",
  "check:schema-drift",
  "check:unique-ar",
  "check:orphans",
  "check:date-boundaries",
  "check:colors",
  "check:authz",
  "check:operation-permissions",
  "check:nginx-abuse",
  "check:compose",
  "check:fk-name",
  "check:css-vars",
  "check:page-header",
  "check:invoice-status-variants",
  "check:raw-tables",
  "check:raw-card",
  "check:window-print",
  "check:locale-numbers",
  "check:raw-select",
  "check:no-window-dialogs",
  "check:sem-fill-contrast",
  "check:loading-strings",
  "check:save-shortcut-coverage",
  "check:operation-attribution",
  "check:filter-shell",
  "check:row-attribution",
  "check:duplicate-search",
  "check:firebase-config-security",
  "check:guards-registered",
  "check:lint",
  "check:form-parity",
  "check:message-drift",
  "check:error-messages",
  "check:friction",
  "check:automation-registry",
  "check:vocabulary",
  "check:page-size",
  "check:screen-governance",
  "check:visual-clipping",
  "check:responsive-layout",
  "check:table-integrity",
  "check:test-types",
  "check:arch-facts",
  "check:layer-imports",
];

/** الحرّاس الأثقل حسابياً تبدأ في مقدّمة الطابور لتفادي ذيل الانتظار (LPT Scheduling). */
const HEAVY_FIRST_PRIORITY = new Map([
  ["check:test-types", 1],
  ["check:lint", 2],
  ["check:authz", 3],
  ["check:orphans", 4],
  ["check:operation-permissions", 5],
  ["check:error-messages", 6],
  ["check:friction", 7],
  ["check:schema-drift", 8],
  ["check:screen-governance", 9],
]);

export function orderGuardsForPool(guards) {
  return [...guards].sort((a, b) => {
    const pa = HEAVY_FIRST_PRIORITY.get(a) ?? 100;
    const pb = HEAVY_FIRST_PRIORITY.get(b) ?? 100;
    return pa - pb;
  });
}

/**
 * يحوّل نصّ سكربت الحارس في `package.json` إلى خطوات تنفيذ مباشرة عبر `process.execPath`
 * إن كان مكوّناً من أوامر `node ...` أو `eslint ...` بسيطة بلا اقتباسات معقّدة.
 */
export function resolveDirectSteps(scriptCmd, repoRoot = REPO_ROOT) {
  const raw = String(scriptCmd ?? "").trim();
  if (!raw || /[|><;`$()]/.test(raw) || /["']/.test(raw)) {
    return null;
  }
  const parts = raw
    .split(/\s*&&\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const steps = [];
  for (const part of parts) {
    const tokens = part.split(/\s+/).filter(Boolean);
    if (tokens[0] === "node" && tokens.length >= 2) {
      steps.push({ bin: process.execPath, args: tokens.slice(1), shell: false });
      continue;
    }
    if (tokens[0] === "eslint") {
      const eslintBin = path.join(repoRoot, "node_modules", "eslint", "bin", "eslint.js");
      if (!existsSync(eslintBin)) return null;
      steps.push({
        bin: process.execPath,
        args: [eslintBin, ...tokens.slice(1)],
        shell: false,
      });
      continue;
    }
    return null;
  }
  return steps;
}

function spawnStep({ bin, args, shell }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: REPO_ROOT,
      env: process.env,
      shell: Boolean(shell),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    child.on("error", (err) => {
      chunks.push(Buffer.from(`\nspawn error: ${err.message}\n`, "utf8"));
      resolve({ code: 1, output: Buffer.concat(chunks).toString("utf8") });
    });
    child.on("close", (code) => {
      resolve({
        code: typeof code === "number" ? code : 1,
        output: Buffer.concat(chunks).toString("utf8"),
      });
    });
  });
}

async function runSingleGuard(guardName, scriptCmd) {
  const startedAt = Date.now();
  if (!scriptCmd) {
    return {
      guardName,
      ok: false,
      durationMs: 0,
      output: `✗ السكربت «${guardName}» غير معرَّف في package.json.`,
    };
  }

  const directSteps = resolveDirectSteps(scriptCmd, REPO_ROOT);
  const steps = directSteps ?? [
    {
      bin: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      args: ["run", guardName],
      shell: process.platform === "win32",
    },
  ];

  const outputs = [];
  for (const step of steps) {
    const res = await spawnStep(step);
    if (res.output.trim()) outputs.push(res.output.trim());
    if (res.code !== 0) {
      return {
        guardName,
        ok: false,
        durationMs: Date.now() - startedAt,
        output: outputs.join("\n"),
      };
    }
  }

  return {
    guardName,
    ok: true,
    durationMs: Date.now() - startedAt,
    output: outputs.join("\n"),
  };
}

export function runSelfTest({ quiet = false } = {}) {
  const fails = [];
  const assert = (cond, msg) => {
    if (!cond) fails.push(msg);
  };

  const unique = new Set(REGISTERED_GUARDS);
  assert(unique.size === REGISTERED_GUARDS.length, "لا يجوز تكرار أيّ حارس في REGISTERED_GUARDS");
  assert(
    REGISTERED_GUARDS.every((g) => /^check:[a-z0-9-]+$/.test(g)),
    "جميع أسماء الحرّاس يجب أن تطابق ^check:[a-z0-9-]+$",
  );

  const ordered = orderGuardsForPool(["check:emoji", "check:test-types", "check:lint"]);
  assert(
    ordered[0] === "check:test-types" && ordered[1] === "check:lint",
    "orderGuardsForPool يجب أن يضع الحرّاس الأثقل في مقدّمة الطابور",
  );

  const directNode = resolveDirectSteps(
    "node scripts/check-test-types.mjs --selftest && node scripts/check-test-types.mjs",
  );
  assert(
    Array.isArray(directNode) && directNode.length === 2 && directNode[0].shell === false,
    "resolveDirectSteps يجب أن يحلّل سلاسل node المباشرة بلا صدفة",
  );

  const unsafeShell = resolveDirectSteps("node scripts/foo.mjs | tee out.log");
  assert(unsafeShell === null, "resolveDirectSteps يجب أن يرفض أنابيب الصدفة ويعود للمسار الاحتياطي");

  if (fails.length > 0) {
    console.error("✗ الاختبار الذاتيّ لمشغّل الحرّاس المتوازي فشل:");
    for (const f of fails) console.error(`  - ${f}`);
    process.exit(1);
  }
  if (!quiet) {
    console.log(
      `✓ الاختبار الذاتيّ لمشغّل الحرّاس المتوازي (run-guards): ${REGISTERED_GUARDS.length} حارساً مُسجَّلاً بسلامة.`,
    );
  }
}

async function main() {
  const selftestOnly = process.argv.includes("--selftest");
  runSelfTest({ quiet: !selftestOnly });
  if (selftestOnly) return;

  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const scripts = pkg.scripts ?? {};

  const requestedConcurrency = Number.parseInt(
    process.env.GUARD_RUNNER_CONCURRENCY ?? "",
    10,
  );
  const concurrency = Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
    ? Math.min(requestedConcurrency, 12)
    : Math.max(2, Math.min(os.cpus().length, 6));

  const queue = orderGuardsForPool(REGISTERED_GUARDS);
  const resultsByGuard = new Map();
  const wallStart = Date.now();

  console.log(
    `▶ تشغيل ${REGISTERED_GUARDS.length} حارساً بالتوازي المحكوم (${concurrency} عمّال)…`,
  );

  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const idx = cursor;
      cursor += 1;
      const guardName = queue[idx];
      const res = await runSingleGuard(guardName, scripts[guardName]);
      resultsByGuard.set(guardName, res);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));

  const wallSeconds = ((Date.now() - wallStart) / 1000).toFixed(1);
  const orderedResults = REGISTERED_GUARDS.map((g) => resultsByGuard.get(g)).filter(Boolean);
  const failed = orderedResults.filter((r) => !r.ok);

  if (failed.length > 0) {
    console.error(
      `\n✗ فشل ${failed.length} من أصل ${orderedResults.length} حارساً (الزمن الكلّي: ${wallSeconds}s):\n`,
    );
    for (const f of failed) {
      console.error(`━━━ ✗ ${f.guardName} (${(f.durationMs / 1000).toFixed(1)}s) ━━━`);
      console.error(f.output || "(بلا مخرجات)");
      console.error("");
    }
    process.exit(1);
  }

  const slowest = [...orderedResults]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5)
    .map((r) => `${r.guardName}=${(r.durationMs / 1000).toFixed(1)}s`)
    .join(" · ");

  console.log(
    `✓ نجح جميع الحرّاس (${orderedResults.length}/${orderedResults.length}) في ${wallSeconds}s [الأبطأ: ${slowest}].`,
  );
}

const isDirectEntry =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectEntry) {
  main().catch((err) => {
    console.error("✗ خطأ غير متوقّع في مشغّل الحرّاس:", err);
    process.exit(1);
  });
}
