package jadx.plugins.decx.utils

import org.slf4j.LoggerFactory
import jadx.plugins.decx.api.DecxError

object LogUtils {

    private val logger = LoggerFactory.getLogger("Decx")

    fun debug(message: String, vararg args: Any) {
        logger.debug("[Decx] $message", *args)
    }

    fun info(message: String, vararg args: Any) {
        logger.info("[Decx] $message", *args)
    }

    fun warn(message: String, vararg args: Any) {
        logger.warn("[Decx] $message", *args)
    }

    fun error(error: DecxError, vararg args: Any) {
        logger.error("[Decx] [{}] {}", error.code, error.format(*args))
    }

    fun error(error: DecxError, e: Exception, vararg args: Any) {
        logger.error("[Decx] [{}] {}", error.code, error.format(*args), e)
    }
}
