export declare class GuardianMcpServer {
    private server;
    private manager;
    constructor(lspCommand: string, lspArgs: string[], dbPath: string);
    private isStandardLibrary;
    private log;
    private setupTools;
    executeTool(request: any): Promise<any>;
    private toRelativePath;
    private resolvePath;
    stop(): Promise<void>;
    run(rootUri: string): Promise<void>;
}
//# sourceMappingURL=server.d.ts.map