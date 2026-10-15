# 将自己的 Agent 接入 Agent EVO

产品负责人：准备问题与预期，确认后冻结题库；选择连接和 Agent 版本，先创建一道题的任务。

开发维护者只需配置一次。Agent 可以留在个人电脑、内网、云服务器或 CI，不需要开放入站端口。连接器主动领取任务，调用已有业务入口，再上传结果。公共平台不执行你的 Python 脚本。

## HTTP 入口

接口收到 JSON：`message`、`conversation_id`、`turn_index`、`history`。同题顺序执行；题间和重复执行分别创建会话。不包含预期答案或评分规则。

接口返回 `{ "answer": "实际回答", "conversation_id": "实际会话 ID", "steps": [], "usage": {} }`。字段不同可通过 `--answer-path data.answer`、`--session-path data.session_id` 映射。步骤和用量可选；缺失时只评回答，不推断工具根因。

在 PowerShell 中配置（替换占位符，不上传这些值）：

```powershell
$env:EVO_CONNECTOR_TOKEN = '<工作台生成的授权>'
$env:EVO_AGENT_TOKEN = '<你的业务接口凭证；无需认证时不设置>'
python evo_connector.py --platform https://你的站点 --url http://127.0.0.1:8001/chat --version v2
```

网站直连只允许管理员在 `EVO_HTTP_ORIGINS` 批准的 HTTPS 域名；私有网络或未批准的域名均走客户侧连接器。此限制不会阻止你在自己的电脑上调用自己的 HTTP Agent。

## Python / SDK

提供可信本地函数 `run_turn(message, conversation_id, history, turn_index)`，返回与上面相同的字典。维护者负责在函数中调用真实业务入口。

```powershell
python evo_connector.py --platform https://你的站点 --adapter my_agent:run_turn --version v2
```

LangGraph 可从随附 `langgraph_adapter.py` 开始，将导入替换为项目现有 compiled graph。适配样本使用 checkpointer 的 thread_id；无 checkpointer 的图须自行传递 history，不能重复传入双份上下文。

## 上报范围与恢复

默认上传问题、回答、会话与版本；执行步骤默认不上报。先检查本地结果的脱敏情况，再设置 `EVO_INCLUDE_STEPS=1` 上传业务步骤。模型用量来源为 Agent 自报，不冒充服务商核验。

连接器将运行前状态和结果持久写入当前目录 `.evo-connector.sqlite`。重启仅重传已有结果，不重新执行已经领取过的任务。租约失效或取消后保留本地结果，人工确认业务是否执行；不要通过删除状态文件强制重复有副作用的操作。

项目授权只允许指定连接领取任务，不可读取题库预期和其他项目。可以在工作台撤销；授权只在生成时显示一次。

## 离线执行

在任务中下载执行问题包，再运行：

```powershell
python evo_connector.py --bundle 执行问题包.json --url http://127.0.0.1:8001/chat --version v2 --output 执行结果.json
```

先检查输出，再在原任务中导入结果包。包必须匹配 project_id、job_id、dataset_version、attempt_id、case_id、repeat；冲突结果不覆盖历史。离线上传会标记来源未独立核验，不能冒充平台发起的执行证据。

## 评分与决策

取得回答后，使用百炼裁判独立评审；Agent 凭证与百炼 Key 分开。题库没有事实参考时保留事实评分缺口。报告列出问题、证据和下一步，支持审核、版本对比和创建独立回归任务。一个高分不代表覆盖所有业务要求。


## Dify 与 LangChain

- Dify：下载 `dify_adapter.py` 与连接器放同一目录，设置 `EVO_DIFY_URL` 为 API base（例如 https://api.dify.ai/v1），`EVO_DIFY_KEY` 为已有应用 Key，执行 `--adapter dify_adapter:run_turn`。SSE 模式支持聊天/Agent 消息；只记录接口实际返回的节点或检索资源，不能保证全链路齐全。新会话使用独立用户标识，同一题的后续轮次保留它与 Dify conversation_id。输入变量可在客户本机设置 `EVO_DIFY_INPUTS` JSON。
- LangChain：设置 `EVO_LANGCHAIN_TARGET=my_application:agent`，执行 `--adapter langchain_adapter:run_turn`。调用已有对象的 `invoke`，默认显式传历史；若已有 Agent 使用 checkpointer，设置 `EVO_LANGCHAIN_MEMORY=checkpointer`，避免重复注入历史。不同 Runnable 输出结构需在适配器中映射。
- 这两份适配器按官方协议实现，自动化验证会话与返回处理；没有你的真实 Dify 应用/SDK 配置时，不能宣称已接通你的产品。

官方协议：https://docs.dify.ai/en/api-reference/chat-messages/send-chat-message 、https://docs.langchain.com/oss/python/langchain/agents 。

## 预约、暂停与条件追问

运行任务可选未来 31 天内的一次性开始时间；客户连接器需要在线，到时主动领取。暂停只阻止新领取，正在进行的对话仍可完成；取消使正在执行的剩余轮次停止，原系统已产生的动作不会撤回。恢复不重跑未知结果。

编辑问题时可为第 2 轮起添加条件：上一回答包含某个关键词则发送另一条已确认的问题，否则发送默认问题。仅使用字符串包含判断，区分大小写；最大 20 轮，不额外调用用户模拟模型。上报时保留实际提问路径，服务端校验路径。两个版本走了不同追问路径时不输出同题改善分数结论。
