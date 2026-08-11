# 레퍼런스 이미지 → 영상 파이프라인 (Krea2 + MiniMax H3 R2V)

캐릭터 레퍼런스 이미지 한 장으로 **LoRA 학습 없이** 일관된 스틸을 뽑고, 그 스틸을
레퍼런스로 넣어 **오디오까지 함께 생성되는 영상**을 만든 뒤, 업스케일·프레임보간으로
마감하는 파이프라인. 2026-08-07 로컬 실검증(RTX 4070 12GB / RAM 32GB).

```
캐릭터 시트 ──[krea2_edit.py]──> 장면 스틸 ──[minimax_r2v.py]──> 5초 영상+오디오
                                                                      │
                                              1664×960 48fps <──[video_finish.py]
```

스크립트 3개는 **stdlib만** 쓴다(파이썬 3.9+). 설치할 파이썬 패키지 없음.
다른 프로젝트로 옮길 때는 `scripts/` 3개 파일만 복사하면 된다.

---

## 1. 사전 준비

### ComfyUI 0.30.0 이상 (필수)

MiniMax H3 네이티브 노드가 0.30.0에 들어왔다. 그 미만이면 노드 자체가 없다.

```bash
cd C:\ComfyUI_windows_portable\update && .\update_comfyui_stable.bat
```

업데이트 스크립트가 `backup_branch_<날짜>`를 자동으로 만들어두니 롤백 가능하다.

확인:

```bash
python -c "import json,urllib.request; i=json.load(urllib.request.urlopen('http://127.0.0.1:8188/object_info')); print('MiniMaxH3ReferenceToVideo' in i, 'TextEncodeQwenImageEditPlus' in i, 'FrameInterpolate' in i)"
```

세 개 다 `True`여야 한다.

### 모델

용량이 커서 별도 드라이브에 두고 `extra_model_paths.yaml`로 매핑하는 걸 권장한다.
**이 파일은 ComfyUI 기동 시에만 읽힌다** — 항목을 추가했으면 반드시 재시작.

`ComfyUI/extra_model_paths.yaml`:

```yaml
d_drive:
    base_path: D:/ComfyUI-models
    diffusion_models: diffusion_models
    text_encoders: text_encoders
    vae: vae
    upscale_models: upscale_models
    frame_interpolation: frame_interpolation
    loras: loras
```

**MiniMax H3 R2V** (~41GB) — 리포 경로가 ComfyUI 폴더 구조와 같아서 `--local-dir` 한 번으로 끝난다:

```bash
hf download Comfy-Org/MiniMax-H3 \
  diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors \
  text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors \
  vae/minimax_h3_video_vae_fp16.safetensors \
  vae/minimax_h3_audio_vae_fp32.safetensors \
  --local-dir D:/ComfyUI-models
```

| 파일 | 크기 | 비고 |
|---|---|---|
| `minimax_h3_ref2va_pruned_int8_convrot` | 20GB | R2V 전용. T2V/I2V는 `fl2va` 쪽 |
| `qwen3vl_32b_minimax_h3_nvfp4_awq` | 15GB | NVFP4는 Blackwell 전용이 아니라 **모든 GPU에서 동작** |
| `minimax_h3_video_vae_fp16` | 4.9GB | |
| `minimax_h3_audio_vae_fp32` | 578MB | 오디오 동시 생성용 |

**Krea 2** — 대부분 이미 있을 것:

| 파일 | 위치 |
|---|---|
| `krea2_turbo_fp8_scaled.safetensors` | `diffusion_models/` |
| `qwen3vl_4b_fp8_scaled.safetensors` | `text_encoders/` |
| `qwen_image_vae.safetensors` | `vae/` |
| `krea2_identity_edit_v1.safetensors` | `loras/` — **필수. 없으면 결과가 깨진다** |

**후처리**:

