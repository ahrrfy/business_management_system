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
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ecosystem = readFileSync(
  path.resolve(process.cwd(), "ecosystem.config.cjs"),
  "utf8",
);

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
    // المفاتيح العددية تُنشر عبر `...webTunables` لا بسطرٍ لكلٍّ منها.
    expect(block, "webTunables غير مبسوطة في كتلة env").toContain("...webTunables");
    for (const key of REQUIRED_WEB_TUNABLES) {
      expect(ecosystem, `${key} غير مُدرَجٍ في webTunableKeys`).toContain(`"${key}"`);
    }
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
