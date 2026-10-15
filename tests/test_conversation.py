from __future__ import annotations

import csv
import io
import json
import sqlite3
from dataclasses import replace
from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pytest

from agent_evo import adapters, generic_adapter, context_judge
from agent_evo.config import Settings
from agent_evo.context_judge import validate_findings
from agent_evo.management import preview_dataset
from agent_evo.models import DatasetInput, EvalCase, case_payload
from agent_evo.runner import execute_one
from agent_evo.store import Store, dumps, now


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("EVO_CONTEXT_JUDGE_ENABLED", "0")
    return Store(replace(Settings.from_env(), db_path=tmp_path / "evo.db", artifact_root=tmp_path / "artifacts"))


def turns():
    return [{"message":"请规划30人的两天培训。"},
            {"message":"人数改成20人，天数不变。", "checks":[{"dimension":"context_correction", "title":"人数更正", "must_include_any":["20"]}]},
            {"message":"汇总当前人数和天数。", "checks":[{"dimension":"context_fact_retention", "title":"人数保留", "must_include_any":["20"]}]}]


def payload(profile="generic", **changes):
    raw = {"case_id":"natural_context_01", "turns":turns(), "synthetic":True, "expected":{"required_model_calls":3}}
    raw.update(changes)
    return DatasetInput(name="自然问法", profile=profile, version="v2", filename="natural.jsonl", content=dumps(raw))


def prepare(store, profile="generic"):
    agent = store.save_agent({"name":"业务入口", "adapter_kind":"http_json", "base_url":"http://127.0.0.1:8033"}) if profile == "generic" else next(a for a in store.list_agents() if a["adapter_kind"] == profile)
    dataset = store.import_dataset(payload(profile))
    store.assign_datasets(agent["agent_id"], [dataset["dataset_id"]])
    case = store.list_cases(dataset_id=dataset["dataset_id"])[0]
    batch = store.create_batch([case["case_id"]], "多轮合同", agent["agent_id"], dataset["dataset_id"])
    return store.claim_next("contract-worker"), batch


def response(body, answer, index):
    business = f"business-{index}"
    return {"business_status":"succeeded", "conversation_id":body["conversation_id"], "business_run_id":business,
            "result":{"answer":answer}, "events":[{"node":"answer", "status":"completed", "summary":answer}],
            "model_usage":{"events":[{"run_id":business,"provider":"dashscope","model_name":"contract-only","status":"success","usage_status":"provider_reported","prompt_tokens":10,"completion_tokens":5}]}}


def test_turns_only_import_csv_defaults_and_frozen_v1(store):
    parsed = preview_dataset(payload(), store.settings.fixture_root)
    assert parsed["valid"] and parsed["cases"][0]["message"] == turns()[0]["message"]
    assert parsed["cases"][0]["turns"][1]["checks"][0]["must_exclude"] == []
    buffer = io.StringIO(); writer = csv.DictWriter(buffer, fieldnames=["case_id","turns"])
    writer.writeheader(); writer.writerow({"case_id":"csv_turn_01", "turns":dumps(turns())})
    assert preview_dataset(payload().model_copy(update={"filename":"turns.csv","content":buffer.getvalue()}),store.settings.fixture_root)["valid"]
    for path in store.settings.dataset_root.glob("*.jsonl"):
        for line in path.read_text(encoding="utf-8").splitlines():
            raw=json.loads(line); assert "turns" not in case_payload(EvalCase.model_validate(raw))
            # Exact seeded SHA follows the same legacy normalized representation.
            assert store.get_case(raw["case_id"])["message"] == raw["message"]


@pytest.mark.parametrize("changes", [
    {"message":"不匹配"}, {"turns":[{"message":"只有一轮"}]},
    {"turns":[{"message":"追问"}]*13}, {"turns":[{"message":"a"*20000}]*5},
    {"turns":[{"message":"请帮我规划培训"},{"message":"这是虚构的培训，用于测试"}]},
])
def test_invalid_dialogue_rejected_atomically(store, changes):
    before=len(store.list_datasets())
    assert not preview_dataset(payload(**changes),store.settings.fixture_root)["valid"]
    with pytest.raises(ValueError): store.import_dataset(payload(**changes))
    assert len(store.list_datasets()) == before


