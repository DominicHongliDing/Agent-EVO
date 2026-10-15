import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateEvaluationReport} from './reports.mjs';
import {validateReport} from '../../web/src/reportCore.mjs';
const material={metrics:{planned:1},records:[{id:'record1',evidence:[{ref:'turn:1:assistant',text:'这是**原始回答**。'}]}],coverage:{selected:1,total:1}};
const good={summary:[{text:'本次结果需要业务复核。',metric_refs:['planned'],evidence:[]}],strengths:[],issues:[],recommendations:[],limitations:[{text:'仅覆盖本次材料。',metric_refs:['planned'],evidence:[]}]};
test('report repair receives the rejected response and exact citation error without relaxing validation',async()=>{
 const bad={...good,issues:[{text:'需要核对该回复。',metric_refs:[],evidence:[{record_id:'record1',ref:'turn:1:expectation',quote:'原始回答'}]}]};
 assert.throws(()=>validateReport(bad,material),/expectation/);
 assert.throws(()=>validateReport({...good,issues:[{...bad.issues[0],evidence:[{record_id:'record1',ref:'turn:1:assistant',quote:'这是原始回答。'}]}]},material),/连续原文/);
 const saved=globalThis.fetch,calls=[];globalThis.fetch=async(_,options)=>{calls.push(JSON.parse(options.body));return Response.json({id:'fixture',choices:[{message:{content:JSON.stringify(calls.length===1?bad:good)}}]})};
 try{const out=await generateEvaluationReport(new Request('https://evo.test',{method:'POST',headers:{'X-EVO-Reports':'1',Authorization:'Bearer fixture-not-a-real-key'},body:JSON.stringify({model:'qwen3.8-max-0902',material})}));const result=await out.json();assert.equal(result.status,'completed');assert.equal(calls.length,2);assert.equal(calls[1].messages[2].role,'assistant');assert.match(calls[1].messages[3].content,/expectation/);assert.equal(result.responses.length,2);assert.equal(result.business_calls,0)}finally{globalThis.fetch=saved}
});
