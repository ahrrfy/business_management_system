/**
 * client/src/lib/permissionsModel.ts — re-export من shared/permissions.ts
 * للتوافق مع الاستيرادات الموجودة (@/lib/permissionsModel).
 */
export {
  ROLES,
  ROLE_TEMPLATES,
  PERMISSION_MODULES,
  resolvePermissions,
  diffFromTemplate,
  canSeeCost,
  accessLabel,
  ALL_ROLES,
  type AccessLevel,
  type RoleKey,
  type RoleInfo,
  type PermissionModule,
  type PermissionMap,
} from "@shared/permissions";
