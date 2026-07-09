# ComfyUI 테스트벤치 웹앱 — 설계 문서

날짜: 2026-07-09
상태: 승인됨 (사용자 확인)

## 목적

로컬 ComfyUI(`C:\ComfyUI_windows_portable`)를 활용해 이미지(FLUX)와 영상(Wan 2.1 I2V) 생성을
반복 테스트하는 웹페이지. 모든 생성 결과가 파라미터와 함께 히스토리에 자동 누적되어
과거 결과와 비교할 수 있어야 한다.

## 성공 기준

- 브라우저에서 프롬프트/파라미터를 조절해 이미지를 생성하고 결과를 즉시 확인
- 히스토리의 이미지(또는 업로드 이미지)에서 클릭 한 번으로 5초 영상 생성 시작
- 생성 기록(파라미터, 프롬프트, 결과 파일, 소요 시간, 실패 시 에러)이 `data/runs.json`에 누적
- 영상처럼 오래 걸리는 작업(5~22분)도 진행률이 보이고, 브라우저를 닫아도 완료됨

## 기술 스택

- **서버**: Node.js + Express (단일 `server.mjs`, 포트 3333)
- **프론트**: vanilla JS + 단일 HTML — 빌드 과정 없음
- **의존성 최소화**: express, ws (ComfyUI WebSocket 클라이언트용), busboy (업로드 multipart 파싱)
- ComfyUI API: `http://127.0.0.1:8188` (검증된 패턴은 `C:\ComfyUI_windows_portable\USAGE.md` 참고)

## 파일 구조

```
C:\projects\comfy_test\
├── server.mjs              # Express 서버: 정적 서빙 + API + 잡 매니저
├── lib/
│   ├── comfy.mjs           # ComfyUI 클라이언트: POST /prompt, WS 진행률, /history, /view 다운로드
│   └── workflows.mjs       # 워크플로우 빌더: buildFluxT2I(params), buildWanI2V(params)
├── public/
│   ├── index.html          # 탭 3개: 이미지 / 영상 / 히스토리
│   ├── app.js
│   └── style.css
├── data/runs.json          # 히스토리 (없으면 [] 로 초기화)
├── outputs/                # 결과물 복사본 (ComfyUI output에서 가져옴)
└── docs/superpowers/specs/ # 이 문서
```

## 컴포넌트 설계

### lib/comfy.mjs — ComfyUI 클라이언트
- `isAlive()` — GET /system_stats 로 연결 확인
- `getModels()` — GET /object_info 에서 checkpoints/loras 목록 추출
- `submit(workflow, clientId)` — POST /prompt → prompt_id
- `trackProgress(promptId, onProgress)` — WS `/ws?clientId=` 로 노드별 진행률 수신
- `fetchHistory(promptId)` — GET /history/:id
- `downloadOutput(fileInfo, destPath)` — GET /view → 파일 저장
- `uploadInput(localPath)` — ComfyUI `input/` 폴더에 이미지 복사 (LoadImage용)

### lib/workflows.mjs — 워크플로우 빌더
- `buildFluxT2I({ prompt, negative, lora, loraStrength, width, height, steps, guidance, seed })`
  - 기본값: 1024×1024, steps 25, cfg 1.0, guidance 3.5, euler/simple (USAGE.md 검증값)
  - lora 지정 시 LoraLoader 노드 삽입
- `buildWanI2V({ imageName, motionPrompt, width, height, frames, steps, seed })`
  - 기본값: 832×480, 81프레임(5초), steps 25, cfg 6.0, uni_pc/simple, fps 16
  - negative 기본값: Wan 공식 중국어 negative
- 순수 함수 — 입력 params → 워크플로우 JSON. **유닛 테스트 대상.**

