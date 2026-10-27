from datetime import datetime, timezone


def utcnow():
    return datetime.now(timezone.utc)


def now():
    return datetime.now(timezone.utc)
