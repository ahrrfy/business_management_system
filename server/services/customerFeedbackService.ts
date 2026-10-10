/**
 * خدمة التغذية العكسية ورضا الزبائن وإدارة الشكاوى والأثر الذكي (CRM Feedback & Quality Hub).
 *
 * تربط تقييمات الزبائن بمحطات العمل وأوامر الشغل والفواتير، وتُحلل المشاعر،
 * وتُصدر كوبونات ترضية وإهداء فورية مع تسجيل سجل التدقيق الإلزامي.
 */

import { randomBytes, createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { appErrorMessage } from "@shared/errors";
import {
  FEEDBACK_CATEGORIES,
  type FeedbackCategory,
  ROOT_CAUSE_STATIONS,
  type RootCauseStation,
  ISSUE_STATUSES,
  type IssueStatus,
  SENTIMENTS,
  type Sentiment,
} from "@shared/customerFeedback";
import {
  branches,
  couponPrograms,
  coupons,
  customerFeedback,
  customers,
  invoices,
  promotions,
  users,
  workOrders,
} from "../../drizzle/schema";
import { logAuditTx } from "./auditService";
import { getAiStudioRuntime } from "./imageStudioSettingsService";
import { requireDb, withTx, type Actor, type MaybeScopedActor } from "./tx";
import { extractInsertId } from "../lib/insertId";

export {
  FEEDBACK_CATEGORIES,
  type FeedbackCategory,
  ROOT_CAUSE_STATIONS,
  type RootCauseStation,
  ISSUE_STATUSES,
  type IssueStatus,
  SENTIMENTS,
  type Sentiment,
};

export interface CreateCustomerFeedbackInput {
  customerId: number;
  branchId?: number | null;
  workOrderId?: number | null;
  invoiceId?: number | null;
  rating: number; // 1 to 5
  category: FeedbackCategory | string;
  comment?: string | null;
  rootCauseStation?: RootCauseStation | string | null;
  resolutionAction?: string | null;
  issueStatus?: IssueStatus;
}

export interface UpdateFeedbackStatusInput {
  feedbackId: number;
  customerId: number;
  issueStatus: IssueStatus;
  resolutionAction?: string | null;
  rootCauseStation?: RootCauseStation | string | null;
}

export interface IssueInstantGiftInput {
  customerId: number;
  amount: string;
  reason?: "COMPENSATION" | "VIP_GIFT" | "WELCOME" | string;
  feedbackId?: number | null;
  notes?: string | null;
  daysValid?: number;
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

export function hashCouponCode(code: string): string {
  return createHash("sha256").update(normalizeCode(code), "utf8").digest("hex");
}

export function generateGiftCode(prefix = "GIFT"): string {
  const safePrefix =
    prefix
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8) || "GIFT";
  const token = randomBytes(4).toString("hex").toUpperCase();
  return `${safePrefix}-${token.slice(0, 4)}-${token.slice(4)}`;
}

/**
 * تحليل المشاعر وصياغة الإرشاد الذكي عبر خوارزمية تشغيلية محكمة
 * مع استدعاء اختياري لنموذج Gemini حين يتوفر المفتاح.
 */
export async function analyzeFeedbackSentimentAndGuidance(params: {
  rating: number;
  category: string;
  comment?: string | null;
  customerName?: string;
  ltv?: string;
}): Promise<{ sentiment: Sentiment; smartGuidance: string }> {
  const comment = params.comment?.trim() || "";
  const rating = Math.max(1, Math.min(5, Math.round(params.rating)));

  // فحص استدعاء Gemini الذكي إن كان المفتاح متوفراً
  try {
    const aiRuntime = await getAiStudioRuntime();
    const apiKey = aiRuntime?.apiKey || process.env.GEMINI_API_KEY;

    if (apiKey && comment.length >= 4) {
      const prompt = `أنت مساعد تشغيلي ذكي لمطبعة تجارية في العراق (المكتبة العربية للطباعة).
حلل تقييم العميل التالي وأعد JSON حصراً:
اسم العميل: "${params.customerName || "عميل"}"
التقييم: ${rating} من 5 نجوم
التصنيف: ${params.category}
ملاحظة العميل: "${comment}"
المطلوب إعادته كائن JSON بالشكل التالي حصراً:
{
  "sentiment": "POSITIVE" | "NEUTRAL" | "NEGATIVE",
  "smartGuidance": "إرشاد عملي موجز للموظف أو الكاشير للتعامل مع هذا العميل"
}`;

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" },
          }),
          signal: AbortSignal.timeout(3500),
        },
      );

      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          const parsed = JSON.parse(text);
          if (
            parsed &&
            typeof parsed.smartGuidance === "string" &&
            ["POSITIVE", "NEUTRAL", "NEGATIVE"].includes(parsed.sentiment)
          ) {
            return {
              sentiment: parsed.sentiment as Sentiment,
              smartGuidance: parsed.smartGuidance.slice(0, 400),
            };
          }
        }
      }
    }
  } catch {
    // التراجع التلقائي للذكاء التشغيلي المدمج عند تعذر الاتصال
  }

  // محرك الذكاء التشغيلي والقواعد الخبيرة
  let sentiment: Sentiment = "NEUTRAL";
  let smartGuidance = "";

  if (rating >= 4) {
    sentiment = "POSITIVE";
    smartGuidance =
      "الزبون راضٍ جداً عن جودة الطباعة والتعامل. يُنصح بدعوته لتقييم المطبعة على Google Maps وتقديم عروض الطباعة الدورية لتعزيز ولائه.";
  } else if (rating === 3) {
    sentiment = "NEUTRAL";
    smartGuidance =
      "تقييم متوسط ومحايد. يرجى الاستفسار من الزبون بلطف عن تفاصيل تجربته مع سرعة التسليم وجودة الألوان لتحسين مستوى الرضا.";
  } else {
    sentiment = "NEGATIVE";
    switch (params.category) {
      case "PRINT_DELAY":
        smartGuidance =
          "تنبيه تأخير سابق: عانى الزبون من بطء في استلام المطبوعات. يرجى تأكيد الموعد النهائي بدقة وإعطاء أمره أولوية على خط الإنتاج وإهدائه كوبون ترضية.";
        break;
      case "COLOR_QUALITY":
        smartGuidance =
          "تنبيه تطابق ألوان: واجه الزبون ملاحظة على ألوان الطباعة. يُلزم الفني بطباعة عينة بروفة ومطابقتها مع شاشة المعايرة قبل سحب الكمية كاملة.";
        break;
      case "CUTTING":
        smartGuidance =
          "تنبيه دقة القص: سجل الزبون عتباً على دقة الأبعاد أو هوامش القص. وجّه محطة التشطيب لمراجعة علامات القص وهوامش الأمان بتركيز 100%.";
        break;
      case "LAMINATION":
        smartGuidance =
          "تنبيه سلفنة وحراري: لوحظت مشاكل في تغليف السلفنة. تأكد من تماسك الحرارة والضغط قبل تسليم المنتج النهائي للزبون.";
        break;
      case "DELIVERY":
        smartGuidance =
          "تنبيه شحن وتوصيل: واجه الزبون إشكالاً في التوصيل. يُنصح بمتابعة سائق التوصيل والتأكيد على التغليف الحامي وعنوان التسليم بدقة.";
        break;
      default:
        smartGuidance =
          "الزبون لديه شكوى غير مغلقة وعتب سابق. تعامل معه باهتمام استثنائي، واعرض عليه فوراً فحص مطبوعاته أو تعويضه بقسيمة هدية ترضية.";
        break;
    }
  }

  return { sentiment, smartGuidance };
}

