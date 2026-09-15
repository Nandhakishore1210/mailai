"""
Tests for the AI action extraction and dispatch logic.
"""
import pytest
from app.assistant.agent import _extract_actions


def test_extract_empty():
    assert _extract_actions("Here is my reply with no actions.") == []


def test_extract_single_action():
    text = 'Sure!\n```json\n[{"type": "NAVIGATE", "view": "inbox"}]\n```'
    actions = _extract_actions(text)
    assert len(actions) == 1
    assert actions[0]["type"] == "NAVIGATE"


def test_extract_multiple_actions():
    text = '```json\n[{"type": "SET_COMPOSE", "subject": "Hi"}, {"type": "ASK_CONFIRMATION", "operation": "SEND_EMAIL"}]\n```'
    actions = _extract_actions(text)
    assert len(actions) == 2
    assert actions[1]["operation"] == "SEND_EMAIL"


def test_extract_malformed_json():
    text = '```json\n[not valid json]\n```'
    assert _extract_actions(text) == []
