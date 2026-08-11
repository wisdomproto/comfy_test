#!/usr/bin/env python3
"""Video finishing pass: RealESRGAN upscale + RIFE frame interpolation.

MiniMax H3's own upscaler is unreleased and the base model only trains at mid
resolution, so the practical route is classic pixel upscaling plus interpolation.

Usage:
  python scripts/video_finish.py --video hori_autumn_raw.mp4
  python scripts/video_finish.py --video x.mp4 --scale-down 0.5 --multiplier 3

Input video must already sit in ComfyUI/input/. Audio is carried through
unchanged — interpolation changes the frame count, not the duration, so output
fps is scaled by the same multiplier to keep playback real-time.
"""
import argparse
import json
import os
import sys
import time
import urllib.request
import uuid

COMFY = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
SRC_FPS = 24.0


def get(path):
    with urllib.request.urlopen(f"{COMFY}{path}", timeout=30) as r:
        return json.load(r)


def post(path, payload):
    req = urllib.request.Request(
        f"{COMFY}{path}", data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def build(video, upscale_model, interp_model, multiplier, scale_down, fps, prefix):
    g = {
        "1": {"class_type": "LoadVideo", "inputs": {"file": video}},
        "2": {"class_type": "GetVideoComponents", "inputs": {"video": ["1", 0]}},
        "3": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": upscale_model}},
        "4": {"class_type": "ImageUpscaleWithModel",
              "inputs": {"upscale_model": ["3", 0], "image": ["2", 0]}},
    }
    frames = ["4", 0]
    # the anime model is 4x; step back down when a smaller target is wanted
    if scale_down and scale_down != 1.0:
        g["5"] = {"class_type": "ImageScaleBy", "inputs": {
            "image": frames, "upscale_method": "lanczos", "scale_by": scale_down}}
        frames = ["5", 0]
    if multiplier > 1:
        g["6"] = {"class_type": "FrameInterpolationModelLoader",
                  "inputs": {"model_name": interp_model}}
        g["7"] = {"class_type": "FrameInterpolate", "inputs": {
            "interp_model": ["6", 0], "images": frames, "multiplier": multiplier}}
        frames = ["7", 0]
    g["8"] = {"class_type": "CreateVideo",
              "inputs": {"images": frames, "fps": fps, "audio": ["2", 1]}}
    g["9"] = {"class_type": "SaveVideo", "inputs": {
        "video": ["8", 0], "filename_prefix": prefix, "format": "auto", "codec": "auto"}}
    return g


def verify(graph):
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
            if k not in known and k.split(".")[0] not in known:
                problems.append(f"node {nid} ({ct}): unknown input '{k}'")
    if problems:
        sys.exit("Schema mismatch:\n  " + "\n  ".join(problems))


def combo_options(info, node, key):
    spec = info[node]["input"]["required"][key]
    if len(spec) > 1 and isinstance(spec[1], dict) and "options" in spec[1]:
        return spec[1]["options"]
    return spec[0] if isinstance(spec[0], list) else []


def run(graph):
    pid = post("/prompt", {"prompt": graph, "client_id": str(uuid.uuid4())})["prompt_id"]
    print(f"queued prompt_id={pid}", flush=True)
    started, last = time.time(), None
    while True:
        time.sleep(5)
        hist = get(f"/history/{pid}")
        if pid in hist:
            entry = hist[pid]
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                for m in status.get("messages", []):
                    if m[0] == "execution_error":
                        print(f"  {m[1].get('node_type')}: {m[1].get('exception_message')}", flush=True)
                sys.exit("finishing pass failed")
            outs = [f"{f.get('subfolder','')}/{f['filename']}".lstrip("/")
                    for o in entry.get("outputs", {}).values()
                    for k in ("videos", "images", "gifs") for f in o.get(k, [])]
            print(f"done in {(time.time()-started)/60:.1f} min -> {outs}", flush=True)
            return outs
        mins = int((time.time() - started) / 60)
        if mins != last:
            print(f"[{mins:3d} min] running", flush=True)
            last = mins


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True, help="filename in ComfyUI/input/")
    ap.add_argument("--upscale-model", default="realesr-animevideov3.pth")
    ap.add_argument("--interp-model", default="rife_v4.26_heavy.safetensors")
    ap.add_argument("--multiplier", type=int, default=2, choices=range(1, 9),
                    help="frame multiplier; 1 disables interpolation")
    ap.add_argument("--scale-down", type=float, default=0.5,
                    help="resize factor applied after the 4x model (0.5 -> net 2x)")
    ap.add_argument("--src-fps", type=float, default=SRC_FPS)
    ap.add_argument("--prefix", default="video/finished")
    a = ap.parse_args()

    info = get("/object_info")
    for node, key, want in (("UpscaleModelLoader", "model_name", a.upscale_model),
                            ("FrameInterpolationModelLoader", "model_name", a.interp_model),
                            ("LoadVideo", "file", a.video)):
        if a.multiplier == 1 and node == "FrameInterpolationModelLoader":
            continue
        opts = combo_options(info, node, key)
        if want not in opts:
            sys.exit(f"{node}.{key}: '{want}' not available. Options: {opts}")

    fps = a.src_fps * a.multiplier
    print(f"{a.video}: 4x {a.upscale_model} x{a.scale_down} resize, "
          f"x{a.multiplier} interpolation -> {fps:g} fps", flush=True)

    graph = build(a.video, a.upscale_model, a.interp_model,
                  a.multiplier, a.scale_down, fps, a.prefix)
    verify(graph)
    run(graph)


if __name__ == "__main__":
    main()
