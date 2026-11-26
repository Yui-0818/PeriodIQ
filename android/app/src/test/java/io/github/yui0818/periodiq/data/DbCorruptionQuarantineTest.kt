package io.github.yui0818.periodiq.data

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * DB 损坏保底（P0）的纯函数单测：钉住"改名为 `*.corrupt-<时间戳>`、与原文件同目录、
 * 重名追加序号、WAL/SHM 各自保底"这四条不变量。设备侧的重命名与提示由 Round 3 的
 * dd 覆写复测覆盖（证据在 %TEMP%），这里只钉住可纯函数化的判据。
 */
class DbCorruptionQuarantineTest {

    private val dir = File(File("files"), "data")

    @Test
    fun `主库保底名带时间戳且与原文件同目录`() {
        val target = corruptBackupTarget(File(dir, "app.db"), "20261120_120000")
        assertEquals("app.db.corrupt-20261120_120000", target.name)
        assertEquals(dir.absolutePath, target.parentFile?.absolutePath)
    }

    @Test
    fun `WAL 与 SHM 各自保底且不与主库名冲突`() {
        val wal = corruptBackupTarget(File(dir, "app.db-wal"), "20261120_120000")
        val shm = corruptBackupTarget(File(dir, "app.db-shm"), "20261120_120000")
        assertEquals("app.db-wal.corrupt-20261120_120000", wal.name)
        assertEquals("app.db-shm.corrupt-20261120_120000", shm.name)
        assertNotEquals(wal.name, corruptBackupTarget(File(dir, "app.db"), "20261120_120000").name)
    }

    @Test
    fun `同一秒重复保底时序号递增且每个名字都不同`() {
        val db = File(dir, "app.db")
        val names = (0..2).map { corruptBackupTarget(db, "20261120_120000", it).name }
        assertEquals(
            listOf(
                "app.db.corrupt-20261120_120000",
                "app.db.corrupt-20261120_120000-1",
                "app.db.corrupt-20261120_120000-2",
            ),
            names,
        )
        assertEquals(3, names.toSet().size)
    }
}
