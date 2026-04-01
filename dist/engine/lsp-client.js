import { spawn, ChildProcess } from 'child_process';
import * as rpc from 'vscode-jsonrpc/node.js';
import * as lsp from 'vscode-languageserver-protocol';
export class LspClient {
    serverCommand;
    serverArgs;
    process = null;
    connection = null;
    isReady = false;
    constructor(serverCommand, serverArgs = []) {
        this.serverCommand = serverCommand;
        this.serverArgs = serverArgs;
    }
    isLspReady() {
        return this.isReady;
    }
    async start() {
        try {
            this.process = spawn(this.serverCommand, this.serverArgs, {
                stdio: ['pipe', 'pipe', 'inherit'],
                shell: true,
            });
            this.connection = rpc.createMessageConnection(new rpc.StreamMessageReader(this.process.stdout), new rpc.StreamMessageWriter(this.process.stdin));
            this.connection.listen();
        }
        catch (err) {
            console.error(`[LSP] Failed to spawn LSP process: ${err}`);
        }
    }
    async initialize(rootUri) {
        if (!this.connection)
            return null;
        const params = {
            processId: process.pid,
            rootUri,
            capabilities: {
                textDocument: {
                    definition: { dynamicRegistration: true },
                    references: { dynamicRegistration: true },
                },
            },
        };
        try {
            const result = await this.connection.sendRequest(lsp.InitializeRequest.type.method, params);
            this.isReady = true;
            return result;
        }
        catch (err) {
            console.error(`[LSP] Initialization failed (often due to missing TS environment): ${err}`);
            return null;
        }
    }
    async getDefinition(uri, line, character) {
        if (!this.connection)
            throw new Error('Connection not started');
        const params = {
            textDocument: { uri },
            position: { line, character },
        };
        return this.connection.sendRequest(lsp.DefinitionRequest.type.method, params);
    }
    async getReferences(uri, line, character) {
        if (!this.connection)
            throw new Error('Connection not started');
        const params = {
            textDocument: { uri },
            position: { line, character },
            context: { includeDeclaration: true },
        };
        return this.connection.sendRequest(lsp.ReferencesRequest.type.method, params);
    }
    async didOpen(uri, languageId, version, text) {
        if (!this.connection)
            throw new Error('Connection not started');
        const params = {
            textDocument: { uri, languageId, version, text },
        };
        return this.connection.sendNotification(lsp.DidOpenTextDocumentNotification.type.method, params);
    }
    stop() {
        try {
            this.connection?.dispose();
            this.process?.kill('SIGKILL'); // Use SIGKILL to ensure immediate exit on Windows
        }
        catch (err) {
            // Silent catch for cleanup
        }
    }
}
//# sourceMappingURL=lsp-client.js.map