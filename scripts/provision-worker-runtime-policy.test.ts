import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import policy from "./provision-worker-runtime-policy.cjs";

describe("provision worker runtime environment", () => {
  const encryptionKey = "1".repeat(64);

  it("يبني بيئة العامل من allowlist موجبة ولا يمرر أسرار الويب والتخزين والذكاء", () => {
    const source = {
      PATH: "runtime-path",
      HOME: "/srv/deploy",
      NODE_ENV: "production",
      TZ: "UTC",
      CONTROL_DATABASE_URL: "control-db-marker",
      INTEGRATIONS_ENCRYPTION_KEY: encryptionKey,
      DB_CONTAINER: "mysql-container-marker",
      DB_ROOT_PW: "mysql-root-marker",
      DATABASE_URL: "tenant-default-marker",
      CONTROL_DB_POOL_LIMIT: "3",
      JWT_SECRET: "jwt-secret-must-not-pass",
      INTERNAL_PROXY_SECRET: "proxy-secret-must-not-pass",
      R2_SECRET_ACCESS_KEY: "r2-secret-must-not-pass",
      R2_ACCESS_KEY_ID: "r2-key-id-must-not-pass",
      GEMINI_API_KEY: "ai-secret-must-not-pass",
      OPENAI_API_KEY: "ai-secret-must-not-pass-too",
      ADMIN_PASSWORD: "admin-secret-must-not-pass",
      UNRELATED_FUTURE_SECRET: "future-secret-must-not-pass",
    };

    const result = policy.buildWorkerEnvironment(source);

    expect(result).toMatchObject({
      PATH: "runtime-path",
      HOME: "/srv/deploy",
      NODE_ENV: "production",
      TZ: "UTC",
      CONTROL_DATABASE_URL: "control-db-marker",
      INTEGRATIONS_ENCRYPTION_KEY: encryptionKey,
      DB_CONTAINER: "mysql-container-marker",
      DB_ROOT_PW: "mysql-root-marker",
      CONTROL_DB_POOL_LIMIT: "3",
    });
    expect(result).not.toHaveProperty("DATABASE_URL");
    expect(Object.keys(result).sort()).toEqual(
      policy.allowedWorkerEnvironmentKeys
        .filter(
          (key: string) =>
            typeof source[key as keyof typeof source] === "string",
        )
        .sort(),
    );
    expect(JSON.stringify(result)).not.toContain("must-not-pass");
  });

  it("يشتق فقط endpoint الناقص من DATABASE_URL ولا يمرر بيانات اعتماده", () => {
    const result = policy.buildWorkerEnvironment({
      DB_HOST: "explicit-db.internal",
      DATABASE_URL: "mysql://app:password@fallback-db.internal:3307/erp",
    });

    expect(result).toMatchObject({
      DB_HOST: "explicit-db.internal",
      DB_PORT: "3307",
    });
    expect(result).not.toHaveProperty("DATABASE_URL");
    expect(JSON.stringify(result)).not.toContain("password");
  });

  it("يقسم بيئات children حسب المهمة ولا يورث أسرار العامل أو الويب", () => {
    const worker = {
      PATH: "runtime-path",
      HOME: "/srv/deploy",
      NODE_ENV: "production",
      TZ: "UTC",
      CONTROL_DATABASE_URL: "control-db-marker",
      INTEGRATIONS_ENCRYPTION_KEY: encryptionKey,
      CONTROL_DB_POOL_LIMIT: "3",
      DB_ROOT_PW: "mysql-root-marker",
      JWT_SECRET: "jwt-secret-must-not-pass",
      R2_SECRET_ACCESS_KEY: "r2-secret-must-not-pass",
      GEMINI_API_KEY: "ai-secret-must-not-pass",
    };

    const claimStep = policy.buildControlStepEnvironment(
      worker,
      "claim-next",
      "linux",
    );
    expect(claimStep).toMatchObject({
      PATH: "runtime-path",
      CONTROL_DATABASE_URL: "control-db-marker",
      INTEGRATIONS_ENCRYPTION_KEY: encryptionKey,
      CONTROL_DB_POOL_LIMIT: "3",
      DOTENV_CONFIG_PATH: "/dev/null",
    });
    expect(claimStep).not.toHaveProperty("DB_ROOT_PW");

    const updateStep = policy.buildControlStepEnvironment(
      worker,
      "mark-done",
      "linux",
    );
    expect(updateStep).not.toHaveProperty("INTEGRATIONS_ENCRYPTION_KEY");

    const mysql = policy.buildMysqlEnvironment(
      worker,
      "one-use-root-password",
      "linux",
    );
    expect(mysql).toMatchObject({
      PATH: "runtime-path",
      MYSQL_PWD: "one-use-root-password",
    });
    expect(mysql).not.toHaveProperty("CONTROL_DATABASE_URL");
    expect(mysql).not.toHaveProperty("INTEGRATIONS_ENCRYPTION_KEY");

    const tenant = policy.buildTenantCommandEnvironment(
      worker,
      {
        DATABASE_URL: "new-tenant-db-marker",
        ADMIN_PASSWORD: "new-company-admin-marker",
        NODE_ENV: "production",
        CONTROL_DATABASE_URL: "",
        R2_SECRET_ACCESS_KEY: "attempted-override-must-not-pass",
      },
      "linux",
    );
    expect(tenant).toMatchObject({
      PATH: "runtime-path",
      DATABASE_URL: "new-tenant-db-marker",
      ADMIN_PASSWORD: "new-company-admin-marker",
      CONTROL_DATABASE_URL: "",
      DOTENV_CONFIG_PATH: "/dev/null",
    });
    expect(tenant).not.toHaveProperty("DB_ROOT_PW");
    expect(tenant).not.toHaveProperty("INTEGRATIONS_ENCRYPTION_KEY");

    const register = policy.buildRegisterEnvironment(
      worker,
      "control-db-override",
      encryptionKey,
      "win32",
    );
    expect(register).toMatchObject({
      PATH: "runtime-path",
      CONTROL_DATABASE_URL: "control-db-override",
      INTEGRATIONS_ENCRYPTION_KEY: encryptionKey,
      DOTENV_CONFIG_PATH: "NUL",
    });

    expect(
      JSON.stringify({ claimStep, updateStep, mysql, tenant, register }),
    ).not.toContain("must-not-pass");

    const dotenvProbe = execFileSync(
      process.execPath,
      [
        "-r",
        "dotenv/config",
        "-e",
        "process.stdout.write(String(Boolean(process.env.JWT_SECRET || process.env.R2_SECRET_ACCESS_KEY || process.env.GEMINI_API_KEY)))",
      ],
      { cwd: process.cwd(), encoding: "utf8", env: register },
    );
    expect(dotenvProbe).toBe("false");

    const encryptionProbe = execFileSync(
      process.execPath,
      [
        "--import=tsx",
        "--eval",
        'import { encryptSecret } from "./server/services/cryptoService"; process.stdout.write(String(encryptSecret("tenant-password")?.startsWith("v1:")))',
      ],
      { cwd: process.cwd(), encoding: "utf8", env: register },
    );
    expect(encryptionProbe).toBe("true");
  });

  it("يعيد PM2 بناء بيئة عامل التوفير من allowlist بعد حذف كل البيئة الموروثة", () => {
    const probe = `
      const config = require("./ecosystem.config.cjs");
      const worker = config.apps.find((app) => app.name === "erp-provision-worker");
      process.stdout.write(JSON.stringify({ filter: worker.filter_env, env: worker.env }));
    `;
    const result = JSON.parse(
      execFileSync(process.execPath, ["-e", probe], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "production",
          TZ: "UTC",
          CONTROL_DATABASE_URL: "control-db-marker",
          INTEGRATIONS_ENCRYPTION_KEY: encryptionKey,
          DB_CONTAINER: "mysql-container-marker",
          DB_ROOT_PW: "mysql-root-marker",
          DATABASE_URL: "mysql://app:password@db.internal:3307/erp",
          JWT_SECRET: "jwt-secret-must-not-pass",
          R2_SECRET_ACCESS_KEY: "r2-secret-must-not-pass",
          GEMINI_API_KEY: "ai-secret-must-not-pass",
          UNRELATED_FUTURE_SECRET: "future-secret-must-not-pass",
        },
      }),
    );

    expect(result.filter).toEqual([""]);
    expect(result.env).toMatchObject({
      PATH: process.env.PATH,
      NODE_ENV: "production",
      TZ: "UTC",
      CONTROL_DATABASE_URL: "control-db-marker",
      INTEGRATIONS_ENCRYPTION_KEY: encryptionKey,
      DB_CONTAINER: "mysql-container-marker",
      DB_ROOT_PW: "mysql-root-marker",
      DB_HOST: "db.internal",
      DB_PORT: "3307",
    });
    expect(result.env).not.toHaveProperty("DATABASE_URL");
    expect(JSON.stringify(result.env)).not.toContain("must-not-pass");
  });
});
