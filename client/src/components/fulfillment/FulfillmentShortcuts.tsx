import React from "react";
import { Link } from "wouter";
import { Truck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { operationDecision } from "@shared/operationPermissions";

export function FulfillmentShortcuts({ branchId, offline = false }: { branchId?: number | null; offline?: boolean }) {
  const me = trpc.auth.me.useQuery();
  if (!["delivery.workflow.preview", "delivery.fulfillment.aftercare.list", "delivery.fulfillment.requests.list"].some(path => operationDecision(me.data, path).allowed)) return null;
  const params = new URLSearchParams({ section: "dispatch" });
  const selectedBranch = branchId ?? me.data?.branchId;
  if (selectedBranch) params.set("branchId", String(selectedBranch));
  return <Button type="button" variant="outline" size="sm" disabled={offline} asChild={!offline} className="gap-1.5" title={offline ? "تحتاج محطات التوصيل اتصالاً بالخادم" : "محطات الإسناد والتحصيل والنقص"}>{offline ? <span className="inline-flex items-center gap-1.5"><Truck className="size-3.5" aria-hidden />التوصيل</span> : <Link href={`/reception/workflow?${params}`}><Truck className="size-3.5" aria-hidden />التوصيل</Link>}</Button>;
}
