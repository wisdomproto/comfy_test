// USAGE.md(C:\ComfyUI_windows_portable\USAGE.md) 검증 레시피 기반 워크플로우 빌더.
// 순수 함수: params → ComfyUI 워크플로우 JSON. seed는 호출측에서 확정된 정수여야 함.

export const LORA_TRIGGERS = {
  'plushy-world-flux_plushy_world_flux_araminta_k.safetensors': 'plushy world',
  'FLUX-dev-lora-live_3D.safetensors': '3D, 8K',
  'softpasty-flux-dev_araminta_k_softpasty_diffusion_flux.safetensors': 'soft pastel illustration',
  'frosting_lane_flux_flux_dev_frostinglane_araminta_k.safetensors': 'frstingln illustration',
  'thepoint_flux_araminta_k.safetensors': 'thepoint, flat illustration',
};

// Wan 공식 negative — 중국어가 효과적 (USAGE.md §13)
export const WAN_NEGATIVE =
  '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿';

function assertSeed(seed) {
  if (!Number.isInteger(seed)) throw new Error('seed must be a resolved integer');
}

export function buildFluxT2I({
  prompt, negative = '', lora = null, loraStrength = 1.0,
  width = 1024, height = 1024, steps = 25, guidance = 3.5, seed,
}) {
  if (!prompt) throw new Error('prompt is required');
  assertSeed(seed);

  const g = {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux1-dev-fp8.safetensors' } },
  };
  let model = ['1', 0];
  let clip = ['1', 1];
  if (lora) {
    g['2'] = {
      class_type: 'LoraLoader',
      inputs: { model, clip, lora_name: lora, strength_model: loraStrength, strength_clip: loraStrength },
    };
    model = ['2', 0];
    clip = ['2', 1];
  }
  g['3'] = { class_type: 'CLIPTextEncode', inputs: { clip, text: prompt } };
  g['4'] = { class_type: 'FluxGuidance', inputs: { conditioning: ['3', 0], guidance } };
  g['5'] = { class_type: 'CLIPTextEncode', inputs: { clip, text: negative } };
  g['6'] = { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } };
  g['7'] = {
    class_type: 'KSampler',
    inputs: {
      model, positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0],
      seed, steps, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise: 1.0,
    },
  };
  g['8'] = { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['1', 2] } };
  g['9'] = { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'testbench' } };
  return g;
}

export function buildWan22I2V({
  imageName, motionPrompt, negative = WAN_NEGATIVE, seed,
  width = 1280, height = 704, frames = 121, fps = 24,
}) {
  if (!imageName) throw new Error('imageName is required');
  if (!motionPrompt) throw new Error('motionPrompt is required');
  assertSeed(seed);

  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.2_ti2v_5B_fp16.safetensors', weight_dtype: 'default' } },
    2: { class_type: 'ModelSamplingSD3', inputs: { model: ['1', 0], shift: 8 } },
    3: { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan', device: 'default' } },
    4: { class_type: 'VAELoader', inputs: { vae_name: 'wan2.2_vae.safetensors' } },
    5: { class_type: 'LoadImage', inputs: { image: imageName } },
    6: { class_type: 'CLIPTextEncode', inputs: { clip: ['3', 0], text: motionPrompt } },
    7: { class_type: 'CLIPTextEncode', inputs: { clip: ['3', 0], text: negative } },
    8: {
      class_type: 'Wan22ImageToVideoLatent',
      inputs: {
        vae: ['4', 0], start_image: ['5', 0],
        width, height, length: frames, batch_size: 1,
      },
    },
    9: {
      class_type: 'KSampler',
      inputs: {
        model: ['2', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['8', 0],
        seed, steps: 20, cfg: 5, sampler_name: 'uni_pc', scheduler: 'simple', denoise: 1,
      },
    },
    10: { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: ['4', 0] } },
    11: { class_type: 'CreateVideo', inputs: { images: ['10', 0], fps } },
    12: { class_type: 'SaveVideo', inputs: { video: ['11', 0], filename_prefix: 'storybook_video', format: 'auto', codec: 'auto' } },
  };
}

