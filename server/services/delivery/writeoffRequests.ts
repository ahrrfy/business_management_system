import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import {
  deliveryCodWriteOffRequests,
  deliveryConsignments,
  deliveryParties,
  users,
} from "../../../drizzle/schema";
import { appErrorMessage } from "@shared/errors";
import { isDupEntry } from "@shared/errorMap.ar";
import { extractAffectedRows, extractInsertId } from "../../lib/insertId";
import { idempotencyHash, payloadHashMatches } from "../idempotency";
import { money, round2, toDbMoney } from "../money";
import { requireDb, type Actor, withTx } from "../tx";
import {
  writeOffDeliveryShortfallInTx,
  type WriteOffInput,
} from "./settle";

export interface DeliveryWriteOffRequestInput extends Omit<WriteOffInput, "clientRequestId"> {
  requestKey: string;
}

export interface DeliveryWriteOffDecisionInput {
  id: number;
  expectedVersion: number;
  decisionKey: string;
  reviewNote?: string | null;
}

function normalizedText(value: string, label: string, min = 3, max = 500): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < min || normalized.length > max) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: `تعذّر حفظ ${label} في طلب شطب عهدة COD`,
        why: `الطول المطلوب بين ${min} و${max} محرفاً، والقيمة المُرسَلة ${normalized.length} محرفاً`,
        doThis: `اكتب ${label} بطولٍ ضمن هذا النطاق ثمّ أعد الحفظ`,
      }),
    });
  }
  return normalized;
}

function normalizedKey(value: string, label: string): string {
  return normalizedText(value, label, 8, 120);
}

type DeliveryWriteOffReviewActor = Actor & { reviewAuthorized?: boolean };

function assertRequestWriteOffAuthority(actor: Actor): void {
  if (actor.role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر فتح طلب شطب عهدة COD",
        why: "طلبات شطب عهدة COD محصورة بالمالك أو الأدمن بقرار المالك، وحسابك ليس منهما",
        doThis: "اطلب من المالك أو الأدمن فتح الطلب من شاشة «مناديب التوصيل»",
      }),
    });
  }
}

function assertReviewWriteOffAuthority(actor: DeliveryWriteOffReviewActor): void {
  if (actor.role !== "admin" && actor.reviewAuthorized !== true) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّرت مراجعة طلب شطب عهدة COD",
        why: "المراجعة تتطلب صلاحية إدارة التوصيل، وهي غير مُسنَدة إلى حسابك",
        doThis: "اطلب من المالك أو مدير التوصيل مراجعة الطلب من «طلبات شطب عهدة COD»",
      }),
    });
  }
}

function assertBranch(branchId: number, actor: Actor): void {
  if (!Number.isInteger(branchId) || branchId <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّرت معالجة طلب شطب عهدة COD",
        why: "فرع الطلب مطلوب ولم يصل رقم فرعٍ صحيح مع الطلب",
        doThis: "أعد فتح شاشة الطلب لتُملأ من الجلسة أو اختر الفرع صراحةً، ثم أعد الإرسال",
      }),
    });
  }
  if (actor.role !== "admin" && Number(actor.branchId) !== branchId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر التعامل مع طلب شطب عهدة COD",
        why: "الطلب مسجَّل على فرعٍ آخر لا يخص فرعك، ومدير الفرع محظور من العبور بين الفروع",
        doThis: "افتح الطلب من فرعه الأصليّ، أو اطلب من المالك/الأدمن معالجته",
      }),
    });
  }
}

