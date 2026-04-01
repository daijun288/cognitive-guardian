import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';

export interface Node {
  id: string;
  type: string;
  name: string;
  fullName: string;
  file: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  metadata?: string;
}

export interface Edge {
  id: string;
  type: string;
  sourceId: string;
  targetId: string;
  metadata?: string;
}
export class KnowledgeGraphStore {
  private db!: Database.Database;

  constructor(dbPath: string = 'knowledge_graph.db') {
    // V11.1: Guard for parent directory creation
    const dir = dirname(dbPath);
    if (dir !== '.' && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.init();
  }

  // Phase 5: 预编译热路径 SQL 语句 —— 消除每次 insert 时的重复 prepare 开销
  private stmtInsertNode!: Database.Statement;
  private stmtInsertEdge!: Database.Statement;

  private init() {
    // Phase 5: 启用 WAL 模式 —— 支持并发读写，写入吞吐提升 5-10 倍
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    
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

    // 预编译高频 SQL —— 整个生命周期只编译一次
    this.stmtInsertNode = this.db.prepare(`
      INSERT OR REPLACE INTO nodes (id, type, name, fullName, file, startLine, startColumn, endLine, endColumn, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtInsertEdge = this.db.prepare(`
      INSERT OR REPLACE INTO edges (id, type, sourceId, targetId, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);
  }

  public insertNode(node: Node) {
    this.stmtInsertNode.run(node.id, node.type, node.name, node.fullName, node.file, node.startLine, node.startColumn, node.endLine, node.endColumn, node.metadata);
  }

  public insertEdge(edge: Edge) {
    this.stmtInsertEdge.run(edge.id, edge.type, edge.sourceId, edge.targetId, edge.metadata);
  }

  public getNodesByFile(file: string): Node[] {
    return this.db.prepare('SELECT * FROM nodes WHERE LOWER(file) = LOWER(?)').all(file) as Node[];
  }

  public getCallers(targetId: string): Node[] {
    return this.db.prepare(`
      SELECT n.* FROM nodes n
      JOIN edges e ON n.id = e.sourceId
      WHERE e.targetId = ? AND e.type = 'calls'
    `).all(targetId) as Node[];
  }

  /**
   * v1.0: Get outgoing dependencies (upstream)
   */
  public getDependencies(sourceId: string): Node[] {
    return this.db.prepare(`
      SELECT n.* FROM nodes n
      JOIN edges e ON n.id = e.targetId
      WHERE e.sourceId = ? AND e.type = 'calls'
    `).all(sourceId) as Node[];
  }

  /**
   * v1.0 Deep Callers: If the target is a class/interface, aggregate callers of its members.
   */
  public getDeepCallers(nodeId: string): Node[] {
    const targetNode = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId) as Node | undefined;
    if (!targetNode) return [];

    if (targetNode.type === 'class' || targetNode.type === 'interface') {
      return this.db.prepare(`
        SELECT DISTINCT n.* FROM nodes n
        JOIN edges e ON n.id = e.sourceId
        JOIN nodes member ON e.targetId = member.id
        WHERE LOWER(member.file) = LOWER(?) 
        AND member.startLine >= ? AND member.endLine <= ?
        AND member.id != ?
        AND e.type = 'calls'
      `).all(targetNode.file, targetNode.startLine, targetNode.endLine, targetNode.id) as Node[];
    }

    return this.getCallers(nodeId);
  }

  // --- Phase 6: Subtraction Strategy (Smart Pruning Engine) ---

  /**
   * 1. find_xml_mapping: Precision mapping for MyBatis XMLs
   */
  public getXmlMappingsForClass(className: string): Node[] {
    return this.db.prepare(`
      SELECT DISTINCT target.* 
      FROM nodes target
      JOIN edges e ON target.id = e.targetId
      JOIN nodes source ON e.sourceId = source.id
      WHERE source.type IN ('class', 'interface', 'method')
      AND source.file LIKE ?
      AND json_extract(e.metadata, '$.isMyBatisLink') = true
    `).all(`%${className}%`) as Node[];
  }

  /**
   * 2. find_frontend_api_calls: Find Cross-Stack dependencies (Vue -> Java API)
   */
  public getFrontendCallsForApi(apiNameOrPath: string): Node[] {
    const searchPattern = `%${apiNameOrPath}%`;
    return this.db.prepare(`
      SELECT DISTINCT frontend.* 
      FROM nodes frontend
      JOIN edges e ON frontend.id = e.sourceId
      JOIN nodes backend ON e.targetId = backend.id
      WHERE json_extract(e.metadata, '$.isCrossStack') = true
      AND (backend.name LIKE ? OR json_extract(backend.metadata, '$.apiPath') LIKE ?)
    `).all(searchPattern, searchPattern) as Node[];
  }

  /**
   * 3. find_cross_module_deps: Cross-boundary API usages
   */
  public getCrossModuleCallers(className: string): Node[] {
    const classNodes = this.db.prepare(`SELECT * FROM nodes WHERE type IN ('class', 'interface', 'enum') AND name = ?`).all(className) as Node[];
    if (classNodes.length === 0) return [];
    
    const results: Node[] = [];
    const seen = new Set<string>();

    const stmt = this.db.prepare(`
      SELECT DISTINCT caller.* 
      FROM nodes caller
      JOIN edges e ON caller.id = e.sourceId
      JOIN nodes target ON e.targetId = target.id
      WHERE target.file = ?
      AND e.type IN ('calls', 'data_flow')
      AND caller.file != ?
    `);

    for (const cn of classNodes) {
      const targetDir = cn.file.substring(0, cn.file.lastIndexOf('/'));
      const callers = stmt.all(cn.file, cn.file) as Node[];
      
      for (const caller of callers) {
        if (seen.has(caller.id)) continue;
        const callerDir = caller.file.substring(0, caller.file.lastIndexOf('/'));
        // strictly filter out same folder (cross-boundary only)
        if (callerDir !== targetDir) {
          seen.add(caller.id);
          results.push(caller);
        }
      }
    }
    return results;
  }

  /**
   * V6.9 Deep Dependencies: If the source is a class/interface, aggregate dependencies of its members.
   */
  public getDeepDependencies(nodeId: string): Node[] {
    const sourceNode = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId) as Node | undefined;
    if (!sourceNode) return [];

    if (sourceNode.type === 'class' || sourceNode.type === 'interface') {
      return this.db.prepare(`
        SELECT DISTINCT target.* FROM nodes target
        JOIN edges e ON target.id = e.targetId
        JOIN nodes member ON e.sourceId = member.id
        WHERE LOWER(member.file) = LOWER(?) 
        AND member.startLine >= ? AND member.endLine <= ?
        AND member.id != ?
        AND e.type = 'calls'
      `).all(sourceNode.file, sourceNode.startLine, sourceNode.endLine, sourceNode.id) as Node[];
    }

    return this.getDependencies(nodeId);
  }

