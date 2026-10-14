import { trpc } from "@/lib/trpc";
import {
  operationDecision,
  type OperationUser,
} from "@shared/operationPermissions";

/** Display the same exact operation decision as the API; financial/document rules remain server checked. */
export function useOperationPermission(path: string) {
  const me = trpc.auth.me.useQuery();
  return me.data
    ? operationDecision(me.data as OperationUser, path)
    : {
        allowed: false,
        key: `operation.${path}`,
        source: "unknown" as const,
        reason: "لم تُحمّل تفويضات الحساب بعد",
      };
}