export interface CustomerSmartGuidanceInput {
  hasOpenComplaint: boolean;
  isOverCreditLimit: boolean;
  isNearCreditLimit: boolean;
  isVip: boolean;
  frequentCustomer: boolean;
  canSeeBalance: boolean;
  creditLimit?: string | null;
  creditUsagePercent?: number;
  ltvFormatted?: string;
  latestFeedback?: {
    rating: number;
    issueStatus?: string | null;
    smartGuidance?: string | null;
  } | null;
}

/**
 * صياغة الإرشاد الذكي المركب للزبون وفق هرم أولويات تشغيلي ومالي صارم
 */
export function computeCustomerSmartGuidance(
  p: CustomerSmartGuidanceInput,
): string {
  // 1. أولوية قصوى: شكوى قيد المتابعة غير محلولة
  if (p.hasOpenComplaint) {
    if (
      p.latestFeedback &&
      (p.latestFeedback.issueStatus === "NEW" ||
        p.latestFeedback.issueStatus === "IN_PROGRESS") &&
      p.latestFeedback.smartGuidance
    ) {
      return p.latestFeedback.smartGuidance;
    }
    return "تنبيه تشغيلي عاجل: الزبون لديه شكوى قيد المتابعة لم تحل بعد. تعامل معه بأولوية وعناية فائقة واعرض عليه حلولاً سريعة.";
  }

  // 2. أولوية مالية: تجاوز سقف الائتمان المحدد
  if (p.isOverCreditLimit) {
    return p.canSeeBalance && p.creditLimit
      ? `تنبيه سقف الدين: الزبون تجاوز سقف الائتمان المحدد (${p.creditLimit} د.ع). يرجى تحصيل دفعة قبل بدء عمل جديد.`
      : "تنبيه سقف الدين: الزبون تجاوز سقف الائتمان المحدد. يرجى تحصيل دفعة قبل بدء عمل جديد.";
  }

  // 3. أولوية مالية: مشارفة سقف الائتمان
  if (p.isNearCreditLimit) {
    return p.canSeeBalance && p.creditLimit
      ? `تنبيه ائتماني: الزبون استنفد ${p.creditUsagePercent ?? 0}% من سقف الائتمان (${p.creditLimit} د.ع).`
      : "تنبيه ائتماني: الزبون قارب سقف الائتمان.";
  }

  // 4. ملاحظة جودة أو تقييم سلبي/متوسط سابق للزبون
  if (
    p.latestFeedback &&
    p.latestFeedback.rating <= 3 &&
    p.latestFeedback.smartGuidance
  ) {
    return p.latestFeedback.smartGuidance;
  }

  // 5. تقدير كبار العملاء VIP
  if (p.isVip) {
    return p.canSeeBalance && p.ltvFormatted
      ? `زبون ذهبي VIP — إجمالي إنفاقه ${p.ltvFormatted} د.ع. يرجى تقديم أولوية قصوى ومراعاة خاصة في التسليم وجودة الطباعة.`
      : "زبون ذهبي VIP — يرجى تقديم أولوية قصوى ومراعاة خاصة في التسليم وجودة الطباعة.";
  }

  // 6. تقدير الزبائن الدائمين المتكررين
  if (p.frequentCustomer) {
    return "زبون متكرر ودائم. احرص على سرعة الخدمة وعرض العروض الترويجية الحالية.";
  }

  // 7. إرشاد التقييم الإيجابي الأخير إن وجد
  if (p.latestFeedback?.smartGuidance) {
    return p.latestFeedback.smartGuidance;
  }

  // 8. الترحيب الافتراضي
  return "زبون مرحب به. احرص على تقديم أفضل تجربة طباعة وسؤاله عن رضا الخدمة.";
}

