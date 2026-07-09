# 동화책 애니메이션 생성기 Design (comfy_test 확장)

**작성일:** 2026-07-09
**상태:** 설계 승인됨 → 스펙 리뷰 대기

## 목표

페이지별 대본과 캐릭터 레퍼런스 이미지를 입력하면, 각 페이지의 **삽화(Krea 2) → 애니메이션(Wan 2.2) → 내레이션(Voicebox TTS)** 을 생성하고 ffmpeg로 합쳐, 페이지 클립들을 이어붙인 **완성된 애니메이션 동화 영상**을 만드는 로컬 웹앱. 기존 `comfy_test`(ComfyUI 테스트벤치) 리포지토리를 확장한다.

## 설계 결정 (확정)

- **입출력:** 사용자가 페이지별 대본(내레이션/장면 묘사) + 캐릭터 레퍼런스 이미지를 제공 → 페이지마다 삽화·애니메이션·내레이션 생성 → 이어붙여 완성 영상 출력.
- **조작:** 웹 UI(기존 테스트벤치에 "동화책" 탭 추가).
- **도구(확정):** 이미지 = **Krea 2 Turbo**, 영상 = **Wan 2.2 I2V**, TTS = **Voicebox**. 대체 없음.
- **캐릭터 일관성:** **레퍼런스 이미지 기반(Krea 2 Identity Edit LoRA + `ComfyUI-Krea2Edit`)** — 학습 불필요. 캐릭터별 LoRA 학습은 향후 업그레이드로 문서화만.
- **코드베이스:** 기존 `comfy_test` 리포 확장(신규 리포 아님).
- **모델:** 필요한 모델은 셋업 스크립트가 자동 다운로드.
- **콘텐츠 소스 = 생성 또는 업로드(에셋별 선택):** 페이지의 각 에셋(삽화 이미지 / 애니메이션 영상 / 내레이션 오디오)은 **생성(기본)** 또는 **사용자 업로드**를 개별 선택할 수 있다. 예: 삽화만 직접 그린 이미지를 올리고 애니메이션·내레이션은 생성, 또는 완성 영상만 올리고 내레이션은 생성 등. **오디오는 추가로 `none`(별도 내레이션 없이 영상 자체 오디오 사용/무음) 허용** — 완성 영상을 그대로 쓰는 경우를 위함.

## 실환경 (기동하여 확인)

- GPU: **RTX 4070, VRAM 12GB**, 시스템 RAM 34GB
- ComfyUI **0.19.3** (PyTorch 2.11+cu130, embedded Python 3.13) — 포터블 `C:\ComfyUI_windows_portable`
- 기설치: `flux1-dev-fp8`, `sd_xl_base_1.0`, `wan2.1_i2v_480p_14B_fp8`, 커스텀노드 ComfyUI-Manager·controlnet_aux
- **제약:** Krea 2는 ComfyUI **≥ 0.26.0** 필요 → 업데이트 필수. 12GB VRAM → 단계별 순차 실행, 모델 언로드 전제.

## 아키텍처

기존 테스트벤치 구조(Express + ComfyUI 클라이언트 + vanilla JS 프론트)를 유지하고 모듈을 추가한다.

### 재사용 (기존)
- `lib/comfy.mjs` — ComfyUI HTTP/WS 클라이언트(submit, 진행률, 히스토리 폴링, 다운로드, input 업로드). 재사용하되 **`freeMemory({ unloadModels=true, freeMemory=true })` 추가**(`POST /free`) — 단계 전환 시 ComfyUI가 VRAM을 해제하도록. B1 참조.
- `lib/workflows.mjs` — 순수 함수 워크플로우 빌더. 신규 빌더 추가.
- `server.mjs` — Express 서버. 라우트/잡 타입 확장.
- `public/` — 잡 추적 UI 재사용, "동화책" 탭 추가.

### 신규 모듈
| 파일 | 책임 |
|---|---|
| `lib/workflows.mjs` (추가) | `buildKrea2Illustration()`, `buildWan22I2V()` 순수 빌더 |
| `lib/voicebox.mjs` | Voicebox REST 클라이언트 (health, ensureProfile, generate) |
| `lib/compose.mjs` | ffmpeg 래퍼 (mux, 영상 길이 맞춤, concat) |
| `lib/storybook.mjs` | book 오케스트레이터 (페이지 파이프라인 + 전체 합성) |
| `scripts/setup-models.mjs` | 모델 자동 다운로드 + Krea2Edit 노드 설치 |

