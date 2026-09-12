import type { WorkspaceRefreshOptions, WorkspaceSnapshot } from "./workspaceAccess";

export type NativeTwoFactorInput = Readonly<{
  ticket: string;
  code?: string;
  recoveryCode?: string;
}>;

type CompleteTwoFactorDependencies = Readonly<{
  completeNativeTwoFactor(input: NativeTwoFactorInput): Promise<unknown>;
  refreshWorkspace(options?: WorkspaceRefreshOptions): Promise<WorkspaceSnapshot>;
  unlockLocalSession(): Promise<void>;
}>;

export async function completeTwoFactorSignIn(
  input: NativeTwoFactorInput,
  dependencies: CompleteTwoFactorDependencies,
): Promise<WorkspaceSnapshot> {
  await dependencies.unlockLocalSession();
  await dependencies.completeNativeTwoFactor(input);
  return dependencies.refreshWorkspace({ localProtectionAlreadyConfirmed: true });
}
