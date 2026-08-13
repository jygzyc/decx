plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.shadow)
}

dependencies {
    implementation(project(":decx-core"))
    implementation(project(":decx-taint"))
    compileOnly(libs.jadx.core) {
        isChanging = false
    }
    compileOnly(libs.jadx.gui) {
        isChanging = false
    }
    compileOnly(libs.jadx.cli) {
        isChanging = false
    }
    compileOnly(libs.javalin)
    compileOnly(libs.gson)
    compileOnly(libs.slf4j.api)
    compileOnly(libs.logback.classic)
}

tasks.processResources {
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
}

tasks {
    named<com.github.jengelman.gradle.plugins.shadow.tasks.ShadowJar>("shadowJar") {
        archiveBaseName = "jadx_decx_plugin"
        archiveClassifier = ""
        archiveVersion = project.version.toString()
        // Service transformers must see duplicate provider files (Shadow 9.6+).
        filesMatching(listOf("META-INF/services/**", "META-INF/*.kotlin_module")) {
            duplicatesStrategy = DuplicatesStrategy.INCLUDE
        }
        mergeServiceFiles()
        manifest {
            attributes("Implementation-Version" to project.version.toString())
        }
    }

    register<Copy>("dist") {
        group = "build"
        dependsOn(shadowJar)
        from(shadowJar)
        into(layout.buildDirectory.dir("dist"))
    }
}
