type Row=Record<string,any>
// Anonymous workspaces use a random browser-held capability, never a shared owner.
function guestWorkspace(){
 try{let token=localStorage.getItem('evo_guest_workspace');if(!token||!/^[a-f0-9]{64}$/.test(token)){token=Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');localStorage.setItem('evo_guest_workspace',token)}return token}
 catch{throw Error('请允许此站点保存浏览器数据，再打开评测工作台。')}
}
export async function workbenchApi(path:string,body?:Row,method?:string):Promise<Row>{const token=sessionStorage.getItem('evo_access_token');const response=await fetch('/api/workbench'+path,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json','X-EVO-Workbench':'1','X-EVO-Workspace':guestWorkspace(),...(token?{'X-EVO-Token':token}:{}),...(body?.key?{Authorization:'Bearer '+body.key}:{})},body:body?JSON.stringify({...body,key:undefined}):undefined});const result=await response.json().catch(()=>({detail:'任务服务未返回有效数据'}));if(!response.ok)throw Error(result.detail||'任务服务请求失败');return result}
