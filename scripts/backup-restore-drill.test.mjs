// حرّاس تمرين الاستعادة — الجزء الذي يقتل إن أخطأ.
//
// حادثة #309 (٢٢/٧/٢٦): «اختبار استعادة» دمّر قاعدةً حيّة. لذلك تُختبَر هذه الحرّاس وحدها
// بلا قاعدة بيانات: كلٌّ منها يجب أن **يرفض** الحالة الخطرة صراحةً، لا أن يعتمد على انتباه المشغّل.
import assert from "node:assert/strict";
import test from "node:test";
import {
  DRILL_SUFFIX,
  assertDumpStaysInSandbox,
  assertPortAllowed,
  assertSafeDrillDatabase,
  pickLatestBackup,
} from "./backup-restore-drill.mjs";

test("backup restore drill guards", () => {
  // ── اسم قاعدة التمرين ──
  assert.equal(assertSafeDrillDatabase(`erp${DRILL_SUFFIX}`, ["erp"]), `erp${DRILL_SUFFIX}`);

  // اسمٌ بلا وسم = قد يكون قاعدةً حقيقية ⇒ يُرفض.
  assert.throws(() => assertSafeDrillDatabase("erp", ["erp"]), /DRILL_DB_UNMARKED/);
  assert.throws(() => assertSafeDrillDatabase("erp_prod", ["erp"]), /DRILL_DB_UNMARKED/);

  // اسمٌ موسومٌ لكنه يطابق قاعدة عملٍ حيّة (لو سُمّيت هكذا) ⇒ يُرفض.
  assert.throws(
    () => assertSafeDrillDatabase(`erp${DRILL_SUFFIX}`, ["erp", `erp${DRILL_SUFFIX}`]),
    /DRILL_DB_COLLIDES_LIVE/,
  );

  // حقن SQL عبر الاسم ⇒ يُرفض قبل بلوغ أيّ استعلام.
  assert.throws(() => assertSafeDrillDatabase("erp`; DROP DATABASE erp; --", ["erp"]), /DRILL_DB_INVALID/);
  assert.throws(() => assertSafeDrillDatabase("", ["erp"]), /DRILL_DB_INVALID/);

  // ── محتوى النسخة لا يقفز خارج الصندوق ──
  assert.equal(assertDumpStaysInSandbox("-- MySQL dump\nCREATE TABLE `x` (id int);\n"), true);
  assert.throws(() => assertDumpStaysInSandbox("CREATE DATABASE `erp`;\n"), /DUMP_ESCAPES_SANDBOX/);
  assert.throws(() => assertDumpStaysInSandbox("USE `erp`;\n"), /DUMP_ESCAPES_SANDBOX/);
  assert.throws(() => assertDumpStaysInSandbox("DROP DATABASE `erp`;\n"), /DUMP_ESCAPES_SANDBOX/);
  // ذكرُ العبارة داخل تعليقٍ أو نصّ لا يُفزع الحارس (السطر يجب أن يبدأ بها).
  assert.equal(assertDumpStaysInSandbox("-- تعليق يذكر CREATE DATABASE للتوثيق\n"), true);

  // ── المنفذ ──
  assert.equal(assertPortAllowed("3310"), true);
  assert.equal(assertPortAllowed("3307"), true);
  assert.throws(() => assertPortAllowed("3306"), /DRILL_PORT_FORBIDDEN/);

  // ── اختيار أحدث نسخة ──
  assert.equal(
    pickLatestBackup("ignored", ["erp-2026-08-01.sql", "erp-2026-08-16.sql", "notes.txt"]),
    "erp-2026-08-16.sql",
  );
  assert.equal(pickLatestBackup("ignored", ["erp-2026-08-16.sql.gpg"]), "erp-2026-08-16.sql.gpg");
  assert.equal(pickLatestBackup("ignored", ["readme.md"]), null);

  console.log("backup restore drill guards: OK");
});
