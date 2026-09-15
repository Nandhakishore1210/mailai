from sqlalchemy import text
from app.db.models import Base
from app.db.session import engine

# Columns added after the first release. create_all() never alters existing
# tables, so apply small additive migrations here (idempotent).
_ADDITIVE_COLUMNS = [
    ("mail_accounts", "imap_host", "VARCHAR"),
    ("mail_accounts", "smtp_host", "VARCHAR"),
]


def init_db():
    Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        for table, column, ddl_type in _ADDITIVE_COLUMNS:
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {ddl_type}"))
