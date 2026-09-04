// CRUD جهات التوصيل.
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull, like, ne, or, sql } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import { courierCommissionRules, deliveryConsignments, deliveryLedgerEntries, deliveryParties, deliveryPartyMembers, onlineOrders, users } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { money, toDbMoney } from "../money";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { withTx } from "../tx";
import { appendDeliveryEvent } from "./lifecycle";
import type { DeliveryActor, DeliveryPartyKind } from "./types";

/** يمنع تعطيل/فكّ ربط جهة عليها طلبات متجر «مع المندوب» (SHIPPED) — وإلا تُيتَّم من مسار التحصيل
 *  الوحيد (توصيلاتي) بلا إعادة إسناد (مراجعة عدائية ١٢/٧). العهدة=0 لطلبٍ لم يُحصَّل بعد فلا يحرسها فحص الرصيد. */
async function assertNoOpenCourierOrders(tx: Tx, partyId: number): Promise<void> {
  const openStore = (await tx
    .select({ n: sql<number>`COUNT(*)` })
    .from(onlineOrders)
    .where(and(eq(onlineOrders.deliveryPartyId, partyId), eq(onlineOrders.status, "SHIPPED"))))[0];
  const openConsignments = (await tx
    .select({ n: sql<number>`COUNT(*)` })
    .from(deliveryConsignments)
    .where(and(eq(deliveryConsignments.partyId, partyId), sql`(${deliveryConsignments.parcelStatus} NOT IN ('DELIVERED','RETURNED','CANCELLED') OR ${deliveryConsignments.moneyStatus} IN ('UNSETTLED','PARTIAL'))`)))[0];
  if (Number(openStore?.n ?? 0) > 0 || Number(openConsignments?.n ?? 0) > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تعطيل جهة التوصيل أو فكّ ربطها",
        why: `للجهة طلبات/إرساليات قيد التوصيل (${Number(openStore?.n ?? 0)} طلب متجر، ${Number(openConsignments?.n ?? 0)} إرسالية)؛ تعطيلها يُيتّم هذه الطلبات من مسار التحصيل`,
        doThis: "سلِّم الإرساليات المفتوحة أو أعِد إسنادها لجهةٍ أخرى من شاشة «مناديب التوصيل»، ثمّ أعد المحاولة",
      }),
    });
  }
}

/**
 * حارس سقف التعرّض داخل المعاملة. currentBalance في المرحلة الثانية يمثّل
 * النقد المحصّل فقط، لذلك يُشتق خطر الإسناد من الدفتر التشغيلي ويُقارن أيضاً
 * بالرصيد المرحّل حتى لا تتجاوز الشحنات غير المسلّمة السقف بصمت.
 */
export async function assertFloatLimitTx(
  tx: Tx,
  party: { id: number | string; name: string; floatLimit?: string | null; currentBalance?: string | null },
  codAmount: ReturnType<typeof money>,
): Promise<void> {
  const limit = money(party.floatLimit ?? "0");
  if (!limit.gt(0)) return;
  const row = (await tx.select({
    exposure: sql<string>`COALESCE(SUM(CASE
      WHEN ${deliveryLedgerEntries.entryType} = 'COD_ASSIGNED' THEN ${deliveryLedgerEntries.amount}
      WHEN ${deliveryLedgerEntries.entryType} IN ('COD_REMITTED','COD_RELEASED','COD_WRITTEN_OFF') THEN -${deliveryLedgerEntries.amount}
      ELSE 0 END),0)`,
  }).from(deliveryLedgerEntries).where(eq(deliveryLedgerEntries.partyId, Number(party.id))))[0];
  const committed = money(row?.exposure ?? "0");
  const legacyCash = money(party.currentBalance ?? "0");
  const after = DecimalMax(committed, legacyCash).plus(codAmount).toDecimalPlaces(2);
  if (after.gt(limit)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: `تعذّر إسناد الطرد لجهة «${party.name}»`,
        why: `التعرّض التشغيليّ للجهة سيبلغ ${after.toFixed(2)} ويتجاوز السقف المضبوط لها (${limit.toFixed(2)})`,
        doThis: "ورِّد نقد الجهة من «تسوية المناديب»، أو أعد توزيع طرودها المفتوحة على جهةٍ أخرى قبل الإسناد الجديد",
      }),
    });
  }
}

/**
 * Slice DFP1 (٣٠/٨/٢٦) — SLA على عمر الطرود المفتوحة (بلاغ المالك ٣٠/٨: «مندوبٌ لديه طرود منذ
 * ٢١ يوماً بلا توريد، والنظام يقبل إسناد طرودٍ جديدة عليه»). قرارُ المالك: حظرٌ ثابت (لا تجاوُز
 * إداريّ) حتى تُصفَّى الطرود القديمة.
 *
 * تعريف «الطرد المفتوح المُتأخّر» = deliveryConsignment للجهة، عمرها منذ الإسناد > `maxOpenParcelAgeDays`،
 * والطرد **لم يُحسَم ماليّاً**: لا COD_REMITTED مسجَّل، ولا COD_RELEASED (إلغاء)، ولا COD_WRITTEN_OFF (شطب).
 * حالة الطرد التشغيليّة (DELIVERED / OUT_FOR_DELIVERY / …) لا تنقض ذلك — طردٌ سُلِّم مع نقدٍ لم
 * يُورَّد يبقى مُتأخّراً بحكم الحاجة إلى التوريد.
 *
 * الاستدعاء: **قبل كلّ إسناد**. الفشل يحوّل الكاشير إلى صفحة الجهة لتصفية الطرود المتأخّرة.
 */
