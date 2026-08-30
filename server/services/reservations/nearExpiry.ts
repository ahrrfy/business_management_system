/**
 * تنبيه واتساب للحجوزات القريبة من الانتهاء. السياسة المملوكة: PHONE/WHATSAPP فقط؛ STORE/WALK_IN
 * مستبعدتان. أثر `nearExpiryNotifiedAt` يخفّض المسح، وdedupeKey المرتبط بموعد الانتهاء هو ضمان
 * idempotency النهائي في outbox (ويتيح تنبيهاً جديداً بعد تمديد الموعد).
 */
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  customers,
  products,
  productUnits,
  productVariants,
  reservationLines,
  reservations,
} from "../../../drizzle/schema";
import { normalizeIraqPhoneE164 } from "../../lib/phone";
import { isBackgroundOperationActive, runAcrossActiveTenants } from "../../tenancy/backgroundTenants";
import { requireDb } from "../tx";
import {
  createFlowNotifyCycleCache,
  flowNotify,
  getWaHubSettings,
  type FlowNotifyInput,
  type FlowNotifyResult,
} from "../whatsapp";

const WINDOW_MS = 4 * 60 * 60 * 1000;
const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;
const TEMPLATE_NAME = "reservation_near_expiry";
const PAGE_SIZE = 200;

