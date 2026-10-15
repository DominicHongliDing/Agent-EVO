export const coverageLabels:Record<string,string>;
export const coverageKeys:string[];
export function validatePlan(plan:any,max?:number):number;
export function allocateCoverage(count:number,weights:Record<string,number>):Record<string,number>;
export function defaultCoverage(count:number):Record<string,number>;
export function coverageGaps(plan:any,cases:any[]):{counts:Record<string,number>;deficits:Record<string,number>;other:number;missing:number};