## 컴포넌트 상세

### lib/workflows.mjs — 신규 빌더

**`buildKrea2Illustration({ prompt, characterRefName, style, seed, width=1280, height=704, steps=8 })`**
- 기본 종횡비를 Wan 타깃(1280×704)에 맞춰 삽화→I2V 왜곡 방지. 정사각/세로 등은 옵션이되 book 단위로 삽화·영상 종횡비 일치 권장.
- Krea 2 Turbo(distilled, ~8스텝) 기반 t2i. 노드: `UNETLoader`(`krea2_turbo_fp8_scaled.safetensors`), `CLIPLoader`(`qwen3vl_4b_fp8_scaled.safetensors`, Qwen3-VL 타입), `VAELoader`(`qwen_image_vae.safetensors`), `KSampler`, `VAEDecode`, `SaveImage`.
- 캐릭터 일관성: `characterRefName` 지정 시 `Krea2Edit` 노드(`Krea2EditModelPatch`, `Krea2EditGroundedEncode`)로 레퍼런스 이미지를 latent + Qwen3-VL 인코더에 주입. `LoadImage`로 레퍼런스 로드.
- style LoRA(예: `krea2_kidsdrawing`, `krea2_softwatercolor`) 선택 적용.
- 실제 노드명/배선은 Phase 0에서 ComfyUI ≥0.26 Krea2 템플릿(`image_krea2_turbo_t2i.json`)과 Krea2Edit README로 확정. seed는 정수 확정 필수(기존 `assertSeed` 패턴).

**`buildWan22I2V({ imageName, motionPrompt, seed, width=1280, height=704, frames=121, fps=24 })`**
- 기본 변형 = **Wan 2.2 5B TI2V**(12GB 적합, 네이티브 24fps). 프레임 기본값 **121@24fps ≈ 5s**로 설정(내레이션 길이와 정합; 내레이션이 더 길면 compose에서 패딩). 14B fp8+lightx2v는 대안.
- 5B 경로 노드: `UNETLoader`(`wan2.2_ti2v_5B_fp16.safetensors`), `CLIPLoader`(`umt5_xxl_fp8_e4m3fn_scaled`, wan 타입), `VAELoader`(`wan2.2_vae.safetensors`), `LoadImage`, `WanImageToVideo`, `KSampler`, `VAEDecode`, `CreateVideo`(fps 24), `SaveVideo`.
- 기존 `buildWanI2V`(2.1)는 유지, 신규 빌더로 분리.

### lib/voicebox.mjs — Voicebox 클라이언트 (base `http://127.0.0.1:17493`)
> ⚠️ **아래 REST 계약은 리서치 기반 잠정값** — Phase 0에서 `http://127.0.0.1:17493/docs`(OpenAPI)와 `/health`로 필드명·응답 형태를 실검증한 뒤 확정한다(B2). 특히 프로필 2단계 흐름과 `/generate/stream` 응답 형식.
- `isAlive()` → `GET /health`
- `ensureProfile({ name, refAudioPath, refText, language:'ko', engine:'qwen' })` → 없으면 `POST /profiles`(voice_type `cloned`) 후 `POST /profiles/{id}/samples`(multipart: `file`=레퍼런스 오디오, `reference_text`=대본). profile_id 반환·캐시.
- `generate({ profileId, text, language:'ko', engine:'qwen', model_size:'1.7B' }, destWavPath)` → `POST /generate/stream`(WAV 바이트 직접 수신)로 파일 저장.
- 한국어: `engine=qwen`, `language=ko`. 대괄호 감정태그 금지(qwen은 리터럴 처리).

### lib/compose.mjs — ffmpeg 래퍼
- `muxPageClip(videoPath, audioPath|null, destPath)` — 영상+오디오 합성. 규칙:
  - **오디오 있음(생성 또는 업로드) = 오디오 authoritative:** `ffprobe`로 두 길이 측정 후 **영상을 오디오 길이에 맞추고**(길면 `tpad`/freeze/loop, 짧으면 트림), 새 오디오 트랙으로 교체(업로드 영상의 기존 오디오는 대체됨).
  - **오디오 `none`:** 영상을 그대로 사용(업로드 영상의 자체 오디오 유지, 생성 영상은 무음). 길이 변형 없음.
