// تصفية خروج الموظف (offboarding clearance) — تقرير **قراءةٍ فقط** يجمع كل ما يربط الموظّف
// بالنظام قبل أن يترك العمل، من ستّ وحداتٍ مختلفة في استعلامٍ واحد.
//
// المشكلة التي يحلّها (فجوة §٥ في تدقيق ١٧/٧): ذمّة الموظّف موزّعةٌ على وحداتٍ لا تعرف
// بعضها — وردية مفتوحة في الورديات، عهدة أصولٍ في الأصول، سلفةٌ في الموارد البشرية، عمولةٌ
// معتمدةٌ لم تُصرَف في العمولات، عضويّة جهة توصيلٍ تمنحه بوّابة، وجلساتٌ حيّة تمنحه دخولاً.
// من يُنهي خدمته كان عليه تذكّر الستّ يدوياً؛ ونسيانُ واحدةٍ يعني نقداً في درجٍ مفتوح أو
// أصلاً لا يعود أو بوّابةً تبقى مفتوحة لمن غادر.
//
// ثوابت حاكمة:
//   ١) **لا يكتب شيئاً.** التصفية تشخيصٌ لا إجراء؛ كل بندٍ يحمل `resolvePath` يشير للشاشة
//      المخوَّلة بمعالجته (بحوكمتها وSODها). تكرارُ تلك الإجراءات هنا يخلق باباً ثانياً
//      بلا حوكمةٍ مكافئة — وهو ما تتجنّبه هذه الوحدة عمداً.
//   ٢) **BLOCKING مقابل WARNING**: الحاجز ما يترك أثراً مالياً أو مادّياً أو صلاحيةً قائمة؛
//      والتحذير ما يزول بإجراءٍ إداريّ بسيط (إبطال الجلسات).
//   ٣) كل الأموال نصوصٌ عبر decimal.js (§٥) — ممنوع Number/parseFloat على المال.
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import {
  commissionRunLines,
  commissionRuns,
  deliveryParties,
  deliveryPartyMembers,
  employeeAdvances,
  employees,
  fixedAssets,
  shifts,
  userSessions,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";
import type { CompanyBranchScope } from "../companyBranchScope";

export type ClearanceKey =
  | "OPEN_SHIFT"
  | "ASSET_CUSTODY"
  | "OUTSTANDING_ADVANCE"
  | "UNPAID_COMMISSION"
  | "DELIVERY_MEMBERSHIP"
  | "ACTIVE_SESSIONS";

export interface ClearanceItem {
  key: ClearanceKey;
  label: string;
  severity: "BLOCKING" | "WARNING";
  count: number;
  /** المبلغ المرتبط (نصّ decimal) — `null` لما لا مبلغ له. */
  amount: string | null;
  /** جهة الاتّجاه لمعالجته — الشاشة المخوَّلة بحوكمتها، لا إجراءٌ من هنا. */
  resolvePath: string;
  /** ماذا يفعل المسؤول عملياً. */
  resolveHint: string;
  details: string[];
}

export interface EmployeeClearance {
  employeeId: number;
  employeeName: string;
  userId: number | null;
  isActive: boolean;
  items: ClearanceItem[];
  /** لا بند حاجز ⇒ يجوز إنهاء الخدمة. التحذيرات لا تمنع. */
  clearedToExit: boolean;
  blockingCount: number;
}

function requireDb() {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL not set");
  return db;
}

/**
 * يجمع ذمّة الموظّف عبر الوحدات الستّ. الموظّف بلا `userId` (سجلّ موارد بشرية بلا حساب
 * دخول) تُتخطّى بنوده المرتبطة بالحساب — لا وردية ولا جلسات ولا عضوية توصيل ولا عمولة.
 */
export async function getEmployeeClearance(
  employeeId: number,
  scope: CompanyBranchScope = { branchId: null },
): Promise<EmployeeClearance> {
  const db = requireDb();
  const [emp] = await db
    .select({
      id: employees.id,
      userId: employees.userId,
      firstName: employees.firstName,
      lastName: employees.lastName,
      isActive: employees.isActive,
    })
    .from(employees)
    .where(
      scope.branchId == null
        ? eq(employees.id, employeeId)
        : and(eq(employees.id, employeeId), eq(employees.branchId, scope.branchId)),
    )
    .limit(1);
  if (!emp) throw new Error("الموظّف غير موجود");

  const userId = emp.userId == null ? null : Number(emp.userId);
  const items: ClearanceItem[] = [];

  // ١) وردية مفتوحة — نقدٌ في درجٍ لا يُغلق بعد مغادرته.
  if (userId != null) {
    const openShifts = await db
      .select({ id: shifts.id, branchId: shifts.branchId, openedAt: shifts.openedAt })
      .from(shifts)
      .where(and(eq(shifts.userId, userId), eq(shifts.status, "OPEN")));
    if (openShifts.length) {
      items.push({
        key: "OPEN_SHIFT",
        label: "وردية مفتوحة",
        severity: "BLOCKING",
        count: openShifts.length,
        amount: null,
        resolvePath: "/shifts",
        resolveHint: "أغلق الوردية بعدّ النقد وتسليمه للخزينة قبل إنهاء الخدمة.",
        details: openShifts.map(
          (s) => `وردية #${Number(s.id)} — فرع ${Number(s.branchId)} — فُتحت ${new Date(s.openedAt).toISOString().slice(0, 16).replace("T", " ")}`,
        ),
      });
    }
  }

  // ٢) عهدة أصول — أصلٌ مادّيّ باسمه لا يعود تلقائياً.
  const custody = await db
    .select({ id: fixedAssets.id, name: fixedAssets.name, code: fixedAssets.code })
    .from(fixedAssets)
    .where(eq(fixedAssets.custodianId, employeeId));
  if (custody.length) {
    items.push({
      key: "ASSET_CUSTODY",
      label: "عهدة أصول",
      severity: "BLOCKING",
      count: custody.length,
      amount: null,
      resolvePath: "/assets",
      resolveHint: "انقل العهدة لموظّفٍ آخر أو أعِدها أصلاً عامّاً قبل إنهاء الخدمة.",
      details: custody.map((a) => `${a.name}${a.code ? ` (${a.code})` : ""}`),
    });
  }

  // ٣) سلفة قائمة — مالٌ للشركة عنده.
  const advances = await db
    .select({ id: employeeAdvances.id, remaining: employeeAdvances.remaining })
    .from(employeeAdvances)
    .where(
      and(
        eq(employeeAdvances.employeeId, employeeId),
        eq(employeeAdvances.status, "ACTIVE"),
        gt(employeeAdvances.remaining, "0"),
      ),
    );
  if (advances.length) {
    const total = advances.reduce((sum, a) => sum.plus(money(a.remaining)), money("0"));
    items.push({
      key: "OUTSTANDING_ADVANCE",
      label: "سلفة غير مسدَّدة",
      severity: "BLOCKING",
      count: advances.length,
      amount: toDbMoney(total),
      resolvePath: "/hr/advances",
      resolveHint: "تُخصَم من تسوية نهاية الخدمة أو تُسدَّد نقداً — لا تُترك معلَّقة.",
      details: advances.map((a) => `سلفة #${Number(a.id)} — المتبقّي ${toDbMoney(money(a.remaining))}`),
    });
  }

  // ٤) عمولة معتمدة لم تُصرَف — مالٌ للموظّف عند الشركة (الاتّجاه معاكس لكنه حاجزٌ أيضاً:
  //    من حقّه أن يُصرف قبل أن يُقفل ملفّه). التشغيلة المعتمدة بلا `payrollRunId` = غير مصروفة.
  if (userId != null) {
    const pending = await db
      .select({
        runId: commissionRuns.id,
        period: commissionRuns.period,
        amount: commissionRunLines.commissionAmount,
      })
      .from(commissionRunLines)
      .innerJoin(commissionRuns, eq(commissionRuns.id, commissionRunLines.runId))
      .where(
        and(
          eq(commissionRunLines.employeeId, employeeId),
          eq(commissionRuns.status, "approved"),
          isNull(commissionRuns.payrollRunId),
          gt(commissionRunLines.commissionAmount, "0"),
        ),
      );
    if (pending.length) {
      const total = pending.reduce((sum, l) => sum.plus(money(l.amount)), money("0"));
      items.push({
        key: "UNPAID_COMMISSION",
        label: "عمولة معتمدة لم تُصرَف",
        severity: "BLOCKING",
        count: pending.length,
        amount: toDbMoney(total),
        resolvePath: "/hr/payroll",
        resolveHint: "تُصرَف ضمن مسيّر الرواتب (يلتقطها تلقائياً ولو بأجرٍ صفريّ للمفصول).",
        details: pending.map((l) => `تشغيلة ${l.period} — ${toDbMoney(money(l.amount))}`),
      });
    }
  }

  // ٥) عضوية جهة توصيل — بوّابة «توصيلاتي» تبقى مفتوحة لمن غادر.
  if (userId != null) {
    const memberships = await db
      .select({ partyName: deliveryParties.name, role: deliveryPartyMembers.memberRole })
      .from(deliveryPartyMembers)
      .innerJoin(deliveryParties, eq(deliveryParties.id, deliveryPartyMembers.partyId))
      .where(and(eq(deliveryPartyMembers.userId, userId), eq(deliveryPartyMembers.isActive, true)));
    if (memberships.length) {
      items.push({
        key: "DELIVERY_MEMBERSHIP",
        label: "عضوية جهة توصيل نشطة",
        severity: "BLOCKING",
        count: memberships.length,
        amount: null,
        resolvePath: "/delivery/parties",
        resolveHint: "عطّل عضويّته في الجهة وإلا بقيت بوّابة «توصيلاتي» مفتوحةً له.",
        details: memberships.map((m) => `${m.partyName} — ${m.role}`),
      });
    }
  }

  // ٦) جلسات حيّة — تحذير: تزول بإبطالٍ إداريّ من شاشة المستخدم، ولا تترك أثراً مالياً.
  if (userId != null) {
    const [live] = await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(userSessions)
      .where(
        and(
          eq(userSessions.userId, userId),
          isNull(userSessions.revokedAt),
          gt(userSessions.expiresAt, sql`NOW()`),
        ),
      );
    const count = Number(live?.n ?? 0);
    if (count > 0) {
      items.push({
        key: "ACTIVE_SESSIONS",
        label: "جلسات دخول نشطة",
        severity: "WARNING",
        count,
        amount: null,
        resolvePath: "/users",
        resolveHint: "أبطِل جلساته من شاشة المستخدم عند تعطيل الحساب (تعطيل الحساب يكفي عملياً).",
        details: [`${count} جلسة حيّة`],
      });
    }
  }

  const blockingCount = items.filter((i) => i.severity === "BLOCKING").length;
  return {
    employeeId,
    employeeName: `${emp.firstName} ${emp.lastName}`.trim(),
    userId,
    isActive: emp.isActive !== false,
    items,
    clearedToExit: blockingCount === 0,
    blockingCount,
  };
}
