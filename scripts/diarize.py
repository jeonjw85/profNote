import argparse
import json
import os
import sys
import wave


def load_pcm16_wav(path: str):
    import numpy as np
    import torch

    with wave.open(path, "rb") as wav:
        channels = wav.getnchannels()
        width = wav.getsampwidth()
        sample_rate = wav.getframerate()
        frames = wav.readframes(wav.getnframes())
    if width != 2:
        raise wave.Error(f"unsupported wav sample width: {width}")
    if channels < 1:
        raise wave.Error("wav has no channels")
    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) * (1.0 / 32768.0)
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    waveform = torch.from_numpy(np.ascontiguousarray(samples)).unsqueeze(0)
    return waveform, sample_rate


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    args = parser.parse_args()

    token = os.environ.get("HF_TOKEN")
    if not token:
        print("HF_TOKEN environment variable is required", file=sys.stderr)
        return 2

    try:
        from pyannote.audio import Pipeline
    except ImportError:
        print("pyannote.audio is not installed", file=sys.stderr)
        return 3

    try:
        waveform, sample_rate = load_pcm16_wav(args.audio)
    except (OSError, wave.Error) as error:
        print(str(error), file=sys.stderr)
        return 4

    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1", token=token
    )
    diarization = pipeline({"waveform": waveform, "sample_rate": sample_rate})

    segments = [
        {"start": turn.start, "end": turn.end, "speaker": speaker}
        for turn, _, speaker in diarization.itertracks(yield_label=True)
    ]
    json.dump({"segments": segments}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
