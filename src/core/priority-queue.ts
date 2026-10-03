/** Max heap for independent ripple frontiers. Equal scores retain insertion order. */
export class PriorityQueue<T extends {score:number}> {
  private entries:Array<{value:T;order:number}>=[];
  private nextOrder=0;
  get length(){return this.entries.length;}
  private higher(a:{value:T;order:number},b:{value:T;order:number}){return a.value.score>b.value.score || (a.value.score===b.value.score && a.order<b.order);}
  push(value:T) {
    const entry={value,order:this.nextOrder++};this.entries.push(entry);
    let i=this.entries.length-1;
    while(i>0){const p=(i-1)>>1;if(!this.higher(entry,this.entries[p]))break;this.entries[i]=this.entries[p];i=p;}
    this.entries[i]=entry;
  }
  shift():T|undefined {
    if(!this.entries.length)return undefined;
    const top=this.entries[0],last=this.entries.pop()!;
    if(this.entries.length){let i=0;for(;;){let c=i*2+1;if(c>=this.entries.length)break;if(c+1<this.entries.length && this.higher(this.entries[c+1],this.entries[c]))c++;if(!this.higher(this.entries[c],last))break;this.entries[i]=this.entries[c];i=c;}this.entries[i]=last;}
    return top.value;
  }
}
