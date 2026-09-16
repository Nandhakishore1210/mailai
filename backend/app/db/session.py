from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.config import settings


def normalise_database_url(url: str) -> str:
    """
    Hosting providers such as Render hand out `postgres://` or bare
    `postgresql://` URLs. SQLAlchemy needs the driver named explicitly, and this
    app uses psycopg2.
    """
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg2://" + url[len(prefix):]
    return url


engine = create_engine(normalise_database_url(settings.database_url), echo=False, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
