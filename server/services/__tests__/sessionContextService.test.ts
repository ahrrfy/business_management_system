/**
 * sessionContextService — اشتقاقُ سياق الجلسة على الخادم (م٤ ق١: الاستنتاج قبل السؤال).
 *
 * ما يُثبَت هنا (كلٌّ منها كان باباً مفتوحاً):
 *   • الفرعُ يأتي **باسمه** من صفّ `branches`، ولا يُخترَع: غيرُ العابر بلا فرعٍ يُرفَض (FORBIDDEN)،
 *     وفرعٌ مُسنَدٌ بلا صفٍّ يُرفَض (PRECONDITION_FAILED) — لا «الفرع ١».
 *   • الحمولةُ التي يُنتجها الخادم **يقبلها قارئُ العميل** (`readSessionContext`) كما هي حتى بعد
 *     المرور بـJSON — الثابت الذي يجعل الشاشة تعرض المُشتَقَّ بلا تلفيق.
 *   • اليومُ التشغيليّ بتوقيت بغداد (+03:00) لا UTC: `22:30Z` ⇒ اليومُ التالي.
 *   • قائمةُ الاختيار تتبع السلطة: عابرُ الفروع ⇒ كلُّ النشطة (المعطَّل مستبعَد)؛ غيرُه ⇒ فرعُه وحده.
 *   • عبر الراوتر (`sessionContext.get`): `scopedOwnerId` يأتي من `branchScopedProcedure` حرفياً —
 *     المديرُ مشرفٌ (`null`) والكاشير يرى ما أنشأه (معرّفُه) — وغيرُ العابر بلا فرعٍ يُرفَض قبل المعالِج.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { INBOUND_ENABLED_PAYMENT_METHODS } from "@shared/inboundPaymentPolicy";
import { readSessionContext } from "@shared/sessionContext";
import { baghdadToday } from "../businessDay";
import { deriveSessionContext, WALK_IN_PRICE_TIER } from "../sessionContextService";

/** 22:30 UTC = 01:30 من اليوم التالي في بغداد ⇒ يُثبت أنّ اليوم التشغيليّ ليس يومَ UTC. */
const NOW = new Date("2026-09-05T22:30:00.000Z");

