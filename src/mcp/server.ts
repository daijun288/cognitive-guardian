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
            name: 'check_relevance',
            description: '[STRATEGIC-FIRST-STEP] 修改任何代码前的“第一道防线”。仅需输入 nodeId，后台将快速感应此节点是否涉及高风险跨层级（如 SQL/Vue/跨服务）引用。如果此工具提示有风险，必须联级调用 impact_brief。',
            inputSchema: {
              type: 'object',
              properties: {
                nodeId: { type: 'string', description: '您准备修改的方法、类或变量名' }
              },
              required: ['nodeId']
            }
          },
          {
            name: 'impact_brief',
            description: '[CRITICAL-RISK-ANALYSIS] 深度风险探测。在执行重构、更名或接口变更前调用。它能发现隐藏在 XML SQL、Vue 模板、微服务接口中的“隐形引用”。建议在 check_relevance 之后或确信有风险时使用。',
            inputSchema: {
              type: 'object',
              properties: {
                nodeId: { type: 'string', description: '待修改的目标名' },
                filePath: { type: 'string', description: '所在文件路径（可选，缺失将触发全局搜索）' }
              },
              required: ['nodeId']
            }
          },
          {
            name: 'quick_check',
            description: '[ACTION-PLAN-GENERATOR] 生成同步修改任务清单。直接将分析结果转化为 suggestedEdits 行动计划项，确保 AI 能一次性补全所有漏掉的关联修改点，防止编译失败或逻辑裂缝。',
            inputSchema: {
              type: 'object',
              properties: {
                nodeId: { type: 'string', description: '节点名称' },
                filePath: { type: 'string', description: '文件路径（可选，缺失将触发全局搜索）' }
              },
              required: ['nodeId']
            }
          },
          {
            name: 'get_call_graph',
            description: '[TOPOLOGY-EXPLORER] 复杂重构必备。提供 360 度深层拓扑图谱，揭示全局连锁反应。适用于评估架构层面的变更冲击。',
            inputSchema: {
              type: 'object',
              properties: {
                nodeId: { type: 'string', description: '代码节点的名称' },
                filePath: { type: 'string', description: '物理文件路径（可选）' },
                direction: { 
                  type: 'string', 
                  enum: ['upstream', 'downstream', 'both'], 
                  description: '分析方向 (默认 downstream)',
                  default: 'downstream'
                }
              },
              required: ['nodeId'],
            },
          },
          {
            name: 'assess_bulk_impact',
            description: '[BULK-STRESS-TEST] 最终一致性校验。在提交包含多个文件的批量修改前调用，识别不同修改点间的逻辑冲突并输出回归测试优先级。',
            inputSchema: {
              type: 'object',
              properties: {
                changes: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      nodeId: { type: 'string', description: '修改点名' },
                      filePath: { type: 'string', description: '所属文件路径' }
                    }
                  }
                }
              },
              required: ['changes']
            },
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
      case 'check_relevance':
      case 'impact_brief':
      case 'quick_check':
      case 'get_call_graph': {
        const isRelevance = toolName === 'check_relevance';
        const isImpactBrief = toolName === 'impact_brief';
        const isQuick = toolName === 'quick_check';
        const isGraph = toolName === 'get_call_graph';
        const { nodeId, filePath, direction = 'downstream' } = (request.params.arguments || {}) as any;
        
        if (!nodeId) throw new Error('nodeId (class/method name) is required');

        const context = await this.manager.getContext(filePath);
        const searchName = nodeId.includes('.') ? (nodeId.split('.').pop() || nodeId) : nodeId;

        const findNodeInContext = (ctx: any, absPath: string | null = null) => {
           let list = absPath ? ctx.store.getNodesByFile(absPath) : ctx.store.getNodesByName(searchName);
           
           // 1. Exact Name & Common Type Match
           let match = list.find((n: any) => (n.id === nodeId || n.name === nodeId) && ['function', 'method', 'class', 'interface', 'variable'].includes(n.type));
           if (match) return match;
           
           // 2. FQN/Qualified Name match
           if (nodeId.includes('.')) {
              match = list.find((n: any) => n.name === searchName && (n.fullName?.replace(/[\\\/]/g, '.') || "").includes(nodeId));
              if (match) return match;
           }

           // 3. V21.1: Filename-to-Class Fallback (Improved)
           if (absPath) {
              const fileName = absPath.split('/').pop() || '';
              const clsNameFromFile = fileName.includes('.') ? fileName.split('.')[0] : fileName;
              if (clsNameFromFile === nodeId || nodeId.toLowerCase() === clsNameFromFile?.toLowerCase()) {
                 match = list.find((n: any) => (n.type === 'class' || n.type === 'interface') && n.name === clsNameFromFile);
                 if (match) return match;
                 if (list.length > 0) return list[0];
              }
           }

           return list.find((n: any) => n.name.toLowerCase() === nodeId.toLowerCase());
        };

        let targetNode: any = null;
        let activeContext = context;

        // --- Step 1: Search in local file ---
        if (context && filePath) {
           const absolutePath = this.resolvePath(context.rootDir, filePath);
           let fileNodes = context.store.getNodesByFile(absolutePath);
           if (fileNodes.length === 0) {
              try {
                await context.orchestrator.analyzeFile(absolutePath, "");
                fileNodes = context.store.getNodesByFile(absolutePath);
              } catch (e) {}
           }
           targetNode = findNodeInContext(context, absolutePath);
        }

        // --- Step 2: Global Memory Search ---
        if (!targetNode) {
           for (const ctx of this.manager.getAllContexts()) {
              targetNode = findNodeInContext(ctx);
              if (targetNode) {
                 activeContext = ctx;
                 break;
              }
           }
        }

        // --- Step 3: V21.1 Omniscient Physical Search (The "Game Changer") ---
        if (!targetNode) {
           this.log(`[Omniscient Search] Symbol [${nodeId}] not in memory. Triggering deep physical search...`);
           const physicalFound = this.manager.findFileGlobally(searchName);
           if (physicalFound) {
              this.log(`[Omniscient Search] Found physical file: ${physicalFound.path}. Analyzing...`);
              try {
                // Ensure context is available for this file
                const fileContext = await this.manager.getContext(physicalFound.path);
                if (fileContext) {
                   await fileContext.orchestrator.analyzeFile(physicalFound.path, "");
                   targetNode = findNodeInContext(fileContext, physicalFound.path);
                   if (targetNode) activeContext = fileContext;
                }
              } catch (e) {
                this.log(`[Omniscient Search] Lazy indexing failed: ${e}`);
              }
           }
        }

        if (!targetNode || !activeContext) throw new Error(`Symbol not found: [${nodeId}] could not be located in file, memory, or project storage.`);

        let collaborators: any[] = [];
        const store = activeContext.store;
        if (direction === 'downstream' || direction === 'both') collaborators = [...collaborators, ...store.getDeepCallers(targetNode.id)];
        if (direction === 'upstream' || direction === 'both') collaborators = [...collaborators, ...store.getDeepDependencies(targetNode.id)];

        collaborators = Array.from(new Set(collaborators.map(c => c.id)))
          .map(id => collaborators.find(c => c.id === id))
          .filter(n => n && !this.isStandardLibrary(n.name));

        const getSemanticAction = (node: any) => {
           if (node.file.endsWith('.xml')) return 'updateSqlMapping';
           if (node.file.includes('Controller')) return 'verifyRestInterface';
           if (node.type === 'service' || node.name.endsWith('Service')) return 'verifyBusinessLogic';
           if (node.type === 'controller' || node.name.endsWith('Controller')) return 'updateEndpointSignature';
           return 'verifyCompatibility';
        };

        const suggestedEdits = collaborators.map(c => ({
           file: this.toRelativePath(activeContext!.rootDir, c.file),
           line: c.startLine,
           node: c.name,
           action: getSemanticAction(c),
           reason: `Impacted by [${targetNode!.name}] modification`
        }));

        const cacheKey = `${toolName}:${nodeId}:${activeContext.rootDir}:${direction}`;
        const cached = isImpactBrief ? this.manager.getCache(cacheKey) : null;
        if (cached) {
            this.log(`[Cache Hit] Serving ${toolName} for ${nodeId}`);
            return cached;
        }

        const complexityScore = collaborators.length * 10;
        const duration = Date.now() - startTs;
        
        let resultText = `### ${isRelevance ? '🔍 相关性扫描' : (isGraph ? '🕸️ 全局拓扑' : (isImpactBrief ? '🛡️ 安全检测报告' : '🛠️ 建议行动计划'))}: [${targetNode.name}]\n`;
        resultText += `> 💡 **感应发现**: 在你当前的上下文之外，识别到 **${collaborators.length}** 个受影响的外部位置点。\n\n`;

        if (isRelevance) {
           if (collaborators.length > 0) {
              resultText += `⚠️ **检测到潜在风险**: 该节点存在 **${collaborators.length}** 个跨层级依赖。强烈建议在修改前运行 \`impact_brief\` 以查看详细受影响路径。`;
           } else {
              resultText += "✅ **低风险**: 未发现跨层级依赖。可以直接进行局部修改。";
           }
        } else if (collaborators.length > 5 && (isQuick || isGraph)) {
           const top3 = suggestedEdits.slice(0, 3);
           const othersCount = suggestedEdits.length - 3;
           resultText += `**⚠️ 必须同步修改的关键路径：**\n` + JSON.stringify(top3, null, 2) + `\n\n`;
           resultText += `<details>\n<summary>点击展开另外 ${othersCount} 个关联项...</summary>\n\n` + JSON.stringify(suggestedEdits.slice(3), null, 2) + `\n</details>\n`;
        } else if (collaborators.length > 0) {
           resultText += `**✅ 建议同步执行的任务清单 (suggestedEdits):**\n` + JSON.stringify(suggestedEdits, null, 2);
        } else {
           resultText += "✅ **感应安全**: 未在全工程内发现显著跨模块影响。可以直接修改该局部节点。";
        }

        if (!isRelevance && complexityScore > 50) resultText += `\n\n🚨 **高回归风险警告**: 此节点的改动具有全局穿透性 (风险值: ${complexityScore})，严禁跳过同步修改和全量回归。`;
        
        // --- Next Steps Guidance ---
        resultText += `\n\n---\n**💡 下一步建议 (Next Steps):**\n`;
        if (isRelevance) {
           resultText += collaborators.length > 0 ? `1. 调用 \`impact_brief\` 获取详细风险报告。\n2. 评估是否需要重构。` : `1. 直接按计划修改代码。`;
        } else if (isImpactBrief) {
           resultText += `1. 调用 \`quick_check\` 生成具体的同步修改计划 (suggestedEdits)。\n2. 确认受影响的 XML/Mapper 是否需要手动映射。`;
        } else if (isQuick) {
           resultText += `1. 将上述清单加入你的 TODO。\n2. 修改完成后，调用 \`assess_bulk_impact\` 进行最终验证。`;
        } else {
           resultText += `1. 确认拓扑结构是否符合预期。\n2. 如需修改，请先运行 \`impact_brief\`。`;
        }
        
        const finalResult = {
          content: [{ type: 'text', text: resultText }],
          analysisMode: 'Omniscient',
          complexityScore,
          suggestedEdits
        };

        if (isImpactBrief) this.manager.setCache(cacheKey, finalResult);
        return finalResult;
      }

      case 'assess_bulk_impact': {
        const { changes } = (request.params.arguments || {}) as { changes: Array<{ nodeId: string, filePath: string }> };
        if (!changes || !Array.isArray(changes)) throw new Error('Invalid changes argument (expected array)');
        
        const intendedNodeIds = new Set<string>();
        const intendedNodes: any[] = [];
        
        for (const change of changes) {
            const context = await this.manager.getContext(change.filePath);
            if (!context) continue;
            const absPath = this.resolvePath(context.rootDir, change.filePath);
            let nodes = context.store.getNodesByFile(absPath);
            
            if (nodes.length === 0) {
                try {
                    await context.orchestrator.analyzeFile(absPath, "");
                    nodes = context.store.getNodesByFile(absPath);
                } catch(e) {}
            }

            const target = nodes.find(n => n.id === change.nodeId || n.name === change.nodeId);
            if (target) {
                intendedNodeIds.add(target.id);
                intendedNodes.push({ node: target, context });
            }
        }

        const impactMap = new Map<string, any>();
        let coordinatedCount = 0;
        let unintendedCount = 0;

        for (const { node, context } of intendedNodes) {
           const callers = context.store.getDeepCallers(node.id).filter((n: any) => !this.isStandardLibrary(n.name));
           for (const caller of callers) {
              const isCoordinated = intendedNodeIds.has(caller.id);
              const existing = impactMap.get(caller.id);
              
              if (existing) {
                 existing.reasons.push(`Impacted by [${node.name}]`);
                 if (isCoordinated) existing.isCoordinated = true; 
              } else {
                 impactMap.set(caller.id, {
                    file: this.toRelativePath(context.rootDir, caller.file),
                    line: caller.startLine,
                    node: caller.name,
                    isCoordinated,
                    reasons: [`Impacted by [${node.name}]`],
                    action: isCoordinated ? 'synchronizeLogic' : 'regressionTest'
                 });
                 if (isCoordinated) coordinatedCount++; else unintendedCount++;
              }
           }
        }

        const suggestedEdits = Array.from(impactMap.values()).map(imp => ({
           ...imp,
           reason: imp.reasons.join(', ')
        }));

        const riskScore = Math.min(100, unintendedCount * 20 + coordinatedCount * 2);
        
        let report = `### 🛡️ 高维改动冲击分析报告\n`;
        report += `评估了 **${intendedNodes.length}** 个改动点。识别到 **${impactMap.size}** 个受波及节点。\n\n`;
        
        report += `#### 🤝 协调性校验 (Coordination)\n`;
        if (coordinatedCount > 0) {
            report += `> 发现 **${coordinatedCount}** 处预期内协同修改。风险已对冲。\n`;
        } else if (intendedNodes.length > 1 && unintendedCount === 0) {
            report += `> 🛡️ **安全对冲达到 100%**: 所有受影响节点均在您的改动计划中。\n`;
        } else {
            report += `> 未发现显著的改动间关联。\n`;
        }

        report += `\n#### ⚠️ 潜在冲突风险 (Unintended)\n`;
        if (unintendedCount > 0) {
            report += `> **发现 ${unintendedCount} 处非预期影响！**\n\n`;
            const sample = suggestedEdits.filter(e => !e.isCoordinated).slice(0, 3);
            report += `**样例：**\n` + JSON.stringify(sample, null, 2) + `\n`;
        } else {
            report += `> ✅ **感应安全**: 无意外溢出风险。\n`;
        }

        report += `\n**综合风险评分: ${riskScore}/100**\n`;

        return { 
          content: [{ type: 'text', text: report }],
          complexityScore: riskScore,
          suggestedEdits 
        };
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
