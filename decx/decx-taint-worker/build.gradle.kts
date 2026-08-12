// Taint worker: a standalone JVM process that runs Tai-e analysis.
// Built as a fat jar (shadow) so the orchestrator can spawn it with a minimal
// classpath: [DECX_HOME/tai-e/lib/*-modified.jar] + this jar.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.shadow)
}

dependencies {
    implementation(project(":decx-taint-protocol"))
    implementation("net.pascal-lab:tai-e:0.5.4")
    implementation(libs.slf4j.api)
    // Tai-e ships log4j-slf4j bindings; keep worker logging minimal.
    runtimeOnly(libs.logback.classic)
}

tasks.shadowJar {
    archiveBaseName.set("decx-taint-worker")
    archiveClassifier.set("all")
    archiveVersion.set("")
    mergeServiceFiles()
}
