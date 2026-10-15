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
    logged: false,
    editing: null,
    editingProject: null,
    poll: null
  };
  const officeStates = {
    active: '协作中',
    paused: '已暂停',
    completed: '已完成',
    cancelled: '已停止'
  };
  const roles = {
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
  const kinds = {
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
  const notice = (text, error = false) => {
    el('officeNotice').hidden = false;
    el('officeNotice').textContent = text;
    el('officeNotice').className = error ? 'is-error' : '';
  };
  async function api(route, body = {}) {
    const r = await fetch('./api/office-admin/' + route, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) throw Error(data.error ?? '操作失败');
    return data;
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
        place: '用户的 Codex config.toml',
        text: `[mcp_servers.${name}]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = ${JSON.stringify(env)}\ntool_timeout_sec = 65\n`,
        docs: 'https://learn.chatgpt.com/docs/extend/mcp'
      };
    if (agent.host === 'opencode')
      return {
        env,
        place: '宿主用户级 opencode.json',
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
    details.append(
      make('p', cfg.place),
      make('pre', cfg.text),
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
    const personal = input(agent.principal, '明确允许访问的个人记忆范围');
    details.append(label('个人记忆范围 ID（填写已有范围，或创建独立范围）', personal));
    const restrictions = input('', '留空：显式上下文；或只允许的工位 ID，逗号分隔');
    details.append(label('高级：限制可用分工', restrictions));
    const issue = button(
      agent.state === 'pending' ? '签发并下载一次性凭据' : '重新签发并下载（旧凭据失效）',
      async () => {
        if (
          agent.state !== 'pending' &&
          !window.confirm('重新签发会撤销旧凭据。请在宿主中替换后重连；是否继续？')
        )
          return;
        const response = await api('credential', {
          id: agent.id,
          expectedRevision: agent.revision,
          personalId: personal.value,
          assignmentIds: restrictions.value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        });
        download(response.token + '\n', agent.id + '.token');
        response.token = '';
        notice(
          '凭据已下载，仅保存在用户下载文件中；请移入宿主秘密设置并妥善清理下载副本。不要把它发给 agent。'
        );
        await refresh();
      }
    );
    issue.disabled = !state.data.credentialIssuance;
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
    state.data = await api('state');
    state.logged = true;
    el('officeLogin').hidden = true;
    el('officeSettings').hidden = false;
    el('officeLoginStatus').textContent = '已登录用户管理';
    el('officeEndpoint').elements.mcpUrl.value = state.data.settings.mcpUrl ?? '';
    el('officeInstance').textContent =
      '实例 ' +
      state.data.settings.instanceId +
      ' · 握手记录来自此数据库；记录存在不代表宿主当前仍在运行。';
    el('officeAgentCount').textContent = state.data.agents.length + ' 个身份';
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
      box.append(make('p', '还没有 agent。填写名称、账户和宿主即可添加。'));
    const rooms = el('officeRoomList');
    rooms.replaceChildren();
    for (const room of state.data.offices)
      rooms.append(
        button(`${room.title} · ${room.state==='active'&&room.deadline<=Date.now()?'已到截止':officeStates[room.state]??room.state}`, () =>
          openOffice(room.id)
        )
      );
    if (!state.data.offices.length)
      rooms.append(make('p', '还没有办公室。接入 agent 后，展开下面的创建表单。'));
    for (const row of el('officeSeatRows').children) {
      const select = row.querySelector('[name=agent]'),
        value = select.value;
      select.replaceChildren();
      for (const agent of state.data.agents.filter((a) => a.state === 'active')) {
        const option = make('option', agent.name + ' · ' + agent.principal);
        option.value = agent.id;
        select.append(option);
      }
      if ([...select.options].some((o) => o.value === value)) select.value = value;
    }
    renderProjects();
    if (!el('officeSeatRows').children.length) {
      addSeat();
      addSeat();
    }
  }
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
    for (const a of state.data?.agents.filter((a) => a.state === 'active') ?? []) {
      const option = make('option', a.name + ' · ' + a.principal);
      option.value = a.id;
      agent.append(option);
    }
    if (data) agent.value = data.agent_id;
    const name = input(data?.label ?? '', '例如：会话 A · 开发');
    name.name = 'label';
    name.required = true;
    name.maxLength = 120;
    const role = make('select');
    role.name = 'role';
    for (const [value, title] of Object.entries(roles)) {
      const option = make('option', title);
      option.value = value;
      role.append(option);
    }
    role.value = data?.role ?? (el('officeSeatRows').children.length === 1 ? 'reviewer' : 'worker');
    row.append(
      label('接入身份', agent),
      label('会话 / 分工名称', name),
      label('角色', role),
      button('移除', () => row.remove())
    );
    el('officeSeatRows').append(row);
  }
  async function openOffice(id) {
    const first = await api('view', { officeId: id });
    state.office = first;
    state.itemsCursor = first.nextItemsAfterId;
    state.materialsCursor = first.nextMaterialsAfterId;
    state.itemsPaged = false;
    state.materialsPaged = false;
    state.events = first.events;
    state.cursor = first.nextCursor;
    renderOffice();
    el('officeView').hidden = false;
    el('officeView').scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
      block: 'start'
    });
  }
  function seatName(id) {
    return state.office?.seats.find((s) => s.id === id)?.label ?? id ?? '用户';
  }
  function fileCondition(seat) {
    const observation = state.office?.access?.find((a) => a.seatId === seat.id);
    if (!observation || Date.now() - observation.observedAt > 86400000) return undefined;
    return observation.report;
  }
  function renderOffice() {
    const data = state.office,
      o = data.office;
    el('officeTitle').textContent = o.title;
    el('officeGoal').textContent = o.goal;
    el('officeRoomMeta').textContent =
      `${o.state==='active'&&o.deadline<=Date.now()?'已到截止':officeStates[o.state]??o.state} · 截止 ${new Date(o.deadline).toLocaleString()} · 全办公室最多 ${o.max_rounds} 轮 · 验收：${o.acceptance}`;
    el('officeSync').textContent = data.hasMore
      ? '有更多事件，继续同步中'
      : '最近同步 ' + new Date().toLocaleTimeString();
    const controls = el('officeControls');
    controls.replaceChildren();
    for (const [value, title] of [
      ['active', '继续办公室'],
      ['paused', '暂停办公室'],
      ['cancelled', '停止办公室']
    ])
      if (!['completed', 'cancelled'].includes(o.state) && o.state !== value)
        controls.append(
          button(title, async () => {
            if (
              value === 'cancelled' &&
              !window.confirm('停止办公室将拒绝后续提交并结束等待，不会强制结束远端宿主。继续？')
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
        button('修改会话分工', () => {
          if (!window.confirm('保存分工会使旧会话绑定和租约失效，agent 需要重新绑定。继续编辑？'))
            return;
          state.editing = { id: o.id, revision: o.revision };
          const f = el('officeRoomForm');
          f.elements.projectId.value = o.projectId ?? '';
          f.elements.title.value = o.title;
          f.elements.goal.value = o.goal;
          f.elements.acceptance.value = o.acceptance;
          f.elements.maxRounds.value = o.max_rounds;
          f.elements.deadline.value = new Date(o.deadline - new Date().getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 16);
          el('officeSeatRows').replaceChildren();
          for (const seat of data.seats.filter((s) => s.enabled)) addSeat(seat);
          el('officeCreate').open = true;
          el('officeCreate').scrollIntoView();
        })
      );
    const desks = el('officeDesks');
    desks.replaceChildren();
    for (const seat of data.seats.filter((s) => s.enabled)) {
      const node = button('', () => showSeat(seat));
      node.className = 'office-desk';
      node.dataset.seat = seat.id;
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
      const shared = access?.mode === 'shared_worktree';
      body.append(
        make('strong', seat.label),
        make('small', `${seat.name} · ${roles[seat.role]}`),
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
      node.append(person, body);
      desks.append(node);
    }
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
          const full = await api('view', { officeId: o.id, itemId: item.id });
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
            if (!window.confirm('取消此工作项并撤销旧租约？历史证据仍保留。')) return;
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
        make('p', '尚无工作项。将工位启动提示词交给 agent，它会通过 MCP 领取分工并创建任务。')
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
    renderEvents();
  }
  function showSeat(seat) {
    const detail = el('officeDetail');
    detail.hidden = false;
    detail.replaceChildren(
      make('h3', seat.label),
      make('p', `${seat.name} / ${roles[seat.role]} · Agent ${seat.agent_id}`)
    );
    const prompt = `使用已经配置的 MindPond HTTP MCP。先调用 work_bootstrap 确认你的 agentId 是 ${seat.agent_id}。在办公室 ${seat.office_id} 领取我已授权的分工 ${seat.id}，用 work_session_open 建立本聊天的工作上下文，后续调用始终带返回的 workSessionId。需要规则时用 work_guide_get；不读取 MindPond 本地文档、不查找 token。读取办公室目标和材料，先报告你的文件访问条件，再开始工作。需要其他工位答复或验收时通过 MCP 发布自包含材料并等待匹配请求/轮次；超时不算完成。遵守办公室截止和迭代预算，条件不足则报告阻塞。`;
    detail.append(
      make(
        'p',
        '把下面这段发给对应聊天，不含凭据。若同一分工已有工作会话，应明确恢复它的编号，不另抢角色。'
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
    const r = await api('material', { materialId: id, number });
    const n = el('officeDetail');
    n.hidden = false;
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
    let record = await api('view', { officeId: state.office.office.id, ...query, offset: 0 }),
      text = record.content;
    const digest = record.sha256;
    while (record.nextOffset !== null) {
      record = await api('view', {
        officeId: state.office.office.id,
        ...query,
        offset: record.nextOffset
      });
      if (record.sha256 !== digest) throw Error('记录在分页中发生变化，请重新读取。');
      text += record.content;
    }
    showDetail(title, JSON.parse(text));
  }
  async function more(kind) {
    const field = kind === 'items' ? 'itemsAfterId' : 'materialsAfterId',
      cursor = kind === 'items' ? state.itemsCursor : state.materialsCursor;
    const result = await api('view', {
      officeId: state.office.office.id,
      [field]: cursor,
      afterSeq: state.cursor
    });
    state.office[kind] = [
      ...new Map([...state.office[kind], ...result[kind]].map((r) => [r.id, r])).values()
    ];
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
    const n = el('officeDetail');
    n.hidden = false;
    n.replaceChildren(make('h3', title), make('pre', JSON.stringify(data, null, 2)));
  }
  function renderEvents() {
    const box = el('officeTimeline');
    box.replaceChildren();
    for (const e of [...state.events].reverse()) {
      const n = make('article');
      n.className = 'office-event';
      n.append(
        make('b', `${seatName(e.seat_id)} · ${kinds[e.kind] ?? e.kind}`),
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
      box.append(n);
    }
    if (!state.events.length) box.append(make('p', '等待第一条真实事件。不会播放模拟工作动画。'));
  }
  function animate(events) {
    if (document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const svg = el('officeWires');
    svg.replaceChildren();
    const ns = 'http://www.w3.org/2000/svg',
      stage = el('officeStage').getBoundingClientRect();
    for (const e of events.slice(-8)) {
      const from = [...el('officeDesks').children].find((n) => n.dataset.seat === e.seat_id),
        to = [...el('officeDesks').children].find((n) => n.dataset.seat === e.body.recipient);
      from?.classList.add('is-live');
      if (!from || !to) continue;
      const a = from.getBoundingClientRect(),
        b = to.getBoundingClientRect(),
        x = a.left + a.width / 2 - stage.left,
        y = a.top - stage.top,
        xx = b.left + b.width / 2 - stage.left,
        yy = b.top - stage.top;
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', `M ${x} ${y} C ${x} ${y - 35}, ${xx} ${yy - 35}, ${xx} ${yy}`);
      svg.append(path);
    }
    setTimeout(() => svg.replaceChildren(), 2200);
  }
  async function updateOffice() {
    if (!state.office || state.loading) return;
    state.loading = true;
    try {
      const data = await api('view', { officeId: state.office.office.id, afterSeq: state.cursor });
      const isLive = !state.office.hasMore && !data.hasMore;
      const old = state.office;
      state.office = {
        ...data,
        items: [...new Map([...old.items, ...data.items].map((r) => [r.id, r])).values()],
        materials: [
          ...new Map([...old.materials, ...data.materials].map((r) => [r.id, r])).values()
        ]
      };
      if (!state.itemsPaged) state.itemsCursor = data.nextItemsAfterId;
      if (!state.materialsPaged) state.materialsCursor = data.nextMaterialsAfterId;
      state.cursor = data.nextCursor;
      state.events = [...state.events, ...data.events].slice(-500);
      renderOffice();
      if (isLive) animate(data.events);
    } finally {
      state.loading = false;
    }
  }
  function schedule() {
    clearTimeout(state.poll);
    state.poll = setTimeout(async () => {
      if (state.logged && !document.hidden) {
        try {
          const data = await api('state');
          state.data = data;
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
          await updateOffice();
          if (state.pollFailed) {
            notice('观察连接已恢复。历史记录已继续同步。');
            state.pollFailed = false;
          }
        } catch (error) {
          state.pollFailed = true;
          el('officeSync').textContent = '观察连接中断 · 正在重试，保留上次状态';
        }
      }
      schedule();
    }, 2500);
  }
  function submit(id, fn) {
    el(id).addEventListener('submit', (e) => {
      e.preventDefault();
      run(() => fn(new FormData(e.currentTarget)), e.submitter);
    });
  }
  submit('officeLogin', async (data) => {
    await api('login', Object.fromEntries(data));
    el('officeLogin').reset();
    await refresh();
    notice('用户管理已连接。按四步引导完成设置。');
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
    const seats = [...el('officeSeatRows').children].map((n) => ({
      id: n.dataset.id,
      agentId: n.querySelector('[name=agent]').value,
      label: n.querySelector('[name=label]').value,
      role: n.querySelector('[name=role]').value
    }));
    if (!seats.length || seats.some((s) => !s.agentId))
      throw Error('请先接入至少一个 active agent，再安排工位。');
    const id = state.editing?.id ?? 'office-' + uuid();
    await api('office', {
      id,
      ...(data.get('projectId') ? { projectId: data.get('projectId') } : {}),
      title: data.get('title'),
      goal: data.get('goal'),
      acceptance: data.get('acceptance'),
      expectedRevision: state.editing?.revision ?? 0,
      state: 'active',
      deadline: new Date(data.get('deadline')).getTime(),
      maxRounds: Number(data.get('maxRounds')),
      seats
    });
    state.editing = null;
    el('officeRoomForm').reset();
    el('officeSeatRows').replaceChildren();
    await refresh();
    await openOffice(id);
    notice('办公室已保存。点击工位获取对应聊天的启动提示词。');
  });
  el('officeAddSeat').onclick = () => addSeat();
  el('officeRefresh').onclick = () =>
    run(async () => {
      await refresh();
      await updateOffice();
    });
  el('officeLogout').onclick = () =>
    run(async () => {
      await api('logout');
      state.logged = false;
      clearTimeout(state.poll);
      state.data = null;
      state.office = null;
      state.events = [];
      el('officeLogin').hidden = false;
      el('officeSettings').hidden = true;
      el('officeView').hidden = true;
      el('officeLoginStatus').textContent = '已退出管理';
      el('officeAgentList').replaceChildren();
      el('officeRoomList').replaceChildren();
      notice('已退出管理。');
    });
  el('officeRoomForm').elements.deadline.value = new Date(
    Date.now() + 24 * 3600000 - new Date().getTimezoneOffset() * 60000
  )
    .toISOString()
    .slice(0, 16);
  window.addEventListener('pagehide', () => clearTimeout(state.poll));
  api('state')
    .then(async () => {
      await refresh();
      schedule();
    })
    .catch(() => {});
})();
