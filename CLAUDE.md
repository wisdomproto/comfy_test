# comfy-testbench

로컬 ComfyUI로 이미지(FLUX)·영상(Wan 2.1 I2V)을 반복 테스트하고 모든 결과를 히스토리로 누적하는 웹앱.

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

## 의존성
- Node.js 20+ (ESM), express, ws, busboy.
- ComfyUI: `C:\ComfyUI_windows_portable` (127.0.0.1:8188). 모델/LoRA는 해당 설치에 존재해야 함.

Spec/Plan: `docs/superpowers/specs/`, `docs/superpowers/plans/`.
