package jadx.plugins.decx.utils

import jadx.api.ICodeCache
import jadx.api.ICodeInfo
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Byte-bounded LRU implementation of JADX's [ICodeCache] (plan A of the
 * headless-server memory governor).
 *
 * JADX's default `jadx.api.impl.InMemoryCodeCache` is an unbounded
 * `ConcurrentHashMap` that keeps the full decompiled source text + code
 * metadata of every class the server ever touches for the lifetime of the
 * JVM. For large apps that is the dominant heap consumer and the reason the
 * `decx.decompile.minFreeHeapBytes` guard eventually starts refusing all
 * decompiles.
 *
 * This cache caps the retained decompiled code by an approximate byte budget
 * (UTF-16 code chars plus a small per-entry overhead) and evicts
 * least-recently-used entries. Evicted names are reported through [onEvict] so
 * [DecompileGuard] can also release the matching JADX internal state.
 *
 * Thread-safety: a single [ReentrantLock] guards the LRU. [onEvict] is invoked
 * *after* releasing the lock, so a blocking callback (backpressure) cannot
 * stall other cache accesses.
 */
internal class BoundedCodeCache(
    private val maxBytes: Long,
    private val onEvict: (String) -> Unit = {},
) : ICodeCache {

    private val lock = ReentrantLock()

    /** Access-ordered LRU: class raw name -> decompiled code info. */
    private val order = LinkedHashMap<String, ICodeInfo>(1024, 0.75f, true)
    private var bytes = 0L
    private var evictions = 0L
    private var hits = 0L

    override fun add(clsFullName: String, codeInfo: ICodeInfo) {
        if (codeInfo === ICodeInfo.EMPTY) return
        val evicted = lock.withLock {
            val previous = order.put(clsFullName, codeInfo)
            if (previous != null) bytes -= estimate(previous)
            bytes += estimate(codeInfo)
            evictLocked()
        }
        // Notify outside the lock: onEvict may block (backpressure) or call
        // back into this cache without risking a self-deadlock on the LRU guard.
        evicted.forEach(onEvict)
    }

    override fun remove(clsFullName: String) {
        lock.withLock {
            order.remove(clsFullName)?.let { bytes -= estimate(it) }
        }
    }

    override fun get(clsFullName: String): ICodeInfo = lock.withLock {
        hits++
        order[clsFullName] ?: ICodeInfo.EMPTY
    }

    override fun getCode(clsFullName: String): String? = lock.withLock {
        order[clsFullName]?.codeStr
    }

    override fun contains(clsFullName: String): Boolean = lock.withLock {
        order.containsKey(clsFullName)
    }

    override fun close() = clear()

    /** Drop all entries and reset counters (kept usable afterwards). */
    fun clear() = lock.withLock {
        order.clear()
        bytes = 0
        evictions = 0
        hits = 0
    }

    fun stats(): Map<String, Any> = lock.withLock {
        linkedMapOf(
            "entries" to order.size,
            "bytes" to bytes,
            "max_bytes" to maxBytes,
            "evictions" to evictions,
            "hits" to hits,
        )
    }

    private fun evictLocked(): List<String> {
        val evicted = mutableListOf<String>()
        val it = order.entries.iterator()
        while (bytes > maxBytes && it.hasNext()) {
            val eldest = it.next()
            it.remove()
            bytes -= estimate(eldest.value)
            evictions++
            evicted.add(eldest.key)
        }
        return evicted
    }

    private fun estimate(info: ICodeInfo): Long {
        // Java strings are UTF-16; approximate retained size plus a fixed
        // per-entry overhead for the CodeMetadata and map node.
        return info.codeStr.length.toLong() * 2 + 1024
    }
}
