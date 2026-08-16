import { describe, expect, it } from "vitest";
import {
  createPostingIntent,
  signedPostingLines,
  validatePostingIntentAgainstSource,
  type JournalLine,
} from "../accounting/postingEngine";
import {
  disposalAdjustmentLines,
  disposalAdjustmentSourceComponents,
  fullDisposalLines,
  fullDisposalSourceComponents,
} from "../assets/dispose";
import { cashExpensePostingIntent, expenseRole } from "../expenseService";
import { bouncedCheckPosting } from "../installment/bounce";
import { money } from "../money";
import { voucherPostingIntent } from "../voucher/posting";
import {
  expenseAccrualRecognition,
  expenseAccrualReversal,
  expenseAccrualSettlement,
  fixedAssetAccrualRecognition,
  fixedAssetAccrualReversal,
  fixedAssetAccrualSettlement,
} from "../accounting/accrualPosting";

function totals(lines: JournalLine[]) {
  return lines.reduce(
    (sum, line) => ({
      debit: sum.debit.plus(money(line.debit)),
      credit: sum.credit.plus(money(line.credit)),
    }),
    { debit: money(0), credit: money(0) },
  );
}

function net(lines: JournalLine[], role: JournalLine["role"]) {
  return lines
    .filter((line) => line.role === role)
    .reduce(
      (sum, line) => sum.plus(money(line.debit)).minus(money(line.credit)),
      money(0),
    )
    .toFixed(2);
}

