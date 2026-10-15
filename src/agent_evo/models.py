from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator


AgentName = Literal["unihr", "clinical", "generic"]


class ContextCheck(BaseModel):
    dimension: Literal["context_fact_retention", "context_correction", "context_constraint", "context_topic_return", "context_isolation"]
    title: str = Field(min_length=1, max_length=200)
    must_include_any: list[str] = Field(default_factory=list, max_length=30)
    must_exclude: list[str] = Field(default_factory=list, max_length=30)
    critical: bool = False

    @model_validator(mode="after")
    def has_conditions(self):
        terms = self.must_include_any + self.must_exclude
        if not terms or any(not item.strip() or len(item) > 300 for item in terms):
            raise ValueError("上下文检查需提供非空词项条件")
        return self


class ConversationTurn(BaseModel):
    message: str = Field(min_length=1, max_length=20000)
    checks: list[ContextCheck] = Field(default_factory=list, max_length=20)


class EvalCase(BaseModel):
    case_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{2,100}$")
    agent: AgentName
    suite_version: str = "v1"
    category: str
    title: str
    message: str = Field(min_length=1, max_length=20000)
    synthetic: Literal[True] = True
    risk_level: Literal["standard", "high", "critical"] = "standard"
    fixtures: list[str] = Field(default_factory=list)
    case_context_text: str | None = Field(default=None, max_length=10000)
    expected: dict[str, object] = Field(default_factory=dict)
    model_required: bool = True
    gold_status: Literal["engineering_draft", "business_approved", "clinician_approved"] = "engineering_draft"
    turns: list[ConversationTurn] = Field(default_factory=list, max_length=12)

    @model_validator(mode="after")
    def valid_dialogue(self):
        if self.turns and (len(self.turns) < 2 or self.message != self.turns[0].message or sum(len(t.message) for t in self.turns) > 80000):
            raise ValueError("多轮用例须为 2–12 轮，message 与首轮一致，总输入不超过 80,000 字符")
        mode = self.expected.get('source_match', 'all')
        if mode not in ('all', 'any', 'groups'):
            raise ValueError('source_match 须为 all、any 或 groups')
        if mode == 'groups':
            groups = self.expected.get('source_groups')
            if not isinstance(groups, list) or not groups or any(
                not isinstance(group, list) or not group or any(not isinstance(v, str) or not v.strip() for v in group)
                for group in groups
            ):
                raise ValueError('source_groups 须包含非空来源替代组；每组至少满足一项')
        return self


def case_payload(case: EvalCase) -> dict:
    # Preserve the exact v1 representation and its frozen SHA.
    return case.model_dump(mode="json", exclude={"turns"} if not case.turns else set())


class CreateBatch(BaseModel):
    repetitions: int = Field(default=1, ge=1, le=5)
    case_ids: list[str] = Field(min_length=1, max_length=100)
    label: str = Field(default="working-tree", max_length=120)
    agent_id: str | None = None
    dataset_id: str | None = None


class AgentInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    adapter_kind: Literal["unihr", "clinical", "http_json"]
    base_url: str = Field(min_length=1, max_length=200)
    endpoint_path: str = Field(default="/evaluate", pattern=r"^/[a-zA-Z0-9/_-]{1,100}$")
    credential_env_prefix: str = Field(default="", pattern=r"^(?:[A-Z][A-Z0-9_]{1,70})?$")


class DatasetInput(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=1000)
    profile: AgentName = "generic"
    version: str = Field(default="v1", pattern=r"^v[0-9]+$")
    filename: str = Field(max_length=200)
    content: str = Field(min_length=1, max_length=5_242_880)


class RenameInput(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class AssignDatasets(BaseModel):
    dataset_ids: list[str] = Field(max_length=1000)


class ManageBatches(BaseModel):
    batch_ids: list[str] = Field(min_length=1, max_length=100)
    action: Literal["delete", "restore", "pin", "unpin"]


class RetrySelection(BaseModel):
    run_ids: list[str] = Field(min_length=1, max_length=100)


class ReviewInput(BaseModel):
    dimension: str = Field(min_length=1, max_length=80)
    result: Literal["pass", "fail", "unjudged"]
    rationale: str = Field(min_length=1, max_length=2000)
    reviewer: str = Field(min_length=1, max_length=100)
