# ComfyUI 테스트벤치

로컬 ComfyUI를 백엔드로, 이미지(FLUX text-to-image)와 영상(Wan 2.1 image-to-video)을
반복 생성·비교하는 웹 테스트벤치입니다. 모든 실행(성공·실패)이 히스토리로 누적됩니다.

## 요구 사항
- Node.js 20 이상
- ComfyUI (`C:\ComfyUI_windows_portable`) — FLUX / Wan 2.1 모델과 LoRA가 설치되어 있어야 함

## 시작
```bash
npm install
npm start
```
브라우저에서 http://localhost:3333 접속.

상단 상태 배지가 **ComfyUI 꺼짐**이면 **"ComfyUI 시작"** 버튼을 누릅니다(기동 ~60초).
**ComfyUI 연결됨**으로 바뀌면 생성 버튼이 활성화됩니다.

## 화면
- **이미지 생성** — 프롬프트·LoRA·사이즈·steps·guidance·seed 설정 후 FLUX로 생성.
  LoRA 선택 시 트리거 단어 힌트가 표시됩니다. 이미지 1장 ~45초.
- **영상 생성** — 히스토리 이미지 선택 또는 파일 업로드를 소스로, 모션 프롬프트를 주어
  Wan 2.1 I2V로 영상 생성. fp8 모델 기준 5초 클립에 **~22분** 소요.
  브라우저를 닫아도 서버가 완료하며, 새로고침하면 진행 중 잡을 다시 표시합니다.
- **히스토리** — 모든 생성 기록(성공·실패)을 카드로 표시. 파라미터 펼쳐보기,
  "같은 설정으로 재생성"(seed 포함 재현), "이 이미지로 영상 만들기" 액션 제공.

## 데이터
- 결과물: `outputs/`
- 실행 기록: `data/runs.json` (성공·실패 모두 기록)

## 테스트
```bash
npm test
```
워크플로우 빌더(`lib/workflows.mjs`) 유닛 테스트를 실행합니다.
