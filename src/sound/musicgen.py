# MusicGen (Meta, open weights) on CPU: python musicgen.py <model> "<prompt>" <seconds> <out.wav>
# Needs torch, transformers and scipy; the sound step runs it through DIORAMA_PYTHON.
import sys

import scipy.io.wavfile
import torch
from transformers import AutoProcessor, MusicgenForConditionalGeneration

model_id, prompt, seconds, out = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
torch.manual_seed(7)
processor = AutoProcessor.from_pretrained(model_id)
model = MusicgenForConditionalGeneration.from_pretrained(model_id)
inputs = processor(text=[prompt], padding=True, return_tensors="pt")
# MusicGen makes about 50 tokens per second of audio.
tokens = int(seconds * model.config.audio_encoder.frame_rate)
with torch.no_grad():
    audio = model.generate(**inputs, do_sample=True, guidance_scale=3.0, max_new_tokens=tokens)
rate = model.config.audio_encoder.sampling_rate
scipy.io.wavfile.write(out, rate=rate, data=audio[0, 0].numpy())
print(f"musicgen: {audio.shape[-1] / rate:.1f} s at {rate} Hz -> {out}", file=sys.stderr)
