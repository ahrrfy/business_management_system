/**
 * اختبارات حارس CSRF + غلاف أخطاء tRPC للوسائط (علّة تعذّر الدخول من متصفح اللوحي ٤/٧/٢٠٢٦):
 * أي وسيط كان يعيد `{"error":"نص"}` عارياً على /api/trpc جعل عميل tRPC يرمي
 * «Unable to transform response from server» بدل عرض السبب العربي. الاختبارات هنا
 * تُثبت أن الغلاف الجديد يجتاز **نفس** دالة التحويل التي يشغّلها العميل (transformResult)،
 * وأن الحارس يقبل Sec-Fetch-Site عند غياب Origin/Referer (متصفحات الخصوصية/توفير البيانات).
 *
 * منطق الاختبارات نفسه لا يلمس القاعدة، لكن **تشغيل الملف يتطلب قاعدة اختبار حيّة** لأن
 * setup vitest العالمي (__setup__.ts) يفتح اتصال MySQL في afterEach لكل اختبار بلا استثناء.
 */
import { transformResult } from "@trpc/server/unstable-core-do-not-import";
import type { NextFunction, Request, Response } from "express";
import superjson from "superjson";
import { describe, expect, it } from "vitest";
import { csrfGuard } from "../csrf";
import { sendTrpcError, trpcAwareRateLimitHandler } from "../trpcError";

type MockRes = Response & { statusCode: number; body: unknown };

function mockRes(): MockRes {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as MockRes;
}

