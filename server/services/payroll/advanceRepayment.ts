import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { fullEmployeeName } from "@shared/hr";
import { isDupEntry } from "@shared/errorMap.ar";
import { appErrorMessage } from "@shared/errors";
import {
  accountingEntries,
  employeeAdvanceRepaymentAllocations,
  employeeAdvanceRepaymentRequests,
  employeeAdvances,
  employees,
  receipts,
  users,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  assertCashOutAvailable,
  lockCashSourceForUpdate,
} from "../cash/cashAvailability";
import { baghdadToday } from "../businessDay";
import { postEntry } from "../ledgerService";
import { money, round2, toDateStr, toDbMoney } from "../money";
import { lockFinancialPostingGate } from "../reports/monthCloseGate";
import { assertPeriodOpen } from "../periodLockService";
import { requireDb, type Actor, withTx } from "../tx";
import {
  createPostingIntent,
  creditLine,
  debitLine,
  type AccountRole,
  type PostingProfile,
  type PostingSourceComponents,
} from "../accounting/postingEngine";
import { payrollHash } from "./helpers";
import { assertPayrollActiveOwnerChecker } from "./settlement";

export type AdvanceRepaymentRequestKind = "REPAYMENT" | "RETURN";
export type AdvanceRepaymentPaymentMethod = "CASH" | "CARD" | "TRANSFER" | "WALLET";

interface PaymentEvidenceInput {
  paymentMethod: AdvanceRepaymentPaymentMethod;
  cashBucket?: "DRAWER" | "TREASURY" | null;
  shiftId?: number | null;
  referenceNumber?: string | null;
  cardLastFour?: string | null;
  transactionDate: string;
  evidenceNote: string;
  clientRequestId: string;
}

export interface CreateAdvanceRepaymentInput extends PaymentEvidenceInput {
  employeeId: number;
  branchId: number;
  amount: string;
}

export interface CreateAdvanceRepaymentReturnInput extends PaymentEvidenceInput {
  originalRequestId: number;
}

export interface AdvanceRepaymentFilters {
  requestKind?: AdvanceRepaymentRequestKind;
  status?: "PENDING" | "APPROVED" | "REJECTED";
  employeeId?: number;
  branchId?: number;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function transactionDate(value: string): string {
  const normalized = value.trim();
  const parsed = Date.parse(`${normalized}T00:00:00.000Z`);
  if (
    !YMD_RE.test(normalized) ||
    Number.isNaN(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== normalized ||
    normalized > baghdadToday()
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسجيل حركة سداد السلفة",
        why: "تاريخ الحركة المُرسَل غير صالح بصيغته أو مستقبليّ عن تاريخ اليوم في بغداد",
        doThis: "أعد الإدخال بتاريخٍ ماضٍ أو تاريخ اليوم بصيغة YYYY-MM-DD",
      }),
    });
  }
  return normalized;
}

function clientRequestId(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسجيل طلب سداد السلفة",
        why: "مفتاح منع التكرار المُرسَل خارج الصيغة المسموحة (8-80 محرفاً من الحروف والأرقام و._:-)",
        doThis: "أعد المحاولة من الشاشة لتوليد مفتاحٍ جديد آلياً بدل تحريره يدوياً",
      }),
    });
  }
  return normalized;
}

function evidenceNote(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 10 || normalized.length > 500) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسجيل دليل سداد السلفة",
        why: "وصف الدليل خارج المدى المسموح (10-500 محرفاً) — الطول الحاليّ لا يكفي لتحرّي الحركة لاحقاً",
        doThis: "اكتب وصفاً موجزاً يذكر مصدر المبلغ ومرجعه (رقم إيصال أو تحويل) بين 10 و500 محرفاً",
      }),
    });
  }
  return normalized;
}

function normalizeEvidence(input: PaymentEvidenceInput) {
  const method = input.paymentMethod;
  const referenceNumber = input.referenceNumber?.trim().toUpperCase() || null;
  const cardLastFour = input.cardLastFour?.trim() || null;
  if (method === "CASH") {
    if (input.cashBucket !== "DRAWER" || !Number.isInteger(input.shiftId) || Number(input.shiftId) <= 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تسجيل سداد السلفة نقداً",
          why: "السداد النقدي يلزمه درج وردية مفتوحة، والطلب وصل بلا معرّف وردية أو خارج الدرج",
          doThis: "افتح وردية مبيعات ثمّ اختر «الدرج» في شاشة السداد النقدي وأعد الحفظ",
        }),
      });
    }
    if (referenceNumber || cardLastFour) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تسجيل سداد السلفة نقداً",
          why: "الطلب النقديّ يحمل مرجع تأكيدٍ إلكترونيّاً أو آخر أربعة أرقامٍ للبطاقة، والنقد يُقبض بلا مرجعٍ إلكترونيّ",
          doThis: "امسح حقلَي المرجع وأرقام البطاقة إذا كان السداد نقداً، أو غيّر طريقة الدفع لغير النقد",
        }),
      });
    }
    return {
      paymentMethod: method,
      cashBucket: "DRAWER" as const,
      shiftId: Number(input.shiftId),
      referenceNumber: null,
      cardLastFour: null,
      transactionDate: transactionDate(input.transactionDate),
      evidenceNote: evidenceNote(input.evidenceNote),
      clientRequestId: clientRequestId(input.clientRequestId),
    };
  }
  if (input.cashBucket != null || input.shiftId != null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسجيل سداد السلفة بغير النقد",
        why: "الطلب البطاقيّ/التحويل/المحفظة وصل مرتبطاً بدرج أو خزينة نقدية، وغير النقد لا يمسّ الدرج",
        doThis: "امسح خانة «مصدر النقد» (الدرج/الخزينة) وأعد الحفظ، أو غيّر طريقة الدفع إلى النقد",
      }),
    });
  }
  if (!referenceNumber) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسجيل سداد السلفة بغير النقد",
        why: "الدفع البطاقيّ/التحويل/المحفظة يلزمه مرجع تأكيدٍ خارجيّ (رقم إيصال البطاقة أو رقم التحويل)",
        doThis: "افتح إيصال جهاز البطاقة أو صورة التحويل، وانسخ رقم المرجع في حقل «رقم التأكيد الخارجي»",
      }),
    });
  }
  if (method === "CARD") {
    if (!/^\d{4}$/.test(cardLastFour ?? "")) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تسجيل سداد السلفة بالبطاقة",
          why: "آخر أربعة أرقام للبطاقة إمّا غائبة أو ليست أربعة أرقامٍ صحيحة",
          doThis: "افتح إيصال جهاز البطاقة واكتب آخر أربعة أرقام حرفياً في الحقل المخصّص",
        }),
      });
    }
  } else if (cardLastFour != null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسجيل سداد السلفة بالتحويل/المحفظة",
        why: "الطلب يحمل آخر أربعة أرقامٍ للبطاقة، وهي لا تخصّ التحويل ولا المحفظة",
        doThis: "امسح حقل أرقام البطاقة، أو غيّر طريقة الدفع إلى «بطاقة» إن كانت البطاقة هي الأداة الفعلية",
      }),
    });
  }
  return {
    paymentMethod: method,
    cashBucket: null,
    shiftId: null,
    referenceNumber,
    cardLastFour: method === "CARD" ? cardLastFour : null,
    transactionDate: transactionDate(input.transactionDate),
    evidenceNote: evidenceNote(input.evidenceNote),
    clientRequestId: clientRequestId(input.clientRequestId),
  };
}

