# Systemic Cognitive Guardian (v1.5)

> **极速拓扑感应器** —— 这是一个为 AI 开发者量身定制的、**全自动静默运行**的 MCP Server，致力于提供工业级、低延迟的代码上下文感知能力。

## 🌟 核心理念：AI 的“副驾驶导航仪”
在 AI 编码时代，最昂贵的动作不是“写”，而是“确认修改的影响”。

本系统采用 **“前台极速解析 + 后台静默索引”** 架构。它静静潜伏在您的 IDE（如 Claude Desktop 或 Cursor）后台，当 AI 准备修改代码时，它能秒级提供全局视野，准确指出跨文件、跨模块甚至跨端的连锁反应。

## 🚀 核心看点与最新优化 (IDEA 架构级提速)

在经历了一系列深度重构后，Guardian 从原型系统正式蜕变为具备工业级鲁棒高性能的代码导航引擎：

- ⚡ **O(1) 毫秒级感应**：
  - 弃用缓慢的 JS 全表扫描，全面改用 **SQLite B-Tree 索引** 查询。
  - 启用 **SQLite WAL 模式** 与 **预编译 SQL 缓存**，将元数据条件检索全数下推至 SQLite `json_extract` 底层，使初始化与增量更新极速完成。
  - 采用并行的异步 I/O (消除大规模 `statSync` 长耗时阻塞)。
- 🔄 **强一致性实时感知 (`sync_file`)**: 
  - 新增专用 MCP 强制同步工具。AI 发生代码修改后，可通过该接口显式穿透系统防抖延迟，瞬间获得毫无时差的最新知识图谱。
  - 升级 Watcher，彻底杜绝僵尸节点重现。
- 🌊 **高并发与流式架构**: 
  - 将庞大的 Git 历史分析从阻塞式重构为 **`spawn + readline` 非阻塞流式处理**，彻底消除在巨型项目上的 OOM(内存溢出) 危机。
  - 基于 `Promise.allSettled` 并行发发调度 LSP 解析任务，化解串行拖拽耗时。
- 🛡️ **优雅降级安全策略**: 
  - 阶梯式探测：优先唤起 LSP，出现死锁或超时则安全降级回 Tree-sitter 无损静态树解析。全链路实现空指针防御检查。

## 🛠 配置与运行 (静默模式)

本系统作为 MCP Server 运行，无需手动在终端启动。请将其配置到您的 AI 客户端中：

### 推荐配置

在对应的 MCP 配置文件中添加以下内容（请确保已安装 `npx` 等依赖）：

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
> **自动初始化**：当您在 AI 助手环境调用并进入目标项目文件夹时，系统会自动在目标工程的根目录下创建 `.guardian/` 文件夹来存放独立数据库索引与排错日志。它不会侵入业务代码，可以放心按需配置 `.gitignore`。

### 开发者模式 (手动调试)
如果您需要观察内部的流转与解析网络：
```bash
npm install
npm run dev
```

## 📂 项目模块结构
- `src/engine/`: 中枢扫描引擎 (Orchestrator)、Git 脉络流式重构提取、并发 FileWatcher。
- `src/mcp/`: 标准化大模型对话接口层 (MCP工具箱包含 `impact_brief`, `sync_file` 等)。
- `src/storage/`: 基于 SQLite WAL 与原生 JSON 解析优化的知识持久化检索层。
- `src/main.ts`: 协议激活入口基座。

## 🛡️ License
ISC
