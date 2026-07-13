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
    implementation(libs.jadx.gui) {
        isChanging = false
    }
    implementation(libs.kotlin.reflect)
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
        archiveBaseName = "decx-server"
        archiveClassifier = ""
        archiveVersion = project.version.toString()
        mergeServiceFiles()
        manifest {
            attributes(
                "Main-Class" to "jadx.plugins.decx.server.DecxServerApp",
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
