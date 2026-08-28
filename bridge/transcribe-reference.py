import argparse
import json
import sys

import soundfile as sf
import torch
import torch.nn.functional as F
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor


def load_audio(filename: str):
    audio, sample_rate = sf.read(filename, always_2d=True, dtype="float32")
    waveform = torch.from_numpy(audio).mean(dim=1)
    if sample_rate != 16000:
        target_length = max(1, round(waveform.numel() * 16000 / sample_rate))
        waveform = F.interpolate(
            waveform.view(1, 1, -1), size=target_length, mode="linear", align_corners=False
        ).view(-1)
    return waveform.numpy()


def main():
    parser = argparse.ArgumentParser(description="H3 Studio isolated multilingual reference transcription")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--model", default="openai/whisper-small")
    args = parser.parse_args()

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device.startswith("cuda") else torch.float32
    processor = AutoProcessor.from_pretrained(args.model, cache_dir=args.cache_dir)
    model = AutoModelForSpeechSeq2Seq.from_pretrained(
        args.model, cache_dir=args.cache_dir, dtype=dtype, low_cpu_mem_usage=True
    ).to(device)
    waveform = load_audio(args.audio)
    inputs = processor(waveform, sampling_rate=16000, return_tensors="pt", return_attention_mask=True)
    input_features = inputs.input_features.to(device=device, dtype=dtype)
    attention_mask = getattr(inputs, "attention_mask", None)
    generate_args = {"task": "transcribe"}
    if attention_mask is not None:
        generate_args["attention_mask"] = attention_mask.to(device)
    with torch.inference_mode():
        generated = model.generate(input_features, **generate_args)
    transcript = processor.batch_decode(generated, skip_special_tokens=True)[0].strip()
    print("H3_TRANSCRIPT_JSON=" + json.dumps({"text": transcript, "model": args.model}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"H3_TRANSCRIPT_ERROR={error}", file=sys.stderr, flush=True)
        raise