const TABLES = ["users", "branches"];

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

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
    { id: 3, name: "فرع مغلق", code: "CLOSED", type: "SALES", isActive: false },
  ]);
  // الفرعُ 99 لا صفَّ له عمداً (سلامةُ بيانات) — يُدرَج والقيودُ معطَّلة.
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  await d.insert(s.users).values([
    { id: 1, openId: "owner", name: "المالك", role: "admin", loginMethod: "local", branchId: 1, isOwner: true },
    { id: 2, openId: "admin-no-branch", name: "أدمن بلا فرع", role: "admin", loginMethod: "local", branchId: null, isOwner: false },
    { id: 3, openId: "manager", name: "مدير الفرع", role: "manager", loginMethod: "local", branchId: 1, isOwner: false },
    { id: 4, openId: "cashier", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 2, isOwner: false },
    { id: 5, openId: "cashier-no-branch", name: "كاشير بلا فرع", role: "cashier", loginMethod: "local", branchId: null, isOwner: false },
    { id: 6, openId: "cashier-dangling", name: "كاشير بفرعٍ معدوم", role: "cashier", loginMethod: "local", branchId: 99, isOwner: false },
  ]);
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function caller(userId: number) {
  const user = (await db().select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
  const context = {
    req: { headers: {} },
    res: { cookie() {}, clearCookie() {} },
    sessionId: null,
    platformAdmin: null,
    user,
  } as unknown as TrpcContext;
  return appRouter.createCaller(context);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("deriveSessionContext — الخدمة (بلا ctx)", () => {
  it("كاشير بفرعٍ مُسنَد: الفرعُ باسمه، النطاقُ فرعُه ومعرّفُه، واليومُ التشغيليّ بتوقيت بغداد", async () => {
    const { context, selectableBranches } = await deriveSessionContext({
      actor: { userId: 4, role: "cashier", isOwner: false },
      assignedBranchId: 2,
      scopedOwnerId: 4,
      now: NOW,
    });
    expect(context.branch).toEqual({ id: 2, name: "فرع المبيعات" });
    expect(context.canCrossBranches).toBe(false);
    expect(context.scope).toEqual({ scopedBranchId: 2, scopedOwnerId: 4 });
    expect(context.businessDay).toBe("2026-09-06");
    expect(context.businessDay).toBe(baghdadToday(NOW));
    expect(context.businessDay).not.toBe(NOW.toISOString().slice(0, 10));
    expect(context.allowedPaymentMethods).toEqual([...INBOUND_ENABLED_PAYMENT_METHODS]);
    expect(context.defaultPriceTier).toBe(WALK_IN_PRICE_TIER);
    expect(context.derivedAt).toBe(NOW.toISOString());
    // غيرُ عابر الفروع لا يُعرَض عليه إلّا فرعُه — ما سيرفضه الخادم لا يُعرَض أصلاً.
    expect(selectableBranches).toEqual([{ id: 2, name: "فرع المبيعات" }]);
  });

  it("الثابتُ الحاكم: ما يركّبه الخادم يقبله قارئُ العميل كما هو (حتى بعد JSON)", async () => {
    const { context } = await deriveSessionContext({
      actor: { userId: 4, role: "cashier", isOwner: false },
      assignedBranchId: 2,
      scopedOwnerId: 4,
      now: NOW,
    });
    expect(readSessionContext(context)).toEqual(context);
    expect(readSessionContext(JSON.parse(JSON.stringify(context)))).toEqual(context);
  });

  it("أدمن بلا فرعٍ مُسنَد: الفرعُ null (لا فرعَ افتراضيّ) والقائمةُ كلُّ الفروع النشطة دون المعطَّل", async () => {
    const { context, selectableBranches } = await deriveSessionContext({
      actor: { userId: 2, role: "admin", isOwner: false },
      assignedBranchId: null,
      scopedOwnerId: null,
      now: NOW,
    });
    expect(context.branch).toBeNull();
    expect(context.canCrossBranches).toBe(true);
    expect(context.scope).toEqual({ scopedBranchId: null, scopedOwnerId: null });
    expect(selectableBranches.map((b) => b.id)).toEqual([1, 2]);
    expect(readSessionContext(context)).toEqual(context);
  });

  it("المالك بفرعٍ مُسنَد: يعبُر الفروع (scopedBranchId=null) ويرى كلَّ الفروع النشطة للتجاوز", async () => {
    const { context, selectableBranches } = await deriveSessionContext({
      actor: { userId: 1, role: "admin", isOwner: true },
      assignedBranchId: 1,
      scopedOwnerId: null,
      now: NOW,
    });
    expect(context.branch).toEqual({ id: 1, name: "الفرع الرئيسي" });
    expect(context.canCrossBranches).toBe(true);
    expect(context.scope.scopedBranchId).toBeNull();
    expect(selectableBranches.map((b) => b.id)).toEqual([1, 2]);
  });

  it("غيرُ عابر الفروع بلا فرعٍ مُسنَد يُرفَض FORBIDDEN برسالةٍ تقول ماذا يفعل — لا «الفرع ١»", async () => {
    const attempt = deriveSessionContext({
      actor: { userId: 5, role: "cashier", isOwner: false },
      assignedBranchId: null,
      scopedOwnerId: 5,
      now: NOW,
    });
    await expect(attempt).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(attempt).rejects.toThrow(/اطلب من المدير/);
  });

  it("فرعٌ مُسنَدٌ بلا صفٍّ في branches يُرفَض PRECONDITION_FAILED بالرقم — لا فرعٌ ملفَّق", async () => {
    const attempt = deriveSessionContext({
      actor: { userId: 6, role: "cashier", isOwner: false },
      assignedBranchId: 99,
      scopedOwnerId: 6,
      now: NOW,
    });
    await expect(attempt).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(attempt).rejects.toThrow(/99/);
  });
});

describe("sessionContext.get — عبر الراوتر (branchScopedProcedure يحقن النطاق)", () => {
  it("المدير مشرفُ فرعه: scopedOwnerId=null وscopedBranchId=فرعُه، والحمولةُ يقبلها القارئ المشترك", async () => {
    const out = await (await caller(3)).sessionContext.get();
    expect(out.context.branch).toEqual({ id: 1, name: "الفرع الرئيسي" });
    expect(out.context.canCrossBranches).toBe(false);
    expect(out.context.scope).toEqual({ scopedBranchId: 1, scopedOwnerId: null });
    expect(out.selectableBranches).toEqual([{ id: 1, name: "الفرع الرئيسي" }]);
    const wire = JSON.parse(JSON.stringify(out.context));
    expect(readSessionContext(wire)).toEqual(out.context);
  });

  it("الكاشير يرى ما أنشأه: scopedOwnerId=معرّفُه (كما يحقنه branchScopedProcedure لا نسخةً منه)", async () => {
    const out = await (await caller(4)).sessionContext.get();
    expect(out.context.scope).toEqual({ scopedBranchId: 2, scopedOwnerId: 4 });
    expect(out.context.businessDay).toBe(baghdadToday(new Date()));
  });

  it("أدمن بلا فرعٍ مُسنَد يمرّ (عابرُ الفروع) بفرعٍ null وقائمةِ اختيارٍ خادميّة", async () => {
    const out = await (await caller(2)).sessionContext.get();
    expect(out.context.branch).toBeNull();
    expect(out.context.scope).toEqual({ scopedBranchId: null, scopedOwnerId: null });
    expect(out.selectableBranches.map((b) => b.id)).toEqual([1, 2]);
  });

  it("كاشير بلا فرعٍ مُسنَد يُرفَض FORBIDDEN قبل بلوغ المعالِج (نفسُ رفض branchScopedProcedure)", async () => {
    await expect((await caller(5)).sessionContext.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("عقدُ الراوتر بعد م٤ — `branchId` اختياريّ يُشتقّ خادمياً عند غيابه (shifts.current)", () => {
  it("المدير بلا branchId في الطلب: يُشتقّ فرعُه المُسنَد ولا يُطلَب من الشاشة (لا وردية ⇒ null بلا رمي)", async () => {
    const out = await (await caller(3)).shifts.current({});
    expect(out).toBeNull();
  });

  it("أدمن بلا فرعٍ مُسنَد ولا branchId: رفضٌ صريح PRECONDITION_FAILED يقول ماذا يفعل — لا فرعَ افتراضيّ", async () => {
    const attempt = (await caller(2)).shifts.current({});
    await expect(attempt).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(attempt).rejects.toThrow(/اختر الفرع/);
  });

  it("أدمن بلا فرعٍ مُسنَد يمرّر الفرعَ الذي اختاره من القائمة الخادميّة فيُقبَل", async () => {
    const out = await (await caller(2)).shifts.current({ branchId: 2 });
    expect(out).toBeNull();
  });
});
