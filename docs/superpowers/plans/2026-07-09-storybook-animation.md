# 동화책 애니메이션 생성기 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 페이지별 대본 + 캐릭터 레퍼런스로 삽화(Krea 2)·애니메이션(Wan 2.2)·내레이션(Voicebox)을 생성/업로드하고 ffmpeg로 합쳐 완성 동화 영상을 만드는 웹앱을, 기존 comfy_test 테스트벤치에 확장.

**Architecture:** Express 서버(3333)가 ComfyUI(8188)·Voicebox(17493)를 오케스트레이션. `lib/storybook.mjs`가 페이지별 파이프라인(삽화→input/ 복사→애니메이션→내레이션→ffmpeg 합성)을 **순차** 실행하며, 12GB VRAM 경합을 피하려 Voicebox 단계 전 `comfy.freeMemory()`로 ComfyUI를 언로드. 각 에셋은 생성 또는 업로드(오디오는 none). 프론트는 기존 vanilla JS에 "동화책" 탭 추가.

**Tech Stack:** Node.js 20+ (ESM, `node:test`), express, ws, busboy, ffmpeg/ffprobe. ComfyUI(Krea 2 Turbo + Krea2Edit, Wan 2.2 5B TI2V), Voicebox(FastAPI, Qwen3-TTS).

**Spec:** `docs/superpowers/specs/2026-07-09-storybook-animation-design.md`

**전제:** ComfyUI `C:\ComfyUI_windows_portable`(RTX 4070 12GB). 스펙의 Krea2Edit 노드명·Voicebox REST 계약은 **잠정값** — Chunk 0에서 실검증 후 Chunk 1 코드에 확정 반영.

---

## Chunk 0: 환경 준비 (Phase 0)

TDD 대상 아님 — 조작·검증 체크리스트. 각 항목의 결과(확정된 노드명/엔드포인트/경로)를 이 문서 하단 "Chunk 0 확정값" 표에 기록하고, Chunk 1~4는 그 값을 사용한다.

> ⚠️ **Phase 0은 사람/머신 접근 필요:** ComfyUI ≥0.26 업데이트, ~37GB 모델 다운로드, Voicebox 풀빌드(Bun/Rust/Python/just)와 실서비스 검증은 자율 subagent가 무인으로 완주하기 어렵다. **자동 실행 시 이 청크는 사람이 수행하거나 감독**하고, 완료 후 "Chunk 0 확정값" 표를 채운다.
> 🚧 **하드 게이트:** "Chunk 0 확정값" 표의 확정값 열이 비어 있으면 **Chunk 1의 빌더 코드/테스트를 작성하지 말 것** — 잠정값으로 green이 나면 스킵을 눈치채지 못한다.

### Task 0.1: 백업 & ComfyUI 업데이트 (≥0.26.0)

- [ ] **Step 0.1.1: 현재 상태 스냅샷**

Run: `curl -s http://127.0.0.1:8188/system_stats` → `comfyui_version` 기록(현재 0.19.3). 기존 테스트벤치 회귀 확인용으로 `npm test` 통과 확인.

- [ ] **Step 0.1.2: ComfyUI 업데이트**

`C:\ComfyUI_windows_portable\update\update_comfyui.bat` 실행(또는 ComfyUI-Manager). 완료 후 재기동:
`cd /c/ComfyUI_windows_portable && ./python_embeded/python.exe -s ComfyUI/main.py --windows-standalone-build --fast fp16_accumulation` (백그라운드).
Expected: `system_stats`의 `comfyui_version` ≥ 0.26.0.

- [ ] **Step 0.1.3: 기존 테스트벤치 회귀 확인**

기존 FLUX/Wan2.1 워크플로우가 여전히 유효한지 확인 — 테스트벤치 서버로 이미지 1장 생성해 done 확인(스펙 리스크 1). 실패 시 업데이트 롤백 검토.

### Task 0.2: 모델 자동 다운로드 스크립트

**Files:** Create: `scripts/setup-models.mjs`, `lib/download.mjs`

- [ ] **Step 0.2.1: 다운로드 유틸 작성 (`lib/download.mjs`)**

스트리밍 다운로드 + 크기 검증 + 존재 시 스킵. 순수하게 테스트 가능한 URL/경로 매핑 함수 `hfResolveUrl(repo, path)`와 실제 다운로더 `downloadTo(url, destPath, expectedBytes?)` 분리.

```js
// lib/download.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export const hfResolveUrl = (repo, filePath) =>
  `https://huggingface.co/${repo}/resolve/main/${filePath.split('/').map(encodeURIComponent).join('/')}`;

