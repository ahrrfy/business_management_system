import { describe, expect, it } from "vitest";
import { deliveryConsignments } from "../drizzle/schema";
import {
  DELIVERY_CONSIGNMENT_STATUSES,
  DELIVERY_MONEY_STATUSES,
  DELIVERY_PARCEL_STATUSES,
} from "./deliveryStatuses";

describe("deliveryStatuses — القواميس مرآةُ تعدادات المخطّط حرفياً", () => {
  it("parcelStatus", () => {
    expect([...DELIVERY_PARCEL_STATUSES]).toEqual([...deliveryConsignments.parcelStatus.enumValues]);
  });
  it("moneyStatus", () => {
    expect([...DELIVERY_MONEY_STATUSES]).toEqual([...deliveryConsignments.moneyStatus.enumValues]);
  });
  it("consignmentStatus", () => {
    expect([...DELIVERY_CONSIGNMENT_STATUSES]).toEqual([...deliveryConsignments.status.enumValues]);
  });
});
