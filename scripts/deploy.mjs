// سكريبت النشر الإنتاجي على VPS — أمر واحد لكل الخطوات بالترتيب الآمن:
//   1) git pull (يجلب آخر main)
//   2) pnpm install --frozen-lockfile (تركيب اعتماديات إن تغيّرت)
//   3) pnpm db:backup (نسخة طازجة قبل أي تغيير)
//   4) pnpm db:migrate:safe (يطبّق الهجرات الجديدة فقط، يفشل إن لا نسخة طازجة)
//   5) pnpm build (يبني الواجهة والخادم)
//   6) pm2 reload erp-server (يعيد التشغيل بدون إسقاط)
//
// عند أي فشل: يتوقّف ويُبلّغ — لا يكمل خطوة بعد فشل سابقتها.
// الاستخدام:  pnpm deploy
import { execFileSync } from "node:child_process";

const STEPS = [
  { name: "1/6 جلب آخر تغييرات (git pull)", cmd: "git", args: ["pull", "--ff-only", "origin", "main"] },
  { name: "2/6 تركيب الاعتماديات", cmd: "pnpm", args: ["install", "--frozen-lockfile"] },
  { name: "3/6 نسخة احتياطية", cmd: "pnpm", args: ["db:backup"] },
  { name: "4/6 تطبيق الهجرات الجديدة", cmd: "pnpm", args: ["db:migrate:safe"] },
  { name: "5/6 بناء الإنتاج", cmd: "pnpm", args: ["build"] },
  { name: "6/6 إعادة تشغيل الخادم (PM2)", cmd: "pm2", args: ["reload", "erp-server"] },
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
