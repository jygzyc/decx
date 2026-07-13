plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.shadow)
    `maven-publish`
}

dependencies {
    // Tai-e static analysis framework — the sole consumer of this dependency.
    implementation(libs.tai.e)
    // Tai-e's modified Soot/FlowDroid patches (override specific classes).
    // These MUST come after the standard Soot/FlowDroid deps so that
    // shadowJar's "last wins" deduplication keeps the modified versions.
    implementation(fileTree("lib") { include("*.jar") })
    // YAML rule parsing (AppShark-style source/sink/sanitizer rules)
    implementation(libs.jackson.dataformat.yaml)
    // JSON-RPC protocol serialization
    implementation(libs.gson)
    implementation(libs.slf4j.api)
    implementation(libs.logback.classic)

    testImplementation(libs.junit.jupiter)
    testImplementation(libs.assertj.core)
    testRuntimeOnly(libs.junit.platform.launcher)
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
        // Tai-e ships modified Soot/FlowDroid class overrides in lib/*.jar.
        // These override specific classes in the standard Soot/FlowDroid deps.
        // zipTree + from() added LAST so shadow's dedup keeps these versions.
        from(zipTree(rootProject.file("decx-taie-engine/lib/flowdroidclasses-modified.jar")))
        from(zipTree(rootProject.file("decx-taie-engine/lib/sootclasses-modified.jar")))
        duplicatesStrategy = DuplicatesStrategy.EXCLUDE
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
