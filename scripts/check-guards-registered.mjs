#!/usr/bin/env node
/**
 * حارسُ الحرّاس — كلُّ حارسٍ في `check:guards` (`REGISTERED_GUARDS` في `scripts/run-guards.mjs`)
 * يجب أن يكون معرَّفاً في `package.json` وأن يملك **خطوةً صريحة** في CI (`.github/workflows/ci.yml`).
 *
 * السبب (Codex P2 على PR #939، وقبله ملاحظةٌ مماثلة على PR #795):
 * وظيفةُ `quality-build` تستدعي الحرّاسَ **بالاسم واحداً واحداً** ولا تشغّل
 * `pnpm check:guards` أبداً. فحارسٌ يُضاف إلى الـaggregate وحدَه:
 *   • يعمل محلياً في `pre-commit` فيبدو مُفعَّلاً،
 *   • ولا يعمل في CI إطلاقاً ⇒ أيّ PR يتخطّى pre-commit (أو يُفتح من واجهة GitHub)
 *     يُدخِل الانتهاكَ الذي كُتب الحارسُ لمنعه، وCI أخضر.
 *
 * ⚠️ استثناءٌ واحدٌ مقصود: `check:authz` لا يعمل في `quality-build` بل تحرسه
 * وظيفةٌ منفصلة `authz-guard` بفرق قاعدة الدمج (§٣.١ في CLAUDE.md).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REGISTERED_GUARDS } from "./run-guards.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** حرّاسٌ تحرسها وظيفةٌ أخرى في نفس الملفّ — لا يلزمها خطوةٌ في quality-build. */
export const COVERED_ELSEWHERE = new Set(["check:authz"]);

export function extractConfiguredGuards(pkg, registeredGuards = REGISTERED_GUARDS) {
  const aggregate = String(pkg?.scripts?.["check:guards"] ?? "");
  if (!aggregate) {
    return { error: "لا سكربت check:guards في package.json", guards: [] };
  }
  const inline = [...aggregate.matchAll(/pnpm (check:[a-z0-9-]+)/g)].map((m) => m[1]);
  if (inline.length > 0) {
    return { error: null, guards: inline };
  }
  if (aggregate.includes("scripts/run-guards.mjs")) {
    return { error: null, guards: [...registeredGuards] };
  }
  return {
    error: "سكربت check:guards لا يذكر حرّاساً صريحة ولا يستدعي scripts/run-guards.mjs",
    guards: [],
  };
}

export function validateGuardsRegistration({ pkg, workflow, registeredGuards = REGISTERED_GUARDS }) {
  const extracted = extractConfiguredGuards(pkg, registeredGuards);
  if (extracted.error) {
    return { ok: false, reason: extracted.error, missingInPkg: [], missingInCi: [], duplicateGuards: [] };
  }

  const guards = extracted.guards;
  const seen = new Set();
  const duplicateGuards = [];
  for (const g of guards) {
    if (seen.has(g)) duplicateGuards.push(g);
    seen.add(g);
  }

  const scripts = pkg?.scripts ?? {};
  const missingInPkg = guards.filter((name) => !scripts[name]);
  const missingInCi = guards.filter(
    (name) => !COVERED_ELSEWHERE.has(name) && !workflow.includes(`pnpm ${name}`),
  );

  const ok =
    duplicateGuards.length === 0 && missingInPkg.length === 0 && missingInCi.length === 0;
  return {
    ok,
    guardsCount: guards.length,
    duplicateGuards,
    missingInPkg,
    missingInCi,
  };
}

