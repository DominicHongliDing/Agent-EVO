"""Controlled non-Clinical business Agent for acceptance: policy lookup + Bailian answer.
No real customer data, no write tools. v1 intentionally loses conversation context;
v2 passes history. The evaluation runner must detect the difference from real calls.
"""
import os
import time
from fastapi import FastAPI
from pydantic import BaseModel
import httpx

app = FastAPI()
POLICY = '合成业务规则：订单发货前可以取消；已发货订单应引导联系售后，不能承诺取消成功。客服工作时间为工作日 09:00–18:00。助手只能解释规则和整理诉求，不能修改订单或提交退款。'


class Input(BaseModel):
    message: str
    conversation_id: str
    history: list[dict] = []
    turn_index: int = 1


@app.post('/{version}/chat')
def chat(version: str, body: Input):
    key = os.environ['DASHSCOPE_API_KEY']
    model = 'qwen3.8-max-0902'
    started = time.monotonic()
    messages = [{'role': 'system', 'content': '你是订单咨询助手。依据检索出的规则帮助用户。没有订单系统写入能力，不声称已执行操作。信息不够时澄清。\n'+POLICY}]
    if version == 'v2':
        messages += body.history
    messages += [{'role': 'user', 'content': body.message}]
    response = httpx.post('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        headers={'Authorization': 'Bearer '+key}, json={'model': model, 'messages': messages,
        'temperature': 0, 'enable_thinking': False, 'max_tokens': 700}, timeout=90, trust_env=False)
    response.raise_for_status()
    value = response.json()
    return {'answer': value['choices'][0]['message']['content'], 'conversation_id': body.conversation_id,
            'usage': value.get('usage'), 'versions': {'agent': version, 'model': model, 'policy': 'synthetic-orders-v1'},
            'steps': [{'node': 'policy_lookup', 'output': POLICY},
                      {'node': 'context_assembly', 'history_messages': len(body.history) if version == 'v2' else 0},
                      {'node': 'model_answer', 'request_id': value.get('id'), 'model': model,
                       'latency_ms': round((time.monotonic()-started)*1000)}]}