  public clearFile(file: string) {
    this.db.prepare(`
      DELETE FROM edges WHERE sourceId IN (SELECT id FROM nodes WHERE LOWER(file) = LOWER(?))
      OR targetId IN (SELECT id FROM nodes WHERE LOWER(file) = LOWER(?))
    `).run(file, file);
    this.db.prepare('DELETE FROM nodes WHERE LOWER(file) = LOWER(?)').run(file);
  }

  public getAllNodes(): Node[] {
    return this.db.prepare('SELECT * FROM nodes').all() as Node[];
  }

  public getAllEdges(): Edge[] {
    return this.db.prepare('SELECT * FROM edges').all() as Edge[];
  }

  public getNodesByName(name: string): Node[] {
    return this.db.prepare('SELECT * FROM nodes WHERE name = ?').all(name) as Node[];
  }

  public getFilesBySuffix(suffix: string): string[] {
    // Uses SQLite LIKE for efficient suffix matching, distinct avoids flooding memory
    const rows = this.db.prepare(`
      SELECT DISTINCT file FROM nodes 
      WHERE file LIKE ? OR file = ?
    `).all(`%/${suffix}`, suffix) as { file: string }[];
    return rows.map(r => r.file);
  }

  public getNodesByJsonFlag(flagPath: string): Node[] {
    // IDEA Stub-like json_extract lookup for highly efficient metadata matching
    return this.db.prepare(`
      SELECT * FROM nodes 
      WHERE json_extract(metadata, ?) = 1 
         OR json_extract(metadata, ?) = 'true'
    `).all(`$.${flagPath}`, `$.${flagPath}`) as Node[];
  }