export async function assertNoStaleOpenParcelsTx(
  tx: Tx,
  party: { id: number | string; name: string; maxOpenParcelAgeDays?: number | null },
): Promise<void> {
  const days = Number(party.maxOpenParcelAgeDays ?? 7);
  // لا حارس بقيمةٍ غير موجبة (لا يجب أن تحدث بسبب CHECK constraint، لكن دفاع في العمق).
  if (!Number.isFinite(days) || days < 1) return;
  const row = (await tx
    .select({
      staleCount: sql<number>`COUNT(*)`,
      oldestDays: sql<number>`COALESCE(MAX(TIMESTAMPDIFF(DAY, ${deliveryConsignments.dispatchedAt}, NOW())), 0)`,
    })
    .from(deliveryConsignments)
    .where(
      and(
        eq(deliveryConsignments.partyId, Number(party.id)),
        sql`${deliveryConsignments.dispatchedAt} IS NOT NULL`,
        sql`TIMESTAMPDIFF(DAY, ${deliveryConsignments.dispatchedAt}, NOW()) > ${days}`,
        // «مفتوحٌ ماليّاً» = moneyStatus != SETTLED (لم يُورَّد بعد) وليس ملغى/مشطوب.
        sql`${deliveryConsignments.moneyStatus} IN ('UNSETTLED', 'PARTIAL')`,
        sql`${deliveryConsignments.parcelStatus} NOT IN ('RETURNED', 'CANCELLED')`,
      ),
    ))[0];
  const staleCount = Number(row?.staleCount ?? 0);
  if (staleCount > 0) {
    const oldest = Number(row?.oldestDays ?? 0);
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: `تعذّر إسناد الطرد لجهة «${party.name}»`,
        why: `للجهة ${staleCount} طرداً مفتوحاً منذ أكثر من ${days} يوماً (أقدمها ${oldest} يوماً)؛ حظرٌ ثابت بقرار المالك (بلا تجاوُز إداريّ) حتى تُصفَّى الطرود المتأخّرة`,
        doThis: "افتح شاشة الجهة وسوِّ الطرود المتأخّرة (توريدٌ أو ارجاعٌ أو شطبٌ موجَّه)، ثمّ أعد الإسناد",
      }),
    });
  }
}

const DecimalMax = (
  a: ReturnType<typeof money>,
  b: ReturnType<typeof money>,
) => (a.gte(b) ? a : b);

/** يتحقّق أن userId حسابُ مندوب (courier) غير مرتبط بجهة أخرى — قبل الربط. (excludePartyId للتعديل.) */
async function assertLinkableCourier(tx: Tx, userId: number, actor: DeliveryActor, excludePartyId?: number): Promise<void> {
  const u = (await tx.select({ role: users.role, isActive: users.isActive, branchId: users.branchId }).from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!u) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر ربط حساب المندوب بجهة التوصيل",
        why: `الحساب رقم ${userId} غير موجود`,
        doThis: "اختر حساباً موجوداً من قائمة الموظفين، أو أنشئ الحساب أوّلاً من شاشة «الموظفين»",
      }),
    });
  }
  if (!u.isActive) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر ربط حساب المندوب بجهة التوصيل",
        why: "الحساب المختار معطَّل، ولا يقبل النظام ربطَ حسابٍ معطَّل بجهةٍ نشطة",
        doThis: "فعِّل الحساب أوّلاً من «الموظفين»، أو اختر حساباً نشطاً",
      }),
    });
  }
  if (u.role !== "courier") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر ربط حساب المندوب بجهة التوصيل",
        why: `دور الحساب المُختار «${u.role}» لا «مندوب توصيل» (courier)`,
        doThis: "افتح تعديل الحساب من «الموظفين» وغيِّر دوره إلى «مندوب توصيل»، أو اختر حساباً دورُه مندوب",
      }),
    });
  }
  if (actor.role !== "admin" && actor.branchId != null && u.branchId != null && Number(u.branchId) !== Number(actor.branchId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر ربط حساب المندوب بجهة التوصيل",
        why: `حساب المندوب يخص فرعاً آخر (${u.branchId}) لا فرعك (${actor.branchId})، ومدير الفرع محظور من العبور بين الفروع`,
        doThis: "اطلب من المالك أو الأدمن ربط الحساب من فرعه الأصليّ، أو اختر مندوباً في فرعك",
      }),
    });
  }
  const conds = [eq(deliveryParties.userId, userId)];
  if (excludePartyId != null) conds.push(ne(deliveryParties.id, excludePartyId));
  const linked = (await tx.select({ id: deliveryParties.id }).from(deliveryParties).where(and(...conds)).limit(1))[0];
  if (linked) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر ربط الحساب بجهة التوصيل",
        why: `الحساب مرتبطٌ سلفاً بجهة توصيل أخرى (#${linked.id})؛ ربطُه بجهتين معاً يفسد إسناد الإرساليات`,
        doThis: `افكّ ربط الحساب من الجهة #${linked.id} أوّلاً من شاشة «مناديب التوصيل»، ثمّ أعد ربطه هنا`,
      }),
    });
  }
  const memberConds = [eq(deliveryPartyMembers.userId, userId)];
  if (excludePartyId != null) memberConds.push(ne(deliveryPartyMembers.partyId, excludePartyId));
  const membership = (await tx.select({ partyId: deliveryPartyMembers.partyId })
    .from(deliveryPartyMembers)
    .where(and(...memberConds))
    .limit(1))[0];
  if (membership) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر ربط الحساب بجهة التوصيل",
        why: `الحساب عضوٌ سلفاً في جهة توصيل أخرى (#${membership.partyId})؛ عضويّته في جهتين معاً تفسد إسناد الإرساليات`,
        doThis: `أزل عضوية الحساب من الجهة #${membership.partyId} أوّلاً من تبويب «الأعضاء» في تلك الجهة، ثمّ أعد ربطه هنا`,
      }),
    });
  }
}