- `concatClips(clipPaths[], destPath)` — 페이지 클립들을 순서대로 이어붙여 `final.mp4`.
- ffmpeg 인자 구성은 **순수 함수로 분리해 단위테스트**(실제 ffmpeg 실행 없이 인자 문자열 검증). 실행은 스모크에서.
- **`ffmpeg`·`ffprobe` 바이너리** 위치는 Phase 0에서 확인(시스템 PATH 또는 ComfyUI 포터블 번들). 없으면 셋업에서 안내/다운로드.

### lib/storybook.mjs — 오케스트레이터
- book 모델을 `data/books.json`으로 영속(`writeBooks()` read-modify-write 헬퍼, `appendRun` 패턴. **단일 사용자·순차 전제**. `books.json`이 동화책 기록의 단일 원천 — `runs.json`에는 기록하지 않음).
- 페이지별 파이프라인을 **순차**(VRAM 경합 회피) 실행. **각 에셋 단계는 소스(`generate`|`upload`)에 따라 분기** — `upload`면 업로드된 파일을 그대로 사용하고 생성 단계를 건너뜀:
  1. **삽화:** `generate`→Krea2(ComfyUI) → `output/`에서 `outputs/books/<id>/page-XX.png`로 다운로드 / `upload`→업로드 이미지 사용
  2. **애니메이션:** `generate`→ **삽화 PNG를 `comfy.uploadInput()`로 ComfyUI `input/`에 복사**(캐릭터 레퍼런스도 동일 hop) 후 Wan2.2로 `imageName` 지정 → `page-XX.mp4` 다운로드 / `upload`→업로드 영상 사용(이 경우 삽화 단계는 선택)
  3. **내레이션:** `generate`→Voicebox `page-XX.wav` / `upload`→업로드 오디오 사용
  4. **ffmpeg 합성** → `page-XX.clip.mp4` (소스 무관 동일)
- **의존성 검증:** 애니메이션 소스가 `generate`인데 삽화가 없으면 먼저 삽화를 확보(생성/업로드)해야 함.
- **VRAM 해제(B1):** ComfyUI 단계(삽화·애니메이션) 종료 후, **Voicebox 단계 진입 전** `comfy.freeMemory()` 호출로 ComfyUI VRAM을 비운다(크로스 프로세스 OOM 방지). 삽화→애니메이션 사이에도 필요 시 호출.
- **seed:** 오케스트레이터가 페이지별 seed를 **빌더 호출 전 정수로 확정**(`resolveSeed`는 server의 헬퍼, 오케스트레이터에서 재사용/공유). 빌더의 `assertSeed`는 방어선.
- 모든 페이지 완료 후 `concatClips` → `final.mp4`.
- 페이지 단위 상태(`queued|running|done|error`)·재생성 지원. 실패 페이지는 표시하고 book은 계속 진행.

**전용 잡 러너(기존 `runJob` 재사용 불가):** 기존 `runJob`은 단일 ComfyUI 제출→`outputs/{job.id}.ext` 1개 출력에 하드코딩돼 4단계 파이프라인/`outputs/books/<id>/page-XX.*` 명명을 처리 못 함. 오케스트레이터는 submit+진행률+히스토리 폴링+다운로드를 **출력 경로/명명 전략을 받는 신규 러너**로 구동(comfy 제출 로직은 `lib/comfy.mjs`에서 공유). 인메모리 잡 Map·히스토리 폴링 완료판정 패턴만 재사용.

### scripts/setup-models.mjs — 모델 자동 다운로드
HuggingFace `resolve` URL에서 스트리밍 다운로드(재개/크기 검증) → 올바른 ComfyUI 폴더 배치. 필요 파일:

| 파일 | 대상 폴더 | 크기 |
|---|---|---|
| `Comfy-Org/Krea-2` → `krea2_turbo_fp8_scaled.safetensors` | `models/diffusion_models/` | 13.1 GB |
| `Comfy-Org/Krea-2` → `qwen3vl_4b_fp8_scaled.safetensors` | `models/text_encoders/` | 5.24 GB |
| `Comfy-Org/Krea-2` → `qwen_image_vae.safetensors` | `models/vae/` | 254 MB |
| `Comfy-Org/Krea-2` → style LoRA(예: `krea2_kidsdrawing.safetensors`) | `models/loras/` | ~469 MB |
| `conradlocke/krea2-identity-edit` → `krea2_identity_edit_v1.safetensors` | `models/loras/` | ~1.83 GB |
| `Comfy-Org/Wan_2.2_ComfyUI_Repackaged` → `split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors` | `models/diffusion_models/` | 10.0 GB |
| `…/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors` | `models/text_encoders/` | 6.74 GB |
| `…/vae/wan2.2_vae.safetensors` | `models/vae/` | 1.41 GB |

