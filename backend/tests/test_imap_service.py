"""
Unit tests for the IMAP/SMTP provider's pure helpers (no network).
"""
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
import email

from app.mail.imap import (
    detect_hosts, decode_header_value, extract_bodies, make_snippet, parse_fetch_meta,
    split_id, address_list, build_imap_criteria, parse_list_line, html_to_text,
)
from app.mail.service import MailFilters


def test_detect_hosts_known_and_unknown():
    assert detect_hosts("a@gmail.com") == ("imap.gmail.com", "smtp.gmail.com")
    assert detect_hosts("A@Outlook.com") == ("outlook.office365.com", "smtp.office365.com")
    assert detect_hosts("x@example.org") == ("imap.example.org", "smtp.example.org")


def test_decode_header_value_rfc2047():
    assert decode_header_value("=?utf-8?q?Caf=C3=A9_update?=") == "Café update"
    assert decode_header_value(None) == ""


def test_extract_bodies_multipart_skips_attachments():
    msg = MIMEMultipart("mixed")
    alt = MIMEMultipart("alternative")
    alt.attach(MIMEText("plain hello", "plain"))
    alt.attach(MIMEText("<p>html hello</p>", "html"))
    msg.attach(alt)
    att = MIMEBase("application", "pdf")
    att.set_payload(b"%PDF")
    att.add_header("Content-Disposition", "attachment", filename="x.pdf")
    msg.attach(att)

    html, text = extract_bodies(email.message_from_bytes(msg.as_bytes()))
    assert text == "plain hello"
    assert "html hello" in html


def test_make_snippet_prefers_text_and_strips_html():
    assert make_snippet("  a   b\n c ", "<b>ignored</b>") == "a b c"
    assert make_snippet("", "<p>Hello&nbsp;<i>world</i></p>") == "Hello world"
    assert html_to_text("<style>x{}</style><a>link</a>") .strip() == "link"


def test_parse_fetch_meta():
    meta = b'12 (UID 4521 FLAGS (\\Seen \\Answered) X-GM-THRID 1800000000000000001 BODY[]<0> {6000}'
    parsed = parse_fetch_meta(meta)
    assert parsed == {"uid": 4521, "seen": True, "thrid": "1800000000000000001"}
    assert parse_fetch_meta(b"1 (UID 7 FLAGS () BODY[] {10}")["seen"] is False


def test_split_id():
    assert split_id("INBOX:42") == ("INBOX", 42)
    assert split_id("SENT:7") == ("SENT", 7)
    try:
        split_id("nope")
        assert False, "should raise"
    except ValueError:
        pass


def test_address_list():
    assert address_list(['"Sarah Lee" <sarah@example.com>, bob@example.com']) == [
        "Sarah Lee <sarah@example.com>",
        "bob@example.com",
    ]
    assert address_list(None) == []


def test_build_imap_criteria():
    today = datetime(2026, 9, 15)
    crit = build_imap_criteria(
        MailFilters(unread=True, sender="sarah", keyword="project", newer_than_days=7, to_date="2026-09-15"),
        today=today,
    )
    assert crit == [
        "UNSEEN", "FROM", '"sarah"', "TEXT", '"project"',
        "SINCE", "08-Sep-2026", "BEFORE", "16-Sep-2026",
    ]
    assert build_imap_criteria(MailFilters()) == ["ALL"]


def test_parse_list_line():
    assert parse_list_line(b'(\\HasNoChildren \\Sent) "/" "Sent Items"') == (["\\HasNoChildren", "\\Sent"], "Sent Items")
    assert parse_list_line(b'(\\HasNoChildren) "/" INBOX') == (["\\HasNoChildren"], "INBOX")
