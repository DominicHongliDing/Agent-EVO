"""Use with a 2–12 turn Clinical dataset; mandatory context checks remain enabled."""


def run_case(case, context):
    if not case.get('turns'):
        raise ValueError('请选择含多轮对话的测试集')
    return context.call_agent()


def evaluate_case(case, result, context):
    turns = result.get('conversation_turns', [])
    complete = len(turns) == len(case['turns']) and all(t.get('session_verified') for t in turns)
    return [{
        'dimension': 'conversation_evidence',
        'result': 'pass' if complete else 'fail',
        'rationale': '逐轮业务会话已验证；回答是否跑偏由平台上下文评审另行判断。' if complete else '多轮证据缺失或会话未验证，需先排查业务链路。',
        'evidence': ['output.conversation_turns'],
    }]
