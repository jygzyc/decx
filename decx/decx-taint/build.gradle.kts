import java.net.URI
import java.util.zip.ZipFile

import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.TaskAction

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.shadow)
}

// Tai-e is not published to Maven Central (only 0.5.1/0.2.2 exist, and the
// taint engine needs 0.5.4). The official GitHub release zip contains the
// main jar plus the patched Soot/FlowDroid jars and the full runtime lib set;
// we extract its lib/ once per checkout and never ship it in any jar.
val taieVersion = libs.versions.taie.get()
val taieLibDir = layout.buildDirectory.dir("taie/lib")

/**
 * Fetches the Tai-e release zip and extracts all runtime jars into build/taie/lib.
 * A task class (not a script closure) so configuration cache can serialize it.
 */
abstract class FetchTaiETask : DefaultTask() {

    @get:Input
    abstract val taieVersion: Property<String>

    @get:OutputDirectory
    abstract val libDir: DirectoryProperty

    @TaskAction
    fun run() {
        val outDir = libDir.get().asFile
        if (outDir.isDirectory && outDir.listFiles { f -> f.name.endsWith(".jar") }!!.isNotEmpty()) {
            return
        }
        outDir.mkdirs()
        val version = taieVersion.get()
        val zipUrl = "https://github.com/pascal-lab/Tai-e/releases/download/" +
            "v$version/tai-e-$version.zip"
        // Allow offline/blocked builds to supply the release zip locally, e.g.
        // DECX_TAIE_ZIP=/path/to/tai-e-0.5.4.zip ./gradlew :decx-taint:build
        val localZip = System.getenv("DECX_TAIE_ZIP")
        val zipFile = if (!localZip.isNullOrBlank() && File(localZip).isFile) {
            File(localZip)
        } else {
            val tmpZip = File.createTempFile("tai-e", ".zip")
            try {
                val url = URI(zipUrl).toURL()
                url.openStream().use { input -> tmpZip.outputStream().use { input.copyTo(it) } }
            } catch (e: Exception) {
                tmpZip.delete()
                throw GradleException("Failed to download Tai-e release zip. " +
                    "Set DECX_TAIE_ZIP to a local copy of the zip: ${e.message}", e)
            }
            tmpZip
        }
        try {
            ZipFile(zipFile).use { zip ->
                val prefix = "tai-e-$version/lib/"
                val entries = zip.entries().asSequence()
                    .filter { !it.isDirectory && it.name.startsWith(prefix) && it.name.endsWith(".jar") }
                    .toList()
                check(entries.isNotEmpty()) { "No jars under '$prefix' found in Tai-e release zip" }
                entries.forEach { entry ->
                    val outFile = File(outDir, entry.name.removePrefix(prefix))
                    zip.getInputStream(entry).use { input ->
                        outFile.outputStream().use { input.copyTo(it) }
                    }
                }
                logger.lifecycle("Extracted ${entries.size} Tai-e jars into $outDir")
            }
        } finally {
            if (zipFile.absolutePath.startsWith(System.getProperty("java.io.tmpdir"))) {
                zipFile.delete()
            }
        }
    }
}

val fetchTaiE = tasks.register<FetchTaiETask>("fetchTaiE") {
    group = "taint"
    description = "Download the Tai-e release zip and extract its runtime jars"
    taieVersion.set(libs.versions.taie)
    libDir.set(taieLibDir)
}

// The extracted Tai-e runtime jars (API surface used by the worker sources).
// compileOnly for compilation; the worker JVM gets the full lib/ dir from
// DECX_HOME/tai-e/lib at runtime, so Tai-e never enters any shipped jar.
//
// The FULL dist lib/ must be on the compile classpath, not just the main jar:
// Tai-e's API signatures reference types from its dependencies (Soot, Jackson,
// ASM, ...), and Kotlin eagerly resolves supertypes — a lone tai-e jar makes
// every affected import fail with "Unresolved reference 'pascal'".
val taieJars = fileTree(taieLibDir) {
    include("*.jar")
}.builtBy(fetchTaiE)

// Runtime classpath packaged into the worker fat jar: only Gson, Kotlin
// stdlib, and logging. Never decx-core, never Tai-e.
val workerRuntime = configurations.create("workerRuntime") {
    isCanBeConsumed = false
    isCanBeResolved = true
}

dependencies {
    implementation(project(":decx-core"))
    implementation(libs.gson)
    compileOnly(libs.slf4j.api)
    compileOnly(taieJars)

    workerRuntime(libs.gson)
    workerRuntime(kotlin("stdlib"))
    workerRuntime(libs.slf4j.api)
    workerRuntime(libs.logback.classic)

    testImplementation(platform("org.junit:junit-bom:${libs.versions.junit.get()}"))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testImplementation(libs.assertj.core)
    testImplementation(libs.mockito.core)
    testImplementation(libs.mockito.kotlin)
}

configurations.shadowRuntimeElements {
    // Consumers (decx-server / decx-plugin) must get the plain library jar;
    // the shadow jar built here is the standalone worker binary instead.
    isCanBeConsumed = false
}

tasks {
    named<Jar>("jar") {
        archiveClassifier = "plain"
    }

    // Worker fat jar: spawned as a separate JVM by TaintWorkerPool. Tai-e
    // itself stays out (classpath = DECX_HOME/tai-e/lib/* + this jar).
    named<com.github.jengelman.gradle.plugins.shadow.tasks.ShadowJar>("shadowJar") {
        group = "taint"
        archiveBaseName.set("decx-taint-worker")
        archiveClassifier.set("")
        archiveVersion.set("")
        // Package only the curated worker runtime, not the project runtime
        // classpath (which would drag decx-core + Javalin + Ktor along).
        configurations = setOf(workerRuntime)
        exclude("module-info.class", "META-INF/versions/*/module-info.class")
        // Worker logging: stderr only, stdout stays pure NDJSON. The resource
        // lives under taint/ so the plain library jar cannot hijack server
        // logging; rename it to the logback default location here.
        from(layout.projectDirectory.file("src/main/resources/taint/worker-logback.xml")) {
            rename { "logback.xml" }
        }
        doLast {
            val outputJar = archiveFile.get().asFile
            val hasLogback = ZipFile(outputJar).use { zip -> zip.getEntry("logback.xml") != null }
            check(hasLogback) { "Worker jar ${outputJar.name} is missing logback.xml" }
        }
    }

    register<Copy>("dist") {
        group = "build"
        dependsOn(shadowJar)
        from(shadowJar)
        into(layout.buildDirectory.dir("dist"))
    }
}
