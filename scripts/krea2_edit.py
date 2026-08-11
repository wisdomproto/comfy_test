#!/usr/bin/env python3
"""Krea 2 reference-image runner (ComfyUI API, stdlib only).

Reference image(s) in, new image out — the Qwen3-VL text encoder sees the
references while reading the prompt, and their VAE latents ride along as clean
in-context tokens, so the subject's identity survives a scene/pose change.

Usage:
  python scripts/krea2_edit.py --ref hori_front.png --prompt "..."
  python scripts/krea2_edit.py --ref subject.png scene.png --prompt-file p.txt

Native ComfyUI nodes only (>=0.30). The comfyui-krea2edit custom pack targets an
older forward() signature and breaks on 0.30.x; TextEncodeQwenImageEditPlus is
the in-tree equivalent and takes up to 3 references.

Turbo runs at 8 steps / CFG 1. Generation stays at or below 2MP.
"""
import argparse
import json
import os
import struct
import sys
import time
import urllib.request
import uuid

COMFY = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
INPUT_DIR = os.environ.get(
    "COMFY_INPUT", "C:/ComfyUI_windows_portable/ComfyUI/input")

DIFFUSION = "krea2_turbo_fp8_scaled.safetensors"
TEXT_ENCODER = "qwen3vl_4b_fp8_scaled.safetensors"
VAE = "qwen_image_vae.safetensors"

MAX_PIXELS = 2_000_000


def get(path):
    with urllib.request.urlopen(f"{COMFY}{path}", timeout=30) as r:
        return json.load(r)


def post(path, payload):
    req = urllib.request.Request(
        f"{COMFY}{path}", data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def build(refs, prompt, width, height, steps, cfg, seed, lora, lora_strength, prefix,
          ref_method="index_timestep_zero"):
    g = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": DIFFUSION, "weight_dtype": "default"}},
        "3": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": TEXT_ENCODER, "type": "krea2", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        # VLM-grounded encode: the encoder sees the refs, and their latents become
        # reference_latents on the conditioning
        "9": {"class_type": "TextEncodeQwenImageEditPlus",
              "inputs": {"clip": ["3", 0], "vae": ["4", 0], "prompt": prompt}},
        "10": {"class_type": "FluxKontextMultiReferenceLatentMethod",
               "inputs": {"conditioning": ["9", 0],
                          "reference_latents_method": ref_method}},
        "11": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["10", 0]}},
        "12": {"class_type": "ModelSamplingFlux", "inputs": {
            "model": ["2", 0] if lora else ["1", 0],
            "max_shift": 1.15, "base_shift": 0.5, "width": width, "height": height}},
        "13": {"class_type": "CFGGuider", "inputs": {
            "model": ["12", 0], "positive": ["10", 0], "negative": ["11", 0], "cfg": cfg}},
        "14": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "15": {"class_type": "BasicScheduler", "inputs": {
            "model": ["12", 0], "scheduler": "simple", "steps": steps, "denoise": 1.0}},
        "16": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "17": {"class_type": "EmptyLatentImage",
               "inputs": {"width": width, "height": height, "batch_size": 1}},
        "18": {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["16", 0], "guider": ["13", 0], "sampler": ["14", 0],
            "sigmas": ["15", 0], "latent_image": ["17", 0]}},
        "19": {"class_type": "VAEDecode", "inputs": {"samples": ["18", 0], "vae": ["4", 0]}},
        "20": {"class_type": "SaveImage",
               "inputs": {"images": ["19", 0], "filename_prefix": prefix}},
    }
    if lora:
        g["2"] = {"class_type": "LoraLoaderModelOnly", "inputs": {
            "model": ["1", 0], "lora_name": lora, "strength_model": lora_strength}}
    for i, name in enumerate(refs, 1):
        nid = f"5{i}"
        g[nid] = {"class_type": "LoadImage", "inputs": {"image": name}}
        g["9"]["inputs"][f"image{i}"] = [nid, 0]
    return g


