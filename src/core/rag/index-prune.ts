import type Database from 'better-sqlite3';

/**
 * Removes files outside discovery with one FTS scan and one atomic cascade.
 * The FTS delete trigger is restored by SQLite rollback if any step fails.
 *
 * @param db - Writable index connection holding the writer lease.
 * @param paths - Registry paths absent from the current discovery scope.
 */
export function pruneObsoleteIndexPaths(db: Database.Database, paths: readonly string[]): void {
  if (paths.length === 0) return;
  const deleteTrigger = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'code_chunks_fts_delete'",
  ).get() as { sql: string } | undefined;
  const hasFts = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'code_chunks_fts'",
  ).get() !== undefined;
  db.transaction(() => {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS obsolete_index_paths (path TEXT PRIMARY KEY)');
    db.exec('DELETE FROM temp.obsolete_index_paths');
    const insertPath = db.prepare('INSERT INTO temp.obsolete_index_paths (path) VALUES (?)');
    for (const filePath of paths) insertPath.run(filePath);

    if (deleteTrigger !== undefined) db.exec('DROP TRIGGER code_chunks_fts_delete');
    if (hasFts) {
      // The old trigger scans FTS once for every cascading chunk. Select all
      // matching rowids in one scan before deleting their source rows.
      db.prepare(`
        DELETE FROM code_chunks_fts WHERE rowid IN (
          SELECT f.rowid FROM code_chunks_fts f
          JOIN code_chunks c ON c.id = f.chunk_id
          JOIN temp.obsolete_index_paths o ON o.path = c.file_path
        )
      `).run();
    }
    db.prepare('DELETE FROM file_registry WHERE path IN (SELECT path FROM temp.obsolete_index_paths)').run();
    if (deleteTrigger !== undefined) db.exec(deleteTrigger.sql);
    db.exec('DROP TABLE temp.obsolete_index_paths');
  })();
}
