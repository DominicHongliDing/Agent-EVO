import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateBatch} from '../src/generateBatch.mjs';
const question=n=>({turns:[{message:'Question '+n}]});
test('50 question batch is split into bounded requests with growing duplicate exclusions',async()=>{
 const inputs=[],saved=[];let n=0;
 const out=await generateBatch({count:50,request:async input=>{inputs.push(input);return {cases:Array.from({length:input.count},()=>question(++n))}},onBatch:b=>saved.push(b.rows.length)});
 assert.deepEqual(inputs.map(i=>i.count),[10,10,10,10,10]);assert.deepEqual(inputs.map(i=>i.exclude.length),[0,10,20,30,40]);assert.deepEqual(saved,[10,20,30,40,50]);assert.equal(out.status,'completed');
});
test('stopping waits for current group and retains every accepted question',async()=>{
 let stop=false,calls=0;const saved=[];
 const out=await generateBatch({count:50,stopped:()=>stop,request:async()=>{calls++;return {cases:[question(calls)]}},onBatch:b=>{saved.push(b.rows);stop=true}});
 assert.equal(calls,1);assert.equal(out.status,'stopped');assert.equal(saved[0].length,1);
});
test('later failure does not discard prior accepted groups or automatically retry a paid request',async()=>{
 let calls=0;const saved=[];
 await assert.rejects(()=>generateBatch({count:50,request:async()=>{if(++calls===2)throw Error('Quota exhausted');return {cases:[question(1)]}},onBatch:b=>saved.push(b.rows.length)}),/Quota/);
 assert.equal(calls,2);assert.deepEqual(saved,[1]);
});
test('empty model output stops billing; partial output has a bounded request budget',async()=>{
 let calls=0;
 await assert.rejects(()=>generateBatch({count:10,request:async()=>{calls++;return {cases:[]}},onBatch:()=>{}}),/没有有效新题/);assert.equal(calls,1);
 const result=await generateBatch({count:50,request:async()=>({cases:[question(++calls)]}),onBatch:()=>{}});assert.equal(result.status,'partial');assert.equal(result.requests,11);
});
