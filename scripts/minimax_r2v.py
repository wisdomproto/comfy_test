#!/usr/bin/env python3
"""MiniMax H3 Reference-to-Video runner (ComfyUI API, stdlib only).

Usage:
  python scripts/minimax_r2v.py --refs hori_ref.png --prompt-file prompt.txt
  python scripts/minimax_r2v.py --refs a.png b.png --prompt "..." --width 832 --height 480

Reference images must already sit in ComfyUI's input/ folder (--refs takes filenames).
Prompt refers to them as <Picture 1>, <Picture 2>, ... in the order given.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

COMFY = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")

# 🔴 --model 로 갈아끼울 수 있다. w4a8(약 11GB) 은 int8(21GB) 의 절반이라 32GB RAM 에 들어가지만
#    ComfyUI 0.31.0 이상을 요구한다(0.30.2 에서는 못 쓴다).
DIFFUSION = os.environ.get(
    "MINIMAX_DIFFUSION", "minimax_h3_ref2va_pruned_int8_convrot.safetensors")
TEXT_ENCODER = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
VIDEO_VAE = "minimax_h3_video_vae_fp16.safetensors"
AUDIO_VAE = "minimax_h3_audio_vae_fp32.safetensors"


def get(path):
    with urllib.request.urlopen(f"{COMFY}{path}", timeout=30) as r:
        return json.load(r)


def post(path, payload):
    req = urllib.request.Request(
        f"{COMFY}{path}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def align_length(seconds, fps=24):
    """MiniMax H3 snaps frame counts to the 17k+5 grid."""
    n = max(5, round(seconds * fps))
    while n % 17 != 5:
        n += 1
    return n


def build(refs, prompt, width, height, length, steps, seed, ref_image_size, prefix,
          lora=None, lora_strength=1.0):
    g = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": DIFFUSION, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": TEXT_ENCODER, "type": "minimax", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VIDEO_VAE}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": AUDIO_VAE}},
        "10": {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": {
            "clip": ["2", 0], "vae": ["3", 0], "audio_vae": ["4", 0],
            "prompt": prompt, "width": width, "height": height,
            "length": length, "ref_image_size": ref_image_size}},
        "20": {"class_type": "BasicGuider", "inputs": {"model": ["1", 0], "conditioning": ["10", 0]}},
        "21": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "22": {"class_type": "BasicScheduler", "inputs": {
            "model": ["1", 0], "scheduler": "simple", "steps": steps, "denoise": 1.0}},
        "23": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "24": {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["23", 0], "guider": ["20", 0], "sampler": ["21", 0],
            "sigmas": ["22", 0], "latent_image": ["10", 1]}},
        "30": {"class_type": "VAEDecode", "inputs": {"samples": ["24", 0], "vae": ["3", 0]}},
        "31": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["24", 0], "vae": ["4", 0]}},
        "40": {"class_type": "CreateVideo", "inputs": {
            "images": ["30", 0], "fps": 24, "audio": ["31", 0]}},
        "41": {"class_type": "SaveVideo", "inputs": {
            "video": ["40", 0], "filename_prefix": prefix, "format": "auto", "codec": "auto"}},
    }
    # Turbo LoRA — 20스텝을 6~8스텝으로 줄인다. 🔴 모델을 받는 노드가 둘(guider·scheduler)이라
    # 둘 다 LoRA 출력으로 갈아끼워야 한다. 한쪽만 바꾸면 스텝만 줄고 품질이 무너진다.
    if lora:
        g["2b"] = {"class_type": "LoraLoaderModelOnly",
                   "inputs": {"model": ["1", 0], "lora_name": lora, "strength_model": lora_strength}}
        g["20"]["inputs"]["model"] = ["2b", 0]
        g["22"]["inputs"]["model"] = ["2b", 0]

    # LoadImage per reference. The node's ref_images socket is an Autogrow input, so
    # the API key is the dotted path "<autogrow id>.<template name>", not a flat name.
    for i, name in enumerate(refs):
        nid = f"5{i}"
        g[nid] = {"class_type": "LoadImage", "inputs": {"image": name}}
        g["10"]["inputs"][f"ref_images.ref_image_{i}"] = [nid, 0]
    return g


def verify_schema(graph):
    """Fail loudly on a node/input name the running ComfyUI doesn't know."""
    info = get("/object_info")
    problems = []
    for nid, node in graph.items():
        ct = node["class_type"]
        if ct not in info:
            problems.append(f"node {nid}: unknown class_type {ct}")
            continue
        spec = info[ct]["input"]
        known = set(spec.get("required", {})) | set(spec.get("optional", {}))
        # autogrow sockets are declared via a template, so /object_info lists only the
        # container ("ref_images"); the per-slot dotted keys are expanded at prompt time
        for k in node["inputs"]:
            if k in known or k.split(".")[0] in known:
                continue
            problems.append(f"node {nid} ({ct}): unknown input '{k}' (known: {sorted(known)})")
    if problems:
        sys.exit("Schema mismatch:\n  " + "\n  ".join(problems))


