/**
 * قوالب Meta (waTemplates) + endpoints إعدادات مركز واتساب الأعمال — تكليف T4.1 (S4، بنية القوالب).
 *
 * نمط الاختبار: appRouter.createCaller (نفس conversationSend.test.ts) لاختبارات الراوتر
 * (integrations.syncTemplates/templates.list/waHubSettings.get/update)، ودوال templateService
 * مباشرةً لمنطق المزامنة الصرف (fetch مموَّه عبر حقن fetchImpl — نمط sendService.test.ts، لا ضربة
 * شبكة حقيقية). سيناريو راوتر واحد يموِّه fetch العالمي (vi.spyOn) لأنّ integrationRouter.syncTemplates
 * لا يقبل fetchImpl (لا مسار حقن في الإنتاج، بخلاف دالة الخدمة القابلة للاختبار مباشرةً).
 */
import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { encryptSecret } from "../cryptoService";
import { getUsableTemplate, syncTemplatesFromGraph } from "../whatsapp/templateService";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

function ctxWith(role: string, branchId: number | null, userId = 2): TrpcContext {
  return {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: { id: userId, role, branchId, name: "t", email: "t@t", isActive: true } as unknown as TrpcContext["user"],
  };
}
const caller = (role: string, branchId: number | null, userId = 2) => appRouter.createCaller(ctxWith(role, branchId, userId));

async function seedBranch(id = 1) {
  await db().insert(s.branches).values({ id, name: "الرئيسي", code: "MAIN", type: "MAIN" });
}

/** يزرع مستخدماً بمعرّف ٢ (userId الافتراضي في ctxWith) — waHubSettings.updatedBy له FK حقيقي. */
async function seedActorUser() {
  await db().insert(s.users).values({ id: 2, openId: "local_wa_hub_test", name: "مدير اختبار", role: "admin", loginMethod: "local" });
}

/** حمولة Graph نموذجية (وثيقة Meta: GET /{wabaId}/message_templates ⇒ {data: [...]}):
 *  قالب APPROVED بمتغيّرين + قالب PENDING بلا متغيّرات. */
function graphPayload() {
  return {
    data: [
      {
        name: "order_ready",
        language: "ar",
        category: "UTILITY",
        status: "APPROVED",
        components: [
          { type: "BODY", text: "مرحباً {{1}}، طلبك رقم {{2}} جاهز للاستلام." },
          { type: "FOOTER", text: "شكراً لتعاملكم معنا" },
        ],
        quality_score: { score: "GREEN" },
      },
      {
        name: "welcome_msg",
        language: "ar",
        category: "MARKETING",
        status: "PENDING",
        components: [{ type: "BODY", text: "أهلاً بك في المكتبة العربية!" }],
      },
    ],
  };
}