function runSelfTest({ quiet = false } = {}) {
  const fails = [];
  const assert = (cond, msg) => {
    if (!cond) fails.push(msg);
  };

  const okRes = validateGuardsRegistration({
    pkg: {
      scripts: {
        "check:guards": "node scripts/run-guards.mjs --selftest && node scripts/run-guards.mjs",
        "check:emoji": "node scripts/check-no-emoji-ui.mjs",
        "check:authz": "node scripts/authz-inventory.mjs --check",
      },
    },
    workflow: "run: pnpm check:emoji",
    registeredGuards: ["check:emoji", "check:authz"],
  });
  assert(okRes.ok === true && okRes.guardsCount === 2, "يمرّر الحرّاس المكتملة مع استثناء check:authz");

  const missingCiRes = validateGuardsRegistration({
    pkg: {
      scripts: {
        "check:guards": "node scripts/run-guards.mjs",
        "check:emoji": "node scripts/check-no-emoji-ui.mjs",
        "check:new-guard": "node scripts/new.mjs",
      },
    },
    workflow: "run: pnpm check:emoji",
    registeredGuards: ["check:emoji", "check:new-guard"],
  });
  assert(
    missingCiRes.ok === false && missingCiRes.missingInCi.includes("check:new-guard"),
    "يرفض الحارس المفقود من ci.yml",
  );

  const missingPkgRes = validateGuardsRegistration({
    pkg: {
      scripts: {
        "check:guards": "node scripts/run-guards.mjs",
      },
    },
    workflow: "run: pnpm check:ghost",
    registeredGuards: ["check:ghost"],
  });
  assert(
    missingPkgRes.ok === false && missingPkgRes.missingInPkg.includes("check:ghost"),
    "يرفض الحارس غير المعرّف في package.json",
  );

  if (fails.length > 0) {
    console.error("✗ الاختبار الذاتيّ لحارس تسجيل الحرّاس فشل:");
    for (const f of fails) console.error(`  - ${f}`);
    process.exit(1);
  }
  if (!quiet) {
    console.log("✓ الاختبار الذاتيّ لحارس تسجيل الحرّاس (check:guards-registered): سليم.");
  }
}

function main() {
  const selftestOnly = process.argv.includes("--selftest");
  runSelfTest({ quiet: !selftestOnly });
  if (selftestOnly) return;

  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const workflow = readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
  const res = validateGuardsRegistration({ pkg, workflow });

  if (!res.ok) {
    if (res.reason) {
      console.error(`✗ ${res.reason}`);
      process.exit(1);
    }
    if (res.duplicateGuards.length > 0) {
      console.error(`✗ حرّاس مكرّرة في REGISTERED_GUARDS: ${res.duplicateGuards.join(", ")}`);
    }
    if (res.missingInPkg.length > 0) {
      console.error(`✗ ${res.missingInPkg.length} حارساً بلا سكربت في package.json:`);
      for (const name of res.missingInPkg) console.error(`  - ${name}`);
    }
    if (res.missingInCi.length > 0) {
      console.error(`✗ ${res.missingInCi.length} حارساً في check:guards بلا خطوةٍ في CI:\n`);
      for (const name of res.missingInCi) console.error(`  - ${name}`);
      console.error(`
وظيفةُ \`quality-build\` في \`.github/workflows/ci.yml\` تستدعي الحرّاسَ **بالاسم** ولا
تشغّل \`pnpm check:guards\`. فحارسٌ في الـaggregate وحدَه يعمل في pre-commit ويبدو مُفعَّلاً،
ولا يعمل في CI ⇒ ثقةٌ كاذبة.

الإصلاح — أضِف خطوةً بجانب بقيّة حرّاس البنية:
      - name: <وصفٌ عربيّ قصير>
        run: pnpm <اسم الحارس>
`);
    }
    process.exit(1);
  }

  console.log(
    `✓ تسجيل الحرّاس: ${res.guardsCount} حارساً في check:guards، كلٌّ معرَّف في package.json وله خطوةٌ في CI` +
      (COVERED_ELSEWHERE.size ? ` (عدا ${[...COVERED_ELSEWHERE].join("، ")} — وظيفةٌ مستقلّة).` : "."),
  );
}

const isDirectEntry =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectEntry) {
  main();
}
