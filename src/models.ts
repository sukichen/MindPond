#!/usr/bin/env node
/** Explicit operator commands; model files and CUDA installs are never automatic. */
import 'dotenv/config';
import { GraphMemory } from './core/graph-memory.js';
import { defaultDatabasePath } from './core/runtime-paths.js';
const args=process.argv.slice(2);
const flag=(name:string)=>{const at=args.indexOf(name);return at<0?undefined:args[at+1];};
const command=args[0];
if(!['status','devices','build','activate'].includes(command))throw new Error('Usage: mindpond-models status|devices|build|activate [--db path] [--profile id] [--max-items 64] [--batches 1]');
const graph=new GraphMemory('.',{dbPath:flag('--db')??defaultDatabasePath()});
try{
  await graph.init();
  if(command==='status')console.log(JSON.stringify(await graph.retrievalProfiles(),null,2));
  if(command==='devices')console.log(JSON.stringify(await graph.retrievalDevices(),null,2));
  if(command==='activate'){
    const id=flag('--profile');if(!id)throw new Error('--profile required');
    console.log(JSON.stringify(await graph.activateRetrievalProfile(id)));
  }
  if(command==='build'){
    const id=flag('--profile');if(!id)throw new Error('--profile required');
    const batches=Number(flag('--batches')??1);if(!Number.isInteger(batches)||batches<1||batches>1000)throw new Error('--batches must be 1–1000');
    for(let i=0;i<batches;i++){
      const result=await graph.buildRetrievalProfile(id,Number(flag('--max-items')??64)) as {coverage:{complete:boolean};failures:unknown[]};
      console.log(JSON.stringify(result));
      if(result.coverage.complete||result.failures.length)break;
    }
  }
}finally{await graph.close();}

// All writes and model workers have drained; native legacy runtimes can retain handles.
process.exit(0);