```bash
# RIFE 프레임 보간 (22MB)
hf download Comfy-Org/frame_interpolation frame_interpolation/rife_v4.26_heavy.safetensors --local-dir /tmp/fi
cp /tmp/fi/frame_interpolation/*.safetensors D:/ComfyUI-models/frame_interpolation/

# 애니메이션 영상용 업스케일러 (2.4MB)
curl -L -o D:/ComfyUI-models/upscale_models/realesr-animevideov3.pth \
  https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-animevideov3.pth
```

### ComfyUI 기동

```bash
cd C:\ComfyUI_windows_portable && .\python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build --cache-none
```

`--cache-none`이 중요하다. R2V는 20GB 디퓨전 + 15GB 텍스트 인코더를 쓰는데 둘이 동시에
상주하면 36.7GB로 32GB RAM을 넘겨 페이지파일 스래싱이 난다. `--cache-none`은 노드가
끝나면 즉시 모델을 내려서 순차 로딩이 되게 한다. 모델을 매번 다시 읽지만 스왑보다 훨씬 싸다.

### 환경변수 (선택)

```bash
export COMFY_URL=http://127.0.0.1:8188                       # 기본값
export COMFY_INPUT=C:/ComfyUI_windows_portable/ComfyUI/input  # krea2_edit.py의 PNG 크기 판독용
```

---

## 2. `krea2_edit.py` — 레퍼런스 이미지 → 스틸

캐릭터 레퍼런스를 넣고 장면·포즈를 바꾼 이미지를 뽑는다. LoRA 학습 불필요.

```bash
python scripts/krea2_edit.py \
  --ref hori_front.png \
  --lora krea2_identity_edit_v1.safetensors \
  --cfg 1.5 \
  --prompt-file prompts/scenes.txt
```

레퍼런스는 **ComfyUI의 `input/` 폴더에 미리 있어야 한다**(파일명만 넘김).

| 플래그 | 기본 | 권장 |
|---|---|---|
| `--ref` | — | 1장. **2~3장은 넣지 말 것** (아래 함정 참조) |
| `--lora` | 없음 | `krea2_identity_edit_v1.safetensors` **사실상 필수** |
| `--cfg` | 1.0 | **1.5** |
| `--steps` | 8 | 8 (Turbo) |
| `--megapixels` | 1.2 | 1.2 (≤2MP 학습 범위) |
| `--ref-method` | `index_timestep_zero` | 기본값 |
| `--prompt` / `--prompt-file` | — | `--prompt` 반복 가능, 파일은 한 줄에 하나 |

출력 크기는 레퍼런스의 종횡비를 따라 자동 계산된다(양축 8의 배수). 소스보다 커도 되고,
`--width/--height`로 직접 줄 수도 있다.

### 프롬프트 요령

- 색·재질을 **명시적으로 나열**한다. VLM이 384×384로 축소해 보기 때문에 미세한 색 구분이 뭉개진다.
  → `"dark brown stripes, cream inner ears, warm brown eyes with white highlights, pink cheek blush"`
- 노드가 프롬프트 앞에 `Picture 1:` 접두어를 자동으로 붙이므로 `<Picture 1>`로 지칭할 수 있다.
- 캐릭터 시트를 그대로 쓰면 콜아웃 원·화살표·`FRONT`/`SIDE` 라벨까지 재현하려 든다.
  **정면 뷰만 잘라서** 쓰는 게 낫다.

---

## 3. `minimax_r2v.py` — 스틸 → 영상 + 오디오

```bash
python scripts/minimax_r2v.py \
  --refs scene.png \
  --prompt-file prompts/motion.txt \
  --width 832 --height 480 --seconds 5
```

| 플래그 | 기본 | 비고 |
|---|---|---|
| `--refs` | — | 최대 9장. 프롬프트에서 `<Picture 1>`~`<Picture 9>`로 지칭 |
| `--width/--height` | 640×384 | **32의 배수 필수** |
| `--seconds` | 5 | 프레임 수는 모델의 `17k+5` 격자로 자동 스냅 |
| `--steps` | 20 | |
| `--ref-image-size` | `match` | `max`는 2048px로 정체성 충실도↑ / 몇 배 느려짐 |
| `--seed` | 12345 | |
| `--dry-run` | — | 워크플로우 JSON만 출력 |

