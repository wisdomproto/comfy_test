import { test } from 'node:test';
import assert from 'node:assert/strict';
import { muxArgs, concatArgs } from '../lib/compose.mjs';

const joined = (args) => args.join(' ');

test('muxArgs: video shorter than audio → pad(tpad/loop) + video/audio/dest present', () => {
  const args = muxArgs({
    video: 'page1.mp4',
    audio: 'page1.wav',
    audioDur: 5,
    videoDur: 3,
    dest: 'clip1.mp4',
  });
  assert.ok(args.includes('page1.mp4'), 'video path present');
  assert.ok(args.includes('page1.wav'), 'audio path present');
  assert.equal(args[args.length - 1], 'clip1.mp4', 'dest is last arg');
  assert.match(joined(args), /tpad|loop/, 'has pad token');
});

test('muxArgs: video longer than audio → trim signal (-t/-shortest/trim)', () => {
  const args = muxArgs({
    video: 'page2.mp4',
    audio: 'page2.wav',
    audioDur: 2,
    videoDur: 6,
    dest: 'clip2.mp4',
  });
  assert.ok(args.includes('page2.mp4'));
  assert.ok(args.includes('page2.wav'));
  assert.equal(args[args.length - 1], 'clip2.mp4');
  assert.match(joined(args), /(^|\s)-t(\s|$)|-shortest|trim/, 'has trim signal');
});

test('muxArgs: audio=null → video + dest, no .wav / no tpad|loop', () => {
  const args = muxArgs({
    video: 'page3.mp4',
    audio: null,
    videoDur: 4,
    dest: 'clip3.mp4',
  });
  assert.ok(args.includes('page3.mp4'), 'video path present');
  assert.equal(args[args.length - 1], 'clip3.mp4', 'dest is last arg');
  assert.doesNotMatch(joined(args), /\.wav/, 'no audio input');
  assert.doesNotMatch(joined(args), /tpad|loop/, 'no pad token');
});

test('concatArgs: all input clip paths AND dest present', () => {
  const clips = ['clip1.mp4', 'clip2.mp4', 'clip3.mp4'];
  const args = concatArgs(clips, 'final.mp4');
  for (const c of clips) assert.ok(args.includes(c), `${c} present`);
  assert.ok(args.includes('final.mp4'), 'dest present');
  assert.match(joined(args), /concat/, 'uses concat filter');
});
