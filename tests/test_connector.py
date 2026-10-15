import importlib.util
import json
import sys
from types import SimpleNamespace
from pathlib import Path
import pytest

spec=importlib.util.spec_from_file_location('evo_connector',Path(__file__).parents[1]/'examples/evo_connector.py')
connector=importlib.util.module_from_spec(spec);spec.loader.exec_module(connector)

def adapter_module(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).parents[1]/'examples'/f'{name}.py')
    module=importlib.util.module_from_spec(spec)
    sys.modules['evo_connector']=connector
    spec.loader.exec_module(module)
    return module

def test_lost_lease_stops_remaining_turns_without_replay():
    calls=[]
    def adapter(**kwargs):
        calls.append(kwargs)
        return {'answer':'实际返回','conversation_id':kwargs['conversation_id']}
    result=connector.execute({'input':{'turns':[{'message':'先问'},{'message':'继续'}]}},adapter,'v1',lambda:bool(calls))
    assert len(calls)==1
    assert result['status']=='uncertain'
    assert len(result['turns'])==1

def test_each_attempt_gets_own_conversation_and_turns_keep_history():
    calls=[]
    def adapter(**kwargs):
        calls.append(kwargs)
        return {'answer':'确认','conversation_id':kwargs['conversation_id']}
    item={'input':{'turns':[{'message':'周三'},{'message':'改周四'}]}}
    first=connector.execute(item,adapter,'v1');second=connector.execute(item,adapter,'v1')
    assert first['conversation_id']!=second['conversation_id']
    assert calls[0]['conversation_id']==calls[1]['conversation_id']
    assert len(calls[1]['history'])==2 and calls[2]['history']==[]

@pytest.mark.parametrize('answer,next_question',[('已记录周四','确认周四'),('时间待定','请确认时间')])
def test_conditional_followup_records_actual_question_and_history(answer,next_question):
    calls=[]
    def adapter(**kwargs):
        calls.append(kwargs)
        return {'answer':answer,'conversation_id':kwargs['conversation_id']}
    result=connector.execute({'input':{'turns':[{'message':'什么时候？'},{'message':'请确认时间','branch':{'contains':'周四','message':'确认周四'}}]}},adapter,'v1')
    assert result['status']=='completed'
    assert calls[1]['message']==next_question
    assert calls[1]['history'][-1]['content']==answer
    assert result['turns'][1]['question']==next_question

def sse(*events):
    return [b'data: '+json.dumps(event).encode()+b'\n' for event in events]

def test_dify_complete_stream_requires_end_and_preserves_returned_evidence():
    adapter=adapter_module('dify_adapter')
    message={'event':'agent_message','conversation_id':'dify-session','answer':'Actual answer'}
    with pytest.raises(ValueError):adapter.consume_events(sse(message))
    with pytest.raises(RuntimeError):adapter.consume_events(sse(message,{'event':'error','message':'upstream failed'}))
    result=adapter.consume_events(sse(message,{'event':'message_end','metadata':{'usage':{'total_tokens':12},'retriever_resources':[{'document_name':'Fixture'}]}}))
    assert result['answer']=='Actual answer' and result['conversation_id']=='dify-session'
    assert result['usage']['total_tokens']==12 and result['steps'][0]['source']=='dify_returned'

def test_dify_multiturn_keeps_remote_session_and_user(monkeypatch):
    adapter=adapter_module('dify_adapter');requests=[]
    monkeypatch.setenv('EVO_DIFY_URL','https://dify.example/v1');monkeypatch.setenv('EVO_DIFY_KEY','protocol-fixture')
    class Response:
        def __enter__(self):return iter(sse({'event':'message','conversation_id':'remote','answer':'Returned'},{'event':'message_end'}))
        def __exit__(self,*args):pass
    def open_request(req,timeout):requests.append(json.loads(req.data));return Response()
    monkeypatch.setattr(adapter.urllib.request,'build_opener',lambda *args:SimpleNamespace(open=open_request))
    one=adapter.run_turn('First','local-unique',[],1)
    adapter.run_turn('Followup',one['conversation_id'],[],2)
    assert [r['user'] for r in requests]==['local-unique','local-unique']
    assert [r['conversation_id'] for r in requests]==['','remote']

@pytest.mark.parametrize('memory,expected_length',[('history',3),('checkpointer',1)])
def test_langchain_invokes_existing_runnable_with_correct_memory(monkeypatch,memory,expected_length):
    adapter=adapter_module('langchain_adapter');calls=[]
    def invoke(value,config):
        calls.append((value,config))
        return {'messages':[{'role':'tool','content':'real tool output'},{'role':'assistant','content':[{'type':'text','text':'Returned answer'}],'usage_metadata':{'total_tokens':9}}]}
    monkeypatch.setitem(sys.modules,'evo_fixture_application',SimpleNamespace(agent=SimpleNamespace(invoke=invoke)))
    monkeypatch.setenv('EVO_LANGCHAIN_TARGET','evo_fixture_application:agent');monkeypatch.setenv('EVO_LANGCHAIN_MEMORY',memory)
    result=adapter.run_turn('Next','unique-thread',[{'role':'user','content':'First'},{'role':'assistant','content':'Previous answer'}],2)
    assert len(calls[0][0]['messages'])==expected_length
    assert calls[0][1]['configurable']['thread_id']=='unique-thread'
    assert result['answer']=='Returned answer' and result['usage']['total_tokens']==9
    assert result['steps'][0]['content']=='real tool output'