async function assertActiveMaker(tx: Tx, actor: Actor, branchId: number): Promise<void> {
  const [row] = await tx
    .select({ isActive: users.isActive, isOwner: users.isOwner })
    .from(users)
    .where(eq(users.id, actor.userId))
    .for("share")
    .limit(1);
  if (!row?.isActive) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر إنشاء طلب سداد السلفة",
        why: "الحساب المُنشئ للطلب موقوف أو محذوف، ولا يقبل النظام إنشاء طلبٍ من مستخدمٍ غير نشط",
        doThis: "سجّل خروج ودخول بحسابٍ نشط، أو اطلب من المدير تفعيل الحساب من شاشة المستخدمين",
      }),
    });
  }
  if (!row.isOwner && actor.role !== "admin" && Number(actor.branchId) !== branchId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر إنشاء طلب سداد السلفة",
        why: "الطلب يخصّ فرعاً غير فرعك المُسنَد، وعبور الفروع محصورٌ بالمدير والمالك",
        doThis: "أنشئ الطلب من داخل فرع الموظّف، أو اطلب من المدير التنفيذ نيابةً",
      }),
    });
  }
}

function canonicalPayload(input: {
  requestKind: AdvanceRepaymentRequestKind;
  employeeId: number;
  branchId: number;
  originalRequestId: number | null;
  amount: string;
  evidence: ReturnType<typeof normalizeEvidence>;
}) {
  return {
    version: 1,
    domain: "EMPLOYEE_ADVANCE_REPAYMENT_REQUEST" as const,
    requestKind: input.requestKind,
    employeeId: input.employeeId,
    branchId: input.branchId,
    originalRequestId: input.originalRequestId,
    amount: input.amount,
    paymentMethod: input.evidence.paymentMethod,
    cashBucket: input.evidence.cashBucket,
    shiftId: input.evidence.shiftId,
    referenceNumber: input.evidence.referenceNumber,
    cardLastFour: input.evidence.cardLastFour,
    transactionDate: input.evidence.transactionDate,
    evidenceNote: input.evidence.evidenceNote,
    clientRequestId: input.evidence.clientRequestId,
  };
}

async function createRequestTx(
  tx: Tx,
  input: {
    requestKind: AdvanceRepaymentRequestKind;
    employeeId: number;
    branchId: number;
    originalRequestId: number | null;
    amount: string;
    evidence: ReturnType<typeof normalizeEvidence>;
  },
  actor: Actor,
) {
  await assertActiveMaker(tx, actor, input.branchId);
  const amount = round2(money(input.amount));
  if (!amount.isFinite() || amount.lte(0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسجيل سداد السلفة",
        why: "المبلغ المُرسَل صفرٌ أو سالبٌ أو غير رقميّ",
        doThis: "أدخل مبلغاً موجباً بالدينار العراقي (أكبر من صفر) وأعد الحفظ",
      }),
    });
  }
  const [employee] = await tx
    .select({ id: employees.id })
    .from(employees)
    .where(eq(employees.id, input.employeeId))
    .for("share")
    .limit(1);
  if (!employee)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر إنشاء طلب سداد السلفة",
        why: "الموظّف المرتبط بالطلب غير موجود في قاعدة البيانات، إمّا حُذف أو أُدخل بمعرّفٍ غير صحيح",
        doThis: "افتح شاشة الموظفين وتحقّق أنّ الموظّف قائم، ثمّ أعد اختياره من القائمة لا بتحرير معرّفه يدوياً",
      }),
    });

  const normalizedAmount = toDbMoney(amount);
  const canonical = canonicalPayload({ ...input, amount: normalizedAmount });
  const sourceHash = payrollHash(canonical);
  const evidenceHash = payrollHash({
    version: canonical.version,
    employeeId: canonical.employeeId,
    branchId: canonical.branchId,
    paymentMethod: canonical.paymentMethod,
    cashBucket: canonical.cashBucket,
    shiftId: canonical.shiftId,
    referenceNumber: canonical.referenceNumber,
    cardLastFour: canonical.cardLastFour,
    transactionDate: canonical.transactionDate,
    evidenceNote: canonical.evidenceNote,
  });
  const sourceKey = `ADVREP:${input.requestKind}:${input.evidence.clientRequestId}`;
  const [existing] = await tx
    .select()
    .from(employeeAdvanceRepaymentRequests)
    .where(eq(employeeAdvanceRepaymentRequests.sourceKey, sourceKey))
    .for("update")
    .limit(1);
  if (existing) {
    if (existing.sourceHash !== sourceHash) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر تسجيل طلب سداد السلفة",
          why: "نفس مفتاح منع التكرار وصل قبل قليل بمحتوىً مختلف عن الطلب الحالي، وإتمامه يعني تنفيذ طلبين بهويّةٍ واحدة",
          doThis: "حدّث الشاشة ليُولَّد مفتاحٌ جديد، ثمّ أعد الحفظ بالمبلغ والمرجع المعروضَين أمامك",
        }),
      });
    }
    return { ...existing, replayed: true };
  }
  try {
    const result = await tx.insert(employeeAdvanceRepaymentRequests).values({
      requestKind: input.requestKind,
      employeeId: input.employeeId,
      branchId: input.branchId,
      originalRequestId: input.originalRequestId,
      amount: normalizedAmount,
      ...input.evidence,
      transactionDate: new Date(`${input.evidence.transactionDate}T00:00:00.000Z`),
      sourceKey,
      sourceHash,
      evidenceHash,
      createdBy: actor.userId,
    });
    const id = extractInsertId(result);
    return { id, ...canonical, status: "PENDING" as const, sourceKey, sourceHash, evidenceHash, createdBy: actor.userId, replayed: false };
  } catch (error) {
    if (!isDupEntry(error)) throw error;
    const [concurrent] = await tx
      .select()
      .from(employeeAdvanceRepaymentRequests)
      .where(eq(employeeAdvanceRepaymentRequests.sourceKey, sourceKey))
      .limit(1);
    if (concurrent?.sourceHash === sourceHash) return { ...concurrent, replayed: true };
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر تسجيل طلب سداد السلفة",
        why: "مرجع التأكيد الخارجي (إيصال البطاقة أو رقم التحويل) أو مفتاح الطلب مسجَّل لحركةٍ أخرى",
        doThis: "افتح شاشة سداد السلف وابحث عن الحركة القائمة بهذا المرجع، أو استعمل مرجعاً جديداً غير مكرّر",
      }),
    });
  }
}

