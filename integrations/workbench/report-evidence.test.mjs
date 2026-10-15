import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reportAnswerUnit, reportMaterial,validateReport} from '../../web/src/reportCore.mjs';
test('report retains the exact reviewed expectation used by scoring',()=>{
 const unit=reportAnswerUnit({record_id:'sample',turns:[{turn:1,question:'请查询',answer:'不能操作',reference:'不能读取',linked_case:{expected:{behavior:'说明助手不能读写真实订单'}}}]});
 const material=reportMaterial({units:[unit],metrics:{planned:1},version:'test'});
 assert.equal(material.records[0].evidence.find(e=>e.ref==='turn:1:expectation').text,'说明助手不能读写真实订单');
 const row={text:'应核对能力边界。',metric_refs:[],evidence:[{record_id:'sample',ref:'turn:1:expectation',quote:'不能读写真实订单'}]};
 validateReport({summary:[row],strengths:[],issues:[row],recommendations:[row],limitations:[row]},material);
 const invalid={...row,evidence:[{record_id:'sample',ref:'missing-one',quote:'错误'},{record_id:'sample',ref:'missing-two',quote:'错误'}]};
 assert.throws(()=>validateReport({summary:[row],strengths:[],issues:[invalid],recommendations:[],limitations:[row]},material),error=>error.message.includes('missing-one')&&error.message.includes('missing-two'));
});
