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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

  it("⭐ سباقٌ حقيقيّ بعمليّتين: فائزٌ واحدٌ ومحجوبٌ واحد", { timeout: 180_000 }, () => {
    // نفس سيناريو `verifyConcurrentIntentLock` — الحارسُ الذي يسقط في النشر.
    const out = execFileSync(process.execPath, [
      join(process.cwd(), "scripts/verify-hr-bridge-deployment.mjs"),
    ], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/hr bridge deployment selftest/);
  });
});
