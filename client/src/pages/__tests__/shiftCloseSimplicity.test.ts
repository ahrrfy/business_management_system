import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("إغلاق الوردية المبسّط", () => {
  it("لا يطلب مستلم عهدة في أي شاشة ويب", () => {
    for (const page of ["../POS.tsx", "../PrintPOS.tsx", "../Reception.tsx", "../Shifts.tsx"]) {
      const source = read(page);
      expect(source).not.toContain("ShiftHandoverSection");
      expect(source).not.toContain("handoverToUserId");
      expect(source).not.toContain("اختر مستلم عهدة الإغلاق");
    }
  });

  it("يغلق الخادم مباشرة إلى الخزينة بلا عقد مستلم أو نقد في الطريق", () => {
    const router = read("../../../../server/routers/shiftRouter.ts");
    const shiftService = read("../../../../server/services/shiftService.ts");
    const handoverService = read("../../../../server/services/cashHandoverService.ts");
    const directCloseService = handoverService.slice(
      handoverService.indexOf("export async function settleShiftReturnTx"),
      handoverService.indexOf("export async function settlePendingShiftCloseHandovers"),
    );

    expect(router).not.toContain("handoverToUserId");
    expect(router).not.toContain("allowLegacySelfCustody");
    expect(shiftService).not.toContain("handoverToUserId");
    expect(shiftService).not.toContain("allowLegacySelfCustody");
    expect(directCloseService).toContain('entryType: "CASH_HANDOVER"');
    expect(directCloseService).toContain('cashBucket: "TREASURY"');
    expect(directCloseService).toContain('status: "COMPLETED"');
    expect(directCloseService).not.toContain("CASH_IN_TRANSIT");
    expect(directCloseService).not.toContain('status: "PENDING"');
  });

  it("يحذف اختيار المستلم من أندرويد أيضاً ويبقي السحب النقدي المنفصل محكوماً", () => {
    const repository = read(
      "../../../../android-native/app/src/main/java/online/alarabiya/superapp/data/ShiftRepository.kt",
    );
    const screen = read(
      "../../../../android-native/app/src/main/java/online/alarabiya/superapp/feature/shifts/ShiftScreen.kt",
    );
    const cashDrop = read("../../components/pos/CashDropDialog.tsx");

    expect(repository).not.toContain("handoverToUserId");
    expect(screen).not.toContain("مستلم عهدة النقد");
    expect(cashDrop).toContain("dropTo");
    expect(cashDrop).toContain("المستلِم");
  });
});
