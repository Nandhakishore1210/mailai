from datetime import datetime
from sqlalchemy import Column, String, DateTime, Text, ForeignKey, BigInteger
from sqlalchemy.orm import declarative_base, relationship
import uuid

Base = declarative_base()


def _uuid():
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=_uuid)
    email = Column(String, unique=True, nullable=False)
    name = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)

    mail_accounts = relationship("MailAccount", back_populates="user")
    sessions = relationship("Session", back_populates="user")
    conversations = relationship("AssistantConversation", back_populates="user")


class MailAccount(Base):
    __tablename__ = "mail_accounts"

    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    provider = Column(String, default="gmail")  # "gmail" (OAuth) | "imap" (email + app password)
    provider_email = Column(String, nullable=False)
    # Fernet-encrypted secret: the OAuth refresh token for "gmail", the app password for "imap".
    encrypted_refresh_token = Column(Text, nullable=False)
    imap_host = Column(String)  # imap provider only
    smtp_host = Column(String)  # imap provider only
    history_id = Column(BigInteger)  # realtime cursor (Gmail historyId or IMAP status hash)

    user = relationship("User", back_populates="mail_accounts")


class Session(Base):
    __tablename__ = "sessions"

    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    expires_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="sessions")


class AssistantConversation(Base):
    __tablename__ = "assistant_conversations"

    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User", back_populates="conversations")
    messages = relationship("AssistantMessage", back_populates="conversation")


class AssistantMessage(Base):
    __tablename__ = "assistant_messages"

    id = Column(String, primary_key=True, default=_uuid)
    conversation_id = Column(String, ForeignKey("assistant_conversations.id"), nullable=False)
    role = Column(String, nullable=False)  # "user" | "assistant"
    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    conversation = relationship("AssistantConversation", back_populates="messages")
