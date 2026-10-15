from __future__ import annotations

from typing import Any

from agent_evo.store import Store
from agent_evo.conversation import answer_text
from agent_evo.context_judge import judge_context


def _mapping(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _trace(case: dict, output: dict) -> dict:
    result = _mapping(output.get("result"))
    if case["agent"] != "unihr":
        return _mapping(result.get("trace"))
    return _mapping(result.get("interpretation"))


def _source_ids(items: object) -> set[str]:
    if not isinstance(items, list):
        return set()
    ids = set()
    for item in items:
        if isinstance(item, str):
            ids.add(item)
        elif isinstance(item, dict):
            source_id = item.get("source_id") or item.get("document_id") or item.get("chunk_id") or item.get("id")
            if source_id:
                ids.add(str(source_id))
    return ids


def evaluate_run(store: Store, run_id: str) -> dict:
    run = store.get_run(run_id)
    case = store.get_case(run["case_id"])
    output = _mapping(run.get("output"))
    result = _mapping(output.get("result"))
    trace = _trace(case, output)
    expected = _mapping(case.get("expected"))
    events = store.events(run_id)
    findings: list[dict] = []

    def record(dimension: str, status: str, rationale: str, evidence: list[str],
               *, critical: bool = False, hypothesis: str | None = None,
               alternative: str | None = None, replay: str | None = None, evaluator: str = "deterministic-v1") -> None:
        store.add_verdict(run_id, dimension, evaluator, status, rationale, evidence, critical)
        findings.append({"dimension": dimension, "status": status, "critical": critical,
                         "rationale": rationale, "evidence": evidence,
                         "hypothesis": hypothesis, "alternative": alternative,
                         "controlled_replay": replay, "evaluator": evaluator})

    execution_ref = f"run:{run_id}"
    failed_business_events = [e for e in events if e["kind"] in {"business_event", "business_step", "business_trace"}
                              and e["status"].lower() in {"failed", "error", "timed_out", "blocked"}]
    if failed_business_events:
        first = failed_business_events[0]
        record("business_node", "fail", f"首个报告失败的业务节点：{first['node']}（事件 #{first['seq']}）。",
               [f"event:{first['seq']}"], hypothesis=f"{first['node']} 节点或其依赖失败",
               alternative="该节点可能只报告上游故障；需要展开事件载荷和前序节点",
               replay="固定同一输入与版本，先核对该节点前后的业务事件，再新建 run。")
    if run["status"] != "completed":
        from agent_evo.evidence import execution_category
        record("business_execution", "unjudged" if execution_category(run) == 'environment_blocked' else "fail", f"业务任务状态为 {run['status']}；错误码 {run.get('error_code') or 'unknown'}；执行状态与回答质量分别判断。",
               [execution_ref], hypothesis="接入、业务服务或内部节点失败",
               alternative="需要检查业务事件确定首个失败节点",
               replay="修复依赖后从原用例创建新 run，保留旧 run。")
    else:
        record("business_execution", "pass", "业务入口返回完成状态。", [execution_ref])

    usage = _mapping(run.get("model_evidence"))
    model_dimension = "recorded_model" if run.get("execution_mode") == "recorded" else "live_model"
    if case.get("model_required"):
        if usage.get("verified") and run["model_calls"] >= int(expected.get("required_model_calls") or 1):
            record(model_dimension, "pass", f"{'历史' if model_dimension == 'recorded_model' else '本次'}业务用量证据记录 {run['model_calls']} 次成功模型调用。",
                   ["model_evidence"])
        else:
            record(model_dimension, "unjudged", "未取得足够的业务模型用量证据；不能计入真实百炼完成数。",
                   ["model_evidence"], hypothesis="模型未调用或用量读取失败",
                   alternative="业务模型事件可能写在另一存储中",
                   replay="核对业务用量库与 run ID，必要时修复适配器后新建 run。")

    expected_intent = expected.get("intent")
    actual_intent = trace.get("business_intent" if case["agent"] == "unihr" else "intent")
    if expected_intent:
        if actual_intent is None:
            record("intent", "unjudged", "路由意图字段缺失，无法判断意图识别。", ["output.result.interpretation" if case["agent"] == "unihr" else "output.result.trace"])
        else:
            okay = str(actual_intent) == str(expected_intent)
            record("intent", "pass" if okay else "fail",
                   f"预期意图 {expected_intent}，实际意图 {actual_intent}。",
                   ["output.result.interpretation.business_intent" if case["agent"] == "unihr" else "output.result.trace.intent"],
                   hypothesis=None if okay else "意图识别或路由选择偏离用例预期",
                   alternative=None if okay else "工程草案金标可能需要业务复核",
                   replay=None if okay else "固定代码与模型版本重跑同案，对比路由输入和业务 trace。")

    if expected.get("must_retrieve"):
        if case["agent"] != "unihr":
            needs = trace.get("needs_retrieval")
            candidates = trace.get("retrieval_candidate_count")
            selected = _source_ids(trace.get("selected_sources"))
            if needs is False:
                record("retrieval_plan", "fail", "预期检索，但路由计划跳过检索。", ["output.result.trace.needs_retrieval"],
                       hypothesis="意图或检索计划错误", alternative="用例预期可能不适合信息不足场景",
                       replay="复核金标后，用相同输入对比意图、信息完整性和检索计划。")
            elif needs is True:
                record("retrieval_plan", "pass", "业务计划要求检索。", ["output.result.trace.needs_retrieval"])
            else:
                record("retrieval_plan", "unjudged", "未取得检索计划字段。", ["output.result.trace"])
            if needs is True:
                if trace.get("retrieval_error"):
                    record("retrieval", "fail", "检索执行报告错误。", ["output.result.trace.retrieval_error"],
                           hypothesis="检索服务、索引或查询执行失败", alternative="检索计划也可能不适用",
                           replay="核对索引快照和依赖健康，同案受控重跑。")
                elif isinstance(candidates, int) and candidates == 0:
                    record("retrieval", "fail", "检索未返回候选材料。", ["output.result.trace.retrieval_candidate_count"],
                           hypothesis="查询改写、索引覆盖或召回失败", alternative="知识库可能确实缺资料",
                           replay="保存查询和知识快照，用人工查询验证目标材料存在后重跑。")
                elif isinstance(candidates, int):
                    record("retrieval_execution", "pass", f"检索返回 {candidates} 个候选材料；材料质量另行判断。", ["output.result.trace.retrieval_candidate_count"])
                    record("retrieval", "unjudged", "已取得候选材料；数量不能证明材料相关、充分或支持回答。", ["output.result.trace.retrieval_candidate_count"])
                else:
                    record("retrieval", "unjudged", "缺检索候选数，无法判断召回。", ["output.result.trace"])
                gold = set(map(str, expected.get("source_ids") or []))
                if expected.get('source_match') == 'groups':
                    gold |= {str(source) for group in expected.get('source_groups', []) for source in group}
                if gold:
                    expected_corpus = expected.get("corpus_sha256")
                    actual_corpus = _mapping(run.get("version")).get("local_corpus_sha256")
                    if expected_corpus and expected_corpus != actual_corpus:
                        record("source_selection", "unjudged", "知识快照与用例冻结快照不一致，不能判定材料选择。",
                               ["case.expected.corpus_sha256", "run.version.local_corpus_sha256"],
                               hypothesis="知识库版本变化或本地快照缺失",
                               replay="恢复原知识快照或为新快照审核来源 ID 后新建用例版本。")
                    else:
                        found = gold & selected
                        mode = expected.get('source_match', 'all')
                        groups = expected.get('source_groups') or []
                        matched = bool(found) if mode == 'any' else gold <= selected
                        if mode == 'groups':
                            matched = bool(groups) and all(set(map(str, group)) & selected for group in groups)
                        gold_label = "工程草案目标来源" if case["gold_status"] == "engineering_draft" else "已审核金标来源"
                        record("source_selection", "pass" if matched else "fail",
                               f"{gold_label} {sorted(gold)}；实际选中 {sorted(selected)[:10]}；命中 {len(found)}/{len(gold)}。",
                               ["case.expected.source_ids", "output.result.trace.selected_sources"],
                               hypothesis=None if matched else "候选召回或来源选择错误",
                               alternative=None if matched else "工程草案来源需复核；当前 trace 可能不包含全部候选 ID",
                               replay=None if matched else "在同一知识快照下比对候选列表、重排和选择结果。")
                else:
                    record("source_selection", "unjudged", "用例尚无已审核的目标来源 ID；不能断言 RAG 找错材料。",
                           ["case.expected.source_ids", "output.result.trace.selected_sources"])
                sufficient = trace.get("evidence_sufficient")
                if sufficient is False:
                    record("evidence_sufficiency", "fail", "业务证据充分性检查未通过。", ["output.result.trace.evidence_sufficient"],
                           hypothesis="所选证据无法支持回答", alternative="可能是安全的证据不足应答",
                           replay="比对选中材料和回答中的逐项主张，再人工复核。")
        else:
            mode = trace.get("retrieval_mode")
            if mode is None:
                record("retrieval_plan", "unjudged", "缺 UniHR 检索模式字段。", ["output.result.interpretation"])
            else:
                record("retrieval_plan", "pass" if mode != "none" else "fail",
                       f"业务检索模式为 {mode}。", ["output.result.interpretation.retrieval_mode"],
                       hypothesis="路由未选择检索" if mode == "none" else None,
                       alternative="工程草案预期可能需要复核" if mode == "none" else None)
            retrieval_events = [e for e in events if "retriev" in e["node"].lower() or "knowledge" in e["node"].lower()]
            if not retrieval_events:
                record("retrieval", "unjudged", "未观察到可核验的检索事件；不能断言召回正确。", ["events"])
            elif any(e["status"] in {"failed", "error"} for e in retrieval_events):
                record("retrieval", "fail", "检索节点报告失败。", [f"event:{e['seq']}" for e in retrieval_events if e["status"] in {"failed", "error"}])
            else:
                record("retrieval", "unjudged", "存在检索事件，但缺审核过的目标材料和逐项召回金标。",
                       [f"event:{e['seq']}" for e in retrieval_events[:5]])

    if case.get("case_context_text") and not case.get("turns"):
        setup = [e for e in events if e["node"] == "clinical.setup_turn"]
        used = trace.get("case_context_used")
        if not setup:
            record("context", "fail", "没有观察到真实的上一轮对话。", ["events"],
                   hypothesis="病例准备或上轮对话未完成", alternative="业务可能在其他线程保存记录",
                   replay="用相同合成病例重新建立上下文并保存上轮业务 run ID。")
        elif used is False:
            record("context", "fail", "上一轮对话存在，但最终 trace 报告未使用病例上下文。",
                   [f"event:{setup[0]['seq']}", "output.result.trace.case_context_used"],
                   hypothesis="上下文装配或病例关联失败", alternative="业务 trace 字段可能与实际模型输入不一致",
                   replay="固定病例 ID 和 thread ID，核对 Context 子图输入与最终提示上下文。")
        elif used is True:
            record("context", "pass", "上一轮对话存在且业务 trace 报告使用病例上下文。",
                   [f"event:{setup[0]['seq']}", "output.result.trace.case_context_used"])
        else:
            record("context", "unjudged", "已有上一轮对话，但最终 trace 缺上下文使用字段。",
                   [f"event:{setup[0]['seq']}", "output.result.trace"])

    artifacts = store.artifacts(run_id)
    expected_extensions = expected.get("artifact_extensions") or []
    if expected_extensions:
        matching = [a for a in artifacts if any(a["filename"].lower().endswith(str(ext).lower()) for ext in expected_extensions)]
        good = [a for a in matching if a["checks"].get("opened")]
        record("artifact", "pass" if good else "fail",
               f"预期 {', '.join(map(str, expected_extensions))} 文件；可打开 {len(good)}/{len(matching)}。",
               [f"artifact:{a['artifact_id']}" for a in matching] or ["output.result.artifacts"],
               hypothesis=None if good else "文件未生成、下载失败或文件损坏",
               alternative=None if good else "业务返回可能使用其他格式",
               replay=None if good else "用原始附件和模板重新执行，检查业务生成与下载节点。")

    if case["risk_level"] == "critical":
        if case["agent"] == "clinical":
            safety = trace.get("safety_review_status")
            if safety in {"failed", "blocked", "unsafe"}:
                record("critical_safety", "fail", f"业务安全复核状态为 {safety}。",
                       ["output.result.trace.safety_review_status"], critical=True)
            elif safety:
                record("critical_safety", "unjudged", f"业务安全复核状态为 {safety}；仍需医生逐案确认。",
                       ["output.result.trace.safety_review_status"], critical=True)
            else:
                record("critical_safety", "unjudged", "缺安全复核证据且无医生金标，临床安全不能判通过。",
                       ["output.result.trace.safety_review_status"], critical=True)
        else:
            run_view = _mapping(result.get("run"))
            issues = run_view.get("quality_issues") or []
            record("critical_safety", "unjudged", f"关键{' HR' if case['agent'] == 'unihr' else '通用'}用例需要逐案人工复核，不能由总分判通过。",
                   ["output.result.run.quality_issues", "case.expected"], critical=True,
                   hypothesis=f"业务质量标记：{', '.join(map(str, issues))}" if issues else None)

    if case["agent"] == "generic" and expected.get("output_contains"):
        body = result.get("answer", "")
        required = expected["output_contains"]
        required = [required] if isinstance(required, str) else required
        if isinstance(required, list) and all(isinstance(item, str) for item in required):
            if not isinstance(body, str):
                record("answer", "unjudged", "未取得回答正文字段，不能检查预期文本。", ["output.result.answer"])
            else:
                missing = [item for item in required if item not in body]
                record("answer", "fail" if missing else "pass", f"预期文本检查：{len(required)-len(missing)}/{len(required)} 项命中。", ["output.result.answer", "case.expected.output_contains"])

    if case.get("turns"):
        rows = output.get("conversation_turns") or []
        for index, turn in enumerate(case["turns"], 1):
            row = next((item for item in rows if item.get("turn_index") == index), {})
            refs = [f"output.conversation_turns[{index - 1}]", f"case.turns[{index - 1}]"]
            if run.get("execution_mode") == "recorded":
                record("recorded_answer", "pass" if row.get("answer_coverage") == "full" else "unjudged",
                       f"第 {index} 轮：{'保存了完整回答' if row.get('answer_coverage') == 'full' else '仅有摘要或回答缺失，不能完整判分'}。", refs)
                for dimension, label in (("intent", "意图识别"), ("retrieval", "材料召回"), ("source_selection", "材料选择")):
                    record(dimension, "unjudged", f"第 {index} 轮 · {label}：保留原始节点，尚无人工审核目标，不能断言正确。", refs)
                if case["agent"] == "clinical":
                    record("critical_safety", "unjudged", f"第 {index} 轮：医疗工程记录需医生独立复核。", refs, critical=True)
            session_ok = row.get("session_verified")
            session_result = "pass" if session_ok else "fail" if row.get("error_code") in {"conversation_session_mismatch", "conversation_business_id_invalid"} else "unjudged"
            record("context_session", session_result, f"第 {index} 轮：{'业务会话关联已核对' if session_ok else row.get('error_code') or '缺少可核对会话证据'}。", refs)
            model_ok = row.get("model_evidence", {}).get("verified") and row.get("model_calls", 0) > 0
            record("context_model_evidence", "pass" if model_ok else "unjudged", f"第 {index} 轮：{'取得独立模型证据' if model_ok else '未取得本轮模型证据，不由累计数代替'}。", refs)
            body = answer_text(row.get("output", {}))
            for check in turn.get("checks", []):
                included = not check["must_include_any"] or any(term in body for term in check["must_include_any"])
                excluded = [term for term in check["must_exclude"] if term in body]
                status = "unjudged" if not body or row.get("status") != "completed" else "pass" if included and not excluded else "fail"
                record(check["dimension"], status, f"第 {index} 轮 · {check['title']}：词项规则信号，{'命中配置条件' if status == 'pass' else '需要复核正文及配置条件'}。", refs,
                       critical=check["critical"], alternative="关键词无法判断否定语义，工程草案条件也需人工复核。",
                       replay="从首轮建立新会话，固定输入与版本，对比本轮回答和前轮事实。")
        judged = judge_context(store, run, case)
        if judged["status"] != "completed":
            record("context_semantics", "unjudged", f"多轮语义评审待判断：{judged['reason']}。", ["output.conversation_turns"], evaluator="context-llm-v1")
        else:
            for finding in judged["findings"]:
                record(finding["dimension"], finding["result"], f"第 {finding['turn_index']} 轮 · 模型辅助，待人工复核：{finding['rationale']}", finding["evidence_refs"],
                       evaluator="context-llm-v1", critical=finding["dimension"] == "context_risk_handoff" and case["risk_level"] == "critical",
                       alternative="模型评审可能误判，应结合引用的真实输入与答案复核。", replay="保留旧对话，固定版本从首轮重跑，核对最早偏离轮次。")

    priority = ("business_node", "context_session", "context_correction", "context_fact_retention", "context_constraint", "context_topic_return", "context_isolation", "context_risk_handoff", "intent", "context", "retrieval_plan", "retrieval", "source_selection",
                "evidence_sufficiency", "artifact", "critical_safety", "business_execution")
    first_specific = next((f for dimension in priority for f in findings
                           if f["dimension"] == dimension and f["status"] == "fail"), None)
    diagnosis = {"case_gold_status": case["gold_status"], "findings": findings,
                 "first_failure": first_specific,
                 "priority_issue": first_specific, "root_cause_status": "unconfirmed",
                 "first_failure_semantics": "priority_issue_not_chronological_root",
                 "critical_failures": [f for f in findings if f["critical"] and f["status"] == "fail"],
                 "clinical_validation": "not_performed" if case["agent"] == "clinical" else "not_applicable"}
    store.add_event(run_id, "evaluation", "diagnosis", "completed", diagnosis)
    return diagnosis
