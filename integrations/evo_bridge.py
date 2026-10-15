"""Vendored into native backends by install-native-bridge.py. No business execution."""
from __future__ import annotations

import hashlib
import json
import os
import re
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, Field


class BridgeRequest(BaseModel):
    data_classification: str = Field(pattern=r"^(synthetic|deidentified)$")
    privacy_confirmed: bool = False
    end_turn: int | None = Field(default=None, ge=1, le=200)
    redact_terms: list[str] = Field(default_factory=list, max_length=100)
    expected_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


PRIVATE_KEY = re.compile(r"password|secret|authorization|api.?key|access.?token|cookie|saved_path|local_path|extracted_text|owner_user|tenant_id|patient_name|candidate_name", re.I)
PRIVATE_TEXT = re.compile(r"\b1[3-9]\d{9}\b|\b\d{17}[\dXx]\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]+)\b")


def clean(value, terms=()):
    if isinstance(value, dict):
        return {key: clean(item, terms) for key, item in value.items() if not PRIVATE_KEY.search(key)}
    if isinstance(value, list):
        return [clean(item, terms) for item in value]
    if isinstance(value, str):
        value = PRIVATE_TEXT.sub("[已脱敏]", value)
        for term in sorted(terms, key=len, reverse=True):
            if term.strip():
                value = value.replace(term, "[已脱敏]")
        return value
    if value is None or isinstance(value, (int, float, bool)):
        return value
    return str(value)


def envelope(kind, scope, conversation_id, title, turns, requires_attachments):
    return {"protocol": "agent-evo-recording-v1", "agent_id": os.getenv("EVO_RECORDING_AGENT_ID", "agent_" + kind),
            "source_scope": hashlib.sha256((kind + ":" + scope).encode()).hexdigest(),
            "conversation_id": conversation_id, "title": title[:120] or "原生会话",
            "requires_attachments": requires_attachments, "turns": turns}


def prepare(snapshot, request):
    if not snapshot["turns"]:
        raise HTTPException(409, "当前会话没有可评测的用户消息")
    if len(snapshot["turns"]) > 200:
        raise HTTPException(422, "会话超过 200 轮，请选择较短会话")
    end = request.end_turn or len(snapshot["turns"])
    if end > len(snapshot["turns"]):
        raise HTTPException(422, "选择的轮次不存在")
    snapshot.update(data_classification=request.data_classification, privacy_confirmed=request.privacy_confirmed)
    sanitized = clean(snapshot, request.redact_terms)
    digest = hashlib.sha256(json.dumps({**sanitized, "privacy_confirmed": False}, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    if request.expected_sha256 and request.expected_sha256 != digest:
        raise HTTPException(409, "会话记录已变化，请重新预览后提交")
    sanitized["turns"] = sanitized["turns"][:end]
    if len(json.dumps(sanitized, ensure_ascii=False).encode()) > 5_242_880:
        raise HTTPException(422, "记录超过 5 MiB，请选择更早的结束轮次")
    return {**sanitized, "preview_sha256": digest}


def submit(snapshot):
    snapshot.pop("preview_sha256", None)
    if not snapshot["privacy_confirmed"]:
        raise HTTPException(422, "请核对预览并确认会话为合成或已脱敏内容")
    base = os.getenv("EVO_PLATFORM_URL", "http://127.0.0.1:8090").rstrip("/")
    parsed = urlparse(base)
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise HTTPException(503, "评测平台地址配置无效")
    token = os.getenv("EVO_RECORDING_TOKEN", "")
    if parsed.hostname not in {"127.0.0.1", "localhost"} and (parsed.scheme != "https" or not token):
        raise HTTPException(503, "远程接入需 HTTPS 和服务端评测密钥")
    try:
        with httpx.Client(timeout=20, follow_redirects=False, trust_env=False) as client:
            response = client.post(base + "/api/recordings", json=snapshot, headers={"X-EVO-Recording-Token": token})
        if response.status_code >= 400:
            raise HTTPException(502, "平台拒绝记录，请检查 Agent 接入配置、记录合同与服务端鉴权")
        result = response.json()
        public_base = os.getenv("EVO_PLATFORM_PUBLIC_URL", base).rstrip("/")
        public = urlparse(public_base)
        if public.scheme not in {"http", "https"} or public.username or public.password:
            raise HTTPException(503, "评测查看地址配置无效")
        return {**result, "url": public_base + "/?run=" + result["run_id"], "new_business_calls": 0}
    except (httpx.HTTPError, ValueError, KeyError):
        raise HTTPException(503, "无法连接评测平台，请确认服务已启动") from None