export interface CreateDeliveryPartyInput {
  partyType: DeliveryPartyKind;
  name: string;
  phone?: string | null;
  phone2?: string | null;
  userId?: number | null;
  branchId?: number | null;
  nationalId?: string | null;
  vehicleInfo?: string | null;
  defaultFee?: string | null;
  floatLimit?: string | null;
  notes?: string | null;
}

export async function createDeliveryParty(input: CreateDeliveryPartyInput, actor: DeliveryActor): Promise<{ id: number }> {
  return withTx(async (tx) => {
    if (input.userId != null) await assertLinkableCourier(tx, input.userId, actor);
    const res = await tx.insert(deliveryParties).values({
      partyType: input.partyType,
      name: input.name.trim(),
      phone: input.phone ?? null,
      phone2: input.phone2 ?? null,
      userId: input.userId ?? null,
      branchId: input.branchId ?? actor.branchId ?? null,
      nationalId: input.nationalId ?? null,
      vehicleInfo: input.vehicleInfo ?? null,
      defaultFee: toDbMoney(input.defaultFee ?? "0"),
      floatLimit: input.floatLimit != null && input.floatLimit !== "" ? toDbMoney(input.floatLimit) : null,
      notes: input.notes ?? null,
      isActive: true,
    });
    const id = extractInsertId(res);
    if (input.userId != null) {
      await tx.insert(deliveryPartyMembers).values({
        partyId: id,
        userId: input.userId,
        memberRole: input.partyType === "COMPANY" ? "MANAGER" : "DRIVER",
        createdBy: actor.userId,
      });
    }
    return { id };
  });
}

export interface UpdateDeliveryPartyInput {
  id: number;
  partyType?: DeliveryPartyKind;
  name?: string;
  phone?: string | null;
  phone2?: string | null;
  userId?: number | null;
  branchId?: number | null;
  nationalId?: string | null;
  vehicleInfo?: string | null;
  defaultFee?: string | null;
  floatLimit?: string | null;
  notes?: string | null;
  /** H2 (٢٩/٨/٢٦): opt-in لاستبدال الأجرة بالعمولة عند التسوية — يتطلّب قاعدة عمولةٍ فعّالة. */
  useCommissionForSettlement?: boolean;
}

