package online.alarabiya.superapp.core.navigation

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import kotlin.text.Charsets
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeNavigationSecurityTest {
    @Test
    fun `native application contains no embedded browser implementation`() {
        val nativeRoot = findNativeRoot()
        val inspectedFiles = buildList {
            val mainRoot = nativeRoot.resolve("app/src/main")
            Files.walk(mainRoot).use { paths ->
                paths.filter(Files::isRegularFile)
                    .filter { it.toString().endsWith(".kt") || it.toString().endsWith(".xml") }
                    .forEach(::add)
            }
            add(nativeRoot.resolve("app/build.gradle.kts"))
        }
        val forbidden = listOf(
            "android.webkit.WebView",
            "androidx.webkit",
            "androidx.browser",
            "TrustedWebActivity",
            "CustomTabsIntent",
        )

        forbidden.forEach { token ->
            val offenders = inspectedFiles.filter { readUtf8(it).contains(token) }
            assertTrue("Forbidden browser primitive '$token' found in $offenders", offenders.isEmpty())
        }
    }

    @Test
    fun `navigation contract contains neither web locations nor legacy web routes`() {
        val navigationRoot = findNativeRoot().resolve(
            "app/src/main/java/online/alarabiya/superapp/core/navigation",
        )
        val files = Files.walk(navigationRoot).use { paths ->
            paths.filter(Files::isRegularFile).toList()
        }
        val source = files.joinToString(separator = "\n") { readUtf8(it) }

        assertFalse(source.contains("http" + "://", ignoreCase = true))
        assertFalse(source.contains("https" + "://", ignoreCase = true))
        assertFalse(Regex("""\b(route|webRoute|path)\s*:\s*String\b""").containsMatchIn(source))
    }

    private fun findNativeRoot(): Path {
        var cursor = Paths.get(System.getProperty("user.dir")).toAbsolutePath()
        repeat(8) {
            if (Files.isDirectory(cursor.resolve("app/src/main"))) return cursor
            if (Files.isDirectory(cursor.resolve("android-native/app/src/main"))) {
                return cursor.resolve("android-native")
            }
            cursor = cursor.parent ?: return@repeat
        }
        error("Could not locate android-native from ${System.getProperty("user.dir")}")
    }

    private fun readUtf8(path: Path): String =
        String(Files.readAllBytes(path), Charsets.UTF_8)
}
