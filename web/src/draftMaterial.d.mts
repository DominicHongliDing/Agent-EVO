export function parseDraftMaterial(content:string):Record<string,any>[];
export function draftCoverage(cases:Record<string,any>[]):{groups:{id:string;label:string;count:number}[];other:number;total:number;multi:number;confirmed:number};
