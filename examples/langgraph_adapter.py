"""Copy beside your existing graph. Run connector with --adapter langgraph_adapter:run_turn.
Replace the import with your own compiled LangGraph. No graph code is uploaded.
Requires your project's existing langgraph and langchain_core packages.
"""
from my_application import graph
from langchain_core.messages import HumanMessage


def run_turn(message, conversation_id, history, turn_index):
    # A graph with a checkpointer retains history by thread_id. Without a checkpointer,
    # change this to pass converted history messages explicitly; do not pass both.
    steps, answer = [], ''
    for update in graph.stream({'messages': [HumanMessage(content=message)]},
                               config={'configurable': {'thread_id': conversation_id}}, stream_mode='updates'):
        for node, value in update.items():
            messages = value.get('messages', []) if isinstance(value, dict) else []
            if not isinstance(messages, list):
                messages = [messages]
            for msg in messages:
                steps.append({'node': node, 'type': getattr(msg, 'type', 'unknown'),
                              'content': getattr(msg, 'content', ''), 'tool_calls': getattr(msg, 'tool_calls', [])})
                if getattr(msg, 'type', '') == 'ai' and getattr(msg, 'content', ''):
                    answer = msg.content
    return {'answer': answer, 'conversation_id': conversation_id, 'steps': steps,
            'versions': {'adapter': 'langgraph-updates-v1'}}
