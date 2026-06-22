package jadx.plugins.decx.service

import jadx.api.JadxDecompiler
import jadx.api.ResourceFile
import jadx.api.ResourceType
import jadx.core.utils.android.AndroidManifestParser
import jadx.core.utils.android.AppAttribute
import jadx.plugins.decx.api.DecxKind
import jadx.plugins.decx.api.DecxFilter
import jadx.plugins.decx.api.DecxError
import jadx.plugins.decx.api.DecxApiResult
import jadx.plugins.decx.utils.AnalysisResultUtils
import jadx.plugins.decx.utils.CodeUtils
import jadx.plugins.decx.utils.ItemKind
import org.w3c.dom.Document
import org.w3c.dom.Element
import org.w3c.dom.NodeList
import java.io.ByteArrayInputStream
import java.util.*
import javax.xml.parsers.DocumentBuilderFactory

class AndroidService(override val decompiler: JadxDecompiler) : DecompilerBackedService {

    private fun getAppManifest(): ResourceFile? {
        return decompiler.resources
            ?.stream()
            ?.filter { resourceFile -> resourceFile.type == ResourceType.MANIFEST }
            ?.findFirst()
            ?.orElse(null)
    }

    private fun getManifestDocument(): Document? {
        val manifest = getAppManifest() ?: return null
        val manifestContent = manifest.loadContent()?.text?.codeStr ?: return null
        val factory = DocumentBuilderFactory.newInstance()
        val builder = factory.newDocumentBuilder()
        return builder.parse(ByteArrayInputStream(manifestContent.toByteArray(Charsets.UTF_8)))
    }

    private fun getTargetSdkVersion(doc: Document): Int {
        val usesSdks = doc.getElementsByTagName("uses-sdk")
        if (usesSdks.length > 0) {
            val item = usesSdks.item(0) as Element
            val target = item.getAttribute("android:targetSdkVersion")
            if (target.isNotEmpty()) return target.toIntOrNull() ?: 1
            val min = item.getAttribute("android:minSdkVersion")
            if (min.isNotEmpty()) return min.toIntOrNull() ?: 1
        }
        return 1
    }

    private fun isDeepLinkIntentFilter(intentFilter: Element): Boolean {
        val hasViewAction = intentFilter.getElementsByTagName("action").let { nodes ->
            (0 until nodes.length).any { i ->
                (nodes.item(i) as? Element)?.getAttribute("android:name") == "android.intent.action.VIEW"
            }
        }

        val categories = intentFilter.getElementsByTagName("category")
        val hasBrowsable = (0 until categories.length).any { i ->
            (categories.item(i) as? Element)?.getAttribute("android:name") == "android.intent.category.BROWSABLE"
        }
        val hasDefault = (0 until categories.length).any { i ->
            (categories.item(i) as? Element)?.getAttribute("android:name") == "android.intent.category.DEFAULT"
        }

        return hasViewAction && hasBrowsable && hasDefault
    }

    private fun getComponentName(intentFilter: Element): String? {
        val parent = intentFilter.parentNode as? Element ?: return null
        return parent.getAttribute("android:name").takeIf { it.isNotEmpty() }
    }

    private fun extractDataElements(intentFilter: Element): List<Map<String, String>> {
        val dataTags = intentFilter.getElementsByTagName("data")
        val dataList = mutableListOf<Map<String, String>>()

        for (i in 0 until dataTags.length) {
            val data = dataTags.item(i) as? Element ?: continue

            dataList.add(mapOf(
                "scheme" to data.getAttribute("android:scheme"),
                "host" to data.getAttribute("android:host"),
                "port" to data.getAttribute("android:port"),
                "path" to data.getAttribute("android:path"),
                "pathPrefix" to data.getAttribute("android:pathPrefix"),
                "pathPattern" to data.getAttribute("android:pathPattern"),
                "mimeType" to data.getAttribute("android:mimeType")
            ))
        }

        return dataList
    }