샘플러는 공식 템플릿 그대로 `res_multistep` / `simple` / CFG 없는 `BasicGuider` / 24fps.

### 프롬프트 요령

MiniMax는 **한 번의 생성 안에 여러 컷**을 넣을 수 있다. 공식 템플릿도 그렇게 쓴다:

```
<Picture 1> is the character and art-direction reference: ...
Keep his design, texture and lighting exactly as in <Picture 1>.

CUT 1 (0-3s): ...동작 서술...
CUT 2 (3-5s): ...동작 서술...

Audio: ...환경음, 음악, 목소리...
```

오디오가 함께 생성되므로 `Audio:` 줄을 반드시 쓴다. 나레이션을 따로 얹을 거라면
MiniMax 오디오는 앰비언스로 낮게 깔면 된다.

### 해상도 전략

| | 샘플링 | R2V 전체 | 후처리 후 |
|---|---|---|---|
| 640×384 | 1분 58초 | 3.7분 | 1280×768 |
| 832×480 | 3분 57초 | 5.8분 | 1664×960 |

픽셀은 1.63배인데 시간은 정확히 2배다(어텐션이 시퀀스 길이에 제곱).

**640으로 만들어 나중에 업스케일하는 것과 832로 만드는 것은 결과가 다르다.**
640 원본에는 세부 정보가 애초에 없어서 올려도 매끈하게 뭉개진 결과가 나온다.
640은 **구도·연출 프리뷰용**으로 쓰고, 확정되면 832로 다시 뽑는다.

---

## 4. `video_finish.py` — 업스케일 + 프레임보간

```bash
python scripts/video_finish.py --video raw.mp4 --multiplier 2 --scale-down 0.5
```

입력 영상은 **ComfyUI `input/` 폴더에 있어야 한다**(파일명만 넘김).

| 플래그 | 기본 | 비고 |
|---|---|---|
| `--multiplier` | 2 | 프레임 배수. 24→48fps. `1`이면 보간 생략 |
| `--scale-down` | 0.5 | 4배 모델 뒤에 적용. 0.5면 순 2배 |
| `--upscale-model` | `realesr-animevideov3.pth` | 실사면 `RealESRGAN_x4.pth` |
| `--interp-model` | `rife_v4.26_heavy.safetensors` | |

전 구간 네이티브 노드다:

```
LoadVideo → GetVideoComponents → ImageUpscaleWithModel(4x) → ImageScaleBy(0.5)
          → FrameInterpolate(RIFE, x2) → CreateVideo(48fps, 원본 오디오) → SaveVideo
```

640×384 기준 42초, 832×480 기준 1.2분. 오디오는 그대로 통과한다.

4배를 그대로 쓰면 원본에 없는 정보를 부풀리기만 하므로 `--scale-down 0.5`로 순 2배가 적당하다.

> 보간 결과는 `(N-1)×multiplier + 1` 프레임이라 길이가 한 프레임분(약 20ms) 짧아진다.
> 오디오도 같이 맞춰지므로 싱크는 유지된다.

---

## 5. 함정 모음 (전부 실제로 밟았음)

### ComfyUI API 포맷은 UI 노드와 다르다

- `LoadImage`에 **`upload` 입력은 없다.** UI 위젯일 뿐이다. `{"image": "name.png"}`만.
- Autogrow 슬롯은 평면 이름이 아니라 **점 표기법**이다:
  `"ref_image_0"` ❌ → **`"ref_images.ref_image_0"`** ✅
  `/object_info`에는 컨테이너(`ref_images`)만 보이고 슬롯은 프롬프트 검증 시점에 펼쳐진다.

세 스크립트 모두 실행 전 `/object_info`로 입력 이름을 검증한다. 잘못된 키는
GPU를 태우기 전에 즉시 실패한다. 새 노드를 붙일 때 이 패턴을 유지할 것.

### Krea2: LoRA 없이 돌리면 모자이크가 깔린다

베이스 turbo만으로는 reference latent를 제대로 처리하지 못해 격자 블록 아티팩트가 생긴다.
`krea2_identity_edit_v1`을 물리면 사라진다. 공식 style reference 템플릿도 항상 전용 LoRA를 건다.

