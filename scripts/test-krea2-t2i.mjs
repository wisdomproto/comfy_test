// Krea2 Turbo 순수 text-to-image 품질 테스트 (캐릭터 레퍼런스 없음).
import { buildKrea2Illustration } from '../lib/workflows.mjs';
import { runComfyWorkflow } from '../lib/comfyrun.mjs';
import { resolveSeed } from '../lib/seed.mjs';

const DEST = process.argv[2] || 'C:/Users/101024/AppData/Local/Temp/claude/C--projects-comfy-test/96d4eebb-2f5f-4f86-8660-bb4d4e7d35fd/scratchpad/krea2_t2i.png';
const seed = resolveSeed(null);
const prompt = process.argv[3] ||
  'A cozy handmade needle-felted wool miniature diorama: a little wool bunny baker in a tiny apron pulling a tray of miniature felt cupcakes from a warm stone oven, inside a snug felted-wool bakery with tiny jars, a rolling pin and hanging herbs, soft warm morning light streaming through a small round window, extremely detailed fuzzy wool fiber texture, shallow depth of field, warm cinematic lighting, cozy children storybook illustration.';

const wf = buildKrea2Illustration({ prompt, seed, width: 1280, height: 832 });
console.log(`[krea2-t2i] submit seed=${seed}`);
const t0 = Date.now();
const res = await runComfyWorkflow(wf, {
  destPath: DEST,
  onProgress: ({ value, max }) => process.stdout.write(`\r[krea2-t2i] step ${value}/${max}   `),
});
console.log(`\n[krea2-t2i] DONE in ${Math.round((Date.now() - t0) / 1000)}s -> ${res.destPath}`);
