import { TRPCError } from "@trpc/server";
import type { Actor } from "./tx";

export type AdministeredUser = {
  id: number;
  role: string;
  isOwner: boolean | null;
};

export type PrivilegedDisableActor = {
  role?: string | null;
  isOwner?: boolean | null;
};

export type PrivilegedDisableTarget = {
  role?: string | null;
  isOwner?: boolean | null;
};

/** Shared hierarchy guard for workflows that disable a linked user as a side effect. */
export function assertCanDisablePrivilegedUser(
  actor: PrivilegedDisableActor,
  target: PrivilegedDisableTarget,
): void {
  if (target.isOwner === true && actor.isOwner !== true) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا يحق لغير المالك تعطيل حساب مالك النظام.",
    });
  }
  if (target.role === "admin" && actor.role !== "admin" && actor.isOwner !== true) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا يحق لغير المدير أو المالك تعطيل حساب مدير النظام.",
    });
  }
}

/** Prevent a normal administrator from taking over or disabling a peer/owner account. */
export function assertCanAdministerUser(actor: Actor, target: AdministeredUser): void {
  if (target.id === actor.userId) return;
  if (target.isOwner && actor.isOwner !== true) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يحق إلا للمالك إدارة حساب مالك آخر." });
  }
  if (target.role === "admin" && actor.isOwner !== true) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يحق إلا للمالك إدارة حساب مدير آخر." });
  }
}
