package jadx.plugins.decx.api

class DecxRequestParams(private val payload: Map<String, Any>) {

    fun string(name: String): String {
        val value = payload[name] as? String ?: throw IllegalArgumentException("Invalid parameter '$name': expected string")
        if (value.isBlank()) throw IllegalArgumentException("Invalid parameter '$name': value cannot be blank")
        return value
    }

    fun boolean(name: String): Boolean {
        return payload.boolean(name) ?: throw IllegalArgumentException("Missing required parameter: $name")
    }

    fun filter(): DecxFilter {
        return DecxFilter.from(payload.obj("filter"))
    }

    fun exported(): DecxFilter {
        return DecxFilter.from(payload)
    }

    fun search(): DecxFilter {
        val search = payload.obj("search") ?: throw IllegalArgumentException("Missing required parameter: search")
        return DecxFilter.from(search)
    }

    fun grep(): DecxFilter {
        val grep = payload.obj("grep") ?: throw IllegalArgumentException("Missing required parameter: grep")
        return DecxFilter.from(grep).also {
            if (it.limit == null) throw IllegalArgumentException("Missing required parameter: grep.limit")
        }
    }

    private fun Map<*, *>.obj(name: String): Map<*, *>? {
        val raw = this[name] ?: return null
        return raw as? Map<*, *> ?: throw IllegalArgumentException("Invalid parameter '$name': expected object")
    }

    private fun Map<*, *>.boolean(name: String): Boolean? {
        return when (val raw = this[name] ?: return null) {
            is Boolean -> raw
            is String -> when (raw.lowercase()) {
                "true" -> true
                "false" -> false
                else -> throw IllegalArgumentException("Invalid parameter '$name': expected boolean")
            }
            else -> throw IllegalArgumentException("Invalid parameter '$name': expected boolean")
        }
    }

}