/** E.164 عام: + ثم 8–15 رقماً، وأول رقم ليس صفراً. التطبيع متسامح، لذلك يلزم حارس صريح قبل الأثر. */
function isDeliverableE164(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

type NotifyFn = (input: FlowNotifyInput) => Promise<FlowNotifyResult>;

interface NearExpiryCandidate {
  id: number;
  reservationNumber: string;
  branchId: number;
  customerId: number | null;
  customerName: string | null;
  contactName: string | null;
  contactPhone: string;
  expiresAt: Date;
}

export interface NotifyNearExpiryOptions {
  now?: Date;
  notify?: NotifyFn;
}

export interface NotifyNearExpiryResult {
  eligible: number;
  notified: number;
  skipped: number;
}

function formatBaghdadHm(value: Date): string {
  const baghdad = new Date(value.getTime() + BAGHDAD_OFFSET_MS);
  return `${String(baghdad.getUTCHours()).padStart(2, "0")}:${String(baghdad.getUTCMinutes()).padStart(2, "0")}`;
}

function formatQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function variantDetails(row: { variantName: string | null; color: string | null; size: string | null }): string {
  const parts = [row.variantName, row.color, row.size].map((v) => v?.trim()).filter(Boolean);
  return parts.length ? ` (${parts.join("، ")})` : "";
}

/** يحمي متغيّر القالب من قائمة أصناف استثنائية الطول مع إبقاء دلالة واضحة على الباقي. */
function summarizeItems(items: string[], maxLength = 900): string {
  if (!items.length) return "أصناف الحجز";
  const included: string[] = [];
  for (let index = 0; index < items.length; index++) {
    const afterNext = items.length - index - 1;
    const suffix = afterNext > 0 ? `، و${afterNext} أصناف أخرى` : "";
    const next = [...included, items[index]].join("، ");
    if (next.length + suffix.length > maxLength && included.length > 0) {
      return `${included.join("، ")}، و${items.length - index} أصناف أخرى`;
    }
    if (next.length > maxLength) return `${items[index].slice(0, maxLength - 1)}…`;
    included.push(items[index]);
  }
  return included.join("، ");
}

/** دورة واحدة قابلة للاختبار. لا ترمي بسبب فشل واتساب؛ `flowNotify` يعيد skip ويحاول الكرون لاحقاً. */
export async function notifyNearExpiryReservations(
  options: NotifyNearExpiryOptions = {},
): Promise<NotifyNearExpiryResult> {
  if (!isBackgroundOperationActive("reservation_near_expiry")) {
    const runs = await runAcrossActiveTenants(
      "reservation_near_expiry",
      () => notifyNearExpiryReservations(options),
    );
    return runs.reduce<NotifyNearExpiryResult>(
      (sum, run) => ({
        eligible: sum.eligible + run.eligible,
        notified: sum.notified + run.notified,
        skipped: sum.skipped + run.skipped,
      }),
      { eligible: 0, notified: 0, skipped: 0 },
    );
  }

  const db = requireDb();
  const now = options.now ?? new Date();
  const horizon = new Date(now.getTime() + WINDOW_MS);
  const notify = options.notify ?? flowNotify;
  const settings = await getWaHubSettings();
  // المفاتيح OFF افتراضياً: خروج واحد قبل مسح الحجوزات والبنود، لا N بوابات متطابقة كل دقيقة.
  if (settings.killSwitch || !settings.flowReservationNearExpiry) {
    return { eligible: 0, notified: 0, skipped: 0 };
  }
  const cycleCache = createFlowNotifyCycleCache();
  const finalWindowConditions = options.now
    ? [gt(reservations.expiresAt, now), lt(reservations.expiresAt, horizon)]
    : [
      gt(reservations.expiresAt, sql`NOW()`),
      lt(reservations.expiresAt, sql`DATE_ADD(NOW(), INTERVAL 4 HOUR)`),
    ];

  let eligible = 0;
  let notified = 0;
  let skipped = 0;
  let cursor: { expiresAt: Date; id: number } | null = null;

  while (true) {
    const candidates: NearExpiryCandidate[] = await db
      .select({
        id: reservations.id,
        reservationNumber: reservations.reservationNumber,
        branchId: reservations.branchId,
        customerId: reservations.customerId,
        customerName: customers.name,
        contactName: reservations.contactName,
        contactPhone: reservations.contactPhone,
        expiresAt: reservations.expiresAt,
      })
      .from(reservations)
      .leftJoin(customers, eq(customers.id, reservations.customerId))
      .where(and(
        eq(reservations.status, "ACTIVE"),
        inArray(reservations.channel, ["PHONE", "WHATSAPP"]),
        isNull(reservations.nearExpiryNotifiedAt),
        gt(reservations.expiresAt, now),
        lt(reservations.expiresAt, horizon),
        cursor
          ? or(
            gt(reservations.expiresAt, cursor.expiresAt),
            and(
              eq(reservations.expiresAt, cursor.expiresAt),
              gt(reservations.id, cursor.id),
            ),
          )
          : undefined,
      ))
      .orderBy(asc(reservations.expiresAt), asc(reservations.id))
      .limit(PAGE_SIZE);

    if (!candidates.length) break;
    eligible += candidates.length;

    const ids = candidates.map((r) => Number(r.id));
    const lines = await db
      .select({
        reservationId: reservationLines.reservationId,
        baseQuantity: reservationLines.baseQuantity,
        productName: products.name,
        variantName: productVariants.variantName,
        color: productVariants.color,
        size: productVariants.size,
        unitName: productUnits.unitName,
        conversionFactor: productUnits.conversionFactor,
      })
      .from(reservationLines)
      .innerJoin(productVariants, eq(productVariants.id, reservationLines.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .innerJoin(productUnits, eq(productUnits.id, reservationLines.productUnitId))
      .where(inArray(reservationLines.reservationId, ids))
      .orderBy(asc(reservationLines.id));

    const itemsByReservation = new Map<number, string[]>();
    for (const line of lines) {
      const factor = Number(line.conversionFactor);
      const quantity = factor > 0 ? Number(line.baseQuantity) / factor : Number(line.baseQuantity);
      const label = `${line.productName}${variantDetails(line)} × ${formatQuantity(quantity)} ${line.unitName}`;
      const key = Number(line.reservationId);
      itemsByReservation.set(key, [...(itemsByReservation.get(key) ?? []), label]);
    }

    for (const reservation of candidates) {
      const id = Number(reservation.id);
      const expiresAt = new Date(reservation.expiresAt);
      const toPhoneE164 = normalizeIraqPhoneE164(reservation.contactPhone);
      if (!isDeliverableE164(toPhoneE164)) {
        skipped++;
        continue;
      }
      // أعد التحقق بعد تحميل البنود: يقلّل نافذة إرسال تنبيه قديم إن أُلغي/مُدّد الحجز أثناء الدورة.
      const stillEligible = (await db
        .select({ id: reservations.id })
        .from(reservations)
        .where(and(
          eq(reservations.id, id),
          eq(reservations.status, "ACTIVE"),
          inArray(reservations.channel, ["PHONE", "WHATSAPP"]),
          eq(reservations.expiresAt, expiresAt),
          isNull(reservations.nearExpiryNotifiedAt),
          ...finalWindowConditions,
        ))
        .limit(1))[0];
      if (!stillEligible) {
        skipped++;
        continue;
      }
      const result = await notify({
        flowKey: "RESERVATION_NEAR_EXPIRY",
        branchId: Number(reservation.branchId),
        toPhoneE164,
        customerId: reservation.customerId == null ? null : Number(reservation.customerId),
        templateName: TEMPLATE_NAME,
        bodyParams: [
          reservation.reservationNumber,
          reservation.contactName?.trim() || reservation.customerName?.trim() || "العميل",
          summarizeItems(itemsByReservation.get(id) ?? []),
          formatBaghdadHm(expiresAt),
        ],
        dedupeKey: `RESERVATION_NEAR_EXPIRY:${id}:${expiresAt.getTime()}`,
        cycleCache,
        dispatchMode: "DEFERRED",
        deliveryGuard: {
          type: "RESERVATION_NEAR_EXPIRY",
          reservationId: id,
          expiresAt: expiresAt.toISOString(),
        },
        finalEligibilityCheck: async (tx) => {
          const current = (await tx
            .select({ id: reservations.id })
            .from(reservations)
            .where(and(
              eq(reservations.id, id),
              eq(reservations.status, "ACTIVE"),
              inArray(reservations.channel, ["PHONE", "WHATSAPP"]),
              eq(reservations.expiresAt, expiresAt),
              isNull(reservations.nearExpiryNotifiedAt),
              ...finalWindowConditions,
            ))
            .for("update")
            .limit(1))[0];
          return Boolean(current);
        },
      });

      if (!("queued" in result)) {
        skipped++;
        continue;
      }

      // outbox أولاً ثم الأثر: إن تعطّل العامل بينهما يعيد dedupe نفس الصف في الدورة التالية ثم يضع الأثر.
      // شرط expiresAt يمنع وسم موعد جديد إن مُدّد الحجز أثناء إرسال تنبيه الموعد القديم.
      await db
        .update(reservations)
        .set({ nearExpiryNotifiedAt: now })
        .where(and(
          eq(reservations.id, id),
          eq(reservations.status, "ACTIVE"),
          eq(reservations.expiresAt, expiresAt),
          isNull(reservations.nearExpiryNotifiedAt),
        ));
      notified++;
    }

    const last = candidates[candidates.length - 1];
    cursor = { expiresAt: new Date(last.expiresAt), id: Number(last.id) };
    if (candidates.length < PAGE_SIZE) break;
  }

  return { eligible, notified, skipped };
}
