plugins {
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.shadow) apply false
    alias(libs.plugins.use.latest.versions)
    alias(libs.plugins.ben.manes.versions)
}

repositories {
    mavenLocal()
    mavenCentral()
    maven(url = "https://s01.oss.sonatype.org/content/repositories/snapshots/")
    google()
    maven(url = "https://jitpack.io")
}

val versionFile = rootProject.file("../version")
val projectVersion = versionFile.readText().trim()
version = projectVersion

subprojects {
    version = projectVersion

    repositories {
        mavenLocal()
        mavenCentral()
        maven(url = "https://s01.oss.sonatype.org/content/repositories/snapshots/")
        google()
        maven(url = "https://jitpack.io")
    }

    pluginManager.withPlugin("org.jetbrains.kotlin.jvm") {
        configure<org.jetbrains.kotlin.gradle.dsl.KotlinProjectExtension> {
            jvmToolchain(17)
        }
    }

    tasks.withType<JavaCompile> {
        options.compilerArgs.add("-parameters")
    }

    tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
        compilerOptions {
            javaParameters = true
        }
    }

    tasks.withType<Test> {
        useJUnitPlatform()
    }
}

tasks.register<Copy>("dist") {
    group = "build"
    dependsOn(":decx-plugin:dist")
    dependsOn(":decx-server:dist")

    from("${project(":decx-plugin").projectDir}/build/dist")
    from("${project(":decx-server").projectDir}/build/dist")
    // Include built-in taint analysis rules in the dist output
    from("$rootDir/rules") {
        into("rules")
    }
    into(layout.buildDirectory.dir("dist"))
}
