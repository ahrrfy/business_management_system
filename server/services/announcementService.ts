import { and, count, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { announcementReads, announcements, users } from "../../drizzle/schema";
import { requireDb } from "./tx";

/**
 * خدمة إعلانات الموظفين الداخلية — الإدارة تنشئ وتستهدف، والموظفون المستهدَفون يقرؤون/يُقرّون.
 * الاستهداف: ALL كل الموظفين · BRANCH فرعٌ بعينه · ROLE دورٌ بعينه.
 *
 * المرحلة ١ (هذه): نموذج البيانات + API + صلاحيات + إقرار + استهداف. **بلا تعميم إشعار** —
 * التوصيل (مركز الإشعارات داخل التطبيق + دفع أصيل بتنقيح ومزامنة قراءة صحيحين) يُبنى في المرحلة ٢
 * مع الواجهة الأصيلة، تجنّباً لدفعٍ يُهمله العميل الحاليّ صامتاً ولنموذج قراءة مزدوج.
 */

export type AnnouncementAudienceType = "ALL" | "BRANCH" | "ROLE";
export type AnnouncementPriority = "NORMAL" | "IMPORTANT" | "CRITICAL";

export interface CreateAnnouncementInput {
  title: string;
  body: string;
  priority?: AnnouncementPriority;
  audienceType: AnnouncementAudienceType;
  audienceBranchId?: number | null;
  audienceRole?: string | null;
  requiresAck?: boolean;
  expiresAt?: Date | null;
}

/** هل يُطابق جمهور الإعلان مستخدماً بعينه؟ (حارس القراءة/الإقرار.) */
function audienceMatchesUser(
  a: { audienceType: string; audienceBranchId: number | null; audienceRole: string | null },
  u: { role: string; branchId: number | null },
): boolean {
  if (a.audienceType === "ALL") return true;
  if (a.audienceType === "BRANCH") {
    return a.audienceBranchId != null && u.branchId != null && Number(u.branchId) === Number(a.audienceBranchId);
  }
  if (a.audienceType === "ROLE") return a.audienceRole != null && u.role === a.audienceRole;
  return false;
}

/** شرط SQL: الإعلانات الفعّالة غير المنتهية التي تستهدف هذا المستخدم. */
function targetingWhere(user: { role: string; branchId: number | null }) {
  const audienceClauses = [eq(announcements.audienceType, "ALL")];
  if (user.branchId != null) {
    audienceClauses.push(
      and(eq(announcements.audienceType, "BRANCH"), eq(announcements.audienceBranchId, Number(user.branchId)))!,
    );
  }
  audienceClauses.push(and(eq(announcements.audienceType, "ROLE"), eq(announcements.audienceRole, user.role))!);
  return and(
    eq(announcements.isActive, true),
    or(isNull(announcements.expiresAt), gt(announcements.expiresAt, new Date())),
    or(...audienceClauses),
  );
}

/** عدد الموظفين النشطين المستهدَفين (للعرض في الإدارة — لا تعميم فعليّ في المرحلة ١). */
async function countTargetedActiveUsers(
  audienceType: AnnouncementAudienceType,
  audienceBranchId: number | null,
  audienceRole: string | null,
): Promise<number> {
  const db = requireDb();
  const clauses = [eq(users.isActive, true)];
  if (audienceType === "BRANCH" && audienceBranchId != null) clauses.push(eq(users.branchId, audienceBranchId));
  if (audienceType === "ROLE" && audienceRole != null) clauses.push(sql`${users.role} = ${audienceRole}`);
  const [row] = await db.select({ n: count() }).from(users).where(and(...clauses));
  return Number(row?.n ?? 0);
}

export async function createAnnouncement(input: CreateAnnouncementInput, actorUserId: number) {
  const db = requireDb();
  const audienceBranchId = input.audienceType === "BRANCH" ? Number(input.audienceBranchId) : null;
  const audienceRole = input.audienceType === "ROLE" ? String(input.audienceRole ?? "") : null;
  if (input.audienceType === "BRANCH" && !audienceBranchId) throw new Error("يجب اختيار الفرع المستهدَف");
  if (input.audienceType === "ROLE" && !audienceRole) throw new Error("يجب اختيار الدور المستهدَف");
  if (input.expiresAt != null && input.expiresAt.getTime() <= Date.now()) {
    throw new Error("تاريخ انتهاء الإعلان يجب أن يكون في المستقبل");
  }

  const [res] = await db.insert(announcements).values({
    title: input.title.trim(),
    body: input.body.trim(),
    priority: input.priority ?? "NORMAL",
    audienceType: input.audienceType,
    audienceBranchId,
    audienceRole,
    requiresAck: input.requiresAck ?? false,
    createdBy: actorUserId,
    expiresAt: input.expiresAt ?? null,
  });
  const announcementId = Number((res as { insertId: number }).insertId);
  const recipientCount = await countTargetedActiveUsers(input.audienceType, audienceBranchId, audienceRole);
  return { id: announcementId, recipientCount };
}

/** قائمة الإدارة: الإعلانات (الأحدث أولاً) مع عدّادَي القراءة والإقرار. */
export async function listAnnouncements(opts?: { includeInactive?: boolean; limit?: number }) {
  const db = requireDb();
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const rows = await db
    .select()
    .from(announcements)
    .where(opts?.includeInactive ? sql`1 = 1` : eq(announcements.isActive, true))
    .orderBy(desc(announcements.createdAt))
    .limit(limit);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const counts = await db
    .select({
      announcementId: announcementReads.announcementId,
      readCount: sql<number>`count(*)`,
      ackCount: sql<number>`sum(case when ${announcementReads.acknowledgedAt} is not null then 1 else 0 end)`,
    })
    .from(announcementReads)
    .where(inArray(announcementReads.announcementId, ids))
    .groupBy(announcementReads.announcementId);
  const byId = new Map(counts.map((c) => [Number(c.announcementId), c]));
  return rows.map((r) => ({
    ...r,
    readCount: Number(byId.get(r.id)?.readCount ?? 0),
    ackCount: Number(byId.get(r.id)?.ackCount ?? 0),
  }));
}

/** تفاصيل الإدارة: إعلانٌ واحد + قائمة قرّائه (من قرأ/أقرّ ومتى). null إن لم يوجد. */
export async function getAnnouncementWithReaders(id: number) {
  const db = requireDb();
  const [row] = await db.select().from(announcements).where(eq(announcements.id, id)).limit(1);
  if (!row) return null;
  const readers = await db
    .select({
      userId: announcementReads.userId,
      userName: users.name,
      readAt: announcementReads.readAt,
      acknowledgedAt: announcementReads.acknowledgedAt,
    })
    .from(announcementReads)
    .innerJoin(users, eq(users.id, announcementReads.userId))
    .where(eq(announcementReads.announcementId, id))
    .orderBy(desc(announcementReads.readAt));
  return { announcement: row, readers };
}

/** تفعيل/تعطيل إعلان. يعيد false إن لم يوجد الصفّ (ليميّز الراوتر NOT_FOUND). */
export async function setAnnouncementActive(id: number, isActive: boolean): Promise<boolean> {
  const db = requireDb();
  const [res] = await db.update(announcements).set({ isActive }).where(eq(announcements.id, id));
  return Number((res as { affectedRows?: number }).affectedRows ?? 0) > 0;
}

/** إعلانات الموظف المستهدَفة (الأحدث أولاً) + عدّاد غير المقروء **الكامل** (غير مقيّد بالصفحة). */
export async function myAnnouncements(user: { id: number; role: string; branchId: number | null }, limit = 50) {
  const db = requireDb();
  const capped = Math.min(Math.max(limit, 1), 100);
  const rows = await db
    .select({
      id: announcements.id,
      title: announcements.title,
      body: announcements.body,
      priority: announcements.priority,
      requiresAck: announcements.requiresAck,
      createdAt: announcements.createdAt,
      expiresAt: announcements.expiresAt,
      readAt: announcementReads.readAt,
      acknowledgedAt: announcementReads.acknowledgedAt,
    })
    .from(announcements)
    .leftJoin(
      announcementReads,
      and(eq(announcementReads.announcementId, announcements.id), eq(announcementReads.userId, user.id)),
    )
    .where(targetingWhere({ role: user.role, branchId: user.branchId }))
    .orderBy(desc(announcements.createdAt))
    .limit(capped);
  // عدّاد غير المقروء الحقيقيّ (كل المستهدَف بلا صفّ قراءة، لا صفحة النتائج فقط).
  const [unread] = await db
    .select({ n: count() })
    .from(announcements)
    .leftJoin(
      announcementReads,
      and(eq(announcementReads.announcementId, announcements.id), eq(announcementReads.userId, user.id)),
    )
    .where(and(targetingWhere({ role: user.role, branchId: user.branchId }), isNull(announcementReads.readAt)));
  return { rows, unreadCount: Number(unread?.n ?? 0) };
}

/** يتحقّق أنّ الإعلان يستهدف المستخدم فعلاً (حارس IDOR)؛ يعيد صفّ الإعلان. */
async function assertTargeted(user: { id: number; role: string; branchId: number | null }, announcementId: number) {
  const db = requireDb();
  const [row] = await db.select().from(announcements).where(eq(announcements.id, announcementId)).limit(1);
  if (!row) throw new Error("الإعلان غير موجود");
  if (!audienceMatchesUser(row, { role: user.role, branchId: user.branchId })) {
    throw new Error("هذا الإعلان لا يخصّك");
  }
  return row;
}

export async function markAnnouncementRead(
  user: { id: number; role: string; branchId: number | null },
  announcementId: number,
) {
  const db = requireDb();
  await assertTargeted(user, announcementId);
  await db
    .insert(announcementReads)
    .values({ announcementId, userId: user.id })
    .onDuplicateKeyUpdate({ set: { announcementId } }); // no-op عند وجوده — يُبقي readAt الأصلي
}

export async function acknowledgeAnnouncement(
  user: { id: number; role: string; branchId: number | null },
  announcementId: number,
) {
  const db = requireDb();
  const row = await assertTargeted(user, announcementId);
  if (!row.requiresAck) throw new Error("هذا الإعلان لا يتطلّب إقراراً");
  if (!row.isActive) throw new Error("الإعلان غير فعّال");
  if (row.expiresAt != null && row.expiresAt.getTime() <= Date.now()) throw new Error("انتهت صلاحية الإعلان");
  const now = new Date();
  await db
    .insert(announcementReads)
    .values({ announcementId, userId: user.id, acknowledgedAt: now })
    .onDuplicateKeyUpdate({ set: { acknowledgedAt: now } });
}