  public runInTransaction(fn: () => void) {
    const transaction = this.db.transaction(fn);
    transaction();
  }

  // V9.0: Git History Methods
  public clearGitData() {
    this.db.exec('DELETE FROM git_file_stats');
    this.db.exec('DELETE FROM git_co_changes');
  }

  public insertGitFileStats(stats: { file: string; totalCommits: number; bugFixCommits: number; lastModified: string; churnScore: number }) {
    this.db.prepare(`
      INSERT OR REPLACE INTO git_file_stats (file, totalCommits, bugFixCommits, lastModified, churnScore)
      VALUES (?, ?, ?, ?, ?)
    `).run(stats.file, stats.totalCommits, stats.bugFixCommits, stats.lastModified, stats.churnScore);
  }

  public insertCoChange(pattern: { fileA: string; fileB: string; coChangeCount: number; confidence: number; totalCommitsA: number; totalCommitsB: number }) {
    this.db.prepare(`
      INSERT OR REPLACE INTO git_co_changes (fileA, fileB, coChangeCount, confidence, totalCommitsA, totalCommitsB)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(pattern.fileA, pattern.fileB, pattern.coChangeCount, pattern.confidence, pattern.totalCommitsA, pattern.totalCommitsB);
  }

  public getCoChangePartners(file: string, minConfidence: number = 0.3): { partner: string; coChangeCount: number; confidence: number }[] {
    const normalizedFile = file.replace(/\\/g, '/').toLowerCase();
    return this.db.prepare(`
      SELECT 
        CASE WHEN LOWER(fileA) = LOWER(?) THEN fileB ELSE fileA END as partner,
        coChangeCount, confidence
      FROM git_co_changes
      WHERE (LOWER(fileA) = LOWER(?) OR LOWER(fileB) = LOWER(?))
      AND confidence >= ?
      ORDER BY confidence DESC, coChangeCount DESC
    `).all(normalizedFile, normalizedFile, normalizedFile, minConfidence) as { partner: string; coChangeCount: number; confidence: number }[];
  }

  public getFileChurn(topN: number = 20): { file: string; totalCommits: number; bugFixCommits: number; lastModified: string; churnScore: number }[] {
    return this.db.prepare(`
      SELECT * FROM git_file_stats ORDER BY churnScore DESC LIMIT ?
    `).all(topN) as any[];
  }

  public getBugHotspots(topN: number = 10): { file: string; totalCommits: number; bugFixCommits: number; bugFixRatio: number }[] {
    return this.db.prepare(`
      SELECT file, totalCommits, bugFixCommits, 
        ROUND(CAST(bugFixCommits AS REAL) / CASE WHEN totalCommits = 0 THEN 1 ELSE totalCommits END, 2) as bugFixRatio
      FROM git_file_stats 
      WHERE bugFixCommits > 0
      ORDER BY bugFixRatio DESC, bugFixCommits DESC 
      LIMIT ?
    `).all(topN) as any[];
  }

  public getGitFileStats(file: string): { file: string; totalCommits: number; bugFixCommits: number; lastModified: string; churnScore: number } | null {
    const normalizedFile = file.replace(/\\/g, '/').toLowerCase();
    return this.db.prepare('SELECT * FROM git_file_stats WHERE LOWER(file) = LOWER(?)').get(normalizedFile) as any || null;
  }

  public close() {
    this.db.close();
  }
}
