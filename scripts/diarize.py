import argparse
import contextlib
import json
import numbers
import os
import sys
import time
import wave


class ProgressEvents:
    def __init__(self, stream, output, clock=time.monotonic):
        self.stream = stream
        self.output = output
        self.clock = clock
        self.last_stage = None
        self.last_progress = {}

    def emit(self, event):
        if self.stream:
            print(json.dumps(event, ensure_ascii=False), file=self.output, flush=True)

    def stage(self, name):
        if name != self.last_stage:
            self.last_stage = name
            self.emit({"type": "stage", "name": name})

    def retry(self):
        self.last_progress.clear()
        self.stage("retrying")

    def hook(self, name, artifact, file=None, total=None, completed=None):
        if not self.stream:
            return
        if (
            name == "embeddings"
            and artifact is not None
            and total is None
            and completed is None
        ):
            self.stage("clustering")
            return
        self.stage(name)
        if not isinstance(total, numbers.Integral) or not isinstance(
            completed, numbers.Integral
        ):
            return
        total = int(total)
        if total <= 0:
            return
        completed = max(0, min(int(completed), total))
        now = self.clock()
        percent = completed * 100 // total
        previous = self.last_progress.get(name)
        if previous is not None:
            last_completed, last_total, last_percent, last_time = previous
            if (completed, total) == (last_completed, last_total):
                return
            if (
                completed not in (0, total)
                and total == last_total
                and percent == last_percent
                and now - last_time < 0.1
            ):
                return
        self.last_progress[name] = (completed, total, percent, now)
        self.emit(
            {
                "type": "progress",
                "name": name,
                "completed": completed,
                "total": total,
            }
        )


def speaker_segments(diarization):
    annotation = getattr(diarization, "speaker_diarization", diarization)
    return [
        {"start": turn.start, "end": turn.end, "speaker": speaker}
        for turn, _, speaker in annotation.itertracks(yield_label=True)
    ]


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
    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32)
    samples *= 1.0 / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    waveform = torch.from_numpy(np.ascontiguousarray(samples)).unsqueeze(0)
    return waveform, sample_rate


def error_message(error, token):
    message = str(error).strip() or type(error).__name__
    if token:
        message = message.replace(token, "[redacted]")
    return message[:2048]


def preferred_device(torch):
    try:
        if torch.cuda.is_available():
            return "cuda"
        version = tuple(int(part) for part in torch.__version__.split(".")[:2])
        if len(version) == 2 and version >= (2, 13) and torch.backends.mps.is_available():
            return "mps"
    except (AttributeError, TypeError, ValueError, RuntimeError):
        pass
    return "cpu"


def apply_pipeline(pipeline, audio, events, torch, device):
    try:
        pipeline.to(torch.device(device))
        return pipeline(audio, hook=events.hook)
    except (RuntimeError, NotImplementedError):
        if device == "cpu":
            raise
    events.retry()
    pipeline.to(torch.device("cpu"))
    return pipeline(audio, hook=events.hook)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--stream", action="store_true")
    args = parser.parse_args()
    output = sys.stdout
    events = ProgressEvents(args.stream, output)
    events.stage("initializing")

    token = os.environ.get("HF_TOKEN")
    if not token:
        message = "HF_TOKEN environment variable is required"
        events.emit({"type": "error", "message": message})
        print(message, file=sys.stderr)
        return 2

    try:
        with contextlib.redirect_stdout(sys.stderr):
            import torch
            from pyannote.audio import Pipeline
    except Exception as error:
        message = error_message(error, token)
        events.emit({"type": "error", "message": message})
        print(message, file=sys.stderr)
        return 3

    try:
        events.stage("loadingAudio")
        with contextlib.redirect_stdout(sys.stderr):
            waveform, sample_rate = load_pcm16_wav(args.audio)
    except Exception as error:
        message = error_message(error, token)
        events.emit({"type": "error", "message": message})
        print(message, file=sys.stderr)
        return 4

    try:
        events.stage("loadingModel")
        with contextlib.redirect_stdout(sys.stderr):
            pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1", token=token
            )
            if pipeline is None:
                raise RuntimeError("speaker diarization model is unavailable")
            diarization = apply_pipeline(
                pipeline,
                {"waveform": waveform, "sample_rate": sample_rate},
                events,
                torch,
                preferred_device(torch),
            )
            segments = speaker_segments(diarization)
    except Exception as error:
        message = error_message(error, token)
        events.emit({"type": "error", "message": message})
        print(message, file=sys.stderr)
        return 5
    if args.stream:
        events.emit({"type": "done", "segments": segments})
    else:
        json.dump({"segments": segments}, output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
