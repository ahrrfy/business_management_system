/**
 * اختبارات أدوار العنقود — الثابت الحاكم: أياً كان عدد عمّال الويب، تعمل الوظائف الخلفيّة
 * (كنّاس واتساب/دفع native/كرون يوميّ/دفع صباحيّ/جسر الحضور) **في عاملٍ واحدٍ بالضبط** — لا
 * صفر (فتتعطّل) ولا أكثر من واحد (فيتكرّر الإرسال ويتضارب منفذ 7788).
 *
 * دوالّ نقيّة (بيئة فقط) — لكن تشغيل الملف يمرّ بـ__setup__.ts العالميّ (اتصال DB في afterEach).
 */
import { describe, expect, it } from "vitest";
import {
  isBackgroundJobRunner,
  isClustered,
  isMultiWorker,
} from "../clusterRole";

const env = (v: Record<string, string | undefined>) => v as NodeJS.ProcessEnv;

describe("isBackgroundJobRunner — الوظائف الخلفيّة في عاملٍ واحد", () => {
  it("العامل 0 من العنقود ⇒ نعم", () => {
    expect(isBackgroundJobRunner(env({ NODE_APP_INSTANCE: "0" }))).toBe(true);
  });

  it("عمّال العنقود 1..N-1 ⇒ لا (منع التكرار)", () => {
    expect(isBackgroundJobRunner(env({ NODE_APP_INSTANCE: "1" }))).toBe(false);
    expect(isBackgroundJobRunner(env({ NODE_APP_INSTANCE: "3" }))).toBe(false);
    expect(isBackgroundJobRunner(env({ NODE_APP_INSTANCE: "15" }))).toBe(false);
  });

  it("عملية fork وحيدة (لا NODE_APP_INSTANCE) ⇒ نعم (التطوير/العملية الواحدة)", () => {
    expect(isBackgroundJobRunner(env({}))).toBe(true);
  });

  it("الثابت الحاسم: عبر عنقودٍ من N عمّال ⇒ عاملٌ واحدٌ بالضبط يُشغّلها", () => {
    for (const n of [1, 2, 4, 8, 16]) {
      const runners = Array.from({ length: n }, (_, i) =>
        isBackgroundJobRunner(env({ NODE_APP_INSTANCE: String(i) })),
      ).filter(Boolean);
      expect(runners.length).toBe(1);
    }
  });
});

describe("isClustered — تمييز وضع العنقود من fork", () => {
  it("NODE_APP_INSTANCE مضبوط ⇒ عنقود", () => {
    expect(isClustered(env({ NODE_APP_INSTANCE: "0" }))).toBe(true);
    expect(isClustered(env({ NODE_APP_INSTANCE: "2" }))).toBe(true);
  });

  it("غير مضبوط ⇒ fork (عملية وحيدة)", () => {
    expect(isClustered(env({}))).toBe(false);
  });
});

describe("isMultiWorker — حجب المفردات ذات الحالة الحيّة (جسر الحضور)", () => {
  it("WEB_INSTANCES=1 أو غياب ⇒ عاملٌ واحد (الجسر يعمل)", () => {
    expect(isMultiWorker(env({ WEB_INSTANCES: "1" }))).toBe(false);
    expect(isMultiWorker(env({}))).toBe(false);
    expect(isMultiWorker(env({ WEB_INSTANCES: "" }))).toBe(false);
  });

  it("WEB_INSTANCES=2/3/max/0 ⇒ عنقودٌ متعدّد (الجسر يُعطَّل)", () => {
    expect(isMultiWorker(env({ WEB_INSTANCES: "2" }))).toBe(true);
    expect(isMultiWorker(env({ WEB_INSTANCES: "3" }))).toBe(true);
    expect(isMultiWorker(env({ WEB_INSTANCES: "max" }))).toBe(true);
    expect(isMultiWorker(env({ WEB_INSTANCES: "0" }))).toBe(true); // كل النوى
  });

  it("قيمةٌ مجهولة ⇒ تُعامَل كعنقودٍ متعدّد (الأمان أوّلاً)", () => {
    expect(isMultiWorker(env({ WEB_INSTANCES: "abc" }))).toBe(true);
  });
});
