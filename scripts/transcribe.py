#!/usr/bin/env python3
"""
Transcribes an audio file using faster-whisper (local Whisper model).
Usage: python3 scripts/transcribe.py <audio_file> [model_size]
Model sizes: tiny, base, small, medium, large-v3  (default: base)
"""
import sys
from faster_whisper import WhisperModel

if len(sys.argv) < 2:
    print("Usage: transcribe.py <audio_file> [model_size]", file=sys.stderr)
    sys.exit(1)

audio_file = sys.argv[1]
model_size = sys.argv[2] if len(sys.argv) > 2 else "small"

model = WhisperModel(model_size, device="cpu", compute_type="int8")
segments, info = model.transcribe(audio_file, beam_size=5)
text = " ".join(seg.text.strip() for seg in segments).strip()
print(text)