export async function updateDeliveryParty(input: UpdateDeliveryPartyInput, _actor: DeliveryActor): Promise<{ id: number }> {
  return withTx(async (tx) => {
    const patch: Record<string, unknown> = {};
    if (input.partyType !== undefined) patch.partyType = input.partyType;
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.phone !== undefined) patch.phone = input.phone;
    if (input.phone2 !== undefined) patch.phone2 = input.phone2;
    if (input.userId !== undefined) {
      const cur = (await tx.select({ userId: deliveryParties.userId, partyType: deliveryParties.partyType }).from(deliveryParties).where(eq(deliveryParties.id, input.id)).for("update").limit(1))[0];
      if (!cur) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "تعذّر تعديل جهة التوصيل",
            why: `جهة التوصيل رقم ${input.id} غير موجودة أو أُزيلت`,
            doThis: "افتح شاشة «مناديب التوصيل» واختر جهةً موجودة من القائمة الحاليّة",
          }),
        });
      }
      const before = cur.userId == null ? null : Number(cur.userId);
      const after = input.userId == null ? null : Number(input.userId);
      // السماح بربط جهة يتيمة (null→حساب) يعيد إرسالياتها إلى البوابة. أما فك الربط أو نقلها
      // من حساب قائم فيُمنع ما دامت عليه أعمال مفتوحة كي لا تختفي من المستخدم الحالي.
      if (before !== after && before != null) await assertNoOpenCourierOrders(tx, input.id);
      if (after != null) await assertLinkableCourier(tx, after, _actor, input.id);
      if (before !== after && before != null) {
        await tx.delete(deliveryPartyMembers).where(and(
          eq(deliveryPartyMembers.partyId, input.id),
          eq(deliveryPartyMembers.userId, before),
        ));
      }
      if (after != null) {
        const member = (await tx.select({ id: deliveryPartyMembers.id }).from(deliveryPartyMembers).where(and(
          eq(deliveryPartyMembers.partyId, input.id),
          eq(deliveryPartyMembers.userId, after),
        )).limit(1))[0];
        if (member) {
          await tx.update(deliveryPartyMembers).set({ isActive: true }).where(eq(deliveryPartyMembers.id, Number(member.id)));
        } else {
          await tx.insert(deliveryPartyMembers).values({
            partyId: input.id,
            userId: after,
            memberRole: (input.partyType ?? cur.partyType) === "COMPANY" ? "MANAGER" : "DRIVER",
            createdBy: _actor.userId,
          });
        }
      }
      patch.userId = input.userId;
    }
    if (input.branchId !== undefined) {
      // مراجعة عدائية ٩/٨ — نقل الجهة لفرعٍ آخر وعليها إرساليات مفتوحة يقفل توريدها للأبد:
      // فرعُها الجديد يرفض («الإرسالية تخصّ فرعاً آخر») وفرعُ الإرسالية يرفض («الجهة لا تخصّ
      // فرع التوريد») ⇒ المخرج الوحيد تسويةٌ حرّة تترك الفواتير غير مسدَّدة.
      const cur = (await tx.select({ branchId: deliveryParties.branchId }).from(deliveryParties).where(eq(deliveryParties.id, input.id)).for("update").limit(1))[0];
      if (!cur) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "تعذّر تعديل جهة التوصيل",
            why: `جهة التوصيل رقم ${input.id} غير موجودة أو أُزيلت`,
            doThis: "افتح شاشة «مناديب التوصيل» واختر جهةً موجودة من القائمة الحاليّة",
          }),
        });
      }
      const branchBefore = cur.branchId == null ? null : Number(cur.branchId);
      const branchAfter = input.branchId == null ? null : Number(input.branchId);
      if (branchBefore !== branchAfter) {
        const open = (await tx
          .select({ n: sql<number>`COUNT(*)` })
          .from(deliveryConsignments)
          .where(and(eq(deliveryConsignments.partyId, input.id), sql`(${deliveryConsignments.parcelStatus} NOT IN ('DELIVERED','RETURNED','CANCELLED') OR ${deliveryConsignments.moneyStatus} IN ('UNSETTLED','PARTIAL'))`)))[0];
        if (Number(open?.n ?? 0) > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "تعذّر تغيير فرع جهة التوصيل",
              why: `للجهة ${Number(open?.n ?? 0)} إرسالية مفتوحة على فرعها الحاليّ (${branchBefore ?? "غير محدَّد"})؛ نقلُها لفرعٍ آخر يُيتّم توريدها (كلا الفرعين يرفض)`,
              doThis: "سوِّ الإرساليات المفتوحة (توريدٌ أو ارجاعٌ أو شطبٌ موجَّه) من «تسوية المناديب»، ثمّ أعد تغيير الفرع",
            }),
          });
        }
      }
      patch.branchId = input.branchId;
    }
    if (input.nationalId !== undefined) patch.nationalId = input.nationalId;
    if (input.vehicleInfo !== undefined) patch.vehicleInfo = input.vehicleInfo;
    if (input.defaultFee !== undefined) patch.defaultFee = toDbMoney(input.defaultFee ?? "0");
    if (input.floatLimit !== undefined) patch.floatLimit = input.floatLimit != null && input.floatLimit !== "" ? toDbMoney(input.floatLimit) : null;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.useCommissionForSettlement !== undefined) {
      // H2: قبل التفعيل يجب وجود قاعدة عمولةٍ فعّالة (وإلّا العلَم لا يُحدث أثراً وسيُحيّر المدير).
      if (input.useCommissionForSettlement === true) {
        const active = (await tx
          .select({ n: sql<number>`COUNT(*)` })
          .from(courierCommissionRules)
          .where(and(
            or(eq(courierCommissionRules.partyId, input.id), isNull(courierCommissionRules.partyId)),
            eq(courierCommissionRules.isActive, true),
          )))[0];
        if (!active || Number(active.n) === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "تعذّر تفعيل «استخدام العمولة في التسوية»",
              why: "لا قاعدة عمولةٍ فعّالة لهذه الجهة (خاصّة بها أو عامّة)، والعلَم بلا قاعدةٍ لا يُحدث أثراً وسيُحيّر المدير",
              doThis: "أَضِف قاعدةً فعّالة أوّلاً من تبويب «قاعدة العمولة» في صفحة الجهة، ثمّ فعِّل العلَم",
            }),
          });
        }
      }
      patch.useCommissionForSettlement = input.useCommissionForSettlement;
    }
    if (Object.keys(patch).length === 0) return { id: input.id };
    await tx.update(deliveryParties).set(patch).where(eq(deliveryParties.id, input.id));
    return { id: input.id };
  });
}

