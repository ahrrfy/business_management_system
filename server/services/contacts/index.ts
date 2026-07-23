// نقطة الدخول العامة لخدمة بنك جهات الاتصال — إعادة تصدير من الوحدات الفرعية (نمط services/tasks/index.ts).
export type { ContactKind, ContactsSearchCtx, ContactsSearchInput, ContactsSearchResult, UnifiedContact } from "./search";
export { searchContacts } from "./search";

export type { Contact360Input } from "./contact360";
export { contact360 } from "./contact360";

export type {
  CreateContactPersonInput,
  ListContactPersonsInput,
  UpdateContactPersonInput,
} from "./persons";
export { createContactPerson, listContactPersons, setContactPersonInactive, updateContactPerson } from "./persons";

export type { FindContactDuplicatesInput } from "./duplicates";
export { findContactDuplicates } from "./duplicates";

export type { SetWaConsentInput, WaConsentValue } from "./waConsent";
export { setWaConsent } from "./waConsent";
