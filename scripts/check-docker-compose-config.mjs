import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const result = spawnSync(
  "docker",
  ["compose", "--file", "docker-compose.yml", "config", "--quiet"],
  {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      DB_ROOT_PW: "compose-config-check-root-password",
      DB_APP_PW: "compose-config-check-app-password",
    },
  },
);

if (result.error) {
  console.error(`✗ تعذّر تشغيل Docker Compose: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  const detail = (result.stderr || result.stdout || "خطأ غير معروف").trim();
  console.error(`✗ docker-compose.yml غير صالح:\n${detail}`);
  process.exit(result.status ?? 1);
}

console.log("✓ docker-compose.yml صالح للتحليل بقيم اختبار آمنة.");