### server.mjs — API + 잡 매니저
| 엔드포인트 | 역할 |
|---|---|
| `GET /api/status` | ComfyUI 연결 여부 + 모델 목록 |
| `POST /api/comfy/start` | `run_nvidia_gpu_fast_fp16_accumulation.bat` spawn (detached) |
| `POST /api/generate/image` | FLUX 워크플로우 생성·제출 → jobId 반환 |
| `POST /api/generate/video` | Wan I2V 제출 (source: 히스토리 run id 또는 업로드 파일) → jobId |
| `POST /api/upload` | 이미지 업로드 → ComfyUI input/ 복사 (multipart 파싱은 busboy 사용) |
| `GET /api/jobs` | 활성 잡 목록 — 페이지 새로고침 후에도 진행 중 잡 재발견 (영상 22분 대비) |
| `GET /api/jobs/:id` | 잡 상태: queued / running(진행률 %) / done(결과 경로) / error |
| `GET /api/runs` | runs.json 반환 |
| `GET /outputs/*` | 결과물 정적 서빙 |

잡 매니저: 메모리 내 Map. 완료 시 결과 파일을 `outputs/`로 복사하고 runs.json에 append.
실패도 에러 메시지와 함께 기록. 서버 재시작 시 진행 중이던 잡은 유실 허용(테스트 도구이므로),
단 ComfyUI 쪽 히스토리로 결과 복구는 하지 않음 (YAGNI).

추가 규칙:
- **seed 확정 기록**: 랜덤 seed는 제출 *전에* 서버가 구체값으로 확정해 `params.seed`에 저장 —
  "같은 설정으로 재생성"이 재현 가능해야 함
- **히스토리 → 영상 소스**: source가 run id면 서버가 해당 `outputs/` 파일을
  `uploadInput()`으로 ComfyUI `input/`에 복사한 뒤 워크플로우 구성
- **LoRA 트리거 단어**: `/object_info`에는 없으므로 USAGE.md 기반의
  파일명→트리거 하드코딩 맵을 서버에 둠

### 프론트 (public/)
- **상단 바**: ComfyUI 연결 상태 배지. 끊김 → "ComfyUI 시작" 버튼
- **이미지 탭**: 프롬프트, negative(접힘), LoRA 드롭다운(선택 시 트리거 단어를 프롬프트 앞에 자동 삽입 힌트 표시),
  사이즈 프리셋(1:1 / 16:9 / 9:16), steps/guidance/seed(랜덤 체크박스), 생성 버튼 → 진행바 → 결과 이미지
- **영상 탭**: 소스 이미지 선택(파일 업로드 or 히스토리 그리드에서 선택), 모션 프롬프트,
  프레임 수(81=5초 / 161=10초), 생성 → 진행바(예상 소요 시간 안내: 5~22분) → 결과 mp4 재생
- **히스토리 탭**: 최신순 카드 그리드. 카드 = 썸네일(이미지/비디오), 타입 배지, 프롬프트 요약.
  클릭 시 파라미터 전체 펼침. 버튼: "같은 설정으로 재생성"(폼에 파라미터 복원), "이 이미지로 영상 만들기"(영상 탭으로 이동 + 소스 설정)
- 폴링: 활성 잡이 있으면 2초 간격 `/api/jobs/:id`

## runs.json 스키마

```json
{
  "id": "uuid",
  "type": "image" | "video",
  "createdAt": "ISO8601",
  "params": { "prompt": "...", "seed": 42, "...": "..." },
  "sourceRunId": "uuid | null",
  "status": "done" | "error",
  "error": "string | null",
  "outputFile": "outputs/xxx.png | null",
  "durationSec": 123
}
```

## 에러 처리

- ComfyUI 미기동: 모든 생성 버튼 비활성 + 상태 배지 안내
- 제출/실행 실패: 잡 상태 error → 히스토리에 에러와 함께 기록 (실패한 조합도 테스트 데이터)
- WS 끊김: 폴링 fallback (GET /history/:promptId 로 완료 확인)

## 테스트

- `lib/workflows.mjs` 유닛 테스트 (node:test): 파라미터 → 워크플로우 JSON 구조 검증
- `lib/comfy.mjs`, server는 실제 ComfyUI 대상 수동 스모크 테스트 (로컬 도구이므로 통합 테스트 과투자 안 함)

## 범위 제외 (YAGNI)

- 배치 큐 / 그리드 실험 (필요해지면 추후)
- 인증, 다중 사용자
- 서버 재시작 시 잡 복구
- SDXL / ControlNet / Redux 파이프라인 (FLUX t2i + Wan i2v 두 개로 시작)
