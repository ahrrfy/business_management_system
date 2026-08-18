"use strict";

// مصدر الحقيقة لبيئة عامل توفير الشركات وعملياته الفرعية. القائمة موجبة عمداً:
// أيّ سر جديد يضاف إلى .env لا يصل تلقائياً إلى العملية المرتفعة الصلاحيات.
const runtimeEnvironmentKeys = Object.freeze([
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "COMSPEC",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "PNPM_HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
]);

const workerApplicationEnvironmentKeys = Object.freeze([
  "NODE_ENV",
  "TZ",
  "CONTROL_DATABASE_URL",
  "INTEGRATIONS_ENCRYPTION_KEY",
  "CONTROL_DB_POOL_LIMIT",
  "DB_CONTAINER",
  "DB_ROOT_PW",
  "DB_HOST",
  "DB_PORT",
]);

const allowedWorkerEnvironmentKeys = Object.freeze([
  ...runtimeEnvironmentKeys,
  ...workerApplicationEnvironmentKeys,
]);

const tenantCommandEnvironmentKeys = Object.freeze([
  "NODE_ENV",
  "TZ",
  "DATABASE_URL",
  "ALLOW_BARE_PUSH",
  "SEED_MODE",
  "CONFIRM_SAMPLE_DATA_SEED",
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
  "ADMIN_USERNAME",
  "ADMIN_MUST_CHANGE_PASSWORD",
  // قيمة فارغة مقصودة: تمنع dotenv من إعادة تحميل وضع تعدد الشركات في أوامر قاعدة
  // الشركة الجديدة، فلا تطلب هذه الأوامر سياق شركة غير موجود.
  "CONTROL_DATABASE_URL",
]);

function pickStringEnvironment(source, allowedKeys) {
  return Object.fromEntries(
    allowedKeys
      .filter((key) => typeof source[key] === "string")
      .map((key) => [key, source[key]]),
  );
}

function buildWorkerEnvironment(source) {
  const environment = pickStringEnvironment(
    source,
    allowedWorkerEnvironmentKeys,
  );

  // العامل يحتاج موضع MySQL فقط، لا بيانات اعتماد مستخدم التطبيق المضمّنة في URL.
  // اشتقاق host/port قبل محو البيئة يحافظ على عقد النشر الحالي بلا تمرير السرّ.
  if (
    (!environment.DB_HOST || !environment.DB_PORT) &&
    typeof source.DATABASE_URL === "string"
  ) {
    try {
      const databaseUrl = new URL(source.DATABASE_URL);
      if (!environment.DB_HOST) environment.DB_HOST = databaseUrl.hostname;
      if (!environment.DB_PORT) {
        environment.DB_PORT = databaseUrl.port || "3306";
      }
    } catch {
      // العامل يطبّق القيم الافتراضية الآمنة عند URL غير صالح.
    }
  }

  return environment;
}

function dotenvIsolation(platform) {
  return {
    DOTENV_CONFIG_PATH: platform === "win32" ? "NUL" : "/dev/null",
    DOTENV_CONFIG_QUIET: "true",
  };
}

function buildChildBaseEnvironment(source, platform) {
  return {
    ...pickStringEnvironment(source, runtimeEnvironmentKeys),
    ...pickStringEnvironment(source, ["NODE_ENV", "TZ"]),
    ...dotenvIsolation(platform),
  };
}

function buildControlStepEnvironment(
  source,
  command,
  platform = process.platform,
) {
  const environment = {
    ...buildChildBaseEnvironment(source, platform),
    ...pickStringEnvironment(source, [
      "CONTROL_DATABASE_URL",
      "CONTROL_DB_POOL_LIMIT",
    ]),
  };
  if (command === "claim-next") {
    Object.assign(
      environment,
      pickStringEnvironment(source, ["INTEGRATIONS_ENCRYPTION_KEY"]),
    );
  }
  return environment;
}

function buildMysqlEnvironment(
  source,
  rootPassword,
  platform = process.platform,
) {
  return {
    ...buildChildBaseEnvironment(source, platform),
    MYSQL_PWD: rootPassword,
  };
}

function buildTenantCommandEnvironment(
  source,
  commandEnvironment,
  platform = process.platform,
) {
  return {
    ...buildChildBaseEnvironment(source, platform),
    ...pickStringEnvironment(commandEnvironment, tenantCommandEnvironmentKeys),
  };
}

function buildRegisterEnvironment(
  source,
  controlUrl,
  integrationsEncryptionKey,
  platform = process.platform,
) {
  return {
    ...buildChildBaseEnvironment(source, platform),
    ...pickStringEnvironment(source, ["CONTROL_DB_POOL_LIMIT"]),
    CONTROL_DATABASE_URL: controlUrl,
    INTEGRATIONS_ENCRYPTION_KEY: integrationsEncryptionKey,
  };
}

module.exports = Object.freeze({
  runtimeEnvironmentKeys,
  workerApplicationEnvironmentKeys,
  allowedWorkerEnvironmentKeys,
  tenantCommandEnvironmentKeys,
  buildWorkerEnvironment,
  buildControlStepEnvironment,
  buildMysqlEnvironment,
  buildTenantCommandEnvironment,
  buildRegisterEnvironment,
});
