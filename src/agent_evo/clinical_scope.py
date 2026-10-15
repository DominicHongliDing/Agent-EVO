"""The active product contains Clinical only; stored historical evidence is immutable."""


def clinical_batch(batch):
    runs = [r for r in batch['runs'] if r['agent'] == 'clinical']
    return {**batch, 'runs': runs, 'total': len(runs),
            'label': batch['label'] if len(runs) == len(batch['runs']) else 'Clinical · 历史评测',
            'recorded_count': sum(r.get('execution_mode') == 'recorded' for r in runs),
            'historical_model_calls': sum(r['model_calls'] for r in runs if r.get('execution_mode') == 'recorded'),
            'finished': sum(r['status'] in {'completed', 'failed', 'timed_out', 'cancelled', 'blocked'} for r in runs),
            'live_model_verified': sum(bool(r.get('live_model_verified')) for r in runs)}
