import contextlib
import importlib.util
import io
import json
import os
import struct
import sys
import tempfile
import types
import unittest
import wave
from unittest.mock import patch

import diarize


class FakeAnnotation:
    def itertracks(self, yield_label=False):
        yield types.SimpleNamespace(start=0.25, end=1.5), None, "SPEAKER_00"


class FakePipeline:
    def __init__(self, failing_device=None):
        self.device = None
        self.failing_device = failing_device
        self.devices = []
        self.audios = []

    def to(self, device):
        self.device = device
        self.devices.append(device)

    def __call__(self, audio, hook):
        self.audios.append(audio)
        print("inference library output")
        hook("segmentation", None, total=3, completed=0)
        if self.device == self.failing_device:
            raise RuntimeError("backend operation is unavailable")
        hook("segmentation", None, total=3, completed=3)
        hook("speaker_counting", None)
        return FakeAnnotation()


class DiarizationTests(unittest.TestCase):
    @unittest.skipUnless(
        importlib.util.find_spec("numpy") and importlib.util.find_spec("torch"),
        "audio runtime dependencies are unavailable",
    )
    def test_pcm16_normalization_preserves_extreme_sample_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "fixture.wav")
            with wave.open(path, "wb") as fixture:
                fixture.setnchannels(1)
                fixture.setsampwidth(2)
                fixture.setframerate(16000)
                fixture.writeframes(struct.pack("<4h", -32768, -1, 0, 32767))
            waveform, sample_rate = diarize.load_pcm16_wav(path)
        self.assertEqual(sample_rate, 16000)
        self.assertEqual(
            waveform.tolist(),
            [[-1.0, -1.0 / 32768.0, 0.0, 32767.0 / 32768.0]],
        )

    def test_hook_reports_actual_counts_and_clamps_batch_overshoot(self):
        output = io.StringIO()
        events = diarize.ProgressEvents(True, output)
        events.hook("segmentation", None, total=57, completed=0)
        events.hook("segmentation", None, total=57, completed=32)
        events.hook("segmentation", None, total=57, completed=64)
        events.hook("segmentation", None)
        events.hook("speaker_counting", None)
        payloads = [json.loads(line) for line in output.getvalue().splitlines()]
        progress = [event for event in payloads if event["type"] == "progress"]
        self.assertEqual([event["completed"] for event in progress], [0, 32, 57])
        self.assertEqual([event["total"] for event in progress], [57, 57, 57])
        self.assertEqual(
            [event["name"] for event in payloads if event["type"] == "stage"],
            ["segmentation", "speaker_counting"],
        )

    def test_progress_throttles_same_percent_and_emits_boundaries_immediately(self):
        output = io.StringIO()
        times = iter([0.0, 0.01, 0.02, 0.12, 0.13, 0.14])
        events = diarize.ProgressEvents(True, output, clock=lambda: next(times))
        for completed in [0, 1, 2, 3, 10, 1000]:
            events.hook("embeddings", None, total=1000, completed=completed)
        payloads = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(
            [event["completed"] for event in payloads if event["type"] == "progress"],
            [0, 3, 10, 1000],
        )

    def test_embedding_completion_marks_clustering_without_invented_progress(self):
        output = io.StringIO()
        events = diarize.ProgressEvents(True, output)
        events.hook("embeddings", None, total=6, completed=6)
        events.hook("embeddings", object())
        payloads = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(payloads[-1], {"type": "stage", "name": "clustering"})
        self.assertEqual(len([event for event in payloads if event["type"] == "progress"]), 1)

    def test_unsupported_accelerator_retries_the_same_audio_on_cpu(self):
        pipeline = FakePipeline(failing_device="mps")
        output = io.StringIO()
        events = diarize.ProgressEvents(True, output)
        audio = {"waveform": object(), "sample_rate": 16000}
        torch = types.SimpleNamespace(device=lambda device: device)
        with contextlib.redirect_stdout(io.StringIO()):
            result = diarize.apply_pipeline(pipeline, audio, events, torch, "mps")
        self.assertIsInstance(result, FakeAnnotation)
        self.assertEqual(pipeline.devices, ["mps", "cpu"])
        self.assertEqual(pipeline.audios, [audio, audio])
        payloads = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(
            len(
                [
                    event
                    for event in payloads
                    if event["type"] == "progress" and event["completed"] == 0
                ]
            ),
            2,
        )
        self.assertIn({"type": "stage", "name": "retrying"}, payloads)

    def test_accelerator_selection_preserves_cuda_priority_and_validated_mps_versions(self):
        def runtime(version="2.13.0", cuda=False, mps=False):
            return types.SimpleNamespace(
                __version__=version,
                cuda=types.SimpleNamespace(is_available=lambda: cuda),
                backends=types.SimpleNamespace(
                    mps=types.SimpleNamespace(is_available=lambda: mps)
                ),
            )

        cases = [
            (runtime(cuda=True, mps=True), "cuda"),
            (runtime(version="2.11.0", cuda=True), "cuda"),
            (runtime(mps=True), "mps"),
            (runtime(version="2.13.0.dev20261001", mps=True), "mps"),
            (runtime(version="2.12.0", mps=True), "cpu"),
            (runtime(version="invalid", mps=True), "cpu"),
            (runtime(), "cpu"),
            (types.SimpleNamespace(), "cpu"),
        ]
        for torch, expected in cases:
            with self.subTest(expected=expected, runtime=torch):
                self.assertEqual(diarize.preferred_device(torch), expected)

    def test_cpu_failure_is_propagated(self):
        pipeline = FakePipeline(failing_device="cpu")
        torch = types.SimpleNamespace(device=lambda device: device)
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(RuntimeError):
                diarize.apply_pipeline(
                    pipeline, {}, diarize.ProgressEvents(False, io.StringIO()), torch, "cpu"
                )
        self.assertEqual(pipeline.devices, ["cpu"])

    def test_error_message_redacts_the_configured_token(self):
        self.assertEqual(
            diarize.error_message(RuntimeError("failed hf_test_only request"), "hf_test_only"),
            "failed [redacted] request",
        )

    def run_main(self, streaming):
        pipeline = FakePipeline()
        torch = types.ModuleType("torch")
        torch.device = lambda device: device
        audio = types.ModuleType("pyannote.audio")

        def from_pretrained(*args, **kwargs):
            print("model library output")
            return pipeline

        audio.Pipeline = types.SimpleNamespace(from_pretrained=from_pretrained)
        arguments = ["diarize.py", "--audio", "public-fixture.wav"]
        if streaming:
            arguments.append("--stream")
        output = io.StringIO()
        errors = io.StringIO()
        with (
            patch.dict(os.environ, {"HF_TOKEN": "hf_test_only"}, clear=True),
            patch.dict(
                sys.modules,
                {"torch": torch, "pyannote.audio": audio},
            ),
            patch.object(sys, "argv", arguments),
            patch.object(diarize, "load_pcm16_wav", return_value=(object(), 16000)),
            contextlib.redirect_stdout(output),
            contextlib.redirect_stderr(errors),
        ):
            code = diarize.main()
        self.assertEqual(code, 0)
        self.assertIn("model library output", errors.getvalue())
        self.assertIn("inference library output", errors.getvalue())
        return output.getvalue()

    def test_stream_mode_emits_only_json_lines_and_a_final_result(self):
        output = self.run_main(True)
        payloads = [json.loads(line) for line in output.splitlines()]
        self.assertEqual(payloads[0], {"type": "stage", "name": "initializing"})
        self.assertEqual(
            payloads[-1],
            {
                "type": "done",
                "segments": [{"start": 0.25, "end": 1.5, "speaker": "SPEAKER_00"}],
            },
        )

    def test_default_mode_preserves_the_existing_single_json_response(self):
        self.assertEqual(
            json.loads(self.run_main(False)),
            {"segments": [{"start": 0.25, "end": 1.5, "speaker": "SPEAKER_00"}]},
        )


if __name__ == "__main__":
    unittest.main()
