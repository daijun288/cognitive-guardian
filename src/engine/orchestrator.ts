import { CodeParser } from './parser.js';
import type { CodeSymbol } from './parser.js';
import { LspClient } from './lsp-client.js';
import { KnowledgeGraphStore } from '../storage/sqlite.js';
import { v4 as uuidv4 } from 'uuid';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as fs from 'fs';
import * as crypto from 'crypto';

export class AnalysisOrchestrator {
  private logger: (msg: string) => void;
  private parser: CodeParser;
  private lspClient: LspClient;
  private store: KnowledgeGraphStore;
  private cachePath: string | null = null;
  private fileHashes: Map<string, string> = new Map();

  constructor(lspServerCommand: string, lspServerArgs: string[], dbPath?: string, logger?: (msg: string) => void) {
    this.logger = logger || ((msg) => console.error(`[Orchestrator] ${msg}`));
    this.parser = new CodeParser();
    this.lspClient = new LspClient(lspServerCommand, lspServerArgs);
    this.store = new KnowledgeGraphStore(dbPath);
    if (dbPath) {
      this.cachePath = join(dirname(dbPath), 'cache.json');
      this.loadCache();
    }
  }

  private log(message: string) {
    this.logger(message);
  }

  private loadCache() {
    if (this.cachePath && fs.existsSync(this.cachePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'));
        this.fileHashes = new Map(Object.entries(data));
      } catch (err) {
        this.log(`Failed to load cache: ${err}`);
      }
    }
  }

  private saveCache() {
    if (this.cachePath) {
      try {
        const dir = dirname(this.cachePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const data = Object.fromEntries(this.fileHashes);
        fs.writeFileSync(this.cachePath, JSON.stringify(data, null, 2));
      } catch (err) {
        this.log(`Failed to save cache: ${err}`);
      }
    }
  }

  private getFileHash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
  }

