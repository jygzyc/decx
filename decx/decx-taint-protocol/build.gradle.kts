// Shared wire protocol between the DECX server orchestrator and the taint
// worker process. Pure Kotlin + Gson; no jadx / Tai-e dependencies so both
// sides can depend on it safely.
plugins {
    alias(libs.plugins.kotlin.jvm)
}

dependencies {
    implementation(libs.gson)

    testImplementation(platform("org.junit:junit-bom:${libs.versions.junit.get()}"))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testImplementation(libs.assertj.core)
}
