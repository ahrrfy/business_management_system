import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { operationDecision } from "@shared/operationPermissions";

export function FulfillmentSourceActions({ invoiceId, workOrderId, branchId, prepare = true, aftercare = true }: {
  invoiceId?: number; workOrderId?: number; branchId?: number | null; prepare?: boolean; aftercare?: boolean;
}) {
  const me = trpc.auth.me.useQuery();
  if (!me.data || (!invoiceId && !workOrderId)) return null;
  const source = new URLSearchParams(invoiceId ? { invoiceId: String(invoiceId) } : { workOrderId: String(workOrderId) });
  if (branchId) source.set("branchId", String(branchId));
  return <>
    {prepare && operationDecision(me.data, "delivery.fulfillment.requests.create").allowed && <Button asChild variant="outline" size="sm"><Link href={`/delivery?tab=fulfillment&kind=requests&${source}`}>ضم إلى طلب توصيل</Link></Button>}
    {aftercare && operationDecision(me.data, "delivery.fulfillment.aftercare.create").allowed && <Button asChild variant="outline" size="sm"><Link href={`/delivery?tab=fulfillment&kind=aftercare&${source}`}>معالجة نقص أو تعويض</Link></Button>}
  </>;
}