// 프로덕션 영상 빌더 (실검증): Wan 2.2 14B GGUF(lightx2v 4-step, two-expert MoE)
// + 워크플로우 내 RealESRGAN 업스케일. 5초(81f@16fps) 컷 단위. 캐릭터 몰핑 억제 네거티브 기본.
export const WAN_ANTIMORPH =
  ', new character, extra animal, white tiger, cloned character, duplicate, morphing, changing identity, extra limbs, deformed, jitter, flickering, fast motion, camera shake, text, watermark';

// upscale: 'none' | '2x'(1664x960) | '1080'(4x→1872x1080). VAE는 14B용 wan_2.1_vae.
export function buildWan22I2V14B({
  imageName, motionPrompt, negative = WAN_NEGATIVE + WAN_ANTIMORPH, seed,
  width = 832, height = 480, frames = 81, fps = 16, upscale = '1080',
  filenamePrefix = 'storybook_hd',
}) {
  if (!imageName) throw new Error('imageName is required');
  if (!motionPrompt) throw new Error('motionPrompt is required');
  assertSeed(seed);

  const g = {
    1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf' } },
    2: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: 'wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors', strength_model: 1.0 } },
    3: { class_type: 'ModelSamplingSD3', inputs: { model: ['2', 0], shift: 5.0 } },
    4: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf' } },
    5: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['4', 0], lora_name: 'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors', strength_model: 1.0 } },
    6: { class_type: 'ModelSamplingSD3', inputs: { model: ['5', 0], shift: 5.0 } },
    7: { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan', device: 'default' } },
    8: { class_type: 'VAELoader', inputs: { vae_name: 'wan_2.1_vae.safetensors' } },
    9: { class_type: 'LoadImage', inputs: { image: imageName } },
    10: { class_type: 'CLIPTextEncode', inputs: { clip: ['7', 0], text: motionPrompt } },
    11: { class_type: 'CLIPTextEncode', inputs: { clip: ['7', 0], text: negative } },
    12: { class_type: 'WanImageToVideo', inputs: { positive: ['10', 0], negative: ['11', 0], vae: ['8', 0], start_image: ['9', 0], width, height, length: frames, batch_size: 1 } },
    13: { class_type: 'KSamplerAdvanced', inputs: { model: ['3', 0], add_noise: 'enable', noise_seed: seed, steps: 4, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', positive: ['12', 0], negative: ['12', 1], latent_image: ['12', 2], start_at_step: 0, end_at_step: 2, return_with_leftover_noise: 'enable' } },
    14: { class_type: 'KSamplerAdvanced', inputs: { model: ['6', 0], add_noise: 'disable', noise_seed: 0, steps: 4, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', positive: ['12', 0], negative: ['12', 1], latent_image: ['13', 0], start_at_step: 2, end_at_step: 10000, return_with_leftover_noise: 'disable' } },
    15: { class_type: 'VAEDecode', inputs: { samples: ['14', 0], vae: ['8', 0] } },
  };

  // 업스케일 분기 — CreateVideo에 넣을 이미지 노드 결정
  let imagesRef = ['15', 0];
  if (upscale === '2x') {
    g['18'] = { class_type: 'UpscaleModelLoader', inputs: { model_name: 'RealESRGAN_x2.pth' } };
    g['19'] = { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['18', 0], image: ['15', 0] } };
    imagesRef = ['19', 0];
  } else if (upscale === '1080') {
    g['18'] = { class_type: 'UpscaleModelLoader', inputs: { model_name: 'RealESRGAN_x4.pth' } };
    g['19'] = { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['18', 0], image: ['15', 0] } };
    g['20'] = { class_type: 'ImageScale', inputs: { image: ['19', 0], upscale_method: 'lanczos', width: 1872, height: 1080, crop: 'disabled' } };
    imagesRef = ['20', 0];
  } else if (upscale !== 'none') {
    throw new Error(`unknown upscale mode: ${upscale}`);
  }

  g['16'] = { class_type: 'CreateVideo', inputs: { images: imagesRef, fps } };
  g['17'] = { class_type: 'SaveVideo', inputs: { video: ['16', 0], filename_prefix: filenamePrefix, format: 'auto', codec: 'auto' } };
  return g;
}

export function buildKrea2Illustration({
  prompt, characterRefName = null, style = null,
  width = 1280, height = 704, steps = 8, seed,
}) {
  if (!prompt) throw new Error('prompt is required');
  assertSeed(seed);

  const g = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'krea2_turbo_fp8_scaled.safetensors', weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_4b_fp8_scaled.safetensors', type: 'krea2', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
  };
  let model = ['1', 0];
  const clip = ['2', 0];
  const vae = ['3', 0];

  // style LoRA — Krea2EditModelPatch 이전에 적용되도록 여기서 배선
  if (style) {
    g['4'] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model, lora_name: style, strength_model: 1.0 },
    };
    model = ['4', 0];
  }

  let positive;
  if (characterRefName) {
    // Krea2Edit 경로: LoadImage → VAEEncode(source_latent) → Krea2EditModelPatch
    g['5'] = { class_type: 'LoadImage', inputs: { image: characterRefName } };
    g['6'] = { class_type: 'VAEEncode', inputs: { pixels: ['5', 0], vae } };
    g['7'] = { class_type: 'Krea2EditModelPatch', inputs: { model, source_latent: ['6', 0] } };
    model = ['7', 0];
    g['8'] = {
      class_type: 'Krea2EditGroundedEncode',
      inputs: { clip, prompt, image: ['5', 0], grounding_px: 768 },
    };
    positive = ['8', 0];
  } else {
    g['8'] = { class_type: 'CLIPTextEncode', inputs: { clip, text: prompt } };
    positive = ['8', 0];
  }

  g['9'] = { class_type: 'ConditioningZeroOut', inputs: { conditioning: positive } };
  g['10'] = { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } };
  g['11'] = {
    class_type: 'KSampler',
    inputs: {
      model, positive, negative: ['9', 0], latent_image: ['10', 0],
      seed, steps, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
    },
  };
  g['12'] = { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae } };
  g['13'] = { class_type: 'SaveImage', inputs: { images: ['12', 0], filename_prefix: 'storybook' } };
  return g;
}

