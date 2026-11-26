/*
 * Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
 * Licensed under the PolyForm Noncommercial License 1.0.0.
 * Commercial use is prohibited without separate written authorization.
 * See LICENSE and COMMERCIAL.md in the repository root.
 */

import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.Files
import java.util.Properties
import java.util.zip.ZipInputStream
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing configuration lookup order:
// 1. Gradle property `piq.keystore.properties`
// 2. Environment variable `PIQ_KEYSTORE_PROPERTIES`
// 3. Repository root `keystore.properties` (gitignored)
// Release builds fail closed if signing credentials are missing (never falls back to debug key).
val releaseTaskPattern = Regex("(?i)(assemble|bundle|install|package|sign|validate|lintVital)\\w*[Rr]elease")
val umbrellaTasks = setOf("assemble", "build", "check")
val releaseRequested = gradle.startParameter.taskNames.any { requested ->
    val simpleName = requested.substringAfterLast(':').removeSurrounding("'\"")
    releaseTaskPattern.containsMatchIn(requested) || simpleName.lowercase() in umbrellaTasks
}

val explicitKeystoreProps: String? =
    providers.gradleProperty("piq.keystore.properties").orNull ?: System.getenv("PIQ_KEYSTORE_PROPERTIES")
val keystorePropsFile: File? = explicitKeystoreProps?.let(::File)
    ?: rootProject.file("../keystore.properties").takeIf { it.isFile }
    ?: rootProject.file("keystore.properties").takeIf { it.isFile }

if (explicitKeystoreProps != null && keystorePropsFile?.isFile != true) {
    throw GradleException(
        "Release signing properties file not found at '$explicitKeystoreProps'. " +
            "Point to a valid keystore.properties file or unset the override.",
    )
}

val keystoreProps = Properties().apply {
    keystorePropsFile?.inputStream()?.use { load(it) }
}

val keystoreFields = listOf("storeFile", "storePassword", "keyAlias", "keyPassword")
    .associateWith { keystoreProps.getProperty(it)?.trim() }

val keystoreReady = keystorePropsFile?.isFile == true &&
    keystoreFields.values.all { !it.isNullOrBlank() } &&
    File(keystoreFields["storeFile"].orEmpty()).isFile

if (releaseRequested && !keystoreReady) {
    val reasons = when {
        keystorePropsFile == null ->
            "No keystore.properties found via -Ppiq.keystore.properties, PIQ_KEYSTORE_PROPERTIES, or keystore.properties"
        !keystorePropsFile.isFile -> "keystore.properties does not exist: ${keystorePropsFile.path}"
        keystoreFields.values.any { it.isNullOrBlank() } ->
            "keystore.properties is missing required fields: " +
                keystoreFields.filterValues { it.isNullOrBlank() }.keys.joinToString(", ")
        else -> "Configured storeFile does not exist: ${keystoreFields["storeFile"]}"
    }
    throw GradleException(
        "Release build requires valid signing credentials ($reasons). " +
            "Fallback to debug signing is disabled.",
    )
}

// Guard against abbreviated Gradle release tasks (e.g. `assembleR` / `aR`).
val releaseArtifactTask = Regex("(?i)^(assemble|bundle|package|signing|validate|install|lintVital)\\w*release")
tasks.matching { releaseArtifactTask.matches(it.name) }.configureEach {
    doFirst {
        if (!keystoreReady) {
            throw GradleException(
                "Release task '${this.name}' aborted: signing credentials are not configured. " +
                    "Provide -Ppiq.keystore.properties or PIQ_KEYSTORE_PROPERTIES.",
            )
        }
    }
}

android {
    namespace = "io.github.yui0818.periodiq"
    compileSdk = 35

    signingConfigs {
        if (keystoreReady) {
            create("release") {
                storeFile = file(keystoreFields["storeFile"]!!)
                storePassword = keystoreFields["storePassword"]
                keyAlias = keystoreFields["keyAlias"]
                keyPassword = keystoreFields["keyPassword"]
            }
        }
    }

    defaultConfig {
        applicationId = "io.github.yui0818.periodiq"
        minSdk = 26
        targetSdk = 35
        versionName = "3.2.0"
        versionCode = 26
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = false
            isDebuggable = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_11)
    }
}