  public async start(rootUri: string) {
    // Bug Fix: Previously checked isLspReady() before start(), creating a deadlock.
    // LSP should always attempt to start; isReady is set internally by initialize().
    try {
      await this.lspClient.start();
      const result = await this.lspClient.initialize(rootUri);
      if (result) {
        this.log(`LSP Initialized successfully for ${rootUri}.`);
      }
    } catch (err) {
      this.log(`LSP startup/init failed: ${err}. Falling back to pure parser mode.`);
    }
    
    const rootDir = fileURLToPath(rootUri);
    this.log(`Starting scan of: ${rootDir} (Incremental Mode V10.1)`);
    const startTime = Date.now();
    
    const allFiles: string[] = [];
    await this.collectFiles(rootDir, allFiles);
    
    const CHUNK_SIZE = 50;
    let skippedCount = 0;
    let totalProcessed = 0;

    for (let i = 0; i < allFiles.length; i += CHUNK_SIZE) {
      const chunk = allFiles.slice(i, i + CHUNK_SIZE);
      const results: {file: string, symbols: any[]}[] = [];
      
      await Promise.all(chunk.map(async (file) => {
        try {
          // V10.1: Avoid fs.realpathSync on Windows to prevent sporadic EINVAL for valid paths.
          const absolutePath = file.replace(/\\/g, '/'); 
          const content = await fs.promises.readFile(absolutePath, 'utf-8');
          const currentHash = this.getFileHash(content);
          
          if (this.fileHashes.get(absolutePath) === currentHash) {
            skippedCount++;
            return;
          }

          const ext = absolutePath.substring(absolutePath.lastIndexOf('.'));
          const symbols = this.parser.extractSymbols(content, ext);
          results.push({ file: absolutePath, symbols });
          this.fileHashes.set(absolutePath, currentHash);
        } catch (err) {
          this.log(`Critical Error reading ${file}: ${err instanceof Error ? err.message : err}. Skipping.`);
        }
      }));

      if (results.length > 0) {
        totalProcessed += results.length;
        this.store.runInTransaction(() => {
          for (const res of results) {
            this.store.clearFile(res.file);
            for (const s of res.symbols) {
              this.store.insertNode({
                id: uuidv4(),
                type: s.type,
                name: s.name,
                fullName: `${res.file}/${s.name}`,
                file: res.file,
                startLine: s.startLine,
                startColumn: s.startColumn,
                endLine: s.endLine,
                endColumn: s.endColumn,
                metadata: JSON.stringify(s.metadata || {}),
              });
            }
          }
        });
      }
    }

    if (skippedCount > 0) {
      this.log(`Incremental update: skipped ${skippedCount} unchanged files.`);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    this.log(`Scan complete. Processed ${totalProcessed}/${allFiles.length} files in ${duration}s.`);
    
    if (totalProcessed > 0 || skippedCount === 0) {
        this.saveCache();
        this.log('Starting global symbol linking (Topology Stitching)...');
        await this.linkSymbols(rootDir);
        this.log('Symbol linking complete.');
    }
  }

  private async linkSymbols(rootDir: string) {
    const allNodes = this.store.getAllNodes();
    
    // --- Performance: Pre-build lookup indexes (O(N) once, then O(1) lookups) ---
    const nodesByName = new Map<string, typeof allNodes>();
    const interfacesByFqn = new Map<string, typeof allNodes[0]>();
    const methodsByFile = new Map<string, typeof allNodes>();
    const parsedMeta = new Map<string, Record<string, any>>();

    for (const node of allNodes) {
      const list = nodesByName.get(node.name);
      if (list) list.push(node);
      else nodesByName.set(node.name, [node]);

      if (node.type === 'method' || node.type === 'function') {
        const fileList = methodsByFile.get(node.file);
        if (fileList) fileList.push(node);
        else methodsByFile.set(node.file, [node]);
      }

      let meta: Record<string, any> = {};
      try { meta = JSON.parse(node.metadata || '{}'); } catch {}
      parsedMeta.set(node.id, meta);

      if (node.type === 'interface' && meta.fqn) {
        interfacesByFqn.set(meta.fqn, node);
      }
    }

    // Phase 5: 使用 SQLite json_extract 原生过滤，避免 JS 端全量遍历
    const xmlSqlNodes = this.store.getNodesByJsonFlag('isMyBatisSql');
    const potentialCalls = this.store.getNodesByJsonFlag('isCall');
    const frontendApiNodes = this.store.getNodesByJsonFlag('isFrontendApi');
    const backendEndpointNodes = this.store.getNodesByJsonFlag('isRestEndpoint');

    // 1. MyBatis Linkage (Mapper Interface -> XML SQL)

    // 辅助：安全获取 metadata（防御 json_extract 返回的节点不在 parsedMeta 缓存中的情况）
    const getMeta = (nodeId: string, rawMetadata?: string): Record<string, any> => {
      const cached = parsedMeta.get(nodeId);
      if (cached) return cached;
      try { return JSON.parse(rawMetadata || '{}'); } catch { return {}; }
    };

    this.log(`Linking ${xmlSqlNodes.length} MyBatis SQL nodes...`);
    this.store.runInTransaction(() => {
      for (const xmlNode of xmlSqlNodes) {
        const meta = getMeta(xmlNode.id, xmlNode.metadata);
        const namespace = meta.namespace;
        if (!namespace) continue;

        const mapperInterface = interfacesByFqn.get(namespace);
        if (!mapperInterface) continue;

        const fileMethods = methodsByFile.get(mapperInterface.file) || [];
        const mapperMethod = fileMethods.find(n => n.name === xmlNode.name);

        if (mapperMethod) {
          this.store.insertEdge({
            id: uuidv4(),
            type: 'calls',
            sourceId: mapperMethod.id,
            targetId: xmlNode.id,
            metadata: JSON.stringify({ isMyBatisLink: true })
          });

          const resultMap = meta.resultMap;
          if (resultMap) {
            const rmCandidates = nodesByName.get(resultMap) || [];
            const rmNode = rmCandidates.find(n => n.file === xmlNode.file);
            if (rmNode) {
              this.store.insertEdge({
                id: uuidv4(),
                type: 'data_flow',
                sourceId: xmlNode.id,
                targetId: rmNode.id,
                metadata: JSON.stringify({ isResultMapLink: true })
              });
            }
          }
        }
      }
    });

    // 2. Fuzzy Linking (Topology Stitching)

    this.log(`Fuzzy linking ${potentialCalls.length} call sites...`);
    this.store.runInTransaction(() => {
      for (const callNode of potentialCalls) {
        const fileMethods = methodsByFile.get(callNode.file) || [];
        const caller = fileMethods.find(n =>
          n.startLine <= callNode.startLine &&
          n.endLine >= callNode.endLine &&
          n.id !== callNode.id
        );

        if (!caller) continue;

        const targets = (nodesByName.get(callNode.name) || []).filter(t =>
          (t.type === 'method' || t.type === 'function' || t.type === 'interface') && t.id !== caller.id
        );

        for (const target of targets) {
          this.store.insertEdge({
            id: uuidv4(),
            type: 'calls',
            sourceId: caller.id,
            targetId: target.id,
            metadata: JSON.stringify({ isFuzzy: true })
          });
        }
      }
    });

    // 3. Cross-Stack Linkage (Frontend API -> Backend REST Endpoint)

    // Pre-index backend endpoints by normalized path for O(1) lookup
    const backendByPath = new Map<string, typeof allNodes>();
    for (const bn of backendEndpointNodes) {
      const bMeta = getMeta(bn.id, bn.metadata);
      const bPath = '/' + (bMeta.apiPath || '').replace(/^\/+|\/+$/g, '');
      const bMethod = (bMeta.httpMethod || 'GET').toUpperCase();
      const key = `${bMethod}:${bPath}`;
      const allKey = `ALL:${bPath}`;
      for (const k of [key, allKey]) {
        const bList = backendByPath.get(k);
        if (bList) bList.push(bn);
        else backendByPath.set(k, [bn]);
      }
    }

    this.log(`Linking ${frontendApiNodes.length} APIs to ${backendEndpointNodes.length} backend endpoints...`);
    this.store.runInTransaction(() => {
      for (const frontendNode of frontendApiNodes) {
        const fMeta = getMeta(frontendNode.id, frontendNode.metadata);
        const fPath = '/' + (fMeta.apiPath || '').replace(/^\/+|\/+$/g, '');
        if (fPath === '/') continue;
        const fMethod = (fMeta.httpMethod || 'GET').toUpperCase();
        const key = `${fMethod}:${fPath}`;

        const matches = backendByPath.get(key) || [];
        for (const backendNode of matches) {
          this.store.insertEdge({
            id: uuidv4(),
            type: 'calls',
            sourceId: frontendNode.id,
            targetId: backendNode.id,
            metadata: JSON.stringify({ isCrossStack: true })
          });
        }
      }
    });
  }



  private async collectFiles(dir: string, fileList: string[]) {
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'target', '.guardian', 'build', '.idea', '.vscode']);
    const CODE_EXTS = new Set(['.ts', '.tsx', '.java', '.js', '.vue', '.xml']);
    
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const subDirPromises: Promise<void>[] = [];
      
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          // 并行递归子目录
          subDirPromises.push(this.collectFiles(fullPath, fileList));
        } else {
          const ext = entry.name.substring(entry.name.lastIndexOf('.')).toLowerCase();
          if (CODE_EXTS.has(ext)) {
            fileList.push(fullPath);
          }
        }
      }
      
      // 等待所有子目录并行扫描完成
      await Promise.all(subDirPromises);
    } catch (e) {
      this.log(`Error collecting files in ${dir}: ${e}`);
    }
  }

  public async analyzeFile(filePath: string, sourceCode?: string) {
    const ext = filePath.substring(filePath.lastIndexOf('.'));
    this.log(`Analyzing file: ${filePath}`);

    let content = sourceCode || "";
    if (!content) {
      try {
        const stats = fs.statSync(filePath);
        if (stats.isDirectory()) {
          this.log(`Skipping directory: ${filePath}`);
          return;
        }
        content = fs.readFileSync(filePath, 'utf-8');
      } catch (err: any) {
        this.log(`Failed to read file for analysis (${err.code || 'ERROR'}): ${filePath}`);
        return;
      }
    }
    
    const uri = `file:///${filePath.replace(/\\/g, '/')}`;
    if ((ext === '.ts' || ext === '.tsx' || ext === '.js') && this.lspClient.isLspReady()) {
      try {
        await this.lspClient.didOpen(uri, 'typescript', 1, content);
      } catch (err) {
        this.log(`LSP didOpen failed: ${err}`);
      }
    }

    const symbols = this.parser.extractSymbols(content, ext);
    const symbolToNodeId = new Map<CodeSymbol, string>();
    this.store.runInTransaction(() => {
      this.store.clearFile(filePath);
      for (const symbol of symbols) {
        const nodeId = uuidv4();
        symbolToNodeId.set(symbol, nodeId);
        this.store.insertNode({
          id: nodeId,
          type: symbol.type,
          name: symbol.name,
          fullName: `${filePath}/${symbol.name}`,
          file: filePath,
          startLine: symbol.startLine,
          startColumn: symbol.startColumn,
          endLine: symbol.endLine,
          endColumn: symbol.endColumn,
          metadata: JSON.stringify(symbol.metadata || {}),
        });
      }
    });

    const edgesToInsert: {sourceId: string, targetId: string}[] = [];
    
    // Phase 4: 并发化 LSP 引用检索 —— 所有符号的请求同时发射，不再串行等待
    if (this.lspClient.isLspReady()) {
      const lspTasks = symbols
        .filter(s => s.type === 'function' || s.type === 'method')
        .map(async (symbol) => {
          const nodeId = symbolToNodeId.get(symbol)!;
          try {
            const refs = await this.lspClient.getReferences(uri, symbol.startLine - 1, symbol.startColumn);
            if (refs) {
              for (const ref of refs) {
                const refFilePath = fileURLToPath(ref.uri);
                const refNodes = this.store.getNodesByFile(refFilePath);
                const callerNode = refNodes.find(n => 
                  n.startLine <= ref.range.start.line + 1 && n.endLine >= ref.range.end.line + 1
                );
                if (callerNode) edgesToInsert.push({ sourceId: callerNode.id, targetId: nodeId });
              }
            }
          } catch (err) {
            // 单个符号的 LSP 查询失败不影响整体
          }
        });
      
      await Promise.allSettled(lspTasks);
    }

    if (edgesToInsert.length > 0) {
      this.store.runInTransaction(() => {
        for (const edge of edgesToInsert) {
          this.store.insertEdge({
            id: uuidv4(),
            type: 'calls',
            sourceId: edge.sourceId,
            targetId: edge.targetId,
          });
        }
      });
    }

    // V16.0: Lite Linking for the current file to support zero-init sessions
    await this.linkFileSymbols(filePath);
  }

  private async linkFileSymbols(filePath: string) {
     const nodes = this.store.getNodesByFile(filePath);
     
     // 获取该文件的协同修改伙伴，用于权重补偿
     const partners = this.store.getCoChangePartners(filePath, 0.2);
     const partnerFiles = new Set(partners.map(p => p.partner));

     this.store.runInTransaction(() => {
        for (const node of nodes) {
           const meta = JSON.parse(node.metadata || '{}');
           // 识别调用或引用
           if (node.type === 'function' || node.type === 'method' || node.type === 'ref' || meta.isCall) {
              // 查找匹配的方法或函数定义，改为利用 SQLite name 字段的 B-Tree 索引 O(1) 直达
              const targets = this.store.getNodesByName(node.name).filter(t => 
                t.id !== node.id && 
                (t.type === 'function' || t.type === 'method' || t.type === 'class' || t.type === 'interface')
              );

              for (const target of targets) {
                  // V17.0: 联动准确度提升 —— 如果目标文件在 Git 协同修改记录中，给予高置信度
                  const isHighConfidence = partnerFiles.has(target.file);
                  this.store.insertEdge({
                    id: uuidv4(),
                    type: 'calls',
                    sourceId: node.id,
                    targetId: target.id,
                    metadata: JSON.stringify({ 
                      isIncremental: true, 
                      confidence: isHighConfidence ? 0.9 : 0.6,
                      source: 'v17_fuzzy_linker'
                    })
                  });
              }
           }
        }
     });
  }

  public async removeFile(filePath: string) {
    this.log(`Removing file from graph: ${filePath}`);
    this.store.runInTransaction(() => {
      this.store.clearFile(filePath);
    });
  }

  public async stop() {
    this.lspClient.stop();
    this.store.close();
  }
}
