import * as lsp from 'vscode-languageserver-protocol';
export declare class LspClient {
    private serverCommand;
    private serverArgs;
    private process;
    private connection;
    private isReady;
    constructor(serverCommand: string, serverArgs?: string[]);
    isLspReady(): boolean;
    start(): Promise<void>;
    initialize(rootUri: string): Promise<lsp.InitializeResult | null>;
    getDefinition(uri: string, line: number, character: number): Promise<lsp.Definition | lsp.LocationLink[] | null>;
    getReferences(uri: string, line: number, character: number): Promise<lsp.Location[] | null>;
    didOpen(uri: string, languageId: string, version: number, text: string): Promise<void>;
    stop(): void;
}
//# sourceMappingURL=lsp-client.d.ts.map