/**
 * تسجيل تقييم أو شكوى جديدة للعميل
 */
export async function recordCustomerFeedback(
  input: CreateCustomerFeedbackInput,
  actor: Actor | MaybeScopedActor,
) {
  return withTx(async (tx) => {
    // التحقق من وجود العميل
    const [customer] = await tx
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .limit(1);

    if (!customer) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذر تسجيل التقييم",
          why: "الزبون غير موجود في النظام",
          doThis: "تحقق من اختيار الزبون الصحيح أولاً",
        }),
      });
    }

    // التحقق من صحة ربط الفاتورة بالعميل لمنع ثغرات IDOR
    if (input.invoiceId != null) {
      const [inv] = await tx
        .select({ id: invoices.id, customerId: invoices.customerId })
        .from(invoices)
        .where(eq(invoices.id, input.invoiceId))
        .limit(1);

      if (!inv || inv.customerId !== input.customerId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذر ربط الفاتورة بالتقييم",
            why: "الفاتورة المحددة غير موجودة أو لا تخص هذا الزبون",
            doThis: "تأكد من اختيار فاتورة صحيحة صادرة لنفس الزبون",
          }),
        });
      }
    }

    // التحقق من صحة ربط أمر الشغل بالعميل لمنع ثغرات IDOR
    if (input.workOrderId != null) {
      const [wo] = await tx
        .select({ id: workOrders.id, customerId: workOrders.customerId })
        .from(workOrders)
        .where(eq(workOrders.id, input.workOrderId))
        .limit(1);

      if (!wo || wo.customerId !== input.customerId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذر ربط أمر الشغل بالتقييم",
            why: "أمر الشغل المحدد غير موجود أو لا يخص هذا الزبون",
            doThis: "تأكد من اختيار أمر شغل صحيح صادر لنفس الزبون",
          }),
        });
      }
    }

    // التحقق من رقم التقييم
    const rating = Math.max(1, Math.min(5, Math.round(input.rating)));

    // تحديد حالة المشكلة تلقائياً
    const defaultStatus: IssueStatus =
      input.issueStatus ??
      (rating <= 2 ? "NEW" : rating === 3 ? "IN_PROGRESS" : "RESOLVED");

    // تحليل المشاعر والإرشاد
    const { sentiment, smartGuidance } =
      await analyzeFeedbackSentimentAndGuidance({
        rating,
        category: input.category,
        comment: input.comment,
        customerName: customer.name,
      });

    const now = new Date();

    const [insertResult] = await tx.insert(customerFeedback).values({
      customerId: input.customerId,
      branchId: input.branchId ?? actor.branchId ?? null,
      workOrderId: input.workOrderId ?? null,
      invoiceId: input.invoiceId ?? null,
      rating,
      category: input.category,
      sentiment,
      comment: input.comment?.trim() || null,
      issueStatus: defaultStatus,
      rootCauseStation: input.rootCauseStation || null,
      resolutionAction: input.resolutionAction || null,
      resolvedBy:
        defaultStatus === "RESOLVED" || defaultStatus === "CLOSED"
          ? actor.userId
          : null,
      resolvedAt:
        defaultStatus === "RESOLVED" || defaultStatus === "CLOSED" ? now : null,
      smartGuidance,
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    });

    const feedbackId = extractInsertId(insertResult);

    await logAuditTx(tx, actor, {
      action: "crm.feedback.create",
      entityType: "customerFeedback",
      entityId: feedbackId,
      newValue: {
        customerId: input.customerId,
        rating,
        category: input.category,
        sentiment,
        issueStatus: defaultStatus,
      },
    });

    return {
      feedbackId,
      rating,
      sentiment,
      issueStatus: defaultStatus,
      smartGuidance,
    };
  });
}

