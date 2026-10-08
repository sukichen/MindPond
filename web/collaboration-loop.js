'use strict';
// Read-only live projection; refreshing it never replaces an editable form.
const loopView = (() => {
  const projections = new WeakMap();
  const text = (tag, value, className) => {
    const element = document.createElement(tag);
    element.textContent = value ?? '';
    if (className) element.className = className;
    return element;
  };
  const labels = {open:'待领取',claimed:'正在处理',submitted:'等待验证',blocked:'需要处理反馈',completed:'已完成',cancelled:'已取消',pending:'验证进行中',passed:'验证通过',changes_requested:'需要修改',superseded:'材料已更新',waiting:'挂起等待',timeout:'等待窗口结束',matched:'已收到回复',failed:'等待中断',expired:'等待连接已过期'};
  const label = value => labels[value] ?? value;
  const time = value => new Date(value).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const waitText = wait => `${wait.principal} · ${label(wait.state)} · ${wait.conditions.until === 'verification_result' ? '验证结果' : wait.conditions.until === 'iteration_submitted' ? '下一轮代码' : '协作消息'} · ${time(wait.startedAt)} → ${time(wait.expiresAt)}`;
  function steps(task) {
    const row = text('div', '', 'loop-steps');
    const current = task.status === 'completed' ? 3 : task.status === 'submitted' ? 2 : task.status === 'claimed' || task.status === 'blocked' ? 1 : 0;
    ['交接','编写 / 修正','等待验证','完成'].forEach((name, index) => {
      const element = text('span', name, index === current ? 'current' : index < current ? 'done' : '');
      row.append(element);
    });
    return row;
  }
  function renderActivity(data, open) {
    const root = document.getElementById('activityTasks');
    root.replaceChildren();
    document.getElementById('activityTime').textContent = `更新于 ${time(data.serverTime)}`;
    document.getElementById('activityConnection').textContent = '实时观察中';
    if (!data.tasks.length) root.append(text('p','尚无可见的协作任务。Agent 发布任务后会在这里出现。','muted'));
    for (const task of data.tasks) {
      const card = text('article', '', 'loop-card');
      const head = text('div', '', 'loop-card-head');
      head.append(text('h3', task.title), text('span', label(task.status), `loop-status status-${task.status}`));
      card.append(head, text('p', `${task.recipient} 编写 / 处理 → ${task.reviewer} 验证`, 'muted'), steps(task));
      if (task.currentIteration) {
        const round = task.currentIteration;
        card.append(text('p', `第 ${round.number} 轮 · ${label(round.state)}`), text('code', round.codeVersion, 'loop-code'));
        if (round.result) card.append(text('p', round.result.summary, 'loop-result'));
      }
      for (const wait of task.waits) card.append(text('p', waitText(wait), 'loop-wait'));
      const button = text('button','查看过程与证据');button.type='button';button.onclick=()=>open(task.taskId);card.append(button);
      root.append(card);
    }
    const incoming = document.getElementById('incomingWaits');
    incoming.replaceChildren();
    for (const wait of data.incomingWaits) incoming.append(text('p', waitText(wait), 'loop-wait'));
  }
  function renderThread(root, thread) {
    const activeWaits = thread.waits.filter(w => w.state === 'waiting');
    const stamp = JSON.stringify([thread.task.status,thread.maxIterations,thread.iterations.map(round=>[round.roundId,round.state,round.finishedAt]),activeWaits]);
    if(projections.get(root)===stamp)return;
    projections.set(root,stamp);
    const openEvidence = new Set([...root.querySelectorAll('details[open]')].map(details=>details.dataset.evidenceKey));
    root.replaceChildren(text('h3', '编写与验证的迭代过程'), steps(thread.task));
    if (!thread.iterations.length) root.append(text('p','尚未提交代码迭代。处理者领取任务后，可提交明确代码版本，由验收者验证。','muted'));
    root.append(text('p', `已提交 ${thread.iterations.length} / ${thread.maxIterations} 轮；提交后等待对应结果，超时仍是等待。`, 'muted'));
    for (const wait of activeWaits) root.append(text('p',waitText(wait),'loop-wait'));
    const rounds = text('div', '', 'loop-rounds');
    for (const round of [...thread.iterations].reverse()) {
      const card = text('article', '', `loop-round round-${round.state}`);
      const head = text('div', '', 'loop-card-head');
      head.append(text('strong', `第 ${round.number} 轮`), text('span',label(round.state),'loop-status'));
      card.append(head, text('code',round.codeVersion,'loop-code'), text('p',round.summary), text('p',`代码引用：${round.artifactRef}`,'muted'));
      if (round.result) {
        card.append(text('p',round.result.summary,'loop-result'));
        for (const [index,evidence] of (round.result.evidence ?? []).entries()) {
          const details = document.createElement('details');
          details.dataset.evidenceKey=round.roundId+':'+index;
          details.open=openEvidence.has(details.dataset.evidenceKey);
          details.append(text('summary',evidence.label),text('pre',evidence.content));
          if (evidence.source) details.append(text('p',evidence.source,'muted'));
          card.append(details);
        }
      }
      rounds.append(card);
    }
    root.append(rounds);
  }
  return {renderActivity,renderThread,label};
})();
