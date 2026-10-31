/**
 * عقد تصريح البيئة لعمّال الويب في PM2 (٣١/٨/٢٦) — فخٌّ أمسكه نشرٌ حقيقيّ.
 *
 * PM2 يدمج بيئة مُحمِّل `ecosystem.config.cjs` في التطبيق **عند `pm2 start` وحده**؛ و
 * `pm2 reload … --update-env` (وهو ما يشغّله `scripts/deploy.mjs`) يُحدّث ما هو **مُصرَّحٌ
 * في كتلة `env`** لا غير. فمتغيّرٌ يقرأه الخادم ولا يُصرَّح هناك يبقى مجمَّداً على قيمته
 * لحظةَ أوّل تشغيل — مهما عُدِّل `.env` ومهما تكرّر النشر — **بلا خطأ ولا تحذير**.
 *
 * الحالة التي كشفته: رُفع `DB_POOL_LIMIT` في `.env` الإنتاج من 5 إلى 10، ونجح نشرٌ كامل،
 * وصُدِّر المتغيّر صراحةً في صدفة أمر إعادة التحميل — وظلّت العمّال الثلاثة على 5، أي أنّ
 * سقف اتصالات النظام بقي 15 بينما كلّ الأدلّة تقول إنّ الإصلاح سرى.
 *
 * ⇒ أيّ مفتاح ضبطٍ تشغيليّ يُقرأ في مسار الويب يجب أن يظهر في كتلة `env` لتطبيق erp-server.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ecosystem = readFileSync(
  path.resolve(process.cwd(), "ecosystem.config.cjs"),
  "utf8",
);

function webBootCall(legacyArgv: boolean) {
  const file = path.resolve("server/index.ts");
  const source = readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "awaitInventoryActivationRelease") calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(calls).toHaveLength(1);
  const call = calls[0];
  const options = call.arguments[0];
  if (!ts.isObjectLiteralExpression(options)) throw new Error("WEB_BOOT_OPTIONS_NOT_LITERAL");
  const properties = options.properties.filter(ts.isPropertyAssignment);
  const identity = properties.find(property => property.name.getText(ast) === "readIdentity")!;
  const bundle = properties.find(property => property.name.getText(ast) === "bundle")!;
  const start = call.getStart(ast);
  const edits = [{ node: identity.initializer, text: 'async () => ({ database: "erp_synthetic_boot", serverUuid: "synthetic-server-uuid" })' }];
  if (legacyArgv) edits.push({ node: bundle.initializer, text: "process.argv[1]" });
  let text = call.getText(ast);
  for (const edit of edits.sort((a, b) => b.node.getStart(ast) - a.node.getStart(ast))) {
    text = text.slice(0, edit.node.getStart(ast) - start) + edit.text + text.slice(edit.node.getEnd() - start);
  }
  return text;
}

function runWebBootFixture({ legacyArgv = false, wrongHash = false } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "erp-web-entry-"));
  chmodSync(directory, 0o700);
  const home = path.join(directory, "home");
  mkdirSync(path.join(home, ".pm2"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(directory, "package.json"), '{"type":"module"}\n');
  const bundle = path.join(directory, "index.js");
  buildSync({
    stdin: { contents: `import { fileURLToPath } from "node:url";
import { awaitInventoryActivationRelease } from ${JSON.stringify(path.resolve("server/config/inventoryActivationBoot.ts"))};
await ${webBootCall(legacyArgv)};
console.log(JSON.stringify({ bundle: fileURLToPath(import.meta.url), argv: process.argv[1], released: true }));`, resolveDir: process.cwd(), loader: "ts" },
    platform: "node", target: "node24", format: "esm", bundle: true, outfile: bundle,
  });
  const hash = wrongHash ? "0".repeat(64) : createHash("sha256").update(readFileSync(bundle)).digest("hex");
  const artifacts = [{ name: "erp-server", bundle, script: bundle, hash, scriptHash: hash, instances: 1 }];
  const id = randomUUID();
  const commit = "a".repeat(40);
  writeFileSync(path.join(home, ".pm2", "erp-inventory-activation.json"), JSON.stringify({
    version: 1, id, nonce: "b".repeat(64), commit, phase: "RELEASED", database: "erp_synthetic_boot", serverUuid: "synthetic-server-uuid", artifacts,
    active: { activationId: id, commit, projectionCommit: commit, readyVersion: 1, database: "erp_synthetic_boot", serverUuid: "synthetic-server-uuid", artifacts },
  }), { mode: 0o600 });
  const wrapper = path.join(directory, "ProcessContainer.cjs");
  writeFileSync(wrapper, 'const { pathToFileURL } = require("node:url"); import(pathToFileURL(process.argv[2]).href).catch(error => { console.error(error.message); process.exitCode = 1; });\n');
  const environment = Object.fromEntries(Object.entries({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    NODE_ENV: "production", HOME: home, USERPROFILE: home }).filter(([, value]) => value !== undefined));
  const result = spawnSync(process.execPath, [wrapper, bundle], { encoding: "utf8", timeout: 10000, cwd: directory, env: environment });
  return { bundle, wrapper, result };
}

describe("compiled web entry inventory artifact identity", () => {
  it("uses the production ESM build contract", () => {
    const pkg = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));
    expect(pkg.type).toBe("module");
    const command = (pkg.scripts.build as string).split("&&").find(part => /esbuild server\/index\.ts\b/.test(part));
    expect(command).toMatch(/--format=esm\b/);
    expect(command).toMatch(/--target=node24\b/);
  });

  it("boots the actual compiled entry when argv points at a cluster wrapper", () => {
    const { bundle, wrapper, result } = runWebBootFixture();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ bundle, argv: wrapper, released: true });
  });

  it("reproduces the old argv identity failure through the real boot fence", () => {
    const { result } = runWebBootFixture({ legacyArgv: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("INVENTORY_BOOT_ARTIFACT_MISMATCH");
  });

  it("still refuses a wrong artifact hash before releasing boot", () => {
    const { result } = runWebBootFixture({ wrongHash: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("INVENTORY_BOOT_ARTIFACT_MISMATCH");
    expect(result.stdout).not.toContain('"released":true');
  });
});

/** كتلة `env` لتطبيق erp-server وحدها (لا كتل التطبيقات الأخرى). */
function webEnvBlock(): string {
  const appStart = ecosystem.indexOf('name: "erp-server"');
  expect(appStart, "تعذّر إيجاد تطبيق erp-server").toBeGreaterThan(-1);
  const envStart = ecosystem.indexOf("env: {", appStart);
  expect(envStart, "تعذّر إيجاد كتلة env").toBeGreaterThan(-1);
  const envEnd = ecosystem.indexOf("\n      },", envStart);
  expect(envEnd, "تعذّر إيجاد نهاية كتلة env").toBeGreaterThan(envStart);
  return ecosystem.slice(envStart, envEnd);
}

