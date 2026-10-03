'use strict';
const $ = id => document.getElementById(id);
const state = { spaces: [], dimensions:null, view: 'search', page: 0, selected: new Map(), memory: null,
  task: null, request: null, plan: null, logCursor: null, search: null, network: null, workContext: null, taskLeases: new Map() };
const busy = new WeakSet();
const text = (tag, value, cls) => { const n = document.createElement(tag); n.textContent = value ?? ''; if (cls) n.className = cls; return n; };
const empty = (title, note) => { const n = text('div', '', 'empty'); n.append(text('strong', title), text('span', note)); return n; };
const badge = (value, cls = '') => text('span', value, 'badge ' + cls);
const when = ts => ts ? new Date(ts).toLocaleString('zh-CN') : '—';
function notice(message, error = false) {
  $('notice').textContent = message; $('notice').className = error ? 'error' : ''; $('notice').hidden = false;
  clearTimeout(notice.timer); notice.timer = setTimeout(() => { $('notice').hidden = true; }, error ? 15000 : 4500);
}
async function api(url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if ($('apiKey').value) headers['x-api-key'] = $('apiKey').value;
  if ($('operatorKey').value) headers['x-operator-key'] = $('operatorKey').value;
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({ error: '服务返回了非 JSON 响应' }));
  if (!response.ok || data.ok === false) throw new Error(response.status === 401 ? '连接需要有效的服务密钥，请在右上角输入 API key。' : data.error || '请求失败');
  return data;
}
async function run(fn, button) {
  if (button && busy.has(button)) return;
  if (button) { busy.add(button); button.setAttribute('aria-busy', 'true'); }
  try { await fn(); } catch (e) { notice(e.message || String(e), true); }
  finally { if (button) { busy.delete(button); button.removeAttribute('aria-busy'); } }
}
function button(label, action, cls = 'smallbtn') {
  const b = text('button', label, cls); b.type = 'button'; b.onclick = () => run(action, b); return b;
}
function on(id, action) { $(id).onclick = e => run(() => action(e), e.currentTarget); }
const freshnessName = value => ({checked:'已核对来源版本',needs_review:'来源或依据已变化 · 待复核',unknown:'尚未核对来源版本'}[value] || '版本未知');
const supportDrafts = new Map();
const actionNames = { embedding_profile_build:'构建模型索引',embedding_profile_activated:'切换向量模型', dimension_configuration_updated:'更新维度与提示词', profile_revised:'修订画像', profile_needs_review:'画像依据待复核', organization_synthesize:'形成 / 修订画像', source_observed:'观察来源变化', memory_sources_updated:'更新来源引用', host_checkpoint:'宿主记忆检查', host_work_claimed:'领取宿主整理工作', host_work_finished:'完成 / 延后宿主整理', host_work_failed:'宿主整理失败', host_work_retried:'重新安排宿主整理', host_work_renewed:'续期宿主整理', transcript_ingested:'摄取原始消息',  node_created:'写入记忆', node_updated:'编辑记忆', node_deleted:'删除记忆', membership_created:'加入空间', association_created:'建立关联', association_reweighted:'更新关联依据与权重', association_deleted:'移除关联', association_carried:'迁移关联依据', association_evidence_reviewed:'复核关联依据', organization_job_claimed:'领取整理任务', organization_job_released:'释放整理任务', organization_consolidate:'整合记忆', organization_associate:'整理并关联', organization_keep:'保留并复查', organization_defer:'暂缓整理', organization_reanchor:'复核检索入口', team_reference_updated:'更新团队知识引用' };
function options(id, values, placeholder, format = v => v) {
  const select = $(id), current = select.value;
  select.replaceChildren(new Option(placeholder, ''), ...values.map(v => new Option(format(v), v)));
  if (values.includes(current)) select.value = current;
}
function dimensionDefinition(id){return state.dimensions?.definitions.find(d=>d.id===id);}
function dimensionLabel(id){return dimensionDefinition(id)?.label||id;}
function selectedDimensions(){return [...new Set($('memoryDimensions').value.split(/[,，]/).map(s=>s.trim()).filter(Boolean))];}
function renderDimensionChoices(){
  const selected=new Set(selectedDimensions()),box=$('memoryDimensionChoices');box.replaceChildren();
  for(const d of state.dimensions?.definitions||[]){
    if(!d.enabled&&!selected.has(d.id))continue;
    const label=text('label','','dimension-choice'),input=document.createElement('input');input.type='checkbox';input.checked=selected.has(d.id);input.value=d.id;
    label.style.setProperty('--dimension-color',d.color);label.title=d.id+' · '+d.description;
    input.onchange=()=>{const values=new Set(selectedDimensions());if(input.checked)values.add(d.id);else values.delete(d.id);$('memoryDimensions').value=[...values].join(', ');};
    label.append(input,text('strong',d.label+(d.enabled?'':' · 停用')),text('small',d.description));box.append(label);
  }
}
$('memoryDimensions').oninput=renderDimensionChoices;
function types(prefix) {
  const space = $(prefix + 'Space').value;
  options(prefix + 'Type', [...new Set(state.spaces.filter(s => !space || s.spaceId === space).map(s => s.memoryType))], prefix === 'org' ? '选择类型' : '全部类型');
}
function scope(prefix) {
  return { spaceId: $(prefix + 'Space').value || undefined, memoryType: $(prefix + 'Type').value || undefined };
}
async function refreshMeta() {
  const [stats, scopes, config] = await Promise.all([api('./api/memory/stats'), api('./api/memory/spaces'),api('./api/memory/dimensions')]);
  await refreshRetrieval();
  state.dimensions=config.configuration;
  for(const d of state.dimensions.definitions)DIM_COLORS[d.id]=d.color;
  renderDimensionLegend();renderDimensionFilters();
  state.spaces = scopes.spaces;
  $('stats').textContent = stats.stats.total + ' 条记忆 · ' + new Set(state.spaces.map(s => s.spaceId)).size + ' 个空间';
  for (const prefix of ['search', 'library', 'org', 'graph']) {
    options(prefix + 'Space', [...new Set(state.spaces.map(s => s.spaceId))], prefix === 'org' ? '选择空间' : '全部空间');
    types(prefix);
  }
}
async function show(view) {
  state.view = view;
  $('currentPage').textContent = {search:'搜索记忆',library:'记忆库',organize:'整理记忆',work:'协作任务',graph:'空间图谱',dimensions:'维度与提示词',log:'操作日志'}[view];
  document.querySelectorAll('.view').forEach(n => { n.hidden = n.id !== 'view-' + view; });
  document.querySelectorAll('[data-view]').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  if (view === 'dimensions') await loadDimensions();
  if (view === 'library') await loadLibrary();
  if (view === 'work') await loadWorkContexts();
  if (view === 'log') await loadLog();
  if (view === 'graph') await loadGraph();
  if (view === 'organize') await loadOrganizationRequests();
}
function evidenceView(a) {
  const box = text('div', '', 'evidence-box');
  const status = { supported: '已有依据 · 适用性仍需判断', needs_review: '来源已变化 · 待复核', missing: '历史关联 · 待补充依据', retired: '依据已停用 · 暂停传播' }[a.evidenceStatus] || '待补充依据';
  box.append(text('strong', status + ' / 权重 ' + a.weight));
  for (const e of a.evidence || []) {
    box.append(text('p', '为何相关　' + e.reason), text('p', '适用场景　' + e.context),
      text('p', '记录于 ' + when(e.createdAt) + (e.review ? ' · ' + (e.review.decision === 'retire' ? '已停用' : '已复核') + '：' + e.review.reason : ''), 'basis-meta'));
  }
  if (!a.evidence?.length) box.append(text('p', '尚未记录原始情境。缺少依据不代表关联无效；请补充来源后再判断。'));
  return box;
}
function card(n, result = false) {
  const c = text('article', '', 'card'), header = text('div', '', 'row between'), tags = text('div', '', 'row');
  tags.append(badge(n.layer));if(n.spaceId)tags.append(badge(n.spaceId));
  for(const id of n.dimensions?.length?n.dimensions:[n.dimension].filter(Boolean)){const b=badge(dimensionLabel(id),'dimension-badge');b.dataset.dimensionId=id;b.style.setProperty('--dimension-color',dimensionDefinition(id)?.color||'#8a9a8e');b.title=id+' · '+(dimensionDefinition(id)?.description||'');tags.append(b);}
  if (n.domain) tags.append(badge(n.domain.kind + ' / ' + n.domain.id));
  if(n.profiles?.length)tags.append(badge('画像','direct'));
  if(n.freshness)tags.append(badge(freshnessName(n.freshness.status),n.freshness.status==='needs_review'?'review':''));
  if(result)c.dataset.review=n.freshness?.status==='needs_review'?'yes':'no';
  if (n.memoryType) tags.append(badge(n.memoryType));
  if (result) tags.append(badge(n.depth === 0 ? '直接命中 · 入口' : '第 ' + n.depth + ' 波带出', n.depth === 0 ? 'direct' : 'ripple'));
  header.append(tags, button('查看 / 编辑', () => openMemory(n.id)));
  c.append(header, text('div', n.content, 'content'));
  const footer = text('div', '', 'row between');
  footer.append(text('span', '重要度 ' + n.importance + ' · ' + (n.tags || []).join(' / '), 'muted'));
  if (result) footer.append(text('span', 'score ' + n.score.toFixed(4), 'score'));
  c.append(footer);
  return c;
}
$('searchForm').onsubmit = e => { e.preventDefault(); run(search, e.submitter); };
async function search() {
  const domainId = $('searchDomainId').value.trim();
  const domain = domainId ? { kind: $('searchDomainKind').value, id: domainId } : undefined;
  const request = { retrievalProfile:$('searchProfile').value||undefined,vectorAlgorithm:$('searchAlgorithm').value||undefined,reranker:$('searchReranker').value||undefined,dimension:$('searchDimension').value||undefined, query: $('query').value.trim(), limit: +$('searchLimit').value, maxDepth: +$('searchDepth').value,
    minScore: +$('searchScore').value, sessionId: $('searchSession').value || undefined,
    domains: domain ? [domain] : undefined, sourceContext: $('sourceContext').value.trim() || undefined, includeL0: $('includeL0').checked, ...scope('search') };
  if (!request.query) return;
  $('searchSummary').textContent = '正在执行混合检索与涟漪扩散…';
  const started = performance.now();
  try {
    const [response, direct] = await Promise.all([api('./api/memory/search', request),
      $('compare').checked ? api('./api/memory/search', { ...request, maxDepth: 0 }) : Promise.resolve(null)]);
    $('view-search').classList.add('has-results');
    state.search = { endpoint: 'POST /api/memory/search', request, response, directOnly: direct };
    $('searchJson').textContent = JSON.stringify(state.search, null, 2); $('searchRaw').hidden = false; $('copySearch').disabled = false;
    $('searchInsights').replaceChildren(...[['直接命中', response.results.filter(h => h.depth === 0).length], ['关联带出', response.results.filter(h => h.depth > 0).length]].map(([label, value]) => { const n = text('div', '', 'insight'); n.append(text('span', label), text('strong', value)); return n; }));
    const hits = response.results, base = new Set(direct?.results.map(h => h.id));
    const names = new Map(hits.map(h => [h.id, h.content.slice(0, 26)]));
    $('searchSummary').textContent = hits.length + ' 条结果 · ' + hits.filter(h => h.depth === 0).length + ' 个直接命中 · ' +
      hits.filter(h => h.depth > 0).length + ' 条关联带出 · ' + Math.round(performance.now() - started) + ' ms' +
      (direct ? ' ｜直接检索 ' + direct.results.length + ' 条，本次新增 ' + hits.filter(h => !base.has(h.id)).length + ' 条（同上限对照）' : '');
    if(response.retrieval?.degraded) {
      const labels={'body-vector':'正文向量','body-text':'正文文本','body-zh':'中文向量','anchors':'锚点','reranker':'重排'};
      const failed=[...new Set(response.retrieval.channels.filter(c=>c.status==='failed'||(c.status==='unavailable'&&c.channel!=='anchors')).map(c=>labels[c.channel]||c.channel))];
      const reasons=[];if(failed.length)reasons.push(failed.join('、')+'暂不可用');if(response.retrieval.profile?.fallbackReason)reasons.push('配置模型尚未就绪，使用旧索引');if(response.retrieval.profile?.algorithm?.fallbackReason)reasons.push('HNSW 不可用，使用精确检索');
      $('searchSummary').textContent+=' ｜'+reasons.join('；');
    }
    if(response.retrieval?.profile){const p=response.retrieval.profile;$('searchSummary').textContent+=' ｜模型 '+p.selected+(p.runtime?.actualDevice?' · '+p.runtime.actualDevice:'')+(p.algorithm?.actual?' · '+p.algorithm.actual:'');}
    $('searchResults').replaceChildren(...hits.map(h => {
      const c = card(h, true), p = text('div', '', 'path'); p.append(text('span', '召回路径'));
      (h.path || []).forEach((id, i) => { if (i) p.append(text('span', '→')); p.append(button(names.get(id) || id.slice(0, 12), () => openMemory(id))); });
      c.append(p);
      if(h.dimensions?.length)c.append(text('p','知识身份：'+h.dimensions.map(dimensionLabel).join(' + '),'muted'));
      if(h.matchedAnchors?.length)c.append(text('p','命中入口：'+h.matchedAnchors.map(a=>a.text).join('；')+'（请核对适用条件）','muted'));
      if(h.dimensionBridges?.length)c.append(text('p','维度桥梁：'+h.dimensionBridges.map(b=>dimensionLabel(b.from)+' → '+dimensionLabel(b.to)+'（同一记忆，不增加跳数）').join('；'),'note'));
      if (h.associationPath?.length) {
        const basis = document.createElement('details');
        basis.append(text('summary', '为什么带出这条记忆？ · 查看 ' + h.associationPath.length + ' 段关联依据'));
        for (const a of h.associationPath) basis.append(evidenceView(a));
        c.append(basis);
      }
      if (direct && !base.has(h.id)) c.append(badge('相较仅直接命中新增', 'ripple'));
      return c;
    }));
    $('onlyReview').onchange();
    if (!hits.length) $('searchResults').append(empty('没有匹配的记忆', '试试更具体的情境，或调整空间、阈值与会话范围。'));
  } catch (e) { $('searchSummary').textContent = '搜索失败，当前显示的结果未更新'; throw e; }
}
function selectionChanged() {
  $('selectionBar').hidden = !state.selected.size;
  $('selectionCount').textContent = '已选择 ' + state.selected.size + ' 条记忆';
  $('organizeSelection').disabled = state.selected.size < 2;
}
async function loadLibrary() {
  const q = new URLSearchParams({ limit: '30', offset: String(state.page * 30), activeOnly: $('libraryState').value, scope: 'operator' });
  for (const [k, v] of Object.entries(scope('library'))) if (v) q.set(k, v);
  if ($('libraryLayer').value) q.set('layer', $('libraryLayer').value);
  if ($('libraryDimension').value) q.set('dimension', $('libraryDimension').value);
  const data = await api('./api/memory/list?' + q);
  $('librarySummary').textContent = data.total + ' 条记忆 · 正文跨空间共享；整理只替换所选空间的成员';
  $('pageLabel').textContent = '第 ' + (state.page + 1) + ' 页';
  $('prevPage').disabled = state.page === 0; $('nextPage').disabled = (state.page + 1) * 30 >= data.total;
  $('libraryResults').replaceChildren(...data.nodes.map(n => {
    const c = card(n), m = (n.memberships || []).filter(m => m.active &&
      (!$('librarySpace').value || m.spaceId === $('librarySpace').value) && (!$('libraryType').value || m.memoryType === $('libraryType').value));
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = state.selected.has(n.id);
    check.disabled = !m.length || n.layer === 'L0'; check.setAttribute('aria-label', '选择记忆 ' + n.content.slice(0, 30));
    check.onchange = () => { if (check.checked) state.selected.set(n.id, n); else state.selected.delete(n.id); c.classList.toggle('selected', check.checked); selectionChanged(); };
    c.classList.toggle('selected', check.checked); c.querySelector('.row').prepend(check);
    const placements = text('div', '', 'row');
    for (const membership of n.memberships || []) placements.append(badge(membership.spaceId + ' / ' + membership.memoryType + (membership.active ? '' : ' · 已整合来源')));
    c.append(placements); return c;
  }));
  if (!data.nodes.length) $('libraryResults').append(empty('这里还没有记忆', '调整筛选条件，或新增第一条完整记忆。'));
  selectionChanged();
}
async function openMemory(id) {
  const data = id ? await api('./api/memory/node/' + encodeURIComponent(id) + '?scope=operator') : null;
  state.memory = data;
  $('nodeHistory').hidden=!id;$('memoryHistory').hidden=true;$('memoryHistory').replaceChildren();
  $('memoryEditReasonField').hidden=!id;$('memoryEditReason').value='';
  $('editTeamGrant').hidden=data?.node.domain.kind!=='team';$('memoryTeamAuthorization').value='';
  $('memoryTitle').textContent = id ? '记忆详情 / 编辑' : '新增记忆';
  $('memoryContent').value = data?.node.content || ''; $('memoryImportance').value = data?.node.importance ?? 5;
  $('memorySources').value = JSON.stringify(data?.node.sourceRefs || [],null,2);
  $('memoryDimensions').value=(data?.node.dimensions||(id?[]:[state.dimensions?.defaultDimension||'fact'])).join(', ');
  renderDimensionChoices();
  $('memoryAnchors').value=JSON.stringify((data?.node.anchors||[]).map(({text,basis,spaceId,memoryType})=>({text,basis,spaceId,memoryType})),null,2);
  $('reviewAnchors').checked=false;
  $('anchorStatus').textContent=(data?.node.anchors||[]).filter(a=>a.status==='needs_review').length+' 个入口待复核';
  $('memoryTags').value = (data?.node.tags || []).join(', '); $('newScope').hidden = !!id;
  $('newSpace').value = $('librarySpace').value; $('newType').value = $('libraryType').value;
  $('newDomainKind').value = data?.node.domain?.kind || 'personal'; $('newDomainId').value = data?.node.domain?.id || 'default'; $('newTeamAuthorization').value = '';
  $('memoryScope').textContent = data ? 'Domain：' + data.node.domain.kind + ' / ' + data.node.domain.id + '；正文编辑影响所有空间成员：' + data.memberships.map(m => m.spaceId + ' / ' + m.memoryType + (m.active ? '' : '（来源）')).join('；') : '创建一条完整记忆，并明确它所属的 domain、空间与类型。';
  $('nodeLog').hidden = !id; $('deleteArea').hidden = !id; $('deleteConfirm').checked = false; $('deleteMemory').disabled = true;
  $('memoryRelations').replaceChildren();
  if (!$('memoryDialog').open) $('memoryDialog').showModal();
  if (!data) return;
  for(const p of data.node.profiles || []) $('memoryRelations').append(button('画像：'+p.title+' · 第 '+p.revision+' 版',()=>showProfile(p.membershipId)));
  const relations = text('section'); relations.append(text('h3', '无向关联'));
  for (const a of data.associations) {
    const own = new Set(data.memberships.map(m => m.id)), target = own.has(a.memberAId) ? a.memoryB : a.memoryA;
    const row = text('div', '', 'relation');
    const reasonLabel = text('label', '关联理由（新增或补充，保留已有记录）'), contextLabel = text('label', '适用场景 / 条件与例外');
    const reasonInput = document.createElement('textarea'), contextInput = document.createElement('textarea');
    reasonInput.value = a.evidence?.at(-1)?.reason || ''; contextInput.value = a.evidence?.at(-1)?.context || '';
    reasonInput.style.minHeight = contextInput.style.minHeight = '75px';
    reasonLabel.append(reasonInput); contextLabel.append(contextInput);
    const editor = document.createElement('details'); editor.append(text('summary', '补充关联依据 / 调整权重'), reasonLabel, contextLabel);
    const value = document.createElement('input'); value.type = 'number'; value.min = '0'; value.max = '1'; value.step = '.05'; value.value = a.weight; value.style.width = '90px'; value.setAttribute('aria-label', '关联权重 ' + a.id);
    row.append(text('p', a.spaceId + ' / ' + a.memoryType, 'muted'),
      target ? button(target.content.slice(0, 90), () => openMemory(target.id)) : text('span', '关联记忆'), evidenceView(a));
    editor.append(value, button('保存依据与权重', async () => { await api('./api/memory/association', { ...a, weight: +value.value, reason: reasonInput.value, context: contextInput.value }); notice('关联依据已保存'); await openMemory(id); }));
    for (const e of a.evidence || []) {
      const review = document.createElement('details'), whyLabel = text('label', '复核结论的具体依据'), why = document.createElement('textarea');
      why.style.minHeight = '70px'; whyLabel.append(why);
      review.append(text('summary', '复核场景：' + e.context.slice(0, 55)), whyLabel);
      const apply = async decision => { await api('./api/memory/association/review', { id: a.id, evidenceId: e.id, decision, reason: why.value, expectedUpdatedAt: a.updatedAt }); notice('复核已记录'); await openMemory(id); };
      review.append(button('确认原场景下仍有效', () => apply('confirm')), button('停用这条依据', () => apply('retire')),
        text('p', '只因当前任务不同，不应停用。全部依据停用后，这条关联暂停传播；可重新确认恢复。', 'muted'));
      editor.append(review);
    }
    row.append(editor,
      button('移除关联', async () => { await api('./api/memory/association/delete', { id: a.id, reason: '用户在工作台移除关联' }); notice('关联已移除'); await openMemory(id); }, 'smallbtn danger'));
    relations.append(row);
  }
  if (!data.associations.length) relations.append(text('p', '暂无活跃关联。可在人工整理中选择两条同范围记忆建立关联。', 'muted'));
  $('memoryRelations').append(relations);
  const connections = await api('./api/memory/node/' + encodeURIComponent(id) + '/connections?scope=operator');
  if (state.memory?.node.id !== id) return;
  const sources = connections.connections.filter(c => ['derived_from', 'aggregates', 'distills'].includes(c.label));
  if (sources.length) {
    $('memoryRelations').append(text('h3', '来源与整合记录'));
    for (const c of sources) $('memoryRelations').append(button(c.label + ' · ' + c.node.content.slice(0, 55), () => openMemory(c.node.id)));
  }
}
$('memoryForm').onsubmit = e => { e.preventDefault(); run(async () => {
  const patch = { sourceRefs: JSON.parse($('memorySources').value || '[]'), content: $('memoryContent').value, importance: +$('memoryImportance').value, tags: $('memoryTags').value.split(/[,，]/).map(t => t.trim()).filter(Boolean) };
  const dimensions=selectedDimensions();
  if(!dimensions.length)throw new Error('至少选择一个知识维度');
  if(dimensions.some(id=>!dimensionDefinition(id)))throw new Error('维度 ID 不在当前配置中，请重新选择');
  if(JSON.stringify(dimensions)!==JSON.stringify(state.memory?.node.dimensions||[]) || (!state.memory&&dimensions.length))patch.dimensions=dimensions;
  if($('reviewAnchors').checked)patch.anchors=JSON.parse($('memoryAnchors').value||'[]');
  if (state.memory) {
    patch.reason=$('memoryEditReason').value.trim();if(!patch.reason)throw new Error('请填写本次修改原因');
    await api('./api/memory/update', { nodeId: state.memory.node.id, scope: 'operator', ...patch,
    expectedContent: state.memory.node.content, expectedUpdatedAt: state.memory.node.updatedAt,teamAuthorization:$('memoryTeamAuthorization').value||undefined });
  } else {
    if (!$('newSpace').value.trim() || !$('newType').value.trim()) throw new Error('请填写空间和类型');
    const domain = {kind:$('newDomainKind').value,id:$('newDomainId').value.trim()};
    if (!domain.id) throw new Error('请填写 domain ID');
    await api('./api/memory/save', { ...patch, domain, sessionId: domain.kind === 'session' ? domain.id : undefined,
      teamAuthorization: $('newTeamAuthorization').value || undefined, memberships: [{ spaceId: $('newSpace').value.trim(), memoryType: $('newType').value.trim() }] });
  }
  $('memoryDialog').close(); notice('记忆已保存，操作已记录'); await refreshMeta();
  if (state.view === 'library') await loadLibrary();
  if (state.task) invalidatePreview();
}, e.submitter); };
function invalidatePreview() { state.plan = null; $('planPreview').hidden = true; $('commitPlan').hidden = true; }
async function releaseTask() {
  if (state.task) {
    if(state.task.requestId)await api('./api/host/organization/request/report',{requestId:state.task.requestId,jobId:state.task.job.id,result:'released',reason:'用户释放人工批次'});
    else await api('./api/organization/release', { jobId: state.task.job.id });
  }
  state.task = null; invalidatePreview(); $('orgEditor').hidden = true;
  if(state.request)await inspectOrganizationRequest(state.request.requestId);
  $('release').disabled = true; $('renew').disabled = true; $('claim').disabled = false;
  $('jobSummary').textContent = '任务已释放，可以重新领取或从记忆库选择。';
}
async function claim(ids) {
  const s = scope('org');
  if (!s.spaceId || !s.memoryType) throw new Error('请先选择一个空间和一个记忆类型');
  if (state.task) throw new Error('请先释放当前任务，避免覆盖尚未完成的整理');
  const task = await api('./api/organization/claim', { ...s, membershipIds: ids, maxMembers: 8 });
  if (!task.job) { notice('当前范围没有至少两条可整理记忆，或它们已被其他任务领取'); return; }
  displayOrganizationTask(task);
}
function displayOrganizationTask(task) {
  state.task = task; supportDrafts.clear(); invalidatePreview();
  $('profileTitle').value='';$('profileCoverage').value='';$('profileUnknowns').value='';
  $('profileTarget').replaceChildren(new Option('新建画像',''),...task.job.members.filter(m=>m.memory.profiles?.some(p=>p.membershipId===m.membership.id)).map(m=>new Option(m.memory.profiles.find(p=>p.membershipId===m.membership.id).title,m.membership.id))); $('orgEditor').hidden = false; $('release').disabled = false; $('renew').disabled = false;
  $('jobSummary').textContent = task.job.members.length + ' 条来源 · ' + task.job.spaceId + ' / ' + task.job.memoryType + ' · 租约截至 ' + when(task.job.leaseExpiresAt);
  $('orgContent').value = ''; $('orgReason').value = ''; $('orgContext').value = ''; $('agentPlan').value = '';
  $('orgAssociations').replaceChildren(text('h3', '已有关系 · 在原始情境下判断'));
  for (const a of task.job.associations || []) {
    const d = document.createElement('details'); d.append(text('summary', (a.memoryA?.content.slice(0, 35) || '记忆') + ' ↔ ' + (a.memoryB?.content.slice(0, 35) || '记忆')), evidenceView(a)); $('orgAssociations').append(d);
  }
  if (!task.job.associations?.length) $('orgAssociations').append(text('p', '本批次暂无已记录关联。', 'muted'));
  $('orgSources').replaceChildren(...task.job.members.map((item, i) => {
    const n = text('article', '', 'card'), label = text('label', '', 'check'), check = document.createElement('input');
    check.type = 'checkbox'; check.checked = true; check.value = item.membership.id; check.className = 'org-choice';
    check.onchange = () => { invalidatePreview(); if ($('opKind').value === 'synthesize') renderSupports(); };
    label.append(check, text('strong', '来源 ' + (i + 1) + ' · ' + item.memory.layer));
    n.append(label, text('div', item.memory.content, 'source'), text('p', item.membership.id + ' · 版本 ' + item.membership.version, 'mono'),
      text('p', '来源：' + (item.memory.source || '未提供') + ' · 会话：' + (item.memory.sessionId || '全局'), 'muted'),
      button('查看原记忆', () => openMemory(item.memory.id)));
    return n;
  }));
  $('opKind').onchange();
}
const requestEventPages=new Map();
let requestRefreshVersion=0;
try {
  const domain=JSON.parse(sessionStorage.getItem('mindpond:request-domain')||'null');
  if(domain&&['personal','session','team'].includes(domain.kind)&&typeof domain.id==='string'&&domain.id.trim()) {
    $('requestDomain').value=domain.kind;$('requestDomainId').value=domain.id;
  }
} catch {}
const requestStates={queued:'等待 agent 或人工领取',running:'处理中（以事件与提交回执为准）',waiting:'等待执行者 / 租约',completed:'本次范围已处理',partial:'部分完成',failed:'处理失败',cancelled:'已取消'};
function requestDomain() {
  const kind=$('requestDomain').value,id=$('requestDomainId').value.trim();
  if(!id)throw new Error('请填写实际域 / 会话 ID');
  return {kind,id};
}
async function loadOrganizationRequests() {
  const domain=requestDomain();
  sessionStorage.setItem('mindpond:request-domain',JSON.stringify(domain));
  const r=await api('./api/host/organization/requests',{domains:[domain],sessionId:domain.kind==='session'?domain.id:undefined,limit:50});
  $('requestList').replaceChildren(...r.requests.map(p=>{
    const row=text('article','','card');row.append(text('strong',p.spaceId+' / '+p.memoryType),text('p',requestStates[p.status]+' · '+p.total+' 条候选'),button('查看请求',()=>inspectOrganizationRequest(p.requestId)));return row;
  }));
  if(!r.requests.length)$('requestList').append(text('p','此范围暂无请求。','muted'));
  const remembered=sessionStorage.getItem('mindpond:request');if(!state.request&&r.requests.some(p=>p.requestId===remembered))await inspectOrganizationRequest(remembered);
}
async function inspectOrganizationRequest(requestId) {
  const version=++requestRefreshVersion;
  const p=await api('./api/organization/request/'+encodeURIComponent(requestId));
  if(version!==requestRefreshVersion)return;
  state.request=p;sessionStorage.setItem('mindpond:request',p.requestId);
  $('requestDetail').hidden=false;$('requestHeading').textContent=p.spaceId+' / '+p.memoryType+' · '+requestStates[p.status];
  const done=p.concluded;
  $('requestProgress').textContent=`候选 ${p.total} · 待处理 ${p.pending} · 已领取 ${p.inFlight||0} · 已整理 ${done.reviewed} · 无需修改 ${done.no_change} · 暂缓 ${done.deferred} · 失败 ${done.failed} · 未覆盖 ${done.uncovered}
`+(p.waitReason||p.receipt?.reason||'')+'\n'+p.requestId;
  const terminal=['completed','partial','failed','cancelled'].includes(p.status);
  $('nextRequestBatch').disabled=terminal||!!state.task;$('cancelRequest').disabled=terminal;$('retryRequest').hidden=!terminal;
  const page=requestEventPages.get(requestId)||{seq:0,events:[]};
  const events=await api('./api/organization/request/'+encodeURIComponent(requestId)+'/events?afterSeq='+page.seq+'&limit=100');
  if(version!==requestRefreshVersion)return;
  for(const event of events.events)if(event.seq>page.seq){page.events.push(event);page.seq=event.seq;}
  page.events=page.events.slice(-100);requestEventPages.set(requestId,page);
  $('requestEvents').textContent=JSON.stringify({throughSeq:page.seq,latestSeq:events.latestSeq,events:page.events},null,2);
}
async function startOrganizationRequest(input) {
  const scopeInput=input||{...scope('org'),domain:requestDomain(),batchSize:+$('requestBatch').value,limit:+$('requestLimit').value};
  if(!scopeInput.spaceId||!scopeInput.memoryType)throw new Error('请选择整理空间和类型');
  const fingerprint=JSON.stringify(scopeInput);
  let pending;try{pending=JSON.parse(sessionStorage.getItem('mindpond:request-draft')||'null');}catch{}
  if(!pending||pending.fingerprint!==fingerprint)pending={fingerprint,key:'workbench-'+Date.now()+'-'+Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16)).join('')};
  sessionStorage.setItem('mindpond:request-draft',JSON.stringify(pending));
  const p=await api('./api/host/organization/request/start',{...scopeInput,idempotencyKey:pending.key});
  $('requestDomain').value=p.domain.kind;$('requestDomainId').value=p.domain.id;
  sessionStorage.removeItem('mindpond:request-draft');await loadOrganizationRequests();await inspectOrganizationRequest(p.requestId);
}
async function nextOrganizationBatch() {
  if(state.task)throw new Error('请先提交或释放当前批次');
  const requestId=state.request?.requestId;if(!requestId)return;
  const r=await api('./api/host/organization/request/next',{requestId});
  if(r.job)displayOrganizationTask({...r,requestId});
  await inspectOrganizationRequest(requestId);
}

