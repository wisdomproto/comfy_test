// 동화책 페이지 한 편 생성 (재사용 CLI):
//   node scripts/make-page.mjs <page-spec.json>
// page-spec.json:
// {
//   "startImage": "C:/.../p1.png",
//   "cuts": ["motion prompt 1", "motion prompt 2", "motion prompt 3"],
//   "narrationText": "페이지 대본...",
//   "voice": { "profileId": "..." }              // 이미 만든 복제 프로필
//        OR  { "name":"narrator", "refAudioPath":"C:/.../ref.mp3", "refText":"참조 대본" },
//   "dest": "C:/.../hori_page1_final.mp4",
//   "upscale": "1080",       // 'none'|'2x'|'1080' (기본 1080)
//   "tmpDir": "C:/.../work"  // 선택. 기본 dest 옆 .work
// }
import fs from 'node:fs';
import path from 'node:path';
import { generatePageVideo } from '../lib/pagevideo.mjs';
import * as vb from '../lib/voicebox.mjs';
import { muxPageClip } from '../lib/compose.mjs';

const specPath = process.argv[2];
if (!specPath) { console.error('usage: node scripts/make-page.mjs <page-spec.json>'); process.exit(1); }
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const { startImage, cuts, narrationText, voice, dest, upscale = '1080' } = spec;
const tmpDir = spec.tmpDir || path.join(path.dirname(dest), '.work_' + path.basename(dest, path.extname(dest)));
fs.mkdirSync(path.dirname(dest), { recursive: true });

async function main() {
  if (!(await vb.isAlive())) throw new Error('Voicebox not running (http://127.0.0.1:17493)');

  // 1) 영상 (N컷 체이닝 + 업스케일)
  console.log(`[page] video: ${cuts.length} cut(s), upscale=${upscale}`);
  const t0 = Date.now();
  const videoPath = path.join(tmpDir, 'page_video.mp4');
  await generatePageVideo({
    startImage, cuts, dest: videoPath, tmpDir, upscale,
    onProgress: ({ cut, total, value, max }) => process.stdout.write(`\r[page] cut ${cut}/${total} step ${value}/${max}   `),
  });
  console.log(`\n[page] video done (${Math.round((Date.now() - t0) / 1000)}s)`);

  // 2) 내레이션 (복제 프로필)
  const engine = 'qwen';
  await vb.ensureModel({ modelName: 'qwen-tts-1.7B' });
  const profileId = voice.profileId || await vb.ensureProfile({
    name: voice.name, refAudioPath: voice.refAudioPath, refText: voice.refText, language: 'ko', engine,
  });
  console.log(`[page] narration: profile=${profileId}`);
  const wavPath = path.join(tmpDir, 'narration.wav');
  await vb.generate({ profileId, text: narrationText, language: 'ko', engine, modelSize: '1.7B' }, wavPath);

  // 3) 합성 (오디오 길이에 영상 맞춤)
  await muxPageClip({ video: videoPath, audio: wavPath, dest });
  console.log(`[page] DONE -> ${dest}`);
}

main().catch((e) => { console.error('[page] ERROR', e.message); process.exit(1); });
