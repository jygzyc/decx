package decx.taie

/**
 * Result data classes for TaiEEngine queries.
 * These are serialized to JSON and sent over the IPC protocol.
 * They mirror the ITaiEEngine data classes in decx-core.
 */
object TaintResult {

    data class CallEdge(
        val from: String,
        val to: String,
        val invokeType: String,
        val line: Int?
    )

    data class RuleSummary(
        val id: String,
        val name: String,
        val description: String,
        val parameters: List<RuleParameter>?
    )

    data class RuleParameter(
        val name: String,
        val type: String,
        val description: String,
        val required: Boolean,
        val defaultValue: String?
    )

    data class TaintPath(
        val ruleId: String,
        val source: String,
        val sink: String,
        val steps: List<TaintStep>
    )

    data class TaintStep(
        val method: String,
        val line: Int,
        val desc: String
    )

    data class DynamicReceiverInfo(
        val registerMethod: String,
        val receiverClass: String,
        val actionFilters: List<String>
    )

    data class IccTarget(
        val sourceComponent: String,
        val intentCall: String,
        val targetComponent: String,
        val isExplicit: Boolean
    )

    data class CallbackInfo(
        val hostClass: String,
        val callbackMethod: String,
        val interfaceType: String
    )
}
