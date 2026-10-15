import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {workbench} from './core.mjs';
export function localDatabase(path){
 mkdirSync(dirname(path),{recursive:true});const sql=new DatabaseSync(path);sql.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30000;');
 if(!sql.prepare("SELECT name FROM sqlite_master WHERE name='evo_projects'").get())sql.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
 const prepare=(query)=>{let args=[];return {bind(...values){args=values;return this},async first(){return sql.prepare(query).get(...args)||null},async all(){return {results:sql.prepare(query).all(...args)}},async run(){return sql.prepare(query).run(...args)},_run(){return sql.prepare(query).run(...args)}}};
 return {prepare,async batch(statements){sql.exec('BEGIN IMMEDIATE');try{const result=statements.map(s=>s._run());sql.exec('COMMIT');return result}catch(e){sql.exec('ROLLBACK');throw e}},close(){sql.close()}};
}
if(process.argv.includes('--serve')){
 const db=localDatabase(resolve(process.env.EVO_WORKBENCH_DB||'.local/workbench.db'));const secret=process.env.EVO_SIDECAR_TOKEN;
 if(!secret)throw Error('EVO_SIDECAR_TOKEN required');
 http.createServer(async(req,res)=>{
 try{if(req.headers['x-evo-sidecar']!==secret){res.writeHead(403);res.end();return}
 const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>2*1024*1024){res.writeHead(413);res.end();return}chunks.push(chunk)}
 const headers=new Headers();for(const [k,v]of Object.entries(req.headers))if(v)headers.set(k,String(v));headers.delete('origin');
 const request=new Request('http://127.0.0.1'+req.url,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)});
 const result=await workbench(request,{DB:db,LOCAL_OWNER:'local-workspace',EVO_HTTP_ORIGINS:process.env.EVO_HTTP_ORIGINS||''});res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));
 }catch{res.writeHead(500,{'Content-Type':'application/json'});res.end('{"detail":"Local workbench unavailable"}')}}).listen(Number(process.env.EVO_WORKBENCH_PORT||8198),'127.0.0.1');
}
