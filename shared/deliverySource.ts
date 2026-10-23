/** Current delivery source only; an original sale reference never becomes a claim. */
export interface DeliverySourceReference {
  sourceType?: string | null;
  sourceId?: number | string | null;
  fulfillmentRequestId?: number | null;
  aftercareExecutionId?: number | null;
  invoiceId?: number | null;
  invoiceNumber?: string | null;
  workOrderId?: number | null;
  orderNumber?: string | null;
}

export function deliverySourceView(source: DeliverySourceReference) {
  if (source.sourceType === "AFTERCARE_EXECUTION") {
    const id = source.aftercareExecutionId ?? source.sourceId;
    return {
      label: "استكمال نقص / معالجة",
      reference: id == null ? "دفعة معالجة" : `دفعة معالجة #${id}`,
      href:
        id == null
          ? null
          : `/delivery?tab=fulfillment&kind=aftercare&executionId=${encodeURIComponent(String(id))}`,
      customerCollectionForbidden: true,
    };
  }
  const requestId =
    source.fulfillmentRequestId ??
    (source.sourceType === "FULFILLMENT_REQUEST" ? source.sourceId : null);
  if (requestId != null) {
    return {
      label: "طلب توصيل موحد",
      reference: `طلب توصيل #${requestId}${source.invoiceNumber ? ` · ${source.invoiceNumber}` : ""}`,
      href: `/delivery?tab=fulfillment&kind=requests&requestId=${encodeURIComponent(String(requestId))}`,
      customerCollectionForbidden: false,
    };
  }
  if (source.sourceType === "WORK_ORDER" || source.workOrderId != null) {
    const id = source.workOrderId ?? source.sourceId;
    return {
      label: "أمر شغل",
      reference:
        source.orderNumber ?? (id == null ? "أمر شغل" : `أمر شغل #${id}`),
      href: id == null ? null : `/work-orders/${id}`,
      customerCollectionForbidden: false,
    };
  }
  if (source.sourceType === "ONLINE_ORDER") {
    return {
      label: "طلب متجر",
      reference: source.orderNumber ?? `طلب متجر #${source.sourceId ?? "—"}`,
      href: source.invoiceId == null ? null : `/invoices/${source.invoiceId}`,
      customerCollectionForbidden: false,
    };
  }
  return {
    label: source.invoiceId == null ? "إرسالية" : "فاتورة",
    reference:
      source.invoiceNumber ??
      (source.invoiceId == null ? "إرسالية" : `فاتورة #${source.invoiceId}`),
    href: source.invoiceId == null ? null : `/invoices/${source.invoiceId}`,
    customerCollectionForbidden: false,
  };
}
