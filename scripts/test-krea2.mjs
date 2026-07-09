// 임시 검증: Krea2 Turbo + Krea2Edit(Identity Edit) — hori.png 캐릭터 레퍼런스로 새 장면 생성.
import * as comfy from '../lib/comfy.mjs';
import { buildKrea2Illustration } from '../lib/workflows.mjs';
import { runComfyWorkflow } from '../lib/comfyrun.mjs';
import { resolveSeed } from '../lib/seed.mjs';

const SRC = 'C:/Users/101024/Downloads/hori.png';
const DEST = process.argv[2] || 'C:/Users/101024/AppData/Local/Temp/claude/C--projects-comfy-test/96d4eebb-2f5f-4f86-8660-bb4d4e7d35fd/scratchpad/hori_playground.png';

const refName = comfy.uploadInput(SRC, 'hori_ref.png');
const seed = resolveSeed(null);
const prompt = process.argv[3] ||
  'Hori the little tiger cub happily playing at a sunny playground, going down a slide with arms raised, joyful laughing expression; cheerful park with swings, green grass and a few trees in the background. Handmade needle-felted wool stop-motion style, soft fuzzy wool texture, cozy warm children storybook illustration, soft warm lighting, same character identity.';

const wf = buildKrea2Illustration({ prompt, characterRefName: refName, seed, width: 1280, height: 832 });
console.log(`[test-krea2] submit — ref=${refName} seed=${seed}`);
const t0 = Date.now();
const res = await runComfyWorkflow(wf, {
  destPath: DEST,
  onProgress: ({ value, max }) => process.stdout.write(`\r[test-krea2] step ${value}/${max}   `),
});
console.log(`\n[test-krea2] DONE in ${Math.round((Date.now() - t0) / 1000)}s -> ${res.destPath}`);