function requestPayload(input: DeliveryWriteOffRequestInput) {
  const amount = round2(money(input.amount));
  if (amount.lte(0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حفظ طلب شطب عهدة COD",
        why: `مبلغ الشطب يجب أن يكون موجباً، والمبلغ المُرسَل ${amount.toString()}`,
        doThis: "أدخل مبلغاً موجباً في حقل «مبلغ الشطب» ثمّ أعد الحفظ",
      }),
    });
  }
  const reason = normalizedText(input.reason, "سبب الشطب");
  const evidenceNote = input.evidenceNote?.trim() || null;
  const attachmentUrl = input.attachmentUrl?.trim() || null;
  if (!evidenceNote && !attachmentUrl) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حفظ طلب شطب عهدة COD",
        why: "شطب عهدةٍ يلزمه إثباتٌ موثَّق: وصف الإثبات فارغ ورابط المرفق فارغ معاً",
        doThis: "اكتب وصفاً للإثبات (مكالمة/بلاغ/محضر) أو ألصق رابطاً للمرفق، ثمّ أعد الحفظ",
      }),
    });
  }
  if (evidenceNote && evidenceNote.length > 500) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حفظ وصف الإثبات",
        why: `طول وصف الإثبات فوق السقف: ${evidenceNote.length} من 500 محرف`,
        doThis: "اختصر الوصف إلى 500 محرفاً فأقلّ، وضع التفاصيل الطويلة في المرفق",
      }),
    });
  }
  if (attachmentUrl && attachmentUrl.length > 2048) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حفظ رابط المرفق",
        why: `طول الرابط فوق السقف: ${attachmentUrl.length} من 2048 محرف`,
        doThis: "ارفع الملف على مساحة المستودع واستعمل رابطاً مختصراً له",
      }),
    });
  }
  return {
    branchId: Number(input.branchId),
    partyId: Number(input.partyId),
    consignmentId: input.consignmentId == null ? null : Number(input.consignmentId),
    amount: toDbMoney(amount),
    reason,
    evidenceNote,
    attachmentUrl,
  };
}

function exactRequestReplay(
  row: typeof deliveryCodWriteOffRequests.$inferSelect,
  payloadHash: string,
  actor: Actor,
): boolean {
  return payloadHashMatches(payloadHash, row.payloadHash) && Number(row.requestedBy) === actor.userId;
}

function decisionHash(input: DeliveryWriteOffDecisionInput, decision: "APPROVE" | "REJECT", note: string | null) {
  return idempotencyHash({
    requestId: input.id,
    expectedVersion: input.expectedVersion,
    decision,
    reviewNote: note,
  });
}

function exactDecisionReplay(
  row: typeof deliveryCodWriteOffRequests.$inferSelect,
  input: DeliveryWriteOffDecisionInput,
  hash: string,
  actor: Actor,
  status: "APPROVED" | "REJECTED",
): boolean {
  return row.status === status
    && row.decisionKey === input.decisionKey
    && row.decisionHash === hash
    && Number(row.reviewedBy) === actor.userId;
}

