# Cognitive Guardian AI Agent Instructions (Smart Pruning Edition)

作为接入了 Cognitive Guardian MCP 的 AI 编程助手，请遵循以下核心准则来使用本系统。
Cognitive Guardian 的核心设计哲学是 **"做减法与专注盲区" (Subtraction & Blind-spot Focus)**。它专门为你提供低噪、高优的跨层级依赖预警，而非返回让你眼花缭乱的全量图谱。

## 🎯 核心认知：你的痛点，它来解决

- 你能轻易通过阅读当前文件了解内部调用，能通过全局文本/Grep搜索找到普通的 Java 调用。所以 Guardian **不会** 也 **没必要** 为你查询同文件、同包下的显式调用。
- 你无法直接通过普通搜索关联的盲区：
  1. **Java Mapper 接口 -> MyBatis XML SQL 的映射**
  2. **Java Controller API -> Vue/前端 的跨栈调用**
  3. **模块级别的深度/隐式跨模块依赖**
- Guardian 专门为你配备了这三把“狙击枪”工具，请在修改代码前**主动**、**高频**调用它们。

## 🚥 神枪手工具链 (Sniper Tools)

### 1. `find_xml_mapping` -> (修改 MyBatis DAO 时 **强制要求**)
当用户要求你修改任何 `*Mapper.java` 接口的签名、参数或逻辑时：
- **动作**: 你必须立即调用此工具，传入 Mapper 类名。
- **目的**: 找出藏在 `src/main/resources/mapper` 中的 XML 标签定义，防止出现接口改了但 SQL 映射错位导致的项目崩溃。

### 2. `find_frontend_api_calls` -> (修改 Controller 时 **强制要求**)
当用户要求你重定义任何 REST 端点（Controller方法、`@RequestMapping` 路径、数据结构）时：
- **动作**: 必须立即调用此工具，传入 Controller 路径或方法名。
- **目的**: 越界到 Vue 层，找出谁调用了此接口。修改后端必须同时兼容或调整前端 `axios` / API 文件。

### 3. `find_cross_module_deps` -> (重构核心 Service 时 **按需预查**)
当你准备大幅重构或修改一个基础层 `Service` / `Utils` 时：
- **动作**: 调用此工具。
- **目的**: 系统会剪枝过滤出那些处于**其他目录界限外**调用本逻辑的“跨界依赖”(Top 5)。让你知道自己的改动是否具有极高的破坏性涟漪。

## ❌ 什么时候不需要用 Guardian
1. 查找普通的 Java-to-Java 同层级调用（你的原生内置工具或 Grep 足够快且准）。
2. 只读任务（仅仅是理解代码逻辑）。
3. 前端界面样式修改（不涉及后端数据接口）。

## 💡 最佳实践
- **拒绝漫无目的搜罗**: 不要试图查找一个没有实际影响意义的普通变量或私有方法。
- **直接拿结果办事**: 返回的信息已经过剪枝过滤（包含了所在文件、行号和代码片段），直接据此去修改 `XML` 或 `.vue`，无需在此过程中消耗 Token 二次过滤！
