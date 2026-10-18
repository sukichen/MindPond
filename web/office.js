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
    poll: null,
    authEpoch: 0,
    roleEditing: false,
    renderedFacilities: null,
    roleQuery: '', roleFilter: 'all', roleZoom: 100, roomQuery: '',
    roleDraft: null, expanded: null, appView: 'officeRooms', roomTab: 'officeCanvas',
    scene: { scale: 1, x: 0, y: 0, autoFit: true, room: null }
  };
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
  const kinds = {message:'消息',message_read:'阅读消息',message_archive:'归档消息',container:'更新容器',
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
    if (!r.ok) throw Error(data.code === 'stale_version'
      ? route.endsWith('/delete') ? '资料已被其他操作更新或删除。请重新打开角色或办公室，核对最新内容后再决定是否删除。' : '资料已被其他操作更新。你的草稿仍保留，请复制需要的内容，关闭后重新打开再编辑。'
      : data.error ?? '操作失败');
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
  function template(agent, url) {
    const env = 'MINDPOND_' + agent.id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase() + '_TOKEN',
      name = 'mindpond_' + agent.id.replace(/[^A-Za-z0-9_]/g, '_');
    if (agent.host === 'codex')
      return {
        env,
        place: '宿主原生 HTTP MCP 设置（.codex/config.toml）',
        text: `[mcp_servers.${name}]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = ${JSON.stringify(env)}\ntool_timeout_sec = 65\n`,
        docs: 'https://learn.chatgpt.com/docs/extend/mcp'
      };
    if (agent.host === 'opencode')
      return {
        env,
        place: '宿主原生 HTTP MCP 设置（opencode.json）',
        text: JSON.stringify(
          {
            mcp: {
              [name]: {
                type: 'remote',
                url,
                oauth: false,
                headers: { Authorization: `Bearer {env:${env}}` },
                timeout: 65000
              }
            }
          },
          null,
          2
        ),
        docs: 'https://opencode.ai/docs/mcp-servers/'
      };
    if (agent.host === 'claude')
      return {
        env,
        place: 'Claude Code 的 .mcp.json（只含变量引用）',
        text: JSON.stringify(
          {
            mcpServers: {
              [name]: {
                type: 'http',
                url,
                headers: { Authorization: 'Bearer ${' + env + '}' },
                timeout: 65000
              }
            }
          },
          null,
          2
        ),
        docs: 'https://code.claude.com/docs/en/mcp'
      };
    return {
      env,
      place: '该宿主的原生 HTTP MCP 设置（语法需按客户端验证）',
      text: `Streamable HTTP MCP URL: ${url}\nAuthentication: Bearer supplied by host secret setting\nSecret reference: ${env}\nTool timeout: at least 65 seconds\n`,
      docs: null
    };
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
    const cfg = template(agent, url);
    const configPreview=make('pre',cfg.text);
    details.append(
      make('p', cfg.place),
      configPreview,
      make(
        'p',
        `由用户把凭据放入宿主秘密设置，使用变量名 ${cfg.env}。配置不会自动设置变量；不要让 agent 用 shell 寻找 token。环境变量若对 shell 可见，秘密隔离仍未实现。`
      )
    );
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
    details.append(make('p','同一个宿主连接可以用于多个聊天。提供原生会话信息时自动关联；否则申请后保留公开 roleContext 并在后续 MCP 调用中携带。不需要额外启动器或配置目录。'));
    const policy = state.data.credentialPolicies?.[agent.id];
    const initialPersonal = policy?.domains.find(d => d.kind === 'personal')?.id ?? agent.principal;
    const personal = input(initialPersonal, '明确允许访问的个人记忆范围');
    details.append(label('个人记忆范围 ID（填写已有范围，或创建独立范围）', personal));
    const initialRestrictions = (policy?.assignmentIds ?? []).join(',');
    const restrictions = input(initialRestrictions, '仅允许的工位 ID，逗号分隔；清空将解除工位限制');
    details.append(label('高级：限制可用分工', restrictions));
    details.append(make('p', '重新签发默认保留现有记忆范围与工位限制。修改记忆范围将替换现有领域授权；清空已有工位列表将解除限制。'));
    const issue = button(
      agent.state === 'pending' ? '签发并下载一次性凭据' : '重新签发并下载（旧凭据失效）',
      async () => {
        if (
          agent.state !== 'pending' &&
          !(await confirmAction('重新签发会撤销旧凭据。请在宿主中替换后重连；是否继续？'))
        )
          return;
        const assignmentIds = restrictions.value.split(',').map(s => s.trim()).filter(Boolean);
        const restrictionsChanged = assignmentIds.join(',') !== initialRestrictions;
        if (policy?.assignmentIds?.length && restrictionsChanged && !assignmentIds.length &&
          !(await confirmAction('清空后此凭据可以选择该 agent 的所有已授权工位。确认解除工位限制？'))) return;
        if (policy && personal.value !== initialPersonal &&
          !(await confirmAction('这会将原有记忆领域授权替换为指定的个人范围。确认修改？'))) return;
        const response = await api('credential', {
          id: agent.id,
          expectedRevision: agent.revision,
          ...(!policy || personal.value !== initialPersonal ? { personalId: personal.value } : {}),
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
    state.logged = true;
    el('officeLogin').hidden = true;
    el('officeSettings').hidden = false;
    state.initializedView = true;
    el('officeShellStatus').textContent='管理已连接';
    el('officeNavRoomCount').textContent=String(state.data.offices.length);
    el('officeLoginStatus').textContent = '已登录用户管理';
    el('officeEndpoint').elements.mcpUrl.value = state.data.settings.mcpUrl ?? '';
    el('officeInstance').textContent =
      '实例 ' +
      state.data.settings.instanceId +
      ' · 握手记录来自此数据库；记录存在不代表宿主当前仍在运行。';
    el('officeAgentCount').textContent = state.data.agents.length + ' 个连接';
    renderCharacters(state.data.characters);
    if(!state.data.characters)notice('当前后台进程尚未加载角色功能。请升级并重启 MindPond 服务；已有记忆与旧工位功能仍可使用。',true);
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
  function renderRoomChoices() {
    const box = el('officeRoomList'); box.replaceChildren();
    el('officeNavRoomCount').textContent=String(state.data?.offices.length??0);
    const rooms = state.data?.offices ?? [], query = state.roomQuery.trim().toLocaleLowerCase();
    const matches = rooms.filter(room => !query || [room.title, room.goal, room.id].join(' ').toLocaleLowerCase().includes(query));
    for (const room of matches) {
      const pick = button('', () => openOffice(room.id));
      pick.append(make('strong', room.title), make('span', officeStates[room.state] ?? room.state));
      pick.className = 'office-room-choice';
      pick.setAttribute('aria-pressed', String(state.office?.office.id === room.id));
      box.append(pick);
    }
    if (!matches.length) box.append(make('p', rooms.length ? '没有匹配的办公室。' : '还没有办公室。可以直接创建一个空房间。'));
  }
  function refreshSeatChoices() {
    for (const row of el('officeSeatRows').children) {
      const select = row.querySelector('[name=agent]'),
        value = select.value;
      select.replaceChildren();
      for (const agent of seatChoices()) {
        const option = make('option', agent.name);
        option.value = agent.value;
        select.append(option);
      }
      if ([...select.options].some((o) => o.value === value)) select.value = value;
    }
  }
  function seatChoices() {
    return [
      ...(state.data?.characters?.roles ?? []).filter(r => r.state === 'active').map(r => ({ value: 'role:' + r.id, name: r.name + ' · ' + r.introduction.slice(0, 40) })),
      ...(state.data?.agents ?? []).filter(a => a.state === 'active').map(a => ({ value: a.id, name: '旧工位 / 连接：' + a.name + ' · ' + a.principal }))
    ];
  }
  function renderCharacters(data) {
    if (!data) return;
    const pending = el('officeApplications'), list = el('officeCharacterList');
    pending.replaceChildren(); list.replaceChildren();
    el('officePendingCount').textContent = data.pending.length;
    el('officeNavPending').textContent=String(data.pending.length);el('officeNavPending').hidden=!data.pending.length;
    for (const app of data.pending) {
      const card = button('', () => openRoleInspector(app, true));
      card.className = 'office-application-card';
      card.append(make('strong', app.name), make('span', '待审核 · ' + app.principal), make('p', app.introduction), make('small', '查看申请 →'));
      pending.append(card);
    }
    if (!data.pending.length) pending.append(make('p', '没有待审核申请。'));
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
      const card = make('details'), summary = make('summary', `${m.sender_name ?? nameOf(m.sender)} → ${m.recipient_name ?? nameOf(m.recipient)} · ${m.kind} · ${m.state === 'queued' ? '未读' : m.state === 'read' ? '已读' : '已归档'}`);
      card.append(summary, make('p', new Date(m.created_at).toLocaleString() + ' · ' + m.id), make('pre', m.body));messages.append(card);
    }
    if (!data.messages.length) messages.append(make('p', '尚无角色消息。'));
  }
  function filteredRoles() {
    const roles = state.data?.characters?.roles ?? [];
    const query = state.roleQuery.trim().toLocaleLowerCase();
    return roles.filter(role => {
      const assigned = state.data.characters.mappings.some(m => m.role_id === role.id);
      return (!query || [role.name, role.introduction, role.principal, role.id].join(' ').toLocaleLowerCase().includes(query)) &&
        (state.roleFilter === 'all' || (state.roleFilter === 'unassigned' ? role.state === 'active' && !assigned : role.state === state.roleFilter));
    });
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
      card.append(heading, status, make('p', role.introduction), make('small', `${role.principal} · ${places ? places + ' 个工位' : '未安排办公室'}`));
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
    if (!(await confirmAction(`永久删除角色「${record.name}」？这会删除角色资料、会话绑定和角色收发的私信，撤销所有工位权限，并取消该角色参与的未完成任务。办公室历史材料与操作审计保留。删除后无法恢复。`,{destructive:true,title:'永久删除角色'}))) return;
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
    body.append(meta, form);
    const info = make('details');info.append(make('summary', '身份与连接信息'), make('p', `编号：${record.id}`), make('p', '连接：' + record.connector_id));
    if (application) info.append(make('p', record.reason), make('p', '会话关联：' + record.mode));
    else {
      info.append(make('p', '资料版本 ' + record.revision));
      const count = state.data.characters.mappings.filter(m => m.role_id === record.id).length;
      info.append(make('p', `已安排 ${count} 个工位`), button('前往办公室', async () => {if (await closeRoleInspector()) {setExpanded(null);showAppView('officeRooms');}}));
    }
    body.append(info);
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
      if (!(await confirmAction(application ? '确认拒绝这份申请？' : record.state === 'active' ? '确认停用这个角色？现有会话将失去角色权限。' : '确认重新启用这个角色？'))) return;
      await saveProfile(application ? 'reject' : record.state === 'active' ? 'disabled' : 'active');
    });secondary.className = 'office-danger';actions.append(secondary);form.append(actions);
    if (!application) {
      const remove=button('永久删除角色',()=>deleteCharacter(record));remove.className='office-danger';
      actions.append(remove);
    }
    dialog.showModal();name.focus();
  }
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
    let cols=1,best=0;
    for(let candidate=1;candidate<=Math.min(count||1,7);candidate++){
      const score=Math.min((Math.max(viewport.clientWidth,300)-40)/(candidate*312+100),(Math.max(viewport.clientHeight,260)-40)/(Math.ceil((count||1)/candidate)*308+207));
      if(score>best){best=score;cols=candidate;}
    }
    const columns=`repeat(${cols}, 280px)`;
    if(el('officeDesks').style.gridTemplateColumns!==columns)scenePlayer.stop();
    el('officeDesks').style.gridTemplateColumns = columns;
    el('officeScene').style.width = (cols * 312 + 100) + 'px';
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
    if(id!=='officeRooms'){if(state.opening){state.generation++;state.opening=false;}replayController.pause();scenePlayer.stop();}
    else if(state.office && state.roomTab==='officeCanvas')requestAnimationFrame(()=>{layoutScene(el('officeDesks').children.length);if(state.scene.autoFit)fitScene();});
    el('officeWorkspaceEmpty').hidden=Boolean(state.office);
  }
  function setRoomTab(id, focus = false) {
    const tabs=[...document.querySelectorAll('[data-room-tab]')];
    if(!tabs.some(tab=>tab.dataset.roomTab===id))return;
    state.roomTab=id;
    for(const tab of tabs){const selected=tab.dataset.roomTab===id;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;if(selected&&focus)tab.focus();}
    for(const panel of document.querySelectorAll('[data-room-panel]'))panel.hidden=panel.id!==id;
    if(id!=='officeCanvas'){replayController.pause();scenePlayer.stop();}
    else requestAnimationFrame(()=>{layoutScene(el('officeDesks').children.length);if(state.scene.autoFit)fitScene();});
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
  const replayController=new window.MindPondOfficeReplay.Player({scene:scenePlayer,fetchPage:args=>api('replay',args),prepare:prepareReplayParticipants,restore:()=>{if(state.office){state.deskSnapshot=null;renderOffice();}},view:{
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
      const rows=el('officeReplayRoles');rows.replaceChildren();
      for(const p of [...meta.participants,{key:'system',name:'用户 / 系统事件'}]){const label=make('label',p.name+' · 每件事（秒）'),input=make('input');input.type='number';input.min='.5';input.max='60';input.step='.5';input.value=player.durations.has(p.key)?String(player.durations.get(p.key)):'';input.placeholder=String(player.defaultSeconds)+'（默认）';input.setAttribute('aria-label',p.name+'每件事展示秒数');input.onchange=()=>{if(input.value===''){player.durations.delete(p.key);}else if(input.reportValidity())player.setDuration(p.key,input.valueAsNumber);};label.append(input);rows.append(label);}
      el('officeReplaySeek').max=String(player.events.length-1);el('officeReplaySeek').value='0';
    },
    select(event,index,total,player){
      el('officeReplayNow').textContent=`#${event.seq} · ${replayName(event.actorKey)} · ${kinds[event.kind]??event.kind}`;
      el('officeReplaySeek').value=String(index);const current=el('officeReplayCurrent');current.hidden=false;current.replaceChildren(make('h4',`#${event.seq} · ${replayName(event.actorKey)} · ${kinds[event.kind]??event.kind}`),make('small',new Date(event.ts).toLocaleString()));
      const body=event.body;current.append(make('p',body.body??body.action??body.summary??body.title??(body.materialId?'材料 '+body.materialId:body.itemId?'任务 '+body.itemId:'事件已记录')));
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
  el('officeReplayRange').onsubmit=event=>{event.preventDefault();void run(async()=>{if(!state.office)return;await replayController.load(state.office.office.id,el('officeReplayFrom').valueAsNumber,el('officeReplayTo').valueAsNumber);});};
  el('officeReplayPlay').onclick=()=>{replayController.play();if(replayController.active){el('officeReplay').open=false;el('officeStage').scrollIntoView({block:'center',behavior:'instant'});}};el('officeReplayPause').onclick=()=>replayController.pause();
  el('officeReplayPrevious').onclick=()=>replayController.seek(replayController.index-1);el('officeReplayNext').onclick=()=>replayController.seek(replayController.index+1);
  el('officeReplayInspect').onclick=()=>{const e=replayController.events[replayController.index];if(e)void run(()=>e.detailAvailable?showRecord({eventSeq:e.seq},'事件 #'+e.seq):showDetail('事件 #'+e.seq,e));};
  el('officeReplaySeek').oninput=()=>replayController.seek(Number(el('officeReplaySeek').value));
  el('officeReplayLive').onclick=()=>{replayController.close();el('officeReplayCurrent').hidden=true;el('officeReplayEvents').replaceChildren();void run(()=>updateOffice());};
  el('officeReplayDuration').onchange=()=>{if(el('officeReplayDuration').reportValidity()){replayController.setDuration(null,el('officeReplayDuration').valueAsNumber);for(const input of el('officeReplayRoles').querySelectorAll('input'))input.placeholder=String(replayController.defaultSeconds)+'（默认）';}};
  el('officeReplaySpeed').onchange=()=>{replayController.setSpeed(Number(el('officeReplaySpeed').value));replayController.view.change(replayController);};
  el('officeScenePreview').onclick = () => scenePlayer.demo(el('officeActionPreview').value);
  el('officeSceneMotion').onclick = () => {const on=!scenePlayer.motion;scenePlayer.setMotion(on);el('officeSceneMotion').setAttribute('aria-pressed',String(!on));el('officeSceneMotion').textContent=on?'暂停动态':'开启动效';};
  el('officeSceneList').onclick = () => {const list=el('officeCanvas').classList.toggle('is-list');el('officeSceneList').setAttribute('aria-pressed',String(list));el('officeSceneList').textContent=list?'场景视图':'列表视图';scenePlayer.list=list;scenePlayer.stop();if(!list)requestAnimationFrame(()=>fitScene());};
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
  window.addEventListener('beforeunload', e => {if (state.roleDraft?.dirty || state.containerDirty) {e.preventDefault();e.returnValue = '';}});
  new ResizeObserver(() => {if (state.scene.autoFit) requestAnimationFrame(()=>fitScene());}).observe(stage);
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
    agent.name = 'agent';
    for (const a of seatChoices()) {
      const option = make('option', a.name);
      option.value = a.value;
      agent.append(option);
    }
    if (data) {
      const mapped=state.data.characters?.mappings.find(m=>m.seat_id===data.id);
      agent.value=mapped?'role:'+mapped.role_id:data.agent_id;
    }
    const name = input(data?.label ?? '', '可选，留空使用人物名字');
    name.name = 'label';
    name.required = false;
    name.maxLength = 120;
    const role = make('input');role.type='hidden';role.name='role';role.value=data?.role??'member';
    row.append(
      label('角色人物 / 旧连接', agent),
      label('在这里的称呼 / 分工（自定义）', name),
      role,
      button('移除', () => row.remove())
    );
    el('officeSeatRows').append(row);
  }
  async function openOffice(id) {
    if (state.containerDirty && !(await confirmAction('容器有尚未保存的修改，仍要切换办公室？'))) return;
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
    state.office = first;
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
    if(state.renderedFacilities===data)return;
    state.renderedFacilities=data;
    const box=el('officeContainers'), messages=el('officeRoomMessages');box.replaceChildren();messages.replaceChildren();
    for(const c of data?.containers??[]){const row=make('article');row.className='office-item';row.append(make('strong',c.title),make('p','版本 '+c.revision),button('打开 / 编辑',async()=>{const room=state.office.office.id;const record=await api('containers',{action:'get',officeId:room,id:c.id});if(state.office?.office.id===room)editContainer(record);}));box.append(row);}
    if(!data?.containers?.length)box.append(make('p','这里还没有容器。需要时可以自行添加。'));
    if(data?.hasMore)box.append(button('查看更多容器',async()=>{const room=state.office.office.id;const page=await api('containers',{action:'list',officeId:room,afterId:data.nextAfterId});if(state.office?.office.id!==room)return;state.office.facilities={...data,containers:[...data.containers,...page.containers],hasMore:page.hasMore,nextAfterId:page.nextAfterId};renderFacilities(state.office.facilities);}));
    for(const m of data?.messages??[]){const row=make('details');row.append(make('summary',m.sender_name+' → '+m.recipient_name+' · '+new Date(m.created_at).toLocaleString()),make('pre',m.body));messages.append(row);}
    if(!data?.messages?.length)messages.append(make('p','尚无办公室消息。'));
  }
  el('officeAddContainer').onclick=()=>{if(state.office)editContainer({id:'container-'+uuid(),title:'',content:'',revision:0});};
  function renderOffice() {
    if(replayController.active)return;
    const data = state.office,
      o = data.office;
    el('officeTitle').textContent = o.title;
    el('officeGoal').textContent = o.goal;
    el('officeRoomMeta').textContent =
      `${officeStates[o.state]??o.state} · ${data.seats.filter(s=>s.enabled).length} 位参与者`;
    renderFacilities(data.facilities);
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
          if (!(await confirmAction('保存分工会使旧会话绑定和租约失效，agent 需要重新绑定。继续编辑？')))
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
    controls.append(removeOffice);
    const deskSnapshot = JSON.stringify([o.id, data.seats, data.access, data.waits, data.items.filter(t => t.status === 'claimed'), data.facilities?.activity, state.data.characters?.roles.map(r => [r.id, r.name])]);
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
      person.className =
        'office-person ' +
        (access?.mode === 'text_only'
          ? 'text-only'
          : access?.mode === 'shared_worktree'
            ? 'shared'
            : 'unknown');
      if (access?.group) {
        let hash = 0;
        for (const c of access.group) hash = (hash * 31 + c.charCodeAt(0)) | 0;
        person.style.setProperty('--coat', `hsl(${Math.abs(hash) % 360} 24% 48%)`);
      }
      const body = make('span'),
        wait = data.waits.find((w) => w.seat_id === seat.id);
      const task = data.items.find((t) => t.owner === seat.id && t.status === 'claimed');
      body.className='office-desk-caption';
      const shared = access?.mode === 'shared_worktree';
      body.append(
        make('strong', seat.label),
        make('small', `${characterForSeat(seat)?.name??seat.name} · ${roles[seat.role]??seat.role}`),
        make(
          'small',
          wait
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
      const activity=data.facilities?.activity?.find(r=>r.seatId===seat.id);
      const pending=Number(activity?.pending??0);
      const station=window.MindPondOfficeScene.props(person);
      const papers=station.querySelector('.office-paper-stack');
      papers.style.setProperty('--paper-count',Math.min(12,pending));papers.hidden=!pending;
      if(pending){papers.textContent=String(pending);body.append(make('small',`待整理消息 ${pending} 条（含已读未归档）`));}
      if(activity?.waitingUntil>Date.now())body.append(make('small','正在等待消息（等待窗口内）'));
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
            if (!(await confirmAction('取消此工作项并撤销旧租约？历史证据仍保留。'))) return;
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
        make('p', '没有旧工作流记录。')
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
    if(state.appView==='officeRooms'&&state.roomTab==='officeCanvas')scenePlayer.syncWaiting((data.facilities?.activity??[]).filter(a=>a.waitingUntil>Date.now()).map(a=>({key:a.roleId?'role:'+a.roleId:'seat:'+a.seatId,until:a.waitingUntil})));
    if(el('officeReplay').open&&state.replayIndexRoom!==o.id)void run(refreshReplayIndex);
    renderEvents();
  }
  function showSeat(seat) {
    const detail = openOfficeDetail();
    detail.replaceChildren(
      make('h3', seat.label),
      make('p', `${characterForSeat(seat)?.name??seat.name} · ${roles[seat.role]??seat.role}`)
    );
    const prompt = `使用已配置的 MindPond HTTP MCP。用 role_sync 读取自己的身份，office_directory 查看有权访问的办公室。这里的办公室编号是 ${seat.office_id}。office_receive 取信，office_message 发信或回复，office_material 存取文本，office_container 存取自定义内容。不要读取或传递认证 token。具体如何开展工作由用户和你决定。`;
    detail.append(
      make(
        'p',
        '下面只说明设施的使用方式，不包含工作安排或凭据。'
      ),
      make('pre', prompt),
      button('下载本工位启动提示词', () => download(prompt, seat.id + '-start.txt'))
    );
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
    n.replaceChildren(make('h3', title), make('pre', JSON.stringify(data, null, 2)));
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
        facilities: data.facilities?.unchanged ? {...old.facilities,activity:data.facilities.activity} : data.facilities,
        items: mergeRecords(old.items, data.items),
        materials: mergeRecords(old.materials, data.materials)
      };
      if (!state.itemsPaged) state.itemsCursor = data.nextItemsAfterId;
      if (!state.materialsPaged) state.materialsCursor = data.nextMaterialsAfterId;
      state.cursor = data.nextCursor;
      state.events = [...state.events, ...data.events].slice(-500);
      renderOffice();
      if (isLive) animate(data.events);
    } finally {
      if (generation === state.generation) state.loading = false;
    }
  }
  function schedule() {
    clearTimeout(state.poll);
    const epoch = state.authEpoch;
    state.poll = setTimeout(async () => {
      if (epoch !== state.authEpoch || !state.logged) return;
      if (state.logged && !document.hidden) {
        try {
          const owner = state.data;
          const data = await api('state', { roleAfterSeq: owner?.characters?.revision });
          if (epoch !== state.authEpoch || !state.logged) return;
          // A manual refresh may have completed while this poll was in flight.
          // Never replace it with a stale response, or erase profile form edits.
          if (state.data !== owner) { schedule(); return; }
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
          if (state.pollFailed) {
            notice('观察连接已恢复。历史记录已继续同步。');
            state.pollFailed = false;
          }
        } catch (error) {
          if (epoch !== state.authEpoch || !state.logged) return;
          state.pollFailed = true;
          el('officeSync').textContent = '观察连接中断 · 正在重试，保留上次状态';
        }
      }
      if (epoch === state.authEpoch && state.logged) schedule();
    }, 2500);
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
      const choice=n.querySelector('[name=agent]').value;
      const roleId=choice.startsWith('role:')?choice.slice(5):null;
      const character=state.data.characters?.roles.find(r=>r.id===roleId);
      return ({
      id: n.dataset.id,
      agentId: character?.connector_id??choice,
      ...(roleId?{roleId}:{}),
      label: n.querySelector('[name=label]').value.trim() || character?.name || state.data.agents.find(a=>a.id===choice)?.name || choice,
      role: n.querySelector('[name=role]').value
    });});
    if (seats.some((s) => !s.agentId))
      throw Error('请先接入至少一个 active agent，再安排工位。');
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
      state.authEpoch++;
      await api('logout');
      replayController.close();state.replayIndexRoom=null;
      scenePlayer.reset();
      state.generation++;
      state.logged = false;
      clearTimeout(state.poll);
      state.data = null;
      state.office = null;
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
  window.addEventListener('pagehide', () => {replayController.close();scenePlayer.reset();state.authEpoch++;clearTimeout(state.poll);});
  window.addEventListener('pageshow', event => {if(event.persisted && state.logged)schedule();});
  syncAppRoute();
  api('state')
    .then(async () => {
      await refresh();
      if(state.appView==='officeRooms'&&state.data.offices.length)await openOffice(state.data.offices[0].id);
      schedule();
    })
    .catch(() => {el('officeShellStatus').textContent='请先登录管理';showAppView('officeSetup');});
})();
