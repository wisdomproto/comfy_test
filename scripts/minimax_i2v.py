#!/usr/bin/env python3
"""MiniMax H3 Image-to-Video runner — 이미지를 **첫 프레임으로 고정**한다 (ComfyUI API, stdlib only).

  python scripts/minimax_i2v.py --first page1.png --prompt-file motion.txt --seconds 12

minimax_r2v.py 와의 차이:
  - 노드가 `MiniMaxH3ImageToVideo`(first_frame/last_frame) 이고 모델은 **fl2va** 쪽이다.
  - 🔴 **오디오를 만들지 않는다.** R2V 만 audio_vae 를 받는다. 효과음이 필요하면 같은 장면의
    R2V 클립에서 오디오만 뽑아 얹는다(같은 장면이라 그대로 맞는다).
  - 🔴 **컷을 나눌 수 없다.** 첫 프레임에서 이어지는 한 장면이므로 프롬프트에 CUT/Shot 을
    쓰지 말고 카메라·피사체의 연속 움직임만 쓴다.

첫 프레임 이미지는 ComfyUI input/ 에 있어야 한다(파일명만 넘김).
"""
import argparse
import json
import os
import sys
import time
import urllib.request
import uuid

COMFY = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")

DIFFUSION = "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
TEXT_ENCODER = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
VIDEO_VAE = "minimax_h3_video_vae_fp16.safetensors"


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
    """MiniMax H3 는 프레임 수를 17k+5 격자로 스냅한다."""
    n = max(5, round(seconds * fps))
    while n % 17 != 5:
        n += 1
    return n


def build(first, last, prompt, width, height, length, steps, seed, prefix):
    g = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": DIFFUSION, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": TEXT_ENCODER, "type": "minimax", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VIDEO_VAE}},
        "50": {"class_type": "LoadImage", "inputs": {"image": first}},
        "10": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {
            "clip": ["2", 0], "vae": ["3", 0],
            "prompt": prompt, "width": width, "height": height, "length": length,
            "first_frame": ["50", 0]}},
        "20": {"class_type": "BasicGuider", "inputs": {"model": ["1", 0], "conditioning": ["10", 0]}},
        "21": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "22": {"class_type": "BasicScheduler", "inputs": {
            "model": ["1", 0], "scheduler": "simple", "steps": steps, "denoise": 1.0}},
        "23": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "24": {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["23", 0], "guider": ["20", 0], "sampler": ["21", 0],
            "sigmas": ["22", 0], "latent_image": ["10", 1]}},
        "30": {"class_type": "VAEDecode", "inputs": {"samples": ["24", 0], "vae": ["3", 0]}},
        "40": {"class_type": "CreateVideo", "inputs": {"images": ["30", 0], "fps": 24}},
        "41": {"class_type": "SaveVideo", "inputs": {
            "video": ["40", 0], "filename_prefix": prefix, "format": "auto", "codec": "auto"}},
    }
    if last:
        g["51"] = {"class_type": "LoadImage", "inputs": {"image": last}}
        g["10"]["inputs"]["last_frame"] = ["51", 0]
    return g


def verify_schema(graph):
    """실행 중인 ComfyUI 가 모르는 노드/입력이면 GPU 를 태우기 전에 죽는다."""
    info = get("/object_info")
    problems = []
    for nid, node in graph.items():
        ct = node["class_type"]
        if ct not in info:
            problems.append(f"node {nid}: unknown class_type {ct}")
            continue
        spec = info[ct]["input"]
        known = set(spec.get("required", {})) | set(spec.get("optional", {}))
        for k in node["inputs"]:
            if k in known or k.split(".")[0] in known:
                continue
            problems.append(f"node {nid} ({ct}): unknown input '{k}' (known: {sorted(known)})")
    if problems:
        sys.exit("Schema mismatch:\n  " + "\n  ".join(problems))


def run(graph):
    res = post("/prompt", {"prompt": graph, "client_id": str(uuid.uuid4())})
    pid = res["prompt_id"]
    print(f"queued prompt_id={pid}", flush=True)
    started, last = time.time(), None
    while True:
        time.sleep(5)
        hist = get(f"/history/{pid}")
        if pid in hist:
            entry = hist[pid]
            status = entry.get("status", {})
            if status.get("status_str") == "error" or not status.get("completed", True):
                for msg in status.get("messages", []):
                    print(msg, flush=True)
                sys.exit("generation failed")
            outs = []
            for node_out in entry.get("outputs", {}).values():
                for key in ("images", "videos", "gifs"):
                    for f in node_out.get(key, []):
                        outs.append(f"{f.get('subfolder','')}/{f['filename']}".lstrip("/"))
            print(f"done in {(time.time()-started)/60:.1f} min -> {outs}", flush=True)
            return outs
        mins = int((time.time() - started) / 60)
        if mins != last:
            print(f"[{mins:3d} min] running", flush=True)
            last = mins


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--first", required=True, help="첫 프레임 — ComfyUI input/ 안의 파일명")
    ap.add_argument("--last", help="끝 프레임(선택)")
    ap.add_argument("--prompt")
    ap.add_argument("--prompt-file")
    ap.add_argument("--width", type=int, default=832)
    ap.add_argument("--height", type=int, default=480)
    ap.add_argument("--seconds", type=float, default=5.0)
    ap.add_argument("--steps", type=int, default=20)
    ap.add_argument("--seed", type=int, default=12345)
    ap.add_argument("--prefix", default="video/minimax_i2v")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

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
          f"{a.steps} steps, first={a.first}" + (f", last={a.last}" if a.last else ""), flush=True)

    graph = build(a.first, a.last, prompt, a.width, a.height, length, a.steps, a.seed, a.prefix)
    if a.dry_run:
        print(json.dumps(graph, indent=2, ensure_ascii=False))
        return
    verify_schema(graph)
    run(graph)


if __name__ == "__main__":
    main()
