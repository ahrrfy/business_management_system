// AdminHub — وحدة «الإدارة» بتبويبات (الإعدادات + الفروع + التكاملات + المستخدمون + الأدوار + الأجهزة + التدقيق).
// تبويبات admin‑فقط: الفروع والتكاملات والأدوار؛ والباقي manager+. مسارات الإنشاء/التعديل تبقى مستقلّة.
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const Settings = lazy(() => import("@/pages/Settings"));
const IntegrationsSettings = lazy(() => import("@/pages/IntegrationsSettings"));
const Branches = lazy(() => import("@/pages/Branches"));
const Users = lazy(() => import("@/pages/Users"));
const Roles = lazy(() => import("@/pages/Roles"));
const KioskDevices = lazy(() => import("@/pages/KioskDevices"));
const AuditLogs = lazy(() => import("@/pages/AuditLogs"));

const TABS: HubTab[] = [
  { value: "settings", label: "الإعدادات", gate: { managerOnly: true }, Component: Settings },
  { value: "branches", label: "الفروع", gate: { adminOnly: true }, Component: Branches },
  { value: "integrations", label: "تَكاملات القَنوات", gate: { adminOnly: true }, Component: IntegrationsSettings },
  { value: "users", label: "المستخدمون", gate: { managerOnly: true }, Component: Users },
  { value: "roles", label: "الأدوار والصلاحيات", gate: { adminOnly: true }, Component: Roles },
  { value: "devices", label: "أجهزة قارئ الأسعار", gate: { managerOnly: true }, Component: KioskDevices },
  { value: "audit", label: "سجلّ التدقيق", gate: { managerOnly: true }, Component: AuditLogs },
];

export default function AdminHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام الإدارة" />;
}
