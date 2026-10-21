/** SQLite files contain private memory and credentials. Do not rely on umask. */
import fs from 'node:fs/promises';
import path from 'node:path';

export async function preparePrivateDatabase(filename:string){
  if(filename===':memory:')return;
  await fs.mkdir(path.dirname(filename),{recursive:true,mode:0o700});
  const file=await fs.open(filename,'a',0o600);
  try{
    if(!(await file.stat()).isFile())throw new Error('Database must be a regular file');
    if(process.platform!=='win32')await file.chmod(0o600);
  }finally{await file.close();}
  if(process.platform==='win32')return;
  // SQLite may canonicalize an explicitly selected symlink. Protect existing
  // sidecars at both names before opening the connection.
  for(const base of new Set([filename,await fs.realpath(filename)])){
    for(const suffix of ['-wal','-shm']){
      try{await fs.chmod(base+suffix,0o600);}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
  }
}

/** VACUUM INTO accepts an empty file. Reserve it privately before any data. */
export async function reservePrivateBackup(filename:string){
  const file=await fs.open(filename,'wx',0o600);await file.close();
}
