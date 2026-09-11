#!/usr/bin/env python3
import sys
import os
import time
import json
import urllib.parse
from pathlib import Path
import colorsys
import numpy as np
from PIL import Image
import onnxruntime as ort

MODEL_PATH = Path.home() / '.local/share/depth-clock/models/rmbg-1.4.onnx'

def parse_image_path(raw_path):
    if raw_path.startswith('file://'):
        parsed = urllib.parse.urlparse(raw_path)
        return urllib.parse.unquote(parsed.path)
    return raw_path

def compute_adaptive_clock_color(image):
    thumb = image.resize((96, 96), Image.Resampling.BILINEAR)
    arr = np.array(thumb, dtype=np.float32) / 255.0
    h, w, _ = arr.shape

    clock_zone = arr[int(h * 0.12):int(h * 0.50), :]
    lum_map = 0.2126 * clock_zone[:, :, 0] + 0.7152 * clock_zone[:, :, 1] + 0.0722 * clock_zone[:, :, 2]
    bg_lum = float(np.mean(lum_map))

    best_score = -1.0
    best_h = 0.6
    best_s = 0.3

    for r, g, b in arr.reshape(-1, 3)[::2]:
        h_val, l_val, s_val = colorsys.rgb_to_hls(r, g, b)
        if 0.15 < l_val < 0.85 and s_val > 0.12:
            score = s_val * (1.0 - abs(l_val - 0.5) * 0.8)
            if score > best_score:
                best_score = score
                best_h = h_val
                best_s = s_val

    is_monochrome = (best_score < 0)
    if bg_lum < 0.52:
        target_l = 0.91
        target_s = 0.05 if is_monochrome else min(0.42, max(0.22, best_s * 0.75))
    else:
        target_l = 0.18
        target_s = 0.08 if is_monochrome else min(0.55, max(0.28, best_s * 0.85))

    fr, fg, fb = colorsys.hls_to_rgb(best_h, target_l, target_s)
    r_hex = int(round(max(0.0, min(1.0, fr)) * 255))
    g_hex = int(round(max(0.0, min(1.0, fg)) * 255))
    b_hex = int(round(max(0.0, min(1.0, fb)) * 255))
    return f"#{r_hex:02x}{g_hex:02x}{b_hex:02x}"

def process_wallpaper(input_path, output_png, crop_box=None, crop_ratio=None):
    clean_path = parse_image_path(input_path)
    if not os.path.exists(clean_path):
        raise FileNotFoundError(f"Input image not found: {clean_path}")

    start_time = time.time()
    orig_img = Image.open(clean_path).convert('RGB')
    orig_w, orig_h = orig_img.size
    
    # Handle normalized crop ratios (left_ratio, top_ratio, right_ratio, bottom_ratio)
    if crop_ratio and len(crop_ratio) == 4:
        r_left, r_top, r_right, r_bottom = crop_ratio
        box = (
            int(round(r_left * orig_w)),
            int(round(r_top * orig_h)),
            int(round(r_right * orig_w)),
            int(round(r_bottom * orig_h))
        )
        orig_img = orig_img.crop(box)
    elif crop_box and len(crop_box) == 4:
        orig_img = orig_img.crop(crop_box)
    
    target_w, target_h = orig_img.size
    
    session_options = ort.SessionOptions()
    session_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session_options.intra_op_num_threads = min(4, os.cpu_count() or 2)
    session_options.inter_op_num_threads = 1
    
    session = ort.InferenceSession(str(MODEL_PATH), session_options, providers=['CPUExecutionProvider'])
    input_name = session.get_inputs()[0].name
    
    # Resize to model input shape
    model_size = (1024, 1024)
    resized_img = orig_img.resize(model_size, Image.Resampling.BILINEAR)
    img_data = np.array(resized_img, dtype=np.float32) / 255.0
    img_data = (img_data - 0.5) / 1.0
    img_data = np.transpose(img_data, (2, 0, 1))
    img_data = np.expand_dims(img_data, axis=0)
    
    # Run inference
    outputs = session.run(None, {input_name: img_data})
    raw_mask = outputs[0][0][0]
    
    # RMBG-1.4 outputs probabilities in [0.0, 1.0].
    # Clean background noise so transparent areas are strictly 0 to prevent ghosting.
    prob_mask = np.clip(raw_mask, 0.0, 1.0)
    cleaned_mask = np.where(prob_mask < 0.25, 0.0, prob_mask)
    cleaned_mask = np.clip((cleaned_mask - 0.25) / 0.5, 0.0, 1.0)
    
    # Resize mask to original target dimensions
    mask_u8 = (cleaned_mask * 255.0).astype(np.uint8)
    mask_img = Image.fromarray(mask_u8, mode='L')
    mask_full = mask_img.resize((target_w, target_h), Image.Resampling.BILINEAR)
    
    # Create RGBA cutout
    cutout = orig_img.copy()
    cutout.putalpha(mask_full)
    
    out_path = Path(output_png)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cutout.save(str(out_path), format='PNG')
    
    # Analyze mask directly on 1024x1024 neural net output
    # Avoids expensive 4K median filtering and full-resolution array allocation
    clock_zone = mask_u8[int(1024 * 0.1):int(1024 * 0.5), :]
    clock_occlusion = float(np.mean(clock_zone > 128))
    total_foreground = float(np.mean(mask_u8 > 128))
    
    is_fg = mask_u8 > 128
    has_fg = np.any(is_fg, axis=0)
    first_fg_y = np.where(has_fg, np.argmax(is_fg, axis=0), 1024)

    sample_indices = np.linspace(0, 1024 - 1, 256, dtype=int)
    raw_samples = [float(first_fg_y[idx]) / 1024.0 for idx in sample_indices]

    kernel = np.array([0.05, 0.2, 0.5, 0.2, 0.05])
    padded = np.pad(raw_samples, (2, 2), mode='edge')
    smoothed = np.convolve(padded, kernel, mode='valid')
    contour_samples = [round(float(v), 4) for v in smoothed]

    meta = {
        "width": target_w,
        "height": target_h,
        "foreground_ratio": round(total_foreground, 3),
        "clock_zone_occlusion": round(clock_occlusion, 3),
        "depth_viable": clock_occlusion < 0.85 and total_foreground > 0.05,
        "suggested_color": compute_adaptive_clock_color(orig_img),
        "contour_samples": contour_samples,
        "render_time": round(time.time() - start_time, 2)
    }
    
    meta_path = out_path.with_suffix('.json')
    with open(meta_path, 'w') as f:
        json.dump(meta, f, indent=2)
        
    print(f"OK {out_path} ({meta['render_time']}s, occlusion={meta['clock_zone_occlusion']})")

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description="Depth Clock Wallpaper Segmenter")
    parser.add_argument("input", help="Path or URI to input wallpaper image")
    parser.add_argument("output", help="Path to output cutout PNG")
    parser.add_argument("--crop-box", nargs=4, type=int, metavar=('LEFT', 'TOP', 'RIGHT', 'BOTTOM'),
                        help="Pixel crop rectangle")
    parser.add_argument("--crop-ratio", nargs=4, type=float, metavar=('LEFT', 'TOP', 'RIGHT', 'BOTTOM'),
                        help="Normalized 0..1 crop rectangle")
    
    args = parser.parse_args()
    process_wallpaper(args.input, args.output, crop_box=args.crop_box, crop_ratio=args.crop_ratio)
