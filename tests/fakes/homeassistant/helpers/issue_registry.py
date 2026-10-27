"""Fake issue registry: Repairs issues recorded on hass.data for tests."""

from __future__ import annotations

from enum import Enum


class IssueSeverity(Enum):
    CRITICAL = "critical"
    ERROR = "error"
    WARNING = "warning"


def _issues(hass) -> dict:
    return hass.data.setdefault("_fake_issues", {})


def async_create_issue(hass, domain, issue_id, **kwargs) -> None:
    _issues(hass)[(domain, issue_id)] = dict(kwargs)


def async_delete_issue(hass, domain, issue_id) -> None:
    _issues(hass).pop((domain, issue_id), None)
