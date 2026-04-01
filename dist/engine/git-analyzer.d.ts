import { KnowledgeGraphStore } from '../storage/sqlite.js';
export interface GitFileStats {
    file: string;
    totalCommits: number;
    bugFixCommits: number;
    lastModified: string;
    churnScore: number;
}
export interface CoChangePattern {
    fileA: string;
    fileB: string;
    coChangeCount: number;
    confidence: number;
    totalCommitsA: number;
    totalCommitsB: number;
}
export declare class GitAnalyzer {
    private logger;
    constructor(logger?: (msg: string) => void);
    /**
     * Check if git is available in the given directory
     */
    isGitRepo(rootDir: string): boolean;
    /**
     * Analyze git history and persist results to SQLite
     */
    analyzeHistory(rootDir: string, store: KnowledgeGraphStore, maxCommits?: number): Promise<{
        totalCommitsAnalyzed: number;
        uniqueFiles: number;
        coChangePairs: number;
    }>;
    private getGitLog;
    private parseGitLog;
    private isCodeFile;
}
//# sourceMappingURL=git-analyzer.d.ts.map