/** تعطيل/تفعيل جهة. الحظر عند وجود عهدة قائمة (currentBalance != 0) لمنع إخفاء ذمّة مفتوحة. */
export async function setDeliveryPartyActive(id: number, isActive: boolean, _actor: DeliveryActor): Promise<{ id: number }> {
  return withTx(async (tx) => {
    if (!isActive) {
      // .for("update"): يقفل صفّ الجهة قبل فحص العهدة ⇒ لا يسبق قرارَ التعطيل تحصيلٌ متزامن يرفع
      // العهدة بعد قراءةٍ غير مقفلة (سباق check-then-act — مراجعة عدائية ١٢/٧). التحصيل يقفل نفس الصفّ.
      const p = (await tx.select({ balance: deliveryParties.currentBalance }).from(deliveryParties).where(eq(deliveryParties.id, id)).for("update").limit(1))[0];
      if (p && money(p.balance ?? "0").abs().gt("0.01")) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر تعطيل جهة التوصيل",
            why: `للجهة عهدة قائمة (${money(p.balance ?? "0").toFixed(2)}) — تعطيلها يُخفي ذمّةً مفتوحة عن كل مسارات المتابعة`,
            doThis: "سوِّ الرصيد أوّلاً من «تسوية المناديب» (توريدٌ أو شطبٌ باعتماد المدير)، ثمّ عطِّل الجهة",
          }),
        });
      }
      await assertNoOpenCourierOrders(tx, id); // + طلبات متجر قيد التوصيل (العهدة=0 لا تحرسها)
      // مراجعة عدائية ٩/٨: فحص الرصيد وحده لا يكفي — بياناتٌ تاريخية (تسوية حرّة قبل حارس
      // العهدة السائبة) قد تُصفّر الرصيد وتُبقي إرساليات مفتوحة؛ تعطيلُ الجهة حينها يُخفيها
      // عن كل مسارات التسوية وتبقى فواتيرها «غير مسدَّدة» في أعمار الذمم للأبد.
      const openCn = (await tx
        .select({ n: sql<number>`COUNT(*)` })
        .from(deliveryConsignments)
        .where(and(eq(deliveryConsignments.partyId, id), sql`(${deliveryConsignments.parcelStatus} NOT IN ('DELIVERED','RETURNED','CANCELLED') OR ${deliveryConsignments.moneyStatus} IN ('UNSETTLED','PARTIAL'))`)))[0];
      if (Number(openCn?.n ?? 0) > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر تعطيل جهة التوصيل",
            why: `للجهة ${Number(openCn?.n ?? 0)} إرسالية مفتوحة (فحص الرصيد وحده لا يكفي — تسويةٌ حرّة سابقة قد تُصفّر الرصيد وتُبقي الإرساليات مفتوحة)؛ تعطيلها يُبقي فواتيرها «غير مسدَّدة» في أعمار الذمم للأبد`,
            doThis: "ورِّد كلّ إرسالية أو أرجِعها أو اشطبها موجَّهةً من «تسوية المناديب»، ثمّ عطِّل الجهة",
          }),
        });
      }
    }
    await tx.update(deliveryParties).set({ isActive }).where(eq(deliveryParties.id, id));
    return { id };
  });
}

export interface ListPartiesOpts {
  branchId?: number | null; // عزل الفرع لغير المرتفعين
  activeOnly?: boolean;
  search?: string | null;
}

