/**
 * خدمة الحملات — البث التسويقي عبر واتساب (S5، T5.1): معاينة الجمهور/الكلفة، إنشاء بثّ (DRAFT)،
 * إطلاقه (باعتماد ثانٍ إلزامي فوق عتبة حجم الجمهور)، اعتماد البثّ المُعلَّق، الإيقاف المؤقّت/الإلغاء،
 * والعرض. **لا تقطير هنا** — إدراج `waBroadcastRecipients` وإرسالها الفعلي عبر `waOutbox` مؤجَّل
 * إلى T5.2 (`launchBroadcast`/`approveBroadcast` ينقلان الحالة إلى RUNNING فقط؛ القاطع الآلي
 * يستهلك RUNNING لاحقاً).
 *
 * **SOD الحملات (قرار مالك موثَّق في تكليف T5.1 — يخالف عمداً نمط السندات المعتاد):** اعتماد بثٍّ
 * مُعلَّق (`approveBroadcast`) يتطلّب فاعلاً مختلفاً عن المُنشئ **دائماً بلا استثناء لـadmin** —
 * خلافاً لـ`approveVoucher`/`rejectVoucher` (SOD-04) اللذين يُعفيان الأدمن للتصحيح الإداري. القرار
 * هنا: خطر إساءة استعمال بثٍّ تسويقيٍّ جماعيٍّ (يصل آلاف العملاء دفعة واحدة، ويهدّد جودة الرقم عند
 * Meta) أعلى من الحاجة لمرونة تصحيح إداري فردي.
 */
import { TRPCError } from "@trpc/server";
import { eq, isNull, or, sql } from "drizzle-orm";
import { waBroadcastRecipients, waBroadcasts, waTemplates, type WaTemplate } from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { type Actor, requireDb, withTx } from "../tx";
import { money, toDbMoney } from "../money";
import { getWaHubSettings } from "./flowNotify";
import { resolveSegmentCount, type SegmentCriteria } from "./segmentService";
import { getUsableTemplate } from "./templateService";

type DbOrTx = DB | Tx;

/**
 * تقدير كلفة الرسالة التسويقية الواحدة (د.ع) — Meta تسعّر فعلياً بالرسالة المُسلَّمة، حسب فئة
 * القالب وبلد المستلم (العراق له بطاقة أسعار خاصة تُثبَّت وقت تسجيل الحساب فعلياً — راجع
 * `docs/whatsapp-hub-design-2026-07-23.md` §ح). **ثابتٌ تقديريّ مؤقّت** بانتظار رقم حيّ — يُستبدَل
 * لاحقاً بحقل مضبوط في `waHubSettings` بمجرّد توفّر بطاقة الأسعار الفعلية (S6/متابعة).
 */
export const MARKETING_MSG_COST = "100";

// ── معاينة الجمهور والكلفة ───────────────────────────────────────────────────────────────────

export interface PreviewAudienceResult {
  audienceCount: number;
  costEstimate: string;
}

export async function previewAudience(criteria: SegmentCriteria, runner: DbOrTx = requireDb()): Promise<PreviewAudienceResult> {
  const audienceCount = await resolveSegmentCount(criteria, runner);
  const costEstimate = toDbMoney(money(MARKETING_MSG_COST).mul(audienceCount));
  return { audienceCount, costEstimate };
}

// ── التحقّق من القالب (MARKETING + APPROVED فعلياً عند Meta) ───────────────────────────────────

async function assertMarketingTemplate(templateId: number, runner: DbOrTx): Promise<WaTemplate> {
  const row = (await runner.select().from(waTemplates).where(eq(waTemplates.id, templateId)).limit(1))[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "القالب غير موجود" });
  if (row.category !== "MARKETING") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "يجب اختيار قالب من فئة «تسويقي» (Marketing) للبث التسويقي" });
  }
  // إعادة تحقّق من الحالة الحيّة عبر getUsableTemplate (لا نكتفي بحالة الصفّ المحلي — دفاعٌ إضافي
  // ضد سباق نادر بين اختيار القالب والحفظ، وإعادة استعمال منطق موحّد مع بقية الأتمتة).
  const usable = await getUsableTemplate(row.name, row.language);
  if (!usable) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "القالب غير معتمَد بعد عند Meta — لا يمكن استعماله للبث" });
  }
  return usable;
}

// ── عزل الفرع لعمليات الكتابة على بثّ قائم ──────────────────────────────────────────────────────

/** نمط `crmCampaigns`/`crmRouter` (البث فوق نفس عالم الحملات): بثّ عامّ (`branchId=null`، كل
 *  الفروع) محصور بالأدمن فقط — مديرُ فرعٍ واحد لا يتحكّم ببثٍّ يشمل كل الفروع. */
