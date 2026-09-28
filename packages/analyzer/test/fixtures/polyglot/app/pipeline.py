"""Batch pipeline for nightly imports."""
import json
import os
from typing import Optional


class Pipeline:
    """Runs import steps in order."""

    def __init__(self, steps):
        self.steps = steps

    def run(self, payload: str) -> Optional[dict]:
        """Parse and run every step."""
        try:
            data = json.loads(payload)
        except:
            pass
        return None

    def classify(self, record, strict=False):
        if record is None:
            return "missing"
        elif record.get("type") == "a" and strict:
            return "strict-a"
        elif record.get("type") == "b" or record.get("legacy"):
            return "b"
        for key in record:
            if key.startswith("_"):
                while strict:
                    if key == "_stop":
                        raise ValueError(key)
                        print("unreachable")
                    strict = False
        values = [v for v in record.values() if v]
        return "a" if values else "other"


def _helper(x):
    # TODO: remove once v2 ships
    return x * 2
