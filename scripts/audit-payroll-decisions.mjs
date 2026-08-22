// جولةُ تحقّقٍ على بياناتٍ حقيقية لقرارات المالك الثلاثة (ق١/ق٢/ق٣) — ١٧/٨/٢٦.
//
// ⛔ **قراءة محضة**: SELECT فقط. لا INSERT ولا UPDATE ولا DELETE ولا DDL، ولا يولّد
//    مسيّراً ولا يمسّ مسيّراً قائماً. آمنٌ على الإنتاج أثناء الدوام.
//
// لماذا سكربت لا قائمة يدوية: الجولة اليدوية تفحص ما يخطر بالبال، وهذه تفحص **كل**
// الموظفين وكل الأشهر المصروفة — وتُخرج أسماءً وأرقاماً يُتصرَّف بها لا انطباعاً.
//
// الاستعمال (على الجهاز الذي يملك القاعدة):
//   node scripts/audit-payroll-decisions.mjs              # الشهر الجاري + آخر ٦ أشهر مصروفة
//   node scripts/audit-payroll-decisions.mjs 2026-08      # شهرٌ بعينه
//
// يقرأ DATABASE_URL من .env. على الـVPS:  cd ~/app && node scripts/audit-payroll-decisions.mjs
import "dotenv/config";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("⛔ DATABASE_URL غير محدّد — شغّل الأمر من جذر المشروع حيث ملف .env.");
  process.exit(1);
}

// الوسم يُقرأ من مصدره الوحيد (shared/hr.ts) لا يُكرَّر هنا: نسخةٌ ثانية تنجرف صامتةً
// فيتوقّف المدقّق عن رؤية البنود الموسومة ويُطمئن كاذباً.
const { readFileSync } = await import("node:fs");
const prefixMatch = readFileSync("shared/hr.ts", "utf8").match(
  /PAYROLL_ITEM_ATTENTION_PREFIX\s*=\s*"([^"]+)"/,
);
if (!prefixMatch) {
  console.error("⛔ تعذّر قراءة PAYROLL_ITEM_ATTENTION_PREFIX من shared/hr.ts — شغّل الأمر من جذر المشروع.");
  process.exit(1);
}
const ATTENTION_PREFIX = prefixMatch[1];

const { createConnection } = await import("mysql2/promise");
const conn = await createConnection(url);
const q = async (sql, args = []) => (await conn.execute(sql, args))[0];

const argPeriod = process.argv[2];
const now = new Date();
const thisPeriod = argPeriod ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