export async function createAdvanceRepaymentRequest(input: CreateAdvanceRepaymentInput, actor: Actor) {
  const evidence = normalizeEvidence(input);
  return withTx(async (tx) => {
    const amount = round2(money(input.amount));
    if (!amount.isFinite() || amount.lte(0)) {
      throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسجيل سداد السلفة",
        why: "المبلغ المُرسَل صفرٌ أو سالبٌ أو غير رقميّ",
        doThis: "أدخل مبلغاً موجباً بالدينار العراقي (أكبر من صفر) وأعد الحفظ",
      }),
    });
    }
    const [replayCandidate] = await tx
      .select({ id: employeeAdvanceRepaymentRequests.id })
      .from(employeeAdvanceRepaymentRequests)
      .where(eq(employeeAdvanceRepaymentRequests.sourceKey, `ADVREP:REPAYMENT:${evidence.clientRequestId}`))
      .limit(1);
    if (replayCandidate) {
      return createRequestTx(tx, {
        requestKind: "REPAYMENT",
        employeeId: input.employeeId,
        branchId: input.branchId,
        originalRequestId: null,
        amount: toDbMoney(amount),
        evidence,
      }, actor);
    }
    await lockFinancialPostingGate(tx);
    await assertPeriodOpen(tx, new Date(`${evidence.transactionDate}T12:00:00.000Z`));
    {
      const advances = await tx
        .select({ remaining: employeeAdvances.remaining })
        .from(employeeAdvances)
        .where(and(
          eq(employeeAdvances.employeeId, input.employeeId),
          eq(employeeAdvances.branchId, input.branchId),
          eq(employeeAdvances.status, "ACTIVE"),
        ));
      const outstanding = advances.reduce((sum, row) => sum.plus(money(row.remaining)), money(0));
      if (outstanding.lt(amount)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر تسجيل سداد السلفة",
            why: "المبلغ المُرسَل أكبر من إجمالي الرصيد المتبقّي لسلف الموظّف النشطة في فرعه",
            doThis: "افتح شاشة سلف الموظّف وتحقّق من الرصيد الفعليّ، ثمّ قسّم السداد أو خفّض المبلغ ليطابق الرصيد",
          }),
        });
      }
    }
    return createRequestTx(tx, {
      requestKind: "REPAYMENT",
      employeeId: input.employeeId,
      branchId: input.branchId,
      originalRequestId: null,
      amount: toDbMoney(amount),
      evidence,
    }, actor);
  });
}

export async function createAdvanceRepaymentReturnRequest(input: CreateAdvanceRepaymentReturnInput, actor: Actor) {
  const evidence = normalizeEvidence(input);
  return withTx(async (tx) => {
    await lockFinancialPostingGate(tx);
    const [original] = await tx
      .select()
      .from(employeeAdvanceRepaymentRequests)
      .where(eq(employeeAdvanceRepaymentRequests.id, input.originalRequestId))
      .for("update")
      .limit(1);
    if (!original || original.requestKind !== "REPAYMENT" || original.status !== "APPROVED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إنشاء طلب إعادة سداد السلفة",
          why: "الطلب الأصليّ ليس سداداً أو ليس معتمداً — لا يُعكس إلّا سدادٌ مُعتمَد ودائم",
          doThis: "افتح شاشة طلبات السداد وابحث عن طلبٍ حالته «معتمد»، ثمّ افتحه ثمّ اضغط «إعادة»",
        }),
      });
    }
    const requestInput = {
      requestKind: "RETURN" as const,
      employeeId: Number(original.employeeId),
      branchId: Number(original.branchId),
      originalRequestId: Number(original.id),
      amount: original.amount,
      evidence,
    };
    const [replayCandidate] = await tx
      .select({ id: employeeAdvanceRepaymentRequests.id })
      .from(employeeAdvanceRepaymentRequests)
      .where(eq(
        employeeAdvanceRepaymentRequests.sourceKey,
        `ADVREP:RETURN:${evidence.clientRequestId}`,
      ))
      .limit(1);
    if (replayCandidate) return createRequestTx(tx, requestInput, actor);
    await assertPeriodOpen(tx, new Date(`${evidence.transactionDate}T12:00:00.000Z`));
    const [activeReturn] = await tx
      .select({ id: employeeAdvanceRepaymentRequests.id })
      .from(employeeAdvanceRepaymentRequests)
      .where(and(
        eq(employeeAdvanceRepaymentRequests.originalRequestId, Number(original.id)),
        eq(employeeAdvanceRepaymentRequests.requestKind, "RETURN"),
        inArray(employeeAdvanceRepaymentRequests.status, ["PENDING", "APPROVED"]),
      ))
      .for("update")
      .limit(1);
    if (activeReturn) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر إنشاء طلب إعادة سداد السلفة",
          why: "لهذا السداد الأصليّ طلبُ إعادةٍ قائم بالفعل (معلَّق أو معتمَد)، ولا يُنشأ طلبُ إعادةٍ ثانٍ فوق قائم",
          doThis: "افتح شاشة طلبات السداد ورشّح على السداد الأصليّ لترى الطلب القائم، ثمّ تابعه (اعتماد/رفض) قبل إنشاء آخر",
        }),
      });
    }
    return createRequestTx(tx, requestInput, actor);
  });
}

