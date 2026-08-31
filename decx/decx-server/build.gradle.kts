import java.net.URI
import java.util.zip.ZipFile

import org.gradle.api.DefaultTask
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.TaskAction

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.shadow)
}

// Jadx Script (Kotlin) plugin is not published to Maven Central; the plugin jar is
// bundled inside a GitHub release zip (same artifact `jadx plugins --install` fetches).
// We extract just the plugin jar once and keep the scripting runtime on Maven Central.
val jadxScriptVersion = libs.versions.jadxScriptKotlin.get()
val jadxScriptPluginJar = layout.buildDirectory.file("jadx-script/jadx-script-kotlin-$jadxScriptVersion.jar")

/**
 * Fetches the jadx-script-kotlin plugin jar from its GitHub release zip.
 * A task class (not a script closure) so configuration cache can serialize it.
 */
abstract class FetchJadxScriptPluginTask : DefaultTask() {

	@get:Input
	abstract val jadxScriptVersion: Property<String>

	@get:OutputFile
	abstract val pluginJar: RegularFileProperty

	@TaskAction
	fun run() {
		val outFile = pluginJar.get().asFile
		if (outFile.exists() && outFile.length() > 0L) {
			return
		}
		outFile.parentFile.mkdirs()
		val version = jadxScriptVersion.get()
		val zipUrl = "https://github.com/jadx-decompiler/jadx-script-kotlin/releases/download/" +
			"v$version/jadx-script-kotlin-$version.zip"
		// Allow offline/blocked builds to supply the release zip locally, e.g.
		// DECX_JADX_SCRIPT_ZIP=/path/to/jadx-script-kotlin-1.1.2.zip ./gradlew :decx-server:shadowJar
		val localZip = System.getenv("DECX_JADX_SCRIPT_ZIP")
		val zipFile = if (!localZip.isNullOrBlank() && File(localZip).isFile) {
			File(localZip)
		} else {
			val tmpZip = File.createTempFile("jadx-script-kotlin", ".zip")
			try {
				val url = URI(zipUrl).toURL()
				url.openStream().use { input -> tmpZip.outputStream().use { input.copyTo(it) } }
			} catch (e: Exception) {
				tmpZip.delete()
				throw GradleException("Failed to download jadx-script-kotlin release zip. " +
					"Set DECX_JADX_SCRIPT_ZIP to a local copy of the zip: ${e.message}", e)
			}
			tmpZip
		}
		try {
			ZipFile(zipFile).use { zip ->
				val entryName = "jadx-script-kotlin-$version.jar"
				val entry = zip.getEntry(entryName)
					?: error("Plugin jar '$entryName' not found in release zip")
				zip.getInputStream(entry).use { input ->
					outFile.outputStream().use { input.copyTo(it) }
				}
			}
		} finally {
			if (zipFile.absolutePath.startsWith(System.getProperty("java.io.tmpdir"))) {
				zipFile.delete()
			}
		}
	}
}

val fetchJadxScriptPlugin = tasks.register<FetchJadxScriptPluginTask>("fetchJadxScriptPlugin") {
	group = "jadx-script"
	description = "Download jadx-script-kotlin plugin jar from the GitHub release"
	jadxScriptVersion.set(libs.versions.jadxScriptKotlin)
	pluginJar.set(jadxScriptPluginJar)
}

dependencies {
    implementation(project(":decx-core"))
    implementation(libs.jadx.core) {
        isChanging = false
    }
    implementation(libs.jadx.cli) {
        isChanging = false
    }
    implementation(libs.kotlin.reflect)
    implementation(libs.gson)
    implementation(libs.slf4j.api)
    implementation(libs.logback.classic)

    // Jadx Script (Kotlin) — enables running `.jadx.kts` scripts during decompilation.
    // The plugin jar is fetched from the GitHub release; the scripting runtime comes
    // from Maven Central (versions mirror the plugin's own build).
    implementation(files(jadxScriptPluginJar).builtBy(fetchJadxScriptPlugin))
    implementation(libs.kotlin.scripting.jvm.host)
    implementation(libs.kotlin.scripting.ide.services)
    implementation(libs.kotlin.scripting.compiler.embeddable)
    implementation(libs.kotlin.scripting.dependencies)
    implementation(libs.kotlin.scripting.dependencies.maven)
    implementation(libs.kotlin.compiler.embeddable)
    implementation(libs.ktlint.rule.engine)
    implementation(libs.ktlint.ruleset.standard)
    implementation(libs.kotlin.logging.jvm)
}

tasks {
    named<Jar>("jar") {
        archiveClassifier = "plain"
    }

    named<com.github.jengelman.gradle.plugins.shadow.tasks.ShadowJar>("shadowJar") {
        archiveBaseName = "decx-server"
        archiveClassifier = ""
        archiveVersion = project.version.toString()
        // Kotlin scripting runtime pushes the jar past 65535 entries.
        isZip64 = true
        // Shadow 9.6 applies EXCLUDE before transformers by default, which leaves only
        // the first JadxPlugin provider and silently drops DexInputPlugin. Without it,
        // APK/DEX files load resources and generated R classes but no executable code.
        filesMatching(listOf("META-INF/services/**", "META-INF/*.kotlin_module")) {
            duplicatesStrategy = DuplicatesStrategy.INCLUDE
        }
        mergeServiceFiles()
        manifest {
            attributes(
                "Main-Class" to "jadx.plugins.decx.server.DecxServerApp",
                "Implementation-Version" to project.version.toString()
            )
        }
        doLast {
            val outputJar = archiveFile.get().asFile
            val jadxPlugins = ZipFile(outputJar).use { zip ->
                val entry = zip.getEntry("META-INF/services/jadx.api.plugins.JadxPlugin")
                    ?: throw GradleException("Missing JADX plugin service descriptor in ${outputJar.name}")
                zip.getInputStream(entry).bufferedReader().use { it.readText() }
            }
            check("jadx.plugins.input.dex.DexInputPlugin" in jadxPlugins) {
                "Missing DexInputPlugin from merged JADX plugin service descriptor in ${outputJar.name}"
            }
            check("jadx.plugins.script.kotlin.JadxScriptKotlinPlugin" in jadxPlugins) {
                "Missing JadxScriptKotlinPlugin from merged JADX plugin service descriptor in ${outputJar.name}"
            }
        }
    }

    register<Copy>("dist") {
        group = "build"
        dependsOn(shadowJar)
        from(shadowJar)
        into(layout.buildDirectory.dir("dist"))
    }
}