function fakeFetchOk(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(graphPayload()), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

describe("templateService.syncTemplatesFromGraph", () => {
  it("قالبان (APPROVED بمتغيّرين + PENDING) ⇒ صفّان بالحالة/الفئة/variableCount الصحيحة", async () => {
    const result = await syncTemplatesFromGraph({ accessToken: "tok", wabaId: "1234567890" }, fakeFetchOk());
    expect(result.synced).toBe(2);
    expect(result.approved).toBe(1);

    const rows = await db().select().from(s.waTemplates).orderBy(asc(s.waTemplates.name));
    expect(rows).toHaveLength(2);

    const orderReady = rows.find((r) => r.name === "order_ready")!;
    expect(orderReady.templateStatus).toBe("APPROVED");
    expect(orderReady.category).toBe("UTILITY");
    expect(orderReady.variableCount).toBe(2);
    expect(orderReady.qualityScore).toBe("GREEN");
    expect(orderReady.bodyText).toContain("{{1}}");
    expect(orderReady.syncedAt).not.toBeNull();

    const welcome = rows.find((r) => r.name === "welcome_msg")!;
    expect(welcome.templateStatus).toBe("PENDING");
    expect(welcome.category).toBe("MARKETING");
    expect(welcome.variableCount).toBe(0);
  });

  it("إعادة التشغيل idempotent — upsert لا تكرار (نفس عدد الصفوف بعد مزامنة ثانية بتغيّر الحالة)", async () => {
    await syncTemplatesFromGraph({ accessToken: "tok", wabaId: "1234567890" }, fakeFetchOk());

    // ثاني مزامنة: order_ready صار PAUSED عند Meta — upsert يُحدِّث الصفّ القائم لا يُضيف صفّاً.
    const secondPayload: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { name: "order_ready", language: "ar", category: "UTILITY", status: "PAUSED", components: [{ type: "BODY", text: "نصّ مُحدَّث {{1}}" }] },
            { name: "welcome_msg", language: "ar", category: "MARKETING", status: "PENDING", components: [{ type: "BODY", text: "أهلاً بك في المكتبة العربية!" }] },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const result = await syncTemplatesFromGraph({ accessToken: "tok", wabaId: "1234567890" }, secondPayload);
    expect(result.synced).toBe(2);
    expect(result.approved).toBe(0); // order_ready لم يعُد APPROVED الآن.

    const rows = await db().select().from(s.waTemplates);
    expect(rows).toHaveLength(2); // بلا تكرار.
    const orderReady = rows.find((r) => r.name === "order_ready")!;
    expect(orderReady.templateStatus).toBe("PAUSED");
    expect(orderReady.variableCount).toBe(1);
  });

  it("غياب wabaId ⇒ خطأ عربي فوري (PRECONDITION_FAILED)", async () => {
    await expect(syncTemplatesFromGraph({ accessToken: "tok", wabaId: null })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("WABA ID"),
    });
    const rows = await db().select().from(s.waTemplates);
    expect(rows).toHaveLength(0);
  });

  it("فشل Graph (HTTP 401) ⇒ خطأ عربي BAD_GATEWAY بلا كتابة", async () => {
    const failFetch: typeof fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "Invalid OAuth access token" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(syncTemplatesFromGraph({ accessToken: "bad", wabaId: "123" }, failFetch)).rejects.toMatchObject({
      code: "BAD_GATEWAY",
    });
    const rows = await db().select().from(s.waTemplates);
    expect(rows).toHaveLength(0);
  });
});

describe("templateService.getUsableTemplate", () => {
  beforeEach(async () => {
    await db().insert(s.waTemplates).values([
      { name: "approved_tpl", language: "ar", templateStatus: "APPROVED", category: "UTILITY" },
      { name: "pending_tpl", language: "ar", templateStatus: "PENDING", category: "UTILITY" },
      { name: "rejected_tpl", language: "ar", templateStatus: "REJECTED", category: "UTILITY" },
    ]);
  });

  it("APPROVED ⇒ يعيد القالب كاملاً", async () => {
    const t = await getUsableTemplate("approved_tpl", "ar");
    expect(t).not.toBeNull();
    expect(t?.templateStatus).toBe("APPROVED");
  });

  it("PENDING/REJECTED ⇒ null (غير قابل للإرسال)", async () => {
    expect(await getUsableTemplate("pending_tpl", "ar")).toBeNull();
    expect(await getUsableTemplate("rejected_tpl", "ar")).toBeNull();
  });

  it("غير موجود أصلاً ⇒ null", async () => {
    expect(await getUsableTemplate("no_such_tpl", "ar")).toBeNull();
  });
});