function paymentAssetRole(method: AdvanceRepaymentPaymentMethod): Extract<AccountRole, "CASH" | "CARD_BANK" | "PAYMENT_WALLET"> {
  if (method === "CASH") return "CASH";
  if (method === "WALLET") return "PAYMENT_WALLET";
  return "CARD_BANK";
}

export function advanceRepaymentPosting(input: {
  requestKind: AdvanceRepaymentRequestKind;
  paymentMethod: AdvanceRepaymentPaymentMethod;
  amount: string;
}) {
  const amount = money(input.amount);
  const asset = paymentAssetRole(input.paymentMethod);
  const repayment = input.requestKind === "REPAYMENT";
  const profile: PostingProfile = repayment
    ? "PAYMENT_IN_EMPLOYEE_ADVANCE_REPAYMENT"
    : "PAYMENT_OUT_EMPLOYEE_ADVANCE_REPAYMENT_RETURN";
  const entryType = repayment ? "PAYMENT_IN" as const : "PAYMENT_OUT" as const;
  const debit = repayment ? asset : "EMPLOYEE_ADVANCES" as const;
  const credit = repayment ? "EMPLOYEE_ADVANCES" as const : asset;
  const source: PostingSourceComponents = {
    roleDebits: { [debit]: toDbMoney(amount) },
    roleCredits: { [credit]: toDbMoney(amount) },
  };
  return {
    amount,
    profile,
    entryType,
    source,
    intent: createPostingIntent(profile, entryType, [debitLine(debit, amount), creditLine(credit, amount)], source),
  };
}

async function materializeReceiptAndEntry(
  tx: Tx,
  request: typeof employeeAdvanceRepaymentRequests.$inferSelect,
  employeeName: string,
  actor: Actor,
) {
  const incoming = request.requestKind === "REPAYMENT";
  const movementDate = toDateStr(request.transactionDate);
  const receiptResult = await tx.insert(receipts).values({
    branchId: Number(request.branchId),
    shiftId: request.shiftId == null ? null : Number(request.shiftId),
    cashBucket: request.cashBucket,
    direction: incoming ? "IN" : "OUT",
    amount: request.amount,
    paymentMethod: request.paymentMethod,
    referenceNumber: request.referenceNumber,
    cardLastFour: request.cardLastFour,
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    approvedBy: actor.userId,
    approvedAt: new Date(),
    voucherNumber: `ADVREP-${incoming ? "IN" : "OUT"}-${request.id}`,
    partyType: "OTHER",
    partyId: null,
    counterpartyName: employeeName,
    voucherDate: new Date(`${movementDate}T00:00:00.000Z`),
    description: incoming ? `سداد سلفة الموظف ${employeeName}` : `إعادة سداد سلفة إلى الموظف ${employeeName}`,
    internalNote: JSON.stringify({
      version: 1,
      kind: "EMPLOYEE_ADVANCE_REPAYMENT",
      requestId: Number(request.id),
      requestKind: request.requestKind,
      employeeId: Number(request.employeeId),
      sourceHash: request.sourceHash,
      evidenceHash: request.evidenceHash,
    }),
    createdBy: actor.userId,
  });
  const receiptId = extractInsertId(receiptResult);
  const posting = advanceRepaymentPosting(request);
  const sourceKey = `ADVREP:ENTRY:${request.id}`;
  const occurredAt = new Date(`${movementDate}T12:00:00.000Z`);
  await postEntry(tx, {
    entryType: posting.entryType,
    branchId: Number(request.branchId),
    receiptId,
    amount: posting.amount,
    revenue: money(0),
    cost: money(0),
    profit: money(0),
    entryDate: occurredAt,
    dedupeKey: sourceKey,
    notes: incoming ? `سداد سلفة موظف — ${employeeName}` : `إعادة سداد سلفة موظف — ${employeeName}`,
    createdBy: actor.userId,
    paymentMethod: request.paymentMethod,
    postingIntent: posting.intent,
    postingSourceComponents: posting.source,
  });
  const [entry] = await tx
    .select({ id: accountingEntries.id })
    .from(accountingEntries)
    .where(eq(accountingEntries.dedupeKey, sourceKey))
    .limit(1);
  if (!entry) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر ربط سداد السلفة بقيده المحاسبي." });
  return { receiptId, accountingEntryId: Number(entry.id), occurredAt };
}

