# 캐릭터 레퍼런스 + 그림체 프롬프트로 이미지 만들기

레퍼런스 이미지 1장으로 **같은 캐릭터를 여러 장면·여러 그림체로** 뽑는 프롬프트 작성 가이드.
LoRA 학습 없이 된다. 실행 도구는 [minimax-r2v-guide.md](minimax-r2v-guide.md)의 `krea2_edit.py`.

이 문서는 **프롬프트를 어떻게 쓸 것인가**를 다룬다. 설치 절차와 플래그 전체는 위 문서 참조.

---

## 0. 어떤 모델을 쓰나

**Krea 2 Turbo + Krea 2 Identity Edit LoRA**. 전부 오픈 웨이트이고 로컬 ComfyUI에서 돈다.
API 호출 없음. 12GB VRAM에서 1.19MP 이미지가 장당 90초(cfg 1.5 기준).

| 역할 | 파일 | ComfyUI 폴더 | 크기 |
|---|---|---|---|
| 디퓨전 | `krea2_turbo_fp8_scaled.safetensors` | `diffusion_models/` | 13GB |
| **텍스트 인코더** | `qwen3vl_4b_fp8_scaled.safetensors` | `text_encoders/` | 4.9GB |
| VAE | `qwen_image_vae.safetensors` | `vae/` | 254MB |
| **레퍼런스 LoRA** | `krea2_identity_edit_v1.safetensors` | `loras/` | 1.8GB |

합계 약 20GB. VRAM 12GB에는 다 안 올라가지만 ComfyUI가 블록 단위로 스트리밍한다.

