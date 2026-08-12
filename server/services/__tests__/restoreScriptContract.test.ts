import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("restore script streaming contract", () => {
  it("لا يعيد تحميل dump كاملاً في ذاكرة العملية", async () => {
    const source = await readFile(path.resolve(process.cwd(), "scripts/restore.mjs"), "utf8");
    expect(source).toContain("createReadStream(file)");
    expect(source).toContain("pipeline(createReadStream(file), child.stdin)");
    expect(source).toContain('"--binary-mode=1"');
    expect(source).not.toMatch(/readFileSync\(file/);
    expect(source).not.toMatch(/Buffer\.concat\([^\n]*sql/);
    expect(source).toContain("validateDumpTarget");
    expect(source).toContain("ALROYA_DB_NEUTRAL_BACKUP");
    expect(source).toContain("acquireMaintenanceLock");
    expect(source).toContain('["db:migrate:apply"]');
    expect(source).toContain('["db:verify"]');
  });

  it("ينشر النسخة باسم فريد وملف partial حصري ثم rename ذري", async () => {
    const source = await readFile(path.resolve(process.cwd(), "scripts/backup.mjs"), "utf8");
    expect(source).toContain('flags: "wx"');
    expect(source).toContain("randomUUID()");
    expect(source).toContain("ALROYA_DB_NEUTRAL_BACKUP");
    expect(source).toContain('"--no-tablespaces"');
    expect(source).toContain("renameSync(partial, out)");
    expect(source).not.toContain('"--databases", t.db');
  });

  it("يدوّر أسماء النسخ الذرية الجديدة والقديمة ولا يهملها", async () => {
    const source = await readFile(path.resolve(process.cwd(), "scripts/backup-rotate.mjs"), "utf8");
    expect(source).toContain("milliseconds = \"000\"");
    expect(source).toContain("Z-[0-9a-f]{8}");
    expect(source).toContain("Number.isNaN(stamp.getTime())");
    expect(() => execFileSync(process.execPath, [path.resolve(process.cwd(), "scripts/backup-rotate.mjs"), "--selftest"]))
      .not.toThrow();
  });

  it("يشترك reset CLI في قفل الصيانة ويحفظ بنية الصلاحيات والتدقيق", async () => {
    const source = await readFile(path.resolve(process.cwd(), "scripts/reset.mjs"), "utf8");
    expect(source).toContain("acquireMaintenanceLock");
    expect(source).toContain('"roles"');
    expect(source).toContain('"auditlogs"');
    expect(source).toContain('"userrecoverycodes"');
  });

  it("يقفل الاستعادة والتصفير القادمين من tRPC أيضاً", async () => {
    const source = await readFile(path.resolve(process.cwd(), "server/routers/systemRouter.ts"), "utf8");
    const restore = source.slice(source.indexOf("restoreBackup:"), source.indexOf("restoreUpload:"));
    const reset = source.slice(source.indexOf("resetSystem:"), source.indexOf("getTaxSettings:"));
    expect(restore).toContain("acquireRestoreLock");
    expect(restore).toContain("finally");
    expect(reset).toContain("acquireRestoreLock");
    expect(reset).toContain("finally");
  });

  it("يعطّل الصيانة المدمرة عبر الويب في الإنتاج بلا مفتاح تجاوز", async () => {
    const source = await readFile(path.resolve(process.cwd(), "server/routers/systemRouter.ts"), "utf8");
    const guard = source.slice(source.indexOf("function assertSingleTenantOnly"), source.indexOf("export const systemRouter"));
    expect(guard).toContain('process.env.NODE_ENV === "production"');
    expect(guard).not.toContain("ALLOW_ONLINE_DB_MAINTENANCE");
    expect(source).not.toContain("ALLOW_ONLINE_DB_MAINTENANCE");
  });

  it("يشغّل الويب بحساب قاعدة محصور ويمسح سر root الموروث", async () => {
    const [index, compose, productionEnv] = await Promise.all([
      readFile(path.resolve(process.cwd(), "server/index.ts"), "utf8"),
      readFile(path.resolve(process.cwd(), "docker-compose.yml"), "utf8"),
      readFile(path.resolve(process.cwd(), ".env.production.example"), "utf8"),
    ]);
    expect(index).toContain("delete process.env.DB_ROOT_PW");
    expect(compose).toContain("MYSQL_USER: ${DB_APP_USER:-erp_app}");
    expect(compose).toContain("MYSQL_PASSWORD: ${DB_APP_PW:");
    expect(productionEnv).toContain("DATABASE_URL=mysql://erp_app:");
    expect(productionEnv).not.toContain("DATABASE_URL=mysql://root:");
  });

  it("تبقى عينة تعدد الشركات ضمن ميزانية الاتصالات الآمنة", async () => {
    const sample = await readFile(path.resolve(process.cwd(), ".env.example"), "utf8");
    expect(sample).toContain("WEB_INSTANCES=2");
    expect(sample).toContain("DB_POOL_LIMIT=5");
    expect(sample).toContain("DB_MAX_TENANT_POOLS_PER_WORKER=10");
    expect(sample).toContain("MYSQL_MAX_CONNECTIONS=151");
    expect(sample).toContain("DB_CONNECTION_RESERVE=20");
    expect(sample).toContain("CONTROL_DB_POOL_LIMIT=5");
  });

  it("يغلق CLI استعادة المدير تجمعي الشركة والتحكم دائماً", async () => {
    const source = await readFile(path.resolve(process.cwd(), "scripts/recover-last-admin.ts"), "utf8");
    expect(source).toContain("closeDb().catch");
    expect(source).toContain("closeControlDb().catch");
    expect(source).toContain("await Promise.all");
  });
});
