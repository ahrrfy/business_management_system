import cron, { type ScheduledTask } from "node-cron";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { deliveryConsignments, deliveryEvents, deliveryOutbox, deliveryPartyMembers, users } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { logger } from "../../logger";
import { isBackgroundOperationActive, runAcrossActiveTenants } from "../../tenancy/backgroundTenants";
import { createAppNotification } from "../appNotificationService";
import { withTx } from "../tx";
import { STALE_ESCALATED_EVENT, sweepStaleConsignments } from "./staleSweep";

const BATCH_SIZE = 40;

/**
 * حدّ أعلى لمحاولات الصفّ قبل نقله إلى DEAD_LETTER (Tier-1 #1، ٢٥/٨). ١٠ محاولات × مؤخّرة ٥ دقائق
 * = ~٥٠ دقيقة إعادة محاولة مشروعة قبل الاستنتاج بأنّ الصفّ سامّ. يخرج بعد ذلك من الطابور تلقائياً
 * وينتظر إجراءً إدارياً صريحاً (`delivery.requeueDeadLetter`).
 */
const MAX_ATTEMPTS = 10;

/** وجهتا الإشعار: بوّابة المندوب لمن يملكها، وشاشة «قيد التوصيل» لموظّفي المكتبة. */
const PORTAL_ROUTE = "/my-deliveries";
const TRANSIT_ROUTE = "/delivery?tab=transit";

async function claimBatch(): Promise<number[]> {
  return withTx(async (tx) => {
    // شرط status='PENDING' يخرج الصفوف المستنفَدة من الطابور فوراً (Tier-1 #1، ٢٥/٨).
    const rows = await tx.select({ id: deliveryOutbox.id }).from(deliveryOutbox)
      .where(and(
        eq(deliveryOutbox.status, "PENDING"),
        isNull(deliveryOutbox.processedAt),
        lte(deliveryOutbox.availableAt, sql`NOW()`),
      ))
      .orderBy(asc(deliveryOutbox.id)).limit(BATCH_SIZE)
      .for("update", { skipLocked: true });
    const ids = rows.map((r) => Number(r.id));
    if (ids.length) {
      // زيادةُ العدّاد + تأجيل ٥ دقائق **مع** نقلٍ إلى DEAD_LETTER عند بلوغ الحدّ. تنفيذٌ ذرّيّ
      // في UPDATE واحد كي لا نُبقي نافذةً بين الفحص والنقل تظلّ فيها الصفوف مسحوبةً مرّةً أخرى.
      await tx.update(deliveryOutbox).set({
        attempts: sql`${deliveryOutbox.attempts} + 1`,
        availableAt: sql`DATE_ADD(NOW(), INTERVAL 5 MINUTE)`,
        status: sql`CASE WHEN ${deliveryOutbox.attempts} + 1 >= ${MAX_ATTEMPTS} THEN 'DEAD_LETTER' ELSE 'PENDING' END`,
        deadLetteredAt: sql`CASE WHEN ${deliveryOutbox.attempts} + 1 >= ${MAX_ATTEMPTS} THEN NOW() ELSE NULL END`,
      }).where(inArray(deliveryOutbox.id, ids));
    }
    return ids;
  });
}

/**
 * مديرو فرع الإرسالية — مستقبِلو الحقيقة حين لا بوّابة للجهة. نفس نمط جلب المعتمِدين في
 * `inventoryRouter` (نشط + مدير الفرع نفسه)، مع الرجوع إلى admin **فقط** إن خلا الفرع من
 * مدير — الغاية منعُ تبخّر الإشعار لا نسخُه لكل إداريّ.
 */
async function branchManagerIds(branchId: number): Promise<number[]> {
  const db = getDb();
  if (!db) return [];
  const managers = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.isActive, true), eq(users.role, "manager"), eq(users.branchId, branchId)));
  if (managers.length) return Array.from(new Set(managers.map((m) => Number(m.id))));
  const admins = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.isActive, true), or(eq(users.role, "admin"), eq(users.isOwner, true))));
  return Array.from(new Set(admins.map((m) => Number(m.id))));
}

type RecipientPlan = { userIds: number[]; route: string };

async function recipientsFor(row: {
  topic: string;
  eventType: string;
  partyId: number;
  assignedUserId: number | null;
  branchId: number;
}): Promise<RecipientPlan> {
  // تصعيد الجمود يذهب لمديري الفرع **دائماً**: جوهره «الجهة صامتة» — فإشعار أعضائها الصامتين
  // أنفسِهم (إن وُجدوا) لا يُحرّك شيئاً، والحسم فعلُ موظّفٍ من شاشة «قيد التوصيل».
  if (row.eventType === STALE_ESCALATED_EVENT) {
    return { userIds: await branchManagerIds(row.branchId), route: TRANSIT_ROUTE };
  }
  if (row.assignedUserId != null && (row.topic === "delivery.assigned" || row.topic === "delivery.reassigned")) {
    return { userIds: [row.assignedUserId], route: PORTAL_ROUTE };
  }
  const db = getDb();
  if (!db) return { userIds: [], route: PORTAL_ROUTE };
  const roles = row.topic === "delivery.assigned" || row.topic === "delivery.reassigned"
    ? ["DRIVER" as const]
    : row.topic === "delivery.failed"
      ? ["MANAGER" as const]
      : row.topic.includes("money") || row.topic === "delivery.delivered"
        ? ["MANAGER" as const, "ACCOUNTANT" as const]
        : [];
  if (!roles.length) return { userIds: [], route: PORTAL_ROUTE };
  const members = await db.select({ userId: deliveryPartyMembers.userId }).from(deliveryPartyMembers)
    .where(and(
      eq(deliveryPartyMembers.partyId, row.partyId),
      eq(deliveryPartyMembers.isActive, true),
      inArray(deliveryPartyMembers.memberRole, roles),
    ));
  const memberIds = Array.from(new Set(members.map((m) => Number(m.userId))));
  if (memberIds.length) return { userIds: memberIds, route: PORTAL_ROUTE };
  // ٢٢/٨ — سدّ تبخّر الإشعارات: جهةٌ بلا أعضاء بوّابة كانت تُرجع قائمةً فارغة فيُختم الصفّ
  // processed **وكأنّ أحداً أُبلغ** — تعذّرُ تسليمٍ أو تسليمٌ بلا توريدٍ يمرّ بصمتٍ تامّ.
  // الحقيقة تتحوّل لمديري فرع الإرسالية، ووجهتُهم شاشةُ المتابعة لا بوّابة مندوبٍ لا يملكونها.
  return { userIds: await branchManagerIds(row.branchId), route: TRANSIT_ROUTE };
}

