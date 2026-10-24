import { useCatalogPeopleOperationAccess } from "@/lib/catalogPeopleOperationAccess";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useEmployeeStatement } from "./statement/useEmployeeStatement";
import { AttendanceStatementHeader } from "./statement/AttendanceStatementHeader";
import { AttendanceStatementSummary } from "./statement/AttendanceStatementSummary";
import { AttendanceStatementTable } from "./statement/AttendanceStatementTable";
import { AttendanceCorrectionDialog } from "./statement/AttendanceCorrectionDialog";
type Props = { employeeId: number; phone?: string | null };
export function EmployeeStatementCard(props: Props) {
  const { can } = useCatalogPeopleOperationAccess();
  if (!can("attendance.employeeStatement")) return null;
  return <EmployeeStatementSession key={props.employeeId} {...props} />;
}
function EmployeeStatementSession(props: Props) {
  const model = useEmployeeStatement(props);
  if (model.q.isLoading)
    return (
      <Card>
        <CardContent className="p-6 text-center text-muted-foreground">
          جارٍ تحميل الكشف…
        </CardContent>
      </Card>
    );
  if (model.q.isError)
    return (
      <Card>
        <CardContent role="alert" className="p-4 space-y-2">
          <p>تعذّر تحميل كشف الحضور والدوام.</p>
          <Button variant="outline" onClick={() => void model.q.refetch()}>
            إعادة المحاولة
          </Button>
        </CardContent>
      </Card>
    );
  if (!model.d) return null;
  return (
    <Card>
      <AttendanceStatementHeader model={model} />
      <CardContent className="space-y-3">
        <AttendanceStatementSummary model={model} />
        <AttendanceStatementTable model={model} />
      </CardContent>
      <AttendanceCorrectionDialog model={model} />
    </Card>
  );
}
