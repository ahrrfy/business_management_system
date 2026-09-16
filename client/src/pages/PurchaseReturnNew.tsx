import { Redirect } from "wouter";

/** رابط توافق يوجه مباشرة لبوابة المرتجعات المركزية لمشتريات الموردين */
export default function PurchaseReturnNew() {
  return <Redirect to="/returns?tab=purchases" />;
}
