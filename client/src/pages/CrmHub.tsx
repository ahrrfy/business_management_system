import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const CrmOverview=lazy(()=>import("@/pages/CrmOverview"));
const Customers=lazy(()=>import("@/pages/Customers"));
const CustomerNotes=lazy(()=>import("@/pages/CustomerNotes"));
const Inbox=lazy(()=>import("@/pages/Inbox"));
const ContactsBank=lazy(()=>import("@/pages/ContactsBank"));
const Quotations=lazy(()=>import("@/pages/Quotations"));
const Campaigns=lazy(()=>import("@/pages/Campaigns"));
const WaBroadcasts=lazy(()=>import("@/pages/WaBroadcasts"));
const Offers=lazy(()=>import("@/pages/Offers"));
const Coupons=lazy(()=>import("@/pages/Coupons"));
const ARReminders=lazy(()=>import("@/pages/ARReminders"));
const CustomerStatement=lazy(()=>import("@/pages/CustomerStatement"));
const ARAging=lazy(()=>import("@/pages/ARAging"));
const InstallmentPlans=lazy(()=>import("@/pages/InstallmentPlans"));
const ContractPrices=lazy(()=>import("@/pages/ContractPrices"));

const TABS:HubTab[]=[
  {value:"overview",label:"نظرة عامة",gate:{module:"campaigns",level:"READ"},Component:CrmOverview},
  {value:"customers",label:"العملاء",gate:{module:"crm",level:"READ"},Component:Customers},
  {value:"followups",label:"المتابعات",gate:{module:"crm",level:"READ"},Component:CustomerNotes},
  {value:"inbox",label:"التواصل والوارد",gate:{module:"channels",level:"READ"},Component:Inbox},
  {value:"contacts",label:"جهات الاتصال",gate:{module:"crm",level:"READ"},Component:ContactsBank},
  {value:"quotations",label:"الفرص وعروض الأسعار",gate:{module:"sales",level:"READ"},Component:Quotations},
  {value:"campaigns",label:"الحملات",gate:{module:"campaigns",level:"READ"},Component:Campaigns},
  {value:"broadcasts",label:"بث واتساب",gate:{module:"campaigns",level:"READ"},Component:WaBroadcasts},
  {value:"offers",label:"العروض والخصومات",gate:{module:"campaigns",level:"READ"},Component:Offers},
  {value:"coupons",label:"الكوبونات",gate:{module:"campaigns",level:"READ"},Component:Coupons},
  {value:"collections",label:"التحصيل والمتأخرات",gate:{module:"collections",level:"FULL"},Component:ARReminders},
  {value:"installments",label:"الأقساط",gate:{module:"treasury",level:"READ"},Component:InstallmentPlans},
  {value:"contracts",label:"التسعير التعاقدي",gate:{managerOnly:true},Component:ContractPrices},
  {value:"statement",label:"كشف العميل",gate:{module:"reports",level:"READ"},Component:CustomerStatement},
  {value:"aging",label:"أعمار الذمم",gate:{module:"reports",level:"READ"},Component:ARAging},
];
export default function CrmHub(){return <PageTabs tabs={TABS} ariaLabel="أقسام إدارة علاقات العملاء"/>}