dependencies {
    // Local WebView asset loader only; zero network, telemetry, or analytics dependencies.
    implementation("androidx.webkit:webkit:1.14.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}

// --- Pure Gradle Frontend Asset Sync (android/frontend -> app/src/main/assets/www) ---

val dataSuffixRegex = Regex("""\.(db|db-wal|db-shm|db-journal|sqlite|sqlite3|bak)$""", RegexOption.IGNORE_CASE)
val backupKeysets = listOf(
    listOf("\"period_start\"", "\"predicted_date\"", "\"model_params\"").map { it.toByteArray(Charsets.UTF_8) },
    listOf("\"cycles\"", "\"predictions\"", "\"exported_at\"").map { it.toByteArray(Charsets.UTF_8) },
)
val backupKeysetNames = listOf(
    "period_start+predicted_date+model_params",
    "cycles+predictions+exported_at",
)

fun containsBytes(haystack: ByteArray, needle: ByteArray): Boolean {
    if (needle.isEmpty() || haystack.size < needle.size) return false
    outer@ for (i in 0..(haystack.size - needle.size)) {
        for (j in needle.indices) {
            if (haystack[i + j] != needle[j]) continue@outer
        }
        return true
    }
    return false
}

fun classifyBytes(name: String, blob: ByteArray): String? {
    if (dataSuffixRegex.containsMatchIn(name)) {
        return "data file suffix"
    }
    for (i in backupKeysets.indices) {
        if (backupKeysets[i].all { key -> containsBytes(blob, key) }) {
            return "backup keyset #${i + 1} (${backupKeysetNames[i]})"
        }
    }
    return null
}

fun scanZipContainer(containerPath: String, blob: ByteArray): List<String> {
    if (blob.size < 2 || blob[0] != 'P'.code.toByte() || blob[1] != 'K'.code.toByte()) {
        return emptyList()
    }
    val hits = mutableListOf<String>()
    try {
        ZipInputStream(ByteArrayInputStream(blob)).use { zis ->
            while (true) {
                val entry = zis.nextEntry ?: break
                if (!entry.isDirectory) {
                    val data = zis.readBytes()
                    val reason = classifyBytes(entry.name, data)
                    if (reason != null) {
                        hits.add("$containerPath!${entry.name} ($reason)")
                    }
                    if (data.size >= 2 && data[0] == 'P'.code.toByte() && data[1] == 'K'.code.toByte()) {
                        hits.addAll(scanZipContainer("$containerPath!${entry.name}", data))
                    }
                }
                zis.closeEntry()
            }
        }
    } catch (ex: Exception) {
        hits.add("$containerPath (unparsable zip container: ${ex.message})")
    }
    return hits
}

fun runPrivacyGate(scanRoots: List<File>, label: String) {
    var totalScanned = 0
    val hits = mutableListOf<String>()

    for (root in scanRoots) {
        if (!root.isDirectory) {
            logger.lifecycle("[$label] SCAN ${root.path} -> absent")
            continue
        }
        var dirScanned = 0
        root.walkTopDown().forEach { entry ->
            if (entry == root) return@forEach
            val isSymlink = Files.isSymbolicLink(entry.toPath())
            if (isSymlink) {
                dirScanned++
                hits.add("${entry.path} (symbolic link not allowed in packaged assets)")
                return@forEach
            }
            if (!entry.isFile) return@forEach
            dirScanned++
            if (dataSuffixRegex.containsMatchIn(entry.name)) {
                hits.add("${entry.path} (data file suffix)")
                return@forEach
            }
            val bytes = try {
                entry.readBytes()
            } catch (ex: Exception) {
                hits.add("${entry.path} (unreadable file: ${ex.message})")
                return@forEach
            }
            if (bytes.size >= 2 && bytes[0] == 'P'.code.toByte() && bytes[1] == 'K'.code.toByte()) {
                hits.addAll(scanZipContainer(entry.path, bytes))
            } else {
                val reason = classifyBytes(entry.name, bytes)
                if (reason != null) {
                    hits.add("${entry.path} ($reason)")
                }
            }
        }
        totalScanned += dirScanned
        logger.lifecycle("[$label] SCAN ${root.path} -> scanned=$dirScanned")
    }

    if (totalScanned == 0) {
        throw GradleException("[$label] FAIL: no files scanned across targets (${scanRoots.joinToString { it.path }}).")
    }
    if (hits.isNotEmpty()) {
        throw GradleException(
            "[$label] FAIL: detected ${hits.size} prohibited user-data artifact(s) in build outputs:\n" +
                hits.joinToString("\n") { "  - $it" },
        )
    }
    logger.lifecycle("[$label] PASS scanned=$totalScanned hits=0")
}

val syncFrontendAssets = tasks.register("syncFrontendAssets") {
    group = "build"
    description = "Syncs android/frontend into app/src/main/assets/www without external tools."
    val srcDir = rootProject.file("frontend")
    val dstDir = project.file("src/main/assets/www")
    val excludedFiles = setOf("README.md", "CONTEXT.md")
    inputs.dir(srcDir)
    outputs.dir(dstDir)

    doLast {
        if (!srcDir.isDirectory || !File(srcDir, "index.html").isFile) {
            throw GradleException("[assets/www] Source directory missing or lacks index.html: ${srcDir.path}")
        }
        val sourceFiles = srcDir.walkTopDown()
            .filter { it.isFile }
            .filter { file ->
                val rel = file.relativeTo(srcDir).invariantSeparatorsPath
                rel !in excludedFiles && !rel.startsWith("Claude_back/")
            }
            .sortedBy { it.relativeTo(srcDir).invariantSeparatorsPath }
            .toList()

        val prohibited = sourceFiles.filter { dataSuffixRegex.containsMatchIn(it.name) }
        if (prohibited.isNotEmpty()) {
            throw GradleException(
                "[assets/www] Prohibited data file(s) in frontend source:\n" +
                    prohibited.joinToString("\n") { "  - ${it.path}" },
            )
        }

        if (dstDir.exists()) {
            dstDir.deleteRecursively()
        }
        dstDir.mkdirs()

        for (srcFile in sourceFiles) {
            val rel = srcFile.relativeTo(srcDir)
            val target = File(dstDir, rel.path)
            target.parentFile.mkdirs()
            srcFile.copyTo(target, overwrite = true)
        }

        for (required in listOf("index.html", "manifest.json")) {
            if (!File(dstDir, required).isFile) {
                throw GradleException("[assets/www] Target missing required file: $required")
            }
        }
        logger.lifecycle("[assets/www] Synced ${sourceFiles.size} file(s) from android/frontend")
    }
}

val privacyGate = tasks.register("privacyGate") {
    group = "verification"
    description = "Verifies that source assets/resources contain no user databases or backup payloads."
    mustRunAfter(syncFrontendAssets)
    val targets = listOf(
        project.file("src/main/assets"),
        project.file("src/main/res"),
        project.file("build/intermediates/assets/debug"),
        project.file("build/intermediates/assets/release"),
    )
    doLast {
        runPrivacyGate(targets, "privacyGate")
    }
}

tasks.named("preBuild") {
    dependsOn(syncFrontendAssets, privacyGate)
}

val privacyGatePackaged = tasks.register("privacyGatePackaged") {
    group = "verification"
    description = "Post-packaging verification: inspects merged assets and built APKs for user data."
    val targets = listOf(
        project.file("build/intermediates/assets/debug"),
        project.file("build/intermediates/assets/release"),
        project.file("build/outputs/apk"),
    )
    doLast {
        runPrivacyGate(targets, "privacyGatePackaged")
    }
}

tasks.matching { t ->
    t.name in setOf("assembleDebug", "assembleRelease", "bundleRelease") ||
        (t.name.startsWith("package") && !t.name.endsWith("Resources") && !t.name.endsWith("Assets"))
}.configureEach {
    finalizedBy(privacyGatePackaged)
}
