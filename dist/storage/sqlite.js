import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
export class KnowledgeGraphStore {
    db;
    constructor(dbPath = 'knowledge_graph.db') {
        // V11.1: Guard for parent directory creation
        const dir = dirname(dbPath);
        if (dir !== '.' && !existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        this.db = new Database(dbPath);
        this.init();
    }
    init() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        fullName TEXT NOT NULL,
        file TEXT NOT NULL,
        startLine INTEGER,
        startColumn INTEGER,
        endLine INTEGER,
        endColumn INTEGER,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        sourceId TEXT NOT NULL,
        targetId TEXT NOT NULL,
        metadata TEXT,
        FOREIGN KEY (sourceId) REFERENCES nodes(id),
        FOREIGN KEY (targetId) REFERENCES nodes(id)
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file);
      CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(sourceId);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(targetId);

      -- V9.0: Git History Tables
      CREATE TABLE IF NOT EXISTS git_file_stats (
        file TEXT PRIMARY KEY,
        totalCommits INTEGER DEFAULT 0,
        bugFixCommits INTEGER DEFAULT 0,
        lastModified TEXT,
        churnScore REAL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS git_co_changes (
        fileA TEXT NOT NULL,
        fileB TEXT NOT NULL,
        coChangeCount INTEGER DEFAULT 0,
        confidence REAL DEFAULT 0,
        totalCommitsA INTEGER DEFAULT 0,
        totalCommitsB INTEGER DEFAULT 0,
        PRIMARY KEY (fileA, fileB)
      );
    `);
    }
    insertNode(node) {
        const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO nodes (id, type, name, fullName, file, startLine, startColumn, endLine, endColumn, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        stmt.run(node.id, node.type, node.name, node.fullName, node.file, node.startLine, node.startColumn, node.endLine, node.endColumn, node.metadata);
    }
    insertEdge(edge) {
        const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO edges (id, type, sourceId, targetId, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);
        stmt.run(edge.id, edge.type, edge.sourceId, edge.targetId, edge.metadata);
    }
    getNodesByFile(file) {
        return this.db.prepare('SELECT * FROM nodes WHERE LOWER(file) = LOWER(?)').all(file);
    }
    getCallers(targetId) {
        return this.db.prepare(`
      SELECT n.* FROM nodes n
      JOIN edges e ON n.id = e.sourceId
      WHERE e.targetId = ? AND e.type = 'calls'
    `).all(targetId);
    }
    /**
     * v1.0: Get outgoing dependencies (upstream)
     */
    getDependencies(sourceId) {
        return this.db.prepare(`
      SELECT n.* FROM nodes n
      JOIN edges e ON n.id = e.targetId
      WHERE e.sourceId = ? AND e.type = 'calls'
    `).all(sourceId);
    }
    /**
     * v1.0 Deep Callers: If the target is a class/interface, aggregate callers of its members.
     */
    getDeepCallers(nodeId) {
        const targetNode = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
        if (!targetNode)
            return [];
        if (targetNode.type === 'class' || targetNode.type === 'interface') {
            return this.db.prepare(`
        SELECT DISTINCT n.* FROM nodes n
        JOIN edges e ON n.id = e.sourceId
        JOIN nodes member ON e.targetId = member.id
        WHERE LOWER(member.file) = LOWER(?) 
        AND member.startLine >= ? AND member.endLine <= ?
        AND member.id != ?
        AND e.type = 'calls'
      `).all(targetNode.file, targetNode.startLine, targetNode.endLine, targetNode.id);
        }
        return this.getCallers(nodeId);
    }
    /**
     * V6.9 Deep Dependencies: If the source is a class/interface, aggregate dependencies of its members.
     */
    getDeepDependencies(nodeId) {
        const sourceNode = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
        if (!sourceNode)
            return [];
        if (sourceNode.type === 'class' || sourceNode.type === 'interface') {
            return this.db.prepare(`
        SELECT DISTINCT target.* FROM nodes target
        JOIN edges e ON target.id = e.targetId
        JOIN nodes member ON e.sourceId = member.id
        WHERE LOWER(member.file) = LOWER(?) 
        AND member.startLine >= ? AND member.endLine <= ?
        AND member.id != ?
        AND e.type = 'calls'
      `).all(sourceNode.file, sourceNode.startLine, sourceNode.endLine, sourceNode.id);
        }
        return this.getDependencies(nodeId);
    }
    clearFile(file) {
        this.db.prepare(`
      DELETE FROM edges WHERE sourceId IN (SELECT id FROM nodes WHERE LOWER(file) = LOWER(?))
      OR targetId IN (SELECT id FROM nodes WHERE LOWER(file) = LOWER(?))
    `).run(file, file);
        this.db.prepare('DELETE FROM nodes WHERE LOWER(file) = LOWER(?)').run(file);
    }
    getAllNodes() {
        return this.db.prepare('SELECT * FROM nodes').all();
    }
    getAllEdges() {
        return this.db.prepare('SELECT * FROM edges').all();
    }
    getNodesByName(name) {
        return this.db.prepare('SELECT * FROM nodes WHERE name = ?').all(name);
    }
    runInTransaction(fn) {
        const transaction = this.db.transaction(fn);
        transaction();
    }
    // V9.0: Git History Methods
    clearGitData() {
        this.db.exec('DELETE FROM git_file_stats');
        this.db.exec('DELETE FROM git_co_changes');
    }
    insertGitFileStats(stats) {
        this.db.prepare(`
      INSERT OR REPLACE INTO git_file_stats (file, totalCommits, bugFixCommits, lastModified, churnScore)
      VALUES (?, ?, ?, ?, ?)
    `).run(stats.file, stats.totalCommits, stats.bugFixCommits, stats.lastModified, stats.churnScore);
    }
    insertCoChange(pattern) {
        this.db.prepare(`
      INSERT OR REPLACE INTO git_co_changes (fileA, fileB, coChangeCount, confidence, totalCommitsA, totalCommitsB)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(pattern.fileA, pattern.fileB, pattern.coChangeCount, pattern.confidence, pattern.totalCommitsA, pattern.totalCommitsB);
    }
    getCoChangePartners(file, minConfidence = 0.3) {
        const normalizedFile = file.replace(/\\/g, '/').toLowerCase();
        return this.db.prepare(`
      SELECT 
        CASE WHEN LOWER(fileA) = LOWER(?) THEN fileB ELSE fileA END as partner,
        coChangeCount, confidence
      FROM git_co_changes
      WHERE LOWER(fileA) = LOWER(?) OR LOWER(fileB) = LOWER(?)
      AND confidence >= ?
      ORDER BY confidence DESC, coChangeCount DESC
    `).all(normalizedFile, normalizedFile, normalizedFile, minConfidence);
    }
    getFileChurn(topN = 20) {
        return this.db.prepare(`
      SELECT * FROM git_file_stats ORDER BY churnScore DESC LIMIT ?
    `).all(topN);
    }
    getBugHotspots(topN = 10) {
        return this.db.prepare(`
      SELECT file, totalCommits, bugFixCommits, 
        ROUND(CAST(bugFixCommits AS REAL) / CASE WHEN totalCommits = 0 THEN 1 ELSE totalCommits END, 2) as bugFixRatio
      FROM git_file_stats 
      WHERE bugFixCommits > 0
      ORDER BY bugFixRatio DESC, bugFixCommits DESC 
      LIMIT ?
    `).all(topN);
    }
    getGitFileStats(file) {
        const normalizedFile = file.replace(/\\/g, '/').toLowerCase();
        return this.db.prepare('SELECT * FROM git_file_stats WHERE LOWER(file) = LOWER(?)').get(normalizedFile) || null;
    }
    close() {
        this.db.close();
    }
}
//# sourceMappingURL=sqlite.js.map