/* Human control and evidence views. Never treat a reported capability as a live host. */
(() => {
    'use strict';
    const node = (tag, text) => { const n = document.createElement(tag); if (text !== undefined)
        n.textContent = text; return n; };
    function mount({ getState, api: request, run, showDetail, showMaterial, setRoomTab, notice, confirmAction, download, fitScene }) {
        async function api(...args) { const { authEpoch, generation } = getState(); const data = await request(...args); if (!getState().logged || getState().authEpoch !== authEpoch || getState().generation !== generation)
            throw Error('当前页面或登录已变化，请重新打开。'); return data; }
        const button = (title, fn) => { const b = node('button', title); b.type = 'button'; b.onclick = () => run(fn); return b; };
        const panel = node('section');
        panel.id = 'officeEvidencePanel';
        panel.dataset.roomPanel = '';
        panel.hidden = true;
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', 'officeTabEvidence');
        panel.className = 'office-evidence';
        panel.append(node('h3', '协作与经验'));
        const toolbar = node('div');
        toolbar.className = 'office-toolbar';
        const body = node('div'), status = node('p');
        status.setAttribute('role', 'status');
        const tab = button('协作与经验', async () => { setRoomTab(panel.id); await refresh(true); });
        tab.id = 'officeTabEvidence';
        tab.dataset.roomTab = panel.id;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-controls', panel.id);
        tab.setAttribute('aria-selected', 'false');
        tab.tabIndex = -1;
        document.querySelector('.office-workspace-tabs').append(tab);
        document.getElementById('officeView').append(panel);
        let mode = 'progress', version = 0, sourceMessage = null, sourceOffice = null;
        const room = () => getState().office?.office.id;
        async function openMemory(officeId, recordId) { const data = await api('learning-memory', { officeId, recordId }); const memory = data.memory, p = data.record.payload; showDetail('记忆与来源', { ...data, body: '## ' + p.title + '\n\n' + (memory?.content ?? '记忆已不可用') + '\n\n### 本次使用证据\n' + p.evidence + '\n\n### 来源与版本\n' + (memory?.sourceRefs ?? []).map(r => '- ' + r.uri + ' · ' + (r.revision ?? '未指定版本')).join('\n') + '\n\n归属：' + (memory?.domain?.kind ?? '未知') + ' / ' + (memory?.domain?.id ?? '未知') + '。办公室成员资格不授予私人记忆权限。' }); }
        async function renderRecords(officeId, kind) {
            const ticket = version, data = await api('records', { officeId, kind, ...(sourceMessage ? { messageId: sourceMessage } : {}) });
            if (room() !== officeId || ticket !== version || !getState().logged)
                return;
            body.replaceChildren();
            if (kind === 'learning' && data.records.length) {
                const map = node('div');
                map.className = 'office-memory-map';
                map.setAttribute('aria-label', '角色与获授权记忆的关联');
                for (const r of data.records) {
                    const edge = node('div');
                    edge.className = 'office-memory-edge';
                    const role = (getState().data?.choices?.roles??getState().data?.characters?.roles)?.find(p => p.id === r.role_id);
                    edge.append(node('span', role?.name ?? '角色不可用'), node('span', '→'), button(r.payload.title, () => openMemory(officeId, r.id)));
                    map.append(edge);
                }
                body.append(map);
                const recorded = data.records.filter(r => r.payload.reuseEvidence?.level === 'recorded_use_report').length;
                body.append(node('p', `本页 ${data.records.length} 条经验记录，其中 ${recorded} 条关联检索与使用反馈回执。其他记录为角色陈述；保存数量不代表收益。`));
            }
            const draw = (records) => {
                for (const r of records) {
                    const p = r.payload, card = node('article');
                    card.className = 'office-item';
                    card.append(node('h4', p.title), node('small', new Date(r.created_at).toLocaleString()));
                    if (kind === 'marker')
                        card.append(node('small', '判断纪要 · 正式验收以任务记录为准'));
                    if (kind === 'marker' && p.assessment) {
                        const {status,counts,taskAcceptance,reasons}=p.assessment;
                        card.append(node('p',({hold:'暂缓',pending:'待核验',ready:'已满足放行检查'})[status]+
                            ' · 已标记 '+counts.total+' 项 · 记录时已正式验收 '+taskAcceptance.accepted+' 项'));
                        const list=node('ul');
                        for(const reason of reasons)
                            list.append(node('li',[reason.title,reason.criterion,reason.observation,reason.code].filter(Boolean).join(' · ')));
                        if(reasons.length)card.append(list);
                        if(p.note)card.append(node('p','补充备注 · '+p.note));
                    }
                    if (p.summary)
                        card.append(window.MindPondOfficeMarkdown.render(p.summary));
                    if (kind === 'learning') {
                        card.classList.add('office-learning-node');
                        card.dataset.memory = p.memoryId;
                        card.append(node('p', ({ saved: '报告已沉淀', used: '报告本次引用', rejected: '报告本次不适用', revised: '报告已修订' })[p.outcome] + ' · ' + (p.freshness === 'changed' ? '来源已有变化，请复核' : '记录时版本一致')), node('p', p.preview), node('p', '使用证据：' + p.evidence));
                        if (p.measurements)
                            card.append(node('p', '宿主报告的用量/耗时：' + JSON.stringify(p.measurements)));
                        card.append(button('查看记忆与来源', () => openMemory(officeId, r.id)));
                    }
                    if (kind === 'handoff') {
                        card.append(node('p', [p.repository, p.branch, p.commit].filter(Boolean).join(' · ')));
                        for (const [key, label] of [['checks', '已验证'], ['unresolved', '待解决'], ['nextSteps', '接下来']]) {
                            card.append(node('strong', label));
                            const list = node('ul');
                            for (const item of p[key] ?? [])
                                list.append(node('li', item));
                            card.append(list);
                        }
                    }
                    if (kind === 'handoff' || kind === 'progress') {
                        for (const materialId of p.materialIds ?? [])
                            card.append(button('查看材料 ' + materialId.slice(0, 8), () => showMaterial(materialId, 0)));
                    }
                    if (p.messageId)
                        card.append(button('相关讨论', async () => showDetail('来源消息', (await api('message', { officeId, messageId: p.messageId })).message)));
                    card.append(button('完整证据记录', async () => showDetail('协作记录', p)));
                    body.append(card);
                }
            };
            draw(data.records);
            if (!data.records.length) {
                const empty={learning:sourceMessage?'这条消息还没有关联的经验记录。':'还没有经验记录。保存或复用经验后，可用 office_record 关联来源。',
                    progress:'还没有共享进展。角色可用 office_record 发布进展并附材料。',
                    handoff:'还没有成果交接。角色可用 office_record 保存版本、验证结果、待解决项与下一步。',
                    marker:'还没有判断纪要。',presence:'还没有角色状态报告。'};
                body.append(node('p', empty[kind]));
            }
            let cursor = data.nextAfterId;
            const more = button('加载更多', async () => { const next = await api('records', { officeId, kind, afterId: cursor, ...(sourceMessage ? { messageId: sourceMessage } : {}) }); if (room() !== officeId || ticket !== version || !getState().logged)
                return; draw(next.records); cursor = next.nextAfterId; more.hidden = !next.hasMore; });
            more.hidden = !data.hasMore;
            body.append(more);
        }
        async function refresh(force = false) {
            if (!room() || (!force && panel.hidden))
                return;
            const officeId = room(), ticket = ++version;
            if (sourceOffice !== officeId) sourceMessage = null;
            status.textContent = '正在读取…';
            if (mode === 'relations') {
                const data = await api('relations', { officeId });
                if (ticket !== version || officeId !== room())
                    return;
                body.replaceChildren(node('p','按发送时间查看最多 100 条未归档消息，包含通知和反馈。'));
                for (const w of data.waiting) {
                    const card = node('article');
                    card.className = 'office-item';
                    card.append(node('strong', `${w.sender_name} → ${w.recipient_name}`), node('p', (w.state === 'processing' ? '处理中' : '尚待领取') + ` · 已经过 ${Math.floor(w.elapsedMs / 60000)} 分钟`), button('打开相关消息', async () => showDetail('未归档消息', (await api('message', { officeId, messageId: w.id })).message)));
                    body.append(card);
                }
                if (!data.waiting.length)
                    body.append(node('p', '当前没有未归档的办公室消息。'));
            }
            else if (mode === 'context') {
                const data = await api('handoff-context', { officeId });
                if (ticket !== version || officeId !== room())
                    return;
                body.replaceChildren(node('p', '交接前核对当前代码/材料版本。以下快照可下载给有权访问该办公室的参与者。'), node('pre', JSON.stringify(data, null, 2)), button('下载交接上下文', async () => download(JSON.stringify(data, null, 2), 'office-context.json')));
            }
            else
                await renderRecords(officeId, mode);
            if (ticket === version)
                status.textContent = '读取于 ' + new Date().toLocaleTimeString() + ' · 手动刷新保留阅读位置';
        }
        function selectMode(next) {
            mode = next;
            for(const item of toolbar.querySelectorAll('[data-record-mode]'))
                item.setAttribute('aria-pressed',String(item.dataset.recordMode===mode));
        }
        for (const [key, label] of [['progress', '共享进展'], ['relations', '未归档消息'], ['handoff', '成果交接'], ['learning', '经验与复用'], ['marker', '判断纪要'], ['presence', '位置与状态报告'], ['context', '交接上下文']]) {
            const item = button(label, async () => { selectMode(key); sourceMessage = null; await refresh(true); });
            item.dataset.recordMode = key;
            item.setAttribute('aria-pressed', String(key === mode));
            toolbar.append(item);
        }
        toolbar.append(button('刷新', () => refresh(true)), button('导出协作记录', async () => {
            const officeId = room(), sections = {};
            let snapshotId, snapshotAt, sha256;
            if (!await confirmAction('导出消息、文本材料、事件、容器、交接、布局和工位档案到本机？完整恢复请使用数据库与附件备份集合；运行状态页的备份只包含数据库。'))
                return;
            for (const section of ['office', 'seats', 'messages', 'materials', 'events', 'containers', 'handoffs', 'layouts', 'seatArchive']) {
                const rows = [];
                let offset = 0;
                for (let page = 0; page < 1000; page++) {
                    const result = await api('export', { officeId, section, offset, ...(snapshotId ? { snapshotId } : {}) });
                    snapshotId = result.snapshotId;
                    snapshotAt = result.snapshotAt;
                    sha256 = result.sha256;
                    if (room() !== officeId)
                        return;
                    rows.push(...result.rows);
                    if (result.nextOffset === null) {
                        sections[section] = rows;
                        break;
                    }
                    offset = result.nextOffset;
                }
                if (!sections[section])
                    throw Error('导出过大，请缩小办公室资料范围。');
            }
            download(JSON.stringify({ version: 'mindpond.office-export.v2', officeId, snapshotId, snapshotAt, sha256, exportedAt: new Date().toISOString(), sections }, null, 2), 'mindpond-office-export.json');
        }));
        panel.append(toolbar, status, body);
        async function inspectRole(roleId) {
            const data = await api('permissions', { roleId });
            const host = data.host ? JSON.parse(data.host.payload) : null;
            const lines = ['## ' + data.role.name, '### 办公室成员关系', ...data.offices.map(o => '- ' + (o.officeTitle??(getState().data?.choices?.offices??getState().data?.offices)?.find(r=>r.id===o.office_id)?.title??o.office_id) + ' · ' + (o.enabled ? '已启用' : '已移除') + ' · ' + ({worker:'处理事项',reviewer:'核对与反馈',observer:'观察与记录'}[o.role]??o.role)), '### 记忆访问规则', data.knowledgePolicy?.description??'绑定角色后访问该角色记忆和有效成员办公室知识；实际调用还需通过当前连接授权。人类管理页面可查看全部。', '### 运行证据', host ? '- 最近自检宿主：' + host.client + '，实等 ' + (host.measuredWaitMs / 1000).toFixed(1) + ' 秒，' + (host.clientReceived ? '宿主确认收到' : '尚未确认收到') : '- 宿主运行状态未知', '### 用户控制请求', ...(data.controls.length?[]:['- 暂无用户控制请求']), ...data.controls.map(c => '- ' + ({ pause: '暂停', stop: '停止', resume: '恢复' })[c.action] + '：' + ({ requested: '等待宿主确认', acknowledged: '宿主已确认', rejected: '宿主已拒绝' })[c.state] + (c.evidence ? '；' + c.evidence : '')), '### 权限边界', '记忆按角色归属，人类管理页面可查看全部；办公室与文件访问分别授权。文件能力由宿主提供；同账户角色可通信，跨账户授权有方向。'];
            showDetail('权限与运行证据', { body: lines.join('\n') });
            const detail = document.getElementById('officeDetail');
            if (!detail)
                return;
            const tools = node('div');
            tools.className = 'office-toolbar';
            for (const [action, label] of [['pause', '请求暂停'], ['stop', '请求停止'], ['resume', '请求恢复']])
                tools.append(button(label, async () => {
                    if (!await confirmAction(`${label}此角色的宿主？请求会保留“尚未确认”，直到宿主反馈；不会声称已强制关闭进程。`))
                        return;
                    const result = await api('control', { roleId, action, reason: '用户从角色控制面板明确请求' + label });
                    notice(result.notice);
                    await inspectRole(roleId);
                }));
            tools.append(button('刷新运行证据与确认结果', () => inspectRole(roleId)));
            detail.append(tools);
            const recent = getState().office?.facilities?.activity?.find(x => x.roleId === roleId);
            if (recent)
                detail.append(node('p', `当前正在处理 ${recent.processing} 条消息，待处理 ${recent.pending} 条。`));
            detail.append(button('查看办公室通信', async () => setRoomTab('officeMessagePanel')), button('查看材料', async () => setRoomTab('officeMaterialPanel')), button('查看经验与交接', async () => { setRoomTab(panel.id); await refresh(true); }));
        }
        toolbar.append(button('记录当前办公室布局', async () => {
            if (document.getElementById('officeScene').classList.contains('is-replaying'))
                throw Error('请先回到实时办公室，再记录布局。');
            setRoomTab('officeCanvas');
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const stage = document.getElementById('officeScene'), box = stage.getBoundingClientRect(), scale = getState().scene.scale;
            if (box.width <= 0 || box.height <= 0 || scale <= 0)
                throw Error('办公室布局尚未就绪，请稍后重试。');
            const seats = [...document.querySelectorAll('#officeDesks>.office-desk')].map(n => { const r = n.getBoundingClientRect(); return { id: n.dataset.seat, roleId: n.dataset.role || null, x: (r.left - box.left) / scale - stage.clientLeft, y: (r.top - box.top) / scale - stage.clientTop, width: r.width / scale, height: r.height / scale }; });
            await api('layout', { officeId: room(), width: box.width / scale, height: box.height / scale, seats });
            notice('当前工位布局已记录。之后的回放可使用此快照。');
        }));
        const replayFilters = node('div');
        replayFilters.className = 'office-fields';
        const person = node('select'), topic = node('input'), keys = node('input');
        topic.placeholder = '协作话题（可选）';
        topic.maxLength = 200;
        keys.type = 'checkbox';
        for (const [title, control] of [['角色', person], ['话题', topic], ['只看关键决定、成果和经验', keys]]) {
            const label = node('label', title);
            if(control===keys){label.className='office-replay-key-filter';label.replaceChildren(control,node('span',title));}else label.append(control);
            replayFilters.append(label);
        }
        document.getElementById('officeReplayRange').after(replayFilters);
        person.onfocus = () => { const selected = person.value; person.replaceChildren(new Option('全部角色', ''), ...((getState().data?.choices?.roles??getState().data?.characters?.roles) ?? []).map(r => new Option(r.name, r.id))); person.value = selected; };
        person.append(new Option('全部角色', ''));
        let appliedLayout = null, replayBase = null;
        function applyReplayLayout(meta, id) {
            const frame = meta.layouts?.find(l => l.id === id);
            if (!frame) {
                if (appliedLayout)
                    restoreLayout(false);
                return;
            }
            if (appliedLayout === id)
                return;
            appliedLayout = id;
            const desks = document.getElementById('officeDesks'), root = document.getElementById('officeScene');
            root.style.width = frame.width + 'px';
            root.style.height = frame.height + 'px';
            desks.style.position = 'static';
            for (const existing of [...desks.children])
                existing.hidden = true;
            for (const s of frame.seats) {
                let n = [...desks.children].find(n => n.dataset.seat === s.id);
                if (!n) {
                    n = button(s.label, async () => showDetail('历史工位', s));
                    n.className = 'office-desk replay-ghost';
                    n.dataset.seat = s.id;
                    const avatar = node('span');
                    avatar.className = 'office-person';
                    n.append(window.MindPondOfficeScene.props(avatar));
                    desks.append(n);
                }
                n.dataset.role = s.roleId ?? '';
                n.dataset.replayKey = s.roleId ? 'role:' + s.roleId : 'seat:' + s.id;
                n.hidden = false;
                n.style.position = 'absolute';
                n.style.left = s.x + 'px';
                n.style.top = s.y + 'px';
                n.style.width = (s.width ?? 280) + 'px';
                n.style.height = (s.height ?? 290) + 'px';
            }
            document.getElementById('officeSceneStatus').textContent = '历史布局快照 · ' + new Date(frame.at).toLocaleString();
            if(getState().scene.autoFit)requestAnimationFrame(fitScene);
        }
        const parallel = node('details');
        parallel.append(node('summary', '并行处理时间线（来自领取与完成事件）'));
        const lanes = node('div');
        parallel.append(lanes);
        document.getElementById('officeReplayEvents').parentElement.after(parallel);
        function renderParallel(player) {
            appliedLayout = null;
            const root = document.getElementById('officeScene'), desks = document.getElementById('officeDesks');
            replayBase = { root: root.style.cssText, desks: desks.style.cssText, nodes: [...desks.children].map(n => ({ node: n, style: n.style.cssText, hidden: n.hidden, role: n.dataset.role, key: n.dataset.replayKey })) };
            lanes.replaceChildren();
            const events = player.events, starts = new Map(), intervals = [];
            for (const e of events) {
                if (e.kind === 'message_take')
                    starts.set(e.body.messageId, e);
                if (e.kind === 'message_finish') {
                    const first = starts.get(e.body.messageId);
                    if (first)
                        intervals.push({ first, last: e });
                }
            }
            if (!intervals.length) {
                lanes.append(node('p', '所选范围没有同时包含领取与完成的处理区间。没有推测缺失的开始或结束时间。'));
                return;
            }
            const from = Math.min(...intervals.map(r => r.first.ts)), to = Math.max(...intervals.map(r => r.last.ts)), span = Math.max(1, to - from);
            for (const key of new Set(intervals.map(r => r.first.actorKey))) {
                const row = node('div');
                row.className = 'office-parallel-lane';
                row.append(node('strong', player.meta.participants.find(p => p.key === key)?.name ?? key));
                const track = node('div');
                track.className = 'office-parallel-track';
                for (const r of intervals.filter(r => r.first.actorKey === key)) {
                    const bar = button('处理消息', async () => player.seek(events.indexOf(r.first)));
                    bar.style.left = ((r.first.ts - from) / span * 100) + '%';
                    bar.style.width = Math.max(2, (r.last.ts - r.first.ts) / span * 100) + '%';
                    bar.title = new Date(r.first.ts).toLocaleString() + ' → ' + new Date(r.last.ts).toLocaleString();
                    track.append(bar);
                }
                row.append(track);
                lanes.append(row);
            }
        }
        function restoreLayout(clear = true) { appliedLayout = null; if (replayBase) {
            document.getElementById('officeScene').style.cssText = replayBase.root;
            const desks = document.getElementById('officeDesks');
            desks.style.cssText = replayBase.desks;
            for (const n of [...desks.children])
                if (!replayBase.nodes.some(r => r.node === n))
                    n.remove();
            for (const r of replayBase.nodes) {
                r.node.style.cssText = r.style;
                r.node.hidden = r.hidden;
                r.node.dataset.role = r.role;
                r.node.dataset.replayKey = r.key;
            }
        } if (clear)
            replayBase = null; }
        async function deleteImpact(kind, id) {
            const {authEpoch,generation}=getState();
            const data=await api('delete-impact',{kind,id});
            if(!getState().logged||authEpoch!==getState().authEpoch||generation!==getState().generation)return;
            const labels={messages:'消息',materials:'文本材料',containers:'容器',events:'事件',seats:'工位',records:'协作记录',
                discussions:'临时讨论',scripts:'脚本',guidedTasks:'办公室任务',seatItems:'工位档案',seatMessages:'工位历史消息',cancelledSeatItems:'将取消的工位工作项',
                attachments:'待撤销访问的附件',bindings:'聊天绑定',workingCheckpoints:'接续摘要',workingTasks:'角色待办',
                workingHistory:'角色接续历史',roles:'关联角色'};
            const lines=Object.entries(data.counts).filter(([,count])=>count>0).map(([key,count])=>'- '+labels[key]+' '+count);
            if(!lines.length)lines.push('当前没有计数范围内的关联记录。');
            if(kind==='office')lines.push('', '保留 '+data.retainedOfficeMemories+' 条办公室记忆及 '+data.retainedRoleDrafts+' 份待发退会草稿。共享附件访问会立即失效，文件由维护任务回收。');
            if(kind==='role')lines.push('', '角色记忆保留。角色私有附件访问会立即失效，文件由维护任务回收。');
            if(kind==='agent')lines.push('', '删除前会再次检查是否还有关联角色或启用的工位。');
            showDetail('永久删除影响预览',{...data,body:lines.join('\n')});
        }
        const apiObject = { refresh, inspectRole, openLearning: async (messageId) => { sourceMessage = messageId; sourceOffice = room(); selectMode('learning'); setRoomTab(panel.id); await refresh(true); }, deleteImpact, applyReplayLayout, renderParallel, restoreLayout, replayFilters() { return { ...(person.value ? { roleId: person.value } : {}), ...(topic.value.trim() ? { topic: topic.value.trim() } : {}), ...(keys.checked ? { keyOnly: true } : {}) }; }, reset() { version++; sourceMessage = null; body.replaceChildren(); } };
        return apiObject;
    }
    window.MindPondOfficeCollaboration = { mount };
})();
