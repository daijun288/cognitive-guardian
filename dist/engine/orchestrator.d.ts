export declare class AnalysisOrchestrator {
    private logger;
    private parser;
    private lspClient;
    private store;
    private cachePath;
    private fileHashes;
    constructor(lspServerCommand: string, lspServerArgs: string[], dbPath?: string, logger?: (msg: string) => void);
    private log;
    private loadCache;
    private saveCache;
    private getFileHash;
    start(rootUri: string): Promise<void>;
    private linkSymbols;
    private collectFiles;
    analyzeFile(filePath: string, sourceCode?: string): Promise<void>;
    private linkFileSymbols;
    stop(): Promise<void>;
}
//# sourceMappingURL=orchestrator.d.ts.map