+ 커스텀노드: `git clone` `ComfyUI-Krea2Edit` → `custom_nodes/`. (14B 경로 선택 시 high/low 익스퍼트 + lightx2v LoRA 추가.)

## 서버 API (server.mjs 추가)

- `GET /api/storybook/status` — ComfyUI·Voicebox·ffmpeg 도달 여부, 모델 설치 여부
- `POST /api/voicebox/start` — Voicebox 백엔드 헤드리스 기동(기존 comfy/start 패턴)
- `GET/POST/PUT/DELETE /api/books`, `/api/books/:id` — book CRUD
- `POST /api/books/:id/character` — 캐릭터 레퍼런스 이미지 업로드
- `POST /api/books/:id/pages/:pid/upload` — 페이지 에셋 업로드(`kind`=`illustration|video|audio`, 파일). **저장 위치 `outputs/books/<id>/`**(정적 서빙·compose 입력용), 해당 에셋 소스를 `upload`로 설정. **타입·크기 검증**(이미지/오디오 ~20MB, **영상은 별도 상향 예: ~500MB**). 업로드 삽화가 있고 애니메이션이 `generate`면 오케스트레이터가 그 삽화를 `input/`으로 hop.
- `GET /api/books/:id/progress` — book 잡 진행 상태(아래 진행률 모델 shape) 조회. 프론트가 폴링.
- `POST /api/books/:id/pages/:pid/generate` — 단일 페이지 파이프라인(소스가 `generate`인 에셋만 생성, `upload`는 건너뜀)
- `POST /api/books/:id/generate` — 전체 book 생성(페이지 순회 + 합성)
- 자산 서빙은 기존 정적 서빙 재사용.
- **진행률 모델(book 잡):** 단일 0-100(KSampler WS)로는 부족 — book 잡은 `N 페이지 × {illustration|video|audio|compose}` 다단계이고 audio/compose는 ComfyUI 잡이 아님. 진행 상태 shape: `{ bookId, currentPageIndex, totalPages, currentStage: 'illustration|video|audio|compose', stageProgress: 0-100(ComfyUI 단계만 WS로 채움), perPageStatus[] }`. 프론트는 이 shape로 페이지·단계 진행을 표시.

## 데이터 모델

```jsonc
// data/books.json
[{
  "id": "uuid", "title": "...", "characterRef": "char_<id>.png",
  "style": "kidsdrawing", "createdAt": "ISO",
  "pages": [{
    "id": "uuid", "text": "옛날 옛적에…",
    "illustrationPrompt": "...", "motionPrompt": "gentle wind…",
    "seed": 12345, "status": "done",
    // 에셋별 소스: illustration/video = "generate"|"upload", audio = "generate"|"upload"|"none"
    "illustrationSource": "generate", "videoSource": "generate", "audioSource": "generate",
    "illustrationFile": "outputs/books/<id>/page-01.png",
    "videoFile": "...page-01.mp4", "audioFile": "...page-01.wav",
    "clipFile": "...page-01.clip.mp4", "error": null
  }],
  "finalVideo": "outputs/books/<id>/final.mp4", "status": "done"
}]
```

## 프론트엔드 — "동화책" 탭

book 생성 → 캐릭터 레퍼런스 업로드 → 페이지 추가(대본 + 장면 프롬프트 + 모션 프롬프트) → 페이지별 미리보기/재생성 → "전체 생성" 버튼 → 진행률 → 완성 영상 미리보기. 기존 잡바·히스토리 UI 재사용, vanilla JS.

각 페이지 카드는 **삽화·애니메이션·내레이션 3개 에셋마다 생성/업로드 토글**을 제공: "생성"(프롬프트로 만들기) 또는 "업로드"(내 파일 올리기). 업로드 선택 시 파일 입력이 나타나고 해당 에셋은 생성에서 제외된다. 각 에셋 슬롯은 현재 소스·미리보기·상태를 표시.

## 에러 처리 / 재현성

- seed 제출 전 정수 확정(재현성). 페이지·book 성공/실패 모두 영속. 페이지 단위 재시도. 서비스 미기동 시 명확한 에러(ComfyUI/Voicebox/ffmpeg 별도 판정).

## 테스트 전략