def test_generic_actual_history_corrected_fact_and_judge_usage_separate(store, monkeypatch):
    run,batch=prepare(store); bodies=[]
    def handler(request):
        body=json.loads(request.content); bodies.append(body)
        assert not any(k in body for k in ["expected","turns","checks"])
        index=len(bodies)
        assert body["turn_index"] == index and len(body["history"]) == (index-1)*2
        if index>1: assert body["history"][-1]["content"] == ("30人，两天。" if index==2 else "已改为20人，两天。")
        return httpx.Response(200,json=response(body, ["30人，两天。","已改为20人，两天。","20人，两天。"][index-1],index))
    monkeypatch.setattr(generic_adapter,"_client",lambda url,timeout:httpx.Client(base_url=url,transport=httpx.MockTransport(handler)))
    execute_one(run,store,store.settings)
    saved=store.get_run(run["run_id"])
    assert saved["status"] == "completed" and saved["model_calls"] == 3 and saved["model_evidence"]["verified"]
    assert len({b["conversation_id"] for b in bodies}) == 1
    assert all(row["model_calls"] == 1 for row in saved["output"]["conversation_turns"])
    assert len([e for e in store.events(run["run_id"]) if e["node"] == "answer" and e["payload"].get("turn_index")]) == 3
    assert all(v["result"] == "pass" for v in store.verdicts(run["run_id"]) if v["dimension"] in {"context_correction","context_fact_retention"})
    # The independent judge has actual quoted evidence and cannot inflate business usage.
    monkeypatch.setenv("EVO_CONTEXT_JUDGE_ENABLED","1"); monkeypatch.setenv("DASHSCOPE_API_KEY","contract-secret")
    findings=[{"turn_index":i,"dimension":"context_correction" if i==2 else "context_fact_retention","result":"pass","rationale":"保留人数更正", "evidence":[{"turn_index":i,"role":"assistant","quote":"20人"}]} for i in [2,3]]
    original_client=httpx.Client
    def judge(request):
        assert request.headers["authorization"] == "Bearer contract-secret"
        return httpx.Response(200,json={"id":"judge-contract","choices":[{"message":{"content":dumps({"findings":findings})}}],"usage":{"prompt_tokens":100,"completion_tokens":50}})
    monkeypatch.setattr(context_judge.httpx,"Client",lambda **kwargs:original_client(transport=httpx.MockTransport(judge)))
    result=context_judge.judge_context(store,saved,store.get_case(saved["case_id"]))
    assert result["status"] == "completed" and store.get_run(run["run_id"])["model_calls"] == 3
    assert "contract-secret" not in dumps(store.events(run["run_id"]))
    assert len([e for e in store.events(run["run_id"]) if e["node"] == "context.semantic.usage"]) == 1


@pytest.mark.parametrize("mode", ["http_error","session_mismatch","missing_usage"])
def test_middle_turn_failure_or_missing_evidence_preserves_actual_earlier_output(store,monkeypatch,mode):
    run,batch=prepare(store); bodies=[]
    def handler(request):
        body=json.loads(request.content); bodies.append(body); index=len(bodies)
        if index==2 and mode=="http_error": return httpx.Response(503,json={"error":"downstream unavailable"})
        value=response(body,"30人" if index==1 else "仍按30人安排。",index)
        if index==2 and mode=="session_mismatch": value["conversation_id"]="wrong-session"
        if index==2 and mode=="missing_usage": value["model_usage"]={}
        return httpx.Response(200,json=value)
    monkeypatch.setattr(generic_adapter,"_client",lambda url,timeout:httpx.Client(base_url=url,transport=httpx.MockTransport(handler)))
    execute_one(run,store,store.settings); saved=store.get_run(run["run_id"]); rows=saved["output"]["conversation_turns"]
    assert rows[0]["output"]["result"]["answer"] == "30人" and rows[0]["model_calls"] == 1
    if mode!="missing_usage":
        assert len(bodies)==2 and rows[1]["status"]=="failed" and rows[2]["status"]=="not_started"
        assert not saved["model_evidence"]["verified"]
        assert all(v["result"]=="unjudged" for v in store.verdicts(run["run_id"]) if v["rationale"].startswith("第 3 轮"))
    else:
        assert len(bodies)==3 and saved["model_calls"]==2 and not saved["model_evidence"]["verified"]
        assert any(v["dimension"]=="context_correction" and v["result"]=="fail" and v["rationale"].startswith("第 2 轮") for v in store.verdicts(run["run_id"]))