async function organizeSelected() {
  const s = scope('library');
  if (!s.spaceId || !s.memoryType) throw new Error('先在记忆库筛选到一个空间和类型，再选择要整理的记忆');
  if (state.selected.size < 2 || state.selected.size > 24) throw new Error('请选择 2–24 条记忆');
  const ids = [...state.selected.values()].map(n => n.memberships.find(m => m.active && m.spaceId === s.spaceId && m.memoryType === s.memoryType)?.id);
  if (ids.some(id => !id)) throw new Error('所选记忆不全属于当前范围，请清空后重新选择');
  $('orgSpace').value = s.spaceId; types('org'); $('orgType').value = s.memoryType;
  await show('organize'); await claim(ids);
}
const chosen = () => [...document.querySelectorAll('.org-choice:checked')].map(n => n.value);
function renderSupports() {
  const target=$('profileTarget').value;
  $('profileSupports').replaceChildren();
  for(const id of chosen().filter(id=>id!==target)) {
    const item=state.task.job.members.find(m=>m.membership.id===id);
    const values=supportDrafts.get(id) || {claim:'',context:''};supportDrafts.set(id,values);
    const box=text('section','','basis');box.append(text('strong',item.memory.content.slice(0,100)));
    for(const [key,label] of [['claim','支撑的具体认识'],['context','成立的场景 / 条件']]) {
      const field=text('label',label),input=document.createElement('textarea');input.value=values[key];
      input.oninput=()=>{values[key]=input.value;invalidatePreview();};field.append(input);box.append(field);
    }
    $('profileSupports').append(box);
  }
}
function humanPlan() {
  const kind=$('opKind').value, target=$('profileTarget').value;
  const membershipIds=chosen().filter(id=>kind!=='synthesize'||id!==target),reason=$('orgReason').value.trim();
  if(!membershipIds.length)throw new Error('请选择来源成员');
  if(['consolidate','associate','synthesize'].includes(kind)&&membershipIds.length<2)throw new Error('请至少选择两条来源');
  if(kind==='associate'&&membershipIds.length!==2)throw new Error('关联需要恰好两条来源');
  if(!reason)throw new Error('请填写整理说明');
  const op={kind,membershipIds,reason};
  if(['consolidate','synthesize'].includes(kind))op.content=$('orgContent').value;
  if(kind==='associate'){op.weight=+$('orgWeight').value;op.context=$('orgContext').value.trim();}
  if(kind==='synthesize') {
    const lines=id=>$(id).value.split('\n').map(v=>v.trim()).filter(Boolean);
    op.profile={title:$('profileTitle').value.trim(),coverage:lines('profileCoverage'),unknowns:lines('profileUnknowns')};
    if(target)op.targetMembershipId=target;
    op.supports=membershipIds.map(id=>({membershipId:id,...supportDrafts.get(id)}));
  }
  return {operations:[op]};
}
async function showProfile(membershipId,offset=0) {
  const p=await api('./api/memory/profile/get',{membershipId,offset,limit:10,scope:'operator'});
  $('profileHeading').textContent=p.profile.title+' · 第 '+p.revision+' 版';
  const box=$('profileBody');box.replaceChildren(badge(freshnessName(p.freshness.status)),text('div',p.content,'source'),text('h3','实际覆盖范围'));
  for(const v of p.profile.coverage)box.append(text('p',v));
  box.append(text('h3','未知 / 未审查范围'));for(const v of p.profile.unknowns)box.append(text('p',v));
  box.append(text('h3','保留的支撑记忆'));
  for(const child of p.supports) {
    const row=text('section','','basis');row.append(text('strong',child.claim),text('p',child.context),text('p','依据版本 '+child.sourceVersion+' / 当前 '+(child.currentVersion ?? '已删除')+(child.active?'':' · 已停用'),'muted'),text('div',child.content || '原始内容已删除，请重新核验','source'));
    if(child.memoryId)row.append(button('查看 / 编辑依据记忆',async()=>{$('profileDialog').close();await openMemory(child.memoryId);}));box.append(row);
  }
  const pager=text('div','','row');if(offset)pager.append(button('上一页依据',()=>showProfile(membershipId,Math.max(0,offset-10))));if(p.nextOffset!==null)pager.append(button('下一页依据',()=>showProfile(membershipId,p.nextOffset)));box.append(pager);
  if(p.parents.length){box.append(text('h3','依赖这份认识的上层画像'));for(const id of p.parents)box.append(button('查看上层画像',()=>showProfile(id)));}
  box.append(button('查看修订历史',async()=>{const revisions=await api('./api/memory/profile/history',{membershipId,scope:'operator'});const history=text('section');history.append(text('h3','修订历史'));for(const r of revisions){const entry=document.createElement('details');entry.append(text('summary','第 '+r.revision+' 版 · '+when(r.at)),text('div',r.content,'source'),text('p',r.reason));history.append(entry);}box.append(history);}));
  if(!$('profileDialog').open)$('profileDialog').showModal();
}
async function showWork() {
  const selected=scope('org');if(!selected.spaceId||!selected.memoryType)throw new Error('先选择整理空间和类型');
  const work=await api('./api/host/work/list',selected);const box=$('workBody');box.replaceChildren(text('h3',selected.spaceId+' / '+selected.memoryType));
  for(const item of work){const row=text('section','','basis');row.append(text('strong',({pending:'待处理',leased:'宿主处理中',completed:'已完成',failed:'需要处理失败原因'}[item.status]||item.status)+' · 尝试 '+item.attempts+' 次'),text('p',item.payload.reason),text('p',item.payload.hostId+' / '+item.payload.runId,'muted'));if(item.receipt)row.append(text('p',item.receipt.reason));if(item.status==='failed')row.append(button('重新安排整理',async()=>{await api('./api/host/work/retry',{workId:item.id,reason:'用户在工作台检查失败记录后重新安排'});await showWork();}));box.append(row);}
  if(!work.length)box.append(empty('暂无宿主整理工作','宿主提交记忆检查点后，待处理事项会出现在这里。'));
  if(!$('workDialog').open)$('workDialog').showModal();
}