/** مستند نيّة فقط: لا قيد، لا تغيير فاتورة/إرسالية، ولا خفض عهدة. */
export async function requestDeliveryCodWriteOff(input: DeliveryWriteOffRequestInput, actor: Actor) {
  assertRequestWriteOffAuthority(actor);
  const requestKey = normalizedKey(input.requestKey, "مفتاح الطلب");
  const payload = requestPayload(input);
  assertBranch(payload.branchId, actor);
  const payloadHash = idempotencyHash(payload);

  return withTx(async (tx) => {
    const replay = (
      await tx.select().from(deliveryCodWriteOffRequests)
        .where(eq(deliveryCodWriteOffRequests.requestKey, requestKey)).limit(1)
    )[0];
    if (replay) {
      assertBranch(Number(replay.branchId), actor);
      if (!exactRequestReplay(replay, payloadHash, actor)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر حفظ طلب شطب عهدة COD",
            why: "نفس مفتاح الطلب مستعمَل لطلبٍ سابقٍ بحمولةٍ مختلفة (جهة أو مبلغ أو سبب)، وإتمامه يعني تنفيذ طلبين بهويّةٍ واحدة",
            doThis: "حدّث الصفحة ليُولَّد مفتاح طلبٍ جديد، ثمّ أعد فتح الطلب بالبيانات الصحيحة",
          }),
        });
      }
      return { ...replay, replayed: true as const };
    }

    const party = (
      await tx.select().from(deliveryParties)
        .where(eq(deliveryParties.id, payload.partyId)).for("update").limit(1)
    )[0];
    if (!party) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر فتح طلب شطب عهدة COD",
          why: `جهة التوصيل رقم ${payload.partyId} غير موجودة أو أُزيلت`,
          doThis: "اختر جهةً موجودة من قائمة «مناديب التوصيل»، أو أنشئ الجهة أوّلاً",
        }),
      });
    }
    if (party.branchId == null || Number(party.branchId) !== payload.branchId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر فتح طلب شطب عهدة COD",
          why: `جهة التوصيل تخصّ فرعاً آخر (فرع ${party.branchId ?? "غير محدَّد"}) لا فرع الطلب (${payload.branchId})`,
          doThis: "افتح الطلب من فرع الجهة، أو اختر جهةً تخصّ فرع الطلب",
        }),
      });
    }
    if (money(payload.amount).gt(round2(money(party.currentBalance)))) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر فتح طلب شطب عهدة COD",
          why: `المبلغ (${payload.amount}) يتجاوز العهدة الحالية للجهة (${party.currentBalance})`,
          doThis: "خفّض مبلغ الشطب حتى يساوي العهدة أو أقلّ، وشغّل توريدَ ما فوقها في مسارٍ منفصل",
        }),
      });
    }
    if (payload.consignmentId != null) {
      const consignment = (
        await tx.select().from(deliveryConsignments)
          .where(eq(deliveryConsignments.id, payload.consignmentId)).for("update").limit(1)
      )[0];
      if (!consignment) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "تعذّر فتح طلب شطب عهدة COD",
            why: `الإرسالية رقم ${payload.consignmentId} غير موجودة أو أُزيلت`,
            doThis: "اختر إرساليةً موجودة، أو افتح الطلب بلا ربطٍ بإرساليةٍ محدّدة",
          }),
        });
      }
      if (Number(consignment.partyId) !== payload.partyId || Number(consignment.branchId) !== payload.branchId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذّر فتح طلب شطب عهدة COD",
            why: `الإرسالية تخصّ جهة/فرعاً مختلفَين (جهة ${consignment.partyId} / فرع ${consignment.branchId}) عن جهة الطلب (${payload.partyId} / فرع ${payload.branchId})`,
            doThis: "اختر إرسالية تخصّ نفس الجهة والفرع، أو ألغِ ربط الإرسالية بالطلب",
          }),
        });
      }
    }

    const pendingGuard = `PARTY:${payload.partyId}:${payload.consignmentId ?? "LOOSE"}`;
    try {
      const inserted = await tx.insert(deliveryCodWriteOffRequests).values({
        requestKey,
        partyId: payload.partyId,
        consignmentId: payload.consignmentId,
        branchId: payload.branchId,
        status: "PENDING",
        basePartyVersion: Number(party.version),
        amount: payload.amount,
        payload,
        payloadHash,
        reason: payload.reason,
        evidenceNote: payload.evidenceNote,
        attachmentUrl: payload.attachmentUrl,
        requestedBy: actor.userId,
        pendingGuard,
      });
      return {
        id: extractInsertId(inserted),
        requestKey,
        branchId: payload.branchId,
        partyId: payload.partyId,
        consignmentId: payload.consignmentId,
        basePartyVersion: Number(party.version),
        status: "PENDING" as const,
        payloadHash,
        replayed: false as const,
      };
    } catch (error) {
      if (!isDupEntry(error)) throw error;
      const raced = (
        await tx.select().from(deliveryCodWriteOffRequests)
          .where(eq(deliveryCodWriteOffRequests.requestKey, requestKey)).limit(1)
      )[0];
      if (raced && exactRequestReplay(raced, payloadHash, actor)) {
        return { ...raced, replayed: true as const };
      }
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر فتح طلب شطب عهدة COD",
          why: "يوجد طلب شطبٍ معلَّق سلفاً على نفس الجهة/الإرسالية، أو استُهلك مفتاح الطلب في محاولةٍ متزامنة",
          doThis: "افتح شاشة «طلبات شطب عهدة COD»، اعتمد أو ارفض الطلب المعلَّق، ثم افتح طلبك بمفتاحٍ جديد",
        }),
      });
    }
  }, { gate: "NONE" });
}

