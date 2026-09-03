import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { missedDailyCountExceptionStatusLabel } from "@shared/missedDailyCountException";

const component = readFileSync(
  new URL("./MissedDailyCountExceptionPanel.tsx", import.meta.url),
  "utf8",
);
const service = readFileSync(
  new URL(
    "../../../../server/services/cash/missedDailyCountException.ts",
    import.meta.url,
  ),
  "utf8",
);
const readiness = readFileSync(
  new URL(
    "../../../../server/services/reports/monthCloseReadiness.ts",
    import.meta.url,
  ),
  "utf8",
);
const certificate = readFileSync(
  new URL(
    "../../../../server/services/reports/monthCloseCertificate.ts",
    import.meta.url,
  ),
  "utf8",
);

describe("MissedDailyCountExceptionPanel governance UX", () => {
  it("uses the context/request/decision API and invalidates month readiness", () => {
    for (const endpoint of ["context", "request", "decide"]) {
      expect(component).toContain(`missedDailyCount.${endpoint}`);
    }
    expect(component).toContain("monthCloseReadiness.invalidate()");
  });

  it("explains zero financial effect and exposes maker/checker decisions", () => {
    expect(component).toContain("لا يصنع جرداً بأثر رجعي ولا يعدّل رصيداً");
    expect(component).toContain("اعتماد الاستثناء");
    expect(component).toContain("رفض الاستثناء");
    expect(component).toContain("مراجعاً مختلفاً عن الطالب");
    expect(component).toContain("بلا استثناء للدور");
    expect(component).toContain("لا يرفع حاجز إقفال الشهر");
  });

  it("keeps Arabic statuses centralized", () => {
    expect(missedDailyCountExceptionStatusLabel).toEqual({
      PENDING: "بانتظار المراجعة",
      APPROVED: "معتمد",
      REJECTED: "مرفوض",
    });
    expect(component).toContain(
      "missedDailyCountExceptionStatusLabel[active.status]",
    );
  });

  it("locks approval to current immutable evidence and a different reviewer", () => {
    expect(service).toContain(
      "currentEvidence.evidenceHash !== row.missingDayEvidenceHash",
    );
    expect(service).toContain("currentCarry.version");
    expect(service).toContain(
      "currentCarry.evidenceHash !== row.carryForwardEvidenceHash",
    );
    expect(service).toContain(
      "lt(cashDailyReconciliations.businessDate, todayUtcDate())",
    );
    expect(service).toContain("Number(row.requestedByUserId) === actor.userId");
    expect(service).toContain("zeroFinancialEffect: true");
  });

  it("exempts only an approved exception with an unchanged closed carry and seals its details", () => {
    expect(readiness).toContain(
      "missed.missedDailyCountExceptionStatus = 'APPROVED'",
    );
    expect(readiness).toContain(
      "carry.cashDailyReconciliationStatus = 'CLOSED'",
    );
    expect(readiness).toContain("carry.version = missed.carryForwardVersion");
    expect(readiness).toContain(
      "carry.evidenceHash = missed.carryForwardEvidenceHash",
    );
    expect(certificate).toContain('"MISSED_DAILY_COUNT_EXCEPTIONS"');
    for (const field of [
      "missingDayEvidenceHash",
      "carryForwardEvidenceHash",
      "immutableEvidenceHash",
      "decisionHash",
      "evidenceReference",
    ]) {
      expect(certificate).toContain(field);
    }
  });
});