function mockReq(opts: {
  method?: string;
  baseUrl?: string;
  path?: string;
  headers?: Record<string, string>;
  host?: string;
  protocol?: string;
}): Request {
  const headers = opts.headers ?? {};
  return {
    method: opts.method ?? "POST",
    baseUrl: opts.baseUrl ?? "/api/trpc",
    path: opts.path ?? "/",
    headers,
    protocol: opts.protocol ?? "https",
    get(name: string) {
      if (name.toLowerCase() === "host") return opts.host ?? "srv.example.iq";
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

function run(req: Request): { res: MockRes; nextCalled: boolean } {
  const res = mockRes();
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  csrfGuard(req, res, next);
  return { res, nextCalled };
}

describe("sendTrpcError — الغلاف الذي يفهمه عميل tRPC", () => {
  it("يجتاز transformResult (نفس تحقّق httpBatchLink) ويحفظ الرسالة العربية", () => {
    const res = mockRes();
    sendTrpcError(res, { httpStatus: 403, code: "FORBIDDEN", message: "مرفوض للاختبار" });
    expect(res.statusCode).toBe(403);
    // لا يرمي TransformResultError — وهو ما كان يحدث مع {"error":"نص"} العارية.
    const transformed = transformResult(
      res.body as Parameters<typeof transformResult>[0],
      superjson
    );
    expect(transformed.ok).toBe(false);
    if (!transformed.ok) {
      const err = transformed.error.error as { message: string; code: number; data: { httpStatus: number } };
      expect(err.message).toBe("مرفوض للاختبار");
      expect(err.code).toBe(-32003);
      expect(err.data.httpStatus).toBe(403);
    }
  });

  it("الشكل العاري القديم كان فعلاً يفشل التحويل (توثيق العلّة)", () => {
    expect(() =>
      transformResult(
        { error: "CSRF: مصدر الطلب مفقود" } as unknown as Parameters<typeof transformResult>[0],
        superjson
      )
    ).toThrow("Unable to transform response from server");
  });

  it("TOO_MANY_REQUESTS يحمل الكود الرقمي الصحيح", () => {
    const res = mockRes();
    sendTrpcError(res, { httpStatus: 429, code: "TOO_MANY_REQUESTS", message: "انتظر" });
    const transformed = transformResult(
      res.body as Parameters<typeof transformResult>[0],
      superjson
    );
    expect(transformed.ok).toBe(false);
    if (!transformed.ok) {
      expect((transformed.error.error as { code: number }).code).toBe(-32029);
    }
  });
});

describe("csrfGuard — المطابقة الأساسية", () => {
  it("يمرّر GET بلا فحص", () => {
    const { nextCalled } = run(mockReq({ method: "GET", headers: {} }));
    expect(nextCalled).toBe(true);
  });

  it("يمرّر POST بـOrigin مطابق", () => {
    const { nextCalled } = run(
      mockReq({ headers: { origin: "https://srv.example.iq" } })
    );
    expect(nextCalled).toBe(true);
  });

  it("يرفض Origin غير مطابق حتى مع Sec-Fetch-Site same-origin (لا التفاف)", () => {
    const { res, nextCalled } = run(
      mockReq({
        headers: { origin: "https://evil.example", "sec-fetch-site": "same-origin" },
      })
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("يرفض نطاق lookalike (srv.example.iq.evil.com)", () => {
    const { res, nextCalled } = run(
      mockReq({ headers: { origin: "https://srv.example.iq.evil.com" } })
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("يرفض اختلاف البروتوكول (http origin على خادم https)", () => {
    const { res, nextCalled } = run(
      mockReq({ headers: { origin: "http://srv.example.iq" } })
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});

describe("csrfGuard — متصفحات تحجب Origin/Referer (علّة اللوحي)", () => {
  it("يقبل عند غيابهما إذا شهد المتصفح Sec-Fetch-Site: same-origin", () => {
    const { nextCalled } = run(mockReq({ headers: { "sec-fetch-site": "same-origin" } }));
    expect(nextCalled).toBe(true);
  });

  it("يقبل Sec-Fetch-Site: none (تفاعل مباشر من المستخدم)", () => {
    const { nextCalled } = run(mockReq({ headers: { "sec-fetch-site": "none" } }));
    expect(nextCalled).toBe(true);
  });

  it("يرفض Sec-Fetch-Site: cross-site", () => {
    const { res, nextCalled } = run(mockReq({ headers: { "sec-fetch-site": "cross-site" } }));
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("يرفض الغياب التام لكل الترويسات (curl/متصفح قديم جداً)", () => {
    const { res, nextCalled } = run(mockReq({ headers: {} }));
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("Origin: null الحرفية (أصل مبهم) تعامَل كغياب: تُقبل مع Sec-Fetch-Site same-origin", () => {
    const { nextCalled } = run(
      mockReq({ headers: { origin: "null", "sec-fetch-site": "same-origin" } })
    );
    expect(nextCalled).toBe(true);
  });

  it("Origin: null الحرفية مع cross-site تُرفض (صفحة مهاجمة بأصل مبهم)", () => {
    const { res, nextCalled } = run(
      mockReq({ headers: { origin: "null", "sec-fetch-site": "cross-site" } })
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});

describe("trpcAwareRateLimitHandler — ردّ 429 بحسب السطح", () => {
  it("على /api/trpc: غلاف tRPC يجتاز تحويل العميل", () => {
    const res = mockRes();
    trpcAwareRateLimitHandler("انتظر قليلاً")(mockReq({ baseUrl: "/api/trpc" }), res);
    expect(res.statusCode).toBe(429);
    const transformed = transformResult(
      res.body as Parameters<typeof transformResult>[0],
      superjson
    );
    expect(transformed.ok).toBe(false);
    if (!transformed.ok) {
      expect((transformed.error.error as { message: string; code: number }).message).toBe("انتظر قليلاً");
      expect((transformed.error.error as { code: number }).code).toBe(-32029);
    }
  });

  it("على سطح آخر: الشكل العاري القديم {error}", () => {
    const res = mockRes();
    trpcAwareRateLimitHandler("انتظر قليلاً")(
      mockReq({ baseUrl: "", headers: {} }),
      res
    );
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({ error: "انتظر قليلاً" });
  });
});

describe("csrfGuard — شكل الرفض بحسب السطح", () => {
  it("على /api/trpc: غلاف tRPC يجتاز تحويل العميل ويعرض الرسالة العربية", () => {
    const { res } = run(mockReq({ baseUrl: "/api/trpc", headers: {} }));
    const transformed = transformResult(
      res.body as Parameters<typeof transformResult>[0],
      superjson
    );
    expect(transformed.ok).toBe(false);
    if (!transformed.ok) {
      expect((transformed.error.error as { message: string }).message).toContain("مصدر الطلب");
    }
  });

  it("على /api/print: الشكل العاري القديم {error} كما كان", () => {
    const { res } = run(mockReq({ baseUrl: "/api/print", headers: {} }));
    expect(res.statusCode).toBe(403);
    expect(res.body).toHaveProperty("error");
    expect((res.body as { error: string }).error).toContain("مصدر الطلب");
  });
});
