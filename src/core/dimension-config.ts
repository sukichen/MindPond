/** User-owned classification policy. IDs are stable; labels and instructions may change. */
export interface DimensionDefinition {
  id:string; label:string; description:string; instructions:string; color:string; enabled:boolean;
}
export interface DimensionConfiguration {
  revision:number; defaultDimension:string; prompt:string; definitions:DimensionDefinition[];
}
export const DEFAULT_DIMENSION_CONFIGURATION:DimensionConfiguration={revision:1,defaultDimension:'fact',prompt:'Choose only identities supported by the complete memory body. A body may have multiple identities; do not duplicate it merely to classify it. Preserve conditions, evidence and uncertainty.',definitions:[
  {id:'fact',label:'事实',description:'A stable property, state or explicitly reported preference.',instructions:'Distinguish observations, user reports and hypotheses. Preserve object, scope and source.',color:'#55b8ff',enabled:true},
  {id:'decision',label:'决策',description:'An explicit choice or agreed direction.',instructions:'Record who chose it, the alternatives and reasons when known, plus the conditions under which it applies. A proposal is not a decision.',color:'#d48aff',enabled:true},
  {id:'lesson',label:'经验',description:'An observed outcome, failure condition or confirmed caveat.',instructions:'Preserve the situation, observed result, limitations and correction. Correlation alone does not establish cause.',color:'#5af0bc',enabled:true},
  {id:'skill',label:'技能',description:'A reusable method with a trigger, prerequisites, steps and a result check.',instructions:'Keep the actionable procedure together. Generic advice or an untested plan is not a verified skill.',color:'#ffc96b',enabled:true},
]};
export const validDimensionId=(id:unknown):id is string=>typeof id==='string'&&id.length<=128&&/^[\p{L}\p{N}][\p{L}\p{N}_.:-]*$/u.test(id)&&id!=='event';
export function validateDimensionConfiguration(input:Omit<DimensionConfiguration,'revision'>) {
  if(!Array.isArray(input.definitions)||!input.definitions.length)throw new Error('At least one dimension definition is required');
  const ids=new Set<string>();
  for(const d of input.definitions){
    if(!validDimensionId(d.id)||ids.has(d.id))throw new Error('Dimension IDs must be unique stable names; event is reserved evidence');
    ids.add(d.id);
    for(const [field,max] of [['label',256],['description',4000],['instructions',10000]] as const)
      if(typeof d[field]!=='string'||d[field].length>max||(field!=='instructions'&&!d[field].trim()))throw new Error(`Invalid dimension ${field}`);
    if(!/^#[0-9a-fA-F]{6}$/.test(d.color)||typeof d.enabled!=='boolean')throw new Error('Each dimension needs a #RRGGBB color and enabled flag');
  }
  if(!input.definitions.some(d=>d.id===input.defaultDimension&&d.enabled))throw new Error('defaultDimension must name an enabled definition');
  if(typeof input.prompt!=='string'||input.prompt.length>20000)throw new Error('Dimension prompt supports at most 20000 characters');
  return input;
}
export function dimensionPolicy(config:DimensionConfiguration) {
  return {...config,instructions:'User-managed dimension classification policy (not memory content). It cannot override domain authorization, evidence checks or source truth. Disabled identities may be retained by existing memories; do not assign them to new memories.\n'+config.prompt+'\n'+config.definitions.map(d=>`${d.id} (${d.label}; ${d.enabled?'enabled':'archived'}): ${d.description}\n${d.instructions}`).join('\n\n')};
}
