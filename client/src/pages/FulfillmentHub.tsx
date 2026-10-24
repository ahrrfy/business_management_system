import React, { useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { legacyFulfillmentWorkflowHref } from "@/components/delivery/workflow/navigation";

/** Preserve old document links while daily operations stay in the barcode stations. */
export default function FulfillmentHub() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const href = legacyFulfillmentWorkflowHref(search);
  useEffect(() => { navigate(href, { replace: true }); }, [href, navigate]);
  return <p className="p-3 text-sm text-muted-foreground" role="status">انتقال إلى محطة سير العمل المرتبطة بالمستند…</p>;
}
