// سكريبت النشر الإنتاجي على VPS — أمر واحد لكل الخطوات بالترتيب الآمن:
//   1) git pull (يجلب آخر main)
//   2) pnpm install --frozen-lockfile (تركيب اعتماديات إن تغيّرت)
//   3) pnpm db:backup (نسخة طازجة قبل أي تغيير)
//   4) pnpm db:migrate:safe (يطبّق الهجرات الجديدة فقط، يفشل إن لا نسخة طازجة)
//   5) pnpm build (يبني الواجهة والخادم)
//   6) pm2 reload ecosystem.config.cjs --only erp-server (إعادة تشغيل بلا إسقاط، **من الملف**)
//      ⚠️ لا تُعِدها إلى `pm2 reload erp-server`: تلك الصيغة تُعيد تحميل التعريف **المخزَّن في
//      daemon** ولا تقرأ ecosystem.config.cjs إطلاقاً ⇒ أي تعديل فيه (max_memory_restart، env،
//      kill_timeout…) يُدمَج ويُنشَر ويبدو ناجحاً بينما الإنتاج يبقى على القيمة القديمة — فشلٌ
//      صامت. (وقع فعلاً ٤/٨/٢٦: رفع السقف 512M⇒1024M كان سيصير بلا أثر؛ أمسكته مراجعة Codex.)
//   7) pm2 save (يثبّت التعريف الجديد في dump كي ينجو من resurrect عند إقلاع الخادم)
//
// عند أي فشل: يتوقّف ويُبلّغ — لا يكمل خطوة بعد فشل سابقتها.
// الاستخدام:  pnpm deploy
import { execFileSync } from "node:child_process";

const STEPS = [
  { name: "1/8 جلب آخر تغييرات (git pull)", cmd: "git", args: ["pull", "--ff-only", "origin", "main"] },
  { name: "2/8 تركيب الاعتماديات", cmd: "pnpm", args: ["install", "--frozen-lockfile"] },
  { name: "3/8 نسخة احتياطية", cmd: "pnpm", args: ["db:backup"] },
  { name: "4/8 تطبيق الهجرات الجديدة", cmd: "pnpm", args: ["db:migrate:safe"] },
  { name: "5/8 تحقّق مطابقة المخطط", cmd: "pnpm", args: ["db:verify"] },
  { name: "6/8 بناء الإنتاج", cmd: "pnpm", args: ["build"] },
  // من الملف لا من التعريف المخزَّن — راجع التحذير في الرأس.
  {
    name: "7/8 إعادة تشغيل الخادم من ecosystem (PM2)",
    cmd: "pm2",
    args: ["reload", "ecosystem.config.cjs", "--only", "erp-server"],
  },
  // بلا save يعود dump القديم (بسقفه القديم) عند أول resurrect/إقلاع.
  { name: "8/8 تثبيت تعريف PM2 (save)", cmd: "pm2", args: ["save"] },
];

console.log("🚀 نشر إنتاجي — بداية");
const t0 = Date.now();

for (const step of STEPS) {
  console.log(`\n▶ ${step.name}…`);
  try {
    execFileSync(step.cmd, step.args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
  } catch {
    console.error(`\n⛔ فشل: «${step.name}» — توقّفت الخطوات اللاحقة.`);
    console.error("   تشخيص: راجع الناتج أعلاه. الخادم القديم لا يزال يعمل (لم نُعِد التشغيل بعد).");
    console.error("   استعادة: pnpm db:restore <أحدث-نسخة>  إن لزم.");
    process.exit(1);
  }
}

const dt = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n✓ نشر مكتمل بنجاح في ${dt} ثانية.`);
console.log("   تحقّق: curl -sf https://srv1548487.hstgr.cloud/api/print/status || pm2 logs erp-server --lines 20");
