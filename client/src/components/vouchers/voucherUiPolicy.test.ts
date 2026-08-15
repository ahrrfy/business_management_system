import { describe, expect, it } from "vitest";
import {
  canPrintOfficialVoucher,
  canShowVoucherApprovalAction,
  canShowVoucherRejectAction,
  expectedVoucherSourceLabel,
  voucherApprovalLabel,
  voucherCashUiPolicy,
  voucherCreateActionLabel,
  voucherCreateSuccessMessage,
} from "./voucherUiPolicy";

describe("voucher owner-disbursement UI policy", () => {
  it("uses the final OUT lifecycle labels without changing immediate IN labels", () => {
    expect(
      voucherApprovalLabel({
        direction: "OUT",
        approvalStatus: "PENDING_APPROVAL",
      }),
    ).toBe("بانتظار الاعتماد والصرف");
    expect(
      voucherApprovalLabel({ direction: "OUT", approvalStatus: "APPROVED" }),
    ).toBe("معتمد ومصروف");
    expect(
      voucherApprovalLabel({ direction: "IN", approvalStatus: "APPROVED" }),
    ).toBe("مُعتمَد");
  });

  it("shows OUT approval only to owner accounts while preserving legacy IN management", () => {
    const pendingOut = { direction: "OUT", approvalStatus: "PENDING_APPROVAL" };
    expect(
      canShowVoucherApprovalAction({
        ...pendingOut,
        isOwner: true,
        canManageLegacyReceipt: false,
      }),
    ).toBe(true);
    expect(
      canShowVoucherRejectAction({
        ...pendingOut,
        isOwner: true,
        canManageLegacyReceipt: false,
      }),
    ).toBe(true);
    expect(
      canShowVoucherRejectAction({
        ...pendingOut,
        isOwner: false,
        canManageLegacyReceipt: true,
      }),
    ).toBe(false);
    expect(
      canShowVoucherApprovalAction({
        ...pendingOut,
        isOwner: false,
        canManageLegacyReceipt: true,
      }),
    ).toBe(false);
    expect(
      canShowVoucherApprovalAction({
        direction: "IN",
        approvalStatus: "PENDING_APPROVAL",
        isOwner: false,
        canManageLegacyReceipt: true,
      }),
    ).toBe(true);
  });

  it("blocks official printing until approval", () => {
    expect(
      canPrintOfficialVoucher({ approvalStatus: "PENDING_APPROVAL" }),
    ).toBe(false);
    expect(canPrintOfficialVoucher({ approvalStatus: "REJECTED" })).toBe(false);
    expect(canPrintOfficialVoucher({ approvalStatus: "APPROVED" })).toBe(true);
  });

  it("never requires the OUT maker's drawer and keeps the IN shift rule", () => {
    expect(voucherCashUiPolicy({
      direction: "OUT",
      paymentMethod: "CASH",
      hasOpenShift: false,
      shiftLoading: false,
      isElevated: false,
    })).toEqual({ hardBlock: false, treasuryNotice: true });
    expect(voucherCashUiPolicy({
      direction: "IN",
      paymentMethod: "CASH",
      hasOpenShift: false,
      shiftLoading: false,
      isElevated: false,
    })).toEqual({ hardBlock: true, treasuryNotice: false });
  });

  it("presents OUT creation as a request and keeps IN creation immediate", () => {
    expect(voucherCreateActionLabel("OUT", false)).toBe("إرسال طلب صرف");
    expect(voucherCreateActionLabel("IN", false)).toBe("حفظ سند القبض");
    expect(
      voucherCreateSuccessMessage({
        direction: "OUT",
        voucherNumber: "PV-12",
        approvalStatus: "PENDING_APPROVAL",
      }),
    ).toContain("بانتظار اعتماد وصرف المالك");
    expect(
      voucherCreateSuccessMessage({
        direction: "IN",
        voucherNumber: "RV-12",
        approvalStatus: "APPROVED",
      }),
    ).toBe("تَمّ إنشاء سند القبض RV-12");
    expect(
      voucherCreateSuccessMessage({
        direction: "IN",
        voucherNumber: "RV-13",
        approvalStatus: "PENDING_APPROVAL",
      }),
    ).toContain("بانتظار اعتماد مدير ثانٍ");
  });

  it("describes the expected source without inventing an unavailable balance", () => {
    expect(
      expectedVoucherSourceLabel({
        paymentMethod: "CASH",
        cashBucket: "TREASURY",
      }),
    ).toBe("الخزينة الإدارية");
    expect(expectedVoucherSourceLabel({ paymentMethod: "CASH" })).toBe(
      "الخزينة الإدارية",
    );
    expect(expectedVoucherSourceLabel({ paymentMethod: "TRANSFER" })).toBe(
      "تحويل مصرفي",
    );
  });
});
