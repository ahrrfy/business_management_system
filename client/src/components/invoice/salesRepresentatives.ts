interface EmployeeSalesRepresentative {
  id: number;
  userId: number | null;
  fullName?: string | null;
  position?: string | null;
  branchName?: string | null;
}

/** Invoice attribution references user accounts, never employee record IDs. */
export function salesRepresentativeOptions(employees: readonly EmployeeSalesRepresentative[]) {
  return employees.flatMap((employee) => employee.userId == null ? [] : [{
    id: employee.userId,
    name: employee.fullName || `موظف #${employee.id}`,
    position: employee.position,
    branchName: employee.branchName,
  }]);
}