export async function downloadTo(url, destPath, { minBytes = 0 } = {}) {
  // 이미 받아둔 파일은 스킵(크기 기준이 있으면 그 이상일 때만). minBytes=0이면 존재만으로 스킵.
  if (fs.existsSync(destPath) && fs.statSync(destPath).size >= minBytes) {
    return { skipped: true, destPath };
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${url}`);
  const tmp = `${destPath}.part`;
  await pipeline(res.body, fs.createWriteStream(tmp));
  fs.renameSync(tmp, destPath);
  return { skipped: false, destPath };
}
```

- [ ] **Step 0.2.2: `hfResolveUrl` 단위 테스트**

**Files:** Test: `test/download.test.mjs`

```js
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
```

Run: `node --test test/download.test.mjs` → PASS.

- [ ] **Step 0.2.3: 다운로드 매니페스트 스크립트 (`scripts/setup-models.mjs`)**

스펙 §setup-models.mjs 표의 파일 목록을 매니페스트로 정의하고 `downloadTo`로 순차 다운로드. ComfyUI 루트는 `C:\ComfyUI_windows_portable\ComfyUI`. 각 파일 → 지정 폴더. 실행: `node scripts/setup-models.mjs`.
Expected: Krea2(turbo fp8, qwen3vl, vae, style LoRA), Krea2 identity-edit LoRA, Wan2.2(5B ti2v, umt5, wan2.2 vae)가 올바른 폴더에 존재. (대용량 — 네트워크 따라 장시간.)

- [ ] **Step 0.2.4: Krea2Edit 커스텀노드 설치**

Run: `git clone https://github.com/lbouaraba/comfyui-krea2edit C:/ComfyUI_windows_portable/ComfyUI/custom_nodes/comfyui-krea2edit` 후 ComfyUI 재기동.
Expected: `curl -s http://127.0.0.1:8188/object_info/Krea2EditModelPatch` 가 노드 스키마 반환(정확한 노드명 확인).

- [ ] **Step 0.2.5: 노드명·모델명 확정 기록**

`curl -s http://127.0.0.1:8188/object_info/UNETLoader` 등으로 실제 설치된 파일명·Krea2Edit 노드 입력 배선을 확인해 하단 "Chunk 0 확정값"에 기록.

### Task 0.3: Voicebox 설치 + 헤드리스 기동 + 계약 검증

- [ ] **Step 0.3.1: 의존성 설치**

Bun, Rust(rustup), Python 3.11+, WebView2, `just` 설치. `git clone https://github.com/jamiepine/voicebox` 후 `cd voicebox && just setup-python`(백엔드만).

- [ ] **Step 0.3.2: 헤드리스 백엔드 기동**

Run: `just dev-backend` (또는 `python -m backend.main --host 127.0.0.1 --port 17493`), 백그라운드.
Expected: `curl -s http://127.0.0.1:17493/health` OK. `http://127.0.0.1:17493/docs` 접근 가능.

- [ ] **Step 0.3.3: REST 계약 실검증 (B2)**

`/docs`(OpenAPI json: `curl -s http://127.0.0.1:17493/openapi.json`)에서 실제 필드 확인:
- `POST /profiles` body 필드, `POST /profiles/{id}/samples` multipart 필드(`file`, `reference_text`)
- `POST /generate` / `POST /generate/stream` body·응답 형식(WAV 스트림 여부)
- 한국어 `engine`/`language`/`model_size` 값
하단 "Chunk 0 확정값"에 실제 스키마 기록. Chunk 1의 `voicebox.mjs`는 이 값을 사용.

- [ ] **Step 0.3.4: 한국어 TTS 스모크**

프로필 생성 → 레퍼런스 오디오+대본 업로드 → `POST /generate/stream`으로 한국어 문장 WAV 저장. 재생 확인.

### Task 0.4: ffmpeg/ffprobe 확인 + VRAM 해제 확인

- [ ] **Step 0.4.1: ffmpeg/ffprobe 확보**

Run: `ffmpeg -version; ffprobe -version`. 없으면 설치(시스템 PATH) 후 경로 기록.

- [ ] **Step 0.4.2: `POST /free` 동작 확인 (B1)**

ComfyUI로 삽화 1장 생성(모델 로드) 후 `curl -s -X POST http://127.0.0.1:8188/free -H "Content-Type: application/json" -d '{"unload_models":true,"free_memory":true}'` → `system_stats`의 `vram_free` 증가 확인.

- [ ] **Step 0.4.3: Chunk 0 종료 기준 확인**

스펙 Phase 0 종료 기준 ①~⑤ 모두 충족: Krea2Edit 노드명 확정 / Voicebox 계약 검증 / freeMemory 동작 / 실제 캐릭터 Identity Edit 일관성 검증 / 각 서비스 도달. **④ 일관성 미흡 시 사용자와 재협의(리스크 3).**

- [ ] **Step 0.4.4: Commit (스크립트/문서)**

```bash
git add scripts/setup-models.mjs lib/download.mjs test/download.test.mjs docs/superpowers/plans/2026-07-09-storybook-animation.md
git commit -m "feat: add model setup script and Phase 0 verified values"
```

---

## Chunk 1: 워크플로우 빌더 + 클라이언트 (Phase 1)

> 🚧 **선행 게이트:** 시작 전 "Chunk 0 확정값" 표가 채워졌는지 확인. 비어 있으면 STOP하고 Chunk 0을 먼저 완료. 아래 상수·엔드포인트는 **확정값으로 교체**한 뒤 테스트와 함께 커밋.

### Task 1.1: Krea 2 삽화 빌더 (TDD)

**Files:** Modify: `lib/workflows.mjs`; Test: `test/workflows.test.mjs`

> Chunk 0 확정값의 실제 노드명/파일명으로 아래 상수를 맞춘다. 잠정값은 그대로 두되 테스트도 함께 갱신.

- [ ] **Step 1.1.1: 실패 테스트 작성**

```js
import { buildKrea2Illustration } from '../lib/workflows.mjs';

test('buildKrea2Illustration: 기본값 그래프', () => {
  const g = buildKrea2Illustration({ prompt: 'a fox', seed: 5 });
  assert.equal(g['1'].class_type, 'UNETLoader');
  assert.equal(g['1'].inputs.unet_name, 'krea2_turbo_fp8_scaled.safetensors');
  assert.equal(g['2'].class_type, 'CLIPLoader');
  assert.equal(g['2'].inputs.clip_name, 'qwen3vl_4b_fp8_scaled.safetensors');
  assert.equal(g['3'].class_type, 'VAELoader');
  assert.equal(g['3'].inputs.vae_name, 'qwen_image_vae.safetensors');
  const enc = Object.values(g).find((n) => n.class_type === 'CLIPTextEncode');
  assert.equal(enc.inputs.text, 'a fox');
  const ks = Object.values(g).find((n) => n.class_type === 'KSampler');
  assert.equal(ks.inputs.seed, 5);
  assert.equal(ks.inputs.steps, 8);
  assert.ok(Object.values(g).some((n) => n.class_type === 'SaveImage'));
});

test('buildKrea2Illustration: characterRefName 지정 시 Krea2Edit 노드 삽입', () => {
  const g = buildKrea2Illustration({ prompt: 'a fox', seed: 5, characterRefName: 'char.png' });
  assert.ok(Object.values(g).some((n) => n.class_type === 'LoadImage' && n.inputs.image === 'char.png'));
  assert.ok(Object.values(g).some((n) => n.class_type === 'Krea2EditModelPatch'));
});

test('buildKrea2Illustration: prompt/seed 검증', () => {
  assert.throws(() => buildKrea2Illustration({ seed: 1 }), /prompt/);
  assert.throws(() => buildKrea2Illustration({ prompt: 'x' }), /seed/);
  assert.throws(() => buildKrea2Illustration({ prompt: 'x', seed: 1.5 }), /seed/);
});
```

- [ ] **Step 1.1.2: 테스트 실패 확인** — Run: `node --test test/workflows.test.mjs` → FAIL(함수 없음).

- [ ] **Step 1.1.3: `buildKrea2Illustration` 구현**

기존 `assertSeed` 재사용. Krea 2 Turbo t2i 그래프(UNETLoader+CLIPLoader(Qwen3-VL)+VAELoader+CLIPTextEncode+KSampler(steps 8, distilled cfg)+VAEDecode+SaveImage). `characterRefName` 지정 시 `LoadImage`+`Krea2EditModelPatch`+`Krea2EditGroundedEncode`로 레퍼런스를 model/conditioning에 주입(Chunk 0 확정 배선). `style` LoRA 옵션. 기본 `width=1280,height=704,steps=8`.

- [ ] **Step 1.1.4: 테스트 통과 확인** — Run: `node --test test/workflows.test.mjs` → PASS.

- [ ] **Step 1.1.5: Commit** — `git commit -m "feat: add Krea 2 illustration workflow builder"`

### Task 1.2: Wan 2.2 I2V 빌더 (TDD)

**Files:** Modify: `lib/workflows.mjs`; Test: `test/workflows.test.mjs`

- [ ] **Step 1.2.1: 실패 테스트 작성**

```js
import { buildWan22I2V } from '../lib/workflows.mjs';

test('buildWan22I2V: 기본값(5B TI2V) 그래프', () => {
  const g = buildWan22I2V({ imageName: 'src.png', motionPrompt: 'gentle wind', seed: 7 });
  assert.equal(g['1'].inputs.unet_name, 'wan2.2_ti2v_5B_fp16.safetensors');
  assert.equal(g['2'].inputs.clip_name, 'umt5_xxl_fp8_e4m3fn_scaled.safetensors');
  assert.equal(g['2'].inputs.type, 'wan');
  assert.equal(g['3'].inputs.vae_name, 'wan2.2_vae.safetensors');
  assert.ok(Object.values(g).some((n) => n.class_type === 'LoadImage' && n.inputs.image === 'src.png'));
  const wiv = Object.values(g).find((n) => n.class_type === 'WanImageToVideo');
  assert.equal(wiv.inputs.length, 121);
  assert.equal(wiv.inputs.width, 1280);
  assert.equal(wiv.inputs.height, 704);
  const cv = Object.values(g).find((n) => n.class_type === 'CreateVideo');
  assert.equal(cv.inputs.fps, 24);
  assert.ok(Object.values(g).some((n) => n.class_type === 'SaveVideo'));
});

test('buildWan22I2V: 필수값 누락 throw', () => {
  assert.throws(() => buildWan22I2V({ motionPrompt: 'x', seed: 1 }), /imageName/);
  assert.throws(() => buildWan22I2V({ imageName: 'a.png', seed: 1 }), /motionPrompt/);
  assert.throws(() => buildWan22I2V({ imageName: 'a.png', motionPrompt: 'x' }), /seed/);
});
```

- [ ] **Step 1.2.2: 실패 확인** → FAIL.

- [ ] **Step 1.2.3: `buildWan22I2V` 구현** — Wan 2.2 5B TI2V 그래프(UNETLoader+CLIPLoader(wan)+VAELoader(wan2.2_vae)+LoadImage+CLIPTextEncode(±)+WanImageToVideo(width 1280,height 704,length 121)+KSampler+VAEDecode+CreateVideo(fps 24 — `fps` 파라미터를 실제로 배선)+SaveVideo). `WAN_NEGATIVE` 재사용. `assertSeed`.

- [ ] **Step 1.2.4: 통과 확인** → PASS.

- [ ] **Step 1.2.5: Commit** — `git commit -m "feat: add Wan 2.2 I2V workflow builder"`

### Task 1.3: Voicebox 클라이언트

**Files:** Create: `lib/voicebox.mjs`

> Chunk 0에서 검증한 실제 엔드포인트/필드로 구현.

- [ ] **Step 1.3.1: `lib/voicebox.mjs` 구현** — `isAlive()`(`GET /health`), `ensureProfile({name, refAudioPath, refText, language, engine})`(없으면 `POST /profiles` → `POST /profiles/{id}/samples` multipart), `generate({profileId, text, language, engine, model_size}, destWavPath)`(`POST /generate/stream` → 파일 저장). base `http://127.0.0.1:17493`.

- [ ] **Step 1.3.2: 문법 확인** — Run: `node --check lib/voicebox.mjs` → 에러 없음. (실서비스 검증은 Chunk 2 스모크.)

- [ ] **Step 1.3.3: Commit** — `git commit -m "feat: add Voicebox TTS client"`

### Task 1.4: ffmpeg compose (인자 구성 TDD)

**Files:** Create: `lib/compose.mjs`; Test: `test/compose.test.mjs`

- [ ] **Step 1.4.1: 실패 테스트 작성 (인자 구성 순수 함수)**

```js
import { muxArgs, concatArgs } from '../lib/compose.mjs';

test('muxArgs: 영상이 오디오보다 짧음 → 패딩(tpad/loop)', () => {
  const args = muxArgs({ video: 'v.mp4', audio: 'a.wav', audioDur: 6, videoDur: 5, dest: 'o.mp4' });
  assert.ok(args.includes('v.mp4') && args.includes('a.wav') && args.includes('o.mp4'));
  assert.ok(args.some((a) => /tpad|loop/.test(a)));
});

test('muxArgs: 영상이 오디오보다 김 → 트림', () => {
  const args = muxArgs({ video: 'v.mp4', audio: 'a.wav', audioDur: 4, videoDur: 6, dest: 'o.mp4' });
  // 오디오 길이로 자름: -t 4 또는 -shortest 등 트림 신호
  assert.ok(args.some((a) => /-t|-shortest|trim/.test(a)));
});

test('muxArgs: audio=none → 영상 그대로(길이 변형 없음)', () => {
  const args = muxArgs({ video: 'v.mp4', audio: null, dest: 'o.mp4' });
  assert.ok(args.includes('v.mp4') && args.includes('o.mp4'));
  assert.ok(!args.some((a) => String(a).endsWith('.wav')));
  assert.ok(!args.some((a) => /tpad|loop/.test(a)));
});

test('concatArgs: 모든 입력 클립이 인자에 포함 + dest', () => {
  const args = concatArgs(['a.clip.mp4', 'b.clip.mp4'], 'final.mp4');
  assert.ok(args.includes('a.clip.mp4') && args.includes('b.clip.mp4') && args.includes('final.mp4'));
});
```

- [ ] **Step 1.4.2: 실패 확인** → FAIL.

- [ ] **Step 1.4.3: 구현** — `muxArgs`/`concatArgs`(순수, ffmpeg argv 배열 반환), `probeDuration(path)`(ffprobe 실행), `muxPageClip()`/`concatClips()`(spawn 실행). audio-authoritative/none 규칙(스펙 §compose). **concat은 `filter_complex concat`으로 구현**(입력 파일들을 `-i`로 나열 → argv 순수 유지, list-file 부작용 없음). 트림은 `-t <audioDur>`, 패딩은 `tpad=stop_mode=clone`.

- [ ] **Step 1.4.4: 통과 확인** → PASS.

- [ ] **Step 1.4.5: Commit** — `git commit -m "feat: add ffmpeg compose (mux/concat) with arg tests"`

---

## Chunk 2: 오케스트레이터 + 서버 (Phase 2)

### Task 2.1: 기반 리팩터 — resolveSeed 추출 + comfy.freeMemory (오케스트레이터 선행)

**Files:** Create: `lib/seed.mjs`; Modify: `server.mjs`, `lib/comfy.mjs`

> 오케스트레이터가 `resolveSeed`·`freeMemory`를 import하므로 **Task 2.2보다 먼저** 존재해야 함.

- [ ] **Step 2.1.1: `resolveSeed`를 `lib/seed.mjs`로 추출** — server.mjs의 `resolveSeed`를 `lib/seed.mjs`로 옮기고 export, server.mjs는 import로 교체(동작 불변).
- [ ] **Step 2.1.2: `lib/comfy.mjs`에 `freeMemory({unloadModels=true, freeMemory=true})` 추가** — `POST /free` `{unload_models, free_memory}` 호출(Chunk 0 확정 형식).
- [ ] **Step 2.1.3: 기존 테스트 회귀 확인** — Run: `npm test` → 전체 PASS.
- [ ] **Step 2.1.4: Commit** — `git commit -m "refactor: extract resolveSeed to lib/seed, add comfy.freeMemory"`

### Task 2.2: ComfyUI 페이지 러너 (전용 러너, B2)

**Files:** Create: `lib/comfyrun.mjs`

기존 `runJob`(server.mjs)은 단일 제출→`outputs/{job.id}.ext` 1개 출력에 하드코딩 → 재사용 불가. 워크플로우를 받아 **제출+WS 진행률+히스토리 폴링 완료판정+지정 경로로 다운로드**하는 러너를 분리.

- [ ] **Step 2.2.1: `runComfyWorkflow(workflow, { destPath, onProgress })` 구현** — `comfy.submit`→`trackProgress`(onProgress)→히스토리 폴링(기존 완료판정 로직 재사용)→`extractOutputs` 첫 파일을 `comfy.downloadOutput(file, destPath)`로 저장. 반환 `{ destPath }`. 출력 명명은 호출측(오케스트레이터)이 `outputs/books/<id>/page-XX.png|mp4`로 지정.
- [ ] **Step 2.2.2: 문법 확인** — `node --check lib/comfyrun.mjs`. (완료판정·다운로드는 Task 2.5 수직 슬라이스에서 실검증.)
- [ ] **Step 2.2.3: Commit** — `git commit -m "feat: add dedicated ComfyUI workflow runner with output path"`

### Task 2.3: storybook 오케스트레이터 (DI TDD)

**Files:** Create: `lib/storybook.mjs`; Test: `test/storybook.test.mjs`

comfy/voicebox/compose를 **주입(deps)**받아 순수 순차 로직 테스트. deps = `{ generateIllustration, generateVideo, generateNarration, composeClip, concatClips, uploadInput, freeMemory }`. (`concatClips`도 주입 — DI 순수성 유지.)

- [ ] **Step 2.3.1: 실패 테스트 작성 (runPage: 소스 분기·의존성·hop·freeMemory 순서)**

```js
import { runPage, runBook } from '../lib/storybook.mjs';

function stubDeps(overrides = {}) {
  const calls = [];
  const rec = (name) => async () => { calls.push(name); return `${name}.out`; };
  return { calls, deps: {
    generateIllustration: rec('illu'), generateVideo: rec('vid'),
    generateNarration: rec('narr'), composeClip: rec('compose'),
    concatClips: rec('concat'),
    uploadInput: () => { calls.push('upload'); return 'in.png'; },
    freeMemory: async () => { calls.push('free'); },
    ...overrides,
  } };
}

test('runPage: 모두 generate → freeMemory가 내레이션 전에 호출, 삽화 input/ hop', async () => {
  const { calls, deps } = stubDeps();
  const page = { illustrationSource: 'generate', videoSource: 'generate', audioSource: 'generate', text: 't', seed: 1 };
  await runPage(page, { characterRef: 'c.png', bookDir: 'd' }, deps);
  assert.ok(calls.indexOf('free') < calls.indexOf('narr')); // Voicebox 전 VRAM 해제
  assert.ok(calls.includes('upload'));
});

test('runPage: characterRef 있으면 캐릭터 레퍼런스도 input/ hop', async () => {
  const uploads = [];
  const { deps } = stubDeps({ uploadInput: (p) => { uploads.push(p); return 'in.png'; } });
  const page = { illustrationSource: 'generate', videoSource: 'generate', audioSource: 'none', text: 't', seed: 1 };
  await runPage(page, { characterRef: 'c.png', bookDir: 'd' }, deps);
  assert.ok(uploads.some((p) => String(p).includes('c.png'))); // 캐릭터 레퍼런스 hop
});

test('runPage: 삽화 upload + 영상 generate → 업로드 삽화 hop, 생성 안 함, audio none', async () => {
  const { calls, deps } = stubDeps();
  const page = { illustrationSource: 'upload', illustrationFile: 'u.png', videoSource: 'generate', audioSource: 'none', seed: 1 };
  await runPage(page, { bookDir: 'd' }, deps);
  assert.ok(!calls.includes('illu'));
  assert.ok(calls.includes('upload') && calls.includes('vid'));
  assert.ok(!calls.includes('narr'));
});

test('runPage: 영상 generate인데 삽화 없음 → throw', async () => {
  const { deps } = stubDeps();
  const page = { illustrationSource: 'upload', illustrationFile: null, videoSource: 'generate', audioSource: 'none', seed: 1 };
  await assert.rejects(runPage(page, { bookDir: 'd' }, deps), /illustration/);
});
```

- [ ] **Step 2.3.2: 실패 확인** → FAIL.

- [ ] **Step 2.3.3: `runPage` 구현** — 소스 분기, 의존성 검증(영상 generate엔 삽화 필수), 캐릭터 레퍼런스+삽화 PNG `uploadInput` hop, freeMemory를 ComfyUI 단계 후·Voicebox 전 호출, 페이지 상태 전이. seed는 호출 전 확정(`resolveSeed`).

- [ ] **Step 2.3.4: 통과 확인** → PASS.

- [ ] **Step 2.3.5: 실패 테스트 작성 (runBook: 에러 격리·상태 전이, B1)**

```js
test('runBook: 한 페이지 실패해도 book 계속, 실패 페이지 error 표기, 이후 페이지 실행', async () => {
  const ran = [];
  const deps = {
    ...stubDeps().deps,
    // 2번째 페이지의 삽화에서만 throw
    generateIllustration: async (page) => { ran.push(page.id); if (page.id === 'p2') throw new Error('boom'); return 'illu.out'; },
  };
  const book = { id: 'b', pages: [
    { id: 'p1', illustrationSource: 'generate', videoSource: 'generate', audioSource: 'none', seed: 1 },
    { id: 'p2', illustrationSource: 'generate', videoSource: 'generate', audioSource: 'none', seed: 2 },
    { id: 'p3', illustrationSource: 'generate', videoSource: 'generate', audioSource: 'none', seed: 3 },
  ] };
  const persisted = [];
  await runBook(book, { persist: (b) => persisted.push(JSON.parse(JSON.stringify(b))) }, deps);
  assert.deepEqual(ran, ['p1', 'p2', 'p3']); // 실패 후에도 p3 실행
  assert.equal(book.pages[0].status, 'done');
  assert.equal(book.pages[1].status, 'error');
  assert.match(book.pages[1].error, /boom/);
  assert.equal(book.pages[2].status, 'done');
});

test('runBook: 전 페이지 성공 → concatClips로 final.mp4, book done', async () => {
  const { calls, deps } = stubDeps();
  const book = { id: 'b', pages: [
    { id: 'p1', illustrationSource: 'generate', videoSource: 'generate', audioSource: 'none', seed: 1 },
    { id: 'p2', illustrationSource: 'generate', videoSource: 'generate', audioSource: 'none', seed: 2 },
  ] };
  await runBook(book, { persist: () => {} }, deps);
  assert.ok(calls.includes('concat')); // 전 페이지 성공 시 concat 호출
  assert.equal(book.status, 'done');
});
```

- [ ] **Step 2.3.6: 실패 확인** → FAIL.

- [ ] **Step 2.3.7: `runBook` 구현** — 페이지 순차 실행, 각 페이지 `try/catch`로 격리(실패 시 `status='error'`, `error` 기록, 다음 페이지 계속), 단계마다 `persist` 콜백. **전 페이지 성공 시 주입된 `concatClips`로 `final.mp4` 생성하고 book `status='done'`**; 실패 페이지가 있으면 concat 스킵하고 book `status='error'`.

- [ ] **Step 2.3.8: 통과 확인** → PASS.

- [ ] **Step 2.3.9: Commit** — `git commit -m "feat: add storybook orchestrator (runPage/runBook) with DI tests"`

### Task 2.4: 서버 라우트 — book CRUD + 업로드

**Files:** Modify: `server.mjs`

- [ ] **Step 2.4.1: book 저장소 + CRUD/업로드 라우트** — `data/books.json`(`readBooks`/`writeBooks`), 라우트: `GET/POST /api/books`, `GET/PUT/DELETE /api/books/:id`, `POST /api/books/:id/character`(→`outputs/books/<id>/char.*`), `POST /api/books/:id/pages/:pid/upload`(`kind`=illustration|video|audio → `outputs/books/<id>/`, 타입·크기 검증: 이미지/오디오 ~20MB, 영상 ~500MB, 소스 필드 갱신), `GET /api/storybook/status`(comfy/voicebox/ffmpeg 도달·모델 설치 여부), `POST /api/voicebox/start`.
- [ ] **Step 2.4.2: 서버 기동 스모크** — `node --check server.mjs` 후 기동, `curl /api/storybook/status`가 각 서비스 false로 응답, `/api/books` `[]`, book 생성·조회 동작.
- [ ] **Step 2.4.3: Commit** — `git commit -m "feat: add book CRUD and asset upload routes"`

### Task 2.5: 서버 라우트 — 생성/진행률 + 수직 슬라이스 E2E

**Files:** Modify: `server.mjs`

- [ ] **Step 2.5.1: 생성·진행률 라우트** — `POST /api/books/:id/pages/:pid/generate`, `POST /api/books/:id/generate`(오케스트레이터 `runBook`을 `lib/comfyrun.mjs` 러너·voicebox·compose deps로 백그라운드 구동), `GET /api/books/:id/progress`(스펙 진행률 shape: `{ bookId, currentPageIndex, totalPages, currentStage, stageProgress, perPageStatus[] }`, 인메모리 book-job에서 노출).
- [ ] **Step 2.5.2: 1페이지 수직 슬라이스 E2E(실서비스)** — ComfyUI+Voicebox 기동 상태에서 book 1개·페이지 1개(모두 generate) 생성 → 삽화·영상·내레이션·합성·`page-01.clip.mp4` 생성 확인, `books.json` 기록, `/progress` 폴링 동작. **여기서 `lib/comfyrun.mjs` 완료판정·다운로드가 실검증됨.**
- [ ] **Step 2.5.3: Commit** — `git commit -m "feat: add generate/progress routes and vertical-slice E2E"`

---

## Chunk 3: 프론트엔드 "동화책" 탭 (Phase 3)

**Files:** Modify: `public/index.html`, `public/style.css`, `public/app.js`

- [ ] **Step 3.1: 탭 + book/페이지 UI 마크업** — nav에 "동화책" 탭 추가, book 생성/선택, 캐릭터 레퍼런스 업로드, 페이지 리스트(추가/삭제), 페이지 카드에 대본·삽화 프롬프트·모션 프롬프트 입력.
- [ ] **Step 3.2: 에셋별 생성/업로드 토글** — 각 페이지 카드의 삽화·영상·오디오 슬롯마다 생성/업로드(오디오는 none 포함) 라디오 + 파일 입력 + 현재 소스·미리보기·상태 표시.
- [ ] **Step 3.3: 생성·진행률 배선** — "페이지 생성"/"전체 생성" → API 호출, `GET /api/books/:id/progress` 폴링으로 페이지·단계 진행 표시(기존 잡바 스타일 재사용), 완료 시 미리보기.
- [ ] **Step 3.4: 육안 확인** — 서버 기동 후 프리뷰로 탭 전환·폼·토글·업로드 UI·콘솔 에러 없음 확인.
- [ ] **Step 3.5: Commit** — `git commit -m "feat: add storybook tab (pages, per-asset generate/upload)"`

---

## Chunk 4: 전체 합성 + E2E 스모크 + 문서 (Phase 4)

- [ ] **Step 4.1: 전체 book 생성 → concat** — 2페이지 book 전체 생성 → 페이지 클립들이 `concatClips`로 `final.mp4` 생성, UI에서 완성 영상 재생.
- [ ] **Step 4.2: 업로드 경로 E2E** — 삽화 업로드+영상 생성+오디오 업로드 조합, 완성 영상 업로드+오디오 none 조합 각각 검증.
- [ ] **Step 4.3: 실패 격리 확인** — 한 페이지 의도적 실패(잘못된 프롬프트/서비스 중단) 시 book이 계속 진행하고 실패 페이지가 표시되는지.
- [ ] **Step 4.4: 문서화** — 루트 `CLAUDE.md`에 동화책 모듈 요약 추가(모듈화 규칙), `README.md`에 사용법·소요시간·서비스 기동 안내(ComfyUI/Voicebox) 추가.
- [ ] **Step 4.5: 전체 테스트 + Commit** — Run: `npm test` → 전체 PASS. `git commit -m "docs: document storybook module; final smoke fixes"`

---

## Chunk 0 확정값 (Phase 0에서 채움)

| 항목 | 잠정값 | 확정값(실검증 2026-07-09) |
|---|---|---|
| ComfyUI 버전 | ≥0.26.0 | **0.27.0** ✓ (0.19.3→업데이트 완료, 기존 노드 회귀 OK) |
| Krea2 unet | krea2_turbo_fp8_scaled | **`diffusion_models/krea2_turbo_fp8_scaled.safetensors`** (HF repo `Comfy-Org/Krea-2`, 하위폴더!) |
| Krea2 text encoder | qwen3vl_4b_fp8_scaled | **`text_encoders/qwen3vl_4b_fp8_scaled.safetensors`**, CLIPLoader **type=`krea2`** |
| Krea2 vae | qwen_image_vae | **`vae/qwen_image_vae.safetensors`** |
| Krea2 style LoRA | krea2_kidsdrawing | **`loras/krea2_kidsdrawing.safetensors`** (LoraLoaderModelOnly) |
| Krea2 t2i 샘플러 | — | **KSampler steps=8, cfg=1, euler, simple, denoise=1**; 음성=**ConditioningZeroOut**; **EmptyLatentImage** |
| Krea2Edit 노드/배선 | Krea2EditModelPatch, Krea2EditGroundedEncode | **`Krea2EditModelPatch(model, source_latent)`→MODEL** (ref를 VAEEncode한 latent); **`Krea2EditGroundedEncode(clip, prompt, image, grounding_px=768)`→CONDITIONING** (CLIPTextEncode 대체); 노드 로드 확인 필요(다운로드 후 재기동) |
| Wan2.2 unet | wan2.2_ti2v_5B_fp16 | `Comfy-Org/Wan_2.2_ComfyUI_Repackaged/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors` (다운로드 중) |
| Wan2.2 vae | wan2.2_vae | `split_files/vae/wan2.2_vae.safetensors` (다운로드 중) |
| Voicebox base | http://127.0.0.1:17493 | 설치 중(Python **3.12** 필수 — 3.13은 kokoro 비호환), `/docs`로 계약 검증 예정 |
| Voicebox 프로필 생성 | POST /profiles → POST /profiles/{id}/samples | 검증 예정 |
| Voicebox 생성 | POST /generate/stream (WAV) | 검증 예정 |
| 한국어 설정 | engine=qwen, language=ko, model_size=1.7B | 검증 예정 |
| ffmpeg/ffprobe 경로 | PATH | 확인 예정 |
| ComfyUI free | POST /free {unload_models,free_memory} | **200 OK** ✓ |