/**
 * تحديث حالة الشكوى (جديدة -> قيد المعالجة -> تم الحل والتعويض)
 */
export async function updateCustomerFeedbackStatus(
  input: UpdateFeedbackStatusInput,
  actor: Actor | MaybeScopedActor,
) {
  return withTx(async (tx) => {
    const whereClause = and(
      eq(customerFeedback.id, input.feedbackId),
      eq(customerFeedback.customerId, input.customerId),
    );

    const [existing] = await tx
      .select()
      .from(customerFeedback)
      .where(whereClause)
      .for("update")
      .limit(1);

    if (!existing) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "سجل الشكوى غير موجود",
          why: "لم يتم العثور على سجل التقييم أو الشكوى في النظام برقم المعرف المحدد أو أنه لا يخص هذا الزبون",
          doThis: "تحقق من اختيار سجل الشكوى الصحيح وأعد المحاولة",
        }),
      });
    }

    const isResolved =
      input.issueStatus === "RESOLVED" || input.issueStatus === "CLOSED";
    const now = new Date();

    await tx
      .update(customerFeedback)
      .set({
        issueStatus: input.issueStatus,
        resolutionAction: input.resolutionAction ?? existing.resolutionAction,
        rootCauseStation: input.rootCauseStation ?? existing.rootCauseStation,
        resolvedBy: isResolved ? (existing.resolvedBy ?? actor.userId) : null,
        resolvedAt: isResolved ? (existing.resolvedAt ?? now) : null,
        updatedAt: now,
      })
      .where(whereClause);

    await logAuditTx(tx, actor, {
      action: "crm.feedback.statusUpdate",
      entityType: "customerFeedback",
      entityId: input.feedbackId,
      oldValue: { status: existing.issueStatus },
      newValue: {
        status: input.issueStatus,
        resolutionAction: input.resolutionAction,
      },
    });

    return { ok: true, status: input.issueStatus };
  });
}

