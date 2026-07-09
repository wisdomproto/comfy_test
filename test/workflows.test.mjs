import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFluxT2I, buildWanI2V, buildWan22I2V, buildWan22I2V14B, buildKrea2Illustration, LORA_TRIGGERS, WAN_NEGATIVE } from '../lib/workflows.mjs';

const nodeByType = (g, t) => Object.values(g).find((n) => n.class_type === t);
const idByType = (g, t) => Object.keys(g).find((id) => g[id].class_type === t);

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

test('buildWan22I2V: 기본값으로 완전한 그래프 생성', () => {
  const g = buildWan22I2V({ imageName: 'hero.png', motionPrompt: 'slow zoom in', seed: 11 });
  const unet = nodeByType(g, 'UNETLoader');
  assert.equal(unet.inputs.unet_name, 'wan2.2_ti2v_5B_fp16.safetensors');
  assert.equal(unet.inputs.weight_dtype, 'default');
  const shift = nodeByType(g, 'ModelSamplingSD3');
  assert.ok(shift);
  assert.equal(shift.inputs.shift, 8);
  const clip = nodeByType(g, 'CLIPLoader');
  assert.equal(clip.inputs.clip_name, 'umt5_xxl_fp8_e4m3fn_scaled.safetensors');
  assert.equal(clip.inputs.type, 'wan');
  const vae = nodeByType(g, 'VAELoader');
  assert.equal(vae.inputs.vae_name, 'wan2.2_vae.safetensors');
  const load = nodeByType(g, 'LoadImage');
  assert.equal(load.inputs.image, 'hero.png');
  const latent = nodeByType(g, 'Wan22ImageToVideoLatent');
  assert.equal(latent.inputs.length, 121);
  assert.equal(latent.inputs.width, 1280);
  assert.equal(latent.inputs.height, 704);
  const ks = nodeByType(g, 'KSampler');
  assert.equal(ks.inputs.steps, 20);
  assert.equal(ks.inputs.cfg, 5);
  assert.equal(ks.inputs.sampler_name, 'uni_pc');
  assert.equal(ks.inputs.scheduler, 'simple');
  assert.equal(ks.inputs.seed, 11);
  // KSampler 모델 입력이 ModelSamplingSD3를 가리켜야 함
  const shiftId = idByType(g, 'ModelSamplingSD3');
  assert.equal(ks.inputs.model[0], shiftId);
  assert.equal(nodeByType(g, 'CreateVideo').inputs.fps, 24);
  assert.ok(nodeByType(g, 'SaveVideo'));
  // 기본 네거티브는 WAN_NEGATIVE
  const neg = Object.values(g).filter((n) => n.class_type === 'CLIPTextEncode')
    .find((n) => n.inputs.text === WAN_NEGATIVE);
  assert.ok(neg);
});

test('buildWan22I2V: 필수값 누락 시 throw', () => {
  assert.throws(() => buildWan22I2V({ motionPrompt: 'x', seed: 1 }), /imageName/);
  assert.throws(() => buildWan22I2V({ imageName: 'a.png', seed: 1 }), /motionPrompt/);
  assert.throws(() => buildWan22I2V({ imageName: 'a.png', motionPrompt: 'x' }), /seed/);
});

