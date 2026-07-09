# ComfyUI 테스트벤치 + 동화책 애니메이션

로컬 ComfyUI 기반 (1) 이미지/영상 반복 테스트 웹앱 + (2) **동화책 페이지 애니메이션 생성 CLI**.

---

# 📖 동화책 페이지 생성 CLI (`make-page`)

시작 이미지 + 컷별 모션 프롬프트 + 대본 + 목소리 → **한 커맨드로 완성 페이지 클립**(영상+내레이션).
다른 프로젝트/디렉토리에서도 절대경로로 호출하면 됩니다.

```bash
node C:/projects/comfy_test/scripts/make-page.mjs <page-spec.json>
```

## 파이프라인
삽화(업로드 또는 Krea2 생성) → **Wan 2.2 14B GGUF I2V**(5초 컷, lightx2v 4-step) → 컷별 **RealESRGAN 업스케일** →
**5초 N컷 체이닝**(각 컷 마지막 프레임을 다음 컷 시작으로) → **Voicebox 음성 복제 내레이션** → ffmpeg 합성.

## 사전 준비 (한 번)
1. **ComfyUI** 기동(`C:\ComfyUI_windows_portable`, 127.0.0.1:8188) + 커스텀노드
   `git clone https://github.com/city96/ComfyUI-GGUF` 및 `comfyui-krea2edit` → `custom_nodes/`,
   `python_embeded/python.exe -m pip install "gguf>=0.13.0"`.
2. **모델 다운로드:** `node scripts/setup-models.mjs` (Krea2, Wan2.2 14B GGUF, lightx2v, RealESRGAN 등).
3. **Voicebox 백엔드**(`C:\projects\voicebox`, 127.0.0.1:17493) — Python **3.12** venv 헤드리스:
   `backend/venv/Scripts/python.exe -m uvicorn backend.main:app --port 17493`.
4. **ffmpeg/ffprobe** PATH.

## page-spec.json 스키마
```jsonc
{
  "startImage": "C:/.../p1.png",        // 첫 컷 시작 이미지 (절대경로)
  "cuts": [                              // 컷별 모션 프롬프트 (컷 1개당 ~5초). 짧게·움직임만!
    "the cub takes a small bite ... gentle motion, stable, consistent",
    "the cub looks at the colorful dishes ... calm cozy motion",
    "the cub picks up a meatball ... soft chewing, gentle motion"
  ],
  "narrationText": "페이지 대본 전체...",   // 한국어 대본
  "voice": { "profileId": "<복제 프로필 id>" },   // 또는 아래 참조-오디오 방식
  "dest": "C:/.../hori_page1.mp4",       // 최종 출력
  "upscale": "1080"                      // 'none' | '2x'(1664x960) | '1080'(1872x1080, 기본)
}
```
- **목소리(음성 복제)** — `voice`는 둘 중 하나:
  - `{ "profileId": "..." }` — 이미 만든 복제 프로필 재사용
  - `{ "name":"narrator", "refAudioPath":"C:/.../ref.mp3", "refText":"참조 오디오 대본" }` —
    참조 오디오(5~15초)로 새 프로필 생성(name 기준 idempotent). `refText`는 참조 오디오의 대본.
- 예제: `docs/page-spec.example.json`.

## 소요 시간 (RTX 4070 12GB 기준, 컷 1개)
`none` ~3분 · `2x` ~3.6분 · `1080` ~5.4분. 3컷 1080p 페이지 ≈ ~16분. (첫 실행 시 TTS/Whisper 모델 다운로드 별도.)

## 팁
- **모션 프롬프트는 짧게, 움직임만.** 캐릭터/장면 재묘사하면 없던 캐릭터가 생김(몰핑).
- 캐릭터 일관된 **삽화**를 아무 장면에나 로컬 생성하려면 Krea2 **캐릭터 LoRA 학습**이 필요(현재 미구현).

---

# ComfyUI 테스트벤치 (웹앱)

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
