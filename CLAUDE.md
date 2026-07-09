# comfy-testbench + 동화책 애니메이션

로컬 ComfyUI 기반 (1) 이미지/영상 반복 테스트 웹앱 + (2) 동화책 페이지 애니메이션 생성 파이프라인.

## 실행
- `npm start` → http://localhost:3333 (Express, 포트 3333)
- `npm test` → 워크플로우 빌더 유닛 테스트 (`node --test`)
- ComfyUI는 UI의 "ComfyUI 시작" 버튼 또는 `/api/comfy/start`로 기동 (~60초)

## 구조
- `server.mjs` — Express 서버. 정적 서빙 + ComfyUI 오케스트레이션 + 잡/히스토리 관리.
  잡은 인메모리(`jobs` Map), 완료 판정은 히스토리 폴링(5초 간격)이라 WS 끊김/브라우저 종료와 무관하게 완주.
- `lib/workflows.mjs` — 순수 함수 워크플로우 빌더(`buildFluxT2I`, `buildWanI2V`), LoRA 트리거 맵, Wan negative.
- `lib/comfy.mjs` — ComfyUI HTTP/WS API 클라이언트(submit, 진행률, 히스토리, 다운로드, 업로드).
- `public/` — 빌드 없는 vanilla JS 단일 페이지. 탭 3개(이미지/영상/히스토리).
- `outputs/` — 결과물 복사본. `data/runs.json` — 성공/실패 모든 실행 기록(gitignore).

## 핵심 설계
- **seed는 제출 전 확정** — 랜덤이라도 서버가 정수로 고정 후 기록해 "같은 설정으로 재생성" 재현성 보장.
- **성공·실패 모두 기록** — 실패 조합도 테스트 데이터이므로 runs.json에 status error로 남김.
- 워크플로우 JSON 값은 `C:\ComfyUI_windows_portable\USAGE.md`의 검증 레시피를 그대로 사용.

## 동화책 페이지 파이프라인 (프로덕션, 실검증)
한 커맨드로 페이지 완성: `node scripts/make-page.mjs <page-spec.json>` → 삽화 시작이미지 + 컷별 모션 프롬프트 + 대본 + 목소리 → 최종 클립.
- `lib/workflows.mjs` `buildWan22I2V14B` — **Wan 2.2 14B GGUF(two-expert)+lightx2v 4-step+RealESRGAN 업스케일**(none/2x/1080). 영상 엔진.
- `lib/workflows.mjs` `buildKrea2Illustration` — Krea2 Turbo 삽화(+Krea2Edit 캐릭터 레퍼런스). 순수 t2i 품질 우수.
- `lib/pagevideo.mjs` `generatePageVideo` — **5초 N컷 체이닝**(각 컷 마지막 프레임→다음 시작). Wan은 ~5초 학습이라 긴 영상은 컷 이어붙임.
- `lib/voicebox.mjs` — Voicebox TTS 클라이언트. **음성 복제**(참조 오디오→그 목소리, engine=qwen)가 핵심. `ensureModel`/`transcribe`/`ensureProfile`/`generate`.
- `lib/comfyrun.mjs` — 워크플로우 제출+진행률+완료판정+지정경로 다운로드 러너.
- `lib/compose.mjs` — ffmpeg mux(오디오 길이 맞춤)/concat.
- 상세·의사결정 근거는 memory `storybook-pipeline-validated.md` 참조.

## 서비스·모델 (동화책)
- **ComfyUI ≥0.26** + 커스텀노드 `ComfyUI-GGUF`(city96) + `comfyui-krea2edit`. `scripts/setup-models.mjs`가 모델 자동 다운로드(Krea2, Wan2.2 14B GGUF, lightx2v, RealESRGAN x2/x4 등).
- **Voicebox**(`C:\projects\voicebox`, 127.0.0.1:17493) — **Python 3.12** venv 헤드리스 백엔드. 한국어는 음성 복제(engine=qwen). 3.13은 kokoro/pyopenjtalk 빌드 실패.
- ffmpeg/ffprobe(PATH).

## 의존성
- Node.js 20+ (ESM), express, ws, busboy.
- ComfyUI: `C:\ComfyUI_windows_portable` (127.0.0.1:8188). 모델/LoRA는 해당 설치에 존재해야 함.

Spec/Plan: `docs/superpowers/specs/`, `docs/superpowers/plans/`.
