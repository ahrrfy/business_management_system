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
const THRESHOLD = 8 * 1024; // بايتات — نفس MAX_AUDIT_VALUE_BYTES وبنفس وحدة `LENGTH()` في SQL
const BATCH = 25; // صفوف لكل دفعة: صفٌّ مسموم قد يبلغ ميغابايتات ⇒ لا نُحمّلها كلّها معاً
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
    // كائنٌ يُسلسِل نفسه (Date…) ⇒ خُذ تمثيله؛ وإلّا فرّغه Object.entries إلى {} — طابِق auditService.
    if (typeof value.toJSON === "function") return redactDeep(value.toJSON(), depth + 1, ancestors);
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
  // بالبايتات لا بالأحرف — نفس وحدة `LENGTH()` في SQL (العربية حرفان لكل حرف).
  if (s && Buffer.byteLength(s, "utf8") > THRESHOLD) {
    return { _truncated: true, _originalBytes: Buffer.byteLength(s, "utf8"), _preview: s.slice(0, 512) };
  }
  return redacted;
}

const mb = (n) => (n / 1048576).toFixed(2);

const main = async () => {
  /**
   * وضع تعدّد الشركات: كل شركة قاعدةٌ منفصلة تُوجَّه عبر `ensureTenantDb`، و`DATABASE_URL` وحده
   * لا يمثّلها. التطهير الجزئيّ **أسوأ من عدمه**: يُبلغ «نظيف» بينما تبقى شاشة التدقيق مكسورة
   * عند كل شركةٍ أخرى. نرفض بصوتٍ عالٍ بدل أن ننجح كذباً (الوضع معطَّل على النشر الحالي).
   */
  if (process.env.CONTROL_DATABASE_URL) {
    console.error(
      "⛔ وضع تعدّد الشركات مُفعَّل (CONTROL_DATABASE_URL).\n" +
        "   هذا السكربت يُطهّر DATABASE_URL وحدها ⇒ ستبقى قواعد الشركات الأخرى مسمومة بصمت.\n" +
        "   شغّله لكل شركة بـDATABASE_URL الخاصّ بها (نمط db:backup:all-companies)."
    );
    process.exit(2);
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL غير مضبوط");
  const c = await mysql.createConnection(url);

  // المسح الأوّليّ يقرأ **الأطوال فقط** لا القيم: صفوفٌ بميغابايتات لا تُحمَّل في الذاكرة إطلاقاً.
  const [meta] = await c.query(
    `SELECT id, action, COALESCE(LENGTH(oldValue),0) oldLen, COALESCE(LENGTH(newValue),0) newLen
       FROM auditLogs
      WHERE LENGTH(oldValue) > ? OR LENGTH(newValue) > ?
      ORDER BY id DESC`,
    [THRESHOLD, THRESHOLD]
  );

  if (!meta.length) {
    console.log(`✓ لا صفوف مسمومة (لا شيء يتجاوز ${THRESHOLD / 1024} ك.ب). الجدول نظيف.`);
    await c.end();
    return;
  }

  const totalBytes = meta.reduce((s, r) => s + r.oldLen + r.newLen, 0);
  console.log(`وُجد ${meta.length} صفّاً مسموماً — إجمالي ${mb(totalBytes)} م.ب`);
  const byAction = {};
  for (const r of meta) byAction[r.action] = (byAction[r.action] ?? 0) + 1;
  for (const [a, n] of Object.entries(byAction).sort((x, y) => y[1] - x[1])) console.log(`  ${a}: ${n}`);
  console.log(`  أكبر صفّ: ${mb(Math.max(...meta.map((r) => Math.max(r.oldLen, r.newLen))))} م.ب`);

  if (!APPLY) {
    console.log("\n(فحصٌ فقط — لم يُكتب شيء. أعد التشغيل بـ--apply للتطبيق.)");
    await c.end();
    return;
  }

  // دفعاتٌ محدودة بمعرّفاتٍ معروفة سلفاً: يمنع نفاد الذاكرة، ويضمن التقدّم حتى لو تعذّر
  // تصغير صفٍّ ما (لا حلقة «أعِد المسح» التي قد لا تتقارب أبداً).
  const ids = meta.map((r) => r.id);
  let done = 0;
  let after = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const [rows] = await c.query(`SELECT id, oldValue, newValue FROM auditLogs WHERE id IN (${chunk.map(() => "?").join(",")})`, chunk);
    for (const r of rows) {
      // mysql2 يُعيد أعمدة JSON مُحلَّلة أصلاً؛ نتحمّل النصّ أيضاً احتياطاً.
      const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);
      const oldS = r.oldValue == null ? null : JSON.stringify(redactValue(parse(r.oldValue)));
      const newS = r.newValue == null ? null : JSON.stringify(redactValue(parse(r.newValue)));
      await c.query("UPDATE auditLogs SET oldValue = ?, newValue = ? WHERE id = ?", [oldS, newS, r.id]);
      after += Buffer.byteLength(oldS ?? "", "utf8") + Buffer.byteLength(newS ?? "", "utf8");
      done++;
    }
    console.log(`  … ${Math.min(i + BATCH, ids.length)}/${ids.length}`);
  }

  const [[check]] = await c.query(
    "SELECT COUNT(*) n FROM auditLogs WHERE LENGTH(oldValue) > ? OR LENGTH(newValue) > ?",
    [THRESHOLD, THRESHOLD]
  );
  console.log(`\n✓ طُهِّر ${done} صفّاً: ${mb(totalBytes)} م.ب ⇐ ${(after / 1024).toFixed(1)} ك.ب`);
  console.log(`✓ صفوفٌ ما زالت تتجاوز السقف: ${check.n} (يجب أن تكون صفراً)`);
  await c.end();
  if (check.n > 0) process.exitCode = 1;
};

main().catch((e) => {
  console.error("فشل التطهير:", e.message);
  process.exit(1);
});
