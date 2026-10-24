import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
export function SectionCard({
  icon: Icon,
  title,
  action,
  children,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Icon aria-hidden className="size-4" /> {title}
          </CardTitle>
          {action}
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">{children}</CardContent>
    </Card>
  );
}
