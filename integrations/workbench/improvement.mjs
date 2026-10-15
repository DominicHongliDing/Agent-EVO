// Project-level review and regression capabilities. Invoked only after ownership validation.
export async function workbenchImprovement(ctx){
 const {db,project,rest,method,request,owner,all,one,object,save,body,need,hash,stamp,ident,json,validateCases,viewAttempt,jobSnapshot}=ctx;
 const list=async kind=>(await all(db,'SELECT * FROM evo_objects WHERE project=? AND kind=? ORDER BY created DESC,id DESC',project,kind)).map(r=>({...JSON.parse(r.payload),id:r.id,created_at:r.created}));
 async function queue(){
  const [jobs,sets,judges,reviews,raw]=await Promise.all([list('job'),list('dataset'),list('assessment'),list('review'),all(db,'SELECT * FROM evo_attempts WHERE project=? ORDER BY created DESC',project)]);
  const items=[];
  for(const job of jobs){const ds=sets.find(d=>d.id===job.dataset);if(!ds)continue;
   const snap=await jobSnapshot(job,ds,raw.filter(a=>a.job===job.id).map(viewAttempt),judges.filter(j=>j.job_id===job.id).map(j=>({...j,assessment_id:j.id})));
   for(const u of snap.units){
    if(u.execution!=='completed')continue;
    const review=reviews.find(r=>r.job_id===job.id&&r.record_id===u.id&&r.reviewer_type!=='automated_engineering_acceptance'),current=!!review&&review.snapshot_id===snap.snapshot_id;
    const rank=u.critical.length?0:u.quality==='fail'?1:2;
    items.push({id:u.id,job_id:job.id,job_name:job.name,case_id:u.source.case_id,dataset:job.dataset,dataset_version:job.dataset_version,snapshot_id:snap.snapshot_id,source_revision:await hash(JSON.stringify(u)),title:u.title,quality:u.quality,critical_count:u.critical.length,evidence:u.critical,dimensions:u.dimensions,review:review||null,review_current:current,rank,case:ds.cases.find(c=>c.case_id===u.source.case_id)});
   }
  }
  items.sort((a,b)=>a.rank-b.rank||Number(a.review_current)-Number(b.review_current)||a.id.localeCompare(b.id));
  const reviewed=items.filter(i=>i.review_current&&['confirmed','disputed','insufficient'].includes(i.review.status));
  return {items,summary:{total:items.length,pending:items.filter(i=>!i.review_current).length,reviewed:reviewed.length,disputed:reviewed.filter(i=>i.review.status==='disputed').length,insufficient:reviewed.filter(i=>i.review.status==='insufficient').length},note:'分歧占比以本次已复核记录为分母，不代表裁判准确率；审核不覆盖模型原判。'};
 }
 if(rest==='/calibration'&&method==='GET')return json(await queue());
 const groups=async()=>{const revisions=(await list('issue_group')).sort((a,b)=>b.revision-a.revision),ids=new Set();return revisions.filter(g=>{if(ids.has(g.group_id))return false;ids.add(g.group_id);return true}).filter(g=>g.records.length)};
 if(rest==='/issues'&&method==='GET')return json({items:await groups(),history:await list('issue_group')});
 if(rest==='/issues'&&method==='POST'){
  const data=await body(request),q=await queue(),selected=q.items.filter(i=>data.records?.includes(i.id));
  need(Array.isArray(data.records)&&new Set(data.records).size===data.records.length&&selected.length===data.records.length&&selected.length>0,'请选择当前项目的不同回答记录');
  need(typeof data.title==='string'&&data.title.trim().length>=3&&typeof data.reason==='string'&&data.reason.trim().length>=3,'请填写共同问题与合并理由');
  const active=await groups(),replaced=active.filter(g=>g.records.some(r=>data.records.includes(r.record_id)));
  need(replaced.every(g=>g.records.every(r=>data.records.includes(r.record_id))),'合并已分组记录时须选择整组；请先拆开误合并的记录');
  const groupId=ident('issue'),created=stamp(),statements=[];
  for(const old of replaced)statements.push(db.prepare('INSERT INTO evo_objects VALUES(?,?,?,?,?)').bind(old.group_id+'_r'+(old.revision+1),project,'issue_group',created,JSON.stringify({...old,id:undefined,revision:old.revision+1,records:[],supersedes:old.id,merged_into:groupId,actor:owner,reason:data.reason.slice(0,4000)})));
  const payload={group_id:groupId,revision:1,title:data.title.slice(0,200),reason:data.reason.slice(0,4000),actor:owner,records:selected.map(i=>({record_id:i.id,job_id:i.job_id,snapshot_id:i.snapshot_id,title:i.title,quality:i.quality,critical_count:i.critical_count})),merged_from:replaced.map(g=>g.group_id)};
  statements.push(db.prepare('INSERT INTO evo_objects VALUES(?,?,?,?,?)').bind(groupId+'_r1',project,'issue_group',created,JSON.stringify(payload)));await db.batch(statements);return json(payload,201);
 }
 const ig=rest.match(/^\/issues\/([\w-]+)\/split$/);
 if(ig&&method==='POST'){
  const data=await body(request),old=(await groups()).find(g=>g.group_id===ig[1]);need(old,'问题组不存在或已合并',404);
  need(old.id===data.revision,'问题组已变化，请刷新后重试',409);
  need(Array.isArray(data.records)&&new Set(data.records).size===data.records.length&&data.records.length>0&&data.records.length<old.records.length&&data.records.every(id=>old.records.some(r=>r.record_id===id)),'请选择原组中的部分记录');
  need(typeof data.reason==='string'&&data.reason.trim().length>=3,'请说明拆分理由');
  const created=stamp(),groupId=ident('issue'),part={...old,id:undefined,group_id:groupId,revision:1,title:String(data.title||old.title+'（拆分）').slice(0,200),reason:data.reason.slice(0,4000),actor:owner,records:old.records.filter(r=>data.records.includes(r.record_id)),split_from:old.group_id};
  await db.batch([db.prepare('INSERT INTO evo_objects VALUES(?,?,?,?,?)').bind(old.group_id+'_r'+(old.revision+1),project,'issue_group',created,JSON.stringify({...old,id:undefined,revision:old.revision+1,supersedes:old.id,records:old.records.filter(r=>!data.records.includes(r.record_id)),reason:data.reason.slice(0,4000),actor:owner})),db.prepare('INSERT INTO evo_objects VALUES(?,?,?,?,?)').bind(groupId+'_r1',project,'issue_group',created,JSON.stringify(part))]);return json(part,201);
 }
 if(rest==='/candidates/capture'&&method==='POST'){
  const q=await queue();let captured=0;
  for(const row of q.items.filter(i=>i.quality==='fail'||i.critical_count)){
   const id='candidate_'+(await hash(row.id+'|'+row.source_revision)).slice(0,40);
   const payload={record_id:row.id,job_id:row.job_id,snapshot_id:row.snapshot_id,source_revision:row.source_revision,title:row.title,case:row.case,quality:row.quality,critical_count:row.critical_count,review_status:'draft'};
   const result=await db.prepare('INSERT OR IGNORE INTO evo_objects VALUES(?,?,?,?,?)').bind(id,project,'candidate',stamp(),JSON.stringify(payload)).run();
   captured+=result.meta?.changes??result.changes??0;
  }
  return json({captured});
 }
 if(rest==='/candidates'&&method==='GET'){
  const items=await list('candidate'),promotions=await list('candidate_promotion');return json({items:items.map(c=>({...c,promotions:promotions.filter(p=>p.candidate===c.id)}))});
 }
 const cm=rest.match(/^\/candidates\/([\w-]+)\/promote$/);
 if(cm&&method==='POST'){
  const c=await object(db,cm[1],project,'candidate'),data=await body(request);
  need(data.confirmed===true&&typeof data.expectation==='string'&&data.expectation.trim().length>=3,'请核对输入并填写新的回归预期，原回答不会用作金标');
  const current=(await queue()).items.find(i=>i.id===c.record_id);need(current?.source_revision===c.source_revision,'原记录评分已变化，请刷新候选后重新审核',409);
  const cases=validateCases([{...c.case,expected:{behavior:data.expectation},reference:String(data.reference||''),review_status:'confirmed',split:'tuning'}]);
  const datasetId=ident('dataset'),promotionId=ident('candidate_promotion'),version=ident('version');
  const payload={name:String(data.name||'回归 · '+c.title).slice(0,120),version,cases,sha256:await hash(JSON.stringify(cases)),generation:{source:'reviewed_candidate',candidate:c.id,source_job:c.job_id,source_record:c.record_id,actor:owner}};
  await db.batch([db.prepare('INSERT INTO evo_objects VALUES(?,?,?,?,?)').bind(datasetId,project,'dataset',stamp(),JSON.stringify(payload)),db.prepare('INSERT INTO evo_objects VALUES(?,?,?,?,?)').bind(promotionId,project,'candidate_promotion',stamp(),JSON.stringify({candidate:c.id,dataset:datasetId,actor:owner,expectation:data.expectation}))]);
  return json({...payload,id:datasetId},201);
 }
 const dm=rest.match(/^\/jobs\/([\w-]+)\/decisions$/);
 if(dm){const job=await object(db,dm[1],project,'job');
  if(method==='GET')return json({items:(await list('decision')).filter(d=>d.job_id===job.id)});
  if(method==='POST'){
   const data=await body(request),ds=await object(db,job.dataset,project,'dataset'),attempts=(await all(db,'SELECT * FROM evo_attempts WHERE job=? AND project=?',job.id,project)).map(viewAttempt);
   const judges=(await list('assessment')).filter(j=>j.job_id===job.id).map(j=>({...j,assessment_id:j.id}));const snap=await jobSnapshot(job,ds,attempts,judges);
   need(data.snapshot_id===snap.snapshot_id,'评分已更新，请重新核对后记录决定',409);
   need(['continue','fix','evidence'].includes(data.outcome)&&typeof data.reason==='string'&&data.reason.trim().length>=3,'请选择下一步并说明理由');
   need(Array.isArray(data.records)&&data.records.length>0&&data.records.every(id=>snap.units.some(u=>u.id===id)),'请选择本任务中的依据记录');
   if(data.outcome==='continue')need(!job.exploratory&&snap.units.length&&snap.units.every(u=>u.quality==='pass'&&!u.critical.length&&u.review_status==='confirmed'&&u.execution==='completed'&&Object.values(u.dimensions).every(v=>typeof v==='number')),'存在风险、未确认预期或证据缺口，请先修复或补充材料');
   return json(await save(db,project,'decision',{job_id:job.id,snapshot_id:snap.snapshot_id,snapshot:snap,outcome:data.outcome,reason:data.reason.slice(0,4000),records:[...new Set(data.records)],actor:owner,scope:'仅本次任务，不自动批准上线'}),201);
  }
 }
 return null;
}