export async function approveAdvanceRepaymentRequest(id: number, actor: Actor) {
  return withTx(async (tx) => {
    const [preview] = await tx
      .select()
      .from(employeeAdvanceRepaymentRequests)
      .where(eq(employeeAdvanceRepaymentRequests.id, id))
      .limit(1);
    if (!preview)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر فتح طلب سداد السلفة",
          why: "الطلب المطلوب بمعرّفه غير موجود، إمّا حُذف أو أُدخل معرّفٌ غير صحيح",
          doThis: "ارجع لقائمة طلبات سداد السلف واختر الطلب من القائمة بدل تحرير المعرّف يدوياً",
        }),
      });
    // Global close/materialization order: posting gate → cash source → owner → request.
    // The later postEntry call reacquires the shared gate reentrantly.
    await lockFinancialPostingGate(tx);
    const [originalPreview] = preview.requestKind === "RETURN" && preview.originalRequestId != null
      ? await tx
          .select({
            id: employeeAdvanceRepaymentRequests.id,
            createdBy: employeeAdvanceRepaymentRequests.createdBy,
            reviewedBy: employeeAdvanceRepaymentRequests.reviewedBy,
          })
          .from(employeeAdvanceRepaymentRequests)
          .where(eq(employeeAdvanceRepaymentRequests.id, Number(preview.originalRequestId)))
          .limit(1)
      : [undefined];
    const forbiddenReviewers = [
      preview.createdBy,
      originalPreview?.createdBy,
      originalPreview?.reviewedBy,
    ];
    if (preview.status === "APPROVED") {
      await assertPayrollActiveOwnerChecker(
        tx,
        actor,
        forbiddenReviewers,
        "إعادة محاولة اعتماد سداد السلفة",
      );
      const [approved] = await tx
        .select()
        .from(employeeAdvanceRepaymentRequests)
        .where(eq(employeeAdvanceRepaymentRequests.id, id))
        .for("update")
        .limit(1);
      if (
        !approved ||
        approved.status !== "APPROVED" ||
        approved.sourceHash !== preview.sourceHash ||
        approved.receiptId == null ||
        approved.accountingEntryId == null
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر إعادة محاولة اعتماد سداد السلفة",
            why: "الطلب معتمد لكن لا يحمل معرّف إيصالٍ أو قيدٍ محاسبيّ كاملَين، أو تغيّر أحدهما بعد الاعتماد الأصليّ",
            doThis: "افتح تفاصيل الطلب المعتمد لمراجعة الإيصال والقيد، ثمّ اطلب من المدير معالجة الطلب يدوياً",
          }),
        });
      }
      return { ...approved, replayed: true };
    }
    if (preview.paymentMethod === "CASH") {
      await lockCashSourceForUpdate(tx, {
        branchId: Number(preview.branchId),
        cashBucket: "DRAWER",
        shiftId: Number(preview.shiftId),
      });
    }
    await assertPayrollActiveOwnerChecker(
      tx,
      actor,
      forbiddenReviewers,
      "اعتماد سداد السلفة",
    );
    const [request] = await tx
      .select()
      .from(employeeAdvanceRepaymentRequests)
      .where(eq(employeeAdvanceRepaymentRequests.id, id))
      .for("update")
      .limit(1);
    if (!request || request.sourceHash !== preview.sourceHash) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر اعتماد طلب سداد السلفة",
          why: "الطلب تغيّر (مبلغ أو موظّف أو مرجع) بين لحظة فتحه للمراجعة ولحظة الاعتماد",
          doThis: "أغلق الشاشة وأعد فتح الطلب من القائمة لعرض نسخته الحالية، ثمّ راجعها ثمّ اعتمد",
        }),
      });
    }
    if (request.status === "APPROVED") {
      if (request.receiptId == null || request.accountingEntryId == null) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر إتمام اعتماد طلب سداد السلفة",
            why: "الطلب مسجَّل معتمداً في القاعدة، لكن لا يحمل معرّف إيصالٍ أو قيدٍ محاسبيّ كاملَين",
            doThis: "افتح تفاصيل الطلب لمراجعة الإيصال والقيد، ثمّ اطلب من المدير إعادة الترحيل يدوياً",
          }),
        });
      }
      return { ...request, replayed: true };
    }
    if (request.status !== "PENDING") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر اعتماد طلب سداد السلفة",
          why: "الطلب ليس بحالة «معلَّق» — لا يُعتمد إلّا طلبٌ حالته معلَّقٌ بانتظار المراجع",
          doThis: "ارجع لقائمة طلبات سداد السلف ورشّح على «المعلَّق» لعرض ما يقبل الاعتماد",
        }),
      });
    }
    const [employee] = await tx
      .select({
        firstName: employees.firstName,
        fatherName: employees.fatherName,
        grandfatherName: employees.grandfatherName,
        lastName: employees.lastName,
      })
      .from(employees)
      .where(eq(employees.id, Number(request.employeeId)))
      .for("share")
      .limit(1);
    if (!employee)
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر اعتماد طلب سداد السلفة",
          why: "الموظّف المرتبط بالطلب لم يعد موجوداً — حُذف أو نُقل بمعرّفٍ جديد بعد إنشاء الطلب",
          doThis: "ارفض هذا الطلب وأبلغ **مدير الموارد البشرية** — الطلبُ يُنشئه HR لموظفٍ يختاره، فاستعادةُ سجلّ الموظّف (أو معرّفه الجديد) شرطُ إنشاءِ طلبٍ بديل، والموظّفُ لا يستطيع فعل ذلك من شاشته",
        }),
      });
    const employeeName = fullEmployeeName(employee) || `موظف #${request.employeeId}`;

    let applyAdvances: Array<typeof employeeAdvances.$inferSelect> = [];
    let reverseAllocations: Array<typeof employeeAdvanceRepaymentAllocations.$inferSelect> = [];
    let originalReceiptId: number | null = null;
    if (request.requestKind === "REPAYMENT") {
      applyAdvances = await tx
        .select()
        .from(employeeAdvances)
        .where(and(
          eq(employeeAdvances.employeeId, Number(request.employeeId)),
          eq(employeeAdvances.branchId, Number(request.branchId)),
          eq(employeeAdvances.status, "ACTIVE"),
        ))
        .orderBy(asc(employeeAdvances.id))
        .for("update");
      const outstanding = applyAdvances.reduce((sum, row) => sum.plus(money(row.remaining)), money(0));
      if (outstanding.lt(money(request.amount))) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر اعتماد طلب سداد السلفة",
            why: "الرصيد المتبقّي لسلف الموظّف تراجع بعد إنشاء الطلب فصار أقلّ من المبلغ المطلوب سداده",
            doThis: "ارفض هذا الطلب وأنشئ طلباً جديداً بالرصيد الحاليّ من شاشة سداد السلف",
          }),
        });
      }
    } else {
      const [original] = await tx
        .select()
        .from(employeeAdvanceRepaymentRequests)
        .where(eq(employeeAdvanceRepaymentRequests.id, Number(request.originalRequestId)))
        .for("update")
        .limit(1);
      if (
        !original || original.requestKind !== "REPAYMENT" || original.status !== "APPROVED" ||
        Number(original.employeeId) !== Number(request.employeeId) ||
        Number(original.branchId) !== Number(request.branchId) ||
        !money(original.amount).eq(money(request.amount)) || original.receiptId == null
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر اعتماد طلب إعادة سداد السلفة",
            why: "الطلب الأصليّ لم يعد سداداً معتمَداً مكتملاً، أو تغيّرت هويّته (موظّف أو فرع أو مبلغ) عن نسخة الطلب الحاليّ",
            doThis: "ارفض طلب الإعادة وأعد إنشاءه من صفحة السداد الأصليّ لضمان التطابق",
          }),
        });
      }
      const [otherApprovedReturn] = await tx
        .select({ id: employeeAdvanceRepaymentRequests.id })
        .from(employeeAdvanceRepaymentRequests)
        .where(and(
          eq(employeeAdvanceRepaymentRequests.originalRequestId, Number(original.id)),
          eq(employeeAdvanceRepaymentRequests.requestKind, "RETURN"),
          eq(employeeAdvanceRepaymentRequests.status, "APPROVED"),
          ne(employeeAdvanceRepaymentRequests.id, Number(request.id)),
        ))
        .limit(1);
      if (otherApprovedReturn)
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر اعتماد طلب إعادة سداد السلفة",
            why: "لهذا السداد الأصليّ إعادةٌ معتمَدةٌ فعلاً في طلبٍ آخر، ولا تُعتمد إعادةٌ ثانية فوق قائمة",
            doThis: "ارفض هذا الطلب، وافتح شاشة سداد السلف لعرض الإعادة القائمة",
          }),
        });
      const allocationPreview = await tx
        .select({
          id: employeeAdvanceRepaymentAllocations.id,
          advanceId: employeeAdvanceRepaymentAllocations.advanceId,
        })
        .from(employeeAdvanceRepaymentAllocations)
        .where(and(
          eq(employeeAdvanceRepaymentAllocations.requestId, Number(original.id)),
          eq(employeeAdvanceRepaymentAllocations.direction, "APPLY"),
        ));
      const advanceIds = Array.from(new Set(allocationPreview.map((row) => Number(row.advanceId))))
        .sort((a, b) => a - b);
      applyAdvances = advanceIds.length > 0
        ? await tx
            .select()
            .from(employeeAdvances)
            .where(inArray(employeeAdvances.id, advanceIds))
            .orderBy(asc(employeeAdvances.id))
            .for("update")
        : [];
      reverseAllocations = await tx
        .select()
        .from(employeeAdvanceRepaymentAllocations)
        .where(and(
          eq(employeeAdvanceRepaymentAllocations.requestId, Number(original.id)),
          eq(employeeAdvanceRepaymentAllocations.direction, "APPLY"),
        ))
        .orderBy(
          asc(employeeAdvanceRepaymentAllocations.advanceId),
          asc(employeeAdvanceRepaymentAllocations.id),
        )
        .for("update");
      if (
        reverseAllocations.length !== allocationPreview.length ||
        applyAdvances.length !== advanceIds.length
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر اعتماد طلب إعادة سداد السلفة",
            why: "سلف الموظّف أو تخصيصات السداد الأصليّ تغيّرت (عدد الصفوف اختلف) بين لحظة الفحص ولحظة الاعتماد",
            doThis: "أعد فتح الطلب من قائمة سداد السلف لعرض النسخة الحاليّة، ثمّ اعتمد",
          }),
        });
      }
      const total = reverseAllocations.reduce((sum, row) => sum.plus(money(row.amount)), money(0));
      if (!total.eq(money(request.amount)) || reverseAllocations.length === 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر اعتماد طلب إعادة سداد السلفة",
            why: "مجموع تخصيصات السداد الأصليّ لا يطابق مبلغ الطلب، أو لا يوجد له أيّ تخصيص",
            doThis: "ارفض هذا الطلب واطلب من المدير إعادة تسجيل السداد الأصليّ بتخصيصاته الصحيحة",
          }),
        });
      }
      originalReceiptId = Number(original.receiptId);
      const [originalReceipt] = await tx
        .select({ status: receipts.status })
        .from(receipts)
        .where(eq(receipts.id, originalReceiptId))
        .for("update")
        .limit(1);
      if (!originalReceipt || originalReceipt.status !== "COMPLETED") {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر اعتماد طلب إعادة سداد السلفة",
            why: "إيصال السداد الأصليّ ليس بحالة «مكتمل» — قد يكون ملغىً أو معاداً، فلا يقبل إعادة",
            doThis: "افتح الإيصال الأصليّ للتحقّق من حالته، ثمّ ارفض هذا الطلب إن لم يعد الإيصال قابلاً للإعادة",
          }),
        });
      }
      if (request.paymentMethod === "CASH") {
        await assertCashOutAvailable(tx, {
          branchId: Number(request.branchId),
          cashBucket: "DRAWER",
          shiftId: Number(request.shiftId),
          amount: request.amount,
          operation: "إعادة سداد سلفة الموظف",
        });
      }
    }

    const materialized = await materializeReceiptAndEntry(tx, request, employeeName, actor);
    if (request.requestKind === "REPAYMENT") {
      let left = money(request.amount);
      for (const advance of applyAdvances) {
        if (left.lte(0)) break;
        const before = money(advance.remaining);
        if (before.lte(0)) continue;
        const applied = round2(before.lt(left) ? before : left);
        const after = round2(before.minus(applied));
        left = round2(left.minus(applied));
        await tx.update(employeeAdvances).set({
          remaining: toDbMoney(after),
          status: after.isZero() ? "SETTLED" : "ACTIVE",
        }).where(eq(employeeAdvances.id, Number(advance.id)));
        await tx.insert(employeeAdvanceRepaymentAllocations).values({
          requestId: Number(request.id),
          advanceId: Number(advance.id),
          direction: "APPLY",
          amount: toDbMoney(applied),
          receiptId: materialized.receiptId,
          accountingEntryId: materialized.accountingEntryId,
          sourceKey: `ADVREP:ALLOC:${request.id}:${advance.id}`,
          occurredAt: materialized.occurredAt,
          createdBy: actor.userId,
        });
      }
      if (!left.isZero())
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر اعتماد طلب سداد السلفة",
            why: "بقيَ جزءٌ من مبلغ السداد لم يجد سلفةً نشطة يُخصَم عليها بعد توزيع الرصيد المتاح",
            doThis: "ارفض هذا الطلب وأنشئ طلباً جديداً بالرصيد الفعليّ من شاشة سداد السلف",
          }),
        });
    } else {
      const advancesById = new Map(applyAdvances.map((row) => [Number(row.id), row]));
      for (const allocation of reverseAllocations) {
        const advance = advancesById.get(Number(allocation.advanceId));
        if (!advance)
          throw new TRPCError({
            code: "CONFLICT",
            message: appErrorMessage({
              what: "تعذّر اعتماد طلب إعادة سداد السلفة",
              why: "إحدى السلف التي خُصم عليها السداد الأصليّ لم تعد موجودة في قاعدة البيانات",
              doThis: "ارفض هذا الطلب واطلب من المدير التحقّق من سلف الموظّف قبل إعادة إنشاء طلب الإعادة",
            }),
          });
        const restored = round2(money(advance.remaining).plus(money(allocation.amount)));
        if (restored.gt(money(advance.amount))) {
          throw new TRPCError({
            code: "CONFLICT",
            message: appErrorMessage({
              what: "تعذّر اعتماد طلب إعادة سداد السلفة",
              why: "إعادة التخصيص على إحدى السلف ستجعل رصيدها المتبقّي أكبر من مبلغها الأصليّ",
              doThis: "ارفض هذا الطلب واطلب من المدير التحقّق من أرصدة سلف الموظّف قبل الإعادة",
            }),
          });
        }
        await tx.update(employeeAdvances).set({ remaining: toDbMoney(restored), status: "ACTIVE" })
          .where(eq(employeeAdvances.id, Number(advance.id)));
        await tx.insert(employeeAdvanceRepaymentAllocations).values({
          requestId: Number(request.id),
          advanceId: Number(advance.id),
          direction: "REVERSE",
          amount: allocation.amount,
          reversalOfId: Number(allocation.id),
          receiptId: materialized.receiptId,
          accountingEntryId: materialized.accountingEntryId,
          sourceKey: `ADVREP:ALLOC-REV:${request.id}:${allocation.id}`,
          occurredAt: materialized.occurredAt,
          createdBy: actor.userId,
        });
      }
      await tx.update(receipts).set({ status: "REVERSED" }).where(eq(receipts.id, originalReceiptId!));
    }

    const reviewedAt = new Date();
    await tx.update(employeeAdvanceRepaymentRequests).set({
      status: "APPROVED",
      receiptId: materialized.receiptId,
      accountingEntryId: materialized.accountingEntryId,
      reviewedBy: actor.userId,
      reviewedAt,
    }).where(eq(employeeAdvanceRepaymentRequests.id, Number(request.id)));
    return {
      ...request,
      status: "APPROVED" as const,
      receiptId: materialized.receiptId,
      accountingEntryId: materialized.accountingEntryId,
      reviewedBy: actor.userId,
      reviewedAt,
      replayed: false,
    };
  });
}

