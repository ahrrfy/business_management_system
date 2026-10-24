import React from "react";
import {
  deliverySourceView,
  type DeliverySourceReference,
} from "@shared/deliverySource";

export function DeliverySourceLink({
  source,
}: {
  source: DeliverySourceReference;
}) {
  const view = deliverySourceView(source);
  return (
    <span className="inline-flex flex-col gap-0.5 text-xs">
      {view.href ? (
        <a href={view.href} className="text-primary hover:underline">
          {view.reference}
        </a>
      ) : (
        <span>{view.reference}</span>
      )}
      {view.customerCollectionForbidden && (
        <span className="text-muted-foreground">
          لا يُطلب مبلغ من العميل · الأجرة على المكتبة
        </span>
      )}
    </span>
  );
}
