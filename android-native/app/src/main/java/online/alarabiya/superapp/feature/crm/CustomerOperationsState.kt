package online.alarabiya.superapp.feature.crm

import online.alarabiya.superapp.model.crm.CatalogOption
import online.alarabiya.superapp.model.crm.CustomerContractPrice
import online.alarabiya.superapp.model.crm.CustomerContractPriceDraft
import online.alarabiya.superapp.model.crm.CustomerFollowUp
import online.alarabiya.superapp.model.crm.CustomerFollowUpDraft
import online.alarabiya.superapp.model.crm.CustomerFollowUpPage

data class CustomerOperationsState(
    val dueRows: List<CustomerFollowUp> = emptyList(),
    val dueTotal: Int = 0,
    val dueFresh: Boolean = false,
    val notesPage: CustomerFollowUpPage = CustomerFollowUpPage(emptyList(), 0),
    val notesFresh: Boolean = false,
    val includeResolved: Boolean = true,
    val contracts: List<CustomerContractPrice> = emptyList(),
    val contractTotal: Int = 0,
    val contractHasMore: Boolean = false,
    val contractNextCursor: String? = null,
    val contractsFresh: Boolean = false,
    val followUpEditor: CustomerFollowUpDraft? = null,
    val contractEditor: CustomerContractPriceDraft? = null,
    val contractCatalogQuery: String = "",
    val contractCatalogResults: List<CatalogOption> = emptyList(),
    val pendingDeleteFollowUpId: Long? = null,
    val pendingDeleteContractId: Long? = null,
) {
    val canMutateFollowUps: Boolean
        get() = notesFresh && dueFresh

    val canMutateContracts: Boolean
        get() = contractsFresh

    fun clearSelectedCustomer(): CustomerOperationsState = copy(
        notesPage = CustomerFollowUpPage(emptyList(), 0),
        notesFresh = false,
        contracts = emptyList(),
        contractTotal = 0,
        contractHasMore = false,
        contractNextCursor = null,
        contractsFresh = false,
        followUpEditor = null,
        contractEditor = null,
        contractCatalogQuery = "",
        contractCatalogResults = emptyList(),
        pendingDeleteFollowUpId = null,
        pendingDeleteContractId = null,
    )
}

internal fun customerOperationsUseTwoPane(widthDp: Int, fontScale: Float): Boolean =
    widthDp >= 760 && fontScale < 1.5f
