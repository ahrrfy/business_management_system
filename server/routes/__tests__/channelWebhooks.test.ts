import { afterEach, describe, expect, it } from "vitest";
import type { DB } from "../../db";
import { runWithCompany } from "../../tenancy/context";
import { webhookTenancyGuard } from "../channelWebhooks";

/**
 * حارس تعدد الشركات لِـ/api/webhooks — يمنع سيناريو خطير: getDb() يرمي بلا سياق شركة في
 * وضع تعدد الشركات (تصميم متعمّد في db.ts)، ورَفض غير مُلتَقَط داخل مُعالِج async يُصبح
 * unhandledRejection يُسقِط العملية بأكملها (Express 4 لا يَلتَقِط رَفض async تلقائياً).
 * هذا الحارس يرفض بوضوح **قبل** الوصول لأي مُعالِج فلا يتحقّق ذلك السيناريو إطلاقاً.
 *
 * لا نشغّل خادم Express كاملاً — webhookTenancyGuard دالّة وسيط عادية، تُختبَر مباشرةً
 * بكائنات req/res وهمية (لا حاجة لـsupertest).
 */

function mockRes() {
  const calls: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      calls.status = code;
      return res;
    },
    send(body: unknown) {
      calls.body = body;
      return res;
    },
  };
  return { res: res as any, calls };
}

describe("webhookTenancyGuard — حارس تعدد الشركات لِـ/api/webhooks", () => {
  const savedControlUrl = process.env.CONTROL_DATABASE_URL;
  afterEach(() => {
    if (savedControlUrl === undefined) delete process.env.CONTROL_DATABASE_URL;
    else process.env.CONTROL_DATABASE_URL = savedControlUrl;
  });

  it("نشر أحادي الشركة (بلا CONTROL_DATABASE_URL): يمرّ دائماً بلا فحص — سلوك ما قبل تعدد الشركات بلا تغيير", () => {
    delete process.env.CONTROL_DATABASE_URL;
    const { res, calls } = mockRes();
    let nextCalled = false;
    webhookTenancyGuard({} as any, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(calls.status).toBeUndefined();
  });

  it("تعدد الشركات + بلا سياق شركة (المسار المطلق /api/webhooks/*): يرفض 404 بدل السقوط في getDb()", () => {
    process.env.CONTROL_DATABASE_URL = "mysql://root:pw@127.0.0.1:3310/erp_control";
    const { res, calls } = mockRes();
    let nextCalled = false;
    webhookTenancyGuard({} as any, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(calls.status).toBe(404);
  });

  it("تعدد الشركات + سياق شركة مضبوط (المسار المقيَّد /api/webhooks/company/:code/*): يمرّ بلا رفض", async () => {
    process.env.CONTROL_DATABASE_URL = "mysql://root:pw@127.0.0.1:3310/erp_control";
    const fakeDb = { marker: "company-A" } as unknown as DB;
    await runWithCompany(7, fakeDb, async () => {
      const { res, calls } = mockRes();
      let nextCalled = false;
      webhookTenancyGuard({} as any, res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
      expect(calls.status).toBeUndefined();
    });
  });
});