    private fun parseStringEntries(fileName: String, content: String): List<Map<String, Any>> {
        val factory = DocumentBuilderFactory.newInstance()
        val builder = factory.newDocumentBuilder()
        val doc = builder.parse(ByteArrayInputStream(content.toByteArray(Charsets.UTF_8)))
        val nodes = doc.getElementsByTagName("string")
        return (0 until nodes.length).mapNotNull { index ->
            val element = nodes.item(index) as? Element ?: return@mapNotNull null
            val name = element.getAttribute("name").takeIf { it.isNotBlank() } ?: return@mapNotNull null
            mapOf(
                "id" to "$fileName#$name",
                "name" to name,
                "value" to element.textContent.orEmpty(),
                "file" to fileName
            )
        }
    }

    /** Returns the parsed AndroidManifest.xml content. */
    fun handleGetAppManifest(): DecxApiResult {
        return try {
            val manifest = getAppManifest()
                ?: return DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.APP_MANIFEST, emptyMap(), DecxError.MANIFEST_NOT_FOUND))
            val manifestContent = manifest.loadContent()?.text?.codeStr ?: ""
            val items = listOf(AnalysisResultUtils.item(
                id = manifest.originalName, kind = ItemKind.CODE, title = manifest.originalName,
                content = manifestContent, meta = mapOf("language" to "xml")
            ))
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.APP_MANIFEST, items = items))
        } catch (e: Exception) {
            DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.APP_MANIFEST, emptyMap(), DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }

    /** Resolves the launcher activity declared by the manifest. */
    fun handleGetMainActivity(): DecxApiResult {
        return try {
            val manifest = getAppManifest()
                ?: return DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.MAIN_ACTIVITY, emptyMap(), DecxError.MANIFEST_NOT_FOUND))
            val parser = AndroidManifestParser(
                manifest, EnumSet.of(AppAttribute.MAIN_ACTIVITY), decompiler.args.security
            )
            val appParams = parser.parse()
            val mainActivityName = appParams.getMainActivity()
                ?: return DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.MAIN_ACTIVITY, emptyMap(), DecxError.NO_MAIN_ACTIVITY))
            val mainActivityClass = appParams.getMainActivityJavaClass(decompiler)
                ?: return DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.MAIN_ACTIVITY, emptyMap(), DecxError.CLASS_NOT_FOUND, mainActivityName))
            val items = listOf(AnalysisResultUtils.item(
                id = mainActivityClass.fullName,
                kind = ItemKind.SYMBOL,
                title = "Main activity: ${mainActivityClass.fullName.substringAfterLast('.')}",
                content = mainActivityClass.fullName
            ))
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.MAIN_ACTIVITY, items = items))
        } catch (e: Exception) {
            DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.MAIN_ACTIVITY, emptyMap(), DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }

    /** Resolves the custom Application implementation declared by the manifest. */
    fun handleGetApplication(): DecxApiResult {
        return try {
            val manifest = getAppManifest()
                ?: return DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.APPLICATION, emptyMap(), DecxError.MANIFEST_NOT_FOUND))
            val parser = AndroidManifestParser(
                manifest, EnumSet.of(AppAttribute.APPLICATION), decompiler.args.security
            )
            if (!parser.isManifestFound()) {
                return DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.APPLICATION, emptyMap(), DecxError.MANIFEST_NOT_FOUND))
            }
            val appParams = parser.parse()
            val applicationClass = appParams.getApplicationJavaClass(decompiler)
                ?: return DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.APPLICATION, emptyMap(), DecxError.NO_APPLICATION))
            val items = listOf(AnalysisResultUtils.item(
                id = applicationClass.fullName,
                kind = ItemKind.SYMBOL,
                title = "Application: ${applicationClass.fullName.substringAfterLast('.')}",
                content = applicationClass.fullName
            ))
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.APPLICATION, items = items))
        } catch (e: Exception) {
            DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.APPLICATION, emptyMap(), DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }

    /** Enumerates exported Android components and their relevant manifest attributes. */
    fun handleGetExportedComponents(filter: DecxFilter): DecxApiResult {
        val query = filter.toQuery()
        return try {
            val doc = getManifestDocument()
                ?: return DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.EXPORTED_COMPONENTS, query, DecxError.MANIFEST_NOT_FOUND))
            val components = mutableListOf<Map<String, Any>>()
            val compiled = filter.compile()
                ?: return DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.EXPORTED_COMPONENTS, query, DecxError.INVALID_PARAMETER, "invalid filter regex"))
            val tags = listOf("activity", "service", "receiver", "provider")
                .filter { compiled.matches(it) }
                .let { filter.limit(it) }
            val targetSdk = getTargetSdkVersion(doc)

            for (tag in tags) {
                val nodeList: NodeList = doc.getElementsByTagName(tag)
                for (i in 0 until nodeList.length) {
                    val element = nodeList.item(i) as Element
                    val exportedAttr = element.getAttribute("android:exported")
                    val intentFilters = element.getElementsByTagName("intent-filter")

                    val hasIntentFilterWithAction = (0 until intentFilters.length).any { j ->
                        val filter = intentFilters.item(j) as Element
                        filter.getElementsByTagName("action").length > 0
                    }

                    val isExported = when {
                        exportedAttr.equals("true", ignoreCase = true) -> true
                        exportedAttr.equals("false", ignoreCase = true) -> false
                        hasIntentFilterWithAction -> true
                        tag == "provider" && exportedAttr.isEmpty() && targetSdk < 17 -> true
                        else -> false
                    }

                    if (!isExported) continue

                    val name = element.getAttribute("android:name")
                    val componentMap = mutableMapOf<String, Any>(
                        "name" to name,
                        "type" to tag
                    )

                    val permission = element.getAttribute("android:permission")
                    if (permission.isNotEmpty()) componentMap["permission"] = permission

                    if (tag == "activity") {
                        val launchMode = element.getAttribute("android:launchMode")
                        if (launchMode.isNotEmpty()) componentMap["launchMode"] = launchMode
                        val taskAffinity = element.getAttribute("android:taskAffinity")
                        if (taskAffinity.isNotEmpty()) componentMap["taskAffinity"] = taskAffinity
                    }

                    if (tag == "provider") {
                        val authorities = element.getAttribute("android:authorities")
                        if (authorities.isNotEmpty()) componentMap["authorities"] = authorities
                        val readPermission = element.getAttribute("android:readPermission")
                        val writePermission = element.getAttribute("android:writePermission")
                        if (readPermission.isNotEmpty()) componentMap["readPermission"] = readPermission
                        if (writePermission.isNotEmpty()) componentMap["writePermission"] = writePermission
                        val grantUriPermissions = element.getAttribute("android:grantUriPermissions")
                        if (grantUriPermissions.equals("true", ignoreCase = true)) {
                            componentMap["grantUriPermissions"] = true
                        }
                    }

                    if (intentFilters.length > 0) {
                        val parsedFilters = mutableListOf<Map<String, Any>>()
                        for (j in 0 until intentFilters.length) {
                            val filter = intentFilters.item(j) as Element
                            val filterMap = mutableMapOf<String, Any>()

                            val actionNodes = filter.getElementsByTagName("action")
                            val actions = (0 until actionNodes.length).mapNotNull { k ->
                                val action = (actionNodes.item(k) as Element).getAttribute("android:name")
                                action.takeIf { it.isNotEmpty() }
                            }
                            if (actions.isEmpty()) continue
                            filterMap["actions"] = actions

                            val categoryNodes = filter.getElementsByTagName("category")
                            val categories = (0 until categoryNodes.length).mapNotNull { k ->
                                val category = (categoryNodes.item(k) as Element).getAttribute("android:name")
                                category.takeIf { it.isNotEmpty() }
                            }
                            if (categories.isNotEmpty()) filterMap["categories"] = categories

                            val dataNodes = filter.getElementsByTagName("data")
                            val dataList = (0 until dataNodes.length).mapNotNull { k ->
                                val dataElement = dataNodes.item(k) as Element
                                val dataMap = mutableMapOf<String, String>()
                                listOf("scheme", "host", "path", "pathPrefix", "pathPattern", "mimeType").forEach { attr ->
                                    val value = dataElement.getAttribute("android:$attr")
                                    if (value.isNotEmpty()) dataMap[attr] = value
                                }
                                dataMap.takeIf { it.isNotEmpty() }
                            }
                            if (dataList.isNotEmpty()) filterMap["data"] = dataList

                            parsedFilters.add(filterMap)
                        }
                        if (parsedFilters.isNotEmpty()) componentMap["intentFilters"] = parsedFilters
                    }

                    components.add(componentMap)
                }
            }
            val items = components.map { comp ->
                val compType = comp["type"] as String
                AnalysisResultUtils.item(
                    id = (comp["name"] as String),
                    kind = ItemKind.SYMBOL,
                    title = "Exported $compType: ${comp["name"]}",
                    content = "${comp["name"]}",
                    meta = comp
                )
            }
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.EXPORTED_COMPONENTS, query, items))
        } catch (e: Exception) {
            DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.EXPORTED_COMPONENTS, query, DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }

    /** Extracts manifest-declared deep links and normalizes their URI parts. */
    fun handleGetDeepLinks(): DecxApiResult {
        return try {
            val manifestDoc = getManifestDocument()
                ?: return DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.DEEP_LINKS, emptyMap(), DecxError.MANIFEST_NOT_FOUND))
            val deepLinks = mutableListOf<Map<String, Any>>()
            val nodeList = manifestDoc.getElementsByTagName("intent-filter")

            for (i in 0 until nodeList.length) {
                val intentFilter = nodeList.item(i) as? Element ?: continue
                if (!isDeepLinkIntentFilter(intentFilter)) continue
                val componentName = getComponentName(intentFilter) ?: continue
                val dataElements = extractDataElements(intentFilter)

                dataElements.forEach { dataMap ->
                    if (dataMap["scheme"].isNullOrEmpty()) return@forEach
                    deepLinks.add(mapOf(
                        "component" to componentName,
                        "scheme" to (dataMap["scheme"] ?: ""),
                        "host" to (dataMap["host"] ?: ""),
                        "port" to (dataMap["port"] ?: ""),
                        "path" to (dataMap["path"] ?: ""),
                        "pathPrefix" to (dataMap["pathPrefix"] ?: ""),
                        "pathPattern" to (dataMap["pathPattern"] ?: ""),
                        "mimeType" to (dataMap["mimeType"] ?: "")
                    ))
                }
            }
            val items = deepLinks.map { dl ->
                val component = dl["component"] as String
                val uri = buildString {
                    append(dl["scheme"] ?: "")
                    append("://")
                    val host = dl["host"] as? String ?: ""
                    if (host.isNotEmpty()) append(host)
                    val port = dl["port"] as? String ?: ""
                    if (port.isNotEmpty()) append(":$port")
                    val path = dl["path"] as? String ?: ""
                    if (path.isNotEmpty()) append(path)
                }
                AnalysisResultUtils.item(
                    id = "$component#$uri", kind = ItemKind.SYMBOL,
                    title = "Deep link: $uri", content = uri,
                    meta = linkedMapOf<String, Any>("component" to component).apply {
                        putAll(dl.filterKeys { it != "component" && (dl[it] as? String)?.isNotEmpty() == true })
                    }
                )
            }
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.DEEP_LINKS, items = items))
        } catch (e: Exception) {
            DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.DEEP_LINKS, emptyMap(), DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }

    /** Finds dynamic receiver registrations inside method bodies. */
    fun handleGetDynamicReceivers(filter: DecxFilter): DecxApiResult {
        val query = filter.toQuery()
        return try {
            val receivers = mutableListOf<Map<String, Any>>()
            val compiled = filter.compile()
                ?: return DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.DYNAMIC_RECEIVERS, query, DecxError.INVALID_PARAMETER, "invalid filter regex"))
            val classes = decompiler.classesWithInners
                .filter { jcls -> compiled.matches(jcls.fullName) }
                .let { filtered -> filter.limit(filtered) }
            classes.forEach { jcls ->
                if ("registerReceiver" !in jcls.smali) return@forEach
                for (jmth in jcls.methods) {
                    val mthCode = jmth.codeStr
                    if ("registerReceiver" !in mthCode) continue
                    receivers.add(mapOf(
                        "class" to jcls.fullName,
                        "method" to CodeUtils.methodSignature(jmth),
                        "code" to mthCode
                    ))
                }
            }
            val items = receivers.map { recv ->
                val className = recv["class"] as String
                val methodName = recv["method"] as String
                val methodCode = recv["code"] as String
                AnalysisResultUtils.item(
                    id = "$className#$methodName", kind = ItemKind.CODE,
                    title = "Dynamic receiver: $methodName",
                    content = methodCode,
                    meta = mapOf("class" to className, "method" to methodName, "total_lines" to methodCode.lines().size)
                )
            }
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.DYNAMIC_RECEIVERS, query, items))
        } catch (e: Exception) {
            DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.DYNAMIC_RECEIVERS, query, DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }

    /** Returns the available Android resource file inventory. */
    fun handleGetAllResources(filter: DecxFilter): DecxApiResult {
        val query = filter.toQuery()
        return try {
            val resources = decompiler.resources
                ?: return DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.ALL_RESOURCES, query, DecxError.RESOURCE_NOT_FOUND))
            val compiled = filter.compile()
                ?: return DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.ALL_RESOURCES, query, DecxError.INVALID_PARAMETER, "invalid filter regex"))
            val fileNames = mutableListOf<String>()
            for (resFile in resources) {
                try {
                    if (resFile.deobfName == "resources.arsc") {
                        resFile.loadContent()?.subFiles?.forEach { sub ->
                            fileNames.add(sub.name)
                        }
                    }
                    fileNames.add(resFile.deobfName)
                } catch (_: Exception) {
                    fileNames.add(resFile.deobfName)
                }
            }
            if (fileNames.isEmpty()) {
                return DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.ALL_RESOURCES, query, DecxError.RESOURCE_NOT_FOUND))
            }
            val filteredFileNames = fileNames
                .filter { name -> compiled.matches(name) }
                .let { names -> filter.limit(names) }
            val items = filteredFileNames.map { name ->
                AnalysisResultUtils.item(
                    id = name,
                    kind = ItemKind.SYMBOL,
                    title = "Resource: ${name.substringAfterLast('/')}",
                    content = name
                )
            }
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.ALL_RESOURCES, query, items))
        } catch (e: Exception) {
            DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.ALL_RESOURCES, query, DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }

    /** Returns the content of a single Android resource file. */
    fun handleGetResourceFile(res: String): DecxApiResult {
        val query = mapOf("target" to res)
        return try {
            val resources = decompiler.resources
                ?: return DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.RESOURCE_FILE, query, DecxError.RESOURCE_NOT_FOUND))
            for (resFile in resources) {
                if (resFile.deobfName == res) {
                    val content = resFile.loadContent()?.text?.codeStr ?: continue
                    val items = listOf(AnalysisResultUtils.item(id = res, kind = ItemKind.CODE, title = res, content = content))
                    return DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.RESOURCE_FILE, query, items))
                }
                if (resFile.deobfName == "resources.arsc") {
                    for (sub in resFile.loadContent()?.subFiles ?: continue) {
                        if (sub.name == res) {
                            val content = sub.text?.codeStr ?: continue
                            val items = listOf(AnalysisResultUtils.item(id = res, kind = ItemKind.CODE, title = res, content = content))
                            return DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.RESOURCE_FILE, query, items))
                        }
                    }
                }
            }
            DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.RESOURCE_FILE, query, DecxError.RESOURCE_NOT_FOUND, res))
        } catch (e: Exception) {
            DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.RESOURCE_FILE, query, DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }

    /** Discovers AIDL interfaces by matching Stub classes and implementations. */
    fun handleGetAidlInterfaces(filter: DecxFilter): DecxApiResult {
        val query = filter.toQuery()
        return try {
            val compiled = filter.compile()
                ?: return DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.AIDL_INTERFACES, query, DecxError.INVALID_PARAMETER, "invalid filter regex"))
            val stubClasses = decompiler.classesWithInners.filter { clazz ->
                clazz.fullName.endsWith(".Stub")
            }
            val aidlInterfaces = stubClasses.mapNotNull { stub ->
                val interfaceName = stub.fullName.removeSuffix(".Stub")
                if (!compiled.matches(interfaceName)) {
                    return@mapNotNull null
                }
                val stubSmaliName = stub.fullName.replace(".Stub", "\$Stub").replace('.', '/')
                val implClasses = decompiler.classesWithInners.filter { clazz ->
                    clazz.fullName != stub.fullName &&
                    !clazz.fullName.endsWith(".Proxy") &&
                    clazz.smali.contains(".super L$stubSmaliName")
                }
                mapOf(
                    "interface" to interfaceName,
                    "stub" to stub.fullName,
                    "implements" to implClasses.map { it.fullName }
                )
            }.let { interfaces -> filter.limit(interfaces) }
            val items = aidlInterfaces.map { aidl ->
                val ifaceName = aidl["interface"] as String
                val impls = aidl["implements"] as List<*>
                AnalysisResultUtils.item(
                    id = ifaceName,
                    kind = ItemKind.SYMBOL,
                    title = "AIDL: ${ifaceName.substringAfterLast('.')}",
                    meta = mapOf<String, Any>(
                        "stub" to (aidl["stub"] ?: ""),
                        "implementations" to impls
                    )
                )
            }
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.AIDL_INTERFACES, query, items))
        } catch (e: Exception) {
            DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.AIDL_INTERFACES, query, DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }

    /** Parses string resources into itemized key-value entries. */
    fun handleGetStrings(): DecxApiResult {
        return try {
            val resources = decompiler.resources
                ?: return DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.STRINGS, emptyMap(), DecxError.RESOURCE_NOT_FOUND))
            val stringsList = resources.mapNotNull { resFile ->
                runCatching {
                    when (resFile.deobfName) {
                        "resources.arsc" -> {
                            val sub = resFile.loadContent()?.subFiles?.find { it.name == "res/values/strings.xml" }
                            sub?.text?.codeStr?.let { content -> mapOf("file" to sub.name, "content" to content) }
                        }
                        "res/values/strings.xml" -> {
                            resFile.loadContent()?.text?.codeStr
                                ?.let { content -> mapOf("file" to resFile.deobfName, "content" to content) }
                        }
                        else -> null
                    }
                }.getOrNull()
            }
            if (stringsList.isEmpty()) {
                return DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.STRINGS, emptyMap(), DecxError.NO_STRINGS_FOUND))
            }
            val items = stringsList.flatMap { s ->
                val fileName = s["file"] as String
                parseStringEntries(fileName, s["content"] as String)
                    .map { entry ->
                        AnalysisResultUtils.item(
                            id = entry["id"] as String,
                            kind = ItemKind.SYMBOL,
                            title = "String: ${entry["name"]}",
                            content = entry["value"] as String,
                            meta = mapOf("file" to fileName)
                        )
                    }
            }
            if (items.isEmpty()) {
                return DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.STRINGS, emptyMap(), DecxError.NO_STRINGS_FOUND))
            }
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.STRINGS, items = items))
        } catch (e: Exception) {
            DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.STRINGS, emptyMap(), DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }

    /** Resolves a Binder service implementation from an AIDL-style Stub superclass. */
    fun handleGetSystemServiceImpl(iface: String): DecxApiResult {
        val query = mapOf("target" to iface)
        return try {
            val interfaceClazz = decompiler.searchJavaClassOrItsParentByOrigFullName(iface)
                ?: return DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.SYSTEM_SERVICE_IMPL, query, DecxError.INTERFACE_NOT_FOUND, iface))
            val serviceClazz = decompiler.classes.firstOrNull {
                it.smali.contains(".super L${interfaceClazz.fullName.replace('.', '/')}\$Stub;")
            } ?: return DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.SYSTEM_SERVICE_IMPL, query, DecxError.SERVICE_IMPL_NOT_FOUND, iface))

            val methodItems = serviceClazz.methods.map { method ->
                val signature = CodeUtils.methodSignature(method)
                AnalysisResultUtils.item(
                    id = signature,
                    kind = ItemKind.SYMBOL,
                    title = "Method: $signature",
                    content = signature
                )
            }
            val fieldItems = serviceClazz.fields.map { field ->
                val signature = CodeUtils.fieldSignature(field)
                AnalysisResultUtils.item(
                    id = signature,
                    kind = ItemKind.SYMBOL,
                    title = "Field: $signature",
                    content = signature
                )
            }
            val items = listOf(
                AnalysisResultUtils.item(
                    id = serviceClazz.fullName,
                    kind = ItemKind.SYMBOL,
                    title = "Service implementation: ${serviceClazz.fullName.substringAfterLast('.')}",
                    content = "${serviceClazz.fullName} implements $iface",
                    meta = mapOf(
                        "interface" to iface,
                        "method_count" to methodItems.size,
                        "field_count" to fieldItems.size
                    )
                )
            ) + methodItems + fieldItems

            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.SYSTEM_SERVICE_IMPL, query, items))
        } catch (e: Exception) {
            DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.SYSTEM_SERVICE_IMPL, query, DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }
}