describe("integrations.syncTemplates + templates.list (راوتر)", () => {
  beforeEach(async () => {
    await seedBranch(1);
    await seedActorUser(); // logAudit يكتب userId=2 (ctxWith الافتراضي) — يمنع تحذير FK صامتاً في السجلّ.
  });

  it("لا تكامل ACTIVE على الفرع ⇒ PRECONDITION_FAILED عربي", async () => {
    await expect(caller("admin", null).integrations.syncTemplates({ branchId: 1 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("تكامل واتساب فعّال"),
    });
  });

  it("تكامل ACTIVE بلا wabaId ⇒ خطأ WABA ID عربي (يتصاعد من templateService)", async () => {
    await db().insert(s.channelIntegrations).values({
      branchId: 1,
      channel: "WHATSAPP",
      phoneNumberId: "15550001",
      status: "ACTIVE",
      encryptedAccessToken: encryptSecret("tok"),
    });
    await expect(caller("admin", null).integrations.syncTemplates({ branchId: 1 })).rejects.toMatchObject({
      message: expect.stringContaining("WABA ID"),
    });
  });

  it("تكامل ACTIVE بwabaId صحيح ⇒ ينجح ويُرجع synced/approved (fetch عالمي مُموَّه)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(fakeFetchOk());
    try {
      await db().insert(s.channelIntegrations).values({
        branchId: 1,
        channel: "WHATSAPP",
        phoneNumberId: "15550001",
        wabaId: "999888777",
        status: "ACTIVE",
        encryptedAccessToken: encryptSecret("tok"),
      });
      const result = await caller("admin", null).integrations.syncTemplates({ branchId: 1 });
      expect(result.synced).toBe(2);
      expect(result.approved).toBe(1);
      const rows = await db().select().from(s.waTemplates);
      expect(rows).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("مدير غير أدمن ⇒ FORBIDDEN على syncTemplates (adminProcedure)", async () => {
    await expect(caller("manager", 1).integrations.syncTemplates({ branchId: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("templates.list يعرض القوالب المُزامَنة — مدير يقرأ (managerProcedure)", async () => {
    await db().insert(s.waTemplates).values({ name: "x_template", language: "ar", templateStatus: "APPROVED", category: "UTILITY" });
    const rows = await caller("manager", 1).integrations.templates.list();
    expect(rows.some((r) => r.name === "x_template")).toBe(true);
  });

  it("فلترة templates.list بـstatusFilter", async () => {
    await db().insert(s.waTemplates).values([
      { name: "a_tpl", language: "ar", templateStatus: "APPROVED", category: "UTILITY" },
      { name: "b_tpl", language: "ar", templateStatus: "PENDING", category: "UTILITY" },
    ]);
    const rows = await caller("manager", 1).integrations.templates.list({ statusFilter: "APPROVED" });
    expect(rows.every((r) => r.templateStatus === "APPROVED")).toBe(true);
    expect(rows.some((r) => r.name === "a_tpl")).toBe(true);
    expect(rows.some((r) => r.name === "b_tpl")).toBe(false);
  });

  it("كاشير محجوب عن templates.list (لا منح صريح)", async () => {
    await expect(caller("cashier", 1).integrations.templates.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("integrations.waHubSettings.get/update (راوتر)", () => {
  beforeEach(async () => {
    await seedActorUser();
  });

  it("get قبل أي تحديث (لا صفّ في DB بعد) ⇒ الافتراضيات بلا كتابة", async () => {
    const view = await caller("manager", 1).integrations.waHubSettings.get();
    expect(view.triageMode).toBe("AUTO_ALL");
    expect(view.killSwitch).toBe(false);
    expect(view.throttlePerMinute).toBe(10);
    const rows = await db().select().from(s.waHubSettings);
    expect(rows).toHaveLength(0); // get-or-default: لا كتابة في مسار القراءة.
  });

  it("update يحفظ ويُقرأ لاحقاً — ensure-row عند الغياب (لا صفّ سابق أصلاً)", async () => {
    const updated = await caller("admin", null).integrations.waHubSettings.update({
      triageMode: "MANUAL",
      killSwitch: true,
      throttlePerMinute: 5,
    });
    expect(updated.triageMode).toBe("MANUAL");
    expect(updated.killSwitch).toBe(true);
    expect(updated.throttlePerMinute).toBe(5);
    expect(updated.updatedBy).toBe(2); // ctxWith الافتراضي userId=2.

    const rows = await db().select().from(s.waHubSettings).where(eq(s.waHubSettings.id, 1));
    expect(rows).toHaveLength(1);

    const reread = await caller("manager", 1).integrations.waHubSettings.get();
    expect(reread.triageMode).toBe("MANUAL");
    expect(reread.killSwitch).toBe(true);
  });

  it("update جزئي لا يمسّ الحقول غير المُرسَلة (undefined = لا تُغيَّر)", async () => {
    await caller("admin", null).integrations.waHubSettings.update({ triageMode: "KEYWORD_ONLY" });
    const after = await caller("admin", null).integrations.waHubSettings.update({ killSwitch: true });
    expect(after.triageMode).toBe("KEYWORD_ONLY"); // لم يُرسَل ثانيةً ⇒ بقي كما هو.
    expect(after.killSwitch).toBe(true);
  });

  it("مدير غير أدمن ⇒ FORBIDDEN على update (adminProcedure)", async () => {
    await expect(caller("manager", 1).integrations.waHubSettings.update({ killSwitch: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("كاشير محجوب عن get (managerProcedure)", async () => {
    await expect(caller("cashier", 1).integrations.waHubSettings.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
