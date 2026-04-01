import { AnalysisOrchestrator } from './orchestrator.js';
import { FileWatcher } from './watcher.js';
import { GitAnalyzer } from './git-analyzer.js';
import { KnowledgeGraphStore } from '../storage/sqlite.js';
import { dirname, join, isAbsolute } from 'path';
import { existsSync, mkdirSync, statSync, appendFileSync } from 'fs';
import { fileURLToPath } from 'url';

export interface ProjectContext {
  rootDir: string;
  store: KnowledgeGraphStore;
  orchestrator: AnalysisOrchestrator;
  watcher: FileWatcher;
  log: (msg: string) => void;
}

export class ContextManager {
  private contexts: Map<string, ProjectContext> = new Map();
  private defaultRootDir: string | null = null;
  private cache: Map<string, { data: any, timestamp: number }> = new Map();
  private readonly CACHE_TTL = 1000 * 60 * 60; // 1 hour
  private lspCommand: string;
  private lspArgs: string[];
  private defaultRoot: string | null = null;
  private logger: (msg: string) => void;

  constructor(lspCommand: string, lspArgs: string[], logger?: (msg: string) => void) {
    this.lspCommand = lspCommand;
    this.lspArgs = lspArgs;
    this.logger = logger || ((msg) => console.error(`[ContextManager] ${msg}`));
  }

  public setDefaultRoot(rootDir: string) {
    this.defaultRoot = rootDir;
  }

  /**
   * 获取或创建一个项目的上下文
   */
  public async getContext(filePath?: string): Promise<ProjectContext | null> {
    if (!filePath) {
      if (this.defaultRoot) {
        const normalizedRoot = this.defaultRoot.replace(/\\/g, '/');
        return this.contexts.get(normalizedRoot) || null;
      }
      return this.contexts.values().next().value || null;
    }
    const normalizedInput = filePath.replace(/\\/g, '/');
    
    // 1. 如果已有 context 覆盖了该路径（处理绝对路径或已解析路径）
    if (isAbsolute(normalizedInput)) {
      const lowerInput = normalizedInput.toLowerCase();
      for (const [rootDir, context] of this.contexts.entries()) {
        const normalizedRoot = rootDir.replace(/\\/g, '/').toLowerCase();
        if (lowerInput.startsWith(normalizedRoot)) {
          return context;
        }
      }
    } else {
      // 2. 处理相对路径 (v1.0): 全域 Context 探测
      // 遍历已激活的 contexts，看这个相对路径是否在某个 context 根目录下真实存在
      for (const [rootDir, context] of this.contexts.entries()) {
        const potentialPath = join(rootDir, normalizedInput).replace(/\\/g, '/');
        if (existsSync(potentialPath)) {
          this.logger(`Resolved relative path [${normalizedInput}] against context: ${rootDir}`);
          return context;
        }
      }

      // 3. 落退逻辑: 相对于 defaultRoot 或进程目录
      const baseDir = this.defaultRoot || process.cwd();
      const absoluteFallback = join(baseDir, normalizedInput).replace(/\\/g, '/');
      const rootDir = this.findProjectRoot(absoluteFallback);
      if (rootDir) {
        const normalizedRoot = rootDir.replace(/\\/g, '/');
        if (this.contexts.has(normalizedRoot)) return this.contexts.get(normalizedRoot)!;
        this.logger(`Discovered new project root via relative fallback: ${normalizedRoot}`);
        const context = await this.createContext(normalizedRoot, true);
        this.contexts.set(normalizedRoot, context);
        return context;
      }

      // 4. v1.0 符号表模糊盲搜 (文件名直达): 如果输入看起来像个文件名
      if (!normalizedInput.includes('/') && (normalizedInput.endsWith('.java') || normalizedInput.endsWith('.js') || normalizedInput.endsWith('.ts') || normalizedInput.endsWith('.vue'))) {
        this.logger(`[Ambiguous Path] Attempting global file-lookup for: ${normalizedInput}`);
        for (const [rootDir, context] of this.contexts.entries()) {
          // 查找 store 中是否包含该文件名的物理全路径，替代原本的 getAllNodes 全表扫！ (IDEA 倒排索引思维)
          const matchedFiles = context.store.getFilesBySuffix(normalizedInput);
          const firstMatch = matchedFiles[0];
          if (firstMatch) {
            const match = firstMatch.replace(/\\/g, '/');
            this.logger(`[Ambiguous Path] Success! Self-corrected [${normalizedInput}] to [${match}]`);
            return context;
          }
        }
      }
    }

    // 4. 如果是绝对路径且没有 context，尝试按文件系统查找
    if (isAbsolute(normalizedInput)) {
      const rootDir = this.findProjectRoot(normalizedInput);
      if (rootDir) {
        const normalizedRoot = rootDir.replace(/\\/g, '/');
        if (this.contexts.has(normalizedRoot)) return this.contexts.get(normalizedRoot)!;
        const context = await this.createContext(normalizedRoot, true); // 默认为 lite 模式，除非显式 start
        this.contexts.set(normalizedRoot, context);
        return context;
      }
    }

    this.logger(`[Error] Could not resolve context for: ${normalizedInput}`);
    return null;
  }