/**
 * إصدار قسيمة هدية فورية لزبون (Instant Gift Coupon)
 * تستخدم لترضية الزبائن وتكريم كبار العملاء مع إنشاء البرنامج والعرض أصولياً إن لم يوجد.
 */
export async function issueCustomerInstantGift(
  input: IssueInstantGiftInput,
  actor: Actor | MaybeScopedActor,
) {
  return withTx(async (tx) => {
    // التحقق من صحة المبلغ المالي
    const amountDec = new Decimal(input.amount.trim() || "0");
    if (!amountDec.isPositive() || amountDec.isZero()) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "مبلغ قسيمة الهدية غير صالح",
          why: `المبلغ المدخل (${input.amount}) يجب أن يكون رقماً موجباً أكبر من الصفر`,
          doThis: "أدخل مبلغاً صحيحاً وموجباً بالدينار العراقي للمتابعة",
        }),
      });
    }

    const [customer] = await tx
      .select({
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
        whatsapp: customers.whatsapp,
      })
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .limit(1);

    if (!customer) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "الزبون غير موجود",
          why: "لم يتم العثور على بيانات الزبون المحدد في قاعدة البيانات",
          doThis: "اختر زبوناً مسجلاً في النظام قبل إصدار قسيمة الهدية",
        }),
      });
    }

    // البحث عن برنامج الكوبونات الخاص بالإهداء الفوري المطابق لمبلغ القسيمة أو إنشاؤه أصولياً
    // الكوبونات الفورية عابرة للفروع Cross-Branch (branchId = null)
    const existingProgramRow = (
      await tx
        .select({
          id: couponPrograms.id,
          promotionId: couponPrograms.promotionId,
          codePrefix: couponPrograms.codePrefix,
          branchId: couponPrograms.branchId,
          validTo: couponPrograms.validTo,
        })
        .from(couponPrograms)
        .innerJoin(promotions, eq(promotions.id, couponPrograms.promotionId))
        .where(
          and(
            eq(couponPrograms.codePrefix, "GIFT"),
            eq(couponPrograms.status, "ACTIVE"),
            eq(promotions.type, "AMOUNT"),
            eq(promotions.discountAmount, amountDec.toFixed(2)),
            isNull(couponPrograms.branchId),
          ),
        )
        .limit(1)
    )[0];

    let program = existingProgramRow;
    const now = new Date();
    const daysValid = Math.max(1, input.daysValid ?? 30);
    const validUntil = new Date(
      now.getTime() + daysValid * 24 * 60 * 60 * 1000,
    );

    if (existingProgramRow) {
      const existingValidToMs = existingProgramRow.validTo
        ? new Date(existingProgramRow.validTo).getTime()
        : 0;
      if (
        !existingProgramRow.validTo ||
        existingValidToMs < validUntil.getTime()
      ) {
        await tx
          .update(couponPrograms)
          .set({ validTo: validUntil, updatedAt: now })
          .where(eq(couponPrograms.id, existingProgramRow.id));
      }
    } else {
      // إنشاء Promotion كعرض كوبون أصولي يطابق تماماً قيمة الهدية المحددة (عابر للفروع)
      const [promoInsert] = await tx.insert(promotions).values({
        name: `قسائم إهداء وترضية (${amountDec.toFixed(0)} د.ع)`,
        type: "AMOUNT",
        discountAmount: amountDec.toFixed(2),
        discountPercent: "0.00",
        scope: "ALL",
        effectiveFrom: now,
        effectiveTo: null,
        branchId: null,
        minLineAmount: "0.00",
        priority: 10,
        isActive: true,
        applicationMode: "COUPON",
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
      });

      const promoId = extractInsertId(promoInsert);

      // إنشاء برنامج الكوبونات (عابر للفروع ومع ضبط تاريخ الصلاحية)
      const [progInsert] = await tx.insert(couponPrograms).values({
        promotionId: promoId,
        name: `برنامج إهداء وترضية الزبائن (${amountDec.toFixed(0)} د.ع)`,
        branchId: null,
        validFrom: now,
        validTo: validUntil,
        perCouponLimit: 1,
        perCustomerLimit: 100,
        codePrefix: "GIFT",
        status: "ACTIVE",
        designJson: {
          title: "قسيمة إهداء خاصة",
          subtitle: "المكتبة العربية للطباعة والقرطاسية",
          terms: "تُستخدم لمرة واحدة على أي فاتورة مبيعات أو أمر شغل",
          color: "#059669",
        },
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
      });

      const programId = extractInsertId(progInsert);
      program = {
        id: programId,
        promotionId: promoId,
        codePrefix: "GIFT",
        branchId: null,
        validTo: validUntil,
      };
    }

    // توليد رمز كوبون فريد
    const code = generateGiftCode(program.codePrefix);
    const codeH = hashCouponCode(code);

    const [couponInsert] = await tx.insert(coupons).values({
      programId: program.id,
      code,
      codeHash: codeH,
      customerId: input.customerId,
      status: "ACTIVE",
      redemptionCount: 0,
      issuedAt: now,
    });

    const couponId = extractInsertId(couponInsert);

    // إذا كانت القسيمة مرتبطة بشكوى، نتحقق من ملكيتها للزبون أولاً (سد ثغرة IDOR) ثم نغلقها كمعوضة
    if (input.feedbackId) {
      const [fb] = await tx
        .select({
          id: customerFeedback.id,
          customerId: customerFeedback.customerId,
        })
        .from(customerFeedback)
        .where(
          and(
            eq(customerFeedback.id, input.feedbackId),
            eq(customerFeedback.customerId, input.customerId),
          ),
        )
        .limit(1);

      if (!fb) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذر ربط القسيمة بالشكوى",
            why: "سجل الشكوى المحدد غير موجود أو لا يخص هذا الزبون",
            doThis: "تأكد من تحديد شكوى تابعة لنفس الزبون",
          }),
        });
      }

      await tx
        .update(customerFeedback)
        .set({
          giftCouponId: couponId,
          issueStatus: "RESOLVED",
          resolutionAction: `تم إهداء الزبون قسيمة هدية وترضية فورية بقيمة ${amountDec.toFixed(0)} د.ع (رمز: ${code})`,
          resolvedBy: actor.userId,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(customerFeedback.id, input.feedbackId),
            eq(customerFeedback.customerId, input.customerId),
          ),
        );
    }

    // تسجيل سجل التدقيق
    await logAuditTx(tx, actor, {
      action: "crm.instantGift.issue",
      entityType: "coupon",
      entityId: couponId,
      newValue: {
        code,
        customerId: input.customerId,
        amount: amountDec.toFixed(2),
        reason: input.reason || "ترضية وإهداء الزبون",
        feedbackId: input.feedbackId ?? null,
      },
    });

    return {
      couponId,
      code,
      amount: amountDec.toFixed(0),
      reason: input.reason || "ترضية وإهداء الزبون",
      validFrom: now.toISOString().slice(0, 10),
      validTo: validUntil.toISOString().slice(0, 10),
      customerName: customer.name,
      customerPhone: customer.phone || customer.whatsapp || null,
    };
  });
}

