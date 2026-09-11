import { Redirect } from "wouter";

/** رابط توافق يوجه مباشرة لبوابة المرتجعات المركزية لمبيعات العملاء */
export default function SalesReturnNew() {
  return <Redirect to="/returns?tab=sales" />;
}