describe("posting intents — الأصول والمصروفات والرواتب", () => {
  it("يفصل الاعتراف بالمصروف عن تسوية النقد ويعكس كل مرحلة بمكونات دقيقة", () => {
    const recognition = expenseAccrualRecognition(
      "OPERATING_EXPENSE",
      money("125000"),
    );
    expect(recognition.intent.profile).toBe("ADJUST_EXPENSE_ACCRUAL");
    expect(net(recognition.intent.lines, "OPERATING_EXPENSE")).toBe("125000.00");
    expect(net(recognition.intent.lines, "ACCRUED_EXPENSES")).toBe("-125000.00");
    expect(() =>
      validatePostingIntentAgainstSource(recognition.intent, {
        amount: money("125000"),
        ...recognition.sourceComponents,
      }),
    ).not.toThrow();

    const recognitionReversal = expenseAccrualReversal(
      "OPERATING_EXPENSE",
      money("125000"),
    );
    expect(recognitionReversal.intent.profile).toBe(
      "ADJUST_EXPENSE_ACCRUAL_REVERSAL",
    );
    expect(net(recognitionReversal.intent.lines, "OPERATING_EXPENSE")).toBe(
      "-125000.00",
    );
    expect(net(recognitionReversal.intent.lines, "ACCRUED_EXPENSES")).toBe(
      "125000.00",
    );

    const settlement = expenseAccrualSettlement(
      "TREASURY_CASH",
      money("125000"),
    );
    expect(settlement.intent.profile).toBe(
      "PAYMENT_OUT_ACCRUED_EXPENSE_SETTLEMENT",
    );
    expect(net(settlement.intent.lines, "ACCRUED_EXPENSES")).toBe("125000.00");
    expect(net(settlement.intent.lines, "TREASURY_CASH")).toBe("-125000.00");

    const cashReturn = expenseAccrualSettlement(
      "TREASURY_CASH",
      money("-125000"),
    );
    expect(net(cashReturn.intent.lines, "ACCRUED_EXPENSES")).toBe("-125000.00");
    expect(net(cashReturn.intent.lines, "TREASURY_CASH")).toBe("125000.00");
    expect(() =>
      validatePostingIntentAgainstSource(cashReturn.intent, {
        amount: money("-125000"),
        ...cashReturn.sourceComponents,
      }),
    ).not.toThrow();
  });

  it("يفصل إثبات الأصل عن تسوية التزام اقتنائه بلا إعادة رسملة عند الدفع", () => {
    const recognition = fixedAssetAccrualRecognition(money("2400000"));
    const reversal = fixedAssetAccrualReversal(money("2400000"));
    const settlement = fixedAssetAccrualSettlement(
      "CARD_BANK",
      money("2400000"),
    );

    expect(recognition.intent.profile).toBe("ADJUST_FIXED_ASSET_ACCRUAL");
    expect(net(recognition.intent.lines, "FIXED_ASSETS")).toBe("2400000.00");
    expect(net(recognition.intent.lines, "ACCRUED_EXPENSES")).toBe("-2400000.00");
    expect(reversal.intent.profile).toBe(
      "ADJUST_FIXED_ASSET_ACCRUAL_REVERSAL",
    );
    expect(net(reversal.intent.lines, "FIXED_ASSETS")).toBe("-2400000.00");
    expect(settlement.intent.profile).toBe(
      "PAYMENT_OUT_FIXED_ASSET_ACCRUAL_SETTLEMENT",
    );
    expect(net(settlement.intent.lines, "FIXED_ASSETS")).toBe("0.00");
    expect(net(settlement.intent.lines, "ACCRUED_EXPENSES")).toBe("2400000.00");
    expect(net(settlement.intent.lines, "CARD_BANK")).toBe("-2400000.00");
  });

  it("اقتناء أصل آجل وعكسه يبدّلان الطرفين بلا أسطر سالبة", () => {
    const acquisition = createPostingIntent(
      "PURCHASE_FIXED_ASSET",
      "PURCHASE",
      signedPostingLines("FIXED_ASSETS", "AP", money("1250000")),
    );
    const reversal = createPostingIntent(
      "PURCHASE_FIXED_ASSET",
      "PURCHASE",
      signedPostingLines("FIXED_ASSETS", "AP", money("-1250000")),
    );

    expect(net(acquisition.lines, "FIXED_ASSETS")).toBe("1250000.00");
    expect(net(acquisition.lines, "AP")).toBe("-1250000.00");
    expect(net(reversal.lines, "FIXED_ASSETS")).toBe("-1250000.00");
    expect(net(reversal.lines, "AP")).toBe("1250000.00");
    expect(
      reversal.lines.every(
        (line) => money(line.debit).gte(0) && money(line.credit).gte(0),
      ),
    ).toBe(true);
  });

  it("مصروفات النظام تختار الدور الصريح، والراتب النقدي Dr SALARIES / Cr CASH", () => {
    expect(expenseRole("RENT")).toBe("RENT");
    expect(expenseRole("UTILITIES")).toBe("UTILITIES");
    expect(expenseRole("MAINTENANCE")).toBe("OPERATING_EXPENSE");
    expect(expenseRole("OTHER")).toBe("OTHER_EXPENSE");

    const salary = cashExpensePostingIntent(
      "SALARY",
      "CASH",
      money("800000"),
      false,
      "DRAWER",
    );
    expect(salary?.profile).toBe("PAYMENT_OUT_SALARY");
    expect(net(salary!.lines, "SALARIES")).toBe("800000.00");
    expect(net(salary!.lines, "CASH")).toBe("-800000.00");

    const reversal = cashExpensePostingIntent(
      "SALARY",
      "CASH",
      money("800000"),
      true,
      "DRAWER",
    );
    expect(reversal?.profile).toBe("PAYMENT_IN_OTHER");
    expect(net(reversal!.lines, "SALARIES")).toBe("-800000.00");
    expect(net(reversal!.lines, "CASH")).toBe("800000.00");
  });

  it("يرحّل WALLET إلى أصل المحفظة المخصص ولا يخمّنه نقداً أو بنكاً", () => {
    const wallet = cashExpensePostingIntent(
      "OTHER",
      "WALLET",
      money("1000"),
    );
    expect(wallet.profile).toBe("PAYMENT_OUT_EXPENSE");
    expect(net(wallet.lines, "OTHER_EXPENSE")).toBe("1000.00");
    expect(net(wallet.lines, "PAYMENT_WALLET")).toBe("-1000.00");
    expect(net(wallet.lines, "CASH")).toBe("0.00");
    expect(net(wallet.lines, "CARD_BANK")).toBe("0.00");
    expect(
      money(
        wallet.sourceComponents?.roleCredits?.PAYMENT_WALLET ?? 0,
      ).toFixed(2),
    ).toBe("1000.00");
  });
});