export async function rejectAdvanceRepaymentRequest(id: number, reason: string, actor: Actor) {
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 5 || normalizedReason.length > 255) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر رفض طلب سداد السلفة",
        why: "سبب الرفض المُرسَل خارج المدى المسموح (5-255 محرفاً) — لا يُكتفى بحرفٍ أو حرفَين",
        doThis: "اكتب سبب الرفض بجملةٍ واضحة تشرح للطالب ما يُصلحه، بين 5 و255 محرفاً",
      }),
    });
  }
  return withTx(async (tx) => {
    const [preview] = await tx
      .select()
      .from(employeeAdvanceRepaymentRequests)
      .where(eq(employeeAdvanceRepaymentRequests.id, id))
      .limit(1);
    if (!preview)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر فتح طلب سداد السلفة",
          why: "الطلب المطلوب بمعرّفه غير موجود، إمّا حُذف أو أُدخل معرّفٌ غير صحيح",
          doThis: "ارجع لقائمة طلبات سداد السلف واختر الطلب من القائمة بدل تحرير المعرّف يدوياً",
        }),
      });
    const [original] = preview.requestKind === "RETURN" && preview.originalRequestId != null
      ? await tx
          .select({
            createdBy: employeeAdvanceRepaymentRequests.createdBy,
            reviewedBy: employeeAdvanceRepaymentRequests.reviewedBy,
          })
          .from(employeeAdvanceRepaymentRequests)
          .where(eq(employeeAdvanceRepaymentRequests.id, Number(preview.originalRequestId)))
          .limit(1)
      : [undefined];
    await assertPayrollActiveOwnerChecker(
      tx,
      actor,
      [preview.createdBy, original?.createdBy, original?.reviewedBy],
      "رفض سداد السلفة",
    );
    const [request] = await tx
      .select()
      .from(employeeAdvanceRepaymentRequests)
      .where(eq(employeeAdvanceRepaymentRequests.id, id))
      .for("update")
      .limit(1);
    if (!request || request.sourceHash !== preview.sourceHash) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر رفض طلب سداد السلفة",
          why: "الطلب تغيّر (مبلغ أو موظّف أو مرجع) بين لحظة فتحه للمراجعة ولحظة الرفض",
          doThis: "أغلق الشاشة وأعد فتح الطلب من قائمة سداد السلف لعرض نسخته الحاليّة، ثمّ راجعها ثمّ ارفض بسببٍ محدَّث",
        }),
      });
    }
    if (request.status === "REJECTED") {
      if (request.rejectionReason !== normalizedReason) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر إعادة محاولة رفض طلب سداد السلفة",
            why: "الطلب مرفوضٌ سابقاً بسببٍ مسجَّل، ومحاولة الرفض الجديدة تحمل سبباً مختلفاً — لا يتغيّر سبب رفضٍ منجَز",
            doThis: "افتح الطلب المرفوض لعرض السبب المسجَّل، وأعد المحاولة بنفس السبب إن أردت التأكيد أو أعد فتحه لإدخال سببٍ جديد",
          }),
        });
      }
      return { ...request, replayed: true };
    }
    if (request.status !== "PENDING") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر رفض طلب سداد السلفة",
          why: "الطلب ليس بحالة «معلَّق» — لا يُرفض إلّا طلبٌ حالته معلَّقٌ بانتظار المراجع",
          doThis: "ارجع لقائمة طلبات سداد السلف ورشّح على «المعلَّق» لعرض ما يقبل الرفض",
        }),
      });
    }
    const reviewedAt = new Date();
    await tx.update(employeeAdvanceRepaymentRequests).set({
      status: "REJECTED",
      reviewedBy: actor.userId,
      reviewedAt,
      rejectionReason: normalizedReason,
    }).where(eq(employeeAdvanceRepaymentRequests.id, id));
    return { ...request, status: "REJECTED" as const, reviewedBy: actor.userId, reviewedAt, rejectionReason: normalizedReason, replayed: false };
  });
}

