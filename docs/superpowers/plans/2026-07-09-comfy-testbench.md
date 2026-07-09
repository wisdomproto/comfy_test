# ComfyUI 테스트벤치 웹앱 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 로컬 ComfyUI로 이미지(FLUX)·영상(Wan 2.1 I2V)을 반복 테스트하고 모든 결과를 히스토리로 누적하는 웹앱.

**Architecture:** Express 서버(포트 3333)가 ComfyUI API(127.0.0.1:8188)를 오케스트레이션 — 워크플로우 빌드/제출, WebSocket 진행률 수신, 히스토리 폴링으로 완료 판정, 결과물을 `outputs/`로 복사하고 `data/runs.json`에 기록. 프론트는 빌드 없는 vanilla JS 단일 페이지(탭 3개: 이미지/영상/히스토리).

**Tech Stack:** Node.js 20+ (ESM, `node:test`), express, ws, busboy. 프론트는 vanilla JS/HTML/CSS.

**Spec:** `docs/superpowers/specs/2026-07-09-comfy-testbench-design.md`

**전제:** ComfyUI는 `C:\ComfyUI_windows_portable`에 설치됨. 검증된 워크플로우 레시피는 `C:\ComfyUI_windows_portable\USAGE.md` 참고 (이 계획의 워크플로우 JSON은 해당 문서의 검증값을 그대로 사용).

---

## Chunk 1: 스캐폴드 + 워크플로우 빌더

### Task 1: 프로젝트 스캐폴드

**Files:**
- Create: `package.json`, `.gitignore`

- [ ] **Step 1.1: package.json 작성**

```json
{
  "name": "comfy-testbench",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server.mjs",
    "test": "node --test test/"
  },
  "dependencies": {
    "busboy": "^1.6.0",
    "express": "^4.21.2",
    "ws": "^8.18.0"
  }
}
```

- [ ] **Step 1.2: .gitignore 작성**

```
node_modules/
outputs/
data/runs.json
```

- [ ] **Step 1.3: 의존성 설치**

Run: `npm install`
Expected: express/ws/busboy 설치, `package-lock.json` 생성, 에러 없음

- [ ] **Step 1.4: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "chore: scaffold comfy-testbench project"
```

### Task 2: 워크플로우 빌더 (TDD)

**Files:**
- Create: `lib/workflows.mjs`
- Test: `test/workflows.test.mjs`

순수 함수: params → ComfyUI 워크플로우 JSON. USAGE.md 검증값이 기본값.

- [ ] **Step 2.1: 실패하는 테스트 작성**

`test/workflows.test.mjs`:

```js
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
```

- [ ] **Step 2.2: 테스트 실패 확인**

Run: `npm test`
Expected: FAIL — `Cannot find module ... lib/workflows.mjs`

- [ ] **Step 2.3: lib/workflows.mjs 구현**

```js
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
```

- [ ] **Step 2.4: 테스트 통과 확인**

Run: `npm test`
Expected: PASS — 6개 테스트 모두 통과

- [ ] **Step 2.5: Commit**

```bash
git add lib/workflows.mjs test/workflows.test.mjs
git commit -m "feat: add FLUX t2i and Wan i2v workflow builders with tests"
```

---

## Chunk 2: ComfyUI 클라이언트 + 서버

### Task 3: ComfyUI API 클라이언트

**Files:**
- Create: `lib/comfy.mjs`

실제 ComfyUI 대상이라 유닛 테스트 없음(스펙의 테스트 방침) — Task 6 스모크 테스트에서 검증.

- [ ] **Step 3.1: lib/comfy.mjs 구현**

```js
// ComfyUI HTTP/WS API 클라이언트 (http://127.0.0.1:8188)
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const BASE = 'http://127.0.0.1:8188';
export const COMFY_ROOT = 'C:\\ComfyUI_windows_portable';
export const COMFY_INPUT_DIR = path.join(COMFY_ROOT, 'ComfyUI', 'input');
export const COMFY_START_BAT = path.join(COMFY_ROOT, 'run_nvidia_gpu_fast_fp16_accumulation.bat');