/**
 * تعليم إرسال دعوة تقييم خرائط كوكل
 */
export async function markGoogleReviewInviteSent(
  input: { feedbackId?: number; customerId: number },
  actor: Actor | MaybeScopedActor,
) {
  return withTx(async (tx) => {
    let targetFeedbackId = input.feedbackId;

    if (targetFeedbackId) {
      const [fb] = await tx
        .select({ id: customerFeedback.id })
        .from(customerFeedback)
        .where(
          and(
            eq(customerFeedback.id, targetFeedbackId),
            eq(customerFeedback.customerId, input.customerId),
          ),
        )
        .limit(1);

      if (!fb) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "تعذر تسجيل إرسال الدعوة",
            why: "سجل التقييم المحدد غير موجود أو لا يخص هذا الزبون",
            doThis: "تحقق من اختيار التقييم الصحيح قبل الإرسال",
          }),
        });
      }
    } else {
      const [latest5Star] = await tx
        .select({ id: customerFeedback.id })
        .from(customerFeedback)
        .where(
          and(
            eq(customerFeedback.customerId, input.customerId),
            eq(customerFeedback.rating, 5),
            eq(customerFeedback.googleReviewInviteSent, false),
          ),
        )
        .orderBy(desc(customerFeedback.id))
        .limit(1);

      if (latest5Star) {
        targetFeedbackId = latest5Star.id;
      }
    }

    if (targetFeedbackId) {
      await tx
        .update(customerFeedback)
        .set({ googleReviewInviteSent: true, updatedAt: new Date() })
        .where(
          and(
            eq(customerFeedback.id, targetFeedbackId),
            eq(customerFeedback.customerId, input.customerId),
          ),
        );
    }

    await logAuditTx(tx, actor, {
      action: "crm.googleReview.inviteSent",
      entityType: "customer",
      entityId: input.customerId,
      newValue: { feedbackId: targetFeedbackId ?? input.feedbackId ?? null },
    });

    return { ok: true };
  });
}

