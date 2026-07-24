// دورة حياة البث التسويقي (S5، T5.1) — broadcastService: معاينة العدد/الكلفة، إنشاء بشرط قالب
// MARKETING+APPROVED، إطلاق باعتماد ثانٍ (SOD) فوق عتبة الجمهور، وKill Switch:
//  1) previewAudience: العدد + الكلفة = count × MARKETING_MSG_COST.
//  2) createBroadcast: قالب غير MARKETING أو غير APPROVED ⇒ رفض؛ قالب صالح ⇒ DRAFT بلقطة مطابقة للمعاينة.
//  3) launchBroadcast: جمهور > العتبة ⇒ PENDING_APPROVAL (لا RUNNING)؛ ≤ العتبة ⇒ RUNNING فوراً.
//  4) approveBroadcast: SOD صارم بلا استثناء admin — نفس المُنشئ (حتى admin) ⇒ FORBIDDEN؛ فاعل آخر ⇒ RUNNING.
//  5) killSwitch مفعّل ⇒ رفض الإطلاق/الاعتماد بـBAD_REQUEST.
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";
import type { Actor } from "../tx";
import {
  MARKETING_MSG_COST,
  approveBroadcast,
  createBroadcast,
  launchBroadcast,
  previewAudience,
  type CreateBroadcastInput,
} from "../whatsapp/broadcastService";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const TABLES = ["waBroadcastRecipients", "waBroadcasts", "waTemplates", "waHubSettings", "customers", "users", "branches"];

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

const managerA: Actor = { userId: 2, branchId: 1, role: "manager" };
const managerB: Actor = { userId: 3, branchId: 1, role: "manager" };
const adminActor: Actor = { userId: 1, branchId: 1, role: "admin" };

async function seedBase(opts: { campaignApprovalThreshold?: number; killSwitch?: boolean } = {}) {
  await db().insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await db().insert(s.users).values([
    { id: 1, openId: "admin", name: "المدير العام", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "mgrA", name: "مديرة أ", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "mgrB", name: "مدير ب", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
  await db().insert(s.waHubSettings).values({
    id: 1,
    campaignApprovalThreshold: opts.campaignApprovalThreshold ?? 500,
    killSwitch: opts.killSwitch ?? false,
  });
  await db().insert(s.waTemplates).values([
    { id: 1, name: "promo_sale", language: "ar", category: "MARKETING", templateStatus: "APPROVED", bodyText: "عرض خاص لك {{1}}", variableCount: 1 },
    { id: 2, name: "order_ready", language: "ar", category: "UTILITY", templateStatus: "APPROVED", bodyText: "طلبك جاهز" },
    { id: 3, name: "promo_draft", language: "ar", category: "MARKETING", templateStatus: "PENDING", bodyText: "قيد المراجعة" },
  ]);
}

async function seedCustomers(count: number, startId = 1) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    name: `عميل ${startId + i}`,
    phone: `07${String(70000000 + startId + i).padStart(9, "0")}`,
    customerType: "فرد" as const,
  }));
  await db().insert(s.customers).values(rows);
}

const baseSegment = { customerTypes: ["فرد"] };

function baseCreateInput(overrides: Partial<CreateBroadcastInput> = {}): CreateBroadcastInput {
  return {
    name: "حملة العروض",
    branchId: 1,
    templateId: 1,
    segment: baseSegment,
    ...overrides,
  };
}

beforeEach(async () => {
  await reset();
});

describe("previewAudience", () => {
  it("العدد + الكلفة = count × MARKETING_MSG_COST", async () => {
    await seedBase();
    await seedCustomers(4);
    const res = await previewAudience(baseSegment);
    expect(res.audienceCount).toBe(4);
    expect(res.costEstimate).toBe(toDbMoney(money(MARKETING_MSG_COST).mul(4)));
  });

  it("شريحة فارغة ⇒ عدد صفر وكلفة صفر", async () => {
    await seedBase();
    const res = await previewAudience({ customerTypes: ["حكومي"] });
    expect(res.audienceCount).toBe(0);
    expect(res.costEstimate).toBe("0.00");
  });
});

