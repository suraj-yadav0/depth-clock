#!/usr/bin/env python3
import sys
import os
import time
import json
import urllib.parse
from pathlib import Path
import numpy as np
from PIL import Image
import onnxruntime as ort

MODEL_PATH = Path.home() / '.local/share/depth-clock/models/rmbg-1.4.onnx'

def parse_image_path(raw_path):
    if raw_path.startswith('file://'):
        parsed = urllib.parse.urlparse(raw_path)
        return urllib.parse.unquote(parsed.path)
    return raw_path

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
            int(r_left * orig_w),
            int(r_top * orig_h),
            int(r_right * orig_w),
            int(r_bottom * orig_h)
        )
        orig_img = orig_img.crop(box)
    elif crop_box and len(crop_box) == 4:
        orig_img = orig_img.crop(crop_box)
    
    target_w, target_h = orig_img.size
    
    session_options = ort.SessionOptions()
    session_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session_options.intra_op_num_threads = min(8, os.cpu_count() or 4)
    
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
    
    # Normalize mask 0..1
    min_val = np.min(raw_mask)
    max_val = np.max(raw_mask)
    norm_mask = (raw_mask - min_val) / (max_val - min_val + 1e-8)
    
    # Resize mask to original target dimensions
    mask_u8 = (norm_mask * 255.0).astype(np.uint8)
    mask_img = Image.fromarray(mask_u8, mode='L')
    mask_full = mask_img.resize((target_w, target_h), Image.Resampling.BILINEAR)
    
    # Create RGBA cutout
    cutout = orig_img.copy()
    cutout.putalpha(mask_full)
    
    out_path = Path(output_png)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cutout.save(str(out_path), format='PNG')
    
    # Analyze mask for clock occlusion (clock is roughly top 10% to 50%)
    mask_arr = np.array(mask_full)
    clock_zone = mask_arr[int(target_h * 0.1):int(target_h * 0.5), :]
    clock_occlusion = float(np.mean(clock_zone > 128))
    total_foreground = float(np.mean(mask_arr > 128))
    
    meta = {
        "width": target_w,
        "height": target_h,
        "foreground_ratio": round(total_foreground, 3),
        "clock_zone_occlusion": round(clock_occlusion, 3),
        "depth_viable": clock_occlusion < 0.85 and total_foreground > 0.05,
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