test('buildKrea2Illustration: 기본값 base 그래프 (캐릭터 참조 없음)', () => {
  const g = buildKrea2Illustration({ prompt: 'a bunny in a meadow', seed: 5 });
  const unet = nodeByType(g, 'UNETLoader');
  assert.equal(unet.inputs.unet_name, 'krea2_turbo_fp8_scaled.safetensors');
  assert.equal(unet.inputs.weight_dtype, 'default');
  const clip = nodeByType(g, 'CLIPLoader');
  assert.equal(clip.inputs.clip_name, 'qwen3vl_4b_fp8_scaled.safetensors');
  assert.equal(clip.inputs.type, 'krea2');
  const vae = nodeByType(g, 'VAELoader');
  assert.equal(vae.inputs.vae_name, 'qwen_image_vae.safetensors');
  const latent = nodeByType(g, 'EmptyLatentImage');
  assert.equal(latent.inputs.width, 1280);
  assert.equal(latent.inputs.height, 704);
  assert.equal(latent.inputs.batch_size, 1);
  const ks = nodeByType(g, 'KSampler');
  assert.equal(ks.inputs.seed, 5);
  assert.equal(ks.inputs.steps, 8);
  assert.equal(ks.inputs.cfg, 1);
  assert.equal(ks.inputs.sampler_name, 'euler');
  assert.equal(ks.inputs.scheduler, 'simple');
  assert.equal(ks.inputs.denoise, 1);
  assert.ok(nodeByType(g, 'ConditioningZeroOut'));
  assert.equal(nodeByType(g, 'SaveImage').inputs.filename_prefix, 'storybook');
  assert.equal(nodeByType(g, 'CLIPTextEncode').inputs.text, 'a bunny in a meadow');
  // 캐릭터 참조 노드는 없어야 함
  assert.equal(nodeByType(g, 'LoadImage'), undefined);
  assert.equal(nodeByType(g, 'VAEEncode'), undefined);
  assert.equal(nodeByType(g, 'Krea2EditModelPatch'), undefined);
  assert.equal(nodeByType(g, 'Krea2EditGroundedEncode'), undefined);
  assert.equal(nodeByType(g, 'LoraLoaderModelOnly'), undefined);
});

test('buildKrea2Illustration: characterRefName 지정 시 Krea2Edit 경로', () => {
  const g = buildKrea2Illustration({ prompt: 'hero pose', characterRefName: 'char.png', seed: 3 });
  const load = nodeByType(g, 'LoadImage');
  assert.equal(load.inputs.image, 'char.png');
  assert.ok(nodeByType(g, 'VAEEncode'));
  const patchId = idByType(g, 'Krea2EditModelPatch');
  assert.ok(patchId);
  const grounded = nodeByType(g, 'Krea2EditGroundedEncode');
  assert.equal(grounded.inputs.grounding_px, 768);
  assert.equal(grounded.inputs.prompt, 'hero pose');
  // KSampler 모델 입력이 Krea2EditModelPatch를 가리켜야 함
  const ks = nodeByType(g, 'KSampler');
  assert.equal(ks.inputs.model[0], patchId);
  // 평범한 CLIPTextEncode positive는 없어야 함
  assert.equal(nodeByType(g, 'CLIPTextEncode'), undefined);
  // 네거티브는 여전히 ConditioningZeroOut
  assert.ok(nodeByType(g, 'ConditioningZeroOut'));
});

test('buildKrea2Illustration: style LoRA 지정 시 LoraLoaderModelOnly 삽입', () => {
  const g = buildKrea2Illustration({ prompt: 'a cat', style: 'krea2_kidsdrawing.safetensors', seed: 2 });
  const lora = nodeByType(g, 'LoraLoaderModelOnly');
  assert.equal(lora.inputs.lora_name, 'krea2_kidsdrawing.safetensors');
  assert.equal(lora.inputs.strength_model, 1.0);
});

test('buildKrea2Illustration: style LoRA는 Krea2EditModelPatch 이전에 적용', () => {
  const g = buildKrea2Illustration({
    prompt: 'a cat', characterRefName: 'char.png', style: 'krea2_kidsdrawing.safetensors', seed: 2,
  });
  const unetId = idByType(g, 'UNETLoader');
  const loraId = idByType(g, 'LoraLoaderModelOnly');
  const patch = nodeByType(g, 'Krea2EditModelPatch');
  // LoRA는 UNET을 입력받고, patch는 LoRA를 입력받음
  assert.equal(g[loraId].inputs.model[0], unetId);
  assert.equal(patch.inputs.model[0], loraId);
});

test('buildKrea2Illustration: prompt 없거나 seed 미확정이면 throw', () => {
  assert.throws(() => buildKrea2Illustration({ seed: 1 }), /prompt/);
  assert.throws(() => buildKrea2Illustration({ prompt: 'x' }), /seed/);
  assert.throws(() => buildKrea2Illustration({ prompt: 'x', seed: 1.5 }), /seed/);
});