async function preview(plan) {
  if (!state.task) throw new Error('请先领取任务');
  invalidatePreview();
  const result = await api('./api/organization/validate', { jobId: state.task.job.id, plan });
  state.plan = JSON.parse(JSON.stringify(plan));
  const box = $('planPreview'); box.hidden = false;
  box.replaceChildren(text('h3', '03 / 核对变更'), text('p', '将替换 ' + result.replacedMembershipIds.length + ' 个空间成员；其他空间成员与原始正文保留。'));
  const operationNames = { synthesize:'形成 / 修订画像（保留所有来源）', consolidate: '整合为一条完整记忆', associate: '建立无向关联', keep: '保持原样并标记复查', defer: '暂缓整理' };
  for (const op of plan.operations) {
    box.append(text('div', operationNames[op.kind] + ' · ' + op.membershipIds.length + ' 条来源', 'note'), text('div', op.content || op.reason || '', 'source'));
    if (op.kind === 'associate') box.append(text('p', '适用场景：' + op.context + ' · 权重 ' + op.weight, 'note'));
  }
  for (const w of result.warnings) box.append(text('p', w, 'warning'));
  for (const a of result.removedAssociations) {
    const name = (id, memory) => memory?.content || state.task.job.members.find(m => m.membership.id === id)?.memory.content || '当前批次以外的关联记忆';
    box.append(text('p', '迁移 / 归入来源记录：' + name(a.memberAId, a.memoryA).slice(0, 70) + ' ↔ ' + name(a.memberBId, a.memoryB).slice(0, 70), 'note'), evidenceView(a));
  }
  box.append(text('p', '程序已校验范围与版本；请核对正文是否保留关键条件、数值和例外。', 'muted'));
  $('commitPlan').hidden = false;
}
async function loadLog(more = false) {
  const q = new URLSearchParams({ limit: '40' });
  if (more && state.logCursor) q.set('before', state.logCursor);
  if ($('logAction').value) q.set('action', $('logAction').value);
  if ($('logNode').value.trim()) q.set('nodeId', $('logNode').value.trim());
  const data = await api('./api/memory/actionlog?' + q);
  options('logAction', data.actions, '全部操作', v => actionNames[v] || v);
  state.logCursor = data.nextCursor; $('moreLog').hidden = !state.logCursor;
  if (!more) $('logResults').replaceChildren();
  for (const entry of data.log) {
    const item = text('article', '', 'logitem'), body = text('div');
    body.append(text('strong', actionNames[entry.action] || entry.action), text('p', entry.action + ' · ' + [entry.nodeId, entry.edgeId].filter(Boolean).map(id => id.slice(0, 12)).join(' / '), 'mono'));
    if (entry.reason) {
      let reason; try { reason = JSON.stringify(JSON.parse(entry.reason), null, 2); } catch { reason = entry.reason; }
      const d = document.createElement('details'); d.append(text('summary', '操作详情 / 内容变更'), text('pre', reason)); body.append(d);
    }
    if (entry.nodeId) body.append(button('查看记忆', () => openMemory(entry.nodeId)));
    item.append(text('time', when(entry.ts)), body); $('logResults').append(item);
  }
  if (!more && !data.log.length) $('logResults').append(empty('暂无操作记录', '写入、编辑或整理后，记录会出现在这里。'));
}
// ── 图谱：知识层优先 + 神经元放电 ─────────────────────────────
// 结构真相（2026-09-17 实测）：全库 9678 节点中 event 4388（L0 原始 3390），
// 边几乎全部是 L0→L1 的 derived_from（原始事件 → 提炼知识）。
// 因此：默认只画知识节点；event/L0 进 latent 索引，放电时动态加入点亮。
const DIM_COLORS = Object.assign(Object.create(null), { fact: '#4c7ef3', decision: '#9d5bd2', lesson: '#3fa376', skill: '#d28b22', event: '#a8b0ab' });
const SPARK = '#f5b942';
const nodeSize = m => 6 + m.importance * 0.8 + (m.layer === 'L2' ? 4 : 0) + (m.layer === 'L3' ? 8 : 0);
const isRawEvent = m => m.layer === 'L0' || m.dimension === 'event';
function memoryNode(m, latent) {
  const dims=m.dimensions?.length?m.dimensions:[m.dimension];
  const colors=dims.map(d=>DIM_COLORS[d]||'#8a9a8e');
  const color=isRawEvent(m)?DIM_COLORS.event:'#'+[1,3,5].map(i=>Math.max(72,Math.round(colors.reduce((s,c)=>s+parseInt(c.slice(i,i+2),16),0)/colors.length)).toString(16).padStart(2,'0')).join('');
  return { id: m.id, label: (latent ? '· ' : '') + (dims.length>1?'['+dims.map(dimensionLabel).join('+')+']\n':'') + m.content.slice(0, 22), title: text('div', dims.map(dimensionLabel).join(' + ')+'\n'+m.content),
    physics:true,shape: 'dot', size: latent ? 5 : nodeSize(m), color, font: { size: 10, color: '#4b5549' }, _dim: m.dimension,_dims:dims, _layer: m.layer, _base: { color, size: latent ? 5 : nodeSize(m) } };
}
const edgeObject = e => ({ id: e.id, from: e.fromId, to: e.toId, arrows:e.directed?{to:{enabled:true}}:undefined, physics:e.kind==='semantic',dashes:e.kind==='provenance',title: e.kind+' · '+e.label + ' · ' + (e.weight ?? ''), length:160-90*(e.weight??.5),width: 1 + (e.weight ?? 0.5) * 2, color: { color: '#6b7a66',opacity:.35 }, font: { size: 9 }, _baseWidth: 1 + (e.weight ?? 0.5) * 2, _baseColor: '#6b7a66' });
/** 放电经过的边确保在画布上（默认模式下边不预加载，跟随 latent 节点一起浮现） */
function ensureEdgeOnCanvas(edgeId) {
  if (state.graphModel.edges.get(edgeId)) return;
  const raw = state.graphEdgeData && state.graphEdgeData.get(edgeId);
  if (raw) state.graphModel.edges.add(edgeObject(raw));
}
// ── 神经元放电 v2：辉光呼吸 + 粒子沿边传导（叠加 canvas 层，参考神经网络 demo）──
// 设计：不动 vis.js 的节点/边数据（旧版瞬变+硬重置的病根），动画全部画在独立叠加层。
const IGNITE = { canvas: null, ctx: null, particles: [], pulses: new Map(), edgesLit: new Map(), rings: [], timers: [], raf: 0, lastT: 0, running: false, kickTimer: 0, ambientT: 0, AMBIENT: false, MAX_PARTICLES: 900, REFRACTORY: 4000 };
function igniteReset() { // 图谱重建时调用：清空放电状态（叠加层保留复用）
  for (const t of IGNITE.timers) clearTimeout(t);
  cancelAnimationFrame(IGNITE.raf);
  IGNITE.timers = []; IGNITE.particles = []; IGNITE.rings = []; IGNITE.raf = 0; IGNITE.running = false; IGNITE.AMBIENT = false; IGNITE.demo = false;
  IGNITE.pulses.clear(); IGNITE.edgesLit.clear();
}
function igniteClear() { // 立即熄灭当前放电
  for (const t of IGNITE.timers) clearTimeout(t);
  IGNITE.timers = []; IGNITE.particles = []; IGNITE.rings = [];
  IGNITE.pulses.clear(); IGNITE.edgesLit.clear();
}
/** 引力扰动按需计算：节点/边变动时短暂重启物理引擎让它重新找位，稳定后自动关闭（不持续迭代耗 CPU） */
function physicsKick(ms) {
  const network = state.network; if (!network) return;
  try {
    network.setOptions({ physics: { enabled: true } });
    clearTimeout(IGNITE.kickTimer);
    IGNITE.kickTimer = setTimeout(() => { try { network.setOptions({ physics: { enabled: false } }); } catch (e) {} }, ms || 2500);
  } catch (e) {}
}
function hexToRgb(hex) { // '#rrggbb' → 'r,g,b'（非法输入回退琥珀色）
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return '245,185,66';
  const v = parseInt(m[1], 16);
  return ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255);
}
function igniteLayer() { // 惰性创建叠加画布（盖在 vis.js 画布之上，不拦截鼠标）
  if (IGNITE.canvas) return IGNITE.ctx;
  const host = $('graphCanvas');
  if (!host) return null;
  const c = document.createElement('canvas');
  c.className = 'ignite-layer';
  Object.assign(c.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '2' });
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.appendChild(c);
  IGNITE.canvas = c; IGNITE.ctx = c.getContext('2d');
  return IGNITE.ctx;
}
function igniteSync() { // 跟随容器尺寸与 devicePixelRatio
  if (!IGNITE.canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(IGNITE.canvas.clientWidth * dpr), h = Math.round(IGNITE.canvas.clientHeight * dpr);
  if (IGNITE.canvas.width !== w || IGNITE.canvas.height !== h) { IGNITE.canvas.width = w; IGNITE.canvas.height = h; }
}
function ignitePos(id) { // 节点世界坐标 → 容器像素坐标
  try {
    const p = state.network.getPositions([id])[id];
    return p ? state.network.canvasToDOM(p) : null;
  } catch { return null; }
}
function igniteStartLoop() {
  if (IGNITE.running || !IGNITE.ctx) return;
  IGNITE.running = true; IGNITE.lastT = 0;
  IGNITE.raf = requestAnimationFrame(igniteLoop);
}
function igniteLoop(t) {
  if (!IGNITE.running) return;
  const ctx = IGNITE.ctx, dpr = window.devicePixelRatio || 1;
  const dt = Math.min(50, IGNITE.lastT ? t - IGNITE.lastT : 16); IGNITE.lastT = t;
  igniteSync();
  const W = IGNITE.canvas.width, H = IGNITE.canvas.height;
  // 浅色主题下 additive('lighter') 会把辉光削顶成背景白（实测核心像素归零），用 source-over 保色彩；炫酷感靠光环/环境流/拖尾/维度色
  ctx.clearRect(0, 0, W, H);
  const now = performance.now();
  // ⓪ 常驻环境粒子流：沿随机边缓慢漂移的微光（不点击也有"活着"的神经网络感，量小不耗资源）
  if (IGNITE.AMBIENT && state.graphModel) {
    IGNITE.ambientT += dt;
    if (IGNITE.ambientT > 420 && IGNITE.particles.length < 120) {
      IGNITE.ambientT = 0;
      const all = state.graphModel.edges.get();
      if (all.length) {
        const e = all[(Math.random() * all.length) | 0];
        if (e && !IGNITE.pulses.has(e.from) && !IGNITE.pulses.has(e.to)) {
          IGNITE.particles.push({ edge: e.id, p: Math.random(), rev: Math.random() < 0.5, speed: 0.00016 + Math.random() * 0.00022, depth: 2, ambient: true });
        }
      }
    }
  }
  // ① 节点辉光：快攻 + 指数衰减呼吸，维度色 bloom + 白热核心
  for (const [id, pu] of IGNITE.pulses) {
    const n = state.graphModel.nodes.get(id);
    if (!n) { IGNITE.pulses.delete(id); continue; }
    const age = now - pu.start;
    if (age > pu.life) { IGNITE.pulses.delete(id); continue; }
    const pos = ignitePos(id); if (!pos) continue;
    const env = age < 180 ? age / 180 : Math.exp(-(age - 180) / 900);
    const rgb = pu.rgb;
    const r = (n._base ? n._base.size : n.size || 8) * (1.6 + 0.9 * env) * dpr;
    const g = ctx.createRadialGradient(pos.x * dpr, pos.y * dpr, 0, pos.x * dpr, pos.y * dpr, r * 2.4);
    g.addColorStop(0, 'rgba(' + rgb + ',' + (0.55 * env).toFixed(3) + ')');
    g.addColorStop(0.4, 'rgba(' + rgb + ',' + (0.20 * env).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(' + rgb + ',0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(pos.x * dpr, pos.y * dpr, r * 2.4, 0, 6.2832); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,240,' + (0.9 * env).toFixed(3) + ')';
    ctx.beginPath(); ctx.arc(pos.x * dpr, pos.y * dpr, Math.max(1.5, r * 0.26) * dpr, 0, 6.2832); ctx.fill();
  }
  // ② 冲击波光环：激发瞬间从节点扩散的亮环（参考站同款"能量波"）
  for (let i = IGNITE.rings.length - 1; i >= 0; i--) {
    const rg = IGNITE.rings[i];
    const age = now - rg.start;
    if (age > rg.life) { IGNITE.rings.splice(i, 1); continue; }
    const pos = ignitePos(rg.id); if (!pos) continue;
    const k = age / rg.life;
    const rad = rg.r0 + (rg.r1 - rg.r0) * (1 - Math.pow(1 - k, 2.2));
    ctx.strokeStyle = 'rgba(' + rg.rgb + ',' + (0.5 * (1 - k)).toFixed(3) + ')';
    ctx.lineWidth = (2.2 * (1 - k) + 0.4) * dpr;
    ctx.beginPath(); ctx.arc(pos.x * dpr, pos.y * dpr, rad * dpr, 0, 6.2832); ctx.stroke();
  }
  // ③ 边发光：与粒子经过同步，指数渐弱
  for (const [eid, li] of IGNITE.edgesLit) {
    const e = state.graphModel.edges.get(eid);
    if (!e) { IGNITE.edgesLit.delete(eid); continue; }
    const age = now - li.start;
    if (age > 2400) { IGNITE.edgesLit.delete(eid); continue; }
    const a = ignitePos(e.from), b = ignitePos(e.to); if (!a || !b) continue;
    const env = Math.exp(-age / 800) * 0.5;
    ctx.strokeStyle = 'rgba(' + li.rgb + ',' + env.toFixed(3) + ')';
    ctx.lineWidth = 2.4 * dpr; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(a.x * dpr, a.y * dpr); ctx.lineTo(b.x * dpr, b.y * dpr); ctx.stroke();
  }
  // ④ 粒子：沿边流动，到达即激发下一节点（信号传导感）+ 渐变拖尾
  for (let i = IGNITE.particles.length - 1; i >= 0; i--) {
    const pt = IGNITE.particles[i];
    const e = state.graphModel.edges.get(pt.edge);
    if (!e) { IGNITE.particles.splice(i, 1); continue; }
    const a = ignitePos(e.from), b = ignitePos(e.to);
    if (!a || !b) { IGNITE.particles.splice(i, 1); continue; }
    const s = pt.rev ? b : a, d = pt.rev ? a : b; // 流动起点取激发节点一侧
    pt.p += dt * pt.speed;
    if (pt.p >= 1) {
      IGNITE.particles.splice(i, 1);
      if (!pt.ambient) { igniteNode(pt.rev ? e.from : e.to, pt.depth); }
      continue;
    }
    const x = s.x + (d.x - s.x) * pt.p, y = s.y + (d.y - s.y) * pt.p;
    const fade = pt.ambient ? 0.16 : Math.exp(-pt.depth * 0.35);
    const rgb = pt.rgb || '255,208,102';
    const tx = s.x + (d.x - s.x) * Math.max(0, pt.p - 0.08), ty = s.y + (d.y - s.y) * Math.max(0, pt.p - 0.08);
    const grad = ctx.createLinearGradient(tx * dpr, ty * dpr, x * dpr, y * dpr); // 拖尾头亮尾淡
    grad.addColorStop(0, 'rgba(' + rgb + ',0)');
    grad.addColorStop(1, 'rgba(' + rgb + ',' + (0.5 * fade).toFixed(3) + ')');
    ctx.strokeStyle = grad; ctx.lineWidth = 1.6 * dpr; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(tx * dpr, ty * dpr); ctx.lineTo(x * dpr, y * dpr); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,235,' + (0.95 * fade).toFixed(3) + ')';
    ctx.beginPath(); ctx.arc(x * dpr, y * dpr, Math.max(1, (pt.ambient ? 1.6 : 2.8 - pt.depth * 0.4)) * dpr, 0, 6.2832); ctx.fill();
  }
  if (IGNITE.particles.length > IGNITE.MAX_PARTICLES) IGNITE.particles.splice(0, IGNITE.particles.length - IGNITE.MAX_PARTICLES);
  // ⑤ 空闲即停：无粒子/辉光/亮边/光环且无待发定时器 → 停 rAF，不空转耗 CPU
  if (!IGNITE.particles.length && !IGNITE.pulses.size && !IGNITE.edgesLit.size && !IGNITE.rings.length && !IGNITE.timers.length) {
    IGNITE.running = false; ctx.clearRect(0, 0, W, H); return;
  }
  IGNITE.raf = requestAnimationFrame(igniteLoop);
}
/** 激发单个神经元：本体辉光 + 冲击波环 + 沿邻接边发射粒子（随机延迟/速度/衰减 = 有机感；4s 不应期防震荡） */
function igniteNode(id, depth) {
  if (depth > 4 || !state.network || !state.graphModel) return;
  const n = state.graphModel.nodes.get(id);
  if (!n || String(id).startsWith('__anchor_')) return;
  const now = performance.now();
  const last = IGNITE.pulses.get(id);
  if (last && now - last.start < IGNITE.REFRACTORY) return;
  const rgb = hexToRgb((n._base && n._base.color) || n.color); // 辉光/粒子/光环跟随节点维度色
  IGNITE.pulses.set(id, { start: now, life: 2200 + Math.random() * 600, rgb });
  const baseR = (n._base ? n._base.size : n.size || 8);
  IGNITE.rings.push({ id, start: now, life: 900, r0: baseR * 1.2, r1: baseR * 4.5 + 26, rgb }); // 激发瞬间扩散的能量环
  if (!IGNITE.ctx) igniteLayer();
  IGNITE.AMBIENT = true; // 首次放电后启用常驻环境粒子流（网络"活着"的底噪）
  igniteStartLoop();
  if (depth >= (IGNITE.demo ? 6 : 4)) return;
  if (!IGNITE.demo && isRawEvent(state.graphMemories.get(id) || {})) return; // event 是终点（V1 设计）；仅演示模式放行以展示级联效果
  let launched = 0;
  for (const [nb, edgeId] of state.graphAdjacency.get(id) || []) { launched++;
    if (depth > 0 && Math.random() < 0.25) continue; // 25% 随机衰减，传播不均匀
    const t = setTimeout(() => {
      const idx = IGNITE.timers.indexOf(t); if (idx >= 0) IGNITE.timers.splice(idx, 1);
      const e0 = state.graphModel.edges.get(edgeId);
      if (!e0) return;
      IGNITE.edgesLit.set(edgeId, { start: performance.now(), rgb });
      // 粒子方向修正：激发节点可能是边的 to 端（无向边），此时粒子从 to → from 反向流动
      IGNITE.particles.push({ edge: edgeId, p: 0, rev: String(e0.from) !== String(id), speed: 0.0011 + Math.random() * 0.0009, depth: depth + 1, rgb });
    }, Math.random() * 140);
    IGNITE.timers.push(t);
  }
}
/** 放电入口：先把两跳内的 latent 邻域拉上画布（粒子要有线才跑得起来），再从本体激发 */
function igniteFrom(startId) {
  if (!state.network || !state.graphModel) return;
  igniteClear();
  const seen = new Set([startId]);
  let frontier = [startId];
  for (let d = 0; d < 2 && frontier.length; d++) {
    const next = [];
    for (const id of frontier) {
      if (isRawEvent(state.graphMemories.get(id) || {})) continue;
      for (const [nb, edgeId] of state.graphAdjacency.get(id) || []) {
        if (seen.has(nb)) continue;
        seen.add(nb); next.push(nb);
        if (!state.graphModel.nodes.get(nb)) {
          const m = state.graphMemories.get(nb);
          if (m) state.graphModel.nodes.add(memoryNode(m, true));
        }
        ensureEdgeOnCanvas(edgeId);
      }
    }
    frontier = next;
  }
  physicsKick(2200); // 新邻居上画布后让引力短暂重算一次找位（算完自动关，不持续耗 CPU）
  igniteNode(startId, 0);
}
async function loadGraph() {
  const limit = +$('graphLimit').value || 1000;
  const showEvents = $('graphShowEvents').checked;
  const graphQuery=new URLSearchParams({limit:String(limit),includeEvents:String(showEvents),spaceId:$('graphSpace').value,memoryType:$('graphType').value});
  const [data, stats] = await Promise.all([api('./api/memory/graph?' + graphQuery), api('./api/memory/stats')]);
  const byDim = stats.stats.byDimension, byLayer = stats.stats.byLayer;
  const space = $('graphSpace').value, type = $('graphType').value;
  // 作用域过滤（space/type 走 memberships——graph API 不带 scope，用 list 对照拿到成员资格）
  const scoped = (space || type) ? new Set((await api('./api/memory/list?' + new URLSearchParams({ limit: String(limit), activeOnly: 'true', scope: 'operator', ...(space ? { spaceId: space } : {}), ...(type ? { memoryType: type } : {}) }))).nodes.map(n => n.id)) : null;
  const nodes = [], latent = new Map(), memories = new Map(), adjacency = new Map();
  for (const m of data.nodes) {
    memories.set(m.id, m);
    if (!adjacency.has(m.id)) adjacency.set(m.id, []);
    if (!showEvents && isRawEvent(m)) { latent.set(m.id, m); continue; } // 默认隐藏：进 latent 索引
    if (scoped && !scoped.has(m.id)) continue;
    nodes.push(memoryNode(m, false));
  }
  const edges = [], edgeData = new Map();
  for (const e of data.edges) {
    const a = memories.get(e.fromId), b = memories.get(e.toId);
    if (!a || !b) continue;
    edgeData.set(e.id, e); // 原始边数据：放电浮现 latent 边时取样式/权重
    if (!showEvents && (latent.has(e.fromId) || latent.has(e.toId))) {
      // 至少一端是隐藏 event：不进画布，但登记进邻接表（放电时动态加入）
      if (!scoped || scoped.has(e.fromId) || scoped.has(e.toId)) {
        adjacency.get(e.fromId).push([e.toId, e.id]); if(!e.directed)adjacency.get(e.toId).push([e.fromId, e.id]);
      }
      continue;
    }
    if (scoped && (!scoped.has(e.fromId) || !scoped.has(e.toId))) continue;
    adjacency.get(e.fromId).push([e.toId, e.id]); if(!e.directed)adjacency.get(e.toId).push([e.fromId, e.id]);
    edges.push(edgeObject(e));
  }
  // 背景事件层（用户设计：event 是背景板，默认半透明呈现；点击知识节点放电时被点亮）。
  // 与画布知识节点直连的 latent event 按边权重排序取前 200 个，小点+淡边，不参与象限引力。
  const bgNodes = [], bgEdges = [];
  if (!showEvents) {
    const bgCap = 200, bgIds = new Set(), cand = [];
    for (const e of data.edges) {
      const a = memories.get(e.fromId), b = memories.get(e.toId);
      if (!a || !b) continue;
      const ev = isRawEvent(a) ? a : isRawEvent(b) ? b : null;
      const kn = ev === a ? b : a;
      if (!ev || latent.get(ev.id) !== ev) continue;
      if (scoped && !scoped.has(kn.id)) continue;
      cand.push([ev, e]);
    }
    cand.sort((x, y) => (y[1].weight ?? 0) - (x[1].weight ?? 0));
    for (const [ev, e] of cand) {
      const admitted = bgIds.has(ev.id);
      if (!admitted && bgNodes.length >= bgCap) continue;
      if (!admitted) {
        bgIds.add(ev.id);
        const base = memoryNode(ev, true);
        bgNodes.push({ ...base, label: '', size: 4, color: 'rgba(168,176,171,0.55)', _base: { color: 'rgba(168,176,171,0.55)', size: 4 } });
      }
      bgEdges.push({ ...edgeObject(e), physics:false, color: { color: 'rgba(107,122,102,0.45)' }, width: 0.8, _baseColor: 'rgba(107,122,102,0.45)', _baseWidth: 0.8 });
    }
    // event 自组织网络（用户设计 2026-09-21）：event 不对知识层传导引力（上面 bgEdges 物理
    // 已强制关闭），但 event 之间的边保留弹簧——事件层自己维持一张独立网络，不再堆在原点。
    for (const e of data.edges) {
      const a = memories.get(e.fromId), b = memories.get(e.toId);
      if (!a || !b || !isRawEvent(a) || !isRawEvent(b)) continue;
      if (!bgIds.has(a.id) || !bgIds.has(b.id)) continue;
      bgEdges.push({ ...edgeObject(e), physics:true, color: { color: 'rgba(140,150,143,0.5)' }, width: 0.7, _baseColor: 'rgba(140,150,143,0.5)', _baseWidth: 0.7 });
    }
  }
  const knowledge = data.nodes.filter(m => !isRawEvent(m)).length;
  const nodeLabel = showEvents ? `${nodes.length} 个节点（${knowledge} 知识 + ${nodes.length - knowledge} 原始事件）` : `${nodes.length} 个知识节点`;
  $('graphSummary').textContent = `画布 ${nodeLabel} · ${edges.length} 条知识连线 + ${bgEdges.length} 条背景事件连线 · ${bgNodes.length} 个背景事件点（范围：最近 ${data.nodes.length} 条中 ${knowledge} 条知识）｜全库 ${stats.stats.total}：${(state.dimensions?.definitions||[]).map(d=>d.label+' '+(byDim[d.id]||0)).join(' / ')} · event ${byDim.event || 0}（L0 原始 ${byLayer.L0 || 0}，${showEvents ? '已显示' : '默认隐藏，点击知识节点放电点亮'}）`;
  if (state.network) state.network.destroy();
  if (!window.vis) throw new Error('图谱组件未加载，请刷新页面');
  // 四象限锚点引力（9/16 已验证配方）：每维一个隐形固定锚 + 该维节点连隐形弹簧边。
  // 必须在 barnesHut 求解器下工作——a718b36 换成 forceAtlas2Based 后 fixed 锚点
  // 拉力失效（2026-09-18 两轮实测），故求解器一并回退 barnesHut。
  const DIM_QUADRANTS = Object.fromEntries([...new Set(nodes.flatMap(n=>n._dims||[]))].map((d,i)=>[d,i]));
  const anchorId = dim => '__anchor_' + dim;
  const anchorNodes = [], dimEdges = [];
  const anchorRadius=Math.min(950,Math.max(180,Math.sqrt(nodes.length)*28));
  for (const [dim, qi] of Object.entries(DIM_QUADRANTS)) {
    anchorNodes.push({ id: anchorId(dim), shape: 'dot', size: 0, color: 'transparent', borderWidth: 0, fixed: true, x: Math.cos(qi*2*Math.PI/Math.max(1,Object.keys(DIM_QUADRANTS).length))*anchorRadius, y: Math.sin(qi*2*Math.PI/Math.max(1,Object.keys(DIM_QUADRANTS).length))*anchorRadius*.65, label: '' });
  }
  for (const n of nodes) for(const dim of n._dims||[]) {
    if (DIM_QUADRANTS[dim] === undefined) continue;
    dimEdges.push({ id: '__dimedge_' + n.id+'_'+dim, from: n.id, to: anchorId(dim), color: { color: 'transparent', opacity: 0 }, hoverWidth: 0, selectionWidth: 0, width: 0.1, label: '' });
  }
  state.graphModel = { nodes: new vis.DataSet([...anchorNodes, ...nodes, ...bgNodes]), edges: new vis.DataSet([...dimEdges, ...edges, ...bgEdges]) };
  state.graphAdjacency = adjacency; state.graphMemories = memories; state.graphEdgeData = edgeData;
  igniteReset(); // 重建图谱：清空上一轮放电状态（叠加层画布保留复用）
  state.network = new vis.Network($('graphCanvas'), state.graphModel, {
    // improvedLayout 在节点数百级即抛错（2026-09-17 实测 1000 节点失败）；
    // 大图禁用，交给 forceAtlas2Based 物理布局。
    layout: { improvedLayout: false },
    physics: { enabled: true, solver: 'barnesHut', barnesHut: { gravitationalConstant: -2600, centralGravity: 0.15, springLength: 95, springConstant: 0.04, damping: 0.35, avoidOverlap: 0.1 }, stabilization: { iterations: 150, fit: false } },
    interaction: { hover: true, selectConnectedEdges: false }, edges: { arrows: { to: false } },
  });
  const currentNetwork=state.network;
  currentNetwork.once('stabilizationIterationsDone',()=>{
    if(state.network!==currentNetwork || !nodes.length)return;
    currentNetwork.fit({nodes:nodes.map(n=>n.id),animation:false});
    if(currentNetwork.getScale()>1.25)currentNetwork.moveTo({scale:1.25});
    // 引力布局只算一次：稳定后 3s 关闭物理引擎，不再持续迭代耗 CPU（节点变动时由 physicsKick 短暂重启）
    setTimeout(()=>{ if(state.network===currentNetwork){ try{ currentNetwork.setOptions({physics:{enabled:false}}); }catch(e){} } },3000);
  });
  state.network.on('click', p => {run(async()=>{
    if (p.nodes.length) {
      const id=p.nodes[0];if(String(id).startsWith('__anchor_'))return;
      const network=state.network;
      const neighborhood=await api('./api/memory/neighborhood',{nodeId:id,scope:'operator',limit:60,spaceId:space||undefined,memoryType:type||undefined});
      if(state.network!==network)return;
      for(const m of neighborhood.nodes) {
        state.graphMemories.set(m.id,m);
        if(!state.graphAdjacency.has(m.id))state.graphAdjacency.set(m.id,[]);
        if(!state.graphModel.nodes.get(m.id))state.graphModel.nodes.add(memoryNode(m,isRawEvent(m)));
      }
      for(const e of neighborhood.edges) {
        if(state.graphEdgeData.has(e.id))continue;
        state.graphEdgeData.set(e.id,e);state.graphModel.edges.add(edgeObject(e));
        state.graphAdjacency.get(e.fromId)?.push([e.toId,e.id]);if(!e.directed)state.graphAdjacency.get(e.toId)?.push([e.fromId,e.id]);
      }
      notice(neighborhood.truncated?'邻居较多，当前展示前 60 条；此动画用于探索邻接。':'已加载真实邻接与来源；实际召回路径请在搜索结果查看。');
      physicsKick(2500); // 新节点/边加入后引力重算一次（按需，不常驻）
      igniteFrom(id);
    }
  });});
  state.network.on('doubleClick', p => { if (p.nodes.length) run(() => openMemory(p.nodes[0])); });
}
function workDomain() {
  const id = $('workDomainId').value.trim();
  if (!id) throw new Error('请填写协作 domain ID');
  return {kind:$('workDomainKind').value,id};
}
async function loadWorkContexts() {
  const domain = workDomain();
  const data = await api('./api/work/context/list', { domains: [domain] });
  const box = $('workContexts'); box.replaceChildren(...data.map(context => {
    const c = text('article', '', 'card');
    c.append(text('strong', context.goal), text('p', context.domain.kind + ' / ' + context.domain.id + ' · ' + context.status + ' · r' + context.revision, 'muted'),
      button('查看任务', () => openWorkContext(context)));
    return c;
  }));
  if (!data.length) box.append(empty('暂无协作上下文', '新建一个明确目标，再拆分待办和验收条件。'));
}
async function openWorkContext(context) {
  state.workContext = context; const tasks = await api('./api/work/task/list', {contextId:context.id,domains:[context.domain]});
  const box = $('workTasks'); box.hidden = false; box.replaceChildren(text('h2', context.goal), text('p', 'domain：' + context.domain.kind + ' / ' + context.domain.id, 'muted'));
  const form = document.createElement('form'), title = document.createElement('input'), criteria = document.createElement('input');
  title.placeholder = '新待办'; criteria.placeholder = '验收条件（可选，逗号分隔）';
  const add = button('添加待办', async () => { if (!title.value.trim()) throw new Error('请填写待办标题'); await api('./api/work/task/create', {contextId:context.id,domains:[context.domain],title:title.value.trim(),acceptanceCriteria:criteria.value.split(/[,，]/).map(x=>x.trim()).filter(Boolean)}); await openWorkContext(context); });
  form.append(title, criteria, add); box.append(form);
  for (const task of tasks) {
    const row = text('article', '', 'relation');
    row.append(text('strong', task.title), text('p', task.status + ' · r' + task.revision + ' · 尝试 ' + task.attempt + (task.assignee ? ' · ' + task.assignee : ''), 'muted'));
    if (task.acceptanceCriteria.length) row.append(text('p', '验收：' + task.acceptanceCriteria.join('；')));
    if (task.status === 'open') row.append(button('以 agent-ui 认领', async () => { const claimed = await api('./api/work/task/claim', {taskId:task.id,domains:[context.domain],agentId:'agent-ui',expectedRevision:task.revision}); state.taskLeases.set(task.id, claimed.leaseToken); await openWorkContext(context); }));
    if (task.status === 'claimed') row.append(button('提交结果', async () => { const token = state.taskLeases.get(task.id); if (!token) throw new Error('只有持有认领租约的 agent 可提交；请使用对应 agent 的 leaseToken。'); await api('./api/work/task/transition', {taskId:task.id,domains:[context.domain],agentId:'agent-ui',eventId:'submit-ui-'+Date.now(),expectedRevision:task.revision,leaseToken:token,status:'submitted',reason:'UI 提交，等待验收'}); await openWorkContext(context); }));
    if (task.status === 'submitted') row.append(button('验收完成', async () => { await api('./api/work/task/transition', {taskId:task.id,domains:[context.domain],agentId:'reviewer-ui',eventId:'accept-ui-'+Date.now(),expectedRevision:task.revision,status:'completed',reason:'用户在工作台验收'}); await openWorkContext(context); }));
    box.append(row);
  }
}
async function copy(value) {
  try { await navigator.clipboard.writeText(value); notice('已复制'); }
  catch { const blob = new Blob([value], { type: 'text/plain;charset=utf-8' }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'mindpond-task.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); notice('剪贴板不可用，已导出文本文件'); }
}
for (const n of document.querySelectorAll('[data-view]')) n.onclick = () => run(() => show(n.dataset.view));
$('openGraphPage').onclick = () => { sessionStorage.setItem('mindpond:graph-api-key',$('apiKey').value); sessionStorage.setItem('mindpond:graph-operator-key',$('operatorKey').value); location.href='./graph'; };
for (const n of document.querySelectorAll('[data-close]')) n.onclick = () => $(n.dataset.close).close();
for (const prefix of ['search', 'library', 'org', 'graph']) $(prefix + 'Space').onchange = () => {
  types(prefix);
  if (prefix === 'library') { state.page = 0; state.selected.clear(); selectionChanged(); run(loadLibrary); }
};
$('libraryDimension').onchange = $('libraryType').onchange = $('libraryLayer').onchange = $('libraryState').onchange = () => {
  state.page = 0; state.selected.clear(); selectionChanged(); run(loadLibrary);
};
on('connect', async () => { await refreshMeta(); await show(state.view); notice('已连接 MindPond'); });
on('createWorkContext', async () => { const domain=workDomain(),goal=$('workGoal').value.trim(); if(!goal)throw new Error('请填写协作目标'); const context=await api('./api/work/context/create',{domain,goal,teamAuthorization:$('workTeamAuthorization').value||undefined}); $('workGoal').value=''; await loadWorkContexts(); await openWorkContext(context); });
on('refreshWork', loadWorkContexts);
on('copySearch', () => copy(JSON.stringify(state.search, null, 2)));
on('loadLibrary', loadLibrary); on('newMemory', () => openMemory());
on('prevPage', async () => { if (state.page) state.page--; await loadLibrary(); });
on('nextPage', async () => { state.page++; await loadLibrary(); });
on('clearSelection', async () => { state.selected.clear(); await loadLibrary(); });
on('organizeSelection', organizeSelected);
on('startRequest',()=>startOrganizationRequest());on('listRequests',loadOrganizationRequests);on('nextRequestBatch',nextOrganizationBatch);
on('cancelRequest',async()=>{if(!state.request)return;const id=state.request.requestId;await api('./api/host/organization/request/cancel',{requestId:id,reason:'用户在工作台取消未提交工作'});if(state.task?.requestId===id){state.task=null;invalidatePreview();$('orgEditor').hidden=true;$('release').disabled=true;$('renew').disabled=true;}await inspectOrganizationRequest(id);await loadOrganizationRequests();});
on('retryRequest',async()=>{const p=state.request;if(p)await startOrganizationRequest({domain:p.domain,spaceId:p.spaceId,memoryType:p.memoryType,batchSize:+$('requestBatch').value,limit:+$('requestLimit').value});});
on('claim', () => claim()); on('release', releaseTask);
on('renew', async () => { if (!state.task) return; const r = await api('./api/organization/renew', { jobId: state.task.job.id }); state.task.job.leaseExpiresAt = r.leaseExpiresAt; $('jobSummary').textContent = '任务已续期至 ' + when(r.leaseExpiresAt); });
on('copyTask', () => copy(state.task.prompt));
on('combineSources', () => { const ids = new Set(chosen()); $('orgContent').value = state.task.job.members.filter(m => ids.has(m.membership.id)).map(m => m.memory.content).join('\n\n'); invalidatePreview(); });
on('previewPlan', () => preview(humanPlan())); on('previewAgent', () => preview(JSON.parse($('agentPlan').value)));
on('commitPlan', async () => {
  if (!state.plan || !state.task) throw new Error('请先预览变更');
  const task=state.task,plan=state.plan;
  const result = await api('./api/organization/commit', { jobId: task.job.id, plan, teamAuthorization:$('requestTeamAuthorization').value||undefined });
  state.task = null; state.selected.clear(); invalidatePreview(); $('orgEditor').hidden = true; $('release').disabled = true; $('renew').disabled = true;
  let reportError=null;
  if(task.requestId){
    // A lost report response is recoverable from the durable committed job via next.
    try{await api('./api/host/organization/request/report',{requestId:task.requestId,jobId:task.job.id,result:'committed'});}catch(error){reportError=error;}
  }
  $('jobSummary').replaceChildren(text('span', '整理已完成。新建 ' + result.createdMemoryIds.length + ' 条记忆，修订 ' + (result.updatedMemoryIds || []).length + ' 条画像，全部操作已写入日志。'));
  for (const id of [...result.createdMemoryIds,...(result.updatedMemoryIds || [])]) $('jobSummary').append(button('查看整理结果', () => openMemory(id)));
  notice(reportError?'变更已提交，进度回执待恢复：'+reportError.message:'整理已应用',!!reportError); await refreshMeta();
  if(task.requestId)await inspectOrganizationRequest(task.requestId);
});
$('opKind').onchange = () => { const kind=$('opKind').value; $('consolidateFields').hidden=!['consolidate','synthesize'].includes(kind);$('profileFields').hidden=kind!=='synthesize';$('weightField').hidden=kind!=='associate';if(state.task)renderSupports();invalidatePreview(); };
$('profileTarget').onchange=()=>run(async()=>{
  invalidatePreview();
  const id=$('profileTarget').value, task=state.task;
  if(id) {
    const p=task.job.members.find(m=>m.membership.id===id)?.profileDetails || await api('./api/memory/profile/get',{membershipId:id,limit:100,scope:'operator'});
    if(state.task!==task || $('profileTarget').value!==id)return;
    $('profileTitle').value=p.profile.title;$('profileCoverage').value=p.profile.coverage.join('\n');
    $('profileUnknowns').value=p.profile.unknowns.join('\n');$('orgContent').value=p.content;
    for(const child of p.supports)supportDrafts.set(child.membershipId,{claim:child.claim,context:child.context});
  }
  renderSupports();
});
on('showWork',showWork);
$('onlyReview').onchange=()=>{for(const card of $('searchResults').querySelectorAll('.card'))card.hidden=$('onlyReview').checked&&card.dataset.review!=='yes';};
for (const id of ['orgContent', 'orgReason', 'orgContext', 'orgWeight', 'agentPlan','profileTitle','profileCoverage','profileUnknowns']) $(id).oninput = invalidatePreview;
on('showPolicy', async () => { const p = await api('./api/organization/policy'); $('policyText').textContent = JSON.stringify({ host: await api('./api/host/capabilities'), memorySave: p.savePolicy, organization: p.policy }, null, 2); $('policyDialog').showModal(); });
on('copyPolicy', () => copy($('policyText').textContent));
on('refreshLog', () => loadLog()); on('filterLog', () => loadLog()); on('moreLog', () => loadLog(true)); on('loadGraph', loadGraph);
on('nodeLog', async () => { $('logNode').value = state.memory.node.id; $('memoryDialog').close(); await show('log'); });
on('nodeHistory',async()=>{
  const memory=state.memory;if(!memory)return;
  const rows=await api('./api/memory/edit/history',{nodeId:memory.node.id,scope:'operator'});
  if(state.memory!==memory)return;
  const box=$('memoryHistory');box.replaceChildren(text('h3','编辑历史 · 撤销会创建新版本'),text('p','仅能撤销其后未变动的编辑；已有后续编辑、关联变动或画像依赖时会拒绝。永久删除不能从这里恢复。','note'));box.hidden=false;
  if(!rows.length)box.append(text('p','尚无新版编辑历史。旧操作日志不作为可撤销快照。','muted'));
  for(const r of rows){
    const entry=document.createElement('details');entry.append(text('summary',when(r.at)+' · '+r.reason));
    entry.append(text('h3','修改前'),text('div',r.before.node.content,'source'),text('h3','修改后'),text('div',r.after.node.content,'source'));
    const metadata=document.createElement('details');metadata.append(text('summary','比较来源、维度与检索入口'),text('pre',JSON.stringify({before:r.before,after:r.after},null,2)));entry.append(metadata);
    const label=text('label','撤销原因'),reason=document.createElement('textarea');reason.style.minHeight='70px';label.append(reason);entry.append(label);
    entry.append(button('撤销此编辑',async()=>{if(!reason.value.trim())throw new Error('请填写撤销原因');await api('./api/memory/edit/restore',{nodeId:memory.node.id,revisionId:r.id,expectedUpdatedAt:memory.node.updatedAt,reason:reason.value.trim(),teamAuthorization:$('memoryTeamAuthorization').value||undefined,scope:'operator'});await openMemory(memory.node.id);notice('已创建恢复版本；当前编辑历史仍保留');await refreshMeta();}));box.append(entry);
  }
});
$('deleteConfirm').onchange = () => { $('deleteMemory').disabled = !$('deleteConfirm').checked; };
on('deleteMemory', async () => {
  if (!state.memory || !$('deleteConfirm').checked) return;
  await api('./api/memory/delete', { nodeId: state.memory.node.id, scope: 'operator',teamAuthorization:$('memoryTeamAuthorization').value||undefined, reason: '用户在工作台明确删除所有空间中的记忆本体' });
  state.selected.delete(state.memory.node.id); $('memoryDialog').close(); notice('记忆已删除，操作已记录'); await refreshMeta();
  if (state.view === 'library') await loadLibrary();
});
run(refreshMeta);

setInterval(()=>{if(state.view==='organize'&&!document.hidden&&state.request)run(()=>inspectOrganizationRequest(state.request.requestId));},5000);


function renderDimensionLegend(){
  const legend=$('dimensionGraphLegend');if(!legend)return;legend.replaceChildren();
  for(const d of state.dimensions?.definitions||[]){const item=text('span',d.label+(d.enabled?'':' · 停用'),'legend-item');const dot=document.createElement('i');dot.style.background=d.color;item.prepend(dot);legend.append(item);}
}
function renderDimensionFilters(){for(const id of ['searchDimension','libraryDimension'])options(id,(state.dimensions?.definitions||[]).map(d=>d.id),'全部维度',dimensionLabel);}
function dimensionRows(){return [...$('dimensionDefinitions').children].map(row=>{const values={};for(const input of row.querySelectorAll('[data-field]'))values[input.dataset.field]=input.type==='checkbox'?input.checked:input.value;return values;});}
function refreshDimensionDefault(){const selected=$('dimensionDefault').value;const defs=dimensionRows().filter(d=>d.enabled&&d.id);$('dimensionDefault').replaceChildren(...defs.map(d=>new Option(d.label||d.id,d.id)));if(defs.some(d=>d.id===selected))$('dimensionDefault').value=selected;}
function addDimensionRow(d={id:'',label:'',description:'',instructions:'',color:'#55b8ff',enabled:true}){
  const row=document.createElement('article');row.className='dimension-card';
  for(const [field,label,kind] of [['id','稳定 ID','input'],['label','显示名称','input'],['color','节点颜色','color'],['enabled','允许新记忆使用','checkbox'],['description','定义与含义','textarea'],['instructions','此维度的 agent 提示词','textarea']]){
    const wrap=text('label',label);const input=document.createElement(kind==='textarea'?'textarea':'input');input.dataset.field=field;
    if(kind==='color'||kind==='checkbox')input.type=kind;
    if(kind==='checkbox'){input.checked=d[field];wrap.className='check';}else{input.value=d[field]??'';if(field!=='instructions')input.required=true;}
    if(kind==='textarea')input.rows=3;
    input.oninput=refreshDimensionDefault;wrap.append(input);row.append(wrap);
  }
  row.append(button('移除此定义',()=>{row.remove();refreshDimensionDefault();},'smallbtn danger'));
  $('dimensionDefinitions').append(row);refreshDimensionDefault();
}
async function loadDimensions(){const {configuration}=await api('./api/memory/dimensions');state.dimensions=configuration;state.dimensionEditRevision=configuration.revision;$('dimensionPrompt').value=configuration.prompt;$('dimensionRevision').textContent='配置版本 '+configuration.revision;$('dimensionDefinitions').replaceChildren();configuration.definitions.forEach(addDimensionRow);$('dimensionDefault').value=configuration.defaultDimension;}
on('reloadDimensions',loadDimensions);
on('addDimension',()=>addDimensionRow());
$('dimensionForm').onsubmit=e=>{e.preventDefault();run(async()=>{
  const input={expectedRevision:state.dimensionEditRevision,defaultDimension:$('dimensionDefault').value,prompt:$('dimensionPrompt').value,definitions:dimensionRows()};
  const result=await api('./api/memory/dimensions',input);state.dimensions=result.configuration;notice('维度定义和提示词已保存；已有记忆保持原分类');await refreshMeta();await loadDimensions();
},e.submitter);};

// Refresh metadata without replacing a user's unsaved dimension policy or memory form.
let dimensionRefreshPending=false;
async function refreshDimensionMetadata(){
  if(document.hidden||dimensionRefreshPending)return;dimensionRefreshPending=true;
  try{const {configuration}=await api('./api/memory/dimensions');if(configuration.revision===state.dimensions?.revision)return;state.dimensions=configuration;for(const d of configuration.definitions)DIM_COLORS[d.id]=d.color;renderDimensionLegend();renderDimensionFilters();for(const b of document.querySelectorAll('[data-dimension-id]')){const d=dimensionDefinition(b.dataset.dimensionId);b.textContent=d?.label||b.dataset.dimensionId;b.style.setProperty('--dimension-color',d?.color||'#8a9a8e');b.title=b.dataset.dimensionId+' · '+(d?.description||'');}if($('memoryDialog').open)renderDimensionChoices();if(state.view==='library')await loadLibrary();if(state.view==='graph')await loadGraph();if(state.view==='dimensions')notice('维度配置已在其他窗口更新；当前未保存内容保留，请重新加载后再编辑',true);}
  catch(e){notice('维度配置同步失败：'+e.message,true);}finally{dimensionRefreshPending=false;}
}
window.addEventListener('focus',refreshDimensionMetadata);
setInterval(refreshDimensionMetadata,15000);

async function refreshRetrieval(){
  const catalog=await api('./api/memory/retrieval/profiles');
  const chosen=$('searchProfile').value;
  $('searchProfile').replaceChildren(new Option('服务默认',''),...catalog.profiles.map(p=>{const option=new Option(p.label+(p.coverage&&!p.coverage.complete?' · 构建未完成':''),p.id);option.disabled=!!p.error||!!p.coverage&&!p.coverage.complete;return option;}));
  if(catalog.profiles.some(p=>p.id===chosen&&!p.error&&(!p.coverage||p.coverage.complete)))$('searchProfile').value=chosen;
  const selectedRanker=$('searchReranker').value;
  $('searchReranker').replaceChildren(new Option('关闭',''),...catalog.rerankers.map(p=>new Option(p.label,p.id)));
  if(catalog.rerankers.some(p=>p.id===selectedRanker))$('searchReranker').value=selectedRanker;
  $('retrievalStatus').textContent='启用：'+catalog.activeProfile+' · 配置默认：'+catalog.preferredProfile+' · 模型文件不会自动下载';
  $('retrievalProfiles').replaceChildren(...catalog.profiles.map(p=>{
    const box=text('article','','card');box.append(text('strong',p.label),text('p',p.model||'兼容现有向量与文本通道','muted'));
    if(p.coverage)box.append(text('p',p.dimensions+' 维 · '+p.pooling+' · '+p.dtype+' · '+p.coverage.indexed+'/'+p.coverage.required+' 个正文 / 锚点已构建'+(p.building?' · 正在构建':'')));
    if(p.runtime)box.append(text('p','请求设备 '+p.runtime.requestedDevice+' → 实际 '+p.runtime.actualDevice,'muted'));
    if(p.error)box.append(text('p','状态：'+p.error,'warning'));
    const actions=text('div','','row');
    if(p.coverage&&!p.coverage.complete&&p.spaceKey)actions.append(button('构建下一批（64 项）',async()=>{const result=await api('./api/memory/retrieval/build',{profileId:p.id,maxItems:64});notice('已构建 '+result.completed+' 项，剩余 '+result.coverage.remaining+(result.failures.length?'；部分失败，请查看状态':''),!!result.failures.length);await refreshRetrieval();}));
    const activate=button(p.id==='legacy'?'切回兼容索引':'启用模型',async()=>{await api('./api/memory/retrieval/activate',{profileId:p.id});notice('向量索引已切换');await refreshRetrieval();});
    activate.disabled=catalog.activeProfile===p.id||!!p.error||!!p.coverage&&!p.coverage.complete;actions.append(activate);box.append(actions);return box;
  }));
}
on('refreshRetrieval',refreshRetrieval);
on('probeDevices',async()=>{const result=await api('./api/memory/retrieval/devices');$('retrievalDevices').textContent=JSON.stringify(result,null,2);$('retrievalDevices').hidden=false;});
