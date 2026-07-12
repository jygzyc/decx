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

sourceSets {
    main {
        resources.srcDir(generatedVersionResourcesDir)
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
}

tasks.jar {
    dependsOn(generateVersionProperties)
    from(sourceSets.main.get().output)
    manifest {
        attributes("Implementation-Version" to project.version.toString())
    }
}