/** قائمة جهات التوصيل + عهدتها + عدد شحناتها المفتوحة (لشاشة /delivery/parties). */
export async function listDeliveryParties(opts: ListPartiesOpts) {
  const db = getDb();
  if (!db) return [];
  const conds = [];
  if (opts.branchId != null) {
    conds.push(or(eq(deliveryParties.branchId, opts.branchId), isNull(deliveryParties.branchId))!);
  }
  if (opts.activeOnly) conds.push(eq(deliveryParties.isActive, true));
  if (opts.search && opts.search.trim()) {
    const s = `%${opts.search.trim()}%`;
    conds.push(or(like(deliveryParties.name, s), like(deliveryParties.phone, s)));
  }
  const where = conds.length ? and(...conds) : undefined;
  const parties = await db
    .select({
      id: deliveryParties.id,
      partyType: deliveryParties.partyType,
      name: deliveryParties.name,
      phone: deliveryParties.phone,
      userId: deliveryParties.userId,
      branchId: deliveryParties.branchId,
      defaultFee: deliveryParties.defaultFee,
      currentBalance: deliveryParties.currentBalance,
      floatLimit: deliveryParties.floatLimit,
      isActive: deliveryParties.isActive,
    })
    .from(deliveryParties)
    .where(where)
    .orderBy(desc(deliveryParties.isActive), deliveryParties.name);

  /**
   * عدد الشحنات المفتوحة + أقدم إرسالية لكل جهة (عهدة قائمة).
   *
   * Slice DFP2 (٣١/٨/٢٦): **مصدر التعريف الوحيد** = `shared/deliveryOpenParcel.OPEN_CONSIGNMENT_STATUSES`
   * (DISPATCHED, PARTIAL). قبل ذلك كان هذا الاستعلام يستعمل تعريفاً موسَّعاً
   * (`parcelStatus NOT IN DELIVERED/RETURNED/CANCELLED OR moneyStatus IN UNSETTLED/PARTIAL`)
   * فيُنتج ٦٩ طرداً حيث تُنتج `listPartyObligations` (نفس البيانات، تعريفٌ ماليّ صارم) ٧ فقط.
   * المدير كان يقفز بين الشاشتَين فيرى رقمَين مختلفَين ⇒ ظنُّ عطبٍ نظاميّ. الآن التعريف موحَّد.
   */
  const openAgg = await db
    .select({
      partyId: deliveryConsignments.partyId,
      openCount: sql<number>`COUNT(*)`,
      oldest: sql<string | null>`MIN(${deliveryConsignments.dispatchedAt})`,
    })
    .from(deliveryConsignments)
    // OPEN_CONSIGNMENT_STATUSES = ['DISPATCHED', 'PARTIAL'] من `shared/deliveryOpenParcel.ts`.
    .where(sql`${deliveryConsignments.status} IN ('DISPATCHED', 'PARTIAL')`)
    .groupBy(deliveryConsignments.partyId);
  const openMap = new Map(openAgg.map((r) => [Number(r.partyId), { openCount: Number(r.openCount), oldest: r.oldest }]));

  /**
   * Slice DFP1 (٣٠/٨/٢٦، P1 #2+#7) — الأعمدة الجديدة لقائمة المناديب (٣٠/٨):
   * ٢) parcelsInTransitAmount = Σ codAmount للطرود ASSIGNED/OUT_FOR_DELIVERY (بضاعةٌ خرجت لم تصل).
   * ٣) deliveredUncollectedAmount = Σ متبقّي الطرود DELIVERED مع moneyStatus ∈ (UNSETTLED, PARTIAL).
   * ٤) feesOwedAmount = Σ (FEE_EARNED − FEE_REFUNDED − FEE_PAID − FEE_OFFSET) مقصوصةً عند صفر لكل جهة.
   * الحسبة هنا اختصار للطاقة، والأعمدة تُعرَض في DeliveryParties بتوكينات لون partyExposure.
   */
  const exposureAgg = await db
    .select({
      partyId: deliveryConsignments.partyId,
      parcelsInTransit: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryConsignments.parcelStatus} IN ('ASSIGNED','OUT_FOR_DELIVERY')
        THEN CAST(${deliveryConsignments.codAmount} AS DECIMAL(15,2)) ELSE 0 END), 0)`,
      deliveredUncollected: sql<string>`COALESCE(SUM(CASE
        WHEN ${deliveryConsignments.parcelStatus} = 'DELIVERED'
          AND ${deliveryConsignments.moneyStatus} IN ('UNSETTLED','PARTIAL')
          AND ${deliveryConsignments.returnDeclaredAt} IS NULL
        THEN GREATEST(
          CAST(${deliveryConsignments.codAmount} AS DECIMAL(15,2))
          - CAST(${deliveryConsignments.collectedAmount} AS DECIMAL(15,2))
          - CAST(${deliveryConsignments.counterSettledAmount} AS DECIMAL(15,2)), 0)
        ELSE 0 END), 0)`,
    })
    .from(deliveryConsignments)
    .where(sql`${deliveryConsignments.parcelStatus} != 'CANCELLED'`)
    .groupBy(deliveryConsignments.partyId);
  const exposureMap = new Map(
    exposureAgg.map((r) => [
      Number(r.partyId),
      {
        parcelsInTransit: String(r.parcelsInTransit ?? "0.00"),
        deliveredUncollected: String(r.deliveredUncollected ?? "0.00"),
      },
    ]),
  );
  const feesAgg = await db
    .select({
      partyId: deliveryLedgerEntries.partyId,
      feesOwed: sql<string>`GREATEST(COALESCE(SUM(CASE
        WHEN ${deliveryLedgerEntries.entryType} = 'FEE_EARNED' THEN ${deliveryLedgerEntries.amount}
        WHEN ${deliveryLedgerEntries.entryType} = 'FEE_REFUNDED' THEN -${deliveryLedgerEntries.amount}
        WHEN ${deliveryLedgerEntries.entryType} IN ('FEE_PAID', 'FEE_OFFSET') THEN -${deliveryLedgerEntries.amount}
        ELSE 0 END), 0), 0)`,
    })
    .from(deliveryLedgerEntries)
    .groupBy(deliveryLedgerEntries.partyId);
  const feesMap = new Map(feesAgg.map((r) => [Number(r.partyId), String(r.feesOwed ?? "0.00")]));

  const driverRows = await db.select({
    partyId: deliveryPartyMembers.partyId,
    userId: deliveryPartyMembers.userId,
    memberRole: deliveryPartyMembers.memberRole,
    name: users.name,
    username: users.username,
  }).from(deliveryPartyMembers)
    .innerJoin(users, eq(users.id, deliveryPartyMembers.userId))
    .where(and(
      eq(deliveryPartyMembers.isActive, true),
      eq(users.isActive, true),
    ));
  const driversByParty = new Map<number, Array<{ userId: number; name: string }>>();
  const portalPartyIds = new Set<number>();
  for (const driver of driverRows) {
    const partyId = Number(driver.partyId);
    portalPartyIds.add(partyId);
    if (driver.memberRole !== "DRIVER") continue;
    const list = driversByParty.get(partyId) ?? [];
    list.push({ userId: Number(driver.userId), name: driver.name ?? driver.username ?? `#${driver.userId}` });
    driversByParty.set(partyId, list);
  }

  return parties.map((p) => ({
    ...p,
    drivers: driversByParty.get(Number(p.id)) ?? [],
    hasPortalAccess: p.userId != null || portalPartyIds.has(Number(p.id)),
    openConsignments: openMap.get(Number(p.id))?.openCount ?? 0,
    oldestOutstanding: openMap.get(Number(p.id))?.oldest ?? null,
    // Slice DFP1 (٣٠/٨/٢٦) — الأعمدة الأربعة الجديدة (partyExposure):
    parcelsInTransitAmount: exposureMap.get(Number(p.id))?.parcelsInTransit ?? "0.00",
    deliveredUncollectedAmount: exposureMap.get(Number(p.id))?.deliveredUncollected ?? "0.00",
    feesOwedAmount: feesMap.get(Number(p.id)) ?? "0.00",
  }));
}

export async function getDeliveryParty(id: number) {
  const db = getDb();
  if (!db) return null;
  const rows = await db.select().from(deliveryParties).where(eq(deliveryParties.id, id)).limit(1);
  return rows[0] ?? null;
}

