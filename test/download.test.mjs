import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hfResolveUrl } from '../lib/download.mjs';

test('hfResolveUrl: repo + path → resolve URL', () => {
  assert.equal(
    hfResolveUrl('Comfy-Org/Krea-2', 'krea2_turbo_fp8_scaled.safetensors'),
    'https://huggingface.co/Comfy-Org/Krea-2/resolve/main/krea2_turbo_fp8_scaled.safetensors',
  );
  assert.equal(
    hfResolveUrl('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/vae/wan2.2_vae.safetensors'),
    'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors',
  );
});