- **유닛(node:test):**
  - 순수 빌더 `buildKrea2Illustration`, `buildWan22I2V`의 그래프 구조/기본값/필수값 throw 검증(기존 `workflows.test.mjs` 방식).
  - 오케스트레이터 `storybook.mjs` — comfy/voicebox/compose 호출을 **의존성 주입(스텁)**하여: 소스 분기(`generate` vs `upload`), 애니메이션의 삽화 의존성 검증, 페이지 순차·상태 전이(`queued→running→done|error`), 페이지 단위 에러 격리(실패 페이지가 book을 중단시키지 않음), freeMemory 호출 순서를 순수 단위로 검증.
  - `compose.mjs` — ffmpeg/ffprobe **인자 구성 함수**를 실행 없이 문자열로 검증.
- **스모크(실서비스):** Voicebox 클라이언트(프로필 생성→WAV), ffmpeg compose(짧은 클립 mux/concat), **1페이지 수직 슬라이스 E2E**.

## 구현 단계 (수직 슬라이스 우선)

- **Phase 0 — 환경 준비 (종료 기준 명시):** ComfyUI 0.19.3→≥0.26.0 업데이트 후 **기존 테스트벤치 워크플로우 회귀 확인**, `setup-models.mjs`로 모델 다운로드, Krea2Edit 노드 설치, Voicebox 설치·헤드리스 기동, `ffmpeg`/`ffprobe` 확인. **종료 기준:** ① Krea2Edit 실제 노드명/배선 확정, ② **Voicebox REST 계약을 `/docs`·`/health`로 실검증**, ③ `comfy.freeMemory()`로 VRAM 해제 동작 확인, ④ **실제 캐릭터로 Identity Edit 일관성 검증**(미흡 시 리스크 3 경로 결정), ⑤ 각 서비스 개별 도달 확인.
- **Phase 1 — 빌더 + 클라이언트:** Krea2/Wan2.2 빌더(+유닛), Voicebox 클라이언트, compose. ComfyUI 실그래프로 삽화 1장·영상 1개 개별 검증.
- **Phase 2 — 오케스트레이터 + 서버:** `storybook.mjs` + 라우트. **1페이지 수직 슬라이스 E2E** 먼저.
- **Phase 3 — 동화책 탭 UI.**
- **Phase 4 — 전체 book 합성 + E2E 스모크.**

## 주요 리스크

1. **ComfyUI 포터블 업데이트**가 기존 노드/버전을 깨뜨릴 수 있음 → Phase 0에서 업데이트 후 기존 테스트벤치 회귀 확인. 백업 권장.
2. **12GB VRAM — 크로스 프로세스 경합(B1):** Krea2 fp8(13GB)·Wan2.2가 빡빡. ComfyUI는 자체 스마트 메모리로도 **외부 프로세스(Voicebox)**를 위해 VRAM을 놓지 않음 → **Voicebox 단계 전 `comfy.freeMemory({unloadModels})` 필수**. 단계별 순차 + Wan 5B 우선 + 필요 시 qwen TTS `0.6B`.
3. **캐릭터 일관성 = 핵심 가치인데 유일 경로가 비공식(범위 리스크):** Identity Edit LoRA·Krea2Edit는 비공식이고, 폴백(캐릭터별 LoRA 학습)은 현재 "범위 밖". 즉 Phase 0에서 일관성이 미흡하면 **인스코프 대안이 없음**. → Phase 0 종료 기준 ④에서 조기 검증하고, 미흡 시 **LoRA 학습을 인스코프로 승격(범위 확대 감수)** 또는 사용자와 재협의.
4. **정확한 노드명/배선**(Krea2Edit, Wan2.2 5B) 및 **Voicebox REST 계약**은 Phase 0 실검증으로 확정 — 스펙 기재값은 리서치 기반 잠정값.
5. **ffmpeg/ffprobe 의존성** 미확인 → Phase 0에서 확인/확보.
6. **대용량 다운로드(~37GB+)** 및 Voicebox 빌드(Bun/Rust/Python/just) 셋업 비용.
7. **book 런타임 예산:** 페이지당 Krea2(오프로딩 13GB)+Wan+TTS+mux가 순차 → **10페이지 book은 수 시간**대 가능. UX에 예상 소요시간 안내 필요.

## 향후 (범위 밖)

- 캐릭터별 LoRA 학습 파이프라인(최고 일관성)
- LLM 대본 자동 생성(줄거리→페이지)
- BGM/효과음, 자막, 페이지 전환 효과
