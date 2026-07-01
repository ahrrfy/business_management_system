// اختبار وحدة لخدمة الصيانة — أمان المسار (path traversal) + تحقّق الرفع + اسم القاعدة. لا قاعدة بيانات.
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  resolveBackupFile, quarantineUpload, cleanupTmp, currentDbName, backupsDir,
} from "../maintenanceService";

describe("resolveBackupFile — أمان المسار", () => {
  it("يرفض الفواصل و«..» وغير .sql والفارغ", async () => {
    for (const bad of ["", "../etc/passwd", "a/b.sql", "a\\b.sql", "..\\x.sql", "notsql.txt", "x.sql/../y"]) {
      expect(await resolveBackupFile(bad)).toBeNull();
    }
  });

  it("يرفض ملفاً غير موجود", async () => {
    expect(await resolveBackupFile("does-not-exist-12345.sql")).toBeNull();
  });

  it("يقبل ملف .sql موجوداً داخل مجلّد backups فقط", async () => {
    await mkdir(backupsDir(), { recursive: true });
    const name = `unit-test-${process.pid}.sql`;
    const abs = path.join(backupsDir(), name);
    await writeFile(abs, "-- MySQL dump\n");
    try {
      const resolved = await resolveBackupFile(name);
      expect(resolved).toBe(abs);
    } finally {
      await rm(abs, { force: true });
    }
  });
});

describe("quarantineUpload — تحقّق الملف المرفوع", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");

  it("يرفض الصغير/التالف", async () => {
    await expect(quarantineUpload(b64("tiny"))).rejects.toThrow();
  });

  it("يرفض ملفاً بلا توقيع mysqldump", async () => {
    const junk = "x".repeat(2000);
    await expect(quarantineUpload(b64(junk))).rejects.toThrow();
  });

  it("يقبل ملفاً يحمل توقيع mysqldump ويكتبه لحجر مؤقّت", async () => {
    const sql = "-- MySQL dump 10.x\n" + "CREATE TABLE `x`(id int);\n".repeat(50);
    const tmp = await quarantineUpload(b64(sql));
    expect(tmp).toMatch(/restore-upload-.*\.sql$/);
    await cleanupTmp(tmp);
  });
});

describe("currentDbName", () => {
  const saved = process.env.DATABASE_URL;
  afterAll(() => { process.env.DATABASE_URL = saved; });

  it("يستخرج اسم القاعدة من DATABASE_URL", async () => {
    process.env.DATABASE_URL = "mysql://root:pw@127.0.0.1:3306/erp_prod";
    expect(await currentDbName()).toBe("erp_prod");
  });
  it("يعمل مع query string", async () => {
    process.env.DATABASE_URL = "mysql://root:pw@127.0.0.1:3306/erp?ssl=true";
    expect(await currentDbName()).toBe("erp");
  });
});
