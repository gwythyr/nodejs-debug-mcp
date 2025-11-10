import statistics
import time


def fetch_customer(customer_id):
    time.sleep(0.01)
    return {"id": customer_id, "balances": [180, 220, 160, 140]}


def calculate_variance(customer):
    balances = customer["balances"]
    baseline = statistics.mean(balances)
    drift = [round((value - baseline) / baseline, 4) for value in balances]
    time.sleep(0.02)
    profile = {
        "customer": customer["id"],
        "baseline": baseline,
        "drift_above": len([value for value in drift if value > 0]),
    }
    return profile


def assemble_report(customer_id):
    customer = fetch_customer(customer_id)
    return calculate_variance(customer)


if __name__ == "__main__":
    assemble_report("acct-4488")
    time.sleep(0.05)
