# 本地运行与第一次评测

[返回项目首页](../README.md)

## 环境

- Python 3.12–3.14，推荐 3.12；使用 uv 安装锁定依赖。
- Node.js 24+ 与 npm。项目工作台使用 Node 内置 SQLite，Node 20 无法启动这部分服务。
- 本地端口 8090（页面与 API）和 8198（工作台内部服务）可用。

在仓库根目录执行：

```bash
uv sync --python 3.12 --extra dev --locked
npm --prefix web ci
npm --prefix web run build
uv run uvicorn agent_evo.api:app --host 127.0.0.1 --port 8090
```

打开 <http://127.0.0.1:8090/?space=native&view=evaluate>。主服务会自动启动工作台内部服务并创建 `.local/` 中的 SQLite 文件；不要同时运行多个 worker，也不要使用 `--reload`。按 Ctrl+C 停止。

前端开发时可以另开终端执行 `npm --prefix web run dev`，访问 <http://127.0.0.1:5190/?space=native&view=evaluate>；API 仍需运行在 8090。

## 第一次体验：从已有回答开始

1. 选择评估已有回答，使用 [`answers.csv`](../web/public/templates/answers.csv) 或 [`answers.xlsx`](../web/public/templates/answers.xlsx)。内容完全合成，包含一条故意沿用旧时间的回答。
2. 核对问题、回答与参考字段。导入和查看材料本身不需要模型凭证。
3. 按页面提示配置百炼凭证和可用模型，再发起评审。模型调用会使用自己的服务额度。
4. 打开某条记录，对照原文和判断依据进行复核；需要报告时再生成并导出。

也可以在项目工作台新建项目，说明服务对象、任务和限制，导入问题模板或让 AI 起草题目，审核后保存为题库版本。

## 查看一条记录的处理过程

打开评测记录，选择“处理过程”，即可按三层查看：

1. **先看做了什么**：默认显示“识别咨询意图”“检索临床资料”等中文动作，以及结果摘要、状态和已记录的耗时。
2. **点击步骤看详情**：查看保存的输入、检索问题、工具、资料来源、处理结果和异常提示。
3. **展开原始执行记录**：核对完整事件 JSON；底部“评测准备与完整记录”还保留任务安排、连接和评测汇总事件。

多轮对话按轮次展示，补充检索会保留为不同步骤。没有保存的输入或耗时会明确注明；只导入问答、没有内部步骤的记录，不会自动补出执行过程。查看这些内容不需要调用模型。

已有本地安装需要拉取更新后重新执行 `npm --prefix web run build`，再重启本地服务。此次更新不需要迁移数据库或重新运行旧评测。

## 模型与环境配置

[`.env.example`](../.env.example) 是变量参考，**应用不会自动加载 `.env`**。请在启动进程的环境中设置需要的变量。例：

```powershell
# PowerShell；只在需要服务器侧模型评审时设置真实值
$env:DASHSCOPE_API_KEY = '<自己的百炼凭证>'
$env:EVO_CONTEXT_JUDGE_MODEL = '<账号可用的模型名称>'
$env:EVO_REPORT_MODEL = '<账号可用的模型名称>'
uv run uvicorn agent_evo.api:app --host 127.0.0.1 --port 8090
```

```bash
# macOS / Linux
export DASHSCOPE_API_KEY='<自己的百炼凭证>'
export EVO_CONTEXT_JUDGE_MODEL='<账号可用的模型名称>'
export EVO_REPORT_MODEL='<账号可用的模型名称>'
uv run uvicorn agent_evo.api:app --host 127.0.0.1 --port 8090
```

原生后台任务使用进程环境；通用项目工作台中的出题和评审按页面提示提交模型凭证。模型名称要以自己的账号实际权限为准，仓库默认值不保证每个账号可用。未配置模型时，仍可导入和整理材料，但不能完成 AI 评审。

## 连接自己的 Agent

先在项目里创建连接，再生成该连接的授权。下面以本地 HTTP Agent 为例：

```powershell
$env:EVO_CONNECTOR_TOKEN = '<工作台生成的授权>'
uv run python examples/evo_connector.py --platform http://127.0.0.1:8090 --url http://127.0.0.1:8001/chat --version v1
```

连接器发送 `message`、`conversation_id`、`history` 和 `turn_index`，接口返回 `answer` 与实际 `conversation_id`。接口字段不同可以配置映射。完整协议、Python 适配、离线执行和恢复方式见[连接器指南](../web/public/templates/connector-guide.md)。

不要在真实有副作用的业务系统上直接运行未审核的测试；先选合成场景和测试账号。连接器本机状态文件用于避免结果不明时重复执行，应保留。

## Clinical 与 UniHR 的关系

通用评测不依赖这两个产品。仓库保留早期专用适配器和合成接口与行为测试，当前内置业务示例入口只展示 Clinical。要真实执行 Clinical，需要独立部署对应业务服务，并配置 `EVO_CLINICAL_BASE_URL`；可选源码指纹与证据采集通过 `EVO_CLINICAL_SOURCE_ROOT` 指定。

本仓库不包含 Clinical 服务、知识库或其模型凭证。`external/` 下的默认路径只是可选依赖位置，不会自动下载其他项目。官网已有的历史案例也不会被复制到新建的本地工作台。

## 验证

```bash
uv run pytest -q
npm --prefix web test
node --test integrations/workbench/*.test.mjs
npm --prefix web run build
```

测试使用合成材料、临时数据库与模拟响应，不需要付费模型调用。`npm --prefix web run test:historical` 是原部署历史快照的单独验收脚本，依赖未随源码发布的 `.local/public-clinical/`，不属于默认测试。

## 常见问题

| 现象 | 检查方法 |
| --- | --- |
| 页面正常，项目工作台返回 503 | 确认 `node --version` 为 24+，8198 未被占用，再重启主进程 |
| 修改源码后页面没有变化 | 重新构建前端，或使用 5190 开发入口 |
| AI 评审提示模型无权限或额度不足 | 检查当前界面的模型配置、凭证与账号额度；已导入材料仍会保留 |
| 内置 Clinical 运行失败 | 该入口依赖单独的 Clinical 服务；可先使用回答导入或自己的 Agent 连接 |
| 官网历史案例在本地没有数据 | 在线快照独立部署；本地源码从空运行记录开始 |

本地模式按单人、回环地址设计。共享部署涉及身份认证、TLS、数据备份和模型凭证管理，见[架构说明](architecture.md)；不要仅把监听地址改成公网地址就作为多用户服务发布。