받는 곳: [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2) (디퓨전·텍스트인코더·VAE),
[conradlocke/krea2-identity-edit](https://huggingface.co/conradlocke/krea2-identity-edit) (LoRA).

### 왜 이 조합인가

**텍스트 인코더가 Qwen3-VL 4B — 비전-언어 모델이다.** 글만 읽는 T5 계열(SDXL·FLUX·Wan 등)과
달리 **이미지를 함께 본다.** 그래서 "이 캐릭터를 유지하되 장면을 바꿔라" 같은 지시를
이해한다. IPAdapter처럼 이미지 특징을 통계적으로 섞는 게 아니라, VLM이 실제로 보고
프롬프트의 지시와 연결한다. **LoRA 학습 없이 캐릭터 일관성이 되는 이유가 이것이다.**

같은 계열이 영상 쪽에도 있다 — MiniMax H3는 Qwen3-VL **32B**를 텍스트 인코더로 쓴다.
그래서 이미지·영상 프롬프트 감각이 그대로 이어진다.

> ComfyUI에서 이 부품을 로드하는 노드 이름이 `CLIPLoader`인 건 역사적 잔재다.
> 실제로는 CLIP이 아니며, `type`을 `krea2`(이미지) / `minimax`(영상)로 지정해야 한다.

### 워크플로우 (네이티브 노드만, 커스텀 노드 없음)

```
UNETLoader(krea2_turbo) ─> LoraLoaderModelOnly(identity_edit) ─> ModelSamplingFlux
                                                                       │
LoadImage ─┐                                                           ▼
           ├─> TextEncodeQwenImageEditPlus ─> FluxKontextMultiReference ─> CFGGuider
CLIPLoader ┘   (VLM이 이미지를 보며 인코딩 +      LatentMethod              (cfg 1.5)
VAELoader  ┘    reference latent 생성)          (index_timestep_zero)          │
                                                                               ▼
                          SamplerCustomAdvanced(euler/simple, 8스텝) ─> VAEDecode ─> SaveImage
```

`comfyui-krea2edit` 커스텀 노드 팩이 있지만 **ComfyUI 0.30.x에서 깨진다**
(`forward()` 시그니처 변경). 네이티브 `TextEncodeQwenImageEditPlus`가 상위 호환이다 —
하는 일이 같고 레퍼런스도 2장이 아니라 3장까지 받는다.

### 다른 선택지

| 모델 | 레퍼런스 | 비고 |
|---|---|---|
| **Krea 2 Identity Edit** | 1장 권장 | 여기서 검증한 조합. 12GB VRAM에 적합 |
| Qwen-Image-Edit-2509 / 2511 | 1~3장 | 20B 베이스. 더 무겁고 여기선 미검증 |
| FLUX.2 [dev] | 최대 10장 | 심미성 상급, 훨씬 무거움. 여기선 미검증 |

아래 수치·처방은 전부 **Krea 2 Turbo + Identity Edit** 기준이다. 다른 모델은 CFG나
스텝 최적값이 다르다.

---

## 1. 먼저 알아야 할 것: 모델이 레퍼런스를 보는 두 경로

Krea 2 Edit는 레퍼런스 이미지를 **두 갈래로** 받는다. 프롬프트를 쓸 때 이 구조를 알면
왜 어떤 건 잘 지켜지고 어떤 건 새는지가 설명된다.

```
레퍼런스 ─┬─ VAE 인코딩 (약 1024×1024 넓이) ──> reference latent  ← 외형·질감
          └─ Qwen3-VL 인코딩 (384×384로 축소!) ──> 의미 이해      ← 지시 해석
```

핵심은 **VLM이 384×384 넓이로 축소된 이미지를 본다**는 것이다.
612×816 레퍼런스가 약 332×442로 줄어든다. 그래서:

| 잘 유지됨 | 잘 샘 |
|---|---|
| 전체 실루엣, 비율, 재질감 | 눈 안쪽 구조(홍채·하이라이트) |
| 주요 색면 (주황 몸통, 크림 배) | 미묘한 색 구분 (진갈색 vs 검정) |
| 큰 특징 (무지개 꼬리) | 작은 특징 (분홍 볼, 3손가락) |

**대응은 하나다 — 새는 것들을 프롬프트에 글로 명시한다.** 모델이 못 본 걸 말로 채워준다.

---

## 2. 프롬프트 공식

순서대로 붙인다. 앞쪽일수록 강하게 작용한다.

```
[그림체 / 매체]  +  [캐릭터 앵커 + 고정 특징 나열]  +  [장면 / 포즈 / 표정]  +  [조명 / 카메라]
```

### ① 그림체 / 매체 — 맨 앞

바꾸고 싶은 게 그림체라면 **반드시 문장 맨 앞**에 둔다. 뒤에 붙이면 레퍼런스의 원래
질감에 눌린다.

```
Soft watercolour children's book illustration, visible cold-press paper grain,
loose ink linework, bleeding pigment edges, generous white space.
```

매체 이름 하나만 쓰지 말고 **그 매체의 물리적 흔적**을 2~3개 같이 적는다.
`watercolour` 한 단어보다 `paper grain / bleeding edges / loose linework`가 훨씬 세게 먹는다.

### ② 캐릭터 앵커 + 고정 특징

`The same ... character,` 로 시작해 동일 인물임을 못박고, **새는 특징을 전부 나열**한다.

```
The same needle-felted plush tiger cub, dark brown stripes, dark brown ear rims
with cream inner ears, warm brown eyes with white highlights, pink cheek blush,
cream muzzle and belly, rainbow-tipped tail,
```

이 덩어리는 **모든 페이지에서 토씨 하나 안 바꾸고 복붙**한다. 캐릭터 바이블이다.
장면마다 다르게 쓰면 캐릭터도 장면마다 달라진다.

### ③ 장면 / 포즈 / 표정

```
sitting on a wooden bench reading an open picture book, joyful open-mouth grin,
```

동작은 **하나만**. "뛰면서 손을 흔들고 뒤를 돌아본다"처럼 겹치면 뭉개진다.

### ④ 조명 / 카메라

```
warm afternoon light, soft blurred park background, shallow depth of field
```

조명은 그림체만큼 톤을 좌우한다. 페이지마다 바꿔서 시간의 흐름을 만들 수 있다
(아침 → 황금빛 → 달빛).

---

## 3. 완성 예시

```
Soft watercolour children's book illustration, visible cold-press paper grain,
loose ink linework, bleeding pigment edges, generous white space. The same
needle-felted plush tiger cub, dark brown stripes, dark brown ear rims with cream
inner ears, warm brown eyes with white highlights, pink cheek blush, cream muzzle
and belly, rainbow-tipped tail, standing in a meadow of tiny wildflowers, soft
warm backlight
```

`--prompt-file`은 **한 줄에 프롬프트 하나**다. 줄바꿈 없이 한 줄로 이어 쓴다.

---

## 4. 그림체 어휘 사전

각 항목의 뒤쪽 서술어가 실제로 일을 한다. 이름만 쓰면 약하다.

| 그림체 | 프롬프트 |
|---|---|
| 수채 동화책 | `soft watercolour children's book illustration, cold-press paper grain, loose ink linework, bleeding pigment edges` |
| 과슈 / 포스터 | `gouache picture-book painting, flat opaque brush strokes, visible brush texture, muted retro palette` |
| 크레용 / 색연필 | `children's crayon drawing, waxy stroke texture, uneven pressure, paper tooth showing through` |
| 종이 오려붙이기 | `paper cutout collage, layered construction paper, visible torn edges, drop shadows between layers` |
| 니들펠트 인형 | `needle-felted wool plush, visible wool fibre texture, soft handmade imperfection, macro product photography` |
| 클레이 애니메이션 | `claymation stop-motion still, plasticine with visible thumbprints and tool marks, miniature handmade set` |
| 3D 픽사풍 | `3D animated feature film still, subsurface scattering, soft global illumination, cinematic depth of field` |
| 2D 셀 애니 | `flat 2D cel-shaded anime illustration, bold clean outlines, two-tone shading, saturated poster colours, no gradients` |
| 목판화 | `woodblock print, bold carved linework, limited ink palette, visible grain and registration offset` |
| 그림자극 | `silhouette shadow-puppet theatre, backlit paper cutouts, warm amber glow behind` |

**동화책 시리즈는 그림체 한 줄을 통째로 고정**하고 장면만 바꾸는 게 정석이다.

### 실측: 레퍼런스와 먼 매체일수록 잘 바뀐다

니들펠트 인형(실사 촬영풍) 레퍼런스 1장으로 세 그림체를 시험한 결과:

| 프롬프트 그림체 | 결과 |
|---|---|
| 수채 동화책 | ✅ 완전 전환. 종이 흰 여백, 물감 번짐, 느슨한 선 |
| 2D 셀 애니 | ✅ 완전 전환. 플랫 컬러, 굵은 외곽선, 그라데이션 없음 |
| 클레이 애니메이션 | △ 부분 전환. 지문·공구 자국이 안 살고 펠트 질감과 섞임 |

**레퍼런스의 원래 매체와 가까운 그림체일수록 덜 바뀐다.** 펠트(실사 3D 공예)에서
클레이(역시 실사 3D 공예)로 가면 둘이 뭉개져 섞인다. 반면 2D 일러스트 계열로 가면
거리가 멀어서 깨끗하게 갈린다.

가까운 매체로 옮겨야 한다면 대비되는 서술어를 더 세게 넣는다 —
`glossy plasticine, sharp tool-carved edges, no fibre texture, smooth wet-clay surface`
처럼 **원래 매체를 부정하는 표현**(`no fibre texture`)을 넣으면 분리가 잘 된다.

---

## 5. 캐릭터 레퍼런스 준비

### 캐릭터 시트는 그대로 쓰지 말 것

3면도·콜아웃 원·화살표·`FRONT` `SIDE` 라벨이 들어간 시트를 그대로 넣으면
**모델이 그 레이아웃까지 재현**하려 든다. 콜아웃 원이 결과물에 그려져 나온다.

**정면 뷰만 잘라내서** 쓴다. 라벨 글자와 리더선이 안 들어가게 자른다.

```bash
magick sheet.png -crop 612x816+352+38 +repage char_front.png
```

### 레퍼런스는 딱 1장

**2~3장 넣으면 안 된다.** `TextEncodeQwenImageEditPlus`의 다중 이미지는
"서로 다른 피사체를 합성"(인물 + 배경 + 소품)하라는 의미로 학습돼 있다.
같은 캐릭터의 3면도를 넣으면 **캐릭터가 여러 마리로 분열**한다.
프롬프트에 "같은 캐릭터의 여러 뷰"라고 명시해도 안 통하고, 시간만 2배로 든다.

### 캐릭터가 프레임을 채우게

VLM 예산이 384×384뿐이라 여백이 많으면 캐릭터에 배정되는 픽셀이 줄어든다.
배경 여백은 잘라낸다.

---

## 6. 정규 레퍼런스 전략 (중요)

시트에서 매번 새로 유도하면 페이지마다 조금씩 다르게 나온다.

```
❌  시트 → 페이지1
    시트 → 페이지2      각자 다른 방향으로 드리프트
    시트 → 페이지3

✅  시트 → [후보 3~4장 생성] → 마음에 드는 1장 선택 = 정규 레퍼런스
                                      ↓
                              정규 → 페이지1, 페이지2, 페이지3 ...
```

**시트는 최초 1회만 쓰고 버린다.** 이후 모든 페이지는 확정된 정규 레퍼런스에서 나온다.
페이지 간 일관성이 훨씬 좋아진다. 정규 레퍼런스는 원하는 그림체로 이미 렌더된 상태라
그림체도 같이 고정되는 이득이 있다.

시리즈 작업 순서:

1. 시트 정면 뷰 크롭
2. 그림체 프롬프트 + 캐릭터 앵커로 후보 3~4장 (`--prompt` 반복 또는 `--seed` 변경)
3. 하나 선택 → ComfyUI `input/`에 `char_canon.png`로 복사
4. 이후 모든 페이지는 `--ref char_canon.png`

---

## 7. 파라미터

| 항목 | 값 | 이유 |
|---|---|---|
| `--cfg` | **1.5** | 1.0은 눈·볼·귀 테두리가 샌다. 2.5는 과포화로 붕괴 |
| `--lora` | `krea2_identity_edit_v1.safetensors` | **없으면 모자이크 블록 아티팩트** |
| `--steps` | 8 | Turbo 기본. 20으로 올려도 질감만 약간, 시간은 2배 |
| `--megapixels` | 1.2 | 2MP 학습 범위 상한 |
| `--seed` | 페이지마다 다르게 | 같은 시드 + 다른 프롬프트여도 구도가 비슷해짐 |

출력 종횡비는 **레퍼런스를 따라간다.** 가로 페이지가 필요하면 레퍼런스도 가로로 만들거나
`--width/--height`를 직접 준다.

---

## 8. 자주 겪는 증상과 처방

| 증상 | 원인 | 처방 |
|---|---|---|
| 격자 모자이크가 깔림 | LoRA 미적용 | `--lora krea2_identity_edit_v1.safetensors` |
| 캐릭터가 2마리 이상 | 레퍼런스 2장 이상 | 1장으로 |
| 눈이 새까맣게, 볼 사라짐 | cfg 1.0 | `--cfg 1.5` + 특징 명시 |
| 색이 형광, 질감 거침 | cfg 2.0 이상 | 1.5로 내림 |
| 콜아웃 원·라벨이 그려짐 | 캐릭터 시트 원본 사용 | 정면 뷰만 크롭 |
| 그림체가 안 바뀜 | 그림체가 문장 뒤쪽 | 맨 앞으로 + 물리적 흔적 서술 추가 |
| 페이지마다 조금씩 다름 | 시트에서 매번 유도 | 정규 레퍼런스 고정 (6장) |
| 포즈가 뭉개짐 | 동작을 여러 개 지시 | 동작 하나만 |

---

## 9. 영상으로 넘길 때

이렇게 만든 스틸을 `minimax_r2v.py`의 `--refs`로 넣으면 영상이 된다.
영상 프롬프트에서는 태그가 `<Picture 1>`로 바뀌고, 컷을 나눠 쓸 수 있다:

```
<Picture 1> is the character and art-direction reference: [캐릭터 앵커 그대로].
Keep his design, texture and lighting exactly as in <Picture 1>.

CUT 1 (0-3s): [동작]
CUT 2 (3-5s): [동작]

Audio: [환경음, 음악]
```

**캐릭터 앵커 덩어리는 이미지·영상 프롬프트에서 동일하게 유지**한다.
그림체 설명도 마찬가지로 넘겨준다 — 레퍼런스 스틸에 이미 반영돼 있어도, 글로 한 번 더
못박는 쪽이 안정적이다.
