"""Dify chat-messages adapter. Keep EVO_DIFY_URL and EVO_DIFY_KEY on the customer host.
Supports SSE chat/agent replies; fails on incomplete streams, never invents a final answer.
Run: python evo_connector.py --adapter dify_adapter:run_turn --platform ... --version v1
"""
import json
import os
import time
import urllib.request
from evo_connector import NoRedirect

_users = {}

def consume_events(lines):
    answer, session, usage, steps, ended = '', '', None, [], False
    size, start = 0, time.monotonic()
    for line in lines:
        size += len(line)
        if size > 2*1024*1024 or time.monotonic()-start > 180:
            raise ValueError('Dify stream exceeded bounds')
        if not line.startswith(b'data:'):
            continue
        raw=line[5:].strip()
        if not raw:
            continue
        event=json.loads(raw)
        kind=event.get('event')
        session=event.get('conversation_id') or session
        if kind=='error':
            raise RuntimeError('Dify reported an execution error')
        if kind in ('message','agent_message'):
            answer+=event.get('answer','')
        elif kind=='message_replace':
            answer=event.get('answer','')
        elif kind=='message_end':
            metadata=event.get('metadata',{})
            usage=metadata.get('usage')
            steps.extend({'node':'retrieval','source':'dify_returned','result':r} for r in metadata.get('retriever_resources',[]))
            ended=True
            break
        elif kind in ('node_finished','workflow_finished'):
            data=event.get('data',{})
            steps.append({'node':data.get('title') or data.get('node_id') or kind,'source':'dify_returned','status':data.get('status'),'inputs':data.get('inputs'),'outputs':data.get('outputs')})
    if not ended or not answer.strip() or not session:
        raise ValueError('Dify did not return a complete answer and conversation ID')
    return {'answer':answer,'conversation_id':session,'usage':usage,'steps':steps,'versions':{'adapter':'dify-sse-v1'}}

def run_turn(message, conversation_id, history, turn_index):
    url=os.environ['EVO_DIFY_URL'].rstrip('/')+'/chat-messages'
    if turn_index==1:
        user=conversation_id;remote=''
    else:
        user=_users[conversation_id];remote=conversation_id
    payload={'query':message,'inputs':json.loads(os.getenv('EVO_DIFY_INPUTS','{}')),'user':user,'conversation_id':remote,'response_mode':'streaming','auto_generate_name':False}
    req=urllib.request.Request(url,data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+os.environ['EVO_DIFY_KEY']})
    with urllib.request.build_opener(NoRedirect()).open(req,timeout=90) as response:
        result=consume_events(response)
    _users[result['conversation_id']]=user
    return result
