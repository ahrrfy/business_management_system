import { Truck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { operationDecision } from "@shared/operationPermissions";

const destinations = [
  {
    kind: "requests",
    path: "delivery.fulfillment.requests.list",
    label: "طلبات توصيل مجمعة",
  },
  {
    kind: "charges",
    path: "delivery.fulfillment.charges.list",
    label: "الأجور الإضافية",
  },
  {
    kind: "aftercare",
    path: "delivery.fulfillment.aftercare.list",
    label: "نقص أو تعويض",
  },
] as const;

export function FulfillmentShortcuts({
  branchId,
  offline = false,
}: {
  branchId?: number | null;
  offline?: boolean;
}) {
  const me = trpc.auth.me.useQuery();
  const allowed = destinations.filter(
    (item) => operationDecision(me.data, item.path).allowed,
  );
  if (!allowed.length) return null;
  const selectedBranch = branchId ?? me.data?.branchId;
  return (
    <DropdownMenu dir="rtl">
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={offline}
          title={
            offline
              ? "تحتاج إجراءات التوصيل والأجور اتصالاً بالخادم"
              : "يفتح في تبويب مستقل مع حفظ شاشة الكاشير الحالية"
          }
          className="gap-1.5"
        >
          <Truck aria-hidden className="size-3.5" />
          التوصيل والأجور
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {allowed.map((item) => (
          <DropdownMenuItem key={item.kind} asChild>
            <a
              href={`/delivery?tab=fulfillment&kind=${item.kind}${selectedBranch ? `&branchId=${selectedBranch}` : ""}`}
              target="_blank"
              rel="noreferrer"
            >
              {item.label}
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
