"""Clinical starter. The platform owns inputs, turns, sessions and mandatory checks."""


def run_case(case, context):
    return context.call_agent()


def evaluate_case(case, result, context):
    # Add reviewed assertions here. No reference answer means no quality-pass claim.
    return [{
        'dimension': 'answer_review',
        'result': 'unjudged',
        'rationale': '保留本轮回答，等待人工核对帮助是否有效、上下文是否一致。',
        'evidence': ['output'],
    }]
