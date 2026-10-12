import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { fmt } from "@/lib/money";
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
  return trpc.shifts.open.useMutation({
    onSuccess: async (res) => {
      await onOpened();
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
      });
    },
    onError: (e) => notify.err(e),
  });
}