export async function approveDeliveryCodWriteOff(input: DeliveryWriteOffDecisionInput, actor: DeliveryWriteOffReviewActor) {
  assertReviewWriteOffAuthority(actor);
  const decisionKey = normalizedKey(input.decisionKey, "مفتاح القرار");
  const reviewNote = input.reviewNote?.trim() || null;
  if (reviewNote && reviewNote.length > 500) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حفظ ملاحظة القرار",
        why: `طول ملاحظة القرار فوق السقف: ${reviewNote.length} من 500 محرف`,
        doThis: "اختصر الملاحظة إلى 500 محرفاً فأقلّ، وضع الشرح المطوَّل في المرفق",
      }),
    });
  }
  const normalizedInput = { ...input, decisionKey };
  const hash = decisionHash(normalizedInput, "APPROVE", reviewNote);
  const result = await withTx(async (tx) => {
    const preview = (
      await tx.select().from(deliveryCodWriteOffRequests)
        .where(eq(deliveryCodWriteOffRequests.id, input.id)).limit(1)
    )[0];
    if (!preview) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر اعتماد طلب شطب عهدة COD",
          why: `طلب الشطب رقم ${input.id} غير موجود أو أُزيل`,
          doThis: "افتح شاشة «طلبات شطب عهدة COD» واختر الطلب من القائمة الحاليّة",
        }),
      });
    }
    assertBranch(Number(preview.branchId), actor);
    if (exactDecisionReplay(preview, normalizedInput, hash, actor, "APPROVED")) {
      return { request: preview, replayed: true as const };
    }
    if (preview.status !== "PENDING") {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر اعتماد طلب شطب عهدة COD",
          why: `الطلب محسومٌ سلفاً بالحالة ${preview.status} ولا يقبل قراراً جديداً`,
          doThis: "افتح شاشة الطلبات وراجع الحالة الحاليّة، وإن لزم شطبٌ آخر افتح طلباً جديداً",
        }),
      });
    }

    // ترتيب الأقفال: جهة التوصيل ← طلب الحوكمة ← الإرسالية/الفاتورة داخل نواة الشطب.
    const party = (
      await tx.select().from(deliveryParties)
        .where(eq(deliveryParties.id, Number(preview.partyId))).for("update").limit(1)
    )[0];
    if (!party) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر اعتماد طلب شطب عهدة COD",
          why: `جهة التوصيل رقم ${preview.partyId} غير موجودة أو أُزيلت بعد إنشاء الطلب`,
          doThis: "ارفض الطلب مع سببٍ صريح، ثم افتح طلباً جديداً على جهةٍ قائمة",
        }),
      });
    }
    const lockedRequest = (
      await tx.select().from(deliveryCodWriteOffRequests)
        .where(eq(deliveryCodWriteOffRequests.id, input.id)).for("update").limit(1)
    )[0];
    if (!lockedRequest) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر اعتماد طلب شطب عهدة COD",
          why: `طلب الشطب رقم ${input.id} أُزيل بعد فتح شاشة الاعتماد`,
          doThis: "حدّث شاشة الطلبات واختر طلباً قائماً",
        }),
      });
    }
    if (exactDecisionReplay(lockedRequest, normalizedInput, hash, actor, "APPROVED")) {
      return { request: lockedRequest, replayed: true as const };
    }
    if (lockedRequest.status !== "PENDING") {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر اعتماد طلب شطب عهدة COD",
          why: `الطلب محسومٌ سلفاً بالحالة ${lockedRequest.status} بينما كنت تراجعه`,
          doThis: "حدّث شاشة الطلبات لترى القرار الحاليّ؛ وإن لزم شطبٌ آخر افتح طلباً جديداً",
        }),
      });
    }
    if (Number(lockedRequest.requestedBy) === actor.userId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر اعتماد طلب شطب عهدة COD",
          why: "أنت من فتح هذا الطلب، وفصل المهام يمنع اعتماد الشخص لطلبه بنفسه",
          doThis: "اطلب من مدير توصيلٍ آخر أو من المالك اعتماد الطلب من نفس الشاشة",
        }),
      });
    }
    if (Number(lockedRequest.basePartyVersion) !== input.expectedVersion) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر اعتماد طلب شطب عهدة COD",
          why: `نسخة الطلب المتوقعة (${input.expectedVersion}) لا تطابق المحفوظة (${lockedRequest.basePartyVersion})`,
          doThis: "أعد تحميل شاشة الطلب لتقرأ النسخة الحاليّة ثمّ اعتمده",
        }),
      });
    }
    if (idempotencyHash(lockedRequest.payload) !== lockedRequest.payloadHash) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر اعتماد طلب شطب عهدة COD",
          why: "حمولة الطلب لا تطابق بصمتها المحفوظة (اختلاف داخليّ في الحفظ)",
          doThis: "ارفض الطلب مع سببٍ يوضّح الانحراف، ثمّ افتح طلباً جديداً بمفتاحٍ جديد",
        }),
      });
    }
    if (Number(party.version) !== Number(lockedRequest.basePartyVersion)) {
      const reviewedAt = new Date();
      await tx.update(deliveryCodWriteOffRequests).set({
        status: "STALE",
        pendingGuard: null,
        reviewedBy: actor.userId,
        reviewedAt,
        reviewNote: "تغيّرت عهدة جهة التوصيل بعد إنشاء الطلب",
        decisionKey,
        decisionHash: hash,
      }).where(and(
        eq(deliveryCodWriteOffRequests.id, input.id),
        eq(deliveryCodWriteOffRequests.status, "PENDING"),
      ));
      return { stale: true as const };
    }

    const storedPayload = lockedRequest.payload as unknown as ReturnType<typeof requestPayload>;
    const effect = await writeOffDeliveryShortfallInTx(tx, {
      ...storedPayload,
      clientRequestId: `delivery-writeoff-control-${input.id}`,
    }, { ...actor, branchId: Number(lockedRequest.branchId) }, { controlRequestAuthorized: true });
    const reviewedAt = new Date();
    const updated = await tx.update(deliveryCodWriteOffRequests).set({
      status: "APPROVED",
      pendingGuard: null,
      reviewedBy: actor.userId,
      reviewedAt,
      reviewNote,
      decisionKey,
      decisionHash: hash,
      appliedAt: reviewedAt,
    }).where(and(
      eq(deliveryCodWriteOffRequests.id, input.id),
      eq(deliveryCodWriteOffRequests.status, "PENDING"),
    ));
    if (extractAffectedRows(updated) !== 1) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر اعتماد طلب شطب عهدة COD",
          why: "تغيّرت حالة الطلب أثناء الاعتماد (اعتمده أو رفضه شخصٌ آخر في نفس اللحظة)",
          doThis: "حدّث شاشة الطلبات لترى القرار المُطبَّق، ولا حاجة لإعادة الاعتماد",
        }),
      });
    }
    return { request: { ...lockedRequest, status: "APPROVED" as const }, effect, replayed: false as const };
  });
  if ("stale" in result) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر اعتماد طلب شطب عهدة COD",
        why: "تغيّرت عهدة جهة التوصيل منذ إنشاء الطلب (قبضٌ أو تسليمٌ أو شطبٌ آخر)، والطلب وُسِم STALE",
        doThis: "افتح شاشة الطلبات وأنشئ طلباً جديداً بالأرقام الحاليّة للعهدة",
      }),
    });
  }
  return result;
}

