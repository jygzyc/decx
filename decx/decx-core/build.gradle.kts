plugins {
    alias(libs.plugins.kotlin.jvm)
}

val generatedVersionResourcesDir = layout.buildDirectory.dir("generated/resources/version")

dependencies {
    implementation(platform(libs.kotlinx.coroutines.bom))
    implementation(platform(libs.kotlinx.serialization.bom))
    implementation(libs.gson)
    implementation(libs.javalin)
    implementation(libs.mcp.kotlin.sdk.server)
    implementation(libs.ktor.server.cio)
    implementation(libs.jackson.databind)
    compileOnly(libs.jadx.core) {
        isChanging = false
    }
    compileOnly(libs.jadx.gui) {
        isChanging = false
    }
    compileOnly(libs.slf4j.api)
    compileOnly(libs.logback.classic)

    testImplementation(libs.junit.jupiter)
    testImplementation(libs.assertj.core)
    testRuntimeOnly(libs.junit.platform.launcher)
}

// ---------------------------------------------------------------------------
// Embed the TaiEEngine shadow jar as a classpath resource.
// At runtime, TaiEEngineProcess extracts it to a temp file and spawns it
// as a child process. This way core carries the engine without server/plugin
// needing to know about it — the engine jar is never a separate release.
// ---------------------------------------------------------------------------
val embeddedEngineJar = layout.buildDirectory.dir("generated/resources/taie-engine/decx-taie-engine.jar")

tasks.register<Copy>("embedTaieEngine") {
    group = "build"
    dependsOn(":decx-taie-engine:shadowJar")
    from(project(":decx-taie-engine").tasks.named("shadowJar"))
    rename { "decx-taie-engine.jar" }
    into(embeddedEngineJar.map { it.asFile.parentFile })
}

sourceSets {
    main {
        resources.srcDir(generatedVersionResourcesDir)
        resources.srcDir(layout.buildDirectory.dir("generated/resources/taie-engine"))
    }
}

val generateVersionProperties by tasks.registering {
    val outputFile = generatedVersionResourcesDir.map { it.file("version.properties") }
    val versionString = project.version.toString()
    outputs.file(outputFile)

    doLast {
        val file = outputFile.get().asFile
        file.parentFile.mkdirs()
        file.writeText("version=$versionString\n")
    }
}

tasks.processResources {
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    dependsOn(generateVersionProperties)
    dependsOn("embedTaieEngine")
}

tasks.jar {
    dependsOn(generateVersionProperties)
    from(sourceSets.main.get().output)
    manifest {
        attributes("Implementation-Version" to project.version.toString())
    }
}