async function processRow(id: number): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    const row = (await db.select({
      id: deliveryOutbox.id,
      eventId: deliveryOutbox.eventId,
      topic: deliveryOutbox.topic,
      consignmentId: deliveryEvents.consignmentId,
      eventType: deliveryEvents.eventType,
      partyId: deliveryConsignments.partyId,
      branchId: deliveryConsignments.branchId,
      assignedUserId: deliveryConsignments.assignedUserId,
      consignmentNumber: deliveryConsignments.consignmentNumber,
    }).from(deliveryOutbox)
      .innerJoin(deliveryEvents, eq(deliveryEvents.id, deliveryOutbox.eventId))
      .innerJoin(deliveryConsignments, eq(deliveryConsignments.id, deliveryEvents.consignmentId))
      .where(and(eq(deliveryOutbox.id, id), isNull(deliveryOutbox.processedAt))).limit(1))[0];
    if (!row) return;
    const plan = await recipientsFor({
      topic: row.topic,
      eventType: row.eventType,
      partyId: Number(row.partyId),
      assignedUserId: row.assignedUserId != null ? Number(row.assignedUserId) : null,
      branchId: Number(row.branchId),
    });
    const isStale = row.eventType === STALE_ESCALATED_EVENT;
    const title = isStale
      ? "طرد توصيل جامد يحتاج متابعة"
      : row.topic === "delivery.failed" ? "تعذر توصيل طرد" : row.topic === "delivery.delivered" ? "تم تسليم طرد" : "تحديث طرد توصيل";
    for (const userId of plan.userIds) {
      await createAppNotification({
        userId,
        kind: row.topic === "delivery.failed" || isStale ? "APPROVAL_REQUIRED" : "TASK_ASSIGNED",
        title,
        body: `${row.consignmentNumber} — ${row.eventType}`,
        route: plan.route,
        eventKey: `delivery-outbox:${row.eventId}:user:${userId}`,
        entityType: "deliveryConsignment",
        entityId: Number(row.consignmentId),
        requiresAction: row.topic === "delivery.failed" || row.topic === "delivery.assigned" || row.topic === "delivery.reassigned" || isStale,
        push: true,
      });
    }
    await db.update(deliveryOutbox).set({ processedAt: new Date(), lastError: null }).where(eq(deliveryOutbox.id, id));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(deliveryOutbox).set({ lastError: message.slice(0, 500) }).where(eq(deliveryOutbox.id, id));
    throw error;
  }
}

export async function sweepDeliveryOutboxOnce(): Promise<{ claimed: number }> {
  if (!isBackgroundOperationActive("delivery_outbox")) {
    const runs = await runAcrossActiveTenants("delivery_outbox", sweepDeliveryOutboxOnce);
    return { claimed: runs.reduce((sum, r) => sum + r.claimed, 0) };
  }
  const ids = await claimBatch();
  for (const id of ids) {
    try { await processRow(id); } catch (error) { logger.error({ err: error, outboxId: id }, "delivery outbox processing failed"); }
  }
  return { claimed: ids.length };
}

let task: ScheduledTask | null = null;
let running = false;
/** ختم آخر تشغيلٍ للكنّاس (بالذاكرة): دورة الـcron دقيقيّة والكنّاس ساعيّ على الأكثر. */
let lastStaleSweepAtMs = 0;

const STALE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export function startDeliveryOutboxWorker(): void {
  if (process.env.NODE_ENV === "test") return;
  task?.stop();
  void sweepDeliveryOutboxOnce().catch((error) => logger.error({ err: error }, "delivery outbox startup sweep failed"));
  // إزاحة طور (فحص الحمل ٣١/٨/٢٦): الثانية ٢٥ — تباعدٌ عن كنّاس واتساب (٥) والحجوزات (٤٥).
  task = cron.schedule("25 * * * * *", async () => {
    if (running) return;
    running = true;
    try {
      await sweepDeliveryOutboxOnce();
      // كنّاس الجمود يركب نفس الدورة (لا cron ثانٍ يُدار): الختم يُقدَّم قبل التنفيذ عمداً —
      // فشلُه لا يتحوّل إعادةَ محاولةٍ كلّ دقيقة، والإيقاع «مرّة كل ساعة على الأكثر» يصمد.
      if (Date.now() - lastStaleSweepAtMs >= STALE_SWEEP_INTERVAL_MS) {
        lastStaleSweepAtMs = Date.now();
        try {
          await sweepStaleConsignments();
        } catch (error) {
          logger.error({ err: error }, "delivery stale sweep failed");
        }
      }
    } finally { running = false; }
  }, { timezone: "UTC" });
}

export function stopDeliveryOutboxWorker(): void {
  task?.stop();
  task = null;
}
