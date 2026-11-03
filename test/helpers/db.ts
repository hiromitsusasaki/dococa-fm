/** Children first so D1's foreign keys hold; any table not listed here is cleared afterwards. */
const DELETE_FIRST = ["reports", "takedowns", "episodes", "history", "letters", "items", "listeners"];

/** Storage is shared by all tests in a file, so each test starts from empty tables. */
export async function resetDb(db: D1Database): Promise<void> {
  const { results } = await db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'd1\\_%' ESCAPE '\\'
         AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
         AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`,
    )
    .all<{ name: string }>();
  const existing = new Set(results.map((r) => r.name));
  const ordered = [...DELETE_FIRST.filter((t) => existing.has(t)), ...[...existing].filter((t) => !DELETE_FIRST.includes(t))];
  await db.batch(ordered.map((t) => db.prepare(`DELETE FROM "${t}"`)));
}