### Krea2: 레퍼런스 여러 장은 역효과

`TextEncodeQwenImageEditPlus`의 다중 이미지는 **"서로 다른 피사체를 합성"**하라는 의미로
학습돼 있다(인물+배경+소품). 같은 캐릭터의 3면도를 넣으면 **캐릭터가 여러 마리로 분열**한다.
프롬프트로 "같은 캐릭터의 여러 뷰"라고 명시해도 안 통한다. 시간만 2배(57초→102초).

### Krea2: CFG는 1.5. 2.5는 무너진다

| CFG | 결과 |
|---|---|
| 1.0 | 눈이 새까맣게, 분홍 볼 소실 |
| **1.5** | **홍채·하이라이트·볼·귀 테두리 회복** |
| 2.5 | 과포화, 색 형광화, 질감 붕괴 |

LoRA 강도 1.3이나 20스텝은 유의미한 차이가 없었다(20스텝은 질감이 약간 나아지지만 시간 2배).

### `comfyui-krea2edit` 커스텀 노드는 0.30.x에서 깨진다

`forward()` 시그니처가 바뀌어 `takes from 4 to 6 positional arguments but 7 were given`이 난다.
**네이티브 `TextEncodeQwenImageEditPlus`가 상위 호환**이다 — 하는 일이 같고(VLM이 이미지를
보며 인코딩 + reference latent 생성) 레퍼런스도 2장이 아니라 3장까지 받는다.
이 파이프라인은 커스텀 노드를 전혀 쓰지 않는다.

### 텍스트 인코더 = 이미지를 읽는 VLM

Krea2는 Qwen3-VL **4B**, MiniMax H3는 Qwen3-VL **32B**를 텍스트 인코더로 쓴다.
글만 읽는 T5 계열과 달리 **이미지를 함께 본다.** LoRA 없이 캐릭터 일관성이 되는 이유이자,
모델이 무겁고 느린 이유다. ComfyUI에서 로더 이름이 `CLIPLoader`인 건 역사적 잔재이고,
`type`을 `krea2` / `minimax`로 지정해야 한다.

### 페이지파일은 가장 빠른 드라이브에

용량이 남는 곳이 아니라 NVMe에 둔다. SATA SSD는 순차 속도가 5배 이상 느리고,
페이징이 실제로 하는 랜덤 4K 접근에서는 격차가 더 벌어진다.

---

## 6. 실측 시간 (RTX 4070 12GB / RAM 32GB / 모델은 SATA SSD)

| 단계 | 시간 |
|---|---|
| Krea2 스틸 1장 (cfg 1.5, 8스텝, 1.19MP) | 1.5분 |
| Krea2 스틸 1장 (cfg 1.0) | 57초 |
| MiniMax R2V 5초 @640×384 | 3.7분 |
| MiniMax R2V 5초 @832×480 | 5.8분 |
| 후처리 @640 → 1280×768 48fps | 0.7분 |
| 후처리 @832 → 1664×960 48fps | 1.2분 |
| **최종 클립 1개 (832 경로)** | **약 8.5분** |

MiniMax는 아직 공식 업스케일러가 미공개다. 베이스가 중간 해상도로만 학습돼 있어
현재로선 실사보다 **애니메이션/플러시 스타일이 유리**하다. Turbo/Distill LoRA가 나오면
최대 5배까지 빨라질 여지가 있다.

---

## 7. 다른 프로젝트로 옮기기

1. `scripts/minimax_r2v.py`, `scripts/krea2_edit.py`, `scripts/video_finish.py` 복사
2. 필요하면 `COMFY_URL` / `COMFY_INPUT` 환경변수 설정
3. 레퍼런스 이미지·영상을 ComfyUI `input/` 폴더에 두고 **파일명만** 인자로 전달
4. 결과는 ComfyUI `output/` 아래 `--prefix` 경로에 떨어진다

의존성은 파이썬 stdlib뿐이다. 별도 설치 없음.