def test_native_unihr_reuses_actual_conversation_and_independent_execution_ids(store,monkeypatch,tmp_path):
    run,_=prepare(store,"unihr"); usage=tmp_path/"usage.db"; forms=[]
    with sqlite3.connect(usage) as db:
        db.execute("CREATE TABLE model_usage_events(run_id TEXT,provider TEXT,model TEXT,purpose TEXT,operation_kind TEXT,status TEXT,input_units INTEGER,output_units INTEGER,latency_ms INTEGER,estimated_cost_cny REAL,pricing_configured INTEGER,created_at TEXT)")
        db.executemany("INSERT INTO model_usage_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",[(f"execution-{i}","bailian","contract-only","answer","chat","succeeded",10,5,100,None,0,now()) for i in [1,2,3]])
    settings=replace(store.settings,unihr_usage_db=usage,unihr_username="contract-user",unihr_password="contract-password")
    def handler(request):
        path=request.url.path
        if path.endswith("/auth/login"): return httpx.Response(200,json={"access_token":"contract-token"})
        if path.endswith("/turns:start"):
            form=parse_qs(request.content.decode()); forms.append(form)
            assert form.get("conversation_id") == (None if len(forms)==1 else ["actual-conversation"])
            return httpx.Response(202,json={"id":f"execution-{len(forms)}"})
        if path.endswith("/events"): return httpx.Response(200,text='data: {"sequence":1,"event":"answer","status":"completed"}\n\n')
        if "/turns/execution-" in path:
            i=int(path.rsplit("-",1)[1]); return httpx.Response(200,json={"id":f"execution-{i}","run_id":f"business-{i}","status":"succeeded","conversation_id":"actual-conversation","result":{"assistant_message":{"content":"20人，两天。"},"artifacts":[]}})
        if "/runs/" in path: return httpx.Response(200,json={"events":[]})
        return httpx.Response(404)
    monkeypatch.setattr(adapters,"_client",lambda url,timeout:httpx.Client(base_url=url,transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(adapters,"source_fingerprint",lambda *args:{})
    execute_one(run,store,settings); saved=store.get_run(run["run_id"])
    assert saved["status"]=="completed" and saved["model_calls"]==3 and len(forms)==3
    assert len({row["business_execution_id"] for row in saved["output"]["conversation_turns"]})==3


def test_native_clinical_reuses_identity_and_thread_without_hidden_setup(store,monkeypatch,tmp_path):
    run,_=prepare(store,"clinical"); requests=[]; submits=[]
    def handler(request):
        path=request.url.path; requests.append(path)
        if path=="/auth/register": return httpx.Response(200,json={"user":{"user_id":"contract-user"}})
        if path=="/auth/login": return httpx.Response(200,json={"access_token":"contract-token"})
        if path=="/auth/me": return httpx.Response(200,json={"user":{"user_id":"contract-user"}})
        if path=="/chat/stream":
            assert request.headers["authorization"]=="Bearer contract-token"
            body=json.loads(request.content); submits.append(body)
            final={"type":"final","response":{"run_id":f"clinical-{len(submits)}","thread_id":body["thread_id"],"answer":"20人，两天。","trace":{"model_usage":{"successful_request_count":1}}}}
            return httpx.Response(200,text="data: "+dumps(final)+"\n\n")
        if path=="/admin/agent-runs": return httpx.Response(200,json={"items":[]})
        if path.endswith("/steps"): return httpx.Response(200,json={"items":[]})
        return httpx.Response(404)
    monkeypatch.setattr(adapters,"_client",lambda url,timeout:httpx.Client(base_url=url,transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(adapters,"source_fingerprint",lambda *args:{})
    settings=replace(store.settings,clinical_access_token="",clinical_source=tmp_path)
    execute_one(run,store,settings); saved=store.get_run(run["run_id"])
    assert saved["status"]=="completed" and saved["model_calls"]==3
    assert requests.count("/auth/register")==1 and "/chat" not in requests and "/cases" not in requests
    assert len({(body["thread_id"],body["user_id"]) for body in submits})==1
    assert "contract-token" not in dumps(saved) and "contract-token" not in dumps(store.events(run["run_id"]))


def test_semantic_judge_rejects_fabricated_quotes_and_missing_rounds():
    transcript=[{"turn_index":i,"user":"问句","assistant":"实际回答"} for i in [1,2,3]]
    item={"turn_index":2,"dimension":"context_correction","result":"fail","rationale":"丢失更正","evidence":[{"turn_index":2,"role":"assistant","quote":"编造引用"}]}
    with pytest.raises(ValueError,match="真实对话"):validate_findings({"findings":[item]},transcript)
    item["evidence"][0]["quote"]="实际回答"
    with pytest.raises(ValueError,match="覆盖"):validate_findings({"findings":[item]},transcript)


def test_new_datasets_natural_prompts_and_exact_multi_coverage(store):
    for profile in ["unihr","clinical"]:
        path=store.settings.dataset_root/"natural-v2"/f"{profile}-50-v2.jsonl"
        result=preview_dataset(DatasetInput(name="自然问法",profile=profile,version="v2",filename=path.name,content=path.read_text(encoding="utf-8")),store.settings.fixture_root)
        assert result["valid"] and result["total"]==50
        assert sum(len(case.get("turns",[]))==3 for case in result["cases"])==10
        for case in result["cases"]:
            assert case["synthetic"] and case["gold_status"]=="engineering_draft"
            for fixture in case["fixtures"]:
                assert "虚构" not in (store.settings.fixture_root/fixture).read_text(encoding="utf-8")
