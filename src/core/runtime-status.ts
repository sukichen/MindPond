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
type FilesystemKind='network'|'volatile'|'local_type'|'unknown';
const linuxFilesystems=new Map<number,{name:string;kind:FilesystemKind}>([
    [0x6969,{name:'NFS',kind:'network'}],
    [0xff534d42,{name:'CIFS',kind:'network'}],
    [0xfe534d42,{name:'SMB2',kind:'network'}],
    [0x517b,{name:'SMB',kind:'network'}],
    [0x00c36400,{name:'CephFS',kind:'network'}],
    [0x01021994,{name:'tmpfs',kind:'volatile'}],
    [0x858458f6,{name:'ramfs',kind:'volatile'}],
    [0xef53,{name:'ext2/3/4',kind:'local_type'}],
    [0x58465342,{name:'XFS',kind:'local_type'}],
    [0x9123683e,{name:'Btrfs',kind:'local_type'}],
    [0x794c7630,{name:'OverlayFS',kind:'unknown'}],
    [0x65735546,{name:'FUSE',kind:'unknown'}]
]);

export function classifyDatabaseFilesystem(type:number,platform=process.platform){
    // Linux statfs may expose an unsigned magic as a signed integer.
    return (platform==='linux'?linuxFilesystems.get(type>>>0):undefined)
        ?? {name:null,kind:'unknown' as const};
}

/** Inspect the actual file's mount, including a symlink target or bind mount. */
export async function databaseFilesystem(filename:string){
    if(filename===':memory:')return null;
    try{
        const target=await fs.realpath(filename).catch(async(error:NodeJS.ErrnoException)=>{
            if(error.code!=='ENOENT')throw error;
            // A dangling symlink is an unknown target, not a new local file.
            const existing=await fs.lstat(filename).catch((failure:NodeJS.ErrnoException)=>{
                if(failure.code!=='ENOENT')throw failure;
                return null;
            });
            if(existing)throw error;
            return fs.realpath(path.dirname(filename));
        });
        const stat=await fs.statfs(target);
        return {...classifyDatabaseFilesystem(stat.type),availableBytes:stat.bavail*stat.bsize,totalBytes:stat.blocks*stat.bsize};
    }catch{
        return null;
    }
}

export async function storageStatus(filename:string){
    const size=async(file:string)=>{try{return (await fs.stat(file)).size;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 0;throw error;}};
    const [databaseBytes,walBytes,shmBytes,filesystem]=await Promise.all([
        size(filename),size(filename+'-wal'),size(filename+'-shm'),databaseFilesystem(filename)
    ]);
    return {databaseBytes,walBytes,shmBytes,filesystem};
}
export const webRuntimeStatus=new RuntimeStatus();
