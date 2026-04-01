import { AnalysisOrchestrator } from './orchestrator.js';
import { FileWatcher } from './watcher.js';
import { KnowledgeGraphStore } from '../storage/sqlite.js';
export interface ProjectContext {
    rootDir: string;
    store: KnowledgeGraphStore;
    orchestrator: AnalysisOrchestrator;
    watcher: FileWatcher;
    log: (msg: string) => void;
}
export declare class ContextManager {
    private contexts;
    private defaultRootDir;
    private cache;
    private readonly CACHE_TTL;
    private lspCommand;
    private lspArgs;
    private defaultRoot;
    private logger;
    constructor(lspCommand: string, lspArgs: string[], logger?: (msg: string) => void);
    setDefaultRoot(rootDir: string): void;
    /**
     * 获取或创建一个项目的上下文
     */
    getContext(filePath: string): Promise<ProjectContext | null>;
    private findProjectRoot;
    private createContext;
    getAllContexts(): ProjectContext[];
    /**
     * v1.0: 全局物理文件搜索 (用于补全未索引的符号)
     */
    findFileGlobally(fileName: string): {
        path: string;
        context: ProjectContext;
    } | null;
    private searchRecursive;
    getCache(key: string): any | null;
    setCache(key: string, data: any): void;
    dispose(): Promise<void>;
}
//# sourceMappingURL=context-manager.d.ts.map