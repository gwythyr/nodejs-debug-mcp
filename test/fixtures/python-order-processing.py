import json
import time
from pathlib import Path

ORDERS = [
    {"id": "A100", "total": 120, "items": 3},
    {"id": "B200", "total": 80, "items": 2},
    {"id": "C300", "total": 42, "items": 1},
]


def persist_summary(records):
    tmp_dir = Path(__file__).resolve().parents[2] / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    target = tmp_dir / "orders-summary.json"
    target.write_text(json.dumps(records, indent=2))
    time.sleep(0.01)
    return target


def process_orders():
    records = []
    for order in ORDERS:
        time.sleep(0.02)
        gross = order["total"] * 1.05
        record = {
            "id": order["id"],
            "status": "processed",
            "gross": round(gross, 2),
            "items": order["items"],
        }
        records.append(record)
    return records


if __name__ == "__main__":
    summary = process_orders()
    summary_path = persist_summary(summary)
    if summary_path.exists():
        summary_path.unlink()
    time.sleep(0.05)
