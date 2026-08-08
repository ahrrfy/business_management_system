/**
 * اختبارات حماية الحِمل الزائد — الوسيط نقيّ (يُحقَن `lagMs`) فيُختبَر قرار التنازل حتمياً بلا
 * إشباعٍ حقيقيّ لحلقة الأحداث. الثابت: يتنازل فقط عندما يتجاوز التأخّرُ العتبةَ، ويُعطَّل بصفر،
 * ويحترم التخطّي (صحّة/أصول/ويبهوكس).
 */
import type { NextFunction, Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { createOverloadGuard, startLagMonitor } from "../overloadGuard";

function invoke(opts: {
  lag: number;
  maxLagMs?: number;
  skip?: (r: Request) => boolean;
  path?: string;
}) {
  const state = { shed: false, nextCalled: false };
  const guard = createOverloadGuard({
    lagMs: () => opts.lag,
    maxLagMs: opts.maxLagMs ?? 500,
    skip: opts.skip,
    onShed: () => {
      state.shed = true;
    },
  });
  const req = { path: opts.path ?? "/api/trpc", method: "POST" } as Request;
  const next: NextFunction = () => {
    state.nextCalled = true;
  };
  guard(req, {} as Response, next);
  return state;
}

describe("createOverloadGuard — قرار التنازل", () => {
  it("تأخّر دون العتبة ⇒ يمرّر", () => {
    const s = invoke({ lag: 100, maxLagMs: 500 });
    expect(s.nextCalled).toBe(true);
    expect(s.shed).toBe(false);
  });

  it("تأخّر فوق العتبة ⇒ يتنازل (503) ولا يمرّر", () => {
    const s = invoke({ lag: 800, maxLagMs: 500 });
    expect(s.shed).toBe(true);
    expect(s.nextCalled).toBe(false);
  });

  it("maxLagMs=0 ⇒ مُعطَّل (يمرّر رغم تأخّرٍ عالٍ)", () => {
    const s = invoke({ lag: 5000, maxLagMs: 0 });
    expect(s.nextCalled).toBe(true);
    expect(s.shed).toBe(false);
  });

  it("skip=true ⇒ يمرّر رغم التأخّر (فحص صحّة/أصول/ويبهوكس)", () => {
    const s = invoke({ lag: 5000, maxLagMs: 500, skip: () => true });
    expect(s.nextCalled).toBe(true);
    expect(s.shed).toBe(false);
  });

  it("عند العتبة تماماً ⇒ يمرّر (الشرط `>` صارم، لا حجب حدّيّ)", () => {
    const s = invoke({ lag: 500, maxLagMs: 500 });
    expect(s.nextCalled).toBe(true);
    expect(s.shed).toBe(false);
  });
});

describe("startLagMonitor", () => {
  it("يبدأ بصفر ويُرجِع lagMs/stop", () => {
    const m = startLagMonitor(10_000); // فترة طويلة: لا يُطلَق أثناء الاختبار
    expect(typeof m.lagMs).toBe("function");
    expect(m.lagMs()).toBe(0);
    m.stop();
  });
});