export async function listAdvanceRepaymentRequests(filters?: AdvanceRepaymentFilters) {
  if (filters?.branchId != null && (!Number.isInteger(filters.branchId) || filters.branchId <= 0)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر عرض طلبات سداد السلف",
        why: "الجلسة الحاليّة بلا فرعٍ مُسنَد، والاطّلاع محصورٌ بفرع الموظّف",
        doThis: "اخرج ثم ادخل بمستخدمٍ له فرعٌ مُسنَد، أو اطلب من المدير تحديد فرعك من شاشة المستخدمين",
      }),
    });
  }
  const where = [
    filters?.requestKind ? eq(employeeAdvanceRepaymentRequests.requestKind, filters.requestKind) : undefined,
    filters?.status ? eq(employeeAdvanceRepaymentRequests.status, filters.status) : undefined,
    filters?.employeeId ? eq(employeeAdvanceRepaymentRequests.employeeId, filters.employeeId) : undefined,
    filters?.branchId != null ? eq(employeeAdvanceRepaymentRequests.branchId, filters.branchId) : undefined,
  ].filter(Boolean) as ReturnType<typeof eq>[];
  return requireDb()
    .select({
      id: employeeAdvanceRepaymentRequests.id,
      requestKind: employeeAdvanceRepaymentRequests.requestKind,
      status: employeeAdvanceRepaymentRequests.status,
      employeeId: employeeAdvanceRepaymentRequests.employeeId,
      branchId: employeeAdvanceRepaymentRequests.branchId,
      originalRequestId: employeeAdvanceRepaymentRequests.originalRequestId,
      amount: employeeAdvanceRepaymentRequests.amount,
      paymentMethod: employeeAdvanceRepaymentRequests.paymentMethod,
      cashBucket: employeeAdvanceRepaymentRequests.cashBucket,
      shiftId: employeeAdvanceRepaymentRequests.shiftId,
      referenceNumber: employeeAdvanceRepaymentRequests.referenceNumber,
      cardLastFour: employeeAdvanceRepaymentRequests.cardLastFour,
      transactionDate: employeeAdvanceRepaymentRequests.transactionDate,
      evidenceNote: employeeAdvanceRepaymentRequests.evidenceNote,
      sourceHash: employeeAdvanceRepaymentRequests.sourceHash,
      evidenceHash: employeeAdvanceRepaymentRequests.evidenceHash,
      receiptId: employeeAdvanceRepaymentRequests.receiptId,
      accountingEntryId: employeeAdvanceRepaymentRequests.accountingEntryId,
      createdBy: employeeAdvanceRepaymentRequests.createdBy,
      reviewedBy: employeeAdvanceRepaymentRequests.reviewedBy,
      reviewedAt: employeeAdvanceRepaymentRequests.reviewedAt,
      rejectionReason: employeeAdvanceRepaymentRequests.rejectionReason,
      createdAt: employeeAdvanceRepaymentRequests.createdAt,
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
    })
    .from(employeeAdvanceRepaymentRequests)
    .leftJoin(employees, eq(employeeAdvanceRepaymentRequests.employeeId, employees.id))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(employeeAdvanceRepaymentRequests.id))
    .then((rows) => rows.map((row) => ({ ...row, employeeName: fullEmployeeName(row) })));
}