function assertBroadcastBranchAccess(actor: Actor, broadcastBranchId: number | null): void {
  if (actor.role === "admin") return;
  if (broadcastBranchId == null) {
    throw new TRPCError({ code: "FORBIDDEN", message: "هذا بثّ عامّ لكل الفروع — يلزم صلاحية أدمن للتحكّم به" });
  }
  if (actor.branchId == null || Number(broadcastBranchId) !== Number(actor.branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "هذا البثّ لا يتبع فرعك" });
  }
}

/**
 * تأكيد دفاعيّ إضافي (T5.1، إصلاح ثغرة عزل فرع الشريحة): الراوتر (`broadcastsRouter.ts`) صار يفرض
 * `segment.branchId = فرع المستخدم` لغير الأدمن وقت `create`، فيُفترَض أن `segmentJson` المخزَّن
 * دائماً متّسق مع فرع البثّ لصفوفٍ أُنشئت بعد هذا الإصلاح. هذا الفحص **لا يعتمد على ذلك الافتراض
 * وحده** — يحمي من صفوفٍ سابقة على الإصلاح (لو وُجدت) أو أي مسار كتابة مستقبليّ يُخالفه: عند إعادة
 * حساب الجمهور هنا (`launchBroadcast`/`approveBroadcast`)، إن كان الفاعل غير أدمن ولم يطابق
 * `segmentJson.branchId` فرعه (بما في ذلك شريحة عامة `null`) — يُرفَض بـFORBIDDEN بدل حساب جمهور
 * فرعٍ آخر صامتاً. (يُستدعى بعد `assertBroadcastBranchAccess` التي تضمن أصلاً أن `row.branchId`
 * يطابق فرع الفاعل لغير الأدمن — فمقارنة segBranchId بفرع الفاعل مكافئة لمقارنته بـrow.branchId.)
 */
function assertSegmentBranchMatchesActor(actor: Actor, criteria: SegmentCriteria): void {
  if (actor.role === "admin") return;
  const segBranchId = criteria.branchId == null ? null : Number(criteria.branchId);
  if (segBranchId == null || segBranchId !== Number(actor.branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "شريحة هذا البثّ لا تطابق فرعك — يلزم صلاحية أدمن." });
  }
}

// ── إنشاء بثّ (DRAFT بلقطة معاينة) ───────────────────────────────────────────────────────────

export interface CreateBroadcastInput {
  name: string;
  /** null = كل الفروع؛ الراوتر يحلّها مسبقاً (نمط `ownBranch` في crmRouter) قبل الوصول هنا. */
  branchId?: number | null;
  crmCampaignId?: number | null;
  templateId: number;
  varsMapJson?: Record<string, string> | null;
  segment: SegmentCriteria;
  throttlePerMinute?: number;
  scheduledAt?: Date | null;
}

export interface CreateBroadcastResult {
  broadcastId: number;
  audienceCount: number;
  costEstimate: string;
}

export async function createBroadcast(input: CreateBroadcastInput, actor: Actor): Promise<CreateBroadcastResult> {
  const template = await assertMarketingTemplate(input.templateId, requireDb());
  const { audienceCount, costEstimate } = await previewAudience(input.segment);
  const broadcastId = await withTx(async (tx) => {
    const res = await tx.insert(waBroadcasts).values({
      branchId: input.branchId ?? null,
      crmCampaignId: input.crmCampaignId ?? null,
      name: input.name,
      templateId: input.templateId,
      templateLang: template.language,
      varsMapJson: input.varsMapJson ?? null,
      segmentJson: input.segment,
      broadcastStatus: "DRAFT",
      audienceCount,
      costEstimate,
      throttlePerMinute: input.throttlePerMinute ?? 10,
      scheduledAt: input.scheduledAt ?? null,
      createdBy: actor.userId,
    });
    return extractInsertId(res);
  });
  return { broadcastId, audienceCount, costEstimate };
}

// ── الإطلاق (SOD فوق العتبة) ──────────────────────────────────────────────────────────────────

export type LaunchBroadcastStatus = "RUNNING" | "PENDING_APPROVAL";

export interface LaunchBroadcastResult {
  status: LaunchBroadcastStatus;
  audienceCount: number;
}

/** يُطلق بثّاً DRAFT/APPROVED: يعيد حساب الجمهور حيّاً (اللقطة عند الإنشاء قد تكون قديمة)، ثم إمّا
 *  RUNNING فوراً (APPROVED مسبقاً، أو DRAFT ضمن العتبة) أو PENDING_APPROVAL (DRAFT فوق العتبة —
 *  بانتظار `approveBroadcast` من فاعل آخر). */
