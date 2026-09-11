import sys
import os
import time
from pathlib import Path
import numpy as np
from PIL import Image
import onnxruntime as ort

def run_segmentation(input_path, output_path, model_path):
    start_time = time.time()
    
    session_options = ort.SessionOptions()
    session_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session_options.intra_op_num_threads = min(4, os.cpu_count() or 2)
    session_options.inter_op_num_threads = 1
    
    session = ort.InferenceSession(str(model_path), session_options, providers=['CPUExecutionProvider'])
    input_name = session.get_inputs()[0].name
    
    orig_img = Image.open(input_path).convert('RGB')
    orig_w, orig_h = orig_img.size
    
    resized_img = orig_img.resize((1024, 1024), Image.Resampling.BILINEAR)
    img_data = np.array(resized_img, dtype=np.float32) / 255.0
    img_data = (img_data - 0.5) / 1.0
    img_data = np.transpose(img_data, (2, 0, 1))
    img_data = np.expand_dims(img_data, axis=0)
    
    outputs = session.run(None, {input_name: img_data})
    raw_mask = outputs[0][0][0]
    
    min_val = np.min(raw_mask)
    max_val = np.max(raw_mask)
    norm_mask = (raw_mask - min_val) / (max_val - min_val + 1e-8)
    
    mask_u8 = (norm_mask * 255.0).astype(np.uint8)
    mask_img = Image.fromarray(mask_u8, mode='L')
    mask_resized = mask_img.resize((orig_w, orig_h), Image.Resampling.BILINEAR)
    
    result_img = orig_img.copy()
    result_img.putalpha(mask_resized)
    
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    result_img.save(str(output_path), format='PNG')
    
    elapsed = time.time() - start_time
    print(f"Processed {input_path} in {elapsed:.2f}s -> {output_path}")

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python test_segment.py <input> <output>")
        sys.exit(1)
    
    model = Path.home() / '.local/share/depth-clock/models/rmbg-1.4.onnx'
    run_segmentation(sys.argv[1], sys.argv[2], model)
