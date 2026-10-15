import {useSyncExternalStore} from 'react'
// One page lifetime only. Never persist credentials to browser storage.
let key=''
const listeners=new Set<()=>void>()
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}}
export function useBailianSessionKey():[string,(value:string)=>void]{
 const value=useSyncExternalStore(subscribe,()=>key,()=> '')
 return [value,(next:string)=>{key=next;listeners.forEach(fn=>fn())}]
}
