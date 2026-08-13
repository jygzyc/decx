// DECX taint-analysis extension.
//
// Implements the decx-core DecxExtension SPI: decx-core itself has no taint
// code; taint routes and MCP tools only exist when this module is on the
// classpath (ServiceLoader discovery via
// META-INF/services/jadx.plugins.decx.extension.DecxExtension).
// The engine runs in a separate Tai-e worker process (see decx-taint-worker).
plugins {
    alias(libs.plugins.kotlin.jvm)
}

dependencies {
    implementation(project(":decx-core"))
    implementation(project(":decx-taint-protocol"))
    implementation(libs.gson)
    implementation(libs.jackson.databind)
    implementation(libs.jackson.dataformat.yaml)
    implementation(libs.jackson.module.kotlin)
    compileOnly(libs.slf4j.api)

    testImplementation(platform("org.junit:junit-bom:${libs.versions.junit.get()}"))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testImplementation(libs.assertj.core)
    testImplementation(libs.mockito.core)
    testImplementation(libs.mockito.kotlin)
}