export async function rejectDeliveryCodWriteOff(
  input: DeliveryWriteOffDecisionInput & { reason: string },
  actor: DeliveryWriteOffReviewActor,
) {
  assertReviewWriteOffAuthority(actor);
  const decisionKey = normalizedKey(input.decisionKey, "مفتاح القرار");
  const note = normalizedText(input.reason, "سبب الرفض");
  const normalizedInput = { ...input, decisionKey };
  const hash = decisionHash(normalizedInput, "REJECT", note);
  return withTx(async (tx) => {
    const request = (
      await tx.select().from(deliveryCodWriteOffRequests)
        .where(eq(deliveryCodWriteOffRequests.id, input.id)).for("update").limit(1)
    )[0];
    if (!request) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر رفض طلب شطب عهدة COD",
          why: `طلب الشطب رقم ${input.id} غير موجود أو أُزيل`,
          doThis: "افتح شاشة «طلبات شطب عهدة COD» واختر طلباً قائماً من القائمة",
        }),
      });
    }
    assertBranch(Number(request.branchId), actor);
    if (exactDecisionReplay(request, normalizedInput, hash, actor, "REJECTED")) {
      return { request, replayed: true as const };
    }
    if (request.status !== "PENDING") {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر رفض طلب شطب عهدة COD",
          why: `الطلب محسومٌ سلفاً بالحالة ${request.status} ولا يقبل قراراً جديداً`,
          doThis: "حدّث شاشة الطلبات لترى الحالة الحاليّة",
        }),
      });
    }
    if (Number(request.requestedBy) === actor.userId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر رفض طلب شطب عهدة COD",
          why: "أنت من فتح هذا الطلب، وفصل المهام يمنع مراجعة الشخص لطلبه بنفسه",
          doThis: "اطلب من مدير توصيلٍ آخر أو من المالك مراجعة الطلب من نفس الشاشة",
        }),
      });
    }
    if (Number(request.basePartyVersion) !== input.expectedVersion) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر رفض طلب شطب عهدة COD",
          why: `نسخة الطلب المتوقعة (${input.expectedVersion}) لا تطابق المحفوظة (${request.basePartyVersion})`,
          doThis: "أعد تحميل شاشة الطلب لتقرأ النسخة الحاليّة ثمّ ارفض الطلب",
        }),
      });
    }
    if (idempotencyHash(request.payload) !== request.payloadHash) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر رفض طلب شطب عهدة COD",
          why: "حمولة الطلب لا تطابق بصمتها المحفوظة (اختلاف داخليّ في الحفظ)",
          doThis: "ارفض الطلب من نسخته الأصليّة، أو راجع المدير/الأدمن",
        }),
      });
    }
    const reviewedAt = new Date();
    await tx.update(deliveryCodWriteOffRequests).set({
      status: "REJECTED",
      pendingGuard: null,
      reviewedBy: actor.userId,
      reviewedAt,
      reviewNote: note,
      decisionKey,
      decisionHash: hash,
    }).where(and(
      eq(deliveryCodWriteOffRequests.id, input.id),
      eq(deliveryCodWriteOffRequests.status, "PENDING"),
    ));
    return { request: { ...request, status: "REJECTED" as const, reviewNote: note }, replayed: false as const };
  }, { gate: "NONE" });
}

