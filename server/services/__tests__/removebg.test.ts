/**
 * اختبارات مسار Pro لاستوديو صور المنتجات (remove.bg) — شريحة ٥.
 *   - callRemovebg/getRemovebgAccount: نقيّة، fetch مُموَّه (لا شبكة فعلية) — تصنيف الأخطاء الحاسم
 *     (402/403/429/400/5xx/شبكة) الذي يقود تدهور الواجهة لـFLATTEN.
 *   - imageStudioSettingsService: تشفير المفتاح (لا يُعرَض نصّاً) + بوّابة «لا تفعيل Pro بلا مفتاح»
 *     + مسح المفتاح يُعطّل Pro + getDecryptedRemovebgKey يحترم التفعيل.
 */
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { __resetKeyCacheForTests } from "../cryptoService";
import { callRemovebg, getRemovebgAccount } from "../removebgService";
import {
  getDecryptedRemovebgKey,
  getImageStudioSettings,
  getProConfig,
  updateImageStudioSettings,
  verifyRemovebgConnection,
} from "../imageStudioSettingsService";

// ────────────────────────── callRemovebg (نقيّ) ──────────────────────────
describe("callRemovebg (fetch مُموَّه)", () => {
  it("نجاح ⇒ قصّ + رصيد + أبعاد من الترويسات", async () => {
    const cut = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const fakeFetch: typeof fetch = async () =>
      new Response(cut, { status: 200, headers: { "X-Credits-Charged": "1", "X-Width": "625", "X-Height": "400" } });
    const r = await callRemovebg("key", "QUJD", { fetchImpl: fakeFetch });
    expect(r.cutout.length).toBe(6);
    expect(r.creditsCharged).toBe(1);
    expect(r.width).toBe(625);
    expect(r.height).toBe(400);
  });

  it.each([
    [402, "OUT_OF_CREDITS"],
    [403, "AUTH"],
    [429, "RATE_LIMITED"],
    [400, "BAD_INPUT"],
    [500, "SERVICE"],
  ] as const)("حالة %i ⇒ تصنيف %s", async (status, kind) => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ errors: [{ title: "x", code: "y" }] }), {
        status,
        headers: { "content-type": "application/json" },
      });
    await expect(callRemovebg("key", "QUJD", { fetchImpl: fakeFetch })).rejects.toMatchObject({ kind });
  });

  it("فشل الشبكة ⇒ NETWORK", async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error("boom");
    };
    await expect(callRemovebg("key", "QUJD", { fetchImpl: fakeFetch })).rejects.toMatchObject({ kind: "NETWORK" });
  });

  it("جسم فارغ رغم 200 ⇒ SERVICE (لا قصّ زائف)", async () => {
    const fakeFetch: typeof fetch = async () => new Response(Buffer.alloc(0), { status: 200 });
    await expect(callRemovebg("key", "QUJD", { fetchImpl: fakeFetch })).rejects.toMatchObject({ kind: "SERVICE" });
  });

  it("402 على الدقّة الكاملة ⇒ يعيد المحاولة بمعاينة ⇒ isPreview=true", async () => {
    let call = 0;
    const cut = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const fakeFetch: typeof fetch = async () => {
      call++;
      if (call === 1) {
        return new Response(JSON.stringify({ errors: [{ title: "Insufficient credits" }] }), {
          status: 402,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(cut, { status: 200, headers: { "X-Credits-Charged": "0" } });
    };
    const r = await callRemovebg("key", "QUJD", { fetchImpl: fakeFetch });
    expect(r.isPreview).toBe(true);
    expect(r.cutout.length).toBe(4);
    expect(call).toBe(2); // حاول auto ثم تراجع لـpreview
  });

  it("402 حتى على المعاينة ⇒ يرمي OUT_OF_CREDITS بلا حلقة لا نهائية", async () => {
    let call = 0;
    const fakeFetch: typeof fetch = async () => {
      call++;
      return new Response(JSON.stringify({ errors: [] }), { status: 402, headers: { "content-type": "application/json" } });
    };
    await expect(callRemovebg("key", "QUJD", { fetchImpl: fakeFetch })).rejects.toMatchObject({ kind: "OUT_OF_CREDITS" });
    expect(call).toBe(2); // auto ثم preview، ثم يستسلم (لا ثالثة)
  });
});

describe("getRemovebgAccount", () => {
  it("يحلّل الرصيد والنداءات المجانية", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ data: { attributes: { credits: { total: 42 }, api: { free_calls: 50 } } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const a = await getRemovebgAccount("key", fakeFetch);
    expect(a.totalCredits).toBe(42);
    expect(a.freeApiCalls).toBe(50);
  });

  it("403 ⇒ AUTH", async () => {
    const fakeFetch: typeof fetch = async () => new Response("{}", { status: 403 });
    await expect(getRemovebgAccount("key", fakeFetch)).rejects.toMatchObject({ kind: "AUTH" });
  });
});

// ─────────────────────── imageStudioSettingsService (DB) ───────────────────────
const ORIGINAL_KEY = process.env.INTEGRATIONS_ENCRYPTION_KEY;
const TEST_KEY_HEX = crypto.randomBytes(32).toString("hex");
const TABLES = ["imageStudioSettings", "users"];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

describe("imageStudioSettingsService (DB)", () => {
  beforeEach(async () => {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = TEST_KEY_HEX;
    __resetKeyCacheForTests();
    await reset();
    await db()
      .insert(s.users)
      .values({ id: 1, openId: "local_admin", name: "المدير", role: "admin", loginMethod: "local" });
  });
  afterAll(() => {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = ORIGINAL_KEY;
    __resetKeyCacheForTests();
  });

  it("حفظ المفتاح ⇒ قناع لا نصّ، وPro مطفأ افتراضياً", async () => {
    await updateImageStudioSettings({ removebgKey: "o98F4kH8secretKEY" }, 1);
    const st = await getImageStudioSettings();
    expect(st.hasKey).toBe(true);
    expect(st.proEnabled).toBe(false);
    expect(st.removebgKeyMasked).not.toContain("secret");
    expect(st.removebgKeyMasked?.endsWith("tKEY")).toBe(true);
    expect(st.cryptoReady).toBe(true);
  });

  it("تفعيل Pro بلا مفتاح ⇒ يُرفَض", async () => {
    await expect(updateImageStudioSettings({ proEnabled: true }, 1)).rejects.toThrow();
    expect((await getProConfig()).proAvailable).toBe(false);
  });

  it("مفتاح ثمّ تفعيل ⇒ proAvailable + المفتاح المفكوك صحيح", async () => {
    await updateImageStudioSettings({ removebgKey: "MYKEY123456" }, 1);
    await updateImageStudioSettings({ proEnabled: true }, 1);
    expect((await getProConfig()).proAvailable).toBe(true);
    expect(await getDecryptedRemovebgKey()).toBe("MYKEY123456");
  });

  it("Pro مطفأ ⇒ getDecryptedRemovebgKey = null رغم وجود المفتاح", async () => {
    await updateImageStudioSettings({ removebgKey: "MYKEY123456" }, 1);
    expect(await getDecryptedRemovebgKey()).toBeNull();
  });

  it("مسح المفتاح ⇒ يُعطّل Pro + hasKey=false + المفكوك null", async () => {
    await updateImageStudioSettings({ removebgKey: "MYKEY123456" }, 1);
    await updateImageStudioSettings({ proEnabled: true }, 1);
    await updateImageStudioSettings({ removebgKey: null }, 1);
    const st = await getImageStudioSettings();
    expect(st.hasKey).toBe(false);
    expect(st.proEnabled).toBe(false);
    expect(await getDecryptedRemovebgKey()).toBeNull();
    expect((await getProConfig()).proAvailable).toBe(false);
  });

  it("verifyConnection (fetch عام مُموَّه) ⇒ ok + يُثبِت lastVerifiedAt", async () => {
    await updateImageStudioSettings({ removebgKey: "MYKEY123456" }, 1);
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { attributes: { credits: { total: 7 }, api: { free_calls: 50 } } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      const r = await verifyRemovebgConnection();
      expect(r.ok).toBe(true);
      expect(r.message).toContain("7");
      const st = await getImageStudioSettings();
      expect(st.lastVerifiedAt).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
