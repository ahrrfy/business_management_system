import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { parseBusinessYmd, utcDayStart, utcNextDayStart } from "../businessDay";

/** Validate report dates before any DB read; timestamp bounds follow the UTC business day. */
export function deliveryReportDates(from?: string, to?: string) {
  try {
    if (from !== undefined) parseBusinessYmd(from);
    if (to !== undefined) parseBusinessYmd(to);
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر عرض تقرير التوصيل",
        why: "تاريخ البداية أو النهاية غير صالح أو لا يوجد في التقويم",
        doThis: "اختر تاريخاً صحيحاً بصيغة YYYY-MM-DD ثم أعد عرض التقرير",
      }),
    });
  }
  if (from !== undefined && to !== undefined && from > to) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر عرض تقرير التوصيل",
        why: "تاريخ النهاية يسبق تاريخ البداية",
        doThis:
          "اجعل تاريخ النهاية مساوياً لتاريخ البداية أو لاحقاً له ثم أعد عرض التقرير",
      }),
    });
  }
  return {
    start: from === undefined ? undefined : utcDayStart(from),
    endExclusive: to === undefined ? undefined : utcNextDayStart(to),
  };
}
