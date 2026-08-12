// اختبار وحدة لخدمة الصيانة — أمان المسار (path traversal) + تحقّق الرفع + اسم القاعدة. لا قاعدة بيانات.
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  resolveBackupFile, quarantineUploadStream, cleanupTmp, currentDbName, backupsDir,
  issueRestoreUploadTicket, normalizeRestoreFileName, verifyRestoreUploadTicket,
  consumeRestoreUploadTicket, acquireRestoreLock,
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

describe("quarantineUploadStream — تحقّق الملف المرفوع", () => {
  it("يرفض الصغير/التالف", async () => {
    await expect(quarantineUploadStream(Readable.from("tiny"), 4)).rejects.toThrow();
  });

  it("يرفض ملفاً بلا توقيع mysqldump", async () => {
    const junk = Buffer.from("x".repeat(2000));
    await expect(quarantineUploadStream(Readable.from(junk), junk.length)).rejects.toThrow();
  });

  it("يقبل دفق mysqldump ويكتبه خارج webroot دون تغيير", async () => {
    const sql = Buffer.from("-- MySQL dump 10.x\n" + "CREATE TABLE `x`(id int);\n".repeat(50));
    const tmp = await quarantineUploadStream(Readable.from([sql.subarray(0, 600), sql.subarray(600)]), sql.length);
    expect(tmp).toMatch(/erp-restore-upload-.*[\\/]upload\.sql$/);
    await expect(readFile(tmp)).resolves.toEqual(sql);
    await cleanupTmp(tmp);
  });

  it("يرفض الدفق الزائد والناقص عن الحجم المصرّح به", async () => {
    const sql = Buffer.from("-- MySQL dump\n" + "CREATE TABLE x(id int);\n".repeat(40));
    await expect(quarantineUploadStream(Readable.from(sql), sql.length - 1)).rejects.toMatchObject({ status: 413 });
    await expect(quarantineUploadStream(Readable.from(sql), sql.length + 1)).rejects.toThrow(/حجم/);
  });
});

describe("restore upload ticket", () => {
  const savedSecret = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = "unit-test-restore-ticket-secret-at-least-32-bytes"; });
  afterAll(() => {
    if (savedSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = savedSecret;
  });

  it("يرفض أسماء المسارات ويقبل اسماً بسيطاً", () => {
    expect(normalizeRestoreFileName("backup.sql")).toBe("backup.sql");
    for (const bad of ["../backup.sql", "a/b.sql", "a\\b.sql", "backup.txt", "..sql"]) {
      expect(() => normalizeRestoreFileName(bad)).toThrow();
    }
  });

  it("يوقّع الحجم والهوية والقاعدة ويتحقق منها", async () => {
    const token = await issueRestoreUploadTicket({
      userId: 7,
      sessionId: 11,
      dbName: "erp",
      fileName: "backup.sql",
      fileSize: 4096,
    });
    const verified = await verifyRestoreUploadTicket(token);
    expect(verified).toMatchObject({
      userId: 7, sessionId: 11, dbName: "erp", fileName: "backup.sql", fileSize: 4096,
    });
    expect(await consumeRestoreUploadTicket(verified!.ticketId!)).toBe(true);
    expect(await consumeRestoreUploadTicket(verified!.ticketId!)).toBe(false);
    await expect(verifyRestoreUploadTicket(`${token}x`)).resolves.toBeNull();
  });
});

describe("restore lock", () => {
  it("يمنع عمليتين متزامنتين ويُتاح مجدداً بعد تحرير المالك", async () => {
    const release = await acquireRestoreLock();
    await expect(acquireRestoreLock()).rejects.toThrow(/عملية استعادة أخرى/);
    await release();
    const releaseAgain = await acquireRestoreLock();
    await releaseAgain();
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