export async function getAdvanceRepaymentRequest(id: number, branchId?: number) {
  const db = requireDb();
  if (branchId != null && (!Number.isInteger(branchId) || branchId <= 0)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر عرض طلبات سداد السلف",
        why: "الجلسة الحاليّة بلا فرعٍ مُسنَد، والاطّلاع محصورٌ بفرع الموظّف",
        doThis: "اخرج ثم ادخل بمستخدمٍ له فرعٌ مُسنَد، أو اطلب من المدير تحديد فرعك من شاشة المستخدمين",
      }),
    });
  }
  const rows = await db
    .select({
      request: employeeAdvanceRepaymentRequests,
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
    })
    .from(employeeAdvanceRepaymentRequests)
    .leftJoin(employees, eq(employeeAdvanceRepaymentRequests.employeeId, employees.id))
    .where(and(
      eq(employeeAdvanceRepaymentRequests.id, id),
      branchId != null ? eq(employeeAdvanceRepaymentRequests.branchId, branchId) : undefined,
    ))
    .limit(1);
  if (!rows[0])
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر فتح طلب سداد السلفة",
        why: "الطلب المطلوب إمّا حُذف، أو يخصّ فرعاً خارج نطاقك",
        doThis: "ارجع لقائمة طلبات سداد السلف واختر الطلب من قائمة فرعك، أو اطلب من المدير التحقّق من نطاقك",
      }),
    });
  const allocations = await db
    .select()
    .from(employeeAdvanceRepaymentAllocations)
    .where(eq(employeeAdvanceRepaymentAllocations.requestId, id))
    .orderBy(asc(employeeAdvanceRepaymentAllocations.id));
  const row = rows[0];
  return {
    ...row.request,
    employeeName: fullEmployeeName(row),
    allocations,
  };
}

export async function listAdvanceRepaymentLedger(filters?: Omit<AdvanceRepaymentFilters, "status">) {
  const requests = await listAdvanceRepaymentRequests({ ...filters, status: "APPROVED" });
  if (requests.length === 0) return [];
  const allocations = await requireDb()
    .select()
    .from(employeeAdvanceRepaymentAllocations)
    .where(inArray(employeeAdvanceRepaymentAllocations.requestId, requests.map((row) => Number(row.id))))
    .orderBy(asc(employeeAdvanceRepaymentAllocations.id));
  const byRequest = new Map<number, typeof allocations>();
  for (const allocation of allocations) {
    const list = byRequest.get(Number(allocation.requestId)) ?? [];
    list.push(allocation);
    byRequest.set(Number(allocation.requestId), list);
  }
  return requests.map((request) => ({ ...request, allocations: byRequest.get(Number(request.id)) ?? [] }));
}