/** حسابات المناديب (دور courier) لربطها بجهة توصيل — مع الجهة المرتبطة حالياً (لمنتقي الربط). */
export async function listCourierAccounts(branchId?: number | null) {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      username: users.username,
      linkedPartyId: sql<number | null>`COALESCE(${deliveryPartyMembers.partyId}, ${deliveryParties.id})`,
      linkedPartyName: deliveryParties.name,
    })
    .from(users)
    .leftJoin(deliveryPartyMembers, and(eq(deliveryPartyMembers.userId, users.id), eq(deliveryPartyMembers.isActive, true)))
    .leftJoin(deliveryParties, or(eq(deliveryParties.id, deliveryPartyMembers.partyId), eq(deliveryParties.userId, users.id)))
    .where(and(
      eq(users.role, "courier"),
      eq(users.isActive, true),
      branchId == null ? undefined : or(eq(users.branchId, branchId), isNull(users.branchId)),
    ))
    .orderBy(users.name);
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name ?? r.username ?? `#${r.id}`,
    username: r.username ?? null,
    linkedPartyId: r.linkedPartyId != null ? Number(r.linkedPartyId) : null,
    linkedPartyName: r.linkedPartyName ?? null,
  }));
}

export async function listDeliveryPartyMembers(partyId: number) {
  const db = getDb();
  if (!db) return [];
  return db.select({
    id: deliveryPartyMembers.id,
    partyId: deliveryPartyMembers.partyId,
    userId: deliveryPartyMembers.userId,
    memberRole: deliveryPartyMembers.memberRole,
    isActive: deliveryPartyMembers.isActive,
    name: users.name,
    username: users.username,
  }).from(deliveryPartyMembers)
    .innerJoin(users, eq(users.id, deliveryPartyMembers.userId))
    .where(eq(deliveryPartyMembers.partyId, partyId))
    .orderBy(desc(deliveryPartyMembers.isActive), users.name);
}

export async function addDeliveryPartyMember(
  input: { partyId: number; userId: number; memberRole: "DRIVER" | "MANAGER" | "ACCOUNTANT" },
  actor: DeliveryActor,
) {
  return withTx(async (tx) => {
    const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, input.partyId)).for("update").limit(1))[0];
    if (!party) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر إضافة العضو لجهة التوصيل",
          why: `جهة التوصيل رقم ${input.partyId} غير موجودة أو أُزيلت`,
          doThis: "افتح شاشة «مناديب التوصيل» واختر جهةً موجودة من القائمة",
        }),
      });
    }
    const otherMembership = (await tx.select({ partyId: deliveryPartyMembers.partyId }).from(deliveryPartyMembers).where(and(
      eq(deliveryPartyMembers.userId, input.userId),
      eq(deliveryPartyMembers.isActive, true),
      ne(deliveryPartyMembers.partyId, input.partyId),
    )).limit(1))[0];
    if (otherMembership) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إضافة العضو لجهة التوصيل",
          why: `الحساب عضوٌ نشطٌ سلفاً في جهة توصيل أخرى (#${otherMembership.partyId})؛ عضويّته في جهتين معاً تفسد إسناد الإرساليات`,
          doThis: `أزل عضوية الحساب من الجهة #${otherMembership.partyId} أوّلاً من تبويب «الأعضاء» فيها، ثمّ أضفه هنا`,
        }),
      });
    }
    await assertLinkableCourier(tx, input.userId, actor, input.partyId);
    const existing = (await tx.select().from(deliveryPartyMembers).where(and(
      eq(deliveryPartyMembers.partyId, input.partyId),
      eq(deliveryPartyMembers.userId, input.userId),
    )).limit(1))[0];
    if (existing) {
      await tx.update(deliveryPartyMembers).set({ memberRole: input.memberRole, isActive: true }).where(eq(deliveryPartyMembers.id, Number(existing.id)));
      return { id: Number(existing.id) };
    }
    const res = await tx.insert(deliveryPartyMembers).values({
      partyId: input.partyId,
      userId: input.userId,
      memberRole: input.memberRole,
      createdBy: actor.userId,
    });
    return { id: extractInsertId(res) };
  });
}

export async function removeDeliveryPartyMember(
  input: { partyId: number; userId: number },
) {
  return withTx(async (tx) => {
    const member = (await tx.select().from(deliveryPartyMembers).where(and(
      eq(deliveryPartyMembers.partyId, input.partyId),
      eq(deliveryPartyMembers.userId, input.userId),
      eq(deliveryPartyMembers.isActive, true),
    )).for("update").limit(1))[0];
    if (!member) return { removed: false };
    const assigned = (await tx.select({ n: sql<number>`COUNT(*)` }).from(deliveryConsignments).where(and(
      eq(deliveryConsignments.partyId, input.partyId),
      eq(deliveryConsignments.assignedUserId, input.userId),
      sql`${deliveryConsignments.parcelStatus} NOT IN ('DELIVERED','RETURNED','CANCELLED')`,
    )))[0];
    if (Number(assigned?.n ?? 0) > 0) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر إزالة السائق من جهة التوصيل",
          why: `للسائق ${Number(assigned?.n ?? 0)} طرداً مفتوحاً مُسنَداً إليه؛ إزالته الآن تُيتّم هذه الطرود من مسار التسليم`,
          doThis: "افتح تبويب «الأعضاء»، أعد إسناد طرود السائق لسائقٍ آخر من زرّ «إعادة إسناد»، ثمّ أزله",
        }),
      });
    }
    const party = (await tx.select({ userId: deliveryParties.userId }).from(deliveryParties)
      .where(eq(deliveryParties.id, input.partyId)).for("update").limit(1))[0];
    if (party?.userId != null && Number(party.userId) === input.userId) {
      await assertNoOpenCourierOrders(tx, input.partyId);
      await tx.update(deliveryParties).set({ userId: null }).where(eq(deliveryParties.id, input.partyId));
    }
    // The table has a unique key on userId. Deleting a safely-detached member
    // keeps that identity reusable by another delivery party; the audit log is
    // the immutable record of the removal.
    await tx.delete(deliveryPartyMembers).where(eq(deliveryPartyMembers.id, Number(member.id)));
    return { removed: true };
  });
}

