import {
  AlertTriangle,
  CalendarClock,
  CircleDollarSign,
  Target,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatIqd } from "@/lib/money";
import type { DashboardData } from "./types";

export function PipelineSummary({ data }: { data: DashboardData }) {
  const openLeads =
    data.leadCounts.NEW + data.leadCounts.CONTACTED + data.leadCounts.QUALIFIED;
  const openOpportunities =
    data.opportunityCounts.DISCOVERY +
    data.opportunityCounts.PROPOSAL +
    data.opportunityCounts.NEGOTIATION;
  const cards = [
    {
      label: "عملاء محتملون نشطون",
      value: openLeads.toLocaleString("ar-IQ-u-nu-latn"),
      Icon: Target,
    },
    {
      label: "فرص مفتوحة",
      value: openOpportunities.toLocaleString("ar-IQ-u-nu-latn"),
      Icon: CircleDollarSign,
    },
    {
      label: "التوقع المرجّح",
      value: formatIqd(data.forecast.weightedForecast),
      Icon: CalendarClock,
    },
    {
      label: "متابعات متأخرة",
      value: (
        data.overdueLeads.length + data.overdueOpportunities.length
      ).toLocaleString("ar-IQ-u-nu-latn"),
      Icon: AlertTriangle,
    },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map(({ label, value, Icon }) => (
        <Card key={label} className="rounded-md shadow-none">
          <CardContent className="flex items-center justify-between gap-3 p-4">
            <div>
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="mt-1 text-xl font-bold tabular-nums">{value}</p>
            </div>
            <div className="grid size-9 place-items-center rounded-md bg-muted text-muted-foreground">
              <Icon aria-hidden className="size-4" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
