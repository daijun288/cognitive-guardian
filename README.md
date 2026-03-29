# Systemic Cognitive Guardian (v1.0)

> **极速拓扑感应器** —— 这是一个为 AI 开发者量身定制的、**全自动静默运行**的 MCP Server。

## 🌟 核心理念：AI 的“副驾驶导航仪”
在 AI 编码时代，最昂贵的动作不是“写”，而是“确认修改的影响”。 

本系统采用 **“前台极速解析 + 后台静默索引”** 的 v1.0 架构。它平时静静潜伏在您的 IDE（如 Claude Desktop 或 Cursor）后台，当 AI 准备修改代码时，它能秒级提供全局视野，准确指出跨文件、跨模块甚至跨端的连锁反应。

## 🚀 v1.0 特色
- **🌩️ 零启动 (Zero-Init)**：您无需手动调用初始化指令。系统在 AI 列表加载工具时即自动开启后台异步扫描。
- **⚡ 毫秒级感应**：核心上下文获取耗时 **< 50ms**，响应体感等同于本地 `grep`。
- **🛡️ 纯净隔离**：项目日志与数据库自动存储在各项目的 `.guardian/` 目录中，主程序目录保持绝对纯净。
- **📈 智能加权**：融合 Git 协同修改历史，优先展示真正在逻辑上紧密关联的影响点。

## 🛠 配置与运行 (静默模式)

本系统作为 MCP Server 运行，无需手动在终端启动。请将其配置到您的 AI 客户端中：

### 推荐配置 (Claude Desktop / Cursor)
在配置文件中添加以下内容（请确保已安装 `npx` 和 `typescript-language-server`）：

```json
{
  "mcpServers": {
    "cognitive-guardian": {
      "command": "npx",
      "args": ["tsx", "D:/dev/ai-workspace/ai-viewer/src/main.ts"]
    }
  }
}
```

> [!NOTE]
> **自动初始化**：当您在 Claude 或 Cursor 中启用此服务并进入目标项目文件夹时，系统会自动在项目根目录下创建一个 `.guardian/` 文件夹，用于存放索引缓存和分析日志。请将其加入您的 `.gitignore` 文件中。


### 开发者模式 (手动调试)
如果您需要观察内部解析逻辑：
```bash
npm install
npm run dev
```

## 📂 项目结构
- `src/engine/`: 核心扫描引擎 (Orchestrator)、Git 分析器与 LSP 客户端。
- `src/mcp/`: MCP 协议对接，包含 `impact_brief` 等极简工具。
- `src/storage/`: 知识图谱持久化层。
- `src/main.ts`: MCP 启动入口。

## 🛡️ License
ISC
