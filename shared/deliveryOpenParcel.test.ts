import { describe, it, expect } from "vitest";
import {
  OPEN_CONSIGNMENT_STATUSES,
  CLOSED_CONSIGNMENT_STATUSES,
  OPEN_PARCEL_SQL_FILTER,
  isOpenConsignmentStatus,
  isDeliveredAwaitingRemittance,
} from "./deliveryOpenParcel";

describe("deliveryOpenParcel — التعريف الموحَّد لـ«الطرد المفتوح»", () => {
  it("قيم DISPATCHED و PARTIAL هي المفتوحة", () => {
    expect(OPEN_CONSIGNMENT_STATUSES).toEqual(["DISPATCHED", "PARTIAL"]);
  });

  it("قيم DELIVERED, CANCELLED, RETURNED هي المغلقة", () => {
    expect(CLOSED_CONSIGNMENT_STATUSES).toEqual(["DELIVERED", "CANCELLED", "RETURNED"]);
  });

  it("لا تداخل بين المفتوحة والمغلقة", () => {
    const openSet = new Set(OPEN_CONSIGNMENT_STATUSES);
    for (const closed of CLOSED_CONSIGNMENT_STATUSES) {
      expect(openSet.has(closed), `overlap: ${closed}`).toBe(false);
    }
  });

  it("isOpenConsignmentStatus() يُميّز صحيحاً", () => {
    expect(isOpenConsignmentStatus("DISPATCHED")).toBe(true);
    expect(isOpenConsignmentStatus("PARTIAL")).toBe(true);
    expect(isOpenConsignmentStatus("DELIVERED")).toBe(false);
    expect(isOpenConsignmentStatus("CANCELLED")).toBe(false);
    expect(isOpenConsignmentStatus("RETURNED")).toBe(false);
    expect(isOpenConsignmentStatus(null)).toBe(false);
    expect(isOpenConsignmentStatus(undefined)).toBe(false);
    expect(isOpenConsignmentStatus("")).toBe(false);
    expect(isOpenConsignmentStatus("UNKNOWN")).toBe(false);
  });

  it("OPEN_PARCEL_SQL_FILTER() يُنتج تصفيةَ SQL صالحة", () => {
    const sql = OPEN_PARCEL_SQL_FILTER("dc.consignmentStatus");
    expect(sql).toBe("dc.consignmentStatus IN ('DISPATCHED', 'PARTIAL')");
  });

  it("OPEN_PARCEL_SQL_FILTER() يقبل أعمدةً بأسماء مختلفة", () => {
    expect(OPEN_PARCEL_SQL_FILTER("status")).toBe("status IN ('DISPATCHED', 'PARTIAL')");
    expect(OPEN_PARCEL_SQL_FILTER("`t1`.`consignmentStatus`")).toBe(
      "`t1`.`consignmentStatus` IN ('DISPATCHED', 'PARTIAL')",
    );
  });
});

describe("isDeliveredAwaitingRemittance() — الطرد المُسلَّم بلا توريد", () => {
  it("سُلِّم للزبون + consignmentStatus مفتوح = ينتظر التوريد", () => {
    expect(isDeliveredAwaitingRemittance("DISPATCHED", "DELIVERED")).toBe(true);
    expect(isDeliveredAwaitingRemittance("PARTIAL", "DELIVERED")).toBe(true);
  });

  it("سُلِّم للزبون لكنّ consignmentStatus مغلق (مثلاً DELIVERED مالياً) ⇒ لا", () => {
    expect(isDeliveredAwaitingRemittance("DELIVERED", "DELIVERED")).toBe(false);
    expect(isDeliveredAwaitingRemittance("CANCELLED", "DELIVERED")).toBe(false);
  });

  it("مفتوحٌ ماليّاً لكن parcelStatus ≠ DELIVERED (مثلاً ASSIGNED/OUT_FOR_DELIVERY) ⇒ لا", () => {
    expect(isDeliveredAwaitingRemittance("DISPATCHED", "ASSIGNED")).toBe(false);
    expect(isDeliveredAwaitingRemittance("DISPATCHED", "OUT_FOR_DELIVERY")).toBe(false);
    expect(isDeliveredAwaitingRemittance("DISPATCHED", "FAILED")).toBe(false);
  });

  it("قيم فارغة أو غير معرَّفة تُرجع false بأمان", () => {
    expect(isDeliveredAwaitingRemittance(null, "DELIVERED")).toBe(false);
    expect(isDeliveredAwaitingRemittance("DISPATCHED", null)).toBe(false);
    expect(isDeliveredAwaitingRemittance(undefined, undefined)).toBe(false);
  });
});