/** مفاتيح ضبطٍ تشغيليّ يقرأها مسار الويب ويجب أن تكون قابلةً للتغيير بنشرٍ لا بإعادة إنشاء. */
const REQUIRED_WEB_ENV_KEYS = [
  "WEB_INSTANCES",
  "DATABASE_URL",
  "JWT_SECRET",
  "STOREFRONT_JWT_SECRET",
  "PORT",
  "HOST",
] as const;

/** مفاتيحُ ضبطٍ عدديّة تُمرَّر عبر `webTunables` (تُدرَج الموجودة فقط، تفادياً لنصّ "undefined"). */
const REQUIRED_WEB_TUNABLES = [
  "DB_POOL_LIMIT",
  "MYSQL_MAX_CONNECTIONS",
  "DB_CONNECTION_RESERVE",
  "EVENT_LOOP_MAX_LAG_MS",
  "EVENT_LOOP_CRITICAL_MAX_LAG_MS",
  "EVENT_LOOP_STOREFRONT_MAX_LAG_MS",
  // مفاتيح المتجر العام: بعضها مفتاح إطفاء طارئ (STOREFRONT_ORDERING_ENABLED)؛ لو لم يُصرَّح هنا
  // لتجمّد على قيمة أوّل تشغيل فلا يطفئ المتجر وقت الطوارئ مهما عُدِّل .env ونُشر.
  "STOREFRONT_ORDERING_ENABLED",
  "STOREFRONT_TURNSTILE_ENABLED",
  "STOREFRONT_RATE_LIMIT_MAX",
  "STOREFRONT_ORDER_RATE_LIMIT_MAX",
  "STOREFRONT_TRACK_RATE_LIMIT_MAX",
  "STOREFRONT_ANALYTICS_RATE_LIMIT_MAX",
  "PUBLIC_SITE_ORIGIN",
  "WEB_PUSH_OUTBOX_INTERVAL_MS",
] as const;

