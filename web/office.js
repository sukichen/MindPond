/* Browser operator view only. Agents use native HTTP MCP, never these routes. */
(() => {
  'use strict';
  const el = (id) => document.getElementById(id),
    make = (tag, text) => {
      const n = document.createElement(tag);
      if (text !== undefined) n.textContent = text;
      return n;
    };
  const uuid = () =>
    crypto.randomUUID
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
          n.toString(16).padStart(2, '0')
        ).join('');
  const state = {
    data: null,
    office: null,
    cursor: 0,
    events: [],
    loading: false,
    generation: 0,
    opening: false,
    logged: false,
    editing: null,
    editingProject: null,
    poll: null, mail: null, mailGeneration: 0,
    authEpoch: 0,
    roleEditing: false,
    renderedFacilities: null,
    roleQuery: '', roleFilter: 'all', roleZoom: 100, roomQuery: '',
    roleDraft: null, expanded: null, appView: 'officeRooms', roomTab: 'officeCanvas',
    scene: { scale: 1, x: 0, y: 0, autoFit: true, room: null }
  };
  const mailRenderVersions = new WeakMap();
  const scenePlayer = new window.MindPondOfficeScene.Scene(el('officeScene'),el('officeWires'),el('officeSceneStatus'),()=>state.scene.scale);
  const officeStates = {
    active: '开放',
    paused: '已暂停',
    completed: '已归档',
    cancelled: '已归档'
  };
  const roles = {
    member: '参与者',
    worker: '开发 / 处理',
    reviewer: '验收',
    reporter: '问题发起',
    coordinator: '协调',
    observer: '观察'
  };
  const states = {
    pending: '待配置凭据',
    active: '可接入',
    disabled: '已停用',
    paused: '已暂停',
    completed: '已完成',
    cancelled: '已取消',
    open: '待领取',
    claimed: '已领取',
    submitted: '等待验收',
    blocked: '条件不足'
  };
  const mailStates={pending:'待处理',processing:'处理中',archived:'已处理（归档）'};
  const kinds = {message_take:'领取消息',message_finish:'处理完成',message:'消息',message_read:'阅读消息',message_archive:'归档消息',container:'更新容器',
    inform: '通知',
    request: '请求答复',
    reply: '回复',
    read: '已读',
    accepted: '明确接受',
    configured: '用户更新设置',
    session_opened: '会话已绑定',
    material_published: '文本材料已发布',
    material_read: '读取文本分段',
    progress: '进展报告',
    access_report: '文件条件报告',
    item_create: '新工作项',
    item_claim: '领取任务',
    item_renew: '续租',
    item_submit: '提交本轮验收',
    item_verify: '反馈验证结果',
    item_transfer: '提议移交',
    item_transfer_accept: '接受负责权',
    item_transfer_reject: '拒绝移交',
    item_cancel: '取消工作项'
  };
  let noticeTimer;
  const notice = (text, error = false) => {
    clearTimeout(noticeTimer);
    if(!error)noticeTimer=setTimeout(()=>{el('officeNotice').hidden=true;},5000);
    el('officeNotice').hidden = false;
    el('officeNotice').textContent = text;
    el('officeNotice').className = error ? 'is-error' : '';
    if (error && el('officeDetailDialog').open) {el('officeDetailStatus').hidden = false;el('officeDetailStatus').textContent = text;}
    if (error && el('officeRoleInspector').open) {el('officeRoleInspectorStatus').hidden = false;el('officeRoleInspectorStatus').textContent = text;}
  };
  async function api(route, body = {}) {
    const r = await fetch('./api/office-admin/' + route, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) { const error=Error(data.code === 'stale_version'
      ? route.endsWith('/delete') ? '资料已被其他操作更新或删除。请重新打开角色或办公室，核对最新内容后再决定是否删除。' : '资料已被其他操作更新。你的草稿仍保留，请复制需要的内容，关闭后重新打开再编辑。'
      : data.error ?? '操作失败'); error.status=r.status;error.code=data.code; throw error; }
    return data;
  }
  function confirmAction(message, {destructive=false,title='确认操作'} = {}) {
    const dialog = el('officeConfirm');
    if (dialog.open) return Promise.resolve(false);
    el('officeConfirmTitle').textContent=title;
    const accept=dialog.querySelector('button[value="confirm"]');
    accept.textContent=destructive?'确认永久删除':'确认';
    accept.className=destructive?'office-danger':'office-primary';
    el('officeConfirmText').textContent = message;dialog.returnValue = '';
    return new Promise(resolve => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), {once: true});
      dialog.showModal();el('officeConfirmCancel').focus();
    });
  }
  async function run(fn, button) {
    if (button?.disabled) return;
    if (button) button.disabled = true;
    try {
      await fn();
    } catch (error) {
      notice(error.message, true);
    } finally {
      if (button) button.disabled = false;
    }
  }
  function button(text, fn) {
    const n = make('button', text);
    n.type = 'button';
    n.addEventListener('click', () => run(fn, n));
    return n;
  }
  function label(text, control) {
    const n = make('label', text);
    n.append(control);
    return n;
  }
  function input(value = '', placeholder = '') {
    const n = make('input');
    n.value = value;
    n.placeholder = placeholder;
    return n;
  }
  function download(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })),
      a = make('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function connectionDetails(agent, box) {
    const details = make('details'),
      summary = make('summary', 'HTTP MCP 配置与凭据');
    details.append(summary);
    const url = state.data.settings.mcpUrl;
    if (!url) {
      details.append(make('p', '先在第一步保存中心 /mcp 地址。'));
      box.append(details);
      return;
    }
    const cfg = state.data.connectionTemplates?.[agent.id];
    if (!cfg) { details.append(make('p', '配置暂不可用，请重新登录并刷新连接设置。')); box.append(details); return; }
    const configPreview=make('pre',cfg.text);
    details.append(
      make('p', cfg.place),
      configPreview,
      make(
        'p',
        `由用户把凭据放入宿主秘密设置，使用变量名 ${cfg.env}。配置不会自动设置变量；不要让 agent 用 shell 寻找 token。环境变量若对 shell 可见，秘密隔离仍未实现。`
      )
    );
    for (const warning of cfg.warnings) details.append(make('p', warning));
    for(const [filename,source] of Object.entries(cfg.files??{}))details.append(make('p','将会话插件保存到项目 '+filename+'，或用户配置目录 plugins/。插件从宿主配置取得凭据，不发送给模型。'),button('下载 OpenCode 会话插件',async()=>{const blob=new Blob([source],{type:'text/javascript'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename.split('/').at(-1);a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}));
    details.append(make('p', '消息等待最多 5 分钟，宿主调用期限配置为 6 分钟。修改后需重新连接 MCP；重新连接后配置生效。'));
    if (cfg.docs) {
      const a = make('a', '宿主官方配置文档');
      a.href = cfg.docs;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      details.append(a);
    }
    details.append(
      make('p', '模板按官方文档生成；实际宿主版本及逐聊天隔离仍需你所在环境验证。OAuth 尚未实现。')
    );
    details.append(make('p','同一宿主可用于多个聊天。Codex 使用每次调用的真实 threadId；OpenCode 需安装上方会话插件。固定配置标签不能代替聊天 ID。同一聊天重连可恢复；没有可靠聊天标识时，请调用 role_sync 并由用户核对激活编号。'));
    const policy = state.data.credentialPolicies?.[agent.id];
    const initialRestrictions = (policy?.assignmentIds ?? []).join(',');
    const restrictions = input(initialRestrictions, '仅允许的工位 ID，逗号分隔；清空将解除工位限制');
    details.append(label('高级：限制可用分工', restrictions));
    details.append(make('p', '角色知识由聊天绑定决定，不需要填写记忆范围。重新签发保留现有工位限制；清空已有工位列表将解除限制。'));
    const issue = button(
      agent.state === 'pending' ? '签发并下载一次性凭据' : '重新签发并下载（当前凭据失效）',
      async () => {
        if (
          agent.state !== 'pending' &&
          !(await confirmAction('重新签发会撤销当前凭据。请在宿主中替换后重连；是否继续？'))
        )
          return;
        const assignmentIds = restrictions.value.split(',').map(s => s.trim()).filter(Boolean);
        const restrictionsChanged = assignmentIds.join(',') !== initialRestrictions;
        if (policy?.assignmentIds?.length && restrictionsChanged && !assignmentIds.length &&
          !(await confirmAction('清空后此凭据可以选择该 agent 的所有已授权工位。确认解除工位限制？'))) return;
        const response = await api('credential', {
          id: agent.id,
          expectedRevision: agent.revision,
          ...(restrictionsChanged ? { assignmentIds: assignmentIds.length ? assignmentIds : null } : {})
        });
        download(response.token + '\n', agent.id + '.token');
        response.token = '';
        notice(
          '凭据已下载，仅保存在用户下载文件中；请移入宿主秘密设置并妥善清理下载副本。不要把它发给 agent。'
        );
        await refresh();
      }
    );
    issue.disabled = !state.data.credentialIssuance || state.data.credentialPolicyError;
    if (state.data.credentialPolicyError) details.append(make('p', '当前权限配置读取失败，已暂停签发。请先检查服务配置，避免覆盖未知权限。'));
    details.append(issue);
    if (!state.data.credentialIssuance)
      details.append(
        make(
          'p',
          '未启用页面签发：为 Web 和 HTTP MCP 服务设置相同的 MINDPOND_MCP_ACCOUNTS 私有配置文件，并使用同一数据库。也可以由管理员离线签发。'
        )
      );
    details.append(
      button('下载无秘密配置模板', () =>
        download(cfg.text, agent.id + (agent.host === 'codex' ? '.toml' : '.json'))
      )
    );

    box.append(details);
  }
  async function refresh() {
    const epoch=state.authEpoch, next=await api('state');
    if(epoch!==state.authEpoch)return;
    state.data = next;
    // A refresh can update the directory without replacing an open profile draft.
    state.logged = true;startObserver();
    el('officeLogin').hidden = true;
    el('officeSettings').hidden = false;
    state.initializedView = true;
    el('officeShellStatus').textContent='管理已连接';
    el('officeNavRoomCount').textContent=String(state.data.offices.length);
    el('officeLoginStatus').textContent = '已登录用户管理';
    el('officeEndpoint').elements.mcpUrl.value = state.data.settings.mcpUrl ?? '';
    renderDiagnostics();
    el('officeInstance').textContent =
      '实例 ' +
      state.data.settings.instanceId +
      ' · 握手记录来自此数据库；记录存在不代表宿主当前仍在运行。';
    el('officeAgentCount').textContent = state.data.agents.length + ' 个连接';
    renderCharacters(state.data.characters);
    if(!state.data.characters)throw Error('角色信息读取失败，请重新加载页面。');
    const box = el('officeAgentList');
    box.replaceChildren();
    for (const agent of state.data.agents) {
      const card = make('article');
      card.className = 'office-agent';
      const badge = make(
        'span',
        agent.state === 'disabled'
          ? '已停用'
          : agent.state === 'pending'
            ? '待配置凭据'
            : agent.discovered_at
              ? '协作工具已发现'
              : agent.last_seen
                ? '已握手 · 等待 bootstrap'
                : (states[agent.state] ?? agent.state)
      );
      badge.className = 'office-pill';
      badge.dataset.agent = agent.id;
      card.append(
        make('h3', agent.name),
        badge,
        make('p', `${agent.host} · 账户 ${agent.principal}`),
        make('p', `Agent ID：${agent.id}`)
      );
      if (agent.last_seen)
        card.append(make('p', '最近握手 ' + new Date(agent.last_seen).toLocaleString()));
      if (agent.state === 'disabled')
        card.append(make('p', '已停用。历史连接记录不代表仍有权限。'));
      connectionDetails(agent, card);
      card.append(
        button(agent.state === 'disabled' ? '重新启用' : '停用接入', async () => {
          await api('agent', {
            id: agent.id,
            principal: agent.principal,
            name: agent.name,
            host: agent.host,
            expectedRevision: agent.revision,
            state: agent.state === 'disabled' ? 'active' : 'disabled'
          });
          await refresh();
        })
      );
      const remove=button('删除连接',async()=>{
        if(!(await confirmAction(`永久删除宿主连接「${agent.name}」并撤销其访问？办公室历史与记忆会保留。有关联角色或正在使用的工位时，需先移除它们。`,{destructive:true,title:'删除宿主连接'})))return;
        const result=await api('agent/delete',{id:agent.id,expectedRevision:agent.revision});await refresh();
        notice(result.credentialCleanupPending?'连接已删除，访问已撤销。私有凭据文件清理未完成，请检查配置文件权限或稍后重试管理删除。':'宿主连接已删除，访问已撤销。',Boolean(result.credentialCleanupPending));
      });remove.className='office-danger';card.append(remove);
      card.append(button('查看删除影响',()=>window.MindPondOfficeCollaboration?.deleteImpact?.('agent',agent.id)));
      box.append(card);
    }
    if (!state.data.agents.length)
      box.append(make('p', '还没有宿主连接。填写名称、账户和宿主即可登记。'));
    if (state.office && !state.data.offices.some(room=>room.id===state.office.office.id)) {
      await clearDeletedRoom(state.office.office.id);
      notice('当前办公室已被删除。');
    }
    renderRoomChoices();
    refreshSeatChoices();
    renderProjects();

  }
  function renderDiagnostics(){
    const box=el('officeDiagnostics');box.replaceChildren(make('h3','连接诊断'));
    box.append(make('p','这里只展示服务端观测证据。宿主正在运行、实际调用期限和跨机器可达性，需要在对应宿主验证。'));
    if(!state.data.settings.mcpUrl)box.append(make('p','尚未保存中心 MCP 地址。'));
    for(const agent of state.data.agents){
      const roleList=(state.data.characters?.roles??[]).filter(r=>r.connection?.connectorId===agent.id);
      const policy=state.data.credentialPolicies?.[agent.id];
      const row=make('article');row.className='office-item';
      row.append(make('strong',agent.name),make('p',`接入：${states[agent.state]??agent.state} · 已批准角色 ${roleList.length} 个`),make('p',agent.last_seen?'最近握手：'+new Date(agent.last_seen).toLocaleString():'尚未观察到握手'),make('p',agent.discovered_at?'工具发现：'+new Date(agent.discovered_at).toLocaleString():'尚未观察到协作工具发现'));
      row.append(make('p',policy?`协作连接策略已读取；办公室限制：${policy.assignmentIds===null?'未额外限制':policy.assignmentIds.length+' 个工位'}。角色记忆通过独立 Memory 连接访问。`:state.data.credentialPolicyError?'凭据策略读取失败，请检查私有配置权限。':'此 Web 进程未发现对应凭据策略；不据此推断 MCP 进程未配置。'));
      for(const report of (state.data.hostReports??[]).filter(h=>roleList.some(r=>r.id===h.role_id&&r.binding_id===h.binding_id))){const p=JSON.parse(report.payload);row.append(make('p',`宿主自检：${p.client} · 角色 ${roleList.find(r=>r.id===report.role_id)?.name??report.role_id} · 服务端实等 ${(p.measuredWaitMs/1000).toFixed(1)} 秒 · ${p.clientReceived?'宿主已确认收到结果':'尚未确认收到结果'} · ${Date.now()-report.observed_at>120000?'当前运行未知':'最近有通信证据'}`));}
      row.append(button('下载宿主自检指引',()=>download('在需要验证的聊天中调用 office_host action=probe，waitMs=300000。收到 probeId 后调用 action=confirm、probeId 和 clientRoundTripMs。或在该宿主环境使用 mindpond-office-doctor --url <MCP地址> --token-env <秘密环境变量名> --session <原会话标识> --long-wait。不要把凭据发到聊天。不同客户端须分别实测。',agent.id+'-doctor.txt')));
      for(const warning of state.data.connectionTemplates?.[agent.id]?.warnings??[])row.append(make('p',warning));
      box.append(row);
    }
    box.append(make('p','角色记忆只对当前绑定的角色开放。人类添加的知识是保留来源的独立副本；成员可读取办公室知识；私人记忆与文件不会随成员资格共享。'));
  }
  function renderRoomChoices() {
    const box = el('officeRoomList'); box.replaceChildren();
    el('officeNavRoomCount').textContent=String(state.data?.offices.length??0);
    const rooms = state.data?.offices ?? [], query = state.roomQuery.trim().toLocaleLowerCase();
    const matches = rooms.filter(room => !query || [room.title, room.goal, room.id].join(' ').toLocaleLowerCase().includes(query));
    for (const room of matches) {
      const row=make('div');row.className='office-room-row';
      const pick = button('', () => openOffice(room.id));
      pick.append(make('strong', room.title), make('span', officeStates[room.state] ?? room.state));
      pick.className = 'office-room-choice';
      pick.title = room.title;
      pick.setAttribute('aria-pressed', String(state.office?.office.id === room.id));
      row.append(pick);
      if (['completed','cancelled'].includes(room.state)) {
        const remove=button('删除',()=>deleteRoom(room));remove.className='office-room-delete office-danger';
        remove.setAttribute('aria-label','永久删除办公室「'+room.title+'」');row.append(remove);
      }
      box.append(row);
    }
    if (!matches.length) box.append(make('p', rooms.length ? '没有匹配的办公室。' : '还没有办公室。可以直接创建一个空房间。'));
  }
  function refreshSeatChoices() {
    for (const row of el('officeSeatRows').children) {
      const select = row.querySelector('[name=roleId]'),
        value = select.value;
      select.replaceChildren(new Option('请选择角色', ''));
      for (const agent of seatChoices()) {
        const option = make('option', agent.name);
        option.value = agent.value;
        select.append(option);
      }
      if ([...select.options].some((o) => o.value === value)) select.value = value;
    }
  }
  function seatChoices() {
    return (state.data?.characters?.roles ?? []).filter(r => r.state === 'active')
      .map(r => ({ value: r.id, name: r.name + ' · ' + r.introduction.slice(0, 40) }));
  }
  function chatLabel(record) {
    const chat=record.chat??(record.native_chat_id?{source:record.chat_source,id:record.native_chat_id}:null);
    const host=state.data?.agents?.find(a=>a.id===(record.connector_id??record.connectorId));
    return {chat,name:host?.name??record.name??'宿主连接',source:hostNames[chat?.source??host?.host]??'HTTP MCP'};
  }
  function chatLocator(record) {
    const {chat,name,source}=chatLabel(record),box=make('section');box.className='office-chat-locator';
    box.append(make('strong',source+' · '+name));
    if(chat){
      const id=input(chat.id);id.readOnly=true;id.setAttribute('aria-label',source+' 聊天 ID');id.className='office-chat-id';
      box.append(label('真实聊天 ID',id),button('复制聊天 ID',async()=>{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(chat.id);notice('已复制聊天 ID。');}else{id.focus();id.select();notice('已选中聊天 ID，请按 Ctrl+C 复制。');}}));
      box.append(make('p',chat.source==='codex'?'在 Codex 的聊天记录中核对这个 threadId；命令行可用 codex resume '+chat.id:'在 OpenCode 中核对这个 sessionID；命令行可用 opencode --session '+chat.id));
    }else box.append(make('p','暂未取得真实聊天 ID。请在目标聊天调用 role_sync 更新信息；不要用聊天关联哈希猜测会话。'));
    return box;
  }
  async function resolveApplication(app,action) {
    const epoch=state.authEpoch;
    if(!await confirmAction(action==='delete'?'删除这份申请？申请内容会移除，目标聊天不会因自动同步重新占用待激活名额。':'拒绝这份申请？它会从待处理列表移除，目标聊天不会因自动同步重新申请激活。',{destructive:action==='delete',title:action==='delete'?'删除申请':'拒绝申请'}))return;
    if(epoch!==state.authEpoch||!state.logged)return;
    await api(action==='delete'?'role/application/delete':'role/review',{applicationId:app.id,expectedRevision:app.revision,...(action==='reject'?{action:'reject'}:{})});
    if(epoch!==state.authEpoch)return;
    if(state.roleDraft?.id===app.id)await closeRoleInspector(true);
    await refresh();notice(action==='delete'?'申请已删除。':'申请已拒绝。');
  }
  function renderCharacters(data) {
    if (!data) return;
    const pending = el('officeApplications'), list = el('officeCharacterList');
    const selected=new Map([...pending.querySelectorAll('[data-request-id]')].map(card=>[card.dataset.requestId,card.querySelector('select')?.value]));
    pending.replaceChildren(); list.replaceChildren();
    const awaiting=data.pending.length+(data.connections?.length??0);
    el('officePendingCount').textContent = awaiting;
    el('officeNavPending').textContent=String(awaiting);el('officeNavPending').hidden=!awaiting;
    for (const app of data.pending) {
      const card = make('article');card.className='office-activation-card';
      const actions=make('div');actions.className='office-chat-actions';
      actions.append(button('查看并批准',()=>openRoleInspector(app,true)),button('拒绝申请',()=>resolveApplication(app,'reject')),button('删除申请',()=>resolveApplication(app,'delete')));
      card.append(make('h3','角色申请 · '+app.name),chatLocator(app),make('p',app.introduction),make('p','申请理由：'+app.reason),actions);pending.append(card);
    }
    if (!awaiting) pending.append(make('p', '没有待审核申请或待激活聊天。'));
    for(const request of data.connections??[]){
      const card=make('article'),select=document.createElement('select');card.className='office-activation-card';card.dataset.requestId=request.id;
      const roles=data.roles.filter(r=>r.state==='active'&&r.principal===request.principal);
      const {chat,source,name}=chatLabel(request);
      select.setAttribute('aria-label','为 '+source+' 聊天选择角色');select.append(new Option('请选择已有角色',''));
      for(const role of roles)select.append(new Option(role.name,role.id));
      if(roles.some(r=>r.id===selected.get(request.id)))select.value=selected.get(request.id);
      const activate=button('确认激活',async()=>{
        const role=roles.find(r=>r.id===select.value);if(!role)throw Error('请选择已有角色');
        if(!await confirmAction('将“'+role.name+'”连接到 '+source+' · '+name+' 的聊天 '+(chat?.id??'（需先核对激活编号 '+request.id+'）')+'？角色专用凭据会撤销；原聊天解除角色绑定，成为人类聊天。知识、消息和办公室分工保留。'))return;
        await api(request.requestId?'role/activate':'role/connect',{...(request.requestId?{requestId:request.requestId}:{targetRuntimeId:request.runtime_id}),roleId:role.id,expectedRevision:role.revision});await refresh();
      });activate.disabled=!select.value;select.onchange=()=>{activate.disabled=!select.value;};
      const actions=make('div');actions.className='office-chat-actions';
      async function dismiss(action){const epoch=state.authEpoch;if(!await confirmAction((action==='delete'?'删除':'拒绝')+'这个聊天的激活请求？不会关闭 Codex / OpenCode，也不删除角色或记忆。自动同步不会让该请求重新出现。',{destructive:action==='delete'}))return;if(epoch!==state.authEpoch||!state.logged)return;await api('role/activation/resolve',{requestId:request.id,expectedRevision:request.revision,action});if(epoch!==state.authEpoch)return;await refresh();notice('请求已移出待处理列表。');}
      actions.append(select,activate,button('拒绝激活',()=>dismiss('reject')),button('删除请求',()=>dismiss('delete')));
      card.append(make('h3','待激活聊天'),chatLocator(request),make('p','最近请求：'+new Date(request.last_seen).toLocaleString()+' · 不代表聊天仍在运行'),actions);
      if(!roles.length)card.append(make('p','此账户尚无可用角色。可以让该聊天申请角色，再在这里批准。'));
      const detail=document.createElement('details');detail.append(make('summary','诊断信息'),make('p','请求编号：'+request.id),make('p','宿主连接：'+request.connector_id));card.append(detail);pending.append(card);
    }
    renderRoleDirectory();
    const form = el('officeRoleLink');
    for (const name of ['sender', 'recipient']) {
      const select = form.elements[name], old = select.value;select.replaceChildren();
      for (const r of data.roles.filter(r => r.state === 'active')) { const o = make('option', r.name + ' · ' + r.principal);o.value = r.id;select.append(o); }
      if ([...select.options].some(o => o.value === old)) select.value = old;
    }
    const links=el('officeRoleLinks');links.replaceChildren();
    const nameOf=id=>data.roles.find(r=>r.id===id)?.name??id;
    for(const link of data.links??[]) {
      const row=make('p',nameOf(link.sender)+' → '+nameOf(link.recipient)+' ');
      row.append(button('撤销这个方向',async()=>{await api('role/link',{...link,enabled:false});await refresh();}));links.append(row);
    }
    if(!data.links?.length)links.append(make('p','尚无跨账户授权；同账户默认可通信。'));
    const events=el('officeRoleEvents');events.replaceChildren();
    for(const event of data.events) {
      const row=make('details');row.append(make('summary',new Date(event.ts).toLocaleString()+' · '+event.kind),make('pre',JSON.stringify(event.body,null,2)));events.append(row);
    }
    const messages = el('officeRoleMessages');messages.replaceChildren();
    for (const m of data.messages) {
      const card = make('details'), summary = make('summary', `${m.sender_name ?? nameOf(m.sender)} → ${m.recipient_name ?? nameOf(m.recipient)} · ${m.kind} · ${mailStates[m.state]??m.state}`);
      card.append(summary, make('p', new Date(m.created_at).toLocaleString() + ' · ' + m.id), window.MindPondOfficeMarkdown.render(m.body));
      if(m.bodyTruncated)card.append(make('p','此处是正文摘要。'));
      if(m.completion)card.append(make('h4','处理反馈'),window.MindPondOfficeMarkdown.render(m.completion));
      card.append(button('打开完整消息',async()=>{const epoch=state.authEpoch;const result=await api('role/message',{messageId:m.id});if(epoch===state.authEpoch&&state.logged)showDetail('角色消息 · '+(mailStates[result.message.state]??result.message.state),result.message);}));messages.append(card);
    }
    if (!data.messages.length) messages.append(make('p', '尚无角色消息。'));
  }
  function filteredRoles() {
    const roles = state.data?.characters?.roles ?? [];
    const query = state.roleQuery.trim().toLocaleLowerCase();
    return roles.filter(role => {
      const assigned = state.data.characters.mappings.some(m => m.role_id === role.id);
      return (!query || [role.name, role.introduction, role.principal, role.id, role.connection?.name, role.connection?.host, role.connection?.chat?.id].join(' ').toLocaleLowerCase().includes(query)) &&
        (state.roleFilter === 'all' || (state.roleFilter === 'unassigned' ? role.state === 'active' && !assigned : role.state === state.roleFilter));
    });
  }
  const hostNames={codex:'Codex',opencode:'OpenCode',claude:'Claude Code','generic-http-mcp':'HTTP MCP'};
  function roleConnectionLabel(role){
    const c=role.connection;
    return c?`${hostNames[c.chat?.source??c.host]??'HTTP MCP'} · ${c.name}${c.hostState==='active'?'':' · 宿主已停用'}`:'未连接聊天';
  }
  let roleConnectionGeneration=0;
  async function switchRoleConnection(record){
    const generation=++roleConnectionGeneration;
    const epoch=state.authEpoch;
    if(!(await closeRoleInspector()))return;
    const dialog=el('officeRoleConnection'),body=el('officeRoleConnectionBody');body.replaceChildren(make('p','读取可用聊天…'));
    dialog.showModal();
    try{
      const data=await api('role/state',{});
      if(generation!==roleConnectionGeneration||epoch!==state.authEpoch||!state.logged||!dialog.open)return;
      const role=data.roles.find(r=>r.id===record.id&&r.state==='active');if(!role)throw Error('角色已变化，请刷新角色目录。');
      body.replaceChildren(make('h3',role.name),make('p','当前连接：'+roleConnectionLabel(role)),make('p','账户：'+role.principal+'。目标宿主连接须登记在同一账户下。'),make('p','先在目标聊天调用 role_sync，再按宿主名称和真实聊天 ID 选择对应会话。'));
      const select=document.createElement('select'),targetInfo=make('div');select.append(new Option('请选择目标聊天',''));
      const requests=[...(data.chats??[]).map(r=>({...r,targetId:r.runtime_id})),...(data.connections??[]).filter(r=>!(data.chats??[]).some(c=>c.runtime_id===r.runtime_id)).map(r=>({...r,targetId:r.id,requestId:r.id}))].filter(r=>r.principal===role.principal);
      for(const request of requests){const host=state.data.agents.find(a=>a.id===request.connector_id);if(!host)continue;const option=new Option(`${hostNames[request.chat_source??host.host]??'HTTP MCP'} · ${host.name} · ${request.native_chat_id??'激活编号 '+request.id}${request.role_id===role.id?' · 当前连接':request.role_id?' · 已连接「'+request.role_name+'」':host.state!=='active'?' · 宿主已停用':' · 可连接'}`,request.targetId);option.disabled=Boolean(request.role_id)||host.state!=='active';select.append(option);}
      const error=make('p','');error.className='office-inspector-error';error.setAttribute('role','alert');error.hidden=true;
      const save=button('确认切换连接',async()=>{
        const request=requests.find(r=>r.targetId===select.value);if(!request)throw Error('请选择目标聊天');
        const host=state.data.agents.find(a=>a.id===request.connector_id);
        if(!await confirmAction(`请核对目标聊天 ID ${request.native_chat_id??request.id}。将「${role.name}」切换到「${host?.name??request.connector_id}」后，原聊天解除角色绑定，成为人类聊天；角色专用凭据撤销，知识、消息和办公室分工保留。`))return;
        if(generation!==roleConnectionGeneration||epoch!==state.authEpoch||!dialog.open)return;
        dialog.dataset.saving='true';save.disabled=true;select.disabled=true;el('officeRoleConnectionClose').disabled=true;
        try{await api(request.requestId?'role/activate':'role/connect',{...(request.requestId?{requestId:request.requestId}:{targetRuntimeId:request.runtime_id}),roleId:role.id,expectedRevision:role.revision});if(epoch!==state.authEpoch)return;dialog.close();await refresh();notice('连接已切换，请在目标聊天调用 role_sync 继续。');}
        catch(e){error.textContent=e.message;error.hidden=false;}
        finally{delete dialog.dataset.saving;save.disabled=!select.value;select.disabled=false;el('officeRoleConnectionClose').disabled=false;}
      });save.disabled=true;select.onchange=()=>{save.disabled=!select.value;error.hidden=true;targetInfo.replaceChildren();const target=requests.find(r=>r.targetId===select.value);if(target)targetInfo.append(chatLocator(target),make('p','目标最近通信：'+new Date(target.last_seen).toLocaleString()+' · 不代表宿主当前在线'));};
      if(role.connection)body.append(chatLocator(role.connection),make('p','最近通信：'+new Date(role.connection.lastSeen).toLocaleString()+' · 不代表宿主当前在线'));
      body.append(button('刷新聊天列表',async()=>{dialog.close();await switchRoleConnection(role);}),label('目标聊天',select),targetInfo,make('p','被其他角色占用的聊天需先断开其角色。切换不会启动或关闭宿主；文件与项目权限按实际配置检查。'),error,save);
      if(select.options.length===1)body.append(make('p','尚无可选目标。请让目标聊天调用 role_sync；服务只能列出已调用过 MindPond 的聊天，不能扫描宿主中所有聊天。'));
    }catch(error){if(generation===roleConnectionGeneration&&epoch===state.authEpoch&&dialog.open)body.replaceChildren(make('p',error.message));}
  }
  function renderRoleDirectory() {
    const list = el('officeCharacterList'), scrollTop = list.scrollTop;
    const focused = document.activeElement?.closest('.office-character-card')?.dataset.roleId;
    list.replaceChildren();
    const roles = filteredRoles();
    el('officeRoleCount').textContent = `${roles.length} / ${state.data?.characters?.roles.length ?? 0} 个角色`;
    for (const role of roles) {
      const card = button('', () => openRoleInspector(role));
      card.className = 'office-character-card';
      card.dataset.state = role.state;card.dataset.roleId = role.id;card.title = role.introduction;
      card.setAttribute('aria-label', '查看角色 ' + role.name);
      const avatar = make('span', Array.from(role.name)[0] ?? '◉'); avatar.className = 'office-avatar';avatar.setAttribute('aria-hidden', 'true');
      let hash = 0; for (const c of role.id) hash = (hash * 31 + c.charCodeAt(0)) | 0;
      avatar.style.setProperty('--avatar-hue', Math.abs(hash) % 360);
      const heading = make('div'); heading.className = 'office-character-heading';
      heading.append(avatar, make('strong', role.name));
      const places = state.data.characters.mappings.filter(m => m.role_id === role.id).length;
      const status = make('span', role.state === 'active' ? '已批准' : '已停用');status.className = 'office-character-status';
      card.append(heading, status, make('span', roleConnectionLabel(role), 'office-role-connection'), make('p', role.introduction), make('small', `${role.principal} · ${places ? places + ' 个工位' : '未安排办公室'}`));
      list.append(card);
    }
    list.scrollTop = scrollTop;
    if (focused) [...list.children].find(n => n.dataset.roleId === focused)?.focus({preventScroll: true});
    if (!roles.length) {
      const empty = make('p', state.data?.characters?.roles.length ? '没有匹配的角色，试试其他关键词或筛选条件。' : '批准第一份申请后，角色会出现在这里。');
      empty.className = 'office-empty';list.append(empty);
    }
  }
  function setRoleZoom(value) {
    state.roleZoom = Math.max(60, Math.min(140, Number(value) || 100));
    el('officeRoleZoom').value = state.roleZoom;
    el('officeRoleZoomValue').textContent = state.roleZoom + '%';
    el('officeCharacterList').style.setProperty('--role-card-width', Math.round(224 * state.roleZoom / 100) + 'px');
    el('officeCharacterList').dataset.compact = String(state.roleZoom < 90);
    el('officeRoleZoomOut').disabled = state.roleZoom <= 60;
    el('officeRoleZoomIn').disabled = state.roleZoom >= 140;
    try { localStorage.setItem('mindpond.office.roleZoom', String(state.roleZoom)); } catch {}
  }
  async function deleteCharacter(record) {
    const draft=state.roleDraft, epoch=state.authEpoch;
    if (!draft || draft.saving) return;
    if (!(await confirmAction(`永久删除角色「${record.name}」？这会删除角色资料、会话绑定、接续摘要、工作任务及其历史、角色收发的私信，撤销所有工位权限，并取消该角色参与的未完成任务。办公室历史材料与操作审计保留。删除后无法恢复。`,{destructive:true,title:'永久删除角色'}))) return;
    if (epoch!==state.authEpoch || !state.logged || state.roleDraft!==draft) return;
    draft.saving=true;
    const fields=[...el('officeRoleInspectorBody').querySelectorAll('input,textarea,button')];
    fields.forEach(n=>n.disabled=true);el('officeRoleInspectorClose').disabled=true;
    try {
      await api('role/delete',{id:record.id,expectedRevision:record.revision});
      if (epoch!==state.authEpoch) return;
      if (state.roleDraft===draft) await closeRoleInspector(true);
      await refresh();await updateOffice();
      notice('角色已永久删除；原会话已失去角色权限。');
    } finally {draft.saving=false;fields.forEach(n=>n.disabled=false);el('officeRoleInspectorClose').disabled=false;}
  }
  async function deleteRoom(record) {
    const epoch=state.authEpoch;
    if (!(await confirmAction(`永久删除办公室「${record.title}」？该办公室的消息、文本材料、容器、任务及历史记录会一并删除，所有工位访问立即失效。角色本身、其他办公室和个人记忆保留。此操作无法撤销。`,{destructive:true,title:'永久删除办公室'}))) return;
    if (epoch!==state.authEpoch || !state.logged) return;
    await api('office/delete',{id:record.id,expectedRevision:record.revision});
    if (epoch!==state.authEpoch) return;
    await clearDeletedRoom(record.id);
    if (state.editing?.id===record.id) el('officeCancelEdit').onclick();
    await refresh();notice('办公室及其中的内容已永久删除。');
  }
  async function clearDeletedRoom(id) {
    if (state.office?.office.id===id) {
      replayController.close();state.replayIndexRoom=null;
      scenePlayer.reset();
      state.generation++;state.office=null;state.loading=false;state.opening=false;
      state.events=[];state.cursor=0;state.renderedFacilities=null;state.deskSnapshot=null;
      if (state.expanded==='officeCanvas') setExpanded(null);
      await closeOfficeDetail(true);el('officeView').hidden=true;el('officeWorkspaceEmpty').hidden=false;
    }
  }
  async function closeRoleInspector(force = false) {
    if (!force && state.roleDraft?.saving) return false;
    if (!force && state.roleDraft?.dirty && !(await confirmAction('有尚未保存的角色修改，放弃修改并关闭？'))) return false;
    el('officeRoleInspector').close();state.roleDraft = null;state.roleEditing = false;
    return true;
  }
  async function openRoleInspector(record, application = false) {
    if (state.roleDraft && !(await closeRoleInspector())) return;
    const dialog = el('officeRoleInspector'), body = el('officeRoleInspectorBody');body.replaceChildren();
    el('officeRoleInspectorStatus').hidden = true;
    el('officeRoleInspectorTitle').textContent = application ? '审核角色申请' : record.name;
    state.roleDraft = { id: record.id, dirty: false };
    const draft = state.roleDraft;
    const form = make('form'), name = input(record.name), intro = make('textarea');
    name.required = true;name.maxLength = 120;intro.required = true;intro.rows = 5;intro.maxLength = 4000;
    intro.value = record.introduction;
    form.append(label('名字', name), label('能力与介绍', intro));
    const meta = make('p', `账户 ${record.principal} · ${application ? '待审核' : record.state === 'active' ? '已批准 · 运行状态未知' : '已停用'}`);meta.className = 'office-hint';
    const profile=make('section');profile.append(meta,form);body.append(profile);let initialFocus=name;
    if(!application){
      const connection=make('section');connection.className='office-role-current';connection.append(make('h3','当前连接'),make('strong',roleConnectionLabel(record)));
      if(record.connection)connection.append(chatLocator(record.connection),make('p','最近通信：'+new Date(record.connection.lastSeen).toLocaleString()+' · 不代表宿主当前在线'));
      if(record.state==='active')connection.append(button(record.connection?'切换连接':'连接到聊天',()=>switchRoleConnection(record)));
      if(record.connection)connection.append(button('断开连接',async()=>{const epoch=state.authEpoch;if(!await confirmAction('断开「'+record.name+'」与当前聊天的连接？聊天将恢复人类记忆权限，角色的记忆、消息与办公室分工保留，角色专用凭据撤销。'))return;if(epoch!==state.authEpoch||state.roleDraft!==draft)return;if(!await closeRoleInspector())return;if(epoch!==state.authEpoch||!state.logged)return;await api('role/disconnect',{roleId:record.id,expectedRevision:record.revision,bindingId:record.connection.bindingId});if(epoch!==state.authEpoch)return;await refresh();notice('角色已断开连接。');}));
      body.prepend(connection);
    }
    const info = make('details');info.append(make('summary', '身份与连接信息'), make('p', `编号：${record.id}`));
    if(application)body.append(chatLocator(record));
    else if(record.connection)info.append(make('p','宿主连接：'+record.connection.connectorId));
    if (application) info.append(make('p', record.reason), make('p', '会话关联：' + record.mode));
    else {
      info.append(make('p', '资料版本 ' + record.revision));
      const count = state.data.characters.mappings.filter(m => m.role_id === record.id).length;
      info.append(make('p', `已安排 ${count} 个工位`), button('前往办公室', async () => {if (await closeRoleInspector()) {setExpanded(null);showAppView('officeRooms');}}));
    }
    profile.append(info);
    if(!application){
      const tabs=make('div'),working=make('section');tabs.className='office-continuity-controls';tabs.setAttribute('aria-label','角色详情视图');
      const scripts=make('section');let libraryMounted=false;
      const workTab=button('接续工作',()=>selectView('work')),profileTab=button('角色资料',()=>selectView('profile')),scriptTab=button('专属脚本',()=>selectView('scripts'));
      function selectView(view){profile.hidden=view!=='profile';working.hidden=view!=='work';scripts.hidden=view!=='scripts';for(const [button,name] of [[workTab,'work'],[profileTab,'profile'],[scriptTab,'scripts']])button.setAttribute('aria-pressed',String(view===name));if(view==='scripts'&&!libraryMounted){libraryMounted=true;const epoch=state.authEpoch;window.MindPondOfficeResources?.library({container:scripts,scope:{roleId:record.id},api,current:()=>state.roleDraft===draft&&state.logged&&state.authEpoch===epoch,notice,confirmAction,download});}}
      tabs.append(workTab,profileTab,scriptTab);body.insertBefore(tabs,profile);body.insertBefore(working,profile);body.insertBefore(scripts,profile);selectView('work');initialFocus=workTab;
      const continuityEpoch=state.authEpoch;window.MindPondRoleContinuity?.mount({container:working,role:record,offices:state.data.offices,api,current:()=>state.roleDraft===draft&&state.logged&&state.authEpoch===continuityEpoch,notice,confirmAction});
    }
    form.addEventListener('input', () => {draft.dirty = true;state.roleEditing = true;save.textContent = application ? '批准这个角色' : '保存修改';});
    const actions = make('div');actions.className = 'office-dialog-actions';
    let saving = false;
    async function saveProfile(action) {
      if (saving || !form.reportValidity()) return;
      const draft = state.roleDraft, epoch = state.authEpoch;
      const payload = {expectedRevision: record.revision, name: name.value.trim(), introduction: intro.value.trim()};
      if (!payload.name || !payload.introduction) throw Error('名字与介绍不能为空。');
      saving = true;draft.saving = true;el('officeRoleInspectorClose').disabled = true;
      const fields = [...form.querySelectorAll('input,textarea,button')];fields.forEach(n => n.disabled = true);
      try {
        await api(application ? 'role/review' : 'role/configure', application ? {...payload, applicationId: record.id, action} : {...payload, roleId: record.id, state: action});
        if (epoch !== state.authEpoch) return;
        if (state.roleDraft === draft) await closeRoleInspector(true);
        await refresh();
        notice(application ? (action === 'approve' ? '已批准，下次 MCP 调用即可同步身份。' : '已拒绝申请。') : '角色资料已保存，后续 MCP 调用会自动返回新版介绍。');
      } finally {saving = false;draft.saving = false;el('officeRoleInspectorClose').disabled = false;fields.forEach(n => n.disabled = false);}
    }

    const save = button(application ? '批准这个角色' : '保存修改', () => saveProfile(application ? 'approve' : record.state));save.className = 'office-primary';
    form.addEventListener('submit', e => {e.preventDefault();run(() => saveProfile(application ? 'approve' : record.state), save);});
    actions.append(save, button('取消', () => closeRoleInspector()));
    const secondary = button(application ? '拒绝申请' : record.state === 'active' ? '停用角色' : '重新启用', async () => {
      if(application){await resolveApplication(record,'reject');return;}
      if (!(await confirmAction(record.state === 'active' ? '确认停用这个角色？现有会话将失去角色权限。' : '确认重新启用这个角色？'))) return;
      await saveProfile(record.state === 'active' ? 'disabled' : 'active');
    });secondary.className = 'office-danger';actions.append(secondary);form.append(actions);
    if(application)actions.append(button('删除申请',()=>resolveApplication(record,'delete')));
    if (!application) {
      actions.append(button('权限与运行控制',()=>window.MindPondOfficeCollaboration?.inspectRole?.(record.id)),button('查看删除影响',()=>window.MindPondOfficeCollaboration?.deleteImpact?.('role',record.id)));
      const remove=button('永久删除角色',()=>deleteCharacter(record));remove.className='office-danger';
      actions.append(remove);
    }
    dialog.showModal();initialFocus.focus();
  }
  el('officeRoleConnectionClose').onclick=()=>{if(el('officeRoleConnection').dataset.saving!=='true')el('officeRoleConnection').close();};
  el('officeRoleConnection').addEventListener('close',()=>{roleConnectionGeneration++;});
  el('officeRoleConnection').addEventListener('cancel',e=>{if(el('officeRoleConnection').dataset.saving==='true')e.preventDefault();});
  function setExpanded(id) {
    if (state.expanded === id) id = null;
    const wasExpanded = state.expanded;
    if (state.expanded) {el(state.expanded).classList.remove('is-expanded');if(state.expanded==='officeCanvas')el(state.expanded).setAttribute('role','tabpanel');else el(state.expanded).removeAttribute('role');el(state.expanded).removeAttribute('aria-modal');}
    if (!state.expanded && id) state.previousOverflow = document.body.style.overflow;
    state.expanded = id;
    document.body.style.overflow = id ? 'hidden' : state.previousOverflow ?? '';
    if (id) {el(id).setAttribute('role', 'dialog');el(id).setAttribute('aria-modal', 'true');el(id).classList.add('is-expanded');el(id).querySelector('input,button')?.focus();}
    else if (wasExpanded) el(wasExpanded === 'officeRoster' ? 'officeRoleExpand' : 'officeSceneExpand').focus();
    el('officeRoleExpand').textContent = id === 'officeRoster' ? '收起总览' : '展开总览';
    el('officeSceneExpand').textContent = id === 'officeCanvas' ? '收起场景' : '展开场景';
    el('officeRoleExpand').setAttribute('aria-expanded', String(id === 'officeRoster'));
    el('officeSceneExpand').setAttribute('aria-expanded', String(id === 'officeCanvas'));
    if (state.scene.autoFit) requestAnimationFrame(()=>fitScene());
  }
  function layoutScene(count) {
    const viewport=el('officeStage');
    const desks=el('officeDesks'),world=el('officeScene');
    const rowHeight=Math.max(420,...[...desks.querySelectorAll('.office-desk')].map(n=>n.offsetHeight));
    let cols=1,best=0;
    for(let candidate=1;candidate<=Math.min(count||1,7);candidate++){
      const score=Math.min((Math.max(viewport.clientWidth,300)-40)/(candidate*312+100),(Math.max(viewport.clientHeight,260)-40)/(Math.ceil((count||1)/candidate)*(rowHeight+62)+195));
      if(score>best){best=score;cols=candidate;}
    }
    const columns=`repeat(${cols}, 280px)`;
    if(el('officeDesks').style.gridTemplateColumns!==columns)scenePlayer.stop();
    desks.style.gridTemplateColumns = columns;
    world.style.width = (cols * 312 + 100) + 'px';
    scenePlayer.startIdle();
  }
  function applyScene() {
    const {x, y, scale} = state.scene;
    el('officeScene').style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    el('officeSceneZoomValue').textContent = Math.round(scale * 100) + '%';
    el('officeSceneZoomOut').disabled = scale <= .1;
    el('officeSceneZoomIn').disabled = scale >= 2;
  }
  function fitScene(all = true) {
    const viewport = el('officeStage'), world = el('officeScene');
    if (!viewport.clientWidth || !viewport.clientHeight) return;
    const scale = Math.max(all ? .1 : .8, Math.min(1.25, (viewport.clientWidth - 40) / world.offsetWidth, (viewport.clientHeight - 40) / world.offsetHeight));
    const x=(viewport.clientWidth-world.offsetWidth*scale)/2,y=(viewport.clientHeight-world.offsetHeight*scale)/2;
    Object.assign(state.scene, {scale, x:all?x:Math.max(20,x), y:all?y:Math.max(20,y), autoFit: true});
    applyScene();
  }
  function zoomScene(scale, point) {
    const viewport = el('officeStage');
    const cx = point?.x ?? viewport.clientWidth / 2, cy = point?.y ?? viewport.clientHeight / 2;
    const next = Math.max(.1, Math.min(2, scale)), ratio = next / state.scene.scale;
    Object.assign(state.scene, {x: cx - (cx - state.scene.x) * ratio, y: cy - (cy - state.scene.y) * ratio, scale: next, autoFit: false});
    applyScene();
  }
  // Application navigation keeps management views separate from the room workspace.
  const appViews = {officeRooms:'办公室',officeCharacters:'角色与申请',officeProjects:'协作项目',officeAgents:'宿主连接',officeSetup:'连接设置'};
  function showAppView(id, updateHash = true) {
    if (!Object.hasOwn(appViews,id)) id='officeRooms';
    if(state.expanded)setExpanded(null);
    state.appView=id;
    for(const panel of document.querySelectorAll('[data-app-view]'))panel.hidden=panel.dataset.appView!==id;
    for(const link of document.querySelectorAll('[data-app-route]')){
      if(link.dataset.appRoute===id)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
    }
    el('officePageTitle').textContent=appViews[id];
    if(updateHash && location.hash!=='#'+id)history.pushState(null,'','#'+id);
    if(id!=='officeRooms'){if(state.opening){state.generation++;state.opening=false;}replayController.pause();scenePlayer.setActive(false);}
    else if(state.office && state.roomTab==='officeCanvas')requestAnimationFrame(()=>{scenePlayer.setActive(true);layoutScene(el('officeDesks').children.length);if(state.scene.autoFit)fitScene();});
    el('officeWorkspaceEmpty').hidden=Boolean(state.office);
  }
  function setRoomTab(id, focus = false) {
    const tabs=[...document.querySelectorAll('[data-room-tab]')];
    if(!tabs.some(tab=>tab.dataset.roomTab===id))return;
    state.roomTab=id;
    for(const tab of tabs){const selected=tab.dataset.roomTab===id;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;if(selected&&focus)tab.focus();}
    for(const panel of document.querySelectorAll('[data-room-panel]'))panel.hidden=panel.id!==id;
    if(id!=='officeCanvas'){replayController.pause();scenePlayer.setActive(false);if(id==='officeMessagePanel'&&state.office)void run(()=>loadMail());}
    else requestAnimationFrame(()=>{scenePlayer.setActive(state.appView==='officeRooms');layoutScene(el('officeDesks').children.length);if(state.scene.autoFit)fitScene();});
  }
  function syncAppRoute(){showAppView(location.hash.slice(1)||'officeRooms',false);}
  document.querySelector('.office-sidebar nav').addEventListener('click',event=>{
    const link=event.target.closest('[data-app-route]');if(!link)return;
    event.preventDefault();showAppView(link.dataset.appRoute);
  });
  window.addEventListener('popstate',syncAppRoute);
  window.addEventListener('hashchange',syncAppRoute);
  document.querySelector('.office-workspace-tabs').addEventListener('click',event=>{const tab=event.target.closest('[data-room-tab]');if(tab)setRoomTab(tab.dataset.roomTab);});
  document.querySelector('.office-workspace-tabs').addEventListener('keydown',event=>{
    const tab=event.target.closest('[data-room-tab]');if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const tabs=[...document.querySelectorAll('[data-room-tab]')],index=tabs.indexOf(tab);
    const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
    event.preventDefault();setRoomTab(tabs[next].dataset.roomTab,true);
  });
  el('officeReplayOpen').onclick=()=>{setRoomTab('officeCanvas');el('officeReplay').open=true;el('officeReplay').scrollIntoView({block:'nearest'});};
  function createOffice(){if(!state.logged){showAppView('officeSetup');el('officeLogin').elements.operatorKey.focus();return;}el('officeCreate').open=true;}
  el('officeCreateButton').onclick=createOffice;el('officeEmptyCreate').onclick=createOffice;
  el('officeCreate').addEventListener('toggle',()=>{
    const dialog=el('officeRoomEditor');
    if(el('officeCreate').open&&!dialog.open)dialog.showModal();else if(!el('officeCreate').open&&dialog.open)dialog.close();
  });
  el('officeRoomEditorClose').onclick=()=>el('officeCancelEdit').onclick();
  el('officeRoomEditor').addEventListener('cancel',event=>{event.preventDefault();el('officeCancelEdit').onclick();});
  el('officeRoomSearch').addEventListener('input', e => {state.roomQuery = e.target.value;renderRoomChoices();});
  el('officeRoleSearch').addEventListener('input', e => {state.roleQuery = e.target.value;renderRoleDirectory();});
  el('officeRoleFilter').addEventListener('change', e => {state.roleFilter = e.target.value;renderRoleDirectory();});
  el('officeRoleZoom').addEventListener('input', e => setRoleZoom(e.target.value));
  el('officeRoleZoomOut').onclick = () => setRoleZoom(state.roleZoom - 10);
  el('officeRoleZoomIn').onclick = () => setRoleZoom(state.roleZoom + 10);
  el('officeRoleFit').onclick = () => setRoleZoom(60);
  el('officeRoleExpand').onclick = () => setExpanded('officeRoster');
  el('officeRoleInspectorClose').onclick = () => closeRoleInspector();
  el('officeRoleInspector').addEventListener('cancel', e => {e.preventDefault();void closeRoleInspector();});
  el('officeSceneExpand').onclick = () => setExpanded('officeCanvas');
  function replayName(key){return replayController.meta?.participants.find(p=>p.key===key)?.name??(key==='system'?'用户':key?.replace(/^(role|seat):/,'')??'用户');}
  function prepareReplayParticipants(participants){
    const desks=el('officeDesks');
    for(const p of participants){let node=[...desks.children].find(n=>(p.roleId&&n.dataset.role===p.roleId)||(p.seatId&&n.dataset.seat===p.seatId));
      if(!node){node=button('',()=>showDetail('历史参与者',{name:p.name,roleId:p.roleId,seatId:p.seatId,historical:true}));node.className='office-desk replay-ghost';node.dataset.seat=p.seatId??p.key;node.dataset.role=p.roleId??'';const person=make('span');person.className='office-person unknown';const caption=make('span');caption.className='office-desk-caption';caption.append(make('strong',p.name),make('small','历史参与者 · 当前不在此工位'));node.append(window.MindPondOfficeScene.props(person),caption);desks.append(node);}
      node.dataset.replayKey=p.key;
    }
    layoutScene(desks.querySelectorAll('.office-desk').length);if(state.scene.autoFit)requestAnimationFrame(()=>fitScene());
  }
  const replayController=new window.MindPondOfficeReplay.Player({scene:scenePlayer,fetchPage:args=>api('replay',args),prepare:prepareReplayParticipants,restore:()=>{window.MindPondOfficeCollaboration?.restoreLayout?.();if(state.office){state.deskSnapshot=null;renderOffice();}},view:{
    change(player){
      el('officeReplay').classList.toggle('is-active',player.active);el('officeReplayTransport').hidden=!player.active&&!player.loading;el('officeScenePreview').disabled=player.active||player.loading;el('officeActionPreview').disabled=player.active||player.loading;
      el('officeReplayPlay').disabled=!player.active||player.loading||player.playing;el('officeReplayPlay').textContent=player.paused?'继续':player.completed?'重新播放':'播放';
      el('officeReplayPause').disabled=!player.playing;el('officeReplayLoad').disabled=player.loading;el('officeReplayLive').disabled=!player.active&&!player.loading;
      el('officeReplayPrevious').disabled=!player.active||player.index===0||player.loading;el('officeReplayNext').disabled=!player.active||player.index>=player.events.length-1||player.loading;
      el('officeReplaySeek').disabled=!player.active||player.loading;
      if(player.loading)el('officeReplayProgress').textContent='正在读取历史事件…';
      else if(player.active)el('officeReplayProgress').textContent=`历史回放 · ${player.index+1} / ${player.events.length} · ${player.completed?'播放完毕':player.playing?'播放中':player.paused?'已暂停':'已就绪'} · ${player.speed}×`;
      else {el('officeReplayProgress').textContent='实时观察中，选择区间后载入回放。';el('officeReplayCurrent').hidden=true;el('officeReplayEvents').replaceChildren();if(!player.events.length){el('officeReplayRoles').replaceChildren(make('p','载入区间后，可分别设置参与角色的时长。'));}}
    },
    loading(done,total){el('officeReplayProgress').textContent=`正在读取历史事件：${done} / ${total}`;},
    loaded(meta,player){
      window.MindPondOfficeCollaboration?.renderParallel?.(player);
      el('officeReplayFrom').value=String(meta.fromSeq);el('officeReplayTo').value=String(meta.toSeq);
      el('officeReplayBounds').textContent=(meta.threadId?'仅此对话':'所选区间')+` · ${meta.count} 个事件 · #${meta.fromSeq} 至 #${meta.toSeq}`;
      const rows=el('officeReplayRoles');rows.replaceChildren();
      for(const p of [...meta.participants,{key:'system',name:'用户 / 系统事件'}]){const label=make('label',p.name+' · 每件事（秒）'),input=make('input');input.type='number';input.min='.5';input.max='60';input.step='.5';input.value=player.durations.has(p.key)?String(player.durations.get(p.key)):'';input.placeholder=String(player.defaultSeconds)+'（默认）';input.setAttribute('aria-label',p.name+'每件事展示秒数');input.onchange=()=>{if(input.value===''){player.durations.delete(p.key);}else if(input.reportValidity())player.setDuration(p.key,input.valueAsNumber);};label.append(input);rows.append(label);}
      el('officeReplaySeek').max=String(player.events.length-1);el('officeReplaySeek').value='0';
    },
    select(event,index,total,player){
      window.MindPondOfficeCollaboration?.applyReplayLayout?.(player.meta,event.layoutId);
      el('officeReplayNow').textContent=`#${event.seq} · ${replayName(event.actorKey)} · ${kinds[event.kind]??event.kind}`;
      el('officeReplaySeek').value=String(index);const current=el('officeReplayCurrent');current.hidden=false;current.replaceChildren(make('h4',`#${event.seq} · ${replayName(event.actorKey)} · ${kinds[event.kind]??event.kind}`),make('small',new Date(event.ts).toLocaleString()));
      const body=event.body;current.append(typeof body.body==='string'?window.MindPondOfficeMarkdown.render(body.body):make('p',body.result??body.action??body.summary??body.title??(body.materialId?'材料 '+body.materialId:body.itemId?'任务 '+body.itemId:'事件已记录')));
      if(body.why)current.append(make('p','原因：'+body.why));if(event.recipientKey)current.append(make('p','发送给：'+replayName(event.recipientKey)));
      current.append(button(event.detailAvailable?'查看完整事件':'查看事件详情',()=>event.detailAvailable?showRecord({eventSeq:event.seq},'事件 #'+event.seq):showDetail('事件 #'+event.seq,event)));
      for(const n of el('officeDesks').children)n.classList.toggle('replay-selected',n.dataset.replayKey===event.actorKey);
      const list=el('officeReplayEvents');list.replaceChildren();for(let i=Math.max(0,index-3);i<Math.min(total,index+5);i++){const e=player.events[i],jump=button(`#${e.seq} · ${replayName(e.actorKey)} · ${kinds[e.kind]??e.kind}`,()=>player.seek(i));jump.setAttribute('aria-current',String(i===index));list.append(jump);}
    },
    progress(progress,player){if(player.playing)el('officeReplayProgress').textContent=`历史回放 · ${player.index+1} / ${player.events.length} · 当前事件 ${Math.round(progress*100)}% · ${player.speed}×`;},
    error(error){notice('回放暂停：'+error.message,true);}
  }});
  scenePlayer.onReplayVisibility=()=>replayController.pause();
  async function refreshReplayIndex(){
    if(!state.office||replayController.active||replayController.loading)return;const room=state.office.office.id,generation=state.generation,version=state.replayIndexVersion=(state.replayIndexVersion??0)+1;
    const meta=await api('replay',{action:'index',officeId:room});if(version!==state.replayIndexVersion||generation!==state.generation||state.office?.office.id!==room)return;
    el('officeReplayBounds').textContent=meta.totalEvents?`共 ${meta.totalEvents} 个事件 · #${meta.firstSeq} 至 #${meta.lastSeq}`:'这间办公室还没有事件。';
    for(const id of ['officeReplayFrom','officeReplayTo']){el(id).min=String(meta.firstSeq??1);el(id).max=String(meta.lastSeq??1);}
    if(state.replayIndexRoom!==room){el('officeReplayFrom').value=meta.firstSeq??'';el('officeReplayTo').value=meta.lastSeq??'';state.replayIndexRoom=room;}
  }
  function setReplayBoundary(which,seq){setRoomTab('officeCanvas');el('officeReplay').open=true;el(which==='from'?'officeReplayFrom':'officeReplayTo').value=String(seq);el('officeReplay').scrollIntoView({block:'start'});}
  el('officeReplay').addEventListener('toggle',()=>{if(el('officeReplay').open)void run(refreshReplayIndex);});
  el('officeReplayRange').onsubmit=event=>{event.preventDefault();void run(async()=>{if(!state.office)return;await replayController.load(state.office.office.id,el('officeReplayFrom').valueAsNumber,el('officeReplayTo').valueAsNumber,undefined,window.MindPondOfficeCollaboration?.replayFilters?.()??{});});};
  el('officeReplayPlay').onclick=()=>{replayController.play();if(replayController.active){el('officeReplay').open=false;el('officeStage').scrollIntoView({block:'center',behavior:'instant'});}};el('officeReplayPause').onclick=()=>replayController.pause();
  el('officeReplayPrevious').onclick=()=>replayController.seek(replayController.index-1);el('officeReplayNext').onclick=()=>replayController.seek(replayController.index+1);
  el('officeReplayInspect').onclick=()=>{const e=replayController.events[replayController.index];if(e)void run(()=>e.detailAvailable?showRecord({eventSeq:e.seq},'事件 #'+e.seq):showDetail('事件 #'+e.seq,e));};
  el('officeReplaySeek').oninput=()=>replayController.seek(Number(el('officeReplaySeek').value));
  el('officeReplayLive').onclick=()=>{replayController.close();el('officeReplayCurrent').hidden=true;el('officeReplayEvents').replaceChildren();void run(()=>updateOffice());};
  el('officeReplayDuration').onchange=()=>{if(el('officeReplayDuration').reportValidity()){replayController.setDuration(null,el('officeReplayDuration').valueAsNumber);for(const input of el('officeReplayRoles').querySelectorAll('input'))input.placeholder=String(replayController.defaultSeconds)+'（默认）';}};
  el('officeReplaySpeed').onchange=()=>{replayController.setSpeed(Number(el('officeReplaySpeed').value));replayController.view.change(replayController);};
  el('officeScenePreview').onclick = () => scenePlayer.demo(el('officeActionPreview').value);
  el('officeSceneMotion').onclick = () => {const on=!scenePlayer.motion;scenePlayer.setMotion(on);el('officeSceneMotion').setAttribute('aria-pressed',String(!on));el('officeSceneMotion').textContent=on?'暂停动态':'开启动效';};
  el('officeSceneList').onclick = () => {const list=el('officeCanvas').classList.toggle('is-list');el('officeSceneList').setAttribute('aria-pressed',String(list));el('officeSceneList').textContent=list?'场景视图':'列表视图';scenePlayer.list=list;scenePlayer.stop();if(!list)requestAnimationFrame(()=>{fitScene();scenePlayer.startIdle();});};
  el('officeSceneFit').onclick = fitScene;
  el('officeSceneZoomOut').onclick = () => zoomScene(state.scene.scale / 1.2);
  el('officeSceneZoomIn').onclick = () => zoomScene(state.scene.scale * 1.2);
  el('officeSceneReset').onclick = () => {Object.assign(state.scene, {scale: 1, x: 20, y: 20, autoFit: false});applyScene();};
  el('officeCancelEdit').onclick = () => {state.editing = null;el('officeCreate').querySelector('summary').textContent = '＋ 创建空办公室';el('officeRoomForm').reset();el('officeSeatRows').replaceChildren();el('officeCreate').open = false;};
  try {setRoleZoom(localStorage.getItem('mindpond.office.roleZoom') ?? 100);} catch {setRoleZoom(100);}
  const stage = el('officeStage'), pointers = new Map();
  let gesture;
  const midpoint = () => {const p = [...pointers.values()];return {x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2, distance: Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y)};};
  stage.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button')) return;
    stage.setPointerCapture(e.pointerId);pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
    if (pointers.size === 2) gesture = midpoint();
    stage.classList.add('is-dragging');
  });
  stage.addEventListener('pointermove', e => {
    const previous = pointers.get(e.pointerId);if (!previous) return;
    pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
    if (pointers.size === 2) {
      const next = midpoint(), rect = stage.getBoundingClientRect();
      if (gesture?.distance > 0) zoomScene(state.scene.scale * next.distance / gesture.distance, {x: gesture.x - rect.left, y: gesture.y - rect.top});
      if (gesture) {state.scene.x += next.x - gesture.x;state.scene.y += next.y - gesture.y;}
      gesture = next;
    } else {state.scene.x += e.clientX - previous.x;state.scene.y += e.clientY - previous.y;}
    state.scene.autoFit = false;applyScene();
  });
  const releasePointer = e => {pointers.delete(e.pointerId);gesture = null;if (!pointers.size) stage.classList.remove('is-dragging');};
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(name, releasePointer);
  stage.addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();const rect = stage.getBoundingClientRect();zoomScene(state.scene.scale * Math.exp(-e.deltaY * .008), {x: e.clientX - rect.left, y: e.clientY - rect.top});
  }, {passive: false});
  stage.addEventListener('keydown', e => {
    if (e.target !== stage) return;
    if (e.key === '0') fitScene();
    else if (e.key === '+' || e.key === '=') zoomScene(state.scene.scale * 1.2);
    else if (e.key === '-') zoomScene(state.scene.scale / 1.2);
    else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      state.scene.x += e.key === 'ArrowLeft' ? 30 : e.key === 'ArrowRight' ? -30 : 0;
      state.scene.y += e.key === 'ArrowUp' ? 30 : e.key === 'ArrowDown' ? -30 : 0;
      state.scene.autoFit = false;applyScene();
    } else return;
    e.preventDefault();
  });
  document.addEventListener('keydown', e => {
    if (!state.expanded || el('officeRoleInspector').open || el('officeDetailDialog').open || el('officeConfirm').open) return;
    if (e.key === 'Escape') {setExpanded(null);return;}
    if (e.key === 'Tab') {
      const focusable = [...el(state.expanded).querySelectorAll('button:not(:disabled),input,select,[tabindex="0"]')].filter(n => n.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) {e.preventDefault();last?.focus();}
      else if (!e.shiftKey && document.activeElement === last) {e.preventDefault();first?.focus();}
    }
  });
  window.addEventListener('beforeunload', e => {if (state.roleDraft?.dirty || state.containerDirty || window.MindPondOfficeResources?.hasDraft?.()) {e.preventDefault();e.returnValue = '';}});
  new ResizeObserver(() => {if (state.scene.autoFit) requestAnimationFrame(()=>{if(!replayController.active)layoutScene(el('officeDesks').querySelectorAll('.office-desk').length);fitScene();});}).observe(stage);
  function renderProjects() {
    const members = el('officeProjectMembers'),
      selected = [...members.selectedOptions].map((o) => o.value);
    members.replaceChildren();
    for (const a of state.data.agents) {
      const option = make('option', a.name);
      option.value = a.id;
      option.selected = selected.includes(a.id);
      members.append(option);
    }
    const pick = el('officeProjectSelect'),
      old = pick.value;
    pick.replaceChildren();
    const none = make('option', '独立办公室');
    none.value = '';
    pick.append(none);
    const box = el('officeProjectList');
    box.replaceChildren();
    for (const p of state.data.projects ?? []) {
      if (p.enabled) {
        const option = make('option', p.title);
        option.value = p.id;
        pick.append(option);
      }
      const n = make('article');
      n.className = 'office-item';
      n.append(
        make('strong', p.title + ' · ' + (p.enabled ? '已启用' : '已停用')),
        make(
          'p',
          p.members.map((id) => state.data.agents.find((a) => a.id === id)?.name ?? id).join(' / ')
        ),
        button('修改成员', () => {
          state.editingProject = p;
          el('officeProjectForm').elements.title.value = p.title;
          for (const option of members.options) option.selected = p.members.includes(option.value);
        }),
        button(p.enabled ? '停用项目' : '启用项目', async () => {
          await api('project', {
            id: p.id,
            title: p.title,
            members: p.members,
            enabled: !p.enabled,
            expectedRevision: p.revision
          });
          await refresh();
        })
      );
      box.append(n);
    }
    if ([...pick.options].some((o) => o.value === old)) pick.value = old;
  }
  function addSeat(data) {
    const row = make('div');
    row.className = 'office-seat-row';
    row.dataset.id = data?.id ?? 'seat-' + uuid();
    const agent = make('select');
    agent.name = 'roleId';agent.required=true;agent.append(new Option('请选择角色',''));
    for (const a of seatChoices()) {
      const option = make('option', a.name);
      option.value = a.value;
      agent.append(option);
    }
    if (data) {
      const mapped=state.data.characters?.mappings.find(m=>m.seat_id===data.id);
      agent.value=mapped?.role_id??'';
    }
    const name = input(data?.label ?? '', '可选，留空使用人物名字');
    name.name = 'label';
    name.required = false;
    name.maxLength = 120;
    const role = input(data?.role??'member','例如：整理资料、核对证据');role.name='role';role.maxLength=80;
    row.append(
      label('参与角色', agent),
      label('在这里的称呼 / 分工（自定义）', name),
      label('职责（自定义）',role),
      button('移除', () => row.remove())
    );
    el('officeSeatRows').append(row);
  }
  async function openOffice(id) {
    if ((state.containerDirty||window.MindPondOfficeResources?.hasDraft?.()) && !(await confirmAction('有尚未保存的内容，仍要切换办公室？'))) return;
    state.containerDirty = false;
    replayController.close();state.replayIndexRoom=null;
    const generation = ++state.generation;
    state.opening = true;
    state.loading = false;
    let first;
    try { first = await api('view', { officeId: id }); }
    finally { if (generation === state.generation) state.opening = false; }
    if (generation !== state.generation || !state.logged) return;
    scenePlayer.reset();
    state.office = first;state.mail=null;state.mailGeneration++;
    state.scene.autoFit = true;
    state.scene.room = id;
    state.itemsCursor = first.nextItemsAfterId;
    state.materialsCursor = first.nextMaterialsAfterId;
    state.itemsPaged = false;
    state.materialsPaged = false;
    state.events = first.events;
    state.cursor = first.nextCursor;
    await closeOfficeDetail(true);
    renderOffice();
    el('officeView').hidden = false;
    el('officeWorkspaceEmpty').hidden=true;
    showAppView('officeRooms');setRoomTab('officeCanvas');
    renderRoomChoices();
    requestAnimationFrame(()=>fitScene());

  }
  function seatName(id) {
    return state.office?.seats.find((s) => s.id === id)?.label ?? state.data?.characters?.roles.find(r=>r.id===id)?.name ?? id ?? '用户';
  }
  function fileCondition(seat) {
    const observation = state.office?.access?.find((a) => a.seatId === seat.id);
    if (!observation || Date.now() - observation.observedAt > 86400000) return undefined;
    return observation.report;
  }
  function characterForSeat(seat) {
    const mapping=state.data?.characters?.mappings.find(m=>m.seat_id===seat.id);
    return state.data?.characters?.roles.find(r=>r.id===mapping?.role_id);
  }
  function openOfficeDetail() {
    const dialog = el('officeDetailDialog');
    el('officeDetail').hidden = false;el('officeDetailStatus').hidden = true;
    if (!dialog.open) dialog.showModal();
    return el('officeDetail');
  }
  async function closeOfficeDetail(force = false) {
    if (!force && state.detailSaving) return false;
    if (!force && state.containerDirty && !(await confirmAction('放弃尚未保存的容器修改？'))) return false;
    state.containerDirty = false;el('officeDetailDialog').close();el('officeDetail').hidden = true;
    return true;
  }
  el('officeDetailClose').onclick = () => closeOfficeDetail();
  el('officeDetailDialog').addEventListener('cancel', e => {e.preventDefault();void closeOfficeDetail();});
  async function editContainer(record) {
    if (state.containerDirty && !(await confirmAction('放弃尚未保存的容器修改？'))) return;
    state.containerDirty = false;
    const room=state.office.office.id, box=openOfficeDetail();box.replaceChildren();
    const title=input(record.title??'', '容器名字'), content=make('textarea'), format=make('select');
    title.maxLength=200;content.rows=12;content.maxLength=65536;
    for(const [value,name] of [['text','文本'],['json','JSON']]){const o=make('option',name);o.value=value;format.append(o);}
    format.value=typeof record.content==='string'?'text':'json';
    content.value=typeof record.content==='string'?record.content:JSON.stringify(record.content??{},null,2);
    content.addEventListener('input', () => {state.containerDirty = true;});
    title.addEventListener('input', () => {state.containerDirty = true;});
    format.addEventListener('change', () => {state.containerDirty = true;});
    let attempt;
    const save=button('保存容器',async()=>{
      if(state.detailSaving)return;
      if(state.office?.office.id!==room)throw Error('办公室已切换，请重新打开容器。');
      const value=format.value==='json'?JSON.parse(content.value):content.value;
      if(!title.value.trim())throw Error('请填写容器名字。');
      const payload={action:'save',officeId:room,id:record.id,title:title.value.trim(),content:value,expectedRevision:record.revision??0};
      const raw=JSON.stringify(payload);if(attempt?.raw!==raw)attempt={raw,key:uuid()};
      state.detailSaving = true;el('officeDetailClose').disabled = true;
      const fields = [title, content, format];fields.forEach(n => n.disabled = true);
      try {
        await api('containers',{...payload,key:attempt.key});state.containerDirty=false;await closeOfficeDetail(true);await updateOffice();notice('容器已保存。');
      } finally {state.detailSaving = false;el('officeDetailClose').disabled = false;fields.forEach(n => n.disabled = false);}
    });
    box.append(make('h3','自定义容器'),label('名字',title),label('内容格式',format),label('内容',content),save);
    if(record.revision)box.append(button('归档容器',async()=>{
      if(state.detailSaving)return;
      if(state.office?.office.id!==room)throw Error('办公室已切换。');
      if(!(await confirmAction('归档这个容器？尚未保存的编辑不会写入，历史内容仍保留。')))return;
      state.detailSaving=true;el('officeDetailClose').disabled=true;
      try{await api('containers',{action:'archive',officeId:room,id:record.id,expectedRevision:record.revision,key:uuid()});await closeOfficeDetail(true);await updateOffice();}
      finally{state.detailSaving=false;el('officeDetailClose').disabled=false;}
    }));
    box.append(button('关闭',()=>closeOfficeDetail()));
    box.scrollIntoView({block:'nearest'});
  }
  function renderFacilities(data) {
    const counts=data?.counts,summary=el('officeMessageCounts');if(summary)summary.textContent=counts?`办公室共 ${counts.total} 条 · 待处理 ${counts.pending} · 处理中 ${counts.processing} · 已处理 ${counts.archived}`:'消息总数同步中…';
    const signature=JSON.stringify([state.office?.office.id,data?.revision,data?.containers,data?.messages]);
    if(state.renderedFacilities===signature)return;
    state.renderedFacilities=signature;
    const box=el('officeContainers');box.replaceChildren();
    for(const c of data?.containers??[]){const row=make('article');row.className='office-item';row.append(make('strong',c.title),make('p','版本 '+c.revision),button('打开 / 编辑',async()=>{const room=state.office.office.id;const record=await api('containers',{action:'get',officeId:room,id:c.id});if(state.office?.office.id===room)editContainer(record);}));box.append(row);}
    if(!data?.containers?.length)box.append(make('p','这里还没有容器。需要时可以自行添加。'));
    if(data?.hasMore)box.append(button('查看更多容器',async()=>{const room=state.office.office.id;const page=await api('containers',{action:'list',officeId:room,afterId:data.nextAfterId});if(state.office?.office.id!==room)return;state.office.facilities={...data,containers:[...data.containers,...page.containers],hasMore:page.hasMore,nextAfterId:page.nextAfterId};renderFacilities(state.office.facilities);}));
    if(!state.mail || state.mail.room!==state.office.office.id){
      state.mail={room:state.office.office.id,messages:data?.messages??[],hasMore:data?.messagesHasMore??false,nextBeforeSeq:data?.nextBeforeSeq??null,query:'',status:'all',threadId:null};
      renderMail();
    }else if(!state.mail.query&&state.mail.status==='all'&&!state.mail.threadId&&!state.mail.correspondent&&!state.mail.since&&!state.mail.until){
      const known=new Map(state.mail.messages.map(m=>[m.id,m]));
      for(const m of data?.messages??[])known.set(m.id,m);
      const merged=[...known.values()].sort((a,b)=>b.seq-a.seq);
      state.mail.messages=merged.slice(0,200);
      if(merged.length>200){state.mail.hasMore=true;state.mail.nextBeforeSeq=state.mail.messages.at(-1).seq;}renderMail();
    }

  }
  function renderMail(){
    const box=el('officeRoomMessages'),existing=new Map([...box.children].filter(n=>n.dataset.message).map(n=>[n.dataset.message,n])),nodes=[],mail=state.mail;
    for(const m of mail?.messages??[]){
      const previous=existing.get(m.id),version=JSON.stringify(m);
      if(previous&&mailRenderVersions.get(previous)===version){nodes.push(previous);continue;}
      const row=make('details');row.className='office-mail';row.dataset.message=m.id;row.dataset.state=m.state;row.open=previous?.open??false;mailRenderVersions.set(row,version);
      const summary=make('summary'),badge=make('span',mailStates[m.state]??m.state);badge.className='office-mail-state';
      summary.append(badge,make('strong',`${m.senderName} → ${m.recipientName}`),make('small',new Date(m.sentAt).toLocaleString()));
      row.append(summary,window.MindPondOfficeMarkdown.render(m.body));
      if(m.bodyTruncated)row.append(make('p','此处为摘要。打开完整消息查看全部正文。'));
      if(m.result)row.append(make('h4','处理反馈'),window.MindPondOfficeMarkdown.render(m.result));
      row.append(button('打开完整消息',async()=>{const room=state.office.office.id,generation=state.generation;const r=await api('message',{officeId:room,messageId:m.id});if(generation===state.generation&&state.logged)showDetail('消息 · '+(mailStates[r.message.state]??r.message.state),r.message);}));
      row.append(button('查看相关经验',()=>window.MindPondOfficeCollaboration?.openLearning?.(m.id)));
      row.append(button('查看后续回复',()=>loadMail({threadId:m.id,reset:true})));
      row.append(button('回放这段对话',async()=>{const room=state.office.office.id,generation=state.generation;const meta=await api('replay',{action:'index',officeId:room,threadId:m.id});if(generation!==state.generation||!state.logged)return;setRoomTab('officeCanvas');el('officeReplay').open=true;await replayController.load(room,meta.firstSeq,meta.lastSeq,m.id);}));
      nodes.push(row);
    }
    if(!mail?.messages.length)nodes.push(make('p','没有符合条件的消息。'));
    if(mail?.hasMore)nodes.push(button('加载更早消息',()=>loadMail({more:true})));
    for(let i=0;i<nodes.length;i++)if(box.children[i]!==nodes[i])box.insertBefore(nodes[i],box.children[i]??null);
    while(box.children.length>nodes.length)box.lastElementChild.remove();
    el('officeMessageStatus').textContent=(mail?.threadId?'正在查看一条消息及其后续回复':'已展示 '+(mail?.messages.length??0)+' 条')+(mail?.query||mail?.status!=='all'||mail?.threadId?' · 保留筛选并自动同步':'')+' · 每次最多保留200条 · 查看不领取或完成消息';
  }
  async function loadMail({more=false,refresh=false,threadId,reset=false}={}){
    if(!state.office)return;
    const room=state.office.office.id,generation=state.generation,request=++state.mailGeneration;
    const previous=state.mail?.room===room?state.mail:null;
    const query=(more||refresh)&&previous?previous.query:reset?'':el('officeMessageQuery').value.trim(),status=(more||refresh)&&previous?previous.status:reset?'all':el('officeMessageFilter').value;
    const correspondent=(more||refresh)&&previous?previous.correspondent:reset?'':el('officeMessagePerson')?.value??'',since=(more||refresh)&&previous?previous.since:reset?null:el('officeMessageSince')?.value,until=(more||refresh)&&previous?previous.until:reset?null:el('officeMessageUntil')?.value;
    const dates={...(since?{since:typeof since==='number'?since:Date.parse(since)}:{}),...(until?{until:typeof until==='number'?until:Date.parse(until)}:{})};
    if(dates.since&&dates.until&&dates.since>dates.until)throw Error('开始时间不能晚于结束时间');
    const thread=threadId===undefined?((more||refresh)?previous?.threadId:null):threadId;
    state.mailLoading=true;
    try{
    const page=await api('messages',{officeId:room,state:status,...(refresh&&previous?{knownIds:previous.messages.map(m=>m.id)}:{}),...dates,...(correspondent?{correspondent}:{}),...(query?{query}:{}),...(thread?{threadId:thread}:{}),...(more&&previous?.nextBeforeSeq?{beforeSeq:previous.nextBeforeSeq}:{})});
    if(generation!==state.generation||request!==state.mailGeneration||!state.logged)return;
    let messages=more?[...previous.messages,...page.messages].slice(-200):page.messages;
    if(refresh&&previous){const updates=new Map(page.knownMessages.map(m=>[m.id,m]));const retained=previous.messages.filter(m=>updates.get(m.id)?.matches).map(m=>({...m,...updates.get(m.id)}));const merged=new Map(retained.map(m=>[m.id,m]));for(const m of page.messages)merged.set(m.id,m);messages=[...merged.values()].sort((a,b)=>b.seq-a.seq).slice(0,200);}
    state.mail={room,query,status,...dates,correspondent,threadId:thread,messages,hasMore:refresh?(previous?.hasMore||page.hasMore):page.hasMore,nextBeforeSeq:refresh?messages.at(-1)?.seq??page.nextBeforeSeq:page.nextBeforeSeq};
    if(reset){el('officeMessageQuery').value='';el('officeMessageFilter').value='all';for(const id of ['officeMessagePerson','officeMessageSince','officeMessageUntil'])if(el(id))el(id).value='';}renderMail();
    }finally{if(request===state.mailGeneration)state.mailLoading=false;}
  }
  el('officeMessageSearch').addEventListener('submit',event=>{event.preventDefault();void run(()=>loadMail());});
  el('officeMessageReset').onclick=()=>run(()=>loadMail({reset:true,threadId:null}));
  el('officeAddContainer').onclick=()=>{if(state.office)editContainer({id:'container-'+uuid(),title:'',content:'',revision:0});};
  function renderOffice() {
    if(replayController.active)return;
    const data = state.office,
      o = data.office;
    el('officeTitle').textContent = o.title;el('officeTitle').title=o.title;el('officeMemoryLink').href='./?office='+encodeURIComponent(o.id);
    el('officeGoal').textContent = o.goal;el('officeGoal').title = o.goal;
    el('officeRoomMeta').textContent =
      `${officeStates[o.state]??o.state} · ${data.seats.filter(s=>s.enabled).length} 位参与者`;
    renderFacilities(data.facilities);
    void window.MindPondOfficeResources?.refresh?.();
    el('officeSync').textContent = data.hasMore
      ? '有更多事件，继续同步中'
      : '最近同步 ' + new Date().toLocaleTimeString();
    const controls = el('officeControls');
    controls.replaceChildren();
    for (const [value, title] of [
      ['active', '开放办公室'],
      ['paused', '暂停使用'],
      ['cancelled', '归档办公室']
    ])
      if (!['completed', 'cancelled'].includes(o.state) && o.state !== value)
        controls.append(
          button(title, async () => {
            if (
              value === 'cancelled' &&
              !(await confirmAction('归档后停止写入，历史内容保留；远端宿主不会被关闭。继续？'))
            )
              return;
            await api('office', {
              id: o.id,
              title: o.title,
              goal: o.goal,
              acceptance: o.acceptance,
              state: value,
              expectedRevision: o.revision,
              deadline: o.deadline,
              maxRounds: o.max_rounds
            });
            await updateOffice();
          })
        );
    if (!['completed', 'cancelled'].includes(o.state))
      controls.append(
        button('编辑办公室与参与者', async () => {
          if (!(await confirmAction('保存后会更新办公室分工，并撤销受影响工作项的领取凭据；角色的聊天绑定与知识保留。继续编辑？')))
            return;
          state.editing = { id: o.id, revision: o.revision, state: o.state };
          el('officeCreate').querySelector('summary').textContent = '编辑办公室：' + o.title;
          const f = el('officeRoomForm');
          f.elements.projectId.value = o.projectId ?? '';
          f.elements.title.value = o.title;
          f.elements.goal.value = o.goal;
          el('officeSeatRows').replaceChildren();
          for (const seat of data.seats.filter((s) => s.enabled)) addSeat(seat);
          el('officeCreate').open = true;
          document.querySelector('.office-room-actions').open=false;
        })
      );
    const removeOffice=button('永久删除办公室',()=>deleteRoom(o));removeOffice.className='office-danger';
    controls.append(button('查看删除影响',()=>window.MindPondOfficeCollaboration?.deleteImpact?.('office',o.id)),removeOffice);
    const people=el('officeMessagePerson');if(people){const selected=people.value;people.replaceChildren(new Option('全部人物',''),...(state.data.characters?.roles??[]).map(r=>new Option(r.name,r.id)));people.value=selected;}
    const deskSnapshot = JSON.stringify([o.id, data.seats, data.access, data.waits, data.items.filter(t => t.status === 'claimed'), data.facilities?.activity, data.facilities?.activity?.map(r=>[Boolean(r.hostSeenAt&&Date.now()-r.hostSeenAt<120000),Boolean(r.presenceAt&&Date.now()-r.presenceAt<120000)]), state.data.characters?.roles.map(r => [r.id, r.name, r.state])]);
    if (state.deskSnapshot !== deskSnapshot) {
      state.deskSnapshot = deskSnapshot;
      const focusedSeat = document.activeElement?.closest('[data-seat]')?.dataset.seat;
    const desks = el('officeDesks');
    scenePlayer.stop();
    desks.replaceChildren();
    for (const seat of data.seats.filter((s) => s.enabled)) {
      const node = button('', () => showSeat(seat));
      node.className = 'office-desk';
      node.dataset.seat = seat.id;
      node.dataset.role = characterForSeat(seat)?.id??'';
      node.dataset.replayKey=node.dataset.role?'role:'+node.dataset.role:'seat:'+seat.id;
      const person = make('span');
      const access = fileCondition(seat);
      person.className='office-person';
      let appearance=0;
      for(const c of node.dataset.role||seat.id)appearance=(appearance*31+c.charCodeAt(0))|0;
      const palette=[158,208,32,266,12],tone=Math.abs(appearance);
      person.style.setProperty('--coat',`hsl(${palette[tone%palette.length]} 32% 64%)`);
      person.style.setProperty('--hair',['#776052','#645a74','#ae815d','#5c736d'][tone%4]);
      person.dataset.appearance=String(tone%4);person.style.setProperty('--blink-delay',`-${tone%50/10}s`);
      const body = make('span'),
        wait = data.waits.find((w) => w.seat_id === seat.id);
      const task = data.items.find((t) => t.owner === seat.id && t.status === 'claimed');
      const activity=data.facilities?.activity?.find(r=>r.seatId===seat.id);
      const processing=Number(activity?.processing??0);
      const disabled=characterForSeat(seat)?.state==='disabled';
      node.dataset.busy=String(!disabled&&Boolean(task||processing||activity?.discussionTitle));
      body.className='office-desk-caption';
      const shared = access?.mode === 'shared_worktree';
      body.append(
        make('strong', seat.label),
        make('small', `${characterForSeat(seat)?.name??seat.name} · ${roles[seat.role]??seat.role}`),
        make(
          'small',
          disabled
            ? `角色已停用${processing?' · '+processing+' 条处理中消息待恢复':''}`
            : activity?.discussionTitle
            ? '讨论中：'+activity.discussionTitle
            : processing
            ? `正在处理 ${processing} 条消息`
            : wait
              ? '最近报告：等待回复（窗口内）'
              : task
              ? '已领取：' + task.title
              : '暂无正在处理的报告'
        ),
        make(
          'small',
          shared
            ? `自报共享副本 · ${access.group ?? '未分组'}`
            : access?.mode === 'separate_clone'
              ? '独立仓库副本'
              : access?.mode === 'text_only'
                ? '仅文本中转'
                : '文件条件待确认'
        )
      );
      const pending=Number(activity?.pending??0);
      const presence=activity?.presence?JSON.parse(activity.presence):null;
      if(presence){if(Date.now()-activity.presenceAt<120000)node.dataset.phase=presence.phase;body.append(make('small','最近角色报告（'+new Date(activity.presenceAt).toLocaleTimeString()+'）：'+({working:'处理事情',waiting_reply:'等待对方反馈',needs_user:'需要用户补充信息',learning:'整理经验',resting:'休息',unknown:'状态未确认'})[presence.phase]));}
      body.append(make('small',activity?.hostSeenAt&&Date.now()-activity.hostSeenAt<120000?'最近有宿主通信证据':'宿主运行状态未知'));
      const station=window.MindPondOfficeScene.props(person);
      if(!disabled&&(task||processing))person.dataset.facing='desk';
      const papers=station.querySelector('.office-paper-stack');
      papers.style.setProperty('--paper-count',Math.min(12,pending));papers.hidden=!pending;
      if(pending){papers.textContent=String(pending);body.append(make('small',`待处理消息 ${pending} 条`));}
      if(activity?.waitingUntil>Date.now())body.append(make('small','正在等待消息（等待窗口内）'));
      body.title=[...body.children].map(n=>n.textContent).join('\n');
      node.append(station, body);
      desks.append(node);
    }
    if(!data.seats.some(s=>s.enabled))desks.append(make('p','这是一个空办公室，可以随时邀请角色加入。'));
      if (focusedSeat) [...desks.children].find(n => n.dataset.seat === focusedSeat)?.focus({preventScroll: true});
    }
    layoutScene(data.seats.filter(s => s.enabled).length);
    if (state.scene.autoFit) requestAnimationFrame(()=>fitScene());
    const items = el('officeItems');
    items.replaceChildren();
    for (const item of data.items) {
      const n = make('article');
      n.className = 'office-item';
      n.append(
        make('strong', item.title),
        make(
          'p',
          `${states[item.status] ?? item.status} · ${seatName(item.owner)} → ${seatName(item.reviewer)}`
        )
      );
      if (item.code_version)
        n.append(make('p', `第 ${item.round_number} 轮 · ${item.code_version}`));
      if (item.transfer_to)
        n.append(make('p', '等待 ' + seatName(item.transfer_to) + ' 接受移交，原负责人继续负责'));
      n.append(
        button('查看工作项详情', async () => {
          const generation = state.generation;
          const full = await api('view', { officeId: o.id, itemId: item.id });
          if (generation !== state.generation || !state.logged) return;
          showDetail('工作项', full.item);
          if (full.item.round_id)
            el('officeDetail').append(
              button('读取本轮完整证据', () =>
                showRecord({ roundId: full.item.round_id }, '本轮验收记录')
              )
            );
        })
      );
      if (!['completed', 'cancelled'].includes(item.status))
        n.append(
          button('用户取消此工作项', async () => {
            if (!(await confirmAction('取消此工作项并撤销当前领取凭据？历史证据仍保留。'))) return;
            await api('item/cancel', {
              itemId: item.id,
              expectedRevision: item.revision,
              reason: '用户在协作页面取消工作项'
            });
            await updateOffice();
          })
        );
      items.append(n);
    }
    if (!data.items.length)
      items.append(
        make('p', '没有工作项记录。')
      );
    const materials = el('officeMaterials');
    materials.replaceChildren();
    for (const m of data.materials) {
      const n = make('article');
      n.className = 'office-item';
      n.append(
        make('strong', m.label),
        make(
          'p',
          `${m.state === 'published' ? '正文已发布' : '草稿 · 接收方不可读取'} · ${m.bytes} 字节 · ${m.chunks} 段 · ${m.version}`
        ),
        button('查看材料清单', () => showDetail('材料清单', m))
      );
      if (m.state === 'published') n.append(button('读取正文', () => showMaterial(m.id, 0)));
      materials.append(n);
    }
    if (state.itemsCursor) items.append(button('读取更多工作项', () => more('items')));
    if (state.materialsCursor)
      materials.append(button('读取更多材料清单', () => more('materials')));
    scenePlayer.setActive(state.appView==='officeRooms'&&state.roomTab==='officeCanvas');
    if(el('officeReplay').open&&state.replayIndexRoom!==o.id)void run(refreshReplayIndex);
    renderEvents();
  }
  function showSeat(seat) {
    const detail = openOfficeDetail();
    detail.replaceChildren(
      make('h3', seat.label),
      make('p', `${characterForSeat(seat)?.name??seat.name} · ${roles[seat.role]??seat.role}`)
    );
    const roleId=characterForSeat(seat)?.id;
    if(roleId&&window.MindPondOfficeCollaboration?.inspectRole)detail.append(button('查看消息、材料、权限与运行控制',()=>window.MindPondOfficeCollaboration.inspectRole(roleId)));
    const prompt = `使用已配置的 MindPond HTTP MCP。用 role_sync 读取自己的身份，office_directory 查看有权访问的办公室。这里的办公室编号是 ${seat.office_id}。office_receive 取信，office_message 发信或回复，office_material 存取文本，office_container 存取自定义内容。不要读取或传递认证 token。具体如何开展工作由用户和你决定。`;
    detail.append(
      make(
        'p',
        '下面只说明设施的使用方式，不包含工作安排或凭据。'
      ),
      make('pre', prompt),
      button('下载本工位启动提示词', () => download(prompt, seat.id + '-start.txt'))
    );
    if(roleId)detail.append(button('删除此角色的影响预览',()=>window.MindPondOfficeCollaboration?.deleteImpact?.('role',roleId)));
    const access = fileCondition(seat);
    if (access)
      detail.append(
        make('p', '以下为 agent 自报，MindPond 未读取本地文件验证：'),
        make('pre', JSON.stringify(access, null, 2))
      );
    detail.scrollIntoView({ block: 'nearest' });
  }
  async function showMaterial(id, number) {
    const generation = state.generation;
    const r = await api('material', { materialId: id, number });
    if (generation !== state.generation || !state.logged) return;
    const n = openOfficeDetail();
    n.replaceChildren(
      make('h3', r.manifest.label),
      make('p', `第 ${number + 1} / ${r.manifest.chunks} 段 · 用户观察读取，不替 agent 确认已读`),
      make('pre', r.chunk.content)
    );
    if (r.nextNumber !== null) n.append(button('下一段正文', () => showMaterial(id, r.nextNumber)));
    if (number > 0) n.append(button('上一段正文', () => showMaterial(id, number - 1)));
    n.scrollIntoView({ block: 'nearest' });
  }
  async function showRecord(query, title) {
    const officeId = state.office.office.id, generation = state.generation;
    let offset = 0, text = '', digest;
    for (let page = 0; page < 128; page++) {
      const record = await api('view', { officeId, ...query, offset });
      if (generation !== state.generation || !state.logged) return;
      if (digest && record.sha256 !== digest) throw Error('记录在分页中发生变化，请重新读取。');
      digest = record.sha256;
      if (record.offset !== offset || typeof record.content !== 'string' ||
          (record.nextOffset !== null && (!Number.isInteger(record.nextOffset) ||
            record.nextOffset !== offset + record.content.length || record.nextOffset <= offset)))
        throw Error('记录分页未前进，已停止读取，请刷新后重试。');
      text += record.content;
      if (record.nextOffset === null) { showDetail(title, JSON.parse(text)); return; }
      offset = record.nextOffset;
    }
    throw Error('记录分页超出读取上限，已停止。');
  }
  async function more(kind) {
    const generation = state.generation;
    const field = kind === 'items' ? 'itemsAfterId' : 'materialsAfterId',
      cursor = kind === 'items' ? state.itemsCursor : state.materialsCursor;
    const result = await api('view', {
      officeId: state.office.office.id,
      [field]: cursor,
      afterSeq: state.cursor
    });
    if (generation !== state.generation || !state.logged) return;
    state.office[kind] = mergeRecords(state.office[kind], result[kind]);
    if (kind === 'items') {
      state.itemsCursor = result.nextItemsAfterId;
      state.itemsPaged = true;
    } else {
      state.materialsCursor = result.nextMaterialsAfterId;
      state.materialsPaged = true;
    }
    renderOffice();
  }
  function showDetail(title, data) {
    const n = openOfficeDetail();
    const message=typeof data.body==='string'?data.body:typeof data.body?.body==='string'?data.body.body:null;
    n.replaceChildren(make('h3', title));
    if(message===null){n.append(make('pre',JSON.stringify(data,null,2)));return;}
    n.append(window.MindPondOfficeMarkdown.render(message));
    if(data.quote?.body){const quote=make('blockquote');quote.append(make('strong','回复原文 · '+(data.quote.senderName??'')),window.MindPondOfficeMarkdown.render(data.quote.body));n.prepend(quote);}
    const raw=make('details');raw.append(make('summary','原始记录'),make('pre',JSON.stringify(data,null,2)));n.append(raw);
  }
  function mergeRecords(previous, incoming) {
    const records = new Map(previous.map(r => [r.id, r]));
    for (const row of incoming) {
      const old = records.get(row.id);
      if (old && ((old.revision ?? 0) > (row.revision ?? 0) ||
          (old.state === 'published' && row.state === 'draft'))) continue;
      records.set(row.id, row);
    }
    return [...records.values()];
  }
  function renderEvents() {
    const box = el('officeTimeline');
    box.replaceChildren();
    for (const e of [...state.events].reverse()) {
      const n = make('article');
      n.className = 'office-event';
      n.append(
        make('b', `${seatName(e.seat_id??e.body.sender??e.actor?.roleId)} · ${kinds[e.kind] ?? e.kind}`),
        make('small', ` #${e.seq} / ${new Date(e.ts).toLocaleTimeString()}`)
      );
      const b = e.body;
      n.append(
        make(
          'p',
          b.body ??
            b.action ??
            b.summary ??
            b.item?.title ??
            (b.materialId ? '材料 ' + b.materialId : '')
        )
      );
      if (b.why) n.append(make('p', '原因：' + b.why));
      if (b.recipient) n.append(make('p', '→ ' + seatName(b.recipient)));
      n.append(
        button('查看事件与正文', () =>
          e.detailAvailable
            ? showRecord({ eventSeq: e.seq }, '事件 #' + e.seq)
            : showDetail('事件 #' + e.seq, e)
        )
      );
      const from=button('设为回放起点',()=>setReplayBoundary('from',e.seq)),to=button('设为回放终点',()=>setReplayBoundary('to',e.seq));from.className=to.className='office-event-replay';n.append(from,to);
      box.append(n);
    }
    if (!state.events.length) box.append(make('p', '等待第一条真实事件。不会播放模拟工作动画。'));
  }
  function animate(events) {if(state.appView==='officeRooms'&&state.roomTab==='officeCanvas')scenePlayer.present(events);}
  async function updateOffice() {
    if (!state.office || state.loading || state.opening || replayController.active) return;
    const generation = state.generation;
    state.loading = true;
    try {
      const data = await api('view', { officeId: state.office.office.id, afterSeq: state.cursor, facilityRevision:state.office.facilities?.revision,
        itemIds: state.office.items.map(t => t.id), materialIds: state.office.materials.map(m => m.id) });
      if (generation !== state.generation || !state.logged || replayController.active) return;
      const isLive = !state.office.hasMore && !data.hasMore;
      const old = state.office;
      state.office = {
        ...data,
        facilities: data.facilities?.unchanged ? {...old.facilities,activity:data.facilities.activity,counts:data.facilities.counts} : data.facilities,
        items: mergeRecords(old.items, data.items),
        materials: mergeRecords(old.materials, data.materials)
      };
      if (!state.itemsPaged) state.itemsCursor = data.nextItemsAfterId;
      if (!state.materialsPaged) state.materialsCursor = data.nextMaterialsAfterId;
      state.cursor = data.nextCursor;
      state.events = [...state.events, ...data.events].slice(-500);
      renderOffice();
      if(state.mail?.room===data.office.id&&!state.mailLoading&&old.facilities?.revision!==state.office.facilities?.revision)await loadMail({refresh:true});
      if (isLive) animate(data.events);
    } finally {
      if (generation === state.generation) state.loading = false;
    }
  }
  function startObserver(){
    if(state.eventStream||!window.EventSource)return;
    const stream=new EventSource('./api/office-admin/events');state.eventStream=stream;
    const changed=()=>{if(state.logged&&!document.hidden){state.observerDirty=true;if(!state.polling)schedule(150);}};
    stream.addEventListener('change',changed);stream.addEventListener('ready',changed);
    stream.onerror=()=>{if(state.logged)schedule(2500);};
  }
  function stopObserver(){state.eventStream?.close();state.eventStream=null;}
  function schedule(delay = 2500) {
    clearTimeout(state.poll);
    const epoch = state.authEpoch;
    state.poll = setTimeout(async () => {
      if (epoch !== state.authEpoch || !state.logged) return;
      state.polling=true;state.observerDirty=false;
      try {
      if (state.logged && !document.hidden) {
        try {
          const owner = state.data;
          const data = await api('state', { roleAfterSeq: owner?.characters?.revision });
          if (epoch !== state.authEpoch || !state.logged) return;
          // A manual refresh may have completed while this poll was in flight.
          // Never replace it with a stale response, or erase profile form edits.
          if (state.data !== owner) { state.observerDirty=true;return; }
          const changed = data.characters && !data.characters.unchanged;
          const changedRooms = Array.isArray(data.offices) && JSON.stringify(data.offices)!==JSON.stringify(owner?.offices);
          if (!changed) data.characters = owner?.characters;
          state.data = data;
          if (changed) { renderCharacters(data.characters); refreshSeatChoices(); }
          for (const badge of el('officeAgentList').querySelectorAll('[data-agent]')) {
            const a = data.agents.find((a) => a.id === badge.dataset.agent);
            if (a)
              badge.textContent =
                a.state === 'disabled'
                  ? '已停用'
                  : a.state === 'pending'
                    ? '待配置凭据'
                    : a.discovered_at
                      ? '协作工具已发现'
                      : a.last_seen
                        ? '已握手 · 等待 bootstrap'
                        : '待接入';
          }
          if (state.office && Array.isArray(data.offices) && !data.offices.some(room=>room.id===state.office.office.id)) {
            await clearDeletedRoom(state.office.office.id);
            notice('当前办公室已在其他页面被删除。');
          }
          if (changedRooms) renderRoomChoices();
          await updateOffice();
          if(state.appView==='officeSetup')renderDiagnostics();
          if (state.pollFailed) {
            notice('观察连接已恢复。历史记录已继续同步。');
            state.pollFailed = false;
          }
        } catch (error) {
          if (epoch !== state.authEpoch || !state.logged) return;
          if(error.status===401){state.logged=false;state.authEpoch++;el('officeRoleConnection').close();stopObserver();el('officeLogin').hidden=false;el('officeSettings').hidden=true;el('officeLoginStatus').textContent='管理会话已过期';notice('管理会话已过期，请重新登录。当前编辑草稿仍保留。',true);showAppView('officeSetup');return;}
          state.pollFailed = true;
          el('officeSync').textContent = '观察连接中断 · 正在重试，保留上次状态';
        }
      }
      }finally{state.polling=false;if (epoch === state.authEpoch && state.logged) schedule(state.observerDirty?150:undefined);}
    }, delay);
  }
  function submit(id, fn) {
    el(id).addEventListener('submit', (e) => {
      e.preventDefault();
      run(() => fn(new FormData(e.currentTarget)), e.submitter);
    });
  }
  submit('officeLogin', async (data) => {
    await api('login', {...Object.fromEntries(data),cookiePath:new URL('./api/office-admin',location.href).pathname});
    el('officeLogin').reset();
    await refresh();
    notice('用户管理已连接。');
    schedule();
  });
  submit('officeEndpoint', async (data) => {
    await api('settings', { mcpUrl: data.get('mcpUrl') });
    await refresh();
    notice('接入地址已保存。请确认目标宿主可访问这个地址，并与工作台使用同一数据实例。');
  });
  submit('officeAgentForm', async (data) => {
    await api('agent', {
      id: 'ag-' + uuid(),
      name: data.get('name'),
      principal: data.get('principal'),
      host: data.get('host'),
      state: 'pending',
      expectedRevision: 0
    });
    el('officeAgentForm').reset();
    await refresh();
    notice('身份已登记，尚未接入。展开该 Agent 的 HTTP MCP 配置继续。');
  });
  submit('officeProjectForm', async (data) => {
    await api('project', {
      id: state.editingProject?.id ?? 'project-' + uuid(),
      title: data.get('title'),
      members: data.getAll('members'),
      enabled: true,
      expectedRevision: state.editingProject?.revision ?? 0
    });
    state.editingProject = null;
    el('officeProjectForm').reset();
    await refresh();
    notice('项目成员已保存，不会自动共享私人记忆或文件。');
  });
  submit('officeRoomForm', async (data) => {
    const seats = [...el('officeSeatRows').children].map((n) => {
      const choice=n.querySelector('[name=roleId]').value;
      const roleId=choice;
      const character=state.data.characters?.roles.find(r=>r.id===roleId);
      return ({
      id: n.dataset.id,
      roleId,
      label: n.querySelector('[name=label]').value.trim() || character?.name || '',
      role: n.querySelector('[name=role]').value
    });});
    if (seats.some((s) => !s.roleId))
      throw Error('请先批准角色，再为每位参与者选择角色。');
    const id = state.editing?.id ?? 'office-' + uuid();
    await api('office', {
      id,
      ...(data.get('projectId') ? { projectId: data.get('projectId') } : {}),
      title: data.get('title'),
      goal: data.get('goal'),
      expectedRevision: state.editing?.revision ?? 0,
      state: state.editing?.state ?? 'active',
      seats
    });
    state.editing = null;el('officeCreate').open=false;
    el('officeCreate').querySelector('summary').textContent = '＋ 创建空办公室';
    el('officeRoomForm').reset();
    el('officeSeatRows').replaceChildren();
    await refresh();
    await openOffice(id);
    notice('办公室已保存。如何使用这个空间由你和参与者决定。');
  });
  el('officeAddSeat').onclick = () => addSeat();
  el('officeRoleRefresh').onclick = () => run(() => refresh(), el('officeRoleRefresh'));
  submit('officeRoleLink', async data => {
    await api('role/link', {sender:data.get('sender'),recipient:data.get('recipient'),enabled:data.get('enabled')==='true'});
    notice('通信权限已保存；记忆与文件权限不会扩大。');
  });
  el('officeRefresh').onclick = () =>
    run(async () => {
      await refresh();
      await updateOffice();
    });
  el('officeLogout').onclick = () =>
    run(async () => {
      if (state.containerDirty && !(await confirmAction('容器有尚未保存的修改，仍要退出管理？'))) return;
      if (!(await closeRoleInspector())) return;
      await closeOfficeDetail(true);
      state.containerDirty = false;
      setExpanded(null);
      state.authEpoch++;el('officeRoleConnection').close();
      await api('logout');stopObserver();
      replayController.close();state.replayIndexRoom=null;
      scenePlayer.reset();
      state.generation++;
      state.logged = false;
      clearTimeout(state.poll);
      state.data = null;
      state.office = null;
      window.MindPondOfficeCollaboration?.reset?.();window.MindPondOfficeResources?.reset?.();
      state.events = [];
      el('officeLogin').hidden = false;
      el('officeSettings').hidden = true;
      el('officeView').hidden = true;
      el('officeLoginStatus').textContent = '已退出管理';
      el('officeShellStatus').textContent='尚未登录管理';el('officeNavRoomCount').textContent='0';el('officeNavPending').hidden=true;el('officeWorkspaceEmpty').hidden=false;
      el('officeCancelEdit').onclick();showAppView('officeSetup');
      el('officeAgentList').replaceChildren();
      el('officeRoomList').replaceChildren();
      for(const id of ['officeApplications','officeCharacterList','officeRoleMessages','officeRoleLinks','officeRoleEvents'])el(id).replaceChildren();
      notice('已退出管理。');
    });
  window.addEventListener('pagehide', () => {replayController.close();scenePlayer.reset();state.authEpoch++;el('officeRoleConnection').close();stopObserver();clearTimeout(state.poll);});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.logged)schedule(150);});
  window.addEventListener('pageshow', event => {if(event.persisted && state.logged){startObserver();schedule(0);}});
  if(window.MindPondOfficeCollaboration?.mount){const mounted=window.MindPondOfficeCollaboration.mount({getState:()=>state,api,run,showDetail,showMaterial,setRoomTab,notice,confirmAction,download,fitScene});Object.assign(window.MindPondOfficeCollaboration,mounted);}
  if(window.MindPondOfficeResources?.mount)Object.assign(window.MindPondOfficeResources,window.MindPondOfficeResources.mount({getState:()=>state,api,run,setRoomTab,notice,confirmAction,download}));
  syncAppRoute();
  api('state')
    .then(async () => {
      await refresh();
      if(state.appView==='officeRooms'&&state.data.offices.length){const chosen=state.data.offices.find(o=>o.state==='active')??state.data.offices[0];await openOffice(chosen.id);}
      schedule();
    })
    .catch(() => {el('officeShellStatus').textContent='请先登录管理';showAppView('officeSetup');});
})();