export async function reassignDeliveryConsignment(
  input: { partyId: number; consignmentId: number; assignedUserId?: number | null; clientRequestId: string },
  actor: DeliveryActor,
) {
  const payloadHash = idempotencyHash({
    partyId: Number(input.partyId),
    consignmentId: Number(input.consignmentId),
    assignedUserId: input.assignedUserId == null ? null : Number(input.assignedUserId),
  });
  return withTx(async (tx) => {
    const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, input.partyId)).for("update").limit(1))[0];
    if (!party?.isActive) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّرت إعادة إسناد الطرد",
          why: `جهة التوصيل رقم ${input.partyId} غير موجودة أو معطَّلة`,
          doThis: "افتح شاشة «مناديب التوصيل» واختر جهةً نشطة من القائمة",
        }),
      });
    }
    const cn = (await tx.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, input.consignmentId)).for("update").limit(1))[0];
    if (!cn) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّرت إعادة إسناد الطرد",
          why: `الإرسالية رقم ${input.consignmentId} غير موجودة أو أُزيلت`,
          doThis: "افتح شاشة «التوصيل» واختر إرساليةً موجودة من القائمة الحاليّة",
        }),
      });
    }
    const replay = await checkIdempotency(tx, "delivery.reassignConsignment", input.clientRequestId, payloadHash);
    if (replay != null) return { consignmentId: replay, replay: true as const };
    if (Number(cn.partyId) !== Number(input.partyId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّرت إعادة إسناد الطرد",
          why: `الإرسالية تخص جهة توصيل أخرى (${cn.partyId}) لا الجهة المُختارة (${input.partyId})`,
          doThis: "اختر الإرسالية من قائمة جهتها الأصليّة، أو غيّر الجهة لتطابق إرساليتها",
        }),
      });
    }
    if (cn.parcelStatus !== "ASSIGNED" && cn.parcelStatus !== "FAILED") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّرت إعادة إسناد الطرد",
          why: `حالة الطرد الحاليّة (${cn.parcelStatus}) لا تسمح بإعادة الإسناد؛ الإعادة مسموحة قبل قبول الطرد (ASSIGNED) أو بعد تسجيل تعذّر التوصيل (FAILED) فقط`,
          doThis: "إن كان الطرد قيد التوصيل الفعليّ، انتظر تسليمَه أو تسجيل تعذّره أوّلاً؛ وإن كان مُسلَّماً استعمل مسار المرتجع",
        }),
      });
    }
    if (input.assignedUserId != null) {
      const driver = (await tx.select({ id: deliveryPartyMembers.id, userActive: users.isActive }).from(deliveryPartyMembers)
        .innerJoin(users, eq(users.id, deliveryPartyMembers.userId))
        .where(and(
          eq(deliveryPartyMembers.partyId, input.partyId),
          eq(deliveryPartyMembers.userId, input.assignedUserId),
          eq(deliveryPartyMembers.memberRole, "DRIVER"),
          eq(deliveryPartyMembers.isActive, true),
        )).limit(1))[0];
      if (!driver?.userActive) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّرت إعادة إسناد الطرد",
            why: `السائق المُختار (${input.assignedUserId}) ليس عضواً نشطاً بدور سائق في هذه الجهة`,
            doThis: "أضِف السائق إلى الجهة أوّلاً من تبويب «الأعضاء» بدور DRIVER، أو اختر سائقاً موجوداً من قائمة الجهة",
          }),
        });
      }
    }
    await tx.update(deliveryConsignments).set({
      assignedUserId: input.assignedUserId ?? null,
      parcelStatus: "ASSIGNED",
      acceptedAt: null,
      pickedUpAt: null,
      outForDeliveryAt: null,
      failedAt: null,
      failureReason: null,
    }).where(eq(deliveryConsignments.id, input.consignmentId));
    await appendDeliveryEvent(tx, {
      eventKey: `CN:${cn.id}:REASSIGNED:${input.clientRequestId}`,
      consignmentId: Number(cn.id),
      eventType: "REASSIGNED",
      fromParcelStatus: cn.parcelStatus,
      toParcelStatus: "ASSIGNED",
      fromMoneyStatus: cn.moneyStatus,
      toMoneyStatus: cn.moneyStatus,
      actorUserId: actor.userId,
      payload: { fromUserId: cn.assignedUserId, toUserId: input.assignedUserId ?? null },
    });
    await recordIdempotencyKey(tx, "delivery.reassignConsignment", input.clientRequestId, Number(cn.id), payloadHash);
    return { consignmentId: Number(cn.id), replay: false as const };
  });
}
