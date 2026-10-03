/** User-owned classification policy. IDs are stable; labels and instructions may change. */
export interface DimensionDefinition {
  id:string; label:string; description:string; instructions:string; color:string; enabled:boolean;
}
export interface DimensionConfiguration {
  revision:number; defaultDimension:string; prompt:string; definitions:DimensionDefinition[];
}
/** Retained for explicit old identities and replay, not the preferred new taxonomy. */
export const LEGACY_DIMENSION_CONFIGURATION:DimensionConfiguration={revision:1,defaultDimension:'fact',prompt:'Choose only identities supported by the complete memory body. A body may have multiple identities; do not duplicate it merely to classify it. Preserve conditions, evidence and uncertainty.',definitions:[
  {id:'fact',label:'事实',description:'A stable property, state or explicitly reported preference.',instructions:'Distinguish observations, user reports and hypotheses. Preserve object, scope and source.',color:'#55b8ff',enabled:true},
  {id:'decision',label:'决策',description:'An explicit choice or agreed direction.',instructions:'Record who chose it, the alternatives and reasons when known, plus the conditions under which it applies. A proposal is not a decision.',color:'#d48aff',enabled:true},
  {id:'lesson',label:'经验',description:'An observed outcome, failure condition or confirmed caveat.',instructions:'Preserve the situation, observed result, limitations and correction. Correlation alone does not establish cause.',color:'#5af0bc',enabled:true},
  {id:'skill',label:'技能',description:'A reusable method with a trigger, prerequisites, steps and a result check.',instructions:'Keep the actionable procedure together. Generic advice or an untested plan is not a verified skill.',color:'#ffc96b',enabled:true},
]};
/** Generic personal/work preset. Existing databases keep their own configuration. */
export const DEFAULT_DIMENSION_CONFIGURATION:DimensionConfiguration={
  revision:1,defaultDimension:'work',
  prompt:'新知识优先选 profile / commitment / environment / work / practice。按完整正文可独立支持的复用视角选择身份，不复制正文。使用已配置的 dimension ID 作为新成员 memoryType，项目或上下文使用 space，子主题使用 tags。fact / decision / lesson / skill 只为历史记忆、用户明确指定及旧计划重放兼容保留。观测、推断、提案、预测和已确认状态必须在正文明确；保留条件、来源和不确定性。配置变化不代表自动重分类历史记忆。',
  definitions:[
    {id:'profile',label:'人物与偏好',description:'人物关系、明确的长期偏好和稳定特点。',instructions:'区分用户陈述、观察与推断；一次行为不能推出稳定偏好。记录适用场景和确认来源。',color:'#65baff',enabled:true},
    {id:'commitment',label:'约定与目标',description:'用户已确认的长期要求、共同约定和长期目标。',instructions:'保留确认依据、状态和适用范围。明确区分提案、已确认、已完成和已撤回；当前任务进度存 session，不当成长期约定。',color:'#d29cff',enabled:true},
    {id:'environment',label:'工具与环境',description:'设备、服务、工具能力、接口和运行条件。',instructions:'记录对象、版本、观察时间、适用条件、失效迹象；不得存密钥。旧配置不自动代表当前环境。',color:'#ffc16d',enabled:true},
    {id:'work',label:'项目与工作知识',description:'项目背景、模块责任、边界、一般工作知识及当前理解。',instructions:'项目通过 space 隔离。保留来源、覆盖范围、未知和有效时间；推断与性能预测不得写成已观测事实。',color:'#58d7cd',enabled:true},
    {id:'practice',label:'方法与经验',description:'可重用操作步骤、故障经验与质量检查清单。',instructions:'一份完整正文保留触发条件、先决要求、步骤、结果检查、失败处理和泛化限制；不要拆碎同一流程。',color:'#f48fa7',enabled:true},
    ...LEGACY_DIMENSION_CONFIGURATION.definitions.map(d=>({...d,label:d.label+'（历史兼容）',instructions:d.instructions+' 这是历史兼容身份；新知识应优先使用当前五个复用视角，除非用户明确指定或重放原计划。'})),
  ],
};
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