def run(graph):
    client_id = str(uuid.uuid4())
    res = post("/prompt", {"prompt": graph, "client_id": client_id})
    pid = res["prompt_id"]
    print(f"queued prompt_id={pid}", flush=True)

    started = time.time()
    last = None
    # 🔴 무한 대기 금지 — 실제로 한 쪽이 568분(9.5시간) "running" 에 걸려 밤새 배치가 멈춘 적이 있다.
    #    GPU 는 4% 로 놀고 있었고 프로세스는 살아 있어서 겉으로는 정상으로 보였다.
    #    832x480 8스텝 기준 가장 긴 쪽도 10분을 넘지 않으므로 30분이면 충분히 넉넉하다.
    timeout_s = float(os.environ.get("MINIMAX_TIMEOUT_MIN", "30")) * 60
    while True:
        if time.time() - started > timeout_s:
            sys.exit(f"timeout: {timeout_s/60:.0f}분 안에 안 끝났다 (prompt_id={pid}) "
                     f"— ComfyUI 를 재시작하고 그 쪽만 다시 돌려라")
        time.sleep(5)
        hist = get(f"/history/{pid}")
        if pid in hist:
            entry = hist[pid]
            status = entry.get("status", {})
            if status.get("status_str") == "error" or not status.get("completed", True):
                for msg in status.get("messages", []):
                    print(msg, flush=True)
                sys.exit("generation failed")
            elapsed = time.time() - started
            outs = []
            for node_out in entry.get("outputs", {}).values():
                for key in ("images", "videos", "gifs"):
                    for f in node_out.get(key, []):
                        outs.append(f"{f.get('subfolder','')}/{f['filename']}".lstrip("/"))
            print(f"done in {elapsed/60:.1f} min -> {outs}", flush=True)
            return outs
        q = get("/queue")
        state = "running" if q.get("queue_running") else "queued"
        mins = int((time.time() - started) / 60)
        if (state, mins) != last:
            print(f"[{mins:3d} min] {state}", flush=True)
            last = (state, mins)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refs", nargs="+", required=True,
                    help="filenames already present in ComfyUI/input/")
    ap.add_argument("--prompt")
    ap.add_argument("--prompt-file")
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--height", type=int, default=384)
    ap.add_argument("--seconds", type=float, default=5.0)
    ap.add_argument("--steps", type=int, default=20)
    ap.add_argument("--seed", type=int, default=12345)
    ap.add_argument("--ref-image-size", choices=["match", "max"], default="match")
    ap.add_argument("--prefix", default="video/minimax_r2v")
    ap.add_argument("--lora", help="예: minimax_h3_turbo_v4_step600_ema.safetensors")
    ap.add_argument("--lora-strength", type=float, default=1.0)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    if len(a.refs) > 9:
        sys.exit("MiniMax H3 accepts at most 9 reference images")
    for dim, name in ((a.width, "width"), (a.height, "height")):
        if dim % 32:
            sys.exit(f"{name} must be a multiple of 32 (got {dim})")

    prompt = a.prompt
    if a.prompt_file:
        prompt = open(a.prompt_file, encoding="utf-8").read().strip()
    if not prompt:
        sys.exit("need --prompt or --prompt-file")

    length = align_length(a.seconds)
    print(f"{a.width}x{a.height}, {length} frames ({length/24:.2f}s @24fps), "
          f"{a.steps} steps, refs={a.refs}" + (f", lora={a.lora}" if a.lora else ""), flush=True)

    graph = build(a.refs, prompt, a.width, a.height, length,
                  a.steps, a.seed, a.ref_image_size, a.prefix, a.lora, a.lora_strength)
    if a.dry_run:
        print(json.dumps(graph, indent=2, ensure_ascii=False))
        return
    verify_schema(graph)
    run(graph)


if __name__ == "__main__":
    main()
