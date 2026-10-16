/** Exercise real UI request handlers with controlled response ordering. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = await fs.readFile(new URL('../web/office.js', import.meta.url), 'utf8');
function handler(name, next) {
  const start = source.indexOf(`  async function ${name}(`);
  const end = source.indexOf(`  ${next}`, start + 1);
  assert(start >= 0 && end > start);
  return source.slice(start, end);
}
const state = { logged: true, generation: 0, loading: false, opening: false, office: null };
let fetcher, detail;
let timer, renderedCharacters;
const context = vm.createContext({
  state,
  api: (...args) => fetcher(...args),
  el: () => ({ scrollIntoView() {} }),
  renderOffice() {},
  animate() {},
  document: { hidden: false },
  setTimeout(fn) { timer = fn; return 1; },
  clearTimeout() { timer = null; },
  renderCharacters(data) { renderedCharacters = data; },
  refreshSeatChoices() {},
  notice() {},
  window: { matchMedia: () => ({ matches: true }) },
  showDetail: (title, value) => {
    detail = { title, value };
  }
});
vm.runInContext(
  [
    handler('openOffice', 'function seatName'),
    handler('updateOffice', 'function schedule'),
    source.slice(source.indexOf('  function schedule('),source.indexOf('  function submit(')),
    handler('showRecord', 'async function more'),
    source.slice(
      source.indexOf('  function mergeRecords('),
      source.indexOf('  function renderEvents(')
    )
  ].join('\n'),
  context
);
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function page(id, extra = {}) {
  return {
    office: { id },
    items: [],
    materials: [],
    events: [],
    nextCursor: 0,
    hasMore: false,
    ...extra
  };
}
// Open A then B: a late A response must never replace B.
const a = deferred(),
  b = deferred();
fetcher = (_, body) => (body.officeId === 'a' ? a.promise : b.promise);
const openingA = context.openOffice('a'),
  openingB = context.openOffice('b');
b.resolve(page('b'));
await openingB;
a.resolve(page('a'));
await openingA;
assert.equal(state.office.office.id, 'b');
// Polling an old room must not leak its events into the newly selected room.
const oldPoll = deferred();
fetcher = (_, body) => (body.officeId === 'b' ? oldPoll.promise : Promise.resolve(page('c')));
const polling = context.updateOffice();
await context.openOffice('c');
oldPoll.resolve(page('b', { events: [{ seq: 999 }], nextCursor: 999 }));
await polling;
assert.equal(state.office.office.id, 'c');
assert.equal(state.cursor, 0);
assert.equal(state.events.length, 0);
// A loaded record beyond the initial page is included in refresh requests.
state.office.items = [{ id: 'later', revision: 1, status: 'open' }];
state.office.materials = [{ id: 'text', state: 'draft' }];
fetcher = async (_, body) => {
  assert.deepEqual(Array.from(body.itemIds), ['later']);
  assert.deepEqual(Array.from(body.materialIds), ['text']);
  return page('c', {
    items: [{ id: 'later', revision: 2, status: 'completed' }],
    materials: [{ id: 'text', state: 'published' }]
  });
};
await context.updateOffice();
assert.equal(state.office.items[0].status, 'completed');
assert.equal(state.office.materials[0].state, 'published');
const merged = context.mergeRecords(
  [{ id: 'task', revision: 3, status: 'completed' }],
  [{ id: 'task', revision: 2, status: 'submitted' }]
);
assert.equal(merged[0].status, 'completed');
// Non-advancing pagination is rejected, instead of generating an infinite HTTP loop.
let calls = 0;
fetcher = async () => {
  calls++;
  return { offset: 0, content: 'abcdefgh', nextOffset: 8, sha256: 'same' };
};
await assert.rejects(context.showRecord({ roundId: 'round' }, 'Evidence'), /分页未前进/);
assert.equal(calls, 2);
// Well-formed pagination still reads the complete record.
const text = JSON.stringify({ result: 'evidence'.repeat(1600) });
fetcher = async (_, body) => ({
  offset: body.offset,
  content: text.slice(body.offset, body.offset + 8000),
  nextOffset: body.offset + 8000 < text.length ? body.offset + 8000 : null,
  sha256: 'stable'
});
await context.showRecord({ roundId: 'round' }, 'Evidence');
assert.equal(detail.value.result, 'evidence'.repeat(1600));
// Logout invalidates requests already in flight.
const late = deferred();
fetcher = () => late.promise;
const request = context.updateOffice();
state.generation++;
state.logged = false;
state.office = null;
late.resolve(page('c'));
await request;
assert.equal(state.office, null);
// One poll must BOTH advance the role cursor and render new applications.
state.logged = true; state.authEpoch = 0;
state.data = { characters: { revision: 1, pending: [] } };
context.el = () => ({ querySelectorAll: () => [] });
context.updateOffice = async () => {};
fetcher = async () => ({ agents: [], characters: { revision: 2, pending: [{ id: 'new' }] } });
context.schedule(); await timer();
assert.equal(renderedCharacters?.pending[0]?.id, 'new', 'poll must render newly arrived applications');
// An in-flight response must not overwrite edits or consume their revision.
const editPoll = deferred(); fetcher = () => editPoll.promise;
context.schedule(); const editing = timer(); state.roleEditing = true;
editPoll.resolve({ agents: [], characters: { revision: 3, pending: [] } });
await editing;
assert.equal(state.data.characters.revision, 2, 'paused edits leave newer state available for refresh');
state.roleEditing = false;
fetcher = async () => ({ agents: [], characters: { unchanged: true, revision: 2 } });
context.schedule(); await timer();
assert.equal(state.data.characters.pending[0].id, 'new', 'unchanged snapshots preserve full prior data');
// Logout invalidates the registry poll as well as the selected-office poll.
const lateRegistry = deferred(); fetcher = () => lateRegistry.promise;
context.schedule(); const pendingRegistry = timer();
state.authEpoch++; state.logged = false; state.data = null; timer = null;
lateRegistry.resolve({ agents: [], characters: { revision: 99, pending: [] } });
await pendingRegistry;
assert.equal(state.data, null);
assert.equal(timer, null, 'an expired poll cannot restart a timer after logout');
console.log(
  'PASS office UI: reversed opens, room-switch polling, loaded-page refresh, bounded detail pagination, logout fencing'
);
