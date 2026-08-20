// اختبار السباق الحقيقي لحجز رقم الهجرة: عدّة **عمليات نظامٍ** تطلب رقماً في آنٍ واحد ⇒ يجب أن
// يخرج كلٌّ منها برقمٍ **مختلف**، وأن تكون الأرقام متتابعةً بلا ثقوب ولا تكرار.
//
// لماذا عمليات لا دوالّ داخل عملية واحدة: العلّة الأصلية بين **جلسات** منفصلة (وأحياناً محرّكات
// مختلفة: Claude وCodex). اختبارٌ داخل عملية واحدة يُثبت المنطق ولا يُثبت الذرّية.
//
// الحالة المُحاكاة هي بالضبط ما وقع في ٢٠/٨/٢٦: فرعان طلبا الرقم نفسه فحصلا عليه، ثمّ ظهر
// التصادم عند الدمج. مع الحجز الذرّي يستحيل ذلك.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { reserveNextMigration, readAllMigrationReservations, MIGRATION_WHEN_STEP } from "./coord-core.mjs";

const self = fileURLToPath(import.meta.url);
const childIdx = process.argv.indexOf("--child");

// أرضيةٌ ثابتة تُمرَّر صراحةً كي لا يعتمد الاختبار على origin/main (يعمل في CI بعمق ١).
const CEIL = { idx: 238, when: 1788052289000 };

if (childIdx >= 0) {
  const id = process.argv[childIdx + 1];
  const root = process.env.RACE_ROOT;
  const res = reserveNextMigration(
    root,
    { slug: `child_${id}`, branch: `session/${id}`, worktree: `/wt/${id}`, sessionKey: `s-${id}` },
    { ceiling: CEIL },
  );
  process.stdout.write(res.ok ? `OK:${res.record.idx}:${res.record.when}` : `ERR:${res.code}`);
  process.exit(0);
} else {
  const root = path.join(os.tmpdir(), `coordmig-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const K = 12;
  const run = (i) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [self, "--child", String(i)], {
        env: { ...process.env, RACE_ROOT: root },
      });
      let buf = "";
      p.stdout.on("data", (d) => (buf += d));
      p.on("close", () => resolve(buf.trim()));
    });

  try {
    const results = await Promise.all(Array.from({ length: K }, (_, i) => run(i)));
    const oks = results.filter((r) => r.startsWith("OK:"));
    const idxs = oks.map((r) => Number(r.split(":")[1]));
    const whens = oks.map((r) => Number(r.split(":")[2]));

    console.log(`  ${K} عملية متزامنة ⇒ نجح ${oks.length} · أرقام: ${idxs.slice().sort((a, b) => a - b).join(", ")}`);

    if (oks.length !== K) {
      console.error(`✗ فشل: نجح ${oks.length} من ${K} (${results.filter((r) => !r.startsWith("OK:")).join(", ")})`);
      process.exit(1);
    }
    // ① لا تكرار — جوهر الاختبار: هذا ما كان يفشل قبل الحجز الذرّي.
    if (new Set(idxs).size !== K) {
      console.error(`✗ فشل: رقمٌ مكرَّر — ${idxs.sort((a, b) => a - b).join(", ")}`);
      process.exit(1);
    }
    if (new Set(whens).size !== K) {
      console.error(`✗ فشل: طابعٌ مكرَّر — ${whens.sort((a, b) => a - b).join(", ")}`);
      process.exit(1);
    }
    // ② كلّها فوق الأرضية (وإلّا تُتخطّى صامتاً على قاعدةٍ طبّقت الأرضية).
    if (Math.min(...idxs) <= CEIL.idx || Math.min(...whens) <= CEIL.when) {
      console.error(`✗ فشل: رقمٌ أو طابعٌ لا يتجاوز أرضية main`);
      process.exit(1);
    }
    // ③ متتابعة بلا ثقوب — يُثبت أنّ EEXIST أدّى إلى انتقالٍ للتالي لا إلى قفزة.
    const sorted = idxs.slice().sort((a, b) => a - b);
    for (let i = 0; i < K; i++) {
      if (sorted[i] !== CEIL.idx + i + 1) {
        console.error(`✗ فشل: ثقبٌ في التتابع عند ${sorted[i]} (المتوقّع ${CEIL.idx + i + 1})`);
        process.exit(1);
      }
    }
    // ④ ترتيب idx يوافق ترتيب when — الثابت الذي يمنع التخطّي الصامت.
    const pairs = oks.map((r) => ({ idx: Number(r.split(":")[1]), when: Number(r.split(":")[2]) }))
      .sort((a, b) => a.idx - b.idx);
    for (let i = 1; i < pairs.length; i++) {
      if (pairs[i].when <= pairs[i - 1].when) {
        console.error(`✗ فشل: when لا يتصاعد مع idx عند ${pairs[i].idx}`);
        process.exit(1);
      }
      if (pairs[i].when - pairs[i - 1].when !== MIGRATION_WHEN_STEP) {
        console.error(`✗ فشل: خطوة when ليست ${MIGRATION_WHEN_STEP} عند ${pairs[i].idx}`);
        process.exit(1);
      }
    }
    // ⑤ السجلّ على القرص يطابق ما أُعيد (لا حجزٌ ضائع ولا شبح).
    const onDisk = readAllMigrationReservations(root);
    if (onDisk.length !== K) {
      console.error(`✗ فشل: ${onDisk.length} حجزاً على القرص (يجب ${K})`);
      process.exit(1);
    }
    console.log("✓ الحجز الذرّي لرقم الهجرة: صفر تكرار · فوق أرضية main · متتابع · when متصاعد.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