export async function launchBroadcast(broadcastId: number, actor: Actor): Promise<LaunchBroadcastResult> {
  const settings = await getWaHubSettings();
  if (settings.killSwitch) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الإرسال الآلي موقوف (Kill Switch)." });
  }
  return withTx(async (tx) => {
    const row = (await tx.select().from(waBroadcasts).where(eq(waBroadcasts.id, broadcastId)).for("update").limit(1))[0];
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "البثّ غير موجود" });
    // فحص الفرع أولاً (قبل أي رسالة تكشف حالة البثّ) — نمط الفحص المبكر: مستخدم فرعٍ آخر يجب أن
    // يُصدَم بـFORBIDDEN لا برسالة BAD_REQUEST تسرّب أن البثّ موجود وبأيّ حالة.
    assertBroadcastBranchAccess(actor, row.branchId == null ? null : Number(row.branchId));
    if (row.broadcastStatus !== "DRAFT" && row.broadcastStatus !== "APPROVED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: `لا يمكن إطلاق بثّ بحالة ${row.broadcastStatus}` });
    }

    const criteria = row.segmentJson as SegmentCriteria;
    assertSegmentBranchMatchesActor(actor, criteria);
    const audienceCount = await resolveSegmentCount(criteria, tx);
    const costEstimate = toDbMoney(money(MARKETING_MSG_COST).mul(audienceCount));

    if (row.broadcastStatus === "DRAFT" && audienceCount > settings.campaignApprovalThreshold) {
      await tx
        .update(waBroadcasts)
        .set({ broadcastStatus: "PENDING_APPROVAL", audienceCount, costEstimate })
        .where(eq(waBroadcasts.id, broadcastId));
      return { status: "PENDING_APPROVAL" as const, audienceCount };
    }

    await tx
      .update(waBroadcasts)
      .set({ broadcastStatus: "RUNNING", audienceCount, costEstimate, startedAt: new Date() })
      .where(eq(waBroadcasts.id, broadcastId));
    return { status: "RUNNING" as const, audienceCount };
  });
}

// ── اعتماد بثّ مُعلَّق (SOD صارم — بلا استثناء admin) ───────────────────────────────────────────

export interface ApproveBroadcastResult {
  status: "RUNNING";
  audienceCount: number;
}

export async function approveBroadcast(broadcastId: number, actor: Actor): Promise<ApproveBroadcastResult> {
  const settings = await getWaHubSettings();
  if (settings.killSwitch) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الإرسال الآلي موقوف (Kill Switch)." });
  }
  return withTx(async (tx) => {
    const row = (await tx.select().from(waBroadcasts).where(eq(waBroadcasts.id, broadcastId)).for("update").limit(1))[0];
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "البثّ غير موجود" });
    // فحص الفرع أولاً (قبل أي رسالة تكشف حالة البثّ أو علاقة المُنشئ) — نمط الفحص المبكر: مستخدم
    // فرعٍ آخر يجب أن يُصدَم بـFORBIDDEN لا برسالة BAD_REQUEST/SOD تسرّب معلومات عن البثّ.
    assertBroadcastBranchAccess(actor, row.branchId == null ? null : Number(row.branchId));
    if (row.broadcastStatus !== "PENDING_APPROVAL") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "البثّ ليس بانتظار الاعتماد" });
    }
    // SOD صارم للحملات: لا استثناء لـadmin (قرار مالك موثَّق — راجع رأس الملف).
    if (row.createdBy != null && Number(row.createdBy) === actor.userId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "لا يجوز اعتماد بثٍّ أنشأتَه بنفسك — يلزم فاعل آخر (فصل المهام، بلا استثناء).",
      });
    }

    // إعادة فحص العدد حيّاً وقت الاعتماد (اللقطة عند PENDING_APPROVAL قد تكون قديمة) — نمط
    // إعادة فحص سقف تسوية بضاعة الأمانة عند اعتماد السند (server/services/voucher/approval.ts).
    const criteria = row.segmentJson as SegmentCriteria;
    assertSegmentBranchMatchesActor(actor, criteria);
    const audienceCount = await resolveSegmentCount(criteria, tx);
    const costEstimate = toDbMoney(money(MARKETING_MSG_COST).mul(audienceCount));

    await tx
      .update(waBroadcasts)
      .set({ broadcastStatus: "RUNNING", approvedBy: actor.userId, audienceCount, costEstimate, startedAt: new Date() })
      .where(eq(waBroadcasts.id, broadcastId));
    return { status: "RUNNING" as const, audienceCount };
  });
}

