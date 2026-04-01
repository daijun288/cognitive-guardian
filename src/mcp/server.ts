import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ContextManager } from '../engine/context-manager.js';
import { join, isAbsolute, dirname, relative } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

export class GuardianMcpServer {
  private server: Server;
  private manager: ContextManager;

  constructor(lspCommand: string, lspArgs: string[], dbPath: string) {
    this.log('--- Server Instance Initializing (v1.0 Official) ---');
    this.manager = new ContextManager(lspCommand, lspArgs, (msg) => this.log(`[ContextManager] ${msg}`));
    this.server = new Server(
      { name: 'cognitive-guardian', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    this.setupTools();
  }

  private isStandardLibrary(name: string): boolean {
    const stdLibPrefixes = [
      'java.', 'javax.', 'org.springframework.', 'com.fasterxml.jackson.',
      'org.apache.commons.', 'org.slf4j.', 'lombok.', 'junit.', 'org.junit.',
      'com.baomidou.', 'io.swagger.', 'org.mybatis.', 'com.github.',
      'org.apache.http.', 'org.apache.poi.', 'com.google.', 'org.apache.ibatis.'
    ];
    return stdLibPrefixes.some(p => name.startsWith(p));
  }

  private log(message: string) {
    const timestamp = new Date().toISOString();
    const formatted = `[${timestamp}] ${message}`;
    console.error(formatted);
  }

  private setupTools() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      this.log('AI is listing available v1.0 tools...');
      return {
        tools: [
          {
            name: 'find_xml_mapping',
            description: '[HIGH-SIGNAL] 查找 Java Mapper 接口对应的 MyBatis XML SQL 节点。如果在修改 Dao/Mapper 接口，必须调用此工具以防漏改 SQL 映射。',
            inputSchema: {
              type: 'object',
              properties: {
                className: { type: 'string', description: 'Mapper 接口类名 (例如: AiCheckRecordMapper)' },
                filePath: { type: 'string', description: '可选，提供所在文件路径加速解析' }
              },
              required: ['className']
            }
          },
          {
            name: 'find_frontend_api_calls',
            description: '[HIGH-SIGNAL] 追溯后端 API 被 Vue/JS 前端调用的交叉点。如果在修改 Controller 或重构 URL 参数，必须调用此工具以免破坏前端请求。',
            inputSchema: {
              type: 'object',
              properties: {
                apiPath: { type: 'string', description: 'API 路径片段或 Controller 方法名 (例如: /api/v1/user 或 getRecordList)' },
                filePath: { type: 'string', description: '可选加速匹配' }
              },
              required: ['apiPath']
            }
          },
          {
            name: 'find_cross_module_deps',
            description: '[HIGH-SIGNAL] 查找某核心类被当前模块以外的其他模块(跨边界)深度依赖的调用点。过滤掉了你肉眼能直接找到的同包调用，专门帮你查“盲区”。',
            inputSchema: {
              type: 'object',
              properties: {
                className: { type: 'string', description: '被修改的核心类名 (例如: SysUserServiceImpl)' },
                filePath: { type: 'string', description: '所属路径' }
              },
              required: ['className']
            }
          },
          {
            name: 'guardian_start',
            description: '[ADMIN-INDEX-REBUILD] 现已全自动。仅在怀疑索引陈旧需强制重建时调用。',
            inputSchema: { 
              type: 'object', 
              properties: {
                filePath: { type: 'string', description: '项目根路径' }
              } 
            },
          },
          {
            name: 'sync_file',
            description: '[FORCE-SYNC] 强制同步索引文件。当 AI 刚刚修改了代码源文件，且需立刻在 500ms 内调用查询类工具前，必须先调用此工具强制刷新图谱，以防查询到陈旧信息。',
            inputSchema: { 
              type: 'object', 
              properties: {
                filePath: { type: 'string', description: '刚刚发生过修改的物理文件绝对路径' }
              },
              required: ['filePath']
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        return await this.executeTool(request);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.log(`[Tool Error] ${request.params.name}: ${errorMsg}`);
        return {
          content: [{ type: 'text', text: `❌ Error: ${errorMsg}` }],
          isError: true
        };
      }
    });
  }

  public async executeTool(request: any) {
    const startTs = Date.now();
    const toolName = request.params.name;

    switch (toolName) {
      case 'find_xml_mapping': {
        const { className, filePath } = request.params.arguments as any;
        const context = await this.manager.getContext(filePath || process.cwd());
        if (!context) throw new Error('Cannot resolve context');

        const nodes = context.store.getXmlMappingsForClass(className);
        let resultText = `### 🎯 MyBatis XML 映射探测: [${className}]\n\n`;
        if (nodes.length === 0) {
           resultText += `> ✅ **未发现关联的 XML SQL 节点。** (如果它是 Mapper，请确认 XML 文件名是否匹配)`;
        } else {
           resultText += `> ⚠️ **检测到 ${nodes.length} 个隐式关联的 XML 映射：**\n\n`;
           for (let i = 0; i < nodes.length; i++) {
              const node = nodes[i];
              if (!node) continue;
              const relativeFile = this.toRelativePath(context.rootDir, node.file);
              resultText += `${i + 1}. \`[${relativeFile}:${node.startLine}]\` **<${node.type} id="${node.name}">**\n`;
           }
           resultText += `\n**💡 建议行动**: 如果修改了该 Mapper 的接口签名或返回类型，请务必同步检查并修改上述 XML 标签。`;
        }
        return { content: [{ type: 'text', text: resultText }] };
      }

      case 'find_frontend_api_calls': {
        const { apiPath, filePath } = request.params.arguments as any;
        const context = await this.manager.getContext(filePath || process.cwd());
        if (!context) throw new Error('Cannot resolve context');

        const nodes = context.store.getFrontendCallsForApi(apiPath);
        let resultText = `### 🎯 前端跨栈调用追溯: [${apiPath}]\n\n`;
        if (nodes.length === 0) {
           resultText += `> ✅ **未发现直接跨栈调用。** (未检索到完全匹配当前 API 的 Vue/JS 接口依赖)`;
        } else {
           resultText += `> ⚠️ **发现 ${nodes.length} 处前端跨栈调用：**\n\n`;
           for (let i = 0; i < nodes.length; i++) {
              const node = nodes[i];
              if (!node) continue;
              const relativeFile = this.toRelativePath(context.rootDir, node.file);
              resultText += `${i + 1}. \`[${relativeFile}:${node.startLine}]\` 调用方: **${node.name}**\n`;
           }
           resultText += `\n**💡 建议行动**: 若修改了后端此接口的具体传参或 JSON 结构，需同步修改上述前端代码。`;
        }
        return { content: [{ type: 'text', text: resultText }] };
      }

      case 'find_cross_module_deps': {
        const { className, filePath } = request.params.arguments as any;
        const context = await this.manager.getContext(filePath || process.cwd());
        if (!context) throw new Error('Cannot resolve context');

        const nodes = context.store.getCrossModuleCallers(className);
        let resultText = `### 🎯 跨界(跨模块)依赖预警: [${className}]\n\n`;
        if (nodes.length === 0) {
           resultText += `> ✅ **感应安全**: 未在全工程内发现显著跨界影响。所有已知调用均在同目录同层级及本模块内（或不存在调用）。`;
        } else {
           const limit = 5;
           const displayNodes = nodes.slice(0, limit);
           resultText += `> ⚠️ **发现 ${nodes.length} 处跨边界隐式依赖（已剪枝过滤同包内及显式调用）：**\n\n`;
           for (let i = 0; i < displayNodes.length; i++) {
              const node = displayNodes[i];
              if (!node) continue;
              const relativeFile = this.toRelativePath(context.rootDir, node.file);
              resultText += `${i + 1}. \`[${relativeFile}:${node.startLine}]\` 外部依赖方: **${node.name}**\n`;
           }
           if (nodes.length > limit) {
              resultText += `\n*(...及其他 ${nodes.length - limit} 处未在此展示)*\n`;
           }
           resultText += `\n**💡 风险提示**: 该组件被外部跨边界依赖，重构存在破坏全局契约的风险。请谨慎修改其公有语义。`;
        }
        return { content: [{ type: 'text', text: resultText }] };
      }

      case 'guardian_start': {
        const { filePath } = request.params.arguments as { filePath?: string };
        const context = await this.manager.getContext(filePath || process.cwd());
        if (!context) return { content: [{ type: 'text', text: 'Error: Cannot initialize context.' }] };
        return { content: [{ type: 'text', text: `Full scan manual trigger for [${context.rootDir}] success.` }] };
      }

      case 'sync_file': {
        const { filePath } = request.params.arguments as { filePath?: string };
        if (!filePath) throw new Error('filePath is required for sync_file');
        const context = await this.manager.getContext(filePath);
        if (!context) throw new Error(`Could not resolve context for ${filePath}`);
        
        const fs = await import('fs');
        if (!fs.existsSync(filePath)) throw new Error(`File does not exist: ${filePath}`);
        const content = fs.readFileSync(filePath, 'utf-8');
        await context.orchestrator.analyzeFile(filePath, content);
        
        return {
          content: [{ type: 'text', text: `✅ [SUCCESS] File has been synchronously re-indexed: ${filePath}. Knowledge Graph is up to date.` }]
        };
      }

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  private toRelativePath(rootDir: string, fullPath: string): string {
    return relative(rootDir, fullPath).replace(/\\/g, '/');
  }

  private resolvePath(rootDir: string, filePath: string): string {
    const normalizedInput = filePath.replace(/\\/g, '/');
    const normRoot = rootDir.replace(/\\/g, '/');
    
    const candidates = [
       normalizedInput,
       join(normRoot, normalizedInput).replace(/\\/g, '/'),
       join(dirname(normRoot), normalizedInput).replace(/\\/g, '/'),
       join(dirname(dirname(normRoot)), normalizedInput).replace(/\\/g, '/')
    ];

    for (const cand of candidates) {
       if (existsSync(cand)) return cand.replace(/\\/g, '/');
    }
    
    const inputParts = normalizedInput.split('/');
    for (let i = 0; i < inputParts.length; i++) {
       const subPath = inputParts.slice(i).join('/');
       const testPath = join(normRoot, subPath).replace(/\\/g, '/');
       if (existsSync(testPath)) return testPath;
    }

    let absolutePath = join(normRoot, normalizedInput).replace(/\\/g, '/');
    if (process.platform === 'win32') {
      if (absolutePath.startsWith('/') && /^\/[a-zA-Z]:/.test(absolutePath)) absolutePath = absolutePath.substring(1);
      if (/^[a-z]:/.test(absolutePath)) {
          const drive = absolutePath[0];
          if (drive) absolutePath = drive.toUpperCase() + absolutePath.substring(1);
      }
    }
    return absolutePath.replace(/\\/g, '/');
  }

  public async stop() {
    this.log('Server shutting down...');
    await this.manager.dispose();
  }

  public async run(rootUri: string) {
    this.log(`Cognitive Guardian MCP Server (v1.0) is starting up...`);
    const transport = new StdioServerTransport();

    process.stdin.on('close', async () => {
      await this.stop();
      process.exit(0);
    });

    await this.server.connect(transport);
    this.log('Server connected successfully.');

    if (rootUri && rootUri !== "") {
      try {
        const rootDir = fileURLToPath(rootUri);
        this.manager.setDefaultRoot(rootDir);
        await this.manager.getContext(rootDir);
      } catch (err) {
        this.log(`Initial initialization skipped: ${err}`);
      }
    }
  }
}