describe("createBroadcast", () => {
  it("قالب ليس من فئة MARKETING ⇒ رفض BAD_REQUEST", async () => {
    await seedBase();
    await seedCustomers(2);
    await expect(createBroadcast(baseCreateInput({ templateId: 2 }), managerA)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("قالب MARKETING لكن غير APPROVED (PENDING) ⇒ رفض BAD_REQUEST", async () => {
    await seedBase();
    await seedCustomers(2);
    await expect(createBroadcast(baseCreateInput({ templateId: 3 }), managerA)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("قالب صالح (MARKETING+APPROVED) ⇒ DRAFT بلقطة audienceCount/costEstimate مطابقة للمعاينة", async () => {
    await seedBase();
    await seedCustomers(6);
    const preview = await previewAudience(baseSegment);
    const res = await createBroadcast(baseCreateInput(), managerA);
    expect(res.audienceCount).toBe(preview.audienceCount);
    expect(res.costEstimate).toBe(preview.costEstimate);

    const row = (await db().select().from(s.waBroadcasts).where(sql`id = ${res.broadcastId}`))[0];
    expect(row.broadcastStatus).toBe("DRAFT");
    expect(row.createdBy).toBe(managerA.userId);
    expect(Number(row.audienceCount)).toBe(6);
  });
});

describe("launchBroadcast — عتبة الاعتماد", () => {
  it("جمهور > العتبة ⇒ PENDING_APPROVAL (لا يُطلَق)", async () => {
    await seedBase({ campaignApprovalThreshold: 3 });
    await seedCustomers(5);
    const created = await createBroadcast(baseCreateInput(), managerA);
    const res = await launchBroadcast(created.broadcastId, managerA);
    expect(res.status).toBe("PENDING_APPROVAL");
    const row = (await db().select().from(s.waBroadcasts).where(sql`id = ${created.broadcastId}`))[0];
    expect(row.broadcastStatus).toBe("PENDING_APPROVAL");
    expect(row.startedAt).toBeNull();
  });

  it("جمهور ≤ العتبة ⇒ RUNNING فوراً + startedAt", async () => {
    await seedBase({ campaignApprovalThreshold: 10 });
    await seedCustomers(3);
    const created = await createBroadcast(baseCreateInput(), managerA);
    const res = await launchBroadcast(created.broadcastId, managerA);
    expect(res.status).toBe("RUNNING");
    const row = (await db().select().from(s.waBroadcasts).where(sql`id = ${created.broadcastId}`))[0];
    expect(row.broadcastStatus).toBe("RUNNING");
    expect(row.startedAt).not.toBeNull();
  });

  it("إطلاق ثانٍ لبثٍّ RUNNING بالفعل ⇒ BAD_REQUEST", async () => {
    await seedBase({ campaignApprovalThreshold: 10 });
    await seedCustomers(1);
    const created = await createBroadcast(baseCreateInput(), managerA);
    await launchBroadcast(created.broadcastId, managerA);
    await expect(launchBroadcast(created.broadcastId, managerA)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("approveBroadcast — فصل المهام (SOD) صارم بلا استثناء admin", () => {
  it("نفس المُنشئ (مدير) يحاول اعتماد بثّه ⇒ FORBIDDEN", async () => {
    await seedBase({ campaignApprovalThreshold: 3 });
    await seedCustomers(5);
    const created = await createBroadcast(baseCreateInput(), managerA);
    await launchBroadcast(created.broadcastId, managerA); // ⇒ PENDING_APPROVAL
    await expect(approveBroadcast(created.broadcastId, managerA)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("مدير آخر يعتمد ⇒ RUNNING + approvedBy", async () => {
    await seedBase({ campaignApprovalThreshold: 3 });
    await seedCustomers(5);
    const created = await createBroadcast(baseCreateInput(), managerA);
    await launchBroadcast(created.broadcastId, managerA);
    const res = await approveBroadcast(created.broadcastId, managerB);
    expect(res.status).toBe("RUNNING");
    const row = (await db().select().from(s.waBroadcasts).where(sql`id = ${created.broadcastId}`))[0];
    expect(row.broadcastStatus).toBe("RUNNING");
    expect(row.approvedBy).toBe(managerB.userId);
    expect(row.startedAt).not.toBeNull();
  });

  it("admin يحاول اعتماد بثّه الخاصّ ⇒ FORBIDDEN أيضاً (بلا استثناء، خلافاً لنمط السندات)", async () => {
    await seedBase({ campaignApprovalThreshold: 3 });
    await seedCustomers(5);
    const created = await createBroadcast(baseCreateInput(), adminActor);
    await launchBroadcast(created.broadcastId, adminActor);
    await expect(approveBroadcast(created.broadcastId, adminActor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // admin آخر (لو وُجد) أو مدير مختلف يستطيع الاعتماد — نتحقّق أن مديراً مختلفاً ينجح.
    const res = await approveBroadcast(created.broadcastId, managerA);
    expect(res.status).toBe("RUNNING");
  });

  it("اعتماد بثّ ليس بانتظار الموافقة ⇒ BAD_REQUEST", async () => {
    await seedBase({ campaignApprovalThreshold: 10 });
    await seedCustomers(2);
    const created = await createBroadcast(baseCreateInput(), managerA);
    await launchBroadcast(created.broadcastId, managerA); // ⇒ RUNNING مباشرة (ضمن العتبة)
    await expect(approveBroadcast(created.broadcastId, managerB)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("killSwitch — يوقف الإطلاق/الاعتماد الآليّ كليّاً", () => {
  it("killSwitch مفعّل ⇒ رفض الإطلاق بـBAD_REQUEST", async () => {
    await seedBase({ campaignApprovalThreshold: 10, killSwitch: true });
    await seedCustomers(2);
    const created = await createBroadcast(baseCreateInput(), managerA);
    await expect(launchBroadcast(created.broadcastId, managerA)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("killSwitch مفعّل ⇒ رفض الاعتماد أيضاً بـBAD_REQUEST", async () => {
    // نُفعّل الإطلاق أولاً (Kill Switch مطفأ) ليصل PENDING_APPROVAL، ثم نُفعّل Kill Switch ونحاول الاعتماد.
    await seedBase({ campaignApprovalThreshold: 3, killSwitch: false });
    await seedCustomers(5);
    const created = await createBroadcast(baseCreateInput(), managerA);
    await launchBroadcast(created.broadcastId, managerA); // ⇒ PENDING_APPROVAL
    await db().update(s.waHubSettings).set({ killSwitch: true }).where(sql`id = 1`);
    await expect(approveBroadcast(created.broadcastId, managerB)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