export function buildWanI2V({
  imageName, motionPrompt, negative = WAN_NEGATIVE,
  width = 832, height = 480, frames = 81, steps = 25, seed,
}) {
  if (!imageName) throw new Error('imageName is required');
  if (!motionPrompt) throw new Error('motionPrompt is required');
  assertSeed(seed);

  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.1_i2v_480p_14B_fp8_scaled.safetensors', weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: 'wan_2.1_vae.safetensors' } },
    4: { class_type: 'CLIPVisionLoader', inputs: { clip_name: 'clip_vision_h.safetensors' } },
    5: { class_type: 'LoadImage', inputs: { image: imageName } },
    6: { class_type: 'CLIPVisionEncode', inputs: { clip_vision: ['4', 0], image: ['5', 0], crop: 'none' } },
    7: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: motionPrompt } },
    8: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: negative } },
    9: {
      class_type: 'WanImageToVideo',
      inputs: {
        positive: ['7', 0], negative: ['8', 0], vae: ['3', 0],
        clip_vision_output: ['6', 0], start_image: ['5', 0],
        width, height, length: frames, batch_size: 1,
      },
    },
    10: {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], positive: ['9', 0], negative: ['9', 1], latent_image: ['9', 2],
        seed, steps, cfg: 6.0, sampler_name: 'uni_pc', scheduler: 'simple', denoise: 1.0,
      },
    },
    11: { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['3', 0] } },
    12: { class_type: 'CreateVideo', inputs: { images: ['11', 0], fps: 16 } },
    13: { class_type: 'SaveVideo', inputs: { video: ['12', 0], filename_prefix: 'testbench_video', format: 'mp4', codec: 'h264' } },
  };
}
