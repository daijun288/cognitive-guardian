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
    if (this.lspClient.isLspReady()) {
      await this.lspClient.start();
      try {
        const result = await this.lspClient.initialize(rootUri);
        if (result) {
          this.log(`LSP Initialized successfully for ${rootUri}.`);
        }
      } catch (err) {
        this.log(`LSP error during initialization: ${err}. Falling back to symbol mode.`);
      }
    }
    
    const rootDir = fileURLToPath(rootUri);
    this.log(`Starting scan of: ${rootDir} (Incremental Mode V10.1)`);
    const startTime = Date.now();
    
    const allFiles: string[] = [];
    this.collectFiles(rootDir, allFiles);
    
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
    
    // 1. MyBatis Linkage (Mapper Interface -> XML SQL)
    const xmlSqlNodes = allNodes.filter(n => {
      try {
        return JSON.parse(n.metadata || '{}').isMyBatisSql === true;
      } catch { return false; }
    });

    this.log(`Linking ${xmlSqlNodes.length} MyBatis SQL nodes...`);
    this.store.runInTransaction(() => {
      for (const xmlNode of xmlSqlNodes) {
        const meta = JSON.parse(xmlNode.metadata || '{}');
        const namespace = meta.namespace;
        if (!namespace) continue;

        const mapperInterface = allNodes.find(n => {
          if (n.type !== 'interface') return false;
          try {
            return JSON.parse(n.metadata || '{}').fqn === namespace;
          } catch { return false; }
        });

        if (mapperInterface) {
          const mapperMethod = allNodes.find(n => 
            n.type === 'method' && n.file === mapperInterface.file && n.name === xmlNode.name
          );

          if (mapperMethod) {
            this.store.insertEdge({
              id: uuidv4(),
              type: 'calls',
              sourceId: mapperMethod.id,
              targetId: xmlNode.id,
              metadata: JSON.stringify({ isMyBatisLink: true })
            });

            // V13.0: Link SQL to ResultMap/Target Entity
            const resultMap = meta.resultMap;
            if (resultMap) {
               const rmNode = allNodes.find(n => n.name === resultMap && n.file === xmlNode.file);
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
      }
    });

    // 2. Fuzzy Linking (Topology Stitching)
    const potentialCalls = allNodes.filter(n => {
      try {
        const meta = JSON.parse(n.metadata || '{}');
        return meta.isCall === true;
      } catch { return false; }
    });

    this.log(`Fuzzy linking ${potentialCalls.length} call sites...`);
    this.store.runInTransaction(() => {
      for (const callNode of potentialCalls) {
        const caller = allNodes.find(n => 
          (n.type === 'method' || n.type === 'function') &&
          n.file === callNode.file &&
          n.startLine <= callNode.startLine &&
          n.endLine >= callNode.endLine &&
          n.id !== callNode.id
        );

        if (!caller) continue;

        const targets = this.store.getNodesByName(callNode.name).filter(t => 
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
    const frontendApiNodes = allNodes.filter(n => {
      try { return JSON.parse(n.metadata || '{}').isFrontendApi === true; } catch { return false; }
    });
    const backendEndpointNodes = allNodes.filter(n => {
      try { return JSON.parse(n.metadata || '{}').isRestEndpoint === true; } catch { return false; }
    });

    this.log(`Linking ${frontendApiNodes.length} APIs to ${backendEndpointNodes.length} backend endpoints...`);
    this.store.runInTransaction(() => {
      for (const frontendNode of frontendApiNodes) {
        const fMeta = JSON.parse(frontendNode.metadata || '{}');
        const fPath = '/' + (fMeta.apiPath || '').replace(/^\/+|\/+$/g, '');
        const fMethod = (fMeta.httpMethod || 'GET').toUpperCase();

        for (const backendNode of backendEndpointNodes) {
          const bMeta = JSON.parse(backendNode.metadata || '{}');
          const bPath = '/' + (bMeta.apiPath || '').replace(/^\/+|\/+$/g, '');
          const bMethod = (bMeta.httpMethod || 'GET').toUpperCase();

          if (fPath === bPath && fPath !== '/' && (fMethod === bMethod || bMethod === 'ALL')) {
            this.store.insertEdge({
              id: uuidv4(),
              type: 'calls',
              sourceId: frontendNode.id,
              targetId: backendNode.id,
              metadata: JSON.stringify({ isCrossStack: true })
            });
          }
        }
      }
    });
  }

  private collectFiles(dir: string, fileList: string[]) {
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          if (file === 'node_modules' || file === '.git' || file === 'dist' || file === 'target' || file === '.guardian') continue;
          this.collectFiles(fullPath, fileList);
        } else {
          const ext = file.substring(file.lastIndexOf('.')).toLowerCase();
          if (['.ts', '.tsx', '.java', '.js', '.vue', '.xml'].includes(ext)) {
            fileList.push(fullPath);
          }
        }
      }
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
    for (const symbol of symbols) {
      if ((symbol.type === 'function' || symbol.type === 'method') && this.lspClient.isLspReady()) {
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
        } catch (err) {}
      }
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
     const allNodes = this.store.getAllNodes();
     
     // 获取该文件的协同修改伙伴，用于权重补偿
     const partners = this.store.getCoChangePartners(filePath, 0.2);
     const partnerFiles = new Set(partners.map(p => p.partner));

     this.store.runInTransaction(() => {
        for (const node of nodes) {
           const meta = JSON.parse(node.metadata || '{}');
           // 识别调用或引用
           if (node.type === 'function' || node.type === 'method' || node.type === 'ref' || meta.isCall) {
              // 查找匹配的方法或函数定义
              const targets = allNodes.filter(t => 
                t.name === node.name && 
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

  public async stop() {
    this.lspClient.stop();
    this.store.close();
  }
}
