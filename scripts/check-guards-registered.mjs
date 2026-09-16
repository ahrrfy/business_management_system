#!/usr/bin/env node
/**
 * حارسُ الحرّاس — كلُّ حارسٍ في `check:guards` يجب أن يملك **خطوةً صريحة** في CI.
 *
 * السبب (Codex P2 على PR #939، وقبله ملاحظةٌ مماثلة على PR #795):
 * وظيفةُ `check-test-build` تستدعي الحرّاسَ **بالاسم واحداً واحداً** ولا تشغّل
 * `pnpm check:guards` أبداً. فحارسٌ يُضاف إلى الـaggregate وحدَه:
 *   • يعمل محلياً في `pre-commit` فيبدو مُفعَّلاً،
 *   • ولا يعمل في CI إطلاقاً ⇒ أيّ PR يتخطّى pre-commit (أو يُفتح من واجهة GitHub)
 *     يُدخِل الانتهاكَ الذي كُتب الحارسُ لمنعه، وCI أخضر.
 * وقع هذا فعلاً على خمسة حرّاس معاً: tashkeel · operation-attribution ·
 * filter-shell · row-attribution · duplicate-search.
 *
 * الحارسُ الذي لا يعمل في CI أسوأُ من غيابه: يمنح ثقةً كاذبة.
 *
 * ⚠️ استثناءٌ واحدٌ مقصود: `check:authz` لا يعمل في `check-test-build` بل تحرسه
 * وظيفةٌ منفصلة `authz-guard` بفرق قاعدة الدمج (§٣.١ في CLAUDE.md).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
const workflow = readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");

const aggregate = pkg.scripts?.["check:guards"];
if (!aggregate) {
  console.error("✗ لا سكربت check:guards في package.json");
  process.exit(1);
}

/** حرّاسٌ تحرسها وظيفةٌ أخرى في نفس الملفّ — لا يلزمها خطوةٌ في check-test-build. */
const COVERED_ELSEWHERE = new Set(["check:authz"]);

const inAggregate = [...aggregate.matchAll(/pnpm (check:[a-z0-9-]+)/g)].map((m) => m[1]);
const missing = inAggregate.filter(
  (name) => !COVERED_ELSEWHERE.has(name) && !workflow.includes(`pnpm ${name}`),
);

if (missing.length) {
  console.error(`✗ ${missing.length} حارساً في check:guards بلا خطوةٍ في CI:\n`);
  for (const name of missing) console.error(`  - ${name}`);
  console.error(`
وظيفةُ \`check-test-build\` في \`.github/workflows/ci.yml\` تستدعي الحرّاسَ **بالاسم** ولا
تشغّل \`pnpm check:guards\`. فحارسٌ في الـaggregate وحدَه يعمل في pre-commit ويبدو مُفعَّلاً،
ولا يعمل في CI ⇒ ثقةٌ كاذبة.

الإصلاح — أضِف خطوةً بجانب بقيّة حرّاس الواجهة:
      - name: <وصفٌ عربيّ قصير>
        run: pnpm <اسم الحارس>
`);
  process.exit(1);
}

console.log(
  `✓ تسجيل الحرّاس: ${inAggregate.length} حارساً في check:guards، كلٌّ له خطوةٌ في CI` +
    (COVERED_ELSEWHERE.size ? ` (عدا ${[...COVERED_ELSEWHERE].join("، ")} — وظيفةٌ مستقلّة).` : "."),
);
