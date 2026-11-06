import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "../../../shared/errors";
import { money, roundCashIQD, sumMoney, toDbMoney } from "../money";

export function digitalSettlementAmounts(input: {
  captured: string; issuedPrices: readonly string[]; regularSubtotal: string;
  regularDisposition: "SELL" | "RELEASE"; unknownCount: number; cashRound: boolean;
}) {
  const captured = money(input.captured);
  const rawSale = sumMoney(Array.from(input.issuedPrices)).plus(input.regularDisposition === "SELL" ? money(input.regularSubtotal) : money(0));
  const sale = input.cashRound ? roundCashIQD(rawSale) : rawSale;
  if (input.unknownCount !== 0 || captured.lt(0) || sale.lt(0) || sale.gt(captured)) {
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
      what: "تعذّر حسم تسوية الكروت",
      why: "نتيجة إصدار غير محسومة أو مبالغ لا تطابق القبض الأصلي",
      doThis: "طابق كل كرت ومبلغ القبض الأصلي قبل اعتماد الفاتورة والرد؛ لا تكرر الإصدار أو القبض",
    }) });
  }
  return { capturedAmount: toDbMoney(captured), saleAmount: toDbMoney(sale), refundAmount: toDbMoney(captured.minus(sale)) };
}
