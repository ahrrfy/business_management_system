import { D, round2 } from "@/lib/money";
import { effectivePrice, type CartLine } from "./cartMath";
import { composeCustomizationText } from "@/components/CustomizationDialog";

export interface DraftPayloadContext {
  customer: { customerId?: number | null; name?: string | null; phone?: string | null };
  effectiveTier: "RETAIL" | "WHOLESALE" | "GOVERNMENT" | null;
  channel: "OTHER" | "WALK_IN" | "WHATSAPP" | "INSTAGRAM" | "TIKTOK" | "PHONE" | null;
  channelHandle: string;
  linkedConversationId: number | null;
  cart: CartLine[];
  customerIdOverride?: number | null;
}

export function buildDraftPayload(ctx: DraftPayloadContext) {
  const {
    customer,
    effectiveTier,
    channel,
    channelHandle,
    linkedConversationId,
    cart,
    customerIdOverride,
  } = ctx;

  const effectiveCustomerId = customerIdOverride ?? customer.customerId ?? null;
  const header = {
    customerId: effectiveCustomerId,
    contactName: effectiveCustomerId == null ? (customer.name?.trim() || null) : null,
    contactPhone: effectiveCustomerId == null ? (customer.phone?.trim() || null) : null,
    priceTier: effectiveTier,
    channel,
    channelHandle: channelHandle.trim() || null,
    conversationId: linkedConversationId,
  };

  const lines = cart.map((c, i) => {
    const eff = round2(D(effectivePrice(c))).toFixed(2);
    if (c.custom) {
      return {
        lineKind: "CUSTOM" as const,
        sortOrder: i,
        variantId: c.manualService ? null : (c.row.variantId || null),
        productUnitId: c.manualService ? null : (c.row.productUnitId || null),
        quantity: String(c.qty),
        unitPrice: eff,
        title: c.custom.title.trim() || c.row.productName,
        customizationText: composeCustomizationText(c.custom) || null,
        designImages: c.custom.designImages.length
          ? JSON.stringify(c.custom.designImages.map((img, ix) => ({ url: img.dataUrl, caption: img.name ?? null, sortOrder: ix })))
          : null,
        printSpec: JSON.stringify({ ...c.custom, designImages: [], paymentReceiptImages: [] }),
        dueDate: c.custom.dueDate || null,
        assignedTo: c.custom.assignedTo ?? null,
      };
    }
    return {
      lineKind: c.row.isPrintService ? ("PRINT" as const) : ("GOODS" as const),
      sortOrder: i,
      variantId: c.row.variantId,
      productUnitId: c.row.productUnitId,
      quantity: String(c.qty),
      unitPrice: eff,
      title: `${c.row.productName} (${c.row.unitName})`,
    };
  });
  return { header, lines };
}

