// سكريبت النشر الإنتاجي على VPS — أمر واحد لكل الخطوات بالترتيب الآمن:
//   1) git pull (يجلب آخر main)
//   2) pnpm install --frozen-lockfile (تركيب اعتماديات إن تغيّرت)
//   3) pnpm db:backup (نسخة طازجة قبل أي تغيير)
//   4) pnpm db:migrate:safe (يطبّق الهجرات الجديدة فقط، يفشل إن لا نسخة طازجة)
//   5) pnpm db:verify (يتحقق من مطابقة مخطط القاعدة)
//   6) pnpm build (يبني الواجهة والخادم)
//   7) preflight لعامل الجسر المبني: imports + config + DB/identity، بلا فتح المنفذ.
//      يفشل قبل لمس العمليات الحالية إن كانت النسخة الجديدة غير قابلة للإقلاع.
//   8) pm2 reload ecosystem.config.cjs --only erp-server (إعادة تشغيل بلا إسقاط، **من الملف**)
//      ⚠️ لا تُعِدها إلى `pm2 reload erp-server`: تلك الصيغة تُعيد تحميل التعريف **المخزَّن في
//      daemon** ولا تقرأ ecosystem.config.cjs إطلاقاً ⇒ أي تعديل فيه (max_memory_restart، env،
//      kill_timeout…) يُدمَج ويُنشَر ويبدو ناجحاً بينما الإنتاج يبقى على القيمة القديمة — فشلٌ
//      صامت. (وقع فعلاً ٤/٨/٢٦: رفع السقف 512M⇒1024M كان سيصير بلا أثر؛ أمسكته مراجعة Codex.)
//   9) pm2 startOrReload ecosystem.config.cjs --only erp-hr-bridge --update-env
//      يبدأ عامل جسر الحضور المستقل لأول مرة أو يعيد تحميله في النشرات اللاحقة. يأتي **بعد**
//      erp-server عمداً: في أول انتقال قد تكون النسخة القديمة من الخادم مالكةً للمنفذ 7788؛
//      إعادة تحميلها أولاً تحرّر المنفذ قبل بدء العملية المستقلة وتمنع EADDRINUSE.
//  10) إثبات آلي مستقر: erp-hr-bridge online والمنفذ يستمع بعملية PM2 نفسها.
//  11) pm2 save (يثبّت التعريف الجديد في dump كي ينجو من resurrect عند إقلاع الخادم)
//
// عند أي فشل: يتوقّف ويُبلّغ — لا يكمل خطوة بعد فشل سابقتها.
// الاستخدام:  pnpm deploy
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import path from "node:path";
import hrBridgePolicy from "./hr-bridge-runtime-policy.cjs";

function assertDeploymentIdentity() {
  if (process.platform !== "linux") {
    console.error("⛔ DEPLOY_PLATFORM_UNSUPPORTED: النشر الإنتاجي معتمد على Linux فقط.");
    process.exit(1);
  }

  const account = userInfo();
  const expectedUser = "deploy";
  const expectedHome = path.resolve(account.homedir, ".pm2");
  const effectiveHome = path.resolve(
    process.env.PM2_HOME?.trim() || path.join(process.env.HOME || "", ".pm2"),
  );

  if (
    process.getuid?.() === 0 ||
    account.username !== expectedUser ||
    effectiveHome !== expectedHome
  ) {
    console.error("⛔ DEPLOY_IDENTITY_INVALID: النشر يجب أن يعمل بهوية deploy وPM2 الخاص بها.");
    console.error("   نفّذ من root:");
    console.error("   sudo -iu deploy bash -lc 'cd /home/deploy/erp && pnpm prod:deploy'");
    process.exit(1);
  }
}

