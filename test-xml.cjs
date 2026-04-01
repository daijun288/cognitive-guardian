const SQLite = require('better-sqlite3');
const db = new SQLite('.guardian/graph.db');

try {
  const count = db.prepare(`SELECT COUNT(*) as c FROM edges WHERE json_extract(metadata, '$.isMyBatisLink') = 1 OR json_extract(metadata, '$.isMyBatisLink') = 'true'`).get();
  console.log('Total MyBatis Links defined:', count.c);
} catch (e) {
  console.error("Query Error:", e.message);
}