/**
 * جلب سجل التغذية العكسية والشكاوى مع الكوبونات المرتبطة
 */
export async function listCustomerFeedback(params?: {
  customerId?: number;
  limit?: number;
}) {
  const db = requireDb();
  const whereCond = params?.customerId
    ? eq(customerFeedback.customerId, params.customerId)
    : undefined;
  return db
    .select({
      id: customerFeedback.id,
      customerId: customerFeedback.customerId,
      workOrderId: customerFeedback.workOrderId,
      workOrderNumber: workOrders.orderNumber,
      rating: customerFeedback.rating,
      category: customerFeedback.category,
      sentiment: customerFeedback.sentiment,
      comment: customerFeedback.comment,
      issueStatus: customerFeedback.issueStatus,
      rootCauseStation: customerFeedback.rootCauseStation,
      resolutionAction: customerFeedback.resolutionAction,
      smartGuidance: customerFeedback.smartGuidance,
      googleReviewInviteSent: customerFeedback.googleReviewInviteSent,
      createdAt: customerFeedback.createdAt,
      giftCouponCode: coupons.code,
    })
    .from(customerFeedback)
    .leftJoin(coupons, eq(coupons.id, customerFeedback.giftCouponId))
    .leftJoin(workOrders, eq(workOrders.id, customerFeedback.workOrderId))
    .where(whereCond)
    .orderBy(desc(customerFeedback.id))
    .limit(params?.limit ?? 20);
}
