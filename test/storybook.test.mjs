import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPage, runBook } from '../lib/storybook.mjs';

// 모든 side-effect dep을 스텁으로 주입. 호출 순서를 calls에 이름으로 기록.
function stubDeps(overrides = {}) {
  const calls = [];
  const rec = (name) => async () => { calls.push(name); return `${name}.out`; };
  return { calls, deps: {
    generateIllustration: rec('illu'), generateVideo: rec('vid'),
    generateNarration: rec('narr'), composeClip: rec('compose'), concatClips: rec('concat'),
    uploadInput: () => { calls.push('upload'); return 'in.png'; },
    freeMemory: async () => { calls.push('free'); },
    ...overrides,
  } };
}

const genPage = (over = {}) => ({
  id: 'p1', text: 't', illustrationPrompt: 'ip', motionPrompt: 'mp', seed: 1,
  illustrationSource: 'generate', videoSource: 'generate', audioSource: 'generate',
  illustrationFile: null, videoFile: null, audioFile: null,
  ...over,
});

test('runPage all-generate: freeMemory before narration and illustration hop uploaded', async () => {
  const { calls, deps } = stubDeps();
  const page = genPage();
  await runPage(page, { characterRef: null, bookDir: '/tmp/book' }, deps);

  assert.ok(calls.indexOf('free') < calls.indexOf('narr'), 'free before narr');
  assert.ok(calls.includes('upload'), 'illustration hop uploaded');
  assert.equal(page.status, 'done');
});

test('runPage: characterRef is hopped via uploadInput', async () => {
  const uploadArgs = [];
  const { deps } = stubDeps({
    uploadInput: (localPath, destName) => { uploadArgs.push(localPath); return destName ?? 'in.png'; },
  });
  const page = genPage();
  await runPage(page, { characterRef: '/refs/hero.png', bookDir: '/tmp/book' }, deps);

  assert.ok(uploadArgs.some((a) => String(a).includes('/refs/hero.png')), 'characterRef hopped');
});

test('runPage: illustration=upload + video=generate + audio=none', async () => {
  const { calls, deps } = stubDeps();
  const page = genPage({
    illustrationSource: 'upload', illustrationFile: '/up/illu.png',
    videoSource: 'generate', audioSource: 'none',
  });
  await runPage(page, { characterRef: null, bookDir: '/tmp/book' }, deps);

  assert.ok(!calls.includes('illu'), 'no illustration generation');
  assert.ok(calls.includes('upload'), 'illustration still hopped');
  assert.ok(calls.includes('vid'), 'video generated');
  assert.ok(!calls.includes('narr'), 'no narration');
  assert.equal(page.status, 'done');
});

test('runPage: video=generate but no illustration → rejects /illustration/', async () => {
  const { deps } = stubDeps();
  const page = genPage({
    illustrationSource: 'upload', illustrationFile: null,
    videoSource: 'generate',
  });
  await assert.rejects(
    () => runPage(page, { characterRef: null, bookDir: '/tmp/book' }, deps),
    /illustration/,
  );
});

test('runBook: middle page error is isolated, book continues', async () => {
  const attempted = [];
  const { deps } = stubDeps({
    generateIllustration: async (page) => {
      attempted.push(page.id);
      if (page.id === 'p2') throw new Error('boom on p2');
      return 'illu.out';
    },
  });
  const persisted = [];
  const book = {
    dir: '/tmp/book',
    pages: [genPage({ id: 'p1' }), genPage({ id: 'p2' }), genPage({ id: 'p3' })],
  };
  await runBook(book, { persist: (b) => persisted.push(b.pages.map((p) => p.status)) }, deps);

  assert.deepEqual(attempted, ['p1', 'p2', 'p3'], 'all pages attempted in order');
  assert.deepEqual(book.pages.map((p) => p.status), ['done', 'error', 'done']);
  assert.match(book.pages[1].error, /boom on p2/);
  assert.equal(book.status, 'error');
  assert.ok(persisted.length > 0, 'persist called');
});

test('runBook: all success → concat called and book done', async () => {
  const { calls, deps } = stubDeps();
  const book = {
    dir: '/tmp/book',
    pages: [genPage({ id: 'p1' }), genPage({ id: 'p2' })],
  };
  await runBook(book, { persist: () => {} }, deps);

  assert.ok(calls.includes('concat'), 'concat called');
  assert.equal(book.status, 'done');
});