const STEPS = [
  {
    name: "1/11 جلب آخر تغييرات (git pull)",
    cmd: "git",
    args: ["pull", "--ff-only", "origin", "main"],
    timeoutMs: 60_000,
  },
  {
    name: "2/11 تركيب الاعتماديات",
    cmd: "pnpm",
    args: ["install", "--frozen-lockfile"],
    timeoutMs: 5 * 60_000,
  },
  {
    name: "3/11 نسخة احتياطية",
    cmd: "pnpm",
    args: ["db:backup"],
    timeoutMs: 10 * 60_000,
  },
  {
    name: "4/11 تطبيق الهجرات الجديدة",
    cmd: "pnpm",
    args: ["db:migrate:safe"],
    timeoutMs: 10 * 60_000,
  },
  {
    name: "5/11 تحقّق مطابقة المخطط",
    cmd: "pnpm",
    args: ["db:verify"],
    timeoutMs: 5 * 60_000,
  },
  {
    name: "6/11 بناء الإنتاج",
    cmd: "pnpm",
    args: ["build"],
    timeoutMs: 10 * 60_000,
  },
  {
    name: "7/11 فحص إقلاع جسر الحضور قبل تبديل العمليات",
    cmd: "node",
    args: ["scripts/hr-bridge-worker.mjs", "--preflight"],
    // parent timeout يمسك حتى event-loop hard block لا يستطيع watchdog الداخلي قطعه.
    timeoutMs: hrBridgePolicy.startupTimeoutMs + 10_000,
  },
  // من الملف لا من التعريف المخزَّن — راجع التحذير في الرأس.
  {
    name: "8/11 إعادة تشغيل الخادم من ecosystem (PM2)",
    cmd: "pm2",
    args: [
      "reload",
      "ecosystem.config.cjs",
      "--only",
      "erp-server",
      "--update-env",
    ],
    timeoutMs: 2 * 60_000,
  },
  {
    name: "9/11 تشغيل أو إعادة تحميل جسر الحضور المستقل (PM2)",
    cmd: "pm2",
    args: [
      "startOrReload",
      "ecosystem.config.cjs",
      "--only",
      "erp-hr-bridge",
      "--update-env",
    ],
    timeoutMs: hrBridgePolicy.pm2ListenTimeoutMs + 15_000,
  },
  {
    name: "10/11 إثبات جاهزية مستقرة لجسر الحضور (PM2 + منفذ TCP)",
    cmd: "node",
    args: ["scripts/verify-hr-bridge-runtime.mjs"],
    timeoutMs: hrBridgePolicy.runtimeGateTimeoutMs + 10_000,
  },
  // بلا save يعود dump القديم (بسقفه القديم) عند أول resurrect/إقلاع.
  {
    name: "11/11 تثبيت تعريف PM2 (save)",
    cmd: "pm2",
    args: ["save"],
    timeoutMs: 30_000,
  },
];

assertDeploymentIdentity();
console.log("🚀 نشر إنتاجي — بداية");
const t0 = Date.now();

for (const step of STEPS) {
  console.log(`\n▶ ${step.name}…`);
  try {
    execFileSync(step.cmd, step.args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      timeout: step.timeoutMs,
    });
  } catch {
    console.error(`\n⛔ فشل: «${step.name}» — توقّفت الخطوات اللاحقة.`);
    console.error(
      "   راجع السبب أعلاه؛ لم تُنفّذ الخطوات اللاحقة ولم يُنفّذ pm2 save.",
    );
    console.error(
      "   لا تنفّذ db:restore تلقائياً؛ الاستعادة فقط بعد إثبات تلف بيانات وقرار موثّق.",
    );
    process.exit(1);
  }
}

const dt = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n✓ نشر مكتمل بنجاح في ${dt} ثانية.`);
console.log(
  "   تحقّق الويب: curl -sf https://srv1548487.hstgr.cloud/api/print/status || pm2 logs erp-server --lines 20",
);
console.log("   الجسر: تم إثبات حالة PM2 والمنفذ تلقائياً قبل pm2 save.");
