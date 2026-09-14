package jadx.plugins.decx.api

enum class DecxError(val code: String, val status: Int, val message: String) {
    SERVER_INTERNAL_ERROR("INTERNAL_ERROR", 500, "Internal error: %s"),
    SERVICE_ERROR("SERVICE_ERROR", 503, "Service error: %s"),
    REQUEST_TIMEOUT("REQUEST_TIMEOUT", 504, "Request timed out after %sms: %s"),
    HEALTH_CHECK_FAILED("HEALTH_CHECK_FAILED", 500, "Health check failed: %s"),
    UNKNOWN_ENDPOINT("UNKNOWN_ENDPOINT", 404, "Unknown endpoint: %s"),
    INVALID_PARAMETER("INVALID_PARAMETER", 400, "Invalid parameter: %s"),
    METHOD_NOT_FOUND("METHOD_NOT_FOUND", 404, "Method not found: %s"),
    CLASS_NOT_FOUND("CLASS_NOT_FOUND", 404, "Class not found: %s"),
    RESOURCE_NOT_FOUND("RESOURCE_NOT_FOUND", 404, "Resource not found: %s"),
    MANIFEST_NOT_FOUND("MANIFEST_NOT_FOUND", 404, "AndroidManifest not found"),
    FIELD_NOT_FOUND("FIELD_NOT_FOUND", 404, "Field not found: %s"),
    INTERFACE_NOT_FOUND("INTERFACE_NOT_FOUND", 404, "Interface not found: %s"),
    SERVICE_IMPL_NOT_FOUND("SERVICE_IMPL_NOT_FOUND", 404, "Service implementation not found for: %s"),
    NO_STRINGS_FOUND("NO_STRINGS_FOUND", 404, "No strings.xml resource found"),
    NO_MAIN_ACTIVITY("NO_MAIN_ACTIVITY", 404, "No MAIN/LAUNCHER Activity found"),
    NO_APPLICATION("NO_APPLICATION", 404, "Application class not found"),
    EMPTY_SEARCH_KEY("EMPTY_SEARCH_KEY", 400, "Search key cannot be empty"),
    DECOMPILATION_SKIPPED("DECOMPILATION_SKIPPED", 503, "Decompilation skipped: %s"),
    NOT_GUI_MODE("NOT_GUI_MODE", 503, "Not in GUI mode");

    fun format(vararg args: Any): String {
        return if (args.isEmpty()) message else message.format(*args)
    }
}