describe("posting intents — السندات والسلف", () => {
  it("ارتداد الشيك يعيد AR ويعكس أصل البنك بمكونات مصدر مستقلة", () => {
    const amount = money("250000");
    const { postingIntent, postingSourceComponents } =
      bouncedCheckPosting(amount);
    expect(postingIntent.profile).toBe("PAYMENT_OUT_CUSTOMER_REFUND");
    expect(net(postingIntent.lines, "AR")).toBe("250000.00");
    expect(net(postingIntent.lines, "CHECKS_RECEIVABLE")).toBe("-250000.00");
    expect(() =>
      validatePostingIntentAgainstSource(postingIntent, {
        amount,
        ...postingSourceComponents,
      }),
    ).not.toThrow();
  });

  it("بادئة EMP-ADV لا تمنح صلاحية، والمسار الصريح يثبت أصل السلفة وعكسه", () => {
    const amount = money("300000");
    const spoofed = voucherPostingIntent({
      entryType: "PAYMENT_OUT",
      partyType: "OTHER",
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      amount,
      referenceNumber: "EMP-ADV-7-request",
    });
    expect(spoofed).toBeUndefined();

    const grantSource = {
      roleDebits: { EMPLOYEE_ADVANCES: amount },
      roleCredits: { CASH: amount },
    };
    const grant = createPostingIntent(
      "PAYMENT_OUT_EMPLOYEE_ADVANCE",
      "PAYMENT_OUT",
      signedPostingLines("EMPLOYEE_ADVANCES", "CASH", amount),
      grantSource,
    );
    expect(net(grant.lines, "EMPLOYEE_ADVANCES")).toBe("300000.00");
    expect(net(grant.lines, "CASH")).toBe("-300000.00");
    expect(() =>
      validatePostingIntentAgainstSource(grant, { amount, ...grantSource }),
    ).not.toThrow();

    const returnSource = {
      roleDebits: { CASH: amount },
      roleCredits: { EMPLOYEE_ADVANCES: amount },
    };
    const returned = createPostingIntent(
      "PAYMENT_IN_OTHER",
      "PAYMENT_IN",
      signedPostingLines("CASH", "EMPLOYEE_ADVANCES", amount),
      returnSource,
    );
    expect(net(returned.lines, "EMPLOYEE_ADVANCES")).toBe("-300000.00");
    expect(net(returned.lines, "CASH")).toBe("300000.00");
    expect(() =>
      validatePostingIntentAgainstSource(returned, { amount, ...returnSource }),
    ).not.toThrow();
  });

  it("اتجاهات العميل والمورّد الأربعة تستند إلى الطرف الفعلي، وOTHER العام يبقى فجوة", () => {
    const customerRefund = voucherPostingIntent({
      entryType: "PAYMENT_OUT",
      partyType: "CUSTOMER",
      paymentMethod: "CARD",
      amount: money("75"),
    });
    expect(customerRefund?.profile).toBe("PAYMENT_OUT_CUSTOMER_REFUND");
    expect(net(customerRefund!.lines, "AR")).toBe("75.00");
    expect(net(customerRefund!.lines, "CARD_BANK")).toBe("-75.00");

    const supplierRefund = voucherPostingIntent({
      entryType: "PAYMENT_IN",
      partyType: "SUPPLIER",
      paymentMethod: "TRANSFER",
      amount: money("90"),
    });
    expect(supplierRefund?.profile).toBe("PAYMENT_IN_SUPPLIER_REFUND");
    expect(net(supplierRefund!.lines, "CARD_BANK")).toBe("90.00");
    expect(net(supplierRefund!.lines, "AP")).toBe("-90.00");

    expect(
      voucherPostingIntent({
        entryType: "PAYMENT_OUT",
        partyType: "OTHER",
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        amount: money("10"),
      }),
    ).toBeUndefined();
  });
});