test('LORA_TRIGGERS: 설치된 LoRA 5종의 트리거 단어 맵', () => {
  assert.equal(Object.keys(LORA_TRIGGERS).length, 5);
  assert.equal(LORA_TRIGGERS['plushy-world-flux_plushy_world_flux_araminta_k.safetensors'], 'plushy world');
});

test('buildWan22I2V14B: 14B GGUF two-expert + lightx2v + 1080 업스케일 기본', () => {
  const g = buildWan22I2V14B({ imageName: 'src.png', motionPrompt: 'gentle motion', seed: 3 });
  // GGUF 두 익스퍼트 + lightx2v LoRA + ModelSamplingSD3
  const ggufs = Object.values(g).filter((n) => n.class_type === 'UnetLoaderGGUF');
  assert.equal(ggufs.length, 2);
  assert.ok(ggufs.some((n) => n.inputs.unet_name.includes('HighNoise')));
  assert.ok(ggufs.some((n) => n.inputs.unet_name.includes('LowNoise')));
  assert.equal(Object.values(g).filter((n) => n.class_type === 'LoraLoaderModelOnly').length, 2);
  assert.equal(Object.values(g).filter((n) => n.class_type === 'ModelSamplingSD3').length, 2);
  // 두 KSamplerAdvanced (2+2 스텝), cfg 1, euler/simple
  const ks = Object.values(g).filter((n) => n.class_type === 'KSamplerAdvanced');
  assert.equal(ks.length, 2);
  assert.ok(ks.every((n) => n.inputs.steps === 4 && n.inputs.cfg === 1.0 && n.inputs.sampler_name === 'euler'));
  // WanImageToVideo start_image, CLIPLoader wan, VAE wan_2.1
  assert.equal(nodeByType(g, 'WanImageToVideo').inputs.start_image[0], idByType(g, 'LoadImage'));
  assert.equal(nodeByType(g, 'CLIPLoader').inputs.type, 'wan');
  assert.equal(nodeByType(g, 'VAELoader').inputs.vae_name, 'wan_2.1_vae.safetensors');
  // 1080 업스케일: x4 모델 + ImageScale 1872x1080, CreateVideo가 업스케일 결과 사용
  assert.equal(nodeByType(g, 'UpscaleModelLoader').inputs.model_name, 'RealESRGAN_x4.pth');
  const scale = nodeByType(g, 'ImageScale');
  assert.equal(scale.inputs.width, 1872);
  assert.equal(scale.inputs.height, 1080);
  assert.equal(nodeByType(g, 'CreateVideo').inputs.images[0], idByType(g, 'ImageScale'));
});

test('buildWan22I2V14B: upscale 옵션 none/2x', () => {
  const none = buildWan22I2V14B({ imageName: 'a.png', motionPrompt: 'm', seed: 1, upscale: 'none' });
  assert.equal(nodeByType(none, 'UpscaleModelLoader'), undefined);
  assert.equal(nodeByType(none, 'CreateVideo').inputs.images[0], idByType(none, 'VAEDecode'));
  const x2 = buildWan22I2V14B({ imageName: 'a.png', motionPrompt: 'm', seed: 1, upscale: '2x' });
  assert.equal(nodeByType(x2, 'UpscaleModelLoader').inputs.model_name, 'RealESRGAN_x2.pth');
  assert.equal(nodeByType(x2, 'ImageScale'), undefined);
  assert.equal(nodeByType(x2, 'CreateVideo').inputs.images[0], idByType(x2, 'ImageUpscaleWithModel'));
});

test('buildWan22I2V14B: 필수값 누락 throw', () => {
  assert.throws(() => buildWan22I2V14B({ motionPrompt: 'x', seed: 1 }), /imageName/);
  assert.throws(() => buildWan22I2V14B({ imageName: 'a.png', seed: 1 }), /motionPrompt/);
  assert.throws(() => buildWan22I2V14B({ imageName: 'a.png', motionPrompt: 'x' }), /seed/);
});
