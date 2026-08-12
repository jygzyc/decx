// PoC module: verify Tai-e can run in decx's JVM 17 / Gradle environment.
// Disposable — remove this module + the settings.gradle.kts line to clean up.
plugins {
    alias(libs.plugins.kotlin.jvm)
    application
}

dependencies {
    // Tai-e's modified Soot/FlowDroid patches MUST precede the stock jars
    // on the classpath, otherwise Android mode throws NoSuchMethodError on
    // LayoutFileParser.<init>(String,String,ARSCFileParser).
    implementation(files("lib/sootclasses-modified.jar", "lib/flowdroidclasses-modified.jar"))
    implementation("net.pascal-lab:tai-e:0.5.4")
    implementation(libs.slf4j.api)
    implementation(libs.logback.classic)
}

application {
    mainClass.set("decx.taint.poc.TaintPoCKt")
}

tasks.withType<JavaExec> {
    // Tai-e is memory-hungry on large apps; for PoC we cap generously.
    jvmArgs("-Xmx4g")
}