export async function isAlive() {
  try {
    const res = await fetch(`${BASE}/system_stats`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getLoras() {
  const res = await fetch(`${BASE}/object_info/LoraLoader`);
  const json = await res.json();
  return json.LoraLoader.input.required.lora_name[0];
}

export async function submit(workflow, clientId) {
  const res = await fetch(`${BASE}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  if (!res.ok) throw new Error(`submit failed: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (json.error) throw new Error(`submit failed: ${JSON.stringify(json.error)}`);
  return json; // { prompt_id, ... }
}

// KSampler 스텝 진행률을 WS로 수신. 완료 판정은 여기서 하지 않음 —
// 서버가 히스토리 폴링으로 판정하므로 WS가 끊겨도 잡은 완주한다.
export function trackProgress(promptId, clientId, onProgress) {
  const ws = new WebSocket(`ws://127.0.0.1:8188/ws?clientId=${clientId}`);
  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // 프리뷰 프레임은 무시
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'progress' && msg.data.prompt_id === promptId) {
      onProgress({ value: msg.data.value, max: msg.data.max });
    }
  });
  ws.on('error', () => {}); // 진행률은 best-effort
  return () => { try { ws.close(); } catch {} };
}

export async function fetchHistory(promptId) {
  const res = await fetch(`${BASE}/history/${promptId}`);
  return res.json();
}

// 히스토리 outputs에서 filename 가진 항목을 전부 수집.
// SaveImage는 outputs[n].images, SaveVideo는 필드명이 다를 수 있어 제너릭하게 순회.
export function extractOutputs(historyEntry) {
  const files = [];
  for (const nodeOutput of Object.values(historyEntry.outputs ?? {})) {
    for (const value of Object.values(nodeOutput)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (item && typeof item === 'object' && item.filename) files.push(item);
      }
    }
  }
  return files;
}

export async function downloadOutput(fileInfo, destPath) {
  const q = new URLSearchParams({
    filename: fileInfo.filename,
    subfolder: fileInfo.subfolder ?? '',
    type: fileInfo.type ?? 'output',
  });
  const res = await fetch(`${BASE}/view?${q}`);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
}

// LoadImage 노드용 — ComfyUI input/ 폴더로 파일 복사
export function uploadInput(localPath, destName) {
  fs.copyFileSync(localPath, path.join(COMFY_INPUT_DIR, destName));
  return destName;
}
```

- [ ] **Step 3.2: 문법 확인**

Run: `node --check lib/comfy.mjs; npm test`
Expected: 문법 에러 없음, 기존 테스트 PASS 유지

- [ ] **Step 3.3: Commit**

```bash
git add lib/comfy.mjs
git commit -m "feat: add ComfyUI API client (submit, progress, history, download)"
```

### Task 4: Express 서버 + 잡 매니저

**Files:**
- Create: `server.mjs`

- [ ] **Step 4.1: server.mjs 구현**

```js
// 테스트벤치 서버: 정적 서빙 + ComfyUI 오케스트레이션 + 잡/히스토리 관리
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import busboy from 'busboy';
import * as comfy from './lib/comfy.mjs';
import { buildFluxT2I, buildWanI2V, LORA_TRIGGERS } from './lib/workflows.mjs';

const PORT = 3333;
const ROOT = import.meta.dirname;
const OUTPUTS_DIR = path.join(ROOT, 'outputs');
const DATA_DIR = path.join(ROOT, 'data');
const RUNS_FILE = path.join(DATA_DIR, 'runs.json');

fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(RUNS_FILE)) fs.writeFileSync(RUNS_FILE, '[]');

const readRuns = () => JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8'));
function appendRun(run) {
  const runs = readRuns();
  runs.push(run);
  fs.writeFileSync(RUNS_FILE, JSON.stringify(runs, null, 2));
}

