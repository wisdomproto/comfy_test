import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFluxT2I, buildWanI2V, LORA_TRIGGERS, WAN_NEGATIVE } from '../lib/workflows.mjs';

test('buildFluxT2I: 기본값으로 완전한 그래프 생성', () => {
  const g = buildFluxT2I({ prompt: 'a cat', seed: 42 });
  assert.equal(g['1'].class_type, 'CheckpointLoaderSimple');
  assert.equal(g['1'].inputs.ckpt_name, 'flux1-dev-fp8.safetensors');
  assert.equal(g['3'].inputs.text, 'a cat');
  assert.equal(g['4'].class_type, 'FluxGuidance');
  assert.equal(g['4'].inputs.guidance, 3.5);
  assert.deepEqual(g['6'].inputs, { width: 1024, height: 1024, batch_size: 1 });
  const ks = g['7'].inputs;
  assert.equal(ks.seed, 42);
  assert.equal(ks.steps, 25);
  assert.equal(ks.cfg, 1.0);
  assert.equal(ks.sampler_name, 'euler');
  assert.equal(ks.scheduler, 'simple');
  assert.equal(g['9'].class_type, 'SaveImage');
  assert.equal(g['2'], undefined); // lora 미지정 시 LoraLoader 없음
  assert.deepEqual(ks.model, ['1', 0]);
});

test('buildFluxT2I: lora 지정 시 LoraLoader 삽입 및 배선 변경', () => {
  const g = buildFluxT2I({ prompt: 'a cat', seed: 1, lora: 'thepoint_flux_araminta_k.safetensors', loraStrength: 0.8 });
  assert.equal(g['2'].class_type, 'LoraLoader');
  assert.equal(g['2'].inputs.lora_name, 'thepoint_flux_araminta_k.safetensors');
  assert.equal(g['2'].inputs.strength_model, 0.8);
  assert.deepEqual(g['7'].inputs.model, ['2', 0]); // KSampler가 LoRA 출력 사용
  assert.deepEqual(g['3'].inputs.clip, ['2', 1]);  // TextEncode도 LoRA clip 사용
});

test('buildFluxT2I: prompt 없거나 seed 미확정이면 throw', () => {
  assert.throws(() => buildFluxT2I({ seed: 1 }), /prompt/);
  assert.throws(() => buildFluxT2I({ prompt: 'x' }), /seed/);
  assert.throws(() => buildFluxT2I({ prompt: 'x', seed: 1.5 }), /seed/);
});

test('buildWanI2V: 기본값으로 완전한 그래프 생성', () => {
  const g = buildWanI2V({ imageName: 'src.png', motionPrompt: 'gentle wind', seed: 7 });
  assert.equal(g['1'].inputs.unet_name, 'wan2.1_i2v_480p_14B_fp8_scaled.safetensors');
  assert.equal(g['2'].inputs.type, 'wan');
  assert.equal(g['5'].inputs.image, 'src.png');
  assert.equal(g['7'].inputs.text, 'gentle wind');
  assert.equal(g['8'].inputs.text, WAN_NEGATIVE);
  const w = g['9'].inputs;
  assert.equal(w.width, 832);
  assert.equal(w.height, 480);
  assert.equal(w.length, 81);
  const ks = g['10'].inputs;
  assert.equal(ks.cfg, 6.0);
  assert.equal(ks.sampler_name, 'uni_pc');
  assert.equal(g['12'].inputs.fps, 16);
  assert.equal(g['13'].class_type, 'SaveVideo');
});

test('buildWanI2V: 필수값 누락 시 throw', () => {
  assert.throws(() => buildWanI2V({ motionPrompt: 'x', seed: 1 }), /imageName/);
  assert.throws(() => buildWanI2V({ imageName: 'a.png', seed: 1 }), /motionPrompt/);
  assert.throws(() => buildWanI2V({ imageName: 'a.png', motionPrompt: 'x' }), /seed/);
});

test('LORA_TRIGGERS: 설치된 LoRA 5종의 트리거 단어 맵', () => {
  assert.equal(Object.keys(LORA_TRIGGERS).length, 5);
  assert.equal(LORA_TRIGGERS['plushy-world-flux_plushy_world_flux_araminta_k.safetensors'], 'plushy world');
});