describe("posting intents — إلغاء الاعتراف بالأصل", () => {
  it("بيع أصل بربح يزيل gross/contra ويثبت النقد والربح بتوازن", () => {
    const lines = fullDisposalLines(
      money("100"),
      money("30"),
      money("90"),
      money("20"),
    );
    const sum = totals(lines);
    expect(sum.debit.eq(sum.credit)).toBe(true);
    expect(net(lines, "TREASURY_CASH")).toBe("90.00");
    expect(net(lines, "CASH")).toBe("0.00");
    expect(net(lines, "ACCUMULATED_DEPRECIATION")).toBe("30.00");
    expect(net(lines, "FIXED_ASSETS")).toBe("-100.00");
    expect(net(lines, "ASSET_DISPOSAL_GAIN")).toBe("-20.00");
  });

  it("بعد قيد المتحصّل المنفصل، intent التسوية يكمل الإلغاء بلا ازدواج نقد", () => {
    const lines = disposalAdjustmentLines(
      money("100"),
      money("30"),
      money("90"),
      money("20"),
    );
    const sum = totals(lines);
    expect(sum.debit.eq(sum.credit)).toBe(true);
    expect(lines.some((line) => line.role === "CASH")).toBe(false);
    expect(net(lines, "ACCUMULATED_DEPRECIATION")).toBe("30.00");
    expect(net(lines, "FIXED_ASSETS")).toBe("-10.00");
    expect(net(lines, "ASSET_DISPOSAL_GAIN")).toBe("-20.00");
    const sourceComponents = disposalAdjustmentSourceComponents(
      money("100"),
      money("30"),
      money("90"),
      money("20"),
    );
    const intent = createPostingIntent(
      "ADJUST_ASSET_DISPOSAL",
      "ADJUST",
      lines,
      sourceComponents,
    );
    expect(() =>
      validatePostingIntentAgainstSource(intent, {
        amount: money("20"),
        ...sourceComponents,
      }),
    ).not.toThrow();
  });

  it("خسارة بيع الأصل تظهر في دور الإفصاح المخصص وتبقى التسوية متوازنة", () => {
    const lines = disposalAdjustmentLines(
      money("100"),
      money("30"),
      money("50"),
      money("-20"),
    );
    const sum = totals(lines);
    expect(sum.debit.eq(sum.credit)).toBe(true);
    expect(net(lines, "ACCUMULATED_DEPRECIATION")).toBe("30.00");
    expect(net(lines, "ASSET_DISPOSAL_LOSS")).toBe("20.00");
    expect(net(lines, "FIXED_ASSETS")).toBe("-50.00");
  });

  it("شطب أصل مهلك بالكامل بلا متحصّل يصفّر gross/contra ولا يمس P&L أو النقد", () => {
    const lines = disposalAdjustmentLines(
      money("100"),
      money("100"),
      money(0),
      money(0),
    );
    const intent = createPostingIntent(
      "ADJUST_ASSET_DISPOSAL",
      "ADJUST",
      lines,
      disposalAdjustmentSourceComponents(
        money("100"),
        money("100"),
        money(0),
        money(0),
      ),
    );
    const sum = totals(intent.lines);
    expect(sum.debit.eq(sum.credit)).toBe(true);
    expect(net(lines, "ACCUMULATED_DEPRECIATION")).toBe("100.00");
    expect(net(lines, "FIXED_ASSETS")).toBe("-100.00");
    expect(
      lines.some((line) =>
        [
          "CASH",
          "TREASURY_CASH",
          "ASSET_DISPOSAL_GAIN",
          "ASSET_DISPOSAL_LOSS",
        ].includes(line.role),
      ),
    ).toBe(false);
    const sourceComponents = fullDisposalSourceComponents(
      money("100"),
      money("100"),
      money(0),
      money(0),
    );
    expect(sourceComponents.roleDebits?.ACCUMULATED_DEPRECIATION).toBeDefined();
    expect(sourceComponents.roleCredits?.FIXED_ASSETS).toBeDefined();
    expect(() =>
      validatePostingIntentAgainstSource(intent, {
        amount: money(0),
        ...sourceComponents,
      }),
    ).not.toThrow();
  });
});
