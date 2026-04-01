# Systemic Cognitive Guardian (v1.5)

> **极速拓扑感应器** —— 这是一个为 AI 开发者量身定制的、**全自动静默运行**的 MCP Server，致力于提供工业级、低延迟的代码上下文感知能力。

## 🌟 核心理念：做减法与专注盲区 (Subtraction Strategy)
在 AI 编码时代，最昂贵的动作不是“写”，而是“确认修改的影响”。

本系统专门采用 **“做减法与专注盲区” (Subtraction & Blind-spot Focus)** 策略。它静静潜伏在您的 IDE（如 Claude Desktop 或 Cursor）后台，致力于为您提供**低噪、高优的跨层级依赖预警**，彻底摒弃那些让人眼花缭乱且极度消耗 Token 的全量依赖图谱。它专治 AI 进行跨语言、跨框架修改时的上下文缺失问题。

## 🚀 核心看点与最新优化

在经历了一系列深度重构后，Guardian 实现了从“堆砌数据”到“精准狙击”的蜕变：

- 🎯 **高信噪比的定向追踪 (Sniper Tools)**：
  - 弃用臃肿且噪音巨大的通用依赖分析接口（如旧版 `impact_brief`）。
  - **`find_xml_mapping`**: 专供修改 MyBatis Mapper 时强制触发，直达 XML SQL 映射盲区防越界。
  - **`find_frontend_api_calls`**: 专注跨端依赖分析，打通 Java Controller 与 Vue/React 前端代码的 API 隐式调用关联。
  - **`find_cross_module_deps`**: 核心服务重构前预检，精准剪枝提取 Top 5 最具破坏性的跨目录/跨模块依赖涟漪。
- ⚡ **O(1) 毫秒级底层索引**：
  - 弃用缓慢的 JS 全表扫描，全面改用 **SQLite B-Tree 索引** 查询。
  - 启用 **SQLite WAL 模式** 与 **预编译 SQL 缓存**，将元数据条件检索全数下推至 SQLite `json_extract` 底层。
- 🔄 **强一致性实时感知 (`sync_file`)**: 
  - 升级 Watcher，彻底杜绝僵尸节点重现。用户发生代码修改后，系统秒级防抖并重建映射圈。
- 🌊 **高并发与流式架构**: 
  - 基于 `spawn + readline` 的非阻塞流式处理，彻底消除大型项目 OOM 危机；基于 `Promise.allSettled` 并发分发 LSP 解析任务。

## 🛠 配置与运行 (静默模式)

本系统作为 MCP Server 运行，无需手动在终端启动。请将其配置到您的 AI 客户端中：

### 推荐配置

在对应的 MCP 配置文件中添加以下内容（请确保已安装 `npx` 等运行依赖）：

```json
{
  "mcpServers": {
    "cognitive-guardian": {
      "command": "npx",
      "args": ["tsx", "~/cognitive-guardian/src/main.ts"]
    }
  }
}
```

> [!NOTE]
> **自动初始化**：当您在 AI 助手环境调用并进入目标项目文件夹时，系统会自动在目标工程的根目录下创建 `.guardian/` 文件夹来存放独立数据库索引与排错日志。它不会侵入业务代码，可以放心接纳或按需配置 `.gitignore`。

### 开发者模式 (手动调试)
如果您需要观察内部的工具输出与流转过程：
```bash
npm install
npm run dev
```

## 🤖 引导 AI 正确使用 (强烈推荐)

本 MCP 的最大发挥前提是 **让 AI 知道它现在拥有一把狙击枪，而不是霰弹枪**。

强烈建议将本仓库中的 [`AI_AGENT_INSTRUCTIONS.md`](AI_AGENT_INSTRUCTIONS.md) 的全部内容提取，合并写入到您目标业务工程根目录下的以下任意引导文件中：
- `.cursorrules` (若使用 Cursor)
- `CLAUDE.md` (若使用 Claude UI / Code)
- 或以 System Prompt 形式配置给您的代理客户端。

## 📂 项目模块结构
- `src/engine/`: 中枢扫描引擎、核心业务逻辑聚合与流式提取器、并发 FileWatcher。
- `src/mcp/`: 标准化大模型对话接口层 (MCP 工具箱，包含核心三板斧 `find_xml_mapping`, `find_frontend_api_calls`, `find_cross_module_deps` 等)。
- `src/storage/`: 基于 SQLite WAL 与原生 JSON 解析优化的知识持久化检索层。
- `src/main.ts`: 协议激活入口基座。

## 🛡️ License
ISC
