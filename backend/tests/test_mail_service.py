"""
Unit tests for GmailMailService helpers.
These mock the Google API client and test parsing logic.
"""
import pytest
from unittest.mock import MagicMock, patch, AsyncMock
from app.mail.gmail import GmailMailService, _build_query, _parse_headers, _decode_body
from app.mail.service import MailFilters
import base64


def test_build_query_empty():
    assert _build_query(MailFilters()) == ""


def test_build_query_combined():
    q = _build_query(MailFilters(sender="alice@example.com", keyword="project", unread=True))
    assert "from:alice@example.com" in q
    assert "project" in q
    assert "is:unread" in q


def test_parse_headers():
    headers = [{"name": "Subject", "value": "Hello"}, {"name": "From", "value": "a@b.com"}]
    parsed = _parse_headers(headers)
    assert parsed["subject"] == "Hello"
    assert parsed["from"] == "a@b.com"


def test_decode_body_plain():
    content = "Hello, World!"
    encoded = base64.urlsafe_b64encode(content.encode()).decode()
    payload = {"mimeType": "text/plain", "body": {"data": encoded}}
    html, text = _decode_body(payload)
    assert text == content
    assert html == ""


def test_decode_body_html():
    content = "<b>Hello</b>"
    encoded = base64.urlsafe_b64encode(content.encode()).decode()
    payload = {"mimeType": "text/html", "body": {"data": encoded}}
    html, text = _decode_body(payload)
    assert html == content
    assert text == ""
