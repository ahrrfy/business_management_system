/**
 * **قفلُ نيّة جسر الحضور: الإقصاء المتبادل تحت الكتابة الجزئية** (٢٠/٨).
 *
 * `verifyConcurrentIntentLock` كان يسقط **متقطّعاً تحت الحِمل** فيوقف `pnpm prod:deploy`
 * (يعمل في ذيل `pnpm build`): رُصد مرّتين على CI ومرّةً على خادم الإنتاج، وفي كلّ مرّة
 * `[1,1]` بدل `[0,0]` — أي أنّ **الطفلَين معاً** رميا خطأً غير متوقَّع.
 *
 * **الجذر** (ليس سباقَ فوزٍ مزدوج كما بدا أوّلاً): `writeIntentRecord` في مسار الإنشاء يفتح
 * الملفّ بـ`wx` ثمّ يكتب ثمّ يُزامن ثمّ يُغلق — فيبقى الملفُّ **فارغاً** في تلك النافذة.
 * وقارئٌ متزامن يقرؤه فيفشل `JSON.parse("")` ⇒ `HR_BRIDGE_LOCK_INTENT_INVALID`، وهو خطأٌ
 * **بلا `code`** فلا يتخطّاه `liveIntentRecords` (يتخطّى `ENOENT` وحده) بل يُعيد رميَه ⇒
 * يخرج من `acquireRuntimeIntentLock` غيرَ رمزِ الانشغال ⇒ الطفل يسقط. ولأنّه يقع على
 * الطرفين بالتناظر تكون النتيجة `[1,1]`. والنافذةُ ميكروثانيةٌ عادةً وتتّسع تحت الحِمل —
 * ولهذا يمرّ منفرداً ويسقط بعد بناءٍ ثقيل.
 *
 * ⛔ **ولا يُضعَّف التحقّق**: الإقصاء المتبادل يحرس نشرَ الجسر فعلاً. المطلوب أن يصير
 * الإنشاءُ **ذرّياً** (كتابةٌ مؤقّتة ثمّ `rename`) فلا يرى قارئٌ ملفاً نصفَ مكتوب أصلاً.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const TOOLS = join(process.cwd(), "scripts/hr-bridge-release.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tools = require_(TOOLS) as {
  acquireRuntimeIntentLock: (root: string, ns: string) => () => void;
};

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "intentlock-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("قفل نيّة جسر الحضور", () => {
  it("يُقصي فعلاً: الثاني يرى الأوّل مشغولاً", () => {
    const unlock = tools.acquireRuntimeIntentLock(root, "sync");
    expect(() => tools.acquireRuntimeIntentLock(root, "sync"))
      .toThrowError(/HR_BRIDGE_DEPLOY_SYNC_ALREADY_RUNNING/);
    unlock();
    // وبعد التحرير يُتاح ثانيةً — القفل ليس بابَ مسدود.
    tools.acquireRuntimeIntentLock(root, "sync")();
  });

  it("⭐ الإنشاء ذرّيّ: لا يُرى اسمٌ نهائيٌّ بمحتوىً ناقص", { timeout: 120_000 }, async () => {
    // **الثابتُ الحاكم**: لا لحظةَ يوجد فيها ملفُّ سجلٍّ بالاسم النهائيّ وهو فارغٌ أو غيرُ
    // قابلٍ للتحليل. قبل الإصلاح كان الإنشاء يفتح الاسم النهائيّ بـ`wx` ثمّ يكتب لاحقاً،
    // فيمرّ الملفّ بحالةٍ فارغة — وقارئٌ متزامن يقرؤها فيرمي `HR_BRIDGE_LOCK_INTENT_INVALID`
    // (خطأٌ بلا `code` فلا يتخطّاه الماسح) ⇒ يسقط المُدّعي بدل أن يُحجب، وبالتناظر يسقط
    // الطرفان معاً — وهو `[1,1]` الذي أوقف النشر.
    //
    // ⚠️ **مرصدٌ احتماليّ بحكم طبيعته**: يستطيع أن يُثبت وجودَ العطب ولا يستطيع نفيَه في
    // تشغيلةٍ واحدة (النافذة ميكروثانيةٌ على آلةٍ خالية). لكنّه **لا يُنذر كذباً أبداً**:
    // على الشيفرة الصحيحة لا يوجد ما يُرصَد أصلاً.
    const dir = join(root, ".runtime", "hr-bridge", "sync-locks");
    mkdirSync(dir, { recursive: true });
    let sawPartial: string | null = null;
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        for (const name of readdirSync(dir)) {
          if (!/^\d+-[0-9a-f-]{36}\.json$/i.test(name)) continue;
          try {
            const raw = readFileSync(join(dir, name), "utf8");
            if (raw.trim() === "") {
              // **قراءةُ تأكيدٍ**: على NTFS قد تُرى مدخلةٌ بطول صفرٍ لحظةَ إنشاء الرابط
              // الصلب رغم ذرّية العملية. الفراغُ الحقيقيّ يدوم؛ والأثرُ العابر يختفي.
              const again = readFileSync(join(dir, name), "utf8");
              if (again.trim() === "") { sawPartial = name; watching = false; }
            } else JSON.parse(raw);
          } catch (e) {
            // ENOENT/EPERM/EBUSY أخطاءٌ **عابرة** لا دليلَ فيها على محتوىً ناقص: الملفّ
            // يُنشأ أو يُحذف لحظةَ القراءة. وويندوز يردّ EPERM على مشاركة الملفّ أثناء
            // `link`/`unlink` — وهي بالضبط ما كان يجعل هذا المرصد يُنذر كذباً على شيفرةٍ
            // سليمة (أُمسك بتشخيصٍ مباشر: الحالةُ الملتقطة كانت EPERM لا فراغاً).
            const code = (e as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "EPERM" || code === "EBUSY") continue;
            sawPartial = `${name}: ${(e as Error).message}`; watching = false;
          }
        }
        await new Promise((r) => setImmediate(r));
      }
    })();

    const child = String.raw`
const tools = require(process.argv[1]);
for (let i = 0; i < 40; i++) {
  try { tools.acquireRuntimeIntentLock(process.argv[3], "sync")(); } catch {}
}`;
    await new Promise<void>((res) => {
      const k = spawn(process.execPath, ["-e", child, TOOLS, "x", root], { stdio: "ignore" });
      k.once("exit", () => res());
    });
    watching = false;
    await watcher;
    expect(sawPartial).toBeNull();
  });

  it("⭐⭐ اختفاءُ سجلٍّ تحت القارئ ليس فساداً — السببُ الثاني، بإثباتٍ حتميّ", () => {
    // **السببُ الثاني لسقوط `verifyConcurrentIntentLock`** (٢١/٨) — غيرُ الأوّل تماماً:
    // الأوّلُ كان ملفاً **فارغاً** يُقرأ أثناء إنشائه (أُغلق بالكتابة الذرّية)؛ وهذا ملفٌّ
    // **يختفي** بين `lstatSync` و`readFileSync`. كان `readIntentRecord` يضع القراءة
    // و`JSON.parse` في `try` واحدٍ بـ`catch` عارٍ ⇒ يبتلع `errno` ويرمي
    // `HR_BRIDGE_LOCK_INTENT_INVALID` بلا `code` ⇒ `liveIntentRecords` (يتخطّى `ENOENT`
    // وحده) يُعيد رميَه ⇒ يخرج من `acquireRuntimeIntentLock` غيرَ رمز الانشغال فيسقط
    // المُدّعي.
    //
    // ومن يُنشئ هذا الاختفاء؟ `liveIntentRecords` نفسها: تحذف سجلَّ عمليةٍ ميّتة. وفاحصُ
    // النشر **يبذر سجلاً ميّتاً عمداً** (pid 2147483647) ⇒ المُدّعيان يتسابقان على حذفه،
    // فيحذفه أحدُهما بينما الآخرُ بين `lstat` و`read`. وقد أُعيد إنتاجُه فعلاً تحت الحِمل
    // والملفُّ المُختفي كان ذلك السجلَّ المبذور بعينه.
    //
    // ⚠️ **`[1,1]` ليس تناظرياً هنا** (بخلاف السبب الأوّل): يُصيب مُدّعياً واحداً، ثمّ يموت
    // الآخرُ — وهو الفائزُ الشرعيّ — بمهلته لأنّه ينتظر إشارةً من قتيلٍ لن يُرسلها.
    //
    // ⭐ الاختبارُ **حتميّ**: يفتح النافذةَ عمداً بدل انتظار السباق (درس
    // [[hr-bridge-lock-flake-2026-08-20]]: لا تعتمد اختبارَ تزامنٍ حتى تُعيد العطب).
    const directory = join(root, ".runtime", "hr-bridge", "sync-locks");
    mkdirSync(directory, { recursive: true });
    // جارٌ صحيحٌ تماماً لعمليةٍ **حيّة** ⇒ لا يُنظَّف كميّت؛ اختفاؤه سببُه المنافسُ وحده.
    const token = "11111111-1111-4111-8111-111111111111";
    const neighbour = join(directory, `${process.pid}-${token}.json`);
    writeFileSync(
      neighbour,
      `${JSON.stringify({
        version: 1,
        namespace: "sync",
        token,
        createdNs: "1",
        held: true,
        pids: [process.pid],
      })}
`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );

    const realRead = fs.readFileSync;
    let fired = false;
    // النافذةُ بالضبط حيث يقع السباق: بعد `lstat`، قبل أن تقرأ `readFileSync` فعلاً.
    (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = ((
      target: Parameters<typeof fs.readFileSync>[0],
      ...rest: unknown[]
    ) => {
      if (!fired && target === neighbour) {
        fired = true;
        rmSync(neighbour, { force: true });
      }
      return (realRead as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.readFileSync;

    try {
      // قبل الإصلاح: يرمي `HR_BRIDGE_LOCK_INTENT_INVALID`. بعده: يمرّ — الجارُ اختفى فلا مانع.
      const unlock = tools.acquireRuntimeIntentLock(root, "sync");
      unlock();
      expect(fired).toBe(true);
    } finally {
      (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = realRead;
    }
  });

  it("⭐⭐⭐ غيابٌ وهميٌّ لمنافسٍ حيّ لا يمنح القفل — السببُ الثالث: فائزان معاً", () => {
    // **أخطرُ الثلاثة**: ليس خطأً يُسقط النشر بل **قفلٌ يُمنَح لاثنين**.
    //
    // الماسحُ يتخطّى `ENOENT` بحجّة «لا اسمَ ⇒ لا منافس». صحيحٌ على POSIX حيث
    // `rename(2)` ذرّية؛ وخطأٌ على ويندوز حيث `MoveFileEx(REPLACE_EXISTING)` قد يكشف
    // غياباً وجيزاً للوجهة — وكلُّ مُدّعٍ يُنفّذ استبدالاً واحداً (كتابة `held:true`).
    //
    // مرّةٌ واحدة لا تكفي: الطورُ الثاني (التثبّت بعد `intentWait`) يمسكها. فلزم غيابٌ في
    // **الطورَين معاً** — وهو ما رُصد فعلاً على ويندوز مرّتين: الفاحصُ يسقط بـ`EEXIST`
    // على ملفّ `winner` لأنّ الطفلَين كليهما ظفرا بالقفل.
    //
    // ⚠️ لينكس (الإنتاج وCI) **غيرُ متأثّر** — ولذلك لم يظهر هذا التوقيعُ في سقوط النشر.
    const directory = join(root, ".runtime", "hr-bridge", "sync-locks");
    mkdirSync(directory, { recursive: true });
    const token = "33333333-3333-4333-8333-333333333333";
    // منافسٌ **حيٌّ ومحتجِزٌ فعلاً**: الجوابُ الصحيح الوحيد هو «مشغول».
    const rival = join(directory, `${process.pid}-${token}.json`);
    writeFileSync(
      rival,
      `${JSON.stringify({
        version: 1,
        namespace: "sync",
        token,
        createdNs: "1",
        held: true,
        pids: [process.pid],
      })}
`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    // ⭐ الحقنُ عند `lstatSync` عمداً — هو أوّلُ ما تمسّه مدخلةٌ غائبة، وهو المسارُ الذي
    // كان يُنتج العطبَ على `main`: `ENOENT` منه يخرج بـ`code` سليمٍ فيُتخطّى **بصمت**.
    // (الحقنُ عند `readFileSync` كان يُخفي العطبَ خلف السبب الثاني بدل أن يُظهره.)
    const realStat = fs.lstatSync;
    let fired = 0;
    (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = ((
      target: Parameters<typeof fs.lstatSync>[0],
      ...rest: unknown[]
    ) => {
      // غيابٌ **وهميّ**: الملفّ باقٍ على القرص والمدخلةُ وحدها ترتدّ — تماماً كنافذة
      // الاستبدال على ويندوز. مرّتان = الطورُ الأوّل والثاني.
      if (fired < 2 && target === rival) {
        fired += 1;
        const error = new Error(`ENOENT: no such file or directory, lstat '${rival}'`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return (realStat as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.lstatSync;
    try {
      expect(() => tools.acquireRuntimeIntentLock(root, "sync"))
        .toThrowError(/HR_BRIDGE_DEPLOY_SYNC_ALREADY_RUNNING/);
      expect(fired).toBe(2);
      expect(existsSync(rival)).toBe(true);
    } finally {
      (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = realStat;
    }
  });

  it("⭐ pid لا نملك إشارته يُعدّ حيّاً لا عطباً", () => {
    // `process.kill(pid, 0)` يردّ `EPERM` حين تكون العمليةُ **قائمة** لمستخدمٍ آخر (pid
    // أُعيد تدويره إلى عمليةِ root مثلاً). رميُه كان يُخرج خطأً غيرَ رمز الانشغال فيسقط
    // النشر؛ والصوابُ اعتبارُها حيّة — أسوأُ ذلك انتظارٌ زائد، وأسوأُ نقيضِه حذفُ قفلِ مالكٍ حيّ.
    const directory = join(root, ".runtime", "hr-bridge", "deploy-locks");
    mkdirSync(directory, { recursive: true });
    const token = "22222222-2222-4222-8222-222222222222";
    const foreignPid = 424242;
    writeFileSync(
      join(directory, `${foreignPid}-${token}.json`),
      `${JSON.stringify({
        version: 1,
        namespace: "deploy",
        token,
        createdNs: "1",
        held: true,
        pids: [foreignPid],
      })}
`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    const realKill = process.kill;
    (process as unknown as { kill: typeof process.kill }).kill = ((
      pid: number,
      signal?: string | number,
    ) => {
      if (pid === foreignPid) {
        const error = new Error("EPERM") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return (realKill as (...args: unknown[]) => boolean)(pid, signal);
    }) as typeof process.kill;
    try {
      // حيٌّ ومحتجِزٌ ⇒ الرمزُ المتوقَّع هو **الانشغال**، لا خطأٌ عامّ يُسقط النشر.
      expect(() => tools.acquireRuntimeIntentLock(root, "deploy"))
        .toThrowError(/HR_BRIDGE_DEPLOY_ALREADY_RUNNING/);
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = realKill;
    }
  });

  it("⭐ سباقٌ حقيقيّ بعمليّتين: فائزٌ واحدٌ ومحجوبٌ واحد", { timeout: 180_000 }, () => {
    // نفس سيناريو `verifyConcurrentIntentLock` — الحارسُ الذي يسقط في النشر.
    const out = execFileSync(process.execPath, [
      join(process.cwd(), "scripts/verify-hr-bridge-deployment.mjs"),
    ], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/hr bridge deployment selftest/);
  });
});
