import java.util.zip.ZipFile

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.shadow)
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
}

tasks {
    named<Jar>("jar") {
        archiveClassifier = "plain"
    }

    named<com.github.jengelman.gradle.plugins.shadow.tasks.ShadowJar>("shadowJar") {
        archiveBaseName = "decx-server"
        archiveClassifier = ""
        archiveVersion = project.version.toString()
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
        }
    }

    register<Copy>("dist") {
        group = "build"
        dependsOn(shadowJar)
        from(shadowJar)
        into(layout.buildDirectory.dir("dist"))
    }
}
