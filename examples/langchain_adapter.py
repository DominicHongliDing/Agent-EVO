"""Adapter for an existing LangChain Runnable / agent; does not build a replacement model.
EVO_LANGCHAIN_TARGET=my_application:agent
EVO_LANGCHAIN_MEMORY=checkpointer only if your existing app owns thread history.
"""
import importlib
import os


def text_content(value):
    if isinstance(value,str):return value
    if isinstance(value,list):return ''.join(b.get('text','') for b in value if isinstance(b,dict) and b.get('type')=='text')
    return ''


def run_turn(message, conversation_id, history, turn_index):
    module, name=os.environ['EVO_LANGCHAIN_TARGET'].split(':',1)
    runnable=getattr(importlib.import_module(module),name)
    retained=os.getenv('EVO_LANGCHAIN_MEMORY','history')=='checkpointer'
    messages=[] if retained else list(history)
    messages.append({'role':'user','content':message})
    result=runnable.invoke({'messages':messages},config={'configurable':{'thread_id':conversation_id}})
    emitted=result.get('messages',[]) if isinstance(result,dict) else [result]
    def get(msg,key,default=None):return msg.get(key,default) if isinstance(msg,dict) else getattr(msg,key,default)
    assistant=[m for m in emitted if get(m,'type',get(m,'role')) in ('ai','assistant')]
    final=assistant[-1] if assistant else None
    answer=text_content(get(final,'content','')) if final is not None else (result.get('output','') if isinstance(result,dict) else text_content(result))
    if not isinstance(answer,str) or not answer.strip():raise ValueError('Map your Runnable output in this adapter; no assistant answer returned')
    steps=[{'node':'returned_message','type':get(m,'type',get(m,'role')),'content':text_content(get(m,'content','')),'tool_calls':get(m,'tool_calls',[])} for m in emitted if get(m,'type',get(m,'role')) in ('ai','assistant','tool')]
    return {'answer':answer,'conversation_id':conversation_id,'steps':steps,'usage':get(final,'usage_metadata'),'versions':{'adapter':'langchain-runnable-v1','memory':'checkpointer' if retained else 'history'}}
