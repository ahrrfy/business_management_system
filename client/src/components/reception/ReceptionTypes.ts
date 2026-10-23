export type OrderDeliveryValue = {
  partyId: number;
  partyName: string | null;
  fee: string;
  feeCollection: "COUNTER" | "COURIER" | "SHOP";
  recipientPhone: string | null;
  recipientName: string | null;
  address: string | null;
  externalTrackingRef: string | null;
};
