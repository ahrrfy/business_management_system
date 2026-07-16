/**
 * تطهير صفوف auditLogs المسمومة بصور base64 (عطل «Out of sort memory»، ١٤–١٦/٧).
 *
 * **العطل:** `store.banner.update` كان يمرّر مدخله كاملاً إلى `logAudit` وفيه data-URL بحجم
 * ميغابايتات. و`ORDER BY id DESC` يُجبر MySQL على `filesort` يجب أن يتّسع **لأعرض صفّ** ⇒
 * صفٌّ واحدٌ مسموم يُسقط **شاشة التدقيق كلّها** (بنرُ إنتاجٍ حقيقيّ ١٫٣ م.ب = ٥٫٣× الافتراضي ٢٥٦ ك.ب).
 *
 * الكود عولج (تعقيمٌ مركزيّ في `logAudit` + جلبٌ بخطوتين في `audit.list`)، لكن **الصفوف
 * المكتوبة سلفاً تبقى**. هذا السكربت يُطهّرها في مكانها: يستبدل الصور بعلامةٍ تصف حجمها،
 * ويُبقي بقيّة الحقول (من فعل ماذا ومتى) سليمةً — **لا يحذف صفّ تدقيقٍ أبداً**.
 *
 * التشغيل:
 *   node scripts/redact-audit-images.mjs            # فحصٌ فقط (لا كتابة) — الافتراضي
 *   node scripts/redact-audit-images.mjs --apply    # التطبيق الفعليّ
 *
 * ⚠️ **تكرارٌ مقصود** لمنطق التعقيم من `server/services/auditService.ts`: هذا سكربت node عارٍ
 * يُشغَّل على الخادم حيث لا مُترجِم TypeScript. النطاق هنا أضيق (data URL + سقف) والاختبار
 * `auditRedaction.test.ts` يحرس تطابق السلوك في الحالة الحاكمة.
 */
import mysql from "mysql2/promise";
import "dotenv/config";

const APPLY = process.argv.includes("--apply");
const THRESHOLD = 8 * 1024; // نفس MAX_AUDIT_VALUE_BYTES
const DATA_URL_RE = /^data:[a-z0-9.+/-]+;base64,/i;
const MAX_STR = 1024;

// حدُّ العمق ٣٢ حاجزٌ ضدّ التداخل المَرَضيّ فقط — لا أداةَ تحجيم (ذاك عمل THRESHOLD).
// كان ٦ فبتر بياناتٍ مشروعة (variants→units→prices) — أمسكه اختبار H6. طابِق auditService.
function redactDeep(value, depth = 0, ancestors = new Set()) {
  if (typeof value === "string") {
    if (DATA_URL_RE.test(value.trimStart())) {
      return `<صورة ${Math.round(value.length / 1024)} ك.ب — محجوبة عن سجلّ التدقيق>`;
    }
    return value.length > MAX_STR ? `${value.slice(0, MAX_STR)}…<اقتُطع ${value.length - MAX_STR} حرفاً>` : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) return "<مرجعٌ دائريّ>";
  if (depth >= 32) return "<تداخلٌ مفرط>";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1, ancestors));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, depth + 1, ancestors);
    return out;
  } finally {
    ancestors.delete(value);
  }
}

function redactValue(value) {
  if (value == null) return null;
  const redacted = redactDeep(value, 0, new Set());
  const s = JSON.stringify(redacted);
  if (s && s.length > THRESHOLD) return { _truncated: true, _originalBytes: s.length, _preview: s.slice(0, 512) };
  return redacted;
}

const main = async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL غير مضبوط");
  const c = await mysql.createConnection(url);

  const [rows] = await c.query(
    `SELECT id, action, LENGTH(oldValue) oldLen, LENGTH(newValue) newLen, oldValue, newValue
       FROM auditLogs
      WHERE LENGTH(oldValue) > ? OR LENGTH(newValue) > ?
      ORDER BY id DESC`,
    [THRESHOLD, THRESHOLD]
  );

  if (!rows.length) {
    console.log("✓ لا صفوف مسمومة (لا شيء يتجاوز 8 ك.ب). الجدول نظيف.");
    await c.end();
    return;
  }

  const totalBytes = rows.reduce((s, r) => s + (r.oldLen ?? 0) + (r.newLen ?? 0), 0);
  console.log(`وُجد ${rows.length} صفّاً مسموماً — إجمالي ${(totalBytes / 1048576).toFixed(2)} م.ب`);
  const byAction = {};
  for (const r of rows) byAction[r.action] = (byAction[r.action] ?? 0) + 1;
  for (const [a, n] of Object.entries(byAction).sort((x, y) => y[1] - x[1])) console.log(`  ${a}: ${n}`);
  console.log(`  أكبر صفّ: ${(Math.max(...rows.map((r) => Math.max(r.oldLen ?? 0, r.newLen ?? 0))) / 1048576).toFixed(2)} م.ب`);

  if (!APPLY) {
    console.log("\n(فحصٌ فقط — لم يُكتب شيء. أعد التشغيل بـ--apply للتطبيق.)");
    await c.end();
    return;
  }

  let done = 0;
  let after = 0;
  for (const r of rows) {
    // mysql2 يُعيد أعمدة JSON مُحلَّلة أصلاً؛ نتحمّل النصّ أيضاً احتياطاً.
    const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);
    const oldV = redactValue(parse(r.oldValue));
    const newV = redactValue(parse(r.newValue));
    const oldS = oldV == null ? null : JSON.stringify(oldV);
    const newS = newV == null ? null : JSON.stringify(newV);
    await c.query("UPDATE auditLogs SET oldValue = ?, newValue = ? WHERE id = ?", [oldS, newS, r.id]);
    after += (oldS?.length ?? 0) + (newS?.length ?? 0);
    done++;
  }

  const [[check]] = await c.query(
    "SELECT COUNT(*) n FROM auditLogs WHERE LENGTH(oldValue) > ? OR LENGTH(newValue) > ?",
    [THRESHOLD, THRESHOLD]
  );
  console.log(`\n✓ طُهِّر ${done} صفّاً: ${(totalBytes / 1048576).toFixed(2)} م.ب ⇐ ${(after / 1024).toFixed(1)} ك.ب`);
  console.log(`✓ صفوفٌ ما زالت تتجاوز السقف: ${check.n} (يجب أن تكون صفراً)`);
  await c.end();
  if (check.n > 0) process.exitCode = 1;
};

main().catch((e) => {
  console.error("فشل التطهير:", e.message);
  process.exit(1);
});
