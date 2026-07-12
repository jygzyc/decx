plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.shadow)
    `maven-publish`
}

dependencies {
    // Tai-e static analysis framework — the sole consumer of this dependency.
    implementation(libs.tai.e)
    // YAML rule parsing (AppShark-style source/sink/sanitizer rules)
    implementation(libs.jackson.dataformat.yaml)
    // JSON-RPC protocol serialization
    implementation(libs.gson)
    implementation(libs.slf4j.api)
    implementation(libs.logback.classic)
}

tasks {
    named<Jar>("jar") {
        archiveClassifier = "plain"
    }

    named<com.github.jengelman.gradle.plugins.shadow.tasks.ShadowJar>("shadowJar") {
        archiveBaseName = "decx-taie-engine"
        archiveClassifier = ""
        archiveVersion = project.version.toString()
        // Relocate ASM to avoid conflicts if this jar is ever loaded alongside JADX
        relocate("org.objectweb.asm", "decx.taie.asm")
        mergeServiceFiles()
        manifest {
            attributes(
                "Main-Class" to "decx.taie.TaiEEngineMain",
                "Implementation-Version" to project.version.toString()
            )
        }
    }

    register<Copy>("dist") {
        group = "build"
        dependsOn(shadowJar)
        from(shadowJar)
        into(layout.buildDirectory.dir("dist"))
    }
}
