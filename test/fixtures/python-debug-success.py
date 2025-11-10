import time


def compute():
    payload = {"answer": 42}
    time.sleep(0.05)
    return payload


if __name__ == "__main__":
    compute()
    time.sleep(0.05)
