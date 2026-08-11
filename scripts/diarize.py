import argparse
import json
import os
import sys


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

    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1", token=token
    )
    diarization = pipeline(args.audio)

    segments = [
        {"start": turn.start, "end": turn.end, "speaker": speaker}
        for turn, _, speaker in diarization.itertracks(yield_label=True)
    ]
    json.dump({"segments": segments}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