  private findProjectRoot(filePath: string): string | null {
    const normalizedInput = filePath.replace(/\\/g, '/');
    let current = isAbsolute(normalizedInput) ? normalizedInput : join(this.defaultRoot || process.cwd(), normalizedInput).replace(/\\/g, '/');
    
    try {
      if (existsSync(current) && !statSync(current).isDirectory()) {
        current = dirname(current);
      }
    } catch {
      current = dirname(current);
    }
    
    let bestRoot: string | null = null;
    let temp = current;
    const limit = this.defaultRoot ? this.defaultRoot.replace(/\\/g, '/') : null;

    while (true) {
      const hasPackage = existsSync(join(temp, 'package.json'));
      const hasGit = existsSync(join(temp, '.git'));
      const hasPom = existsSync(join(temp, 'pom.xml'));

      if (hasPackage || hasGit || hasPom) {
        bestRoot = temp; // 记录当前发现的根，继续向上找更高的
      }
      
      const parent = dirname(temp);
      if (parent === temp) break;
      
      // 如果设置了 limit，不要越由于 limit
      if (limit && !temp.toLowerCase().startsWith(limit.toLowerCase())) break;
      
      temp = parent;
    }

    // 如果没有任何发现，降级到 limit 或当前目录
    return bestRoot || limit || current;
  }

  private async createContext(rootDir: string, lite: boolean = true): Promise<ProjectContext> {
    const guardianDir = join(rootDir, '.guardian');
    
    if (!existsSync(guardianDir)) {
      mkdirSync(guardianDir, { recursive: true });
    }

    const projectLogPath = join(guardianDir, 'guardian.log');
    const projectLogger = (msg: string) => {
      const timestamp = new Date().toISOString();
      const formatted = `[${timestamp}] ${msg}\n`;
      try {
        appendFileSync(projectLogPath, formatted);
      } catch (err) {}
      this.logger(`[${rootDir}] ${msg}`);
    };

    projectLogger('--- Project Context Initialization (v1.0) ---');

    const dbPath = join(guardianDir, 'graph.sqlite');
    const store = new KnowledgeGraphStore(dbPath);
    const orchestrator = new AnalysisOrchestrator(this.lspCommand, this.lspArgs, dbPath, (msg) => projectLogger(`[Orchestrator] ${msg}`));
    
    const rootUri = `file:///${rootDir.replace(/\\/g, '/')}`;
    
    // v1.0: 始终以后台任务形式启动全量扫描，不阻塞上下文返回
    // 这样 getContext 永远是毫秒级的
    const initPromise = orchestrator.start(rootUri).catch(err => {
      projectLogger(`[Background Init Error] ${err.message}`);
    });

    if (lite) {
      projectLogger('Lite mode (Implicit): Background full scan started. Hot Path available immediately.');
    }

    // v1.0: Git History Analysis (Background)
    const gitAnalyzer = new GitAnalyzer((msg) => projectLogger(`[GitAnalyzer] ${msg}`));
    gitAnalyzer.analyzeHistory(rootDir, store).catch(err => {
      projectLogger(`[GitAnalyzer] Failed (non-blocking): ${err instanceof Error ? err.message : err}`);
    });

    const watcher = new FileWatcher(orchestrator, rootDir);

    const context: ProjectContext = {
      rootDir,
      store,
      orchestrator,
      watcher,
      log: projectLogger
    };

    projectLogger(`[Success] Context created (Background Init In-Progress): ${rootDir}`);
    
    return context;
  }

  public getAllContexts(): ProjectContext[] {
    return Array.from(this.contexts.values());
  }

  /**
   * v1.0: 全局物理文件搜索 (用于补全未索引的符号)
   */
  public findFileGlobally(fileName: string): { path: string, context: ProjectContext } | null {
    const extensions = ['.java', '.ts', '.js', '.vue'];
    const searchNames = extensions.map(ext => fileName.endsWith(ext) ? fileName : fileName + ext);
    
    for (const [rootDir, context] of this.contexts.entries()) {
      const found = this.searchRecursive(rootDir, searchNames);
      if (found) return { path: found, context };
    }
    return null;
  }

  private searchRecursive(dir: string, targetNames: string[], depth = 0): string | null {
    if (depth > 12) return null; // 防止过深
    if (dir.includes('node_modules') || dir.includes('.git') || dir.includes('target') || dir.includes('dist')) return null;

    try {
      const files = require('fs').readdirSync(dir);
      for (const file of files) {
        const fullPath = join(dir, file).replace(/\\/g, '/');
        if (targetNames.some(t => file === t || fullPath.endsWith('/' + t))) {
          return fullPath;
        }
        if (require('fs').statSync(fullPath).isDirectory()) {
          const res = this.searchRecursive(fullPath, targetNames, depth + 1);
          if (res) return res;
        }
      }
    } catch (e) {}
    return null;
  }

  public getCache(key: string): any | null {
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.timestamp > this.CACHE_TTL) {
      this.cache.delete(key);
      return null;
    }
    return cached.data;
  }

  public setCache(key: string, data: any) {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  public async dispose() {
    for (const context of this.contexts.values()) {
      context.log('Project context disposing...');
      await context.orchestrator.stop();
      context.watcher.stop();
    }
    this.contexts.clear();
  }
}
