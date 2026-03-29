import { spawn, ChildProcess } from 'child_process';
import * as rpc from 'vscode-jsonrpc/node.js';
import * as lsp from 'vscode-languageserver-protocol';

export class LspClient {
  private process: ChildProcess | null = null;
  private connection: rpc.MessageConnection | null = null;
  private isReady: boolean = false;

  constructor(private serverCommand: string, private serverArgs: string[] = []) {}

  public isLspReady(): boolean {
    return this.isReady;
  }

  public async start(): Promise<void> {
    try {
      this.process = spawn(this.serverCommand, this.serverArgs, {
        stdio: ['pipe', 'pipe', 'inherit'],
        shell: true,
      });

      this.connection = rpc.createMessageConnection(
        new rpc.StreamMessageReader(this.process.stdout!),
        new rpc.StreamMessageWriter(this.process.stdin!)
      );

      this.connection.listen();
    } catch (err) {
      console.error(`[LSP] Failed to spawn LSP process: ${err}`);
    }
  }

  public async initialize(rootUri: string): Promise<lsp.InitializeResult | null> {
    if (!this.connection) return null;

    const params: lsp.InitializeParams = {
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
      return result as lsp.InitializeResult;
    } catch (err) {
      console.error(`[LSP] Initialization failed (often due to missing TS environment): ${err}`);
      return null;
    }
  }

  public async getDefinition(uri: string, line: number, character: number): Promise<lsp.Definition | lsp.LocationLink[] | null> {
    if (!this.connection) throw new Error('Connection not started');

    const params: lsp.TextDocumentPositionParams = {
      textDocument: { uri },
      position: { line, character },
    };

    return this.connection.sendRequest(lsp.DefinitionRequest.type.method, params);
  }

  public async getReferences(uri: string, line: number, character: number): Promise<lsp.Location[] | null> {
    if (!this.connection) throw new Error('Connection not started');

    const params: lsp.ReferenceParams = {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true },
    };

    return this.connection.sendRequest(lsp.ReferencesRequest.type.method, params);
  }

  public async didOpen(uri: string, languageId: string, version: number, text: string): Promise<void> {
    if (!this.connection) throw new Error('Connection not started');

    const params: lsp.DidOpenTextDocumentParams = {
      textDocument: { uri, languageId, version, text },
    };

    return this.connection.sendNotification(lsp.DidOpenTextDocumentNotification.type.method, params);
  }

  public stop() {
    try {
      this.connection?.dispose();
      this.process?.kill('SIGKILL'); // Use SIGKILL to ensure immediate exit on Windows
    } catch (err) {
      // Silent catch for cleanup
    }
  }
}