const iqd = (v) => Number(v ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
const line = (s = "") => console.log(s);
const head = (s) => { line(); line("─".repeat(78)); line(s); line("─".repeat(78)); };

let findings = 0;
const flag = (s) => { findings += 1; line(`  ⚑ ${s}`); };

/* ═══ ق١ — أيامٌ مفتوحة (دخولٌ بلا انصراف): ساعاتٌ لن تُحتسب في المسيّر ═══════════ */
head(`ق١) أيامٌ بلا بصمة انصراف — الشهر ${thisPeriod}`);
{
  const rows = await q(
    `SELECT e.id, CONCAT_WS(' ', e.firstName, e.lastName) AS name, b.name AS branch,
            COUNT(*) AS openDays,
            GROUP_CONCAT(DATE_FORMAT(a.attendanceDate, '%Y-%m-%d') ORDER BY a.attendanceDate SEPARATOR '، ') AS dates
       FROM attendance a
       JOIN employees e ON e.id = a.employeeId
       LEFT JOIN branches b ON b.id = e.branchId
      WHERE DATE_FORMAT(a.attendanceDate, '%Y-%m') = ?
        AND a.status IN ('PRESENT','LATE')
        AND a.checkIn IS NOT NULL AND a.checkOut IS NULL
      GROUP BY e.id, name, branch
      ORDER BY openDays DESC`,
    [thisPeriod],
  );
  if (rows.length === 0) line("  ✓ لا يوم مفتوحاً — المسيّر يُولَّد بلا نقصٍ من هذا الباب.");
  for (const r of rows) {
    flag(`${r.name} (${r.branch ?? "بلا فرع"}) — ${r.openDays} يوم: ${r.dates}`);
  }
  if (rows.length) {
    line();
    line("  ⇐ صحّح بصمة الانصراف من كشف كل موظف **قبل** توليد المسيّر.");
    line("     إن وُلِّد قبل التصحيح: البند يُنشأ بساعاته المؤكَّدة موسوماً، ويُستردّ الباقي");
    line("     بحذف المسوّدة وإعادة التوليد بعد التصحيح (لا يمكن بعد الاعتماد).");
  }
}

/* ═══ ق٢ — جدولٌ صفريّ: يُقرأ غياباً ظاهراً لا صفراً صامتاً ═══════════════════════ */
head("ق٢) موظفون بجدول دوامٍ صفريّ أو غير مضبوط");
{
  const rows = await q(
    `SELECT e.id, CONCAT_WS(' ', e.firstName, e.lastName) AS name, b.name AS branch,
            e.payType, e.salary, e.attendanceExempt,
            CASE WHEN e.workSchedule IS NULL THEN 'بلا جدول (يقع على الاحتياطي ٨س)'
                 ELSE 'جدولٌ مضبوط' END AS sched
       FROM employees e
       LEFT JOIN branches b ON b.id = e.branchId
      WHERE e.isActive = 1 AND e.employmentStatus IN ('active','leave')
        AND e.payType = 'monthly' AND e.workSchedule IS NULL
      ORDER BY e.id`,
  );
  if (rows.length === 0) line("  ✓ كل موظف شهريّ نشط له جدولٌ مضبوط.");
  for (const r of rows) {
    flag(`${r.name} (${r.branch ?? "بلا فرع"}) — ${r.sched}${r.attendanceExempt ? " · معفى من الحضور" : ""}`);
  }
  if (rows.length) {
    line();
    line("  ⇐ الاحتياطي ٨ ساعات والجمعة راحة. إن خالف دوامَه الفعليّ فأجرُه يُحتسب خطأً.");
  }
}

/* ═══ ق٣ — الشهر المصروف مجمَّد: هل يُطابق المعروض ما دُفع فعلاً؟ ═══════════════ */
head("ق٣) الأشهر المصروفة — الرقم المعروض مقابل الرقم المدفوع");
{
  const runs = await q(
    `SELECT id, period, status, revisionNo, employeeCount, totalGross, totalNet, approvedAt, paidAt
       FROM payrollRuns
      WHERE status IN ('approved','paid')
      ORDER BY period DESC
      LIMIT 6`,
  );
  if (runs.length === 0) {
    line("  · لا مسيّر معتمد أو مدفوع بعد — التجميد بلا أثرٍ حتى الآن (سليم).");
  }
  for (const run of runs) {
    line();
    line(`  ▸ ${run.period} — ${run.status === "paid" ? "مدفوع" : "معتمد"} · ${run.employeeCount} موظف · صافٍ ${iqd(run.totalNet)} د.ع`);
    const items = await q(
      `SELECT i.employeeId, CONCAT_WS(' ', e.firstName, e.lastName) AS name,
              i.gross, i.overtime, i.commission, i.deductions, i.net, i.note,
              e.salary AS salaryNow
         FROM payrollItems i
         JOIN employees e ON e.id = i.employeeId
        WHERE i.runId = ? AND i.revisionNo = ?
        ORDER BY i.id`,
      [run.id, run.revisionNo],
    );
    line(`    لقطةُ ${items.length} بند — هي ما يعرضه الكشف والتقرير والطباعة الآن.`);

    /*
     * أثر التجميد عملياً: مَن عُدِّل سجلُّه **بعد** اعتماد الشهر. قبل ق٣ كان كشفُ ذلك الشهر
     * يُعيد الاشتقاق من السجلّ المعدَّل فيُظهر رقماً غير الذي قُبض؛ الآن يقرأ اللقطة.
     * ⚠️ `updatedAt` يتحرّك بأيّ تعديل لا بالراتب وحده — فهذه **الحدّ الأعلى** للمتأثّرين
     * لا قائمةَ انحرافاتٍ مؤكَّدة. لا يوجد في المخطّط سجلُّ تغيّرٍ للراتب يُدقَّق عليه.
     */
    const when = run.paidAt ?? run.approvedAt;
    const touched = when
      ? await q(
          `SELECT CONCAT_WS(' ', e.firstName, e.lastName) AS name, e.salary AS salaryNow, e.updatedAt
             FROM payrollItems i JOIN employees e ON e.id = i.employeeId
            WHERE i.runId = ? AND i.revisionNo = ? AND e.updatedAt > ?
            ORDER BY e.updatedAt DESC`,
          [run.id, run.revisionNo, when],
        )
      : [];
    for (const t of touched) {
      line(`      • ${t.name}: عُدِّل سجلُّه بعد الصرف (${new Date(t.updatedAt).toISOString().slice(0, 10)}) · راتبه اليوم ${iqd(t.salaryNow)} د.ع`);
    }
    if (touched.length) {
      line(`      ⇐ كشف هذا الشهر لهؤلاء صار يقرأ **لقطة المسيّر** لا سجلَّهم الحاليّ (ق٣).`);
    } else {
      line("      ✓ لا سجلَّ عُدِّل بعد الصرف — المعروض والمدفوع متطابقان أصلاً.");
    }

    // بنودٌ وُسمت بيومٍ مفتوح ثم اعتُمدت بنقصها — لا تُستردّ بعد الاعتماد.
    const flagged = items.filter((i) => String(i.note ?? "").startsWith(ATTENTION_PREFIX));
    for (const f of flagged) {
      flag(`${run.period} · ${f.name} — اعتُمد بنقصٍ: ${String(f.note).slice(0, 120)}`);
    }
  }
}

/* ═══ الخلاصة ═══════════════════════════════════════════════════════════════ */
head("الخلاصة");
if (findings === 0) {
  line("  ✓ لا بندَ يحتاج تدخّلاً. المسيّر جاهز للتوليد.");
} else {
  line(`  ⚑ ${findings} بنداً يحتاج نظرك — راجع الأسطر الموسومة أعلاه.`);
  line("    الأهمّ: أيام ق١ المفتوحة تُصحَّح **قبل** توليد مسيّر الشهر.");
}
line();

await conn.end();