// 랜덤 seed는 제출 전에 확정 — "같은 설정으로 재생성" 재현성 보장 (스펙)
// crypto.randomInt는 max-min ≤ 2^48-1 제약 — 2**48이면 RangeError
const resolveSeed = (seed) => (Number.isInteger(seed) ? seed : crypto.randomInt(0, 2 ** 48 - 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jobs = new Map();

function createJob(type, params, sourceRunId = null) {
  const job = {
    id: crypto.randomUUID(), type, params, sourceRunId,
    status: 'queued', progress: 0, error: null, outputFile: null, startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

async function runJob(job, workflow) {
  const clientId = crypto.randomUUID();
  let closeWs = () => {};
  try {
    const { prompt_id: promptId } = await comfy.submit(workflow, clientId);
    job.status = 'running';
    closeWs = comfy.trackProgress(promptId, clientId, ({ value, max }) => {
      job.progress = Math.round((value / max) * 100);
    });
    // 완료 판정은 히스토리 폴링 — WS 끊김/브라우저 종료와 무관하게 완주.
    // 단, ComfyUI 자체가 죽으면 2분(연속 24회 실패) 후 잡을 error로 마감
    let failures = 0;
    for (;;) {
      await sleep(5000);
      let history = null;
      try {
        history = await comfy.fetchHistory(promptId);
        failures = 0;
      } catch {
        failures += 1;
        if (failures >= 24) throw new Error('ComfyUI unreachable for 2 minutes during job');
      }
      const entry = history?.[promptId];
      if (!entry?.status) continue;
      if (entry.status.status_str === 'error') {
        const errs = (entry.status.messages ?? []).filter(([t]) => t === 'execution_error');
        throw new Error(`execution error: ${JSON.stringify(errs.at(-1) ?? 'unknown')}`);
      }
      if (entry.status.completed) {
        const files = comfy.extractOutputs(entry);
        if (!files.length) throw new Error('completed but no output files in history');
        const ext = path.extname(files[0].filename) || (job.type === 'video' ? '.mp4' : '.png');
        const outName = `${job.id}${ext}`;
        await comfy.downloadOutput(files[0], path.join(OUTPUTS_DIR, outName));
        job.outputFile = `outputs/${outName}`;
        job.status = 'done';
        break;
      }
    }
  } catch (err) {
    job.status = 'error';
    job.error = String(err?.message ?? err);
  } finally {
    closeWs();
    // 실패한 조합도 테스트 데이터 — 성공/실패 모두 기록 (스펙)
    appendRun({
      id: job.id, type: job.type,
      createdAt: new Date(job.startedAt).toISOString(),
      params: job.params, sourceRunId: job.sourceRunId,
      status: job.status === 'done' ? 'done' : 'error',
      error: job.error, outputFile: job.outputFile,
      durationSec: Math.round((Date.now() - job.startedAt) / 1000),
    });
  }
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/outputs', express.static(OUTPUTS_DIR));

app.get('/api/status', async (req, res) => {
  const alive = await comfy.isAlive();
  let loras = [];
  if (alive) {
    try { loras = await comfy.getLoras(); } catch { /* 목록 실패해도 상태는 응답 */ }
  }
  res.json({ alive, loras, loraTriggers: LORA_TRIGGERS });
});

app.post('/api/comfy/start', async (req, res) => {
  if (await comfy.isAlive()) return res.json({ started: false, reason: 'already running' });
  spawn('cmd.exe', ['/c', 'start', 'ComfyUI', comfy.COMFY_START_BAT], {
    cwd: comfy.COMFY_ROOT, detached: true, stdio: 'ignore',
  }).unref();
  res.json({ started: true }); // 기동 완료까지 ~60초 — 프론트가 /api/status 폴링으로 확인
});

app.post('/api/generate/image', async (req, res) => {
  if (!(await comfy.isAlive())) return res.status(503).json({ error: 'ComfyUI is not running' });
  const p = req.body;
  const params = {
    prompt: p.prompt, negative: p.negative || '',
    lora: p.lora || null, loraStrength: p.loraStrength ?? 1.0,
    width: p.width ?? 1024, height: p.height ?? 1024,
    steps: p.steps ?? 25, guidance: p.guidance ?? 3.5,
    seed: resolveSeed(p.seed),
  };
  let workflow;
  try { workflow = buildFluxT2I(params); } catch (err) { return res.status(400).json({ error: err.message }); }
  const job = createJob('image', params);
  runJob(job, workflow);
  res.json({ jobId: job.id });
});

app.post('/api/generate/video', async (req, res) => {
  if (!(await comfy.isAlive())) return res.status(503).json({ error: 'ComfyUI is not running' });
  const p = req.body;
  let imageName = p.uploadName ?? null;
  if (p.sourceRunId) {
    const run = readRuns().find((r) => r.id === p.sourceRunId);
    if (!run?.outputFile) return res.status(400).json({ error: 'source run not found or has no output' });
    // 히스토리 결과물을 ComfyUI input/으로 복사 (스펙: 히스토리 → 영상 소스)
    imageName = comfy.uploadInput(
      path.join(ROOT, run.outputFile),
      `src_${run.id}${path.extname(run.outputFile)}`,
    );
  }
  const params = {
    imageName, motionPrompt: p.motionPrompt,
    width: p.width ?? 832, height: p.height ?? 480,
    frames: p.frames ?? 81, steps: p.steps ?? 25,
    seed: resolveSeed(p.seed),
  };
  let workflow;
  try { workflow = buildWanI2V(params); } catch (err) { return res.status(400).json({ error: err.message }); }
  const job = createJob('video', params, p.sourceRunId ?? null);
  runJob(job, workflow);
  res.json({ jobId: job.id });
});

app.post('/api/upload', (req, res) => {
  const bb = busboy({ headers: req.headers });
  let done = null; // 파일 flush 완료까지 기다렸다가 응답 (부분 쓰기 방지)
  bb.on('file', (name, file, info) => {
    const destName = `upload_${Date.now()}${path.extname(info.filename) || '.png'}`;
    const out = fs.createWriteStream(path.join(comfy.COMFY_INPUT_DIR, destName));
    file.pipe(out);
    done = new Promise((resolve, reject) => {
      out.on('finish', () => resolve(destName));
      out.on('error', reject);
    });
  });
  bb.on('close', async () => {
    if (!done) return res.status(400).json({ error: 'no file' });
    try {
      res.json({ uploadName: await done });
    } catch (err) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });
  req.pipe(bb);
});

app.get('/api/jobs', (req, res) => {
  res.json([...jobs.values()].filter((j) => j.status === 'queued' || j.status === 'running'));
});
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});
app.get('/api/runs', (req, res) => res.json(readRuns().reverse()));

app.listen(PORT, () => console.log(`comfy-testbench: http://localhost:${PORT}`));
```

- [ ] **Step 4.2: 서버 기동 확인 (ComfyUI 꺼진 상태)**

Run: `node --check server.mjs` 후 서버를 백그라운드로 띄우고:
```bash
curl -s http://localhost:3333/api/status
curl -s http://localhost:3333/api/runs
curl -s -X POST http://localhost:3333/api/generate/image -H "Content-Type: application/json" -d '{"prompt":"test"}'
```
Expected:
- `/api/status` → `{"alive":false,"loras":[],"loraTriggers":{...5개...}}`
- `/api/runs` → `[]`
- generate → HTTP 503 `{"error":"ComfyUI is not running"}`
확인 후 서버 종료.

- [ ] **Step 4.3: Commit**

```bash
git add server.mjs
git commit -m "feat: add express server with job manager and generation endpoints"
```

---

## Chunk 3: 프론트엔드 + 스모크 테스트

### Task 5: 프론트엔드

**Files:**
- Create: `public/index.html`, `public/style.css`, `public/app.js`

- [ ] **Step 5.1: public/index.html 작성**

```html
<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ComfyUI 테스트벤치</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header>
  <h1>ComfyUI 테스트벤치</h1>
  <div id="comfy-status" class="status offline">
    <span id="status-text">확인 중…</span>
    <button id="btn-start-comfy" hidden>ComfyUI 시작</button>
  </div>
</header>

<div id="active-jobs"></div>

<nav>
  <button class="tab active" data-tab="image">이미지 생성</button>
  <button class="tab" data-tab="video">영상 생성</button>
  <button class="tab" data-tab="history">히스토리</button>
</nav>

<main>
<section id="tab-image" class="panel active">
  <form id="form-image">
    <label>프롬프트
      <textarea name="prompt" rows="3" required placeholder="a cozy cabin in the woods, warm light"></textarea>
    </label>
    <details><summary>Negative 프롬프트 (FLUX는 보통 불필요)</summary>
      <textarea name="negative" rows="2"></textarea>
    </details>
    <div class="row">
      <label>LoRA
        <select name="lora"><option value="">(없음)</option></select>
      </label>
      <label>LoRA 강도 <input type="number" name="loraStrength" value="1.0" step="0.1" min="0" max="3"></label>
    </div>
    <p id="lora-hint" class="hint" hidden></p>
    <div class="row">
      <label>사이즈
        <select name="size">
          <option value="1024x1024">1:1 (1024×1024)</option>
          <option value="1344x768">16:9 (1344×768)</option>
          <option value="768x1344">9:16 (768×1344)</option>
        </select>
      </label>
      <label>Steps <input type="number" name="steps" value="25" min="1" max="50"></label>
      <label>Guidance <input type="number" name="guidance" value="3.5" step="0.5" min="1" max="10"></label>
    </div>
    <div class="row">
      <label>Seed <input type="number" name="seed" value="42" min="0"></label>
      <label class="check"><input type="checkbox" name="randomSeed" checked> 랜덤</label>
    </div>
    <button type="submit" class="primary">이미지 생성</button>
  </form>
  <div id="image-result" class="result"></div>
</section>

<section id="tab-video" class="panel">
  <form id="form-video">
    <fieldset>
      <legend>소스 이미지</legend>
      <label class="check"><input type="radio" name="sourceType" value="history" checked> 히스토리에서 선택</label>
      <label class="check"><input type="radio" name="sourceType" value="upload"> 파일 업로드</label>
      <div id="video-source-history" class="thumb-grid small"></div>
      <input type="file" id="video-source-file" accept="image/*" hidden>
      <p id="video-source-selected" class="hint">선택된 소스 없음</p>
    </fieldset>
    <label>모션 프롬프트
      <textarea name="motionPrompt" rows="2" required>subtle natural motion, gentle wind, soft camera movement, cinematic</textarea>
    </label>
    <div class="row">
      <label>길이
        <select name="frames">
          <option value="81">5초 (81프레임)</option>
          <option value="161">10초 (161프레임)</option>
        </select>
      </label>
      <label>Steps <input type="number" name="steps" value="25" min="10" max="40"></label>
      <label>Seed <input type="number" name="seed" value="42" min="0"></label>
      <label class="check"><input type="checkbox" name="randomSeed" checked> 랜덤</label>
    </div>
    <p class="hint">⏱ fp8 모델 기준 5초 클립에 ~22분 소요됩니다. 브라우저를 닫아도 서버가 완료합니다.</p>
    <button type="submit" class="primary">영상 생성</button>
  </form>
  <div id="video-result" class="result"></div>
</section>

<section id="tab-history" class="panel">
  <div id="history-grid" class="cards"></div>
</section>
</main>
<script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 5.2: public/style.css 작성**

```css
* { box-sizing: border-box; }
body { margin: 0; font-family: 'Segoe UI', sans-serif; background: #14151a; color: #e8e8ec; }
header { display: flex; justify-content: space-between; align-items: center; padding: 12px 20px; background: #1c1e26; }
h1 { font-size: 18px; margin: 0; }
.status { display: flex; gap: 10px; align-items: center; font-size: 13px; padding: 4px 12px; border-radius: 20px; }
.status.online { background: #143d2b; color: #4ade80; }
.status.offline { background: #3d1a1a; color: #f87171; }
nav { display: flex; gap: 4px; padding: 10px 20px 0; }
.tab { background: none; border: none; color: #9a9aa5; padding: 10px 18px; font-size: 14px; cursor: pointer; border-bottom: 2px solid transparent; }
.tab.active { color: #e8e8ec; border-bottom-color: #6366f1; }
main { padding: 20px; max-width: 1100px; margin: 0 auto; }
.panel { display: none; }
.panel.active { display: block; }
form { display: flex; flex-direction: column; gap: 14px; background: #1c1e26; padding: 20px; border-radius: 10px; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: #b8b8c2; }
label.check { flex-direction: row; align-items: center; }
textarea, input, select { background: #14151a; border: 1px solid #34363f; color: #e8e8ec; border-radius: 6px; padding: 8px 10px; font-size: 14px; font-family: inherit; }
.row { display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-end; }
.row label { flex: 1; min-width: 120px; }
button.primary { background: #6366f1; color: #fff; border: none; padding: 12px; border-radius: 8px; font-size: 15px; cursor: pointer; }
button.primary:disabled { background: #34363f; cursor: not-allowed; }
button { cursor: pointer; }
.hint { font-size: 12px; color: #8a8a95; margin: 0; }
#active-jobs { padding: 0 20px; }
.job-bar { background: #1c1e26; border: 1px solid #34363f; border-radius: 8px; padding: 10px 14px; margin: 10px 0; font-size: 13px; }
.job-bar progress { width: 100%; height: 8px; }
.result { margin-top: 20px; }
.result img, .result video { max-width: 100%; border-radius: 10px; }
.result .error { color: #f87171; background: #3d1a1a; padding: 12px; border-radius: 8px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
.card { background: #1c1e26; border-radius: 10px; overflow: hidden; }
.card img, .card video { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; }
.card .meta { padding: 10px; font-size: 12px; }
.card .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; margin-right: 6px; }
.badge.image { background: #1e3a5f; color: #7dd3fc; }
.badge.video { background: #3b2a5f; color: #c4b5fd; }
.badge.error { background: #3d1a1a; color: #f87171; }
.card .prompt { color: #b8b8c2; margin: 6px 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.card pre { background: #14151a; padding: 8px; border-radius: 6px; overflow-x: auto; font-size: 11px; white-space: pre-wrap; }
.card .actions { display: flex; gap: 6px; margin-top: 8px; }
.card .actions button { background: #2a2c36; border: 1px solid #34363f; color: #b8b8c2; border-radius: 6px; padding: 5px 8px; font-size: 11px; }
.thumb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)); gap: 8px; max-height: 220px; overflow-y: auto; margin-top: 8px; }
.thumb-grid img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 6px; cursor: pointer; border: 2px solid transparent; }
.thumb-grid img.selected { border-color: #6366f1; }
details summary { cursor: pointer; font-size: 13px; color: #8a8a95; }
```

- [ ] **Step 5.3: public/app.js 작성**

```js
const $ = (sel) => document.querySelector(sel);
const api = async (path, opts) => {
  const res = await fetch(path, opts);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let statusInfo = { alive: false, loras: [], loraTriggers: {} };
let runs = [];
let selectedSourceRunId = null;
let uploadedName = null;
const watching = new Set();

// ---- 상태 ----
async function refreshStatus() {
  try { statusInfo = await api('/api/status'); } catch { statusInfo.alive = false; }
  const el = $('#comfy-status');
  el.classList.toggle('online', statusInfo.alive);
  el.classList.toggle('offline', !statusInfo.alive);
  $('#status-text').textContent = statusInfo.alive ? 'ComfyUI 연결됨' : 'ComfyUI 꺼짐';
  $('#btn-start-comfy').hidden = statusInfo.alive;
  document.querySelectorAll('button.primary').forEach((b) => (b.disabled = !statusInfo.alive));
  renderLoraOptions();
}

function renderLoraOptions() {
  const sel = document.querySelector('#form-image select[name=lora]');
  if (sel.dataset.filled || !statusInfo.loras.length) return;
  for (const name of statusInfo.loras) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name.replace('.safetensors', '');
    sel.appendChild(opt);
  }
  sel.dataset.filled = '1';
}

$('#btn-start-comfy').addEventListener('click', async () => {
  await api('/api/comfy/start', { method: 'POST' });
  $('#status-text').textContent = 'ComfyUI 시작 중… (~60초)';
});

// LoRA 선택 시 트리거 단어 힌트
document.querySelector('#form-image select[name=lora]').addEventListener('change', (e) => {
  const trigger = statusInfo.loraTriggers[e.target.value];
  const hint = $('#lora-hint');
  hint.hidden = !trigger;
  if (trigger) hint.textContent = `💡 트리거 단어를 프롬프트에 포함하세요: "${trigger}"`;
});

// ---- 탭 ----
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'history') loadRuns();
    if (btn.dataset.tab === 'video') renderVideoSourceGrid();
  });
});

// ---- 잡 추적 ----
function watchJob(jobId) {
  if (watching.has(jobId)) return;
  watching.add(jobId);
  const bar = document.createElement('div');
  bar.className = 'job-bar';
  bar.id = `job-${jobId}`;
  $('#active-jobs').appendChild(bar);
  const timer = setInterval(async () => {
    let job;
    try {
      job = await api(`/api/jobs/${jobId}`);
    } catch (err) {
      // 서버 재시작 등으로 잡이 사라지면(404) 폴링 중단
      if (String(err.message).includes('not found')) {
        clearInterval(timer);
        watching.delete(jobId);
        bar.remove();
      }
      return;
    }
    bar.innerHTML = `<div>${job.type === 'video' ? '🎬 영상' : '🖼 이미지'} 생성 중 — ${job.status} ${job.progress}%</div><progress max="100" value="${job.progress}"></progress>`;
    if (job.status === 'done' || job.status === 'error') {
      clearInterval(timer);
      watching.delete(jobId);
      bar.remove();
      showResult(job);
      loadRuns();
    }
  }, 2000);
}

function showResult(job) {
  const target = $(job.type === 'video' ? '#video-result' : '#image-result');
  if (job.status === 'error') {
    target.innerHTML = `<div class="error">실패: ${esc(job.error)}</div>`;
  } else if (job.type === 'video') {
    target.innerHTML = `<video src="/${job.outputFile}" controls autoplay loop></video>`;
  } else {
    target.innerHTML = `<img src="/${job.outputFile}" alt="result">`;
  }
}

// 새로고침 후에도 진행 중 잡 재발견 (스펙)
async function rediscoverJobs() {
  try { (await api('/api/jobs')).forEach((j) => watchJob(j.id)); } catch { /* 서버 미기동 */ }
}

// ---- 이미지 생성 ----
$('#form-image').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const [width, height] = f.get('size').split('x').map(Number);
  const body = {
    prompt: f.get('prompt'), negative: f.get('negative') ?? '',
    lora: f.get('lora') || null, loraStrength: Number(f.get('loraStrength')),
    width, height, steps: Number(f.get('steps')), guidance: Number(f.get('guidance')),
    seed: f.get('randomSeed') ? null : Number(f.get('seed')),
  };
  try {
    const { jobId } = await api('/api/generate/image', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    $('#image-result').innerHTML = '';
    watchJob(jobId);
  } catch (err) { $('#image-result').innerHTML = `<div class="error">${err.message}</div>`; }
});

// ---- 영상 생성 ----
function renderVideoSourceGrid() {
  const grid = $('#video-source-history');
  const imageRuns = runs.filter((r) => r.type === 'image' && r.status === 'done');
  grid.innerHTML = imageRuns.length ? '' : '<p class="hint">완성된 이미지가 아직 없습니다</p>';
  for (const run of imageRuns) {
    const img = document.createElement('img');
    img.src = `/${run.outputFile}`;
    img.classList.toggle('selected', run.id === selectedSourceRunId);
    img.addEventListener('click', () => selectVideoSource(run.id));
    grid.appendChild(img);
  }
}

function selectVideoSource(runId) {
  selectedSourceRunId = runId;
  uploadedName = null;
  document.querySelector('#form-video input[value=history]').checked = true;
  $('#video-source-selected').textContent = `선택됨: 히스토리 이미지 ${runId.slice(0, 8)}`;
  renderVideoSourceGrid();
}

document.querySelectorAll('#form-video input[name=sourceType]').forEach((radio) => {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    // 소스 방식 전환 시 이전 선택 초기화 (stale 업로드로 제출 방지)
    uploadedName = null;
    selectedSourceRunId = null;
    $('#video-source-selected').textContent = '선택된 소스 없음';
    renderVideoSourceGrid();
    if (radio.value === 'upload') $('#video-source-file').click();
  });
});

$('#video-source-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const fd = new FormData();
    fd.append('file', file);
    const { uploadName } = await api('/api/upload', { method: 'POST', body: fd });
    uploadedName = uploadName;
    selectedSourceRunId = null;
    $('#video-source-selected').textContent = `선택됨: 업로드 파일 ${file.name}`;
  } catch (err) {
    $('#video-source-selected').textContent = `업로드 실패: ${err.message}`;
  }
});

$('#form-video').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedSourceRunId && !uploadedName) {
    $('#video-result').innerHTML = '<div class="error">소스 이미지를 선택하세요</div>';
    return;
  }
  const f = new FormData(e.target);
  const body = {
    sourceRunId: selectedSourceRunId, uploadName: uploadedName,
    motionPrompt: f.get('motionPrompt'),
    frames: Number(f.get('frames')), steps: Number(f.get('steps')),
    seed: f.get('randomSeed') ? null : Number(f.get('seed')),
  };
  try {
    const { jobId } = await api('/api/generate/video', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    $('#video-result').innerHTML = '';
    watchJob(jobId);
  } catch (err) { $('#video-result').innerHTML = `<div class="error">${err.message}</div>`; }
});

// ---- 히스토리 ----
async function loadRuns() {
  runs = await api('/api/runs');
  const grid = $('#history-grid');
  grid.innerHTML = runs.length ? '' : '<p class="hint">아직 생성 기록이 없습니다</p>';
  for (const run of runs) grid.appendChild(renderCard(run));
}

function renderCard(run) {
  const card = document.createElement('div');
  card.className = 'card';
  const media = run.status !== 'done' ? ''
    : run.type === 'video'
      ? `<video src="/${run.outputFile}" muted loop onmouseover="this.play()" onmouseout="this.pause()"></video>`
      : `<img src="/${run.outputFile}" loading="lazy">`;
  const prompt = run.params.prompt ?? run.params.motionPrompt ?? '';
  card.innerHTML = `
    ${media}
    <div class="meta">
      <span class="badge ${run.type}">${run.type}</span>
      ${run.status === 'error' ? '<span class="badge error">실패</span>' : ''}
      <span>${new Date(run.createdAt).toLocaleString('ko-KR')} · ${run.durationSec}s</span>
      <p class="prompt">${esc(prompt)}</p>
      <details><summary>파라미터</summary><pre>${esc(JSON.stringify(run.params, null, 2))}${run.error ? `\n\nERROR: ${esc(run.error)}` : ''}</pre></details>
      <div class="actions"></div>
    </div>`;
  const actions = card.querySelector('.actions');
  if (run.type === 'image') {
    const btnRedo = document.createElement('button');
    btnRedo.textContent = '같은 설정으로 재생성';
    btnRedo.addEventListener('click', () => restoreImageParams(run.params));
    actions.appendChild(btnRedo);
    if (run.status === 'done') {
      const btnVideo = document.createElement('button');
      btnVideo.textContent = '이 이미지로 영상 만들기';
      btnVideo.addEventListener('click', () => {
        selectVideoSource(run.id);
        document.querySelector('[data-tab=video]').click();
        selectVideoSource(run.id); // 탭 전환 후 그리드 다시 그려지므로 재적용
      });
      actions.appendChild(btnVideo);
    }
  }
  return card;
}

function restoreImageParams(p) {
  const form = $('#form-image');
  form.prompt.value = p.prompt;
  form.negative.value = p.negative ?? '';
  form.lora.value = p.lora ?? '';
  form.lora.dispatchEvent(new Event('change'));
  form.loraStrength.value = p.loraStrength ?? 1.0;
  form.size.value = `${p.width}x${p.height}`;
  form.steps.value = p.steps;
  form.guidance.value = p.guidance;
  form.seed.value = p.seed;
  form.randomSeed.checked = false; // 확정 seed로 재현
  document.querySelector('[data-tab=image]').click();
}

// ---- init ----
refreshStatus();
setInterval(refreshStatus, 10000);
loadRuns();
rediscoverJobs();
```

- [ ] **Step 5.4: 서버 띄우고 UI 육안 확인 (ComfyUI 꺼진 상태)**

Run: `npm start` (백그라운드), 브라우저에서 `http://localhost:3333`
Expected:
- 상태 배지 "ComfyUI 꺼짐" + "ComfyUI 시작" 버튼 표시
- 생성 버튼 비활성
- 탭 3개 전환 동작, 히스토리 "아직 생성 기록이 없습니다"
- 콘솔 에러 없음

- [ ] **Step 5.5: Commit**

```bash
git add public/
git commit -m "feat: add testbench frontend (image/video/history tabs)"
```

### Task 6: 실기기 스모크 테스트 (ComfyUI 연동)

**Files:** 없음 (검증만)

- [ ] **Step 6.1: ComfyUI 기동**

UI의 "ComfyUI 시작" 버튼 또는 `C:\ComfyUI_windows_portable\run_nvidia_gpu_fast_fp16_accumulation.bat` 실행.
~60초 후 상태 배지가 "ComfyUI 연결됨"으로 바뀌고 LoRA 드롭다운에 5종이 로드되는지 확인.

- [ ] **Step 6.2: 이미지 생성 E2E**

이미지 탭에서 프롬프트 `a cozy cabin in the woods, warm light, cinematic` 로 생성.
Expected: 진행바 표시 → 45초~2분 내 완료 → 결과 이미지 표시, `outputs/`에 png 저장, `data/runs.json`에 레코드 1건(status done, seed 정수 확정) 추가, 히스토리 탭에 카드 표시.

- [ ] **Step 6.3: 재생성/파라미터 복원 확인**

히스토리 카드의 "같은 설정으로 재생성" 클릭 → 이미지 탭 폼에 파라미터(확정 seed 포함, 랜덤 해제) 복원 확인.

- [ ] **Step 6.4: 영상 생성 E2E (시간 오래 걸림 — 백그라운드 확인)**

히스토리 카드의 "이 이미지로 영상 만들기" → 영상 탭에 소스 설정 확인 → 생성 시작.
진행바 뜨는 것 확인 후 **브라우저 새로고침** → 활성 잡이 재발견되어 진행바 다시 표시되는지 확인.
fp8 기준 ~22분 후: mp4가 `outputs/`에 저장되고 runs.json에 video 레코드 추가, 히스토리 카드에서 hover 재생.

- [ ] **Step 6.5: 실패 기록 확인**

이미지 탭에서 LoRA를 수동으로 존재하지 않는 값으로 보내거나(개발자도구), ComfyUI를 끈 상태에서 생성 시도.
Expected: 에러가 UI에 표시되고, 실행 단계 실패인 경우 runs.json에 status error 레코드 기록.

- [ ] **Step 6.6: 발견된 버그 수정 후 Commit**

```bash
git add -A
git commit -m "fix: smoke test fixes"   # 수정 사항 있을 때만
```

### Task 7: 문서화 + 마무리

**Files:**
- Create: `CLAUDE.md`, `README.md`

- [ ] **Step 7.1: 루트 CLAUDE.md 작성 (~30줄, 모듈화 규칙 준수)**

프로젝트 개요, 실행법(`npm start` → localhost:3333), 구조 요약, ComfyUI 의존성(`C:\ComfyUI_windows_portable`, USAGE.md 참조), 테스트(`npm test`).

- [ ] **Step 7.2: README.md 작성**

사용자용: 실행법, 화면 설명(탭 3개), ComfyUI 시작 버튼, 소요 시간 안내(이미지 ~45초, 영상 ~22분).

- [ ] **Step 7.3: 전체 테스트 + Commit**

Run: `npm test`
Expected: 전체 PASS

```bash
git add -A
git commit -m "docs: add CLAUDE.md and README"
```
