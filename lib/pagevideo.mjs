// 페이지 영상: 5초 컷 여러 개를 "마지막 프레임 → 다음 시작 이미지" 체이닝으로
// 연속 영상으로 생성 후 이어붙임. Wan 2.2 14B GGUF + 업스케일(buildWan22I2V14B).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as comfy from './comfy.mjs';
import { runComfyWorkflow } from './comfyrun.mjs';
import { buildWan22I2V14B } from './workflows.mjs';
import { resolveSeed } from './seed.mjs';

// ── 순수 ffmpeg argv 빌더 (단위 테스트 대상) ──
// 컷 끝(0.08s 전)에서 마지막 프레임 1장 추출
export const lastFrameArgs = (video, png) =>
  ['-y', '-sseof', '-0.08', '-i', video, '-update', '1', '-frames:v', '1', '-q:v', '2', png];

// 무음 컷들을 video-only로 이어붙임 (filter_complex concat, list-file 없음)
export const concatVideoArgs = (clips, dest) => {
  const args = ['-y'];
  for (const c of clips) args.push('-i', c);
  args.push('-filter_complex', `concat=n=${clips.length}:v=1:a=0[outv]`, '-map', '[outv]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', dest);
  return args;
};

const runFfmpeg = (args) => new Promise((res, rej) => {
  const p = spawn('ffmpeg', args, { stdio: 'ignore' });
  p.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exit ${c}`))));
  p.on('error', rej);
});

/**
 * 페이지 영상 생성 (N컷 체이닝).
 * @param {object} o
 * @param {string} o.startImage 첫 컷 시작 이미지 경로
 * @param {string[]} o.cuts 컷별 모션 프롬프트 배열 (>=1)
 * @param {string} o.dest 최종 연속 영상 경로 (.mp4)
 * @param {string} o.tmpDir 중간 파일 디렉토리 (컷/프레임)
 * @param {string} [o.upscale='1080'] 'none'|'2x'|'1080'
 * @param {number} [o.width=832] @param {number} [o.height=480] @param {number} [o.frames=81] @param {number} [o.fps=16]
 * @param {function} [o.onProgress] ({cut,total,value,max})
 * @returns {Promise<{dest:string, cutFiles:string[]}>}
 */
export async function generatePageVideo({
  startImage, cuts, dest, tmpDir,
  upscale = '1080', width = 832, height = 480, frames = 81, fps = 16, onProgress = () => {},
}) {
  if (!startImage) throw new Error('startImage is required');
  if (!Array.isArray(cuts) || cuts.length === 0) throw new Error('cuts must be a non-empty array');
  fs.mkdirSync(tmpDir, { recursive: true });

  const cutFiles = [];
  let startImg = startImage;
  for (let i = 0; i < cuts.length; i++) {
    const inputName = comfy.uploadInput(startImg, `pv_cut${i + 1}_start_${path.basename(tmpDir)}.png`);
    const seed = resolveSeed(null);
    const wf = buildWan22I2V14B({ imageName: inputName, motionPrompt: cuts[i], seed, width, height, frames, fps, upscale });
    const cutDest = path.join(tmpDir, `cut${i + 1}.mp4`);
    await runComfyWorkflow(wf, {
      destPath: cutDest,
      onProgress: ({ value, max }) => onProgress({ cut: i + 1, total: cuts.length, value, max }),
    });
    cutFiles.push(cutDest);
    if (i < cuts.length - 1) {
      // 다음 컷 시작 = 이 컷의 마지막 프레임. 업스케일된 해상도를 이어가려 업스케일 영상에서 추출.
      startImg = path.join(tmpDir, `cut${i + 1}_last.png`);
      await runFfmpeg(lastFrameArgs(cutDest, startImg));
    }
  }

  if (cutFiles.length === 1) {
    fs.copyFileSync(cutFiles[0], dest);
  } else {
    await runFfmpeg(concatVideoArgs(cutFiles, dest));
  }
  return { dest, cutFiles };
}