// ── الإيقاف المؤقّت والإلغاء ──────────────────────────────────────────────────────────────────

export async function pauseBroadcast(broadcastId: number, reason: string, actor: Actor): Promise<{ status: "PAUSED" }> {
  return withTx(async (tx) => {
    const row = (await tx.select().from(waBroadcasts).where(eq(waBroadcasts.id, broadcastId)).for("update").limit(1))[0];
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "البثّ غير موجود" });
    if (row.broadcastStatus !== "RUNNING") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إيقاف بثّ مؤقّتاً إلا وهو قيد التشغيل" });
    }
    assertBroadcastBranchAccess(actor, row.branchId == null ? null : Number(row.branchId));
    const trimmedReason = reason.trim().slice(0, 200);
    if (!trimmedReason) throw new TRPCError({ code: "BAD_REQUEST", message: "سبب الإيقاف المؤقّت مطلوب" });
    await tx.update(waBroadcasts).set({ broadcastStatus: "PAUSED", pausedReason: trimmedReason }).where(eq(waBroadcasts.id, broadcastId));
    return { status: "PAUSED" as const };
  });
}

/** يستأنف بثّاً PAUSED (سواءً أوقفه فاعلٌ يدوياً عبر `pauseBroadcast` أو أوقفه قاطع الجودة الآلي في
 *  T5.2 `broadcastDispatch.dripRunningBroadcasts`) — يعيده RUNNING فيستكمل التقطير من حيث توقّف
 *  (`waBroadcastRecipients` المتبقّية PENDING/QUEUED لم تُمسّ أثناء الإيقاف). killSwitch مفعّل ⇒
 *  رفض (نمط launchBroadcast/approveBroadcast — لا استئناف إرسال آليّ والمفتاح مطفأ). */
export async function resumeBroadcast(broadcastId: number, actor: Actor): Promise<{ status: "RUNNING" }> {
  const settings = await getWaHubSettings();
  if (settings.killSwitch) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الإرسال الآلي موقوف (Kill Switch)." });
  }
  return withTx(async (tx) => {
    const row = (await tx.select().from(waBroadcasts).where(eq(waBroadcasts.id, broadcastId)).for("update").limit(1))[0];
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "البثّ غير موجود" });
    assertBroadcastBranchAccess(actor, row.branchId == null ? null : Number(row.branchId));
    if (row.broadcastStatus !== "PAUSED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن استئناف بثّ إلا وهو مُوقَّف مؤقّتاً" });
    }
    await tx.update(waBroadcasts).set({ broadcastStatus: "RUNNING", pausedReason: null }).where(eq(waBroadcasts.id, broadcastId));
    return { status: "RUNNING" as const };
  });
}

const CANCELLABLE_STATUSES = new Set(["DRAFT", "PENDING_APPROVAL", "APPROVED", "RUNNING", "PAUSED"]);

export async function cancelBroadcast(broadcastId: number, actor: Actor): Promise<{ status: "CANCELLED" }> {
  return withTx(async (tx) => {
    const row = (await tx.select().from(waBroadcasts).where(eq(waBroadcasts.id, broadcastId)).for("update").limit(1))[0];
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "البثّ غير موجود" });
    if (!CANCELLABLE_STATUSES.has(row.broadcastStatus)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `لا يمكن إلغاء بثّ بحالة ${row.broadcastStatus}` });
    }
    assertBroadcastBranchAccess(actor, row.branchId == null ? null : Number(row.branchId));
    await tx.update(waBroadcasts).set({ broadcastStatus: "CANCELLED", completedAt: new Date() }).where(eq(waBroadcasts.id, broadcastId));
    return { status: "CANCELLED" as const };
  });
}

// ── العرض (قراءة، عزل فرع في الراوتر عبر scopedBranchId) ───────────────────────────────────────

export interface BroadcastListRow {
  id: number;
  name: string;
  branchId: number | null;
  crmCampaignId: number | null;
  templateId: number;
  broadcastStatus: string;
  audienceCount: number;
  costEstimate: string;
  throttlePerMinute: number;
  scheduledAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  pausedReason: string | null;
  createdBy: number | null;
  approvedBy: number | null;
  createdAt: Date;
}

