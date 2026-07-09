// ComfyUI 모델 다운로드 스크립트: MANIFEST의 파일들을 올바른 폴더로 순차 다운로드.
// 사용법:
//   node scripts/setup-models.mjs            # 실제 다운로드 (수십 GB)
//   node scripts/setup-models.mjs --dry-run  # 다운로드 없이 URL/dest만 출력
import path from 'node:path';
import { hfResolveUrl, downloadTo } from '../lib/download.mjs';

const COMFY_ROOT = 'C:\\ComfyUI_windows_portable\\ComfyUI';

// { repo, file(레포 내 경로), folder(COMFY_ROOT/models 하위) } → dest 자동 계산
const dest = (folder, file) => path.join(COMFY_ROOT, 'models', folder, path.basename(file));

const MANIFEST = [
  // Comfy-Org/Krea-2는 파일이 하위 폴더(diffusion_models/ 등)에 위치 — 레포 내 경로에 접두어 필요 (HF 실검증)
  { repo: 'Comfy-Org/Krea-2', file: 'diffusion_models/krea2_turbo_fp8_scaled.safetensors', folder: 'diffusion_models' },
  { repo: 'Comfy-Org/Krea-2', file: 'text_encoders/qwen3vl_4b_fp8_scaled.safetensors', folder: 'text_encoders' },
  { repo: 'Comfy-Org/Krea-2', file: 'vae/qwen_image_vae.safetensors', folder: 'vae' },
  { repo: 'Comfy-Org/Krea-2', file: 'loras/krea2_kidsdrawing.safetensors', folder: 'loras' },
  { repo: 'conradlocke/krea2-identity-edit', file: 'krea2_identity_edit_v1.safetensors', folder: 'loras' },
  { repo: 'Comfy-Org/Wan_2.2_ComfyUI_Repackaged', file: 'split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors', folder: 'diffusion_models' },
  { repo: 'Comfy-Org/Wan_2.2_ComfyUI_Repackaged', file: 'split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors', folder: 'text_encoders' },
  { repo: 'Comfy-Org/Wan_2.2_ComfyUI_Repackaged', file: 'split_files/vae/wan2.2_vae.safetensors', folder: 'vae' },
].map((m) => ({ ...m, url: hfResolveUrl(m.repo, m.file), dest: dest(m.folder, m.file) }));

const isDryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';

async function main() {
  if (isDryRun) {
    console.log(`[dry-run] ${MANIFEST.length} files WOULD be downloaded:\n`);
    for (const m of MANIFEST) {
      console.log(`  ${m.url}`);
      console.log(`    -> ${m.dest}\n`);
    }
    return;
  }

  const failures = [];
  for (const [i, m] of MANIFEST.entries()) {
    const tag = `[${i + 1}/${MANIFEST.length}]`;
    console.log(`${tag} start: ${m.url}`);
    try {
      const { skipped } = await downloadTo(m.url, m.dest, { minBytes: 1 });
      console.log(`${tag} ${skipped ? 'skipped (exists)' : 'done'}: ${m.dest}`);
    } catch (err) {
      console.error(`${tag} ERROR: ${err.message}`);
      failures.push({ file: m.file, error: err.message });
    }
  }

  if (failures.length) {
    console.error(`\n${failures.length} of ${MANIFEST.length} failed:`);
    for (const f of failures) console.error(`  - ${f.file}: ${f.error}`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${MANIFEST.length} files ready.`);
  }
}

main();
