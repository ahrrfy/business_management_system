import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { fmt } from "@/lib/money";
import { releaseReservedPrintWindow, reservePrintWindow } from "@/lib/printing/brand";
import { printShiftOpen } from "@/lib/printing/print";

export function usePOSShiftOpening({
  onOpened,
  opening,
  cashierName,
  branchName,
}: {
  onOpened: () => Promise<unknown>;
  opening: string;
  cashierName: string;
  branchName: string;
}) {
  const m = trpc.shifts.open.useMutation({
    onSuccess: async (res) => {
      try { await onOpened(); } catch { /* noop */ }
      if (res.treasuryWarning) {
        notify.warn(
          "تنبيه: عجز الخزينة",
          res.treasuryBalanceAfter != null
            ? `عهدة الافتتاح فاقت رصيد الخزينة — الرصيد الآن ${fmt(Number(res.treasuryBalanceAfter))} د.ع. موّل الخزينة.`
            : "عهدة الافتتاح فاقت رصيد الخزينة (عجز). أبلغ المدير لتمويل الخزينة.",
        );
      }
      void printShiftOpen({
        shiftId: res.shiftId,
        openingBalance: Number(opening || 0),
        cashierName,
        branchName,
        openedAt: new Date(),
      }).catch(() => {}).finally(() => releaseReservedPrintWindow());
    },
    onError: (e) => {
      releaseReservedPrintWindow();
      notify.err(e);
    },
  });
  return {
    ...m,
    mutate: ((...args: Parameters<typeof m.mutate>) => {
      reservePrintWindow();
      return m.mutate(...args);
    }) as typeof m.mutate,
    mutateAsync: ((...args: Parameters<typeof m.mutateAsync>) => {
      reservePrintWindow();
      return m.mutateAsync(...args);
    }) as typeof m.mutateAsync,
  };
}
