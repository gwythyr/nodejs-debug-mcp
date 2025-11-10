import json
import sys
import time
from pathlib import Path


def read_config():
    tmp_dir = Path(__file__).resolve().parents[2] / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    config_path = tmp_dir / "missing-config.json"
    if not config_path.exists():
        return None
    return json.loads(config_path.read_text())


def hydrate_config(payload):
    time.sleep(0.02)
    return {
        "env": payload.get("env", "prod"),
        "features": payload.get("features", []),
    }


if __name__ == "__main__":
    config = read_config()
    if config is None:
        sys.exit(0)
    hydrate_config(config)
    time.sleep(0.05)