def verify_schema(graph):
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
            if k not in known:
                problems.append(f"node {nid} ({ct}): unknown input '{k}' (known: {sorted(known)})")
    if problems:
        sys.exit("Schema mismatch:\n  " + "\n  ".join(problems))


def run(graph, label=""):
    pid = post("/prompt", {"prompt": graph, "client_id": str(uuid.uuid4())})["prompt_id"]
    started = time.time()
    while True:
        time.sleep(3)
        hist = get(f"/history/{pid}")
        if pid not in hist:
            continue
        entry = hist[pid]
        status = entry.get("status", {})
        if status.get("status_str") == "error":
            for m in status.get("messages", []):
                if m[0] == "execution_error":
                    print(f"  {m[1].get('node_type')}: {m[1].get('exception_message')}", flush=True)
            sys.exit(f"generation failed ({label})")
        outs = [f"{f.get('subfolder','')}/{f['filename']}".lstrip("/")
                for o in entry.get("outputs", {}).values() for f in o.get("images", [])]
        print(f"  {label} done in {time.time()-started:.0f}s -> {outs}", flush=True)
        return outs


def png_size(name):
    with open(f"{INPUT_DIR}/{name}", "rb") as f:
        head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        sys.exit(f"{name}: only PNG sources are auto-sized; pass --width/--height")
    return struct.unpack(">II", head[16:24])


def target_size(ref, budget):
    """Source aspect ratio, <= budget pixels, both axes /8."""
    w, h = png_size(ref)
    scale = (budget / (w * h)) ** 0.5  # scales up too: output res is the target latent
    return max(8, int(w * scale) // 8 * 8), max(8, int(h * scale) // 8 * 8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", nargs="+", required=True,
                    help="up to 3 filenames in ComfyUI/input/ (subject first)")
    ap.add_argument("--prompt", action="append", default=[], help="repeat for a batch")
    ap.add_argument("--prompt-file", help="one prompt per non-empty line")
    ap.add_argument("--width", type=int)
    ap.add_argument("--height", type=int)
    ap.add_argument("--megapixels", type=float, default=1.2)
    ap.add_argument("--steps", type=int, default=8, help="Turbo fast path")
    ap.add_argument("--cfg", type=float, default=1.0, help="Turbo fast path")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--lora", help="e.g. krea2_identity_edit_v1.safetensors")
    ap.add_argument("--lora-strength", type=float, default=1.0)
    ap.add_argument("--ref-method", default="index_timestep_zero",
                    choices=["offset", "index", "uxo/uno", "index_timestep_zero"])
    ap.add_argument("--prefix", default="krea2_ref/out")
    a = ap.parse_args()

    if len(a.ref) > 3:
        sys.exit("TextEncodeQwenImageEditPlus takes at most 3 reference images")

    prompts = list(a.prompt)
    if a.prompt_file:
        prompts += [l.strip() for l in open(a.prompt_file, encoding="utf-8") if l.strip()]
    if not prompts:
        sys.exit("need --prompt or --prompt-file")

    if a.width and a.height:
        w, h = a.width, a.height
    else:
        w, h = target_size(a.ref[0], min(a.megapixels, 2.0) * 1_000_000)
    if w * h > MAX_PIXELS:
        sys.exit(f"{w}x{h} exceeds the 2MP trained range")

    print(f"{w}x{h} ({w*h/1e6:.2f}MP), {a.steps} steps, cfg {a.cfg}, "
          f"lora={a.lora or 'none'}, refs={a.ref}", flush=True)

    for i, p in enumerate(prompts):
        graph = build(a.ref, p, w, h, a.steps, a.cfg, a.seed + i,
                      a.lora, a.lora_strength, a.prefix, a.ref_method)
        if i == 0:
            verify_schema(graph)
        print(f"[{i+1}/{len(prompts)}] {p[:70]}", flush=True)
        run(graph, label=f"{i+1}/{len(prompts)}")


if __name__ == "__main__":
    main()