function normalizeRow(r: typeof waBroadcasts.$inferSelect): BroadcastListRow {
  return {
    id: Number(r.id),
    name: r.name,
    branchId: r.branchId == null ? null : Number(r.branchId),
    crmCampaignId: r.crmCampaignId == null ? null : Number(r.crmCampaignId),
    templateId: Number(r.templateId),
    broadcastStatus: r.broadcastStatus,
    audienceCount: Number(r.audienceCount),
    costEstimate: String(r.costEstimate),
    throttlePerMinute: Number(r.throttlePerMinute),
    scheduledAt: r.scheduledAt,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    pausedReason: r.pausedReason,
    createdBy: r.createdBy == null ? null : Number(r.createdBy),
    approvedBy: r.approvedBy == null ? null : Number(r.approvedBy),
    createdAt: r.createdAt,
  };
}

/** `branchId`: null (admin/manager بلا فلترة) أو رقم فرع ⇒ يعيد بثوث ذلك الفرع + البثوث العامة
 *  (branchId=null في الصفّ) — نمط `visibleBranch` في crmRouter. */
export async function listBroadcasts(opts: { branchId?: number | null } = {}): Promise<BroadcastListRow[]> {
  const db = requireDb();
  const where = opts.branchId == null ? undefined : or(isNull(waBroadcasts.branchId), eq(waBroadcasts.branchId, opts.branchId));
  const rows = await db.select().from(waBroadcasts).where(where).orderBy(sql`${waBroadcasts.id} DESC`);
  return rows.map(normalizeRow);
}

export interface BroadcastDetail extends BroadcastListRow {
  /** تجميع حالات المستلمين — فارغ في T5.1 (لا إدراج بعد؛ يمتلئ مع التقطير في T5.2). */
  recipientCounts: Record<string, number>;
}

export async function getBroadcast(id: number, opts: { branchId?: number | null } = {}): Promise<BroadcastDetail | null> {
  const db = requireDb();
  const row = (await db.select().from(waBroadcasts).where(eq(waBroadcasts.id, id)).limit(1))[0];
  if (!row) return null;
  if (opts.branchId != null && row.branchId != null && Number(row.branchId) !== opts.branchId) return null;
  const counts = await db
    .select({ status: waBroadcastRecipients.recipientStatus, cnt: sql<number>`COUNT(*)` })
    .from(waBroadcastRecipients)
    .where(eq(waBroadcastRecipients.broadcastId, id))
    .groupBy(waBroadcastRecipients.recipientStatus);
  const recipientCounts: Record<string, number> = {};
  for (const c of counts) recipientCounts[String(c.status)] = Number(c.cnt);
  return { ...normalizeRow(row), recipientCounts };
}

// ── النتائج (T5.2) — تجميع حالات المستلمين بنسب مئوية، لاستهلاك تقرير الحملات (T5.3/S6) ─────────

export interface BroadcastResults {
  broadcastId: number;
  audienceCount: number;
  totalRecipients: number;
  counts: Record<string, number>;
  /** نسبة كل حالة من totalRecipients — سلسلة "٪" بدقّتين عشريّتين (decimal.js — لا Number/parseFloat). */
  percentages: Record<string, string>;
}

/** تجميع نتائج بثٍّ (عدّ + نسب لكل recipientStatus) — لا يفلتر بالفرع (استهلاك تقريريّ خلف بوّابة
 *  التقارير في الراوتر؛ راجع broadcastsRouter.results). NOT_FOUND صريح بدل مصفوفة فارغة مُضلِّلة. */
export async function broadcastResults(broadcastId: number): Promise<BroadcastResults> {
  const db = requireDb();
  const broadcastRow = (await db.select({ audienceCount: waBroadcasts.audienceCount }).from(waBroadcasts).where(eq(waBroadcasts.id, broadcastId)).limit(1))[0];
  if (!broadcastRow) throw new TRPCError({ code: "NOT_FOUND", message: "البثّ غير موجود" });

  const counts = await db
    .select({ status: waBroadcastRecipients.recipientStatus, cnt: sql<number>`COUNT(*)` })
    .from(waBroadcastRecipients)
    .where(eq(waBroadcastRecipients.broadcastId, broadcastId))
    .groupBy(waBroadcastRecipients.recipientStatus);

  const countsMap: Record<string, number> = {};
  let totalRecipients = 0;
  for (const c of counts) {
    const n = Number(c.cnt);
    countsMap[String(c.status)] = n;
    totalRecipients += n;
  }
  const percentages: Record<string, string> = {};
  for (const [status, n] of Object.entries(countsMap)) {
    percentages[status] = totalRecipients > 0 ? money(n).mul(100).div(totalRecipients).toDecimalPlaces(2).toFixed(2) : "0.00";
  }

  return { broadcastId, audienceCount: Number(broadcastRow.audienceCount), totalRecipients, counts: countsMap, percentages };
}