/** مفاتيح الاستوديو تُصرّح دائماً؛ الفراغ يمسح قيمة PM2 قديمة بدلاً من إبقائها بصمت. */
const REQUIRED_STUDIO_ENV_KEYS = [
  "INTEGRATIONS_ENCRYPTION_KEY",
  "GEMINI_API_BASE",
  "IMAGE_STORE_DRIVER",
  "R2_ACCOUNT_ID",
  "R2_IMAGE_BUCKET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_MAX_CONCURRENCY",
  "R2_MAX_QUEUE",
  "R2_QUEUE_TIMEOUT_MS",
  "R2_CIRCUIT_FAILURE_THRESHOLD",
  "R2_CIRCUIT_OPEN_MS",
] as const;

/** أسرارٌ ممنوعة على عامل الويب مهما كان (مرآةُ webForbiddenEnvironmentKeys). */
const FORBIDDEN_WEB_ENV_KEYS = [
  "DB_ROOT_PW",
  "DB_CONTAINER",
  "DB_APP_PW",
  "DB_CONTROL_PW",
  "ADMIN_PASSWORD",
] as const;

describe("عقد تصريح بيئة PM2 لعامل الويب", () => {
  it("كل مفتاح ضبطٍ تشغيليّ مُصرَّحٌ في كتلة env (وإلّا تجمّد على أوّل تشغيل)", () => {
    const block = webEnvBlock();
    for (const key of REQUIRED_WEB_ENV_KEYS) {
      expect(block, `${key} غير مُصرَّح ⇒ تعديلُه في .env لن يسري أبداً`).toContain(`${key}:`);
    }
    expect(
      block,
      "STOREFRONT_JWT_SECRET يجب أن يمسح القيمة الموروثة عند إزالته من .env ليعود إلى JWT_SECRET",
    ).toContain('STOREFRONT_JWT_SECRET: process.env.STOREFRONT_JWT_SECRET ?? ""');
    // المفاتيح العددية تُنشر عبر `...webTunables` لا بسطرٍ لكلٍّ منها.
    expect(block, "webTunables غير مبسوطة في كتلة env").toContain("...webTunables");
    for (const key of REQUIRED_WEB_TUNABLES) {
      expect(ecosystem, `${key} غير مُدرَجٍ في webTunableKeys`).toContain(`"${key}"`);
    }
    expect(block, "webStudioEnvironment غير مبسوطة في كتلة env").toContain("...webStudioEnvironment");
    for (const key of REQUIRED_STUDIO_ENV_KEYS) {
      expect(ecosystem, `${key} غير مُدرَج في عقد بيئة الاستوديو`).toContain(`"${key}"`);
    }
    expect(ecosystem, "غياب قيمة الاستوديو يجب أن يمسح الموروث القديم").toContain('process.env[key] ?? ""');
  });

  it("webTunables تُسقط غير المضبوط بدل تمريره نصّاً \"undefined\"", () => {
    // `boundedIntEnv` في server/db.ts يرمي على قيمةٍ غير عددية ⇒ تمريرُ "undefined" كان
    // سيمنع إقلاع الخادم في أيّ نشرٍ لا يضبط المفتاح.
    expect(ecosystem).toContain('typeof process.env[key] === "string"');
    expect(ecosystem).toContain('process.env[key].trim() !== ""');
  });

  it("لا سرّ من الأسرار الممنوعة يتسرّب إلى كتلة env", () => {
    const block = webEnvBlock();
    for (const key of FORBIDDEN_WEB_ENV_KEYS) {
      expect(block, `${key} يجب ألّا يصل عامل الويب`).not.toContain(`${key}:`);
    }
  });

  it("النشر يُعيد تقييم ملف ecosystem ويحدّث البيئة معاً (لا reload بالاسم وحده)", () => {
    const deploy = readFileSync(
      path.resolve(process.cwd(), "scripts/deploy.mjs"),
      "utf8",
    );
    // بلا `ecosystem.config.cjs` لا يُعاد تقييم الملف فلا يُقرأ .env أصلاً؛
    // وبلا `--update-env` لا تُحدَّث حتى المفاتيح المُصرَّحة.
    expect(deploy).toContain('"ecosystem.config.cjs"');
    expect(deploy).toContain('"--update-env"');
  });
});
