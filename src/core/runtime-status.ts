/** Bounded operational evidence. Never stores URLs, arguments, bodies or secrets. */
import {performance} from 'node:perf_hooks';
import fs from 'node:fs/promises';
import path from 'node:path';
export class RuntimeStatus {
    private started=Date.now();
    private counts={requests:0,failed:0,rejected:0,serverErrors:0,aborted:0};
    private samples:number[]=[];
    private errors:Array<{at:number;status:number;aborted:boolean}>=[];
    observe(durationMs:number,status:number,aborted=false){
        this.counts.requests++;if(status>=400)this.counts.failed++;if(status>=400&&status<500)this.counts.rejected++;if(status>=500)this.counts.serverErrors++;if(aborted)this.counts.aborted++;
        if(Number.isFinite(durationMs)&&durationMs>=0){this.samples.push(durationMs);if(this.samples.length>256)this.samples.shift();}
        if(status>=400||aborted){this.errors.push({at:Date.now(),status,aborted});if(this.errors.length>20)this.errors.shift();}
    }
    snapshot(){
        const sorted=[...this.samples].sort((a,b)=>a-b),percentile=(p:number)=>sorted.length?Math.round(sorted[Math.ceil(sorted.length*p)-1]*10)/10:null;
        const memory=process.memoryUsage();
        return {observedAt:Date.now(),startedAt:this.started,uptimeSeconds:Math.floor((Date.now()-this.started)/1000),...this.counts,
            latency:{sampleCount:sorted.length,p50Ms:percentile(.5),p95Ms:percentile(.95),maxMs:sorted.at(-1)??null,scope:'Last 256 completed HTTP requests in this process; includes long waits. HTTP 200 does not prove a tool or task succeeded.'},
            memoryBytes:{rss:memory.rss,heapUsed:memory.heapUsed},recentErrors:[...this.errors],scope:'This process since start. No LLM execution, online-host or whole-deployment claims.'};
    }
    middleware(){return (_req:unknown,res:{statusCode:number;writableEnded:boolean;once:(event:string,fn:()=>void)=>unknown},next:()=>void)=>{const started=performance.now();let done=false;const finish=(aborted:boolean)=>{if(done)return;done=true;this.observe(performance.now()-started,res.statusCode,aborted);};res.once('finish',()=>finish(false));res.once('close',()=>finish(!res.writableEnded));next();};}
}
export async function storageStatus(filename:string){
    const size=async(file:string)=>{try{return (await fs.stat(file)).size;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 0;throw error;}};
    const [databaseBytes,walBytes,shmBytes]=await Promise.all([size(filename),size(filename+'-wal'),size(filename+'-shm')]);
    let filesystem:{availableBytes:number;totalBytes:number}|null=null;
    try{const value=await fs.statfs(path.dirname(filename));filesystem={availableBytes:value.bavail*value.bsize,totalBytes:value.blocks*value.bsize};}catch{/* Explicitly unknown on unsupported filesystems. */}
    return {databaseBytes,walBytes,shmBytes,filesystem};
}
export const webRuntimeStatus=new RuntimeStatus();