export async function listDeliveryCodWriteOffRequests(
  actor: DeliveryWriteOffReviewActor,
  options?: { status?: "PENDING" | "APPROVED" | "REJECTED" | "STALE"; branchId?: number | null },
) {
  assertReviewWriteOffAuthority(actor);
  if (options?.branchId != null) assertBranch(Number(options.branchId), actor);
  const effectiveBranchId = actor.role === "admin"
    ? (options?.branchId == null ? null : Number(options.branchId))
    : Number(actor.branchId);
  if (effectiveBranchId != null) assertBranch(effectiveBranchId, actor);
  const db = requireDb();
  return db.select({
    id: deliveryCodWriteOffRequests.id,
    requestKey: deliveryCodWriteOffRequests.requestKey,
    partyId: deliveryCodWriteOffRequests.partyId,
    partyName: deliveryParties.name,
    consignmentId: deliveryCodWriteOffRequests.consignmentId,
    consignmentNumber: deliveryConsignments.consignmentNumber,
    branchId: deliveryCodWriteOffRequests.branchId,
    status: deliveryCodWriteOffRequests.status,
    basePartyVersion: deliveryCodWriteOffRequests.basePartyVersion,
    amount: deliveryCodWriteOffRequests.amount,
    reason: deliveryCodWriteOffRequests.reason,
    evidenceNote: deliveryCodWriteOffRequests.evidenceNote,
    attachmentUrl: deliveryCodWriteOffRequests.attachmentUrl,
    requestedBy: deliveryCodWriteOffRequests.requestedBy,
    requesterName: users.name,
    reviewedBy: deliveryCodWriteOffRequests.reviewedBy,
    reviewedAt: deliveryCodWriteOffRequests.reviewedAt,
    reviewNote: deliveryCodWriteOffRequests.reviewNote,
    appliedAt: deliveryCodWriteOffRequests.appliedAt,
    createdAt: deliveryCodWriteOffRequests.createdAt,
  }).from(deliveryCodWriteOffRequests)
    .innerJoin(deliveryParties, eq(deliveryParties.id, deliveryCodWriteOffRequests.partyId))
    .leftJoin(deliveryConsignments, eq(deliveryConsignments.id, deliveryCodWriteOffRequests.consignmentId))
    .innerJoin(users, eq(users.id, deliveryCodWriteOffRequests.requestedBy))
    .where(and(
      options?.status ? eq(deliveryCodWriteOffRequests.status, options.status) : undefined,
      effectiveBranchId != null ? eq(deliveryCodWriteOffRequests.branchId, effectiveBranchId) : undefined,
    ))
    .orderBy(desc(deliveryCodWriteOffRequests.id))
    .limit(300);
}
