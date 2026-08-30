/**
 * أطوار الوظائف الدورية (فحص الحمل ٣١/٨/٢٦) — ثابتٌ تعاقديّ:
 * ستّ وظائف كانت تنطلق في الثانية `00` نفسها على العامل ٠ فتصنع ذروةَ استعلاماتٍ متزامنة
 * على مجمّع اتصالٍ واحد. الاختبار يقرأ التعبيرات من مصادرها ويُثبت تباعدها فعلياً — لا
 * يكفي التعليق، فأيّ عودةٍ إلى `* * * * *` تُعيد التصادم بصمت.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string): string =>
  readFileSync(path.resolve(process.cwd(), rel), "utf8");

/** يلتقط تعبير cron بستّة حقول من نصّ المصدر. */
function sixFieldExpressions(source: string): string[] {
  return [...source.matchAll(/"(\d+ [^"]*\*[^"]*)"/g)]
    .map((m) => m[1])
    .filter((expr) => expr.trim().split(/\s+/).length === 6);
}

const SOURCES: Array<{ label: string; file: string }> = [
  { label: "whatsapp-outbox", file: "server/services/whatsapp/outboxSweeper.ts" },
  { label: "delivery-outbox", file: "server/services/delivery/outboxWorker.ts" },
  { label: "reservations", file: "server/services/reservations/sweeper.ts" },
  { label: "studio-notifications", file: "server/services/productStudioNotificationWorker.ts" },
  { label: "online-order-expiry", file: "server/services/onlineOrderExpirySweeper.ts" },
];

describe("أطوار الوظائف الدورية", () => {
  it("كل وظيفة دورية تحمل تعبيراً بستّة حقول (ثانيةٌ صريحة) لا خمسة", () => {
    for (const { label, file } of SOURCES) {
      const exprs = sixFieldExpressions(read(file));
      expect(exprs.length, `${label}: لا تعبير سداسيّ`).toBeGreaterThan(0);
    }
  });

  it("لا وظيفتين تتشاركان الثانية نفسها (التصادم الذي أُغلق)", () => {
    const seconds: Array<{ label: string; second: number; expr: string }> = [];
    for (const { label, file } of SOURCES) {
      for (const expr of sixFieldExpressions(read(file))) {
        seconds.push({ label, second: Number(expr.trim().split(/\s+/)[0]), expr });
      }
    }
    expect(seconds.length).toBeGreaterThanOrEqual(6);
    const bySecond = new Map<number, string[]>();
    for (const entry of seconds) {
      bySecond.set(entry.second, [...(bySecond.get(entry.second) ?? []), entry.label]);
    }
    const collisions = [...bySecond.entries()].filter(([, labels]) => labels.length > 1);
    expect(collisions, `تصادم أطوار: ${JSON.stringify(collisions)}`).toEqual([]);
  });

  it("الثواني موزّعة على الدقيقة بأوسع تباعدٍ يسمح به عددها", () => {
    const secs = SOURCES.flatMap(({ file }) =>
      sixFieldExpressions(read(file)).map((e) => Number(e.trim().split(/\s+/)[0])),
    ).sort((a, b) => a - b);
    // الحدّ مشتقٌّ من العدد لا ثابتاً بعشر: إضافةُ وظيفةٍ سابعة تضيّق التباعد الممكن حتماً،
    // وحارسٌ بثابتٍ صلب كان سيفشل عليها فيُجبر على تعديله بدل أن يقيس المقصود (مراجعة ٣١/٨).
    const minGap = Math.max(2, Math.floor(60 / secs.length) - 1);
    for (let i = 1; i < secs.length; i += 1) {
      expect(secs[i] - secs[i - 1], `تقارب عند ${secs[i]} (الحدّ ${minGap})`).toBeGreaterThanOrEqual(minGap);
    }
  });

  it("لا تعبير cron خماسيّ الحقول باقٍ في هذه الوظائف", () => {
    for (const { label, file } of SOURCES) {
      const source = read(file);
      expect(source, `${label}: ما زال يحمل تعبيراً كل دقيقة بلا ثانية`).not.toMatch(
        /"\*\s+\*\s+\*\s+\*\s+\*"/,
      );
      expect(source, `${label}: ما زال يحمل تعبير كل-٥-دقائق بلا ثانية`).not.toMatch(
        /"\*\/5\s+\*\s+\*\s+\*\s+\*"/,
      );
    }
  });
});
