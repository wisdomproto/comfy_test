import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastFrameArgs, concatVideoArgs } from '../lib/pagevideo.mjs';

test('lastFrameArgs: 컷 끝에서 마지막 프레임 1장 추출 argv', () => {
  const a = lastFrameArgs('cut1.mp4', 'cut1_last.png');
  assert.ok(a.includes('cut1.mp4') && a.includes('cut1_last.png'));
  assert.ok(a.includes('-sseof') && a.includes('-frames:v'));
});

test('concatVideoArgs: 모든 입력 + dest 포함, video-only(a=0) concat', () => {
  const a = concatVideoArgs(['c1.mp4', 'c2.mp4', 'c3.mp4'], 'out.mp4');
  assert.ok(['c1.mp4', 'c2.mp4', 'c3.mp4', 'out.mp4'].every((x) => a.includes(x)));
  assert.ok(a.some((x) => /concat=n=3:v=1:a=0/.test(x)));
});
