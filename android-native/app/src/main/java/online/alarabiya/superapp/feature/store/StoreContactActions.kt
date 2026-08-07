package online.alarabiya.superapp.feature.store

import online.alarabiya.superapp.model.store.PhoneSanitizer

object StoreContactActions {
    fun callUri(phone: String?): String? = PhoneSanitizer.normalizeIraqi(phone)?.let { "tel:$it" }

    fun whatsappUri(phone: String?): String? = PhoneSanitizer.whatsappNumber(phone)?.let {
        "https://wa.me/$it"
    }
}
