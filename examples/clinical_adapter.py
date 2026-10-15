"""Read-only synthetic Clinical business entry. No source .env or original patient data."""
import os,secrets,uuid
from evo_connector import request
sessions={}
def run_turn(message,conversation_id,history,turn_index):
    base=os.getenv('EVO_CLINICAL_URL','http://127.0.0.1:8000')
    if conversation_id not in sessions:
        username='evo_'+uuid.uuid4().hex[:18];password=secrets.token_urlsafe(24)
        request(base+'/auth/register',{'username':username,'password':password,'preferred_language':'zh'},{})
        login=request(base+'/auth/login',{'username':username,'password':password},{})
        import urllib.request,json
        auth={'Authorization':'Bearer '+login['access_token']}
        with urllib.request.urlopen(urllib.request.Request(base+'/auth/me',headers=auth),timeout=30) as r: user=json.load(r)['user']['user_id']
        sessions[conversation_id]=(auth,user)
    auth,user=sessions[conversation_id]
    response=request(base+'/chat',{'thread_id':'evo_run_'+conversation_id,'user_id':user,'message':message,'language':'zh'},auth,timeout=240)
    answer=response.get('answer') or response.get('message') or response.get('reply')
    if isinstance(answer,dict):
        answer='\n\n'.join([str(answer.get('summary') or '')]+[str(s.get('title') or '')+'\n'+str(s.get('content') or '') for s in answer.get('sections',[])])
    if not isinstance(answer,str):
        raise ValueError('Clinical response answer mapping must match source schema')
    return {'answer':answer,'conversation_id':conversation_id,'steps':[{'node':'clinical_business_response','run_id':response.get('run_id'),'trace':response.get('trace')}],
            'usage':(response.get('trace') or {}).get('model_usage'),'versions':{'agent':'clinical-original-read-only','business_run_id':response.get('run_id')}}
