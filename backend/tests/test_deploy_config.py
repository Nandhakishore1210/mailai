"""Deployment glue: providers hand out URLs in forms SQLAlchemy rejects."""
from app.db.session import normalise_database_url


def test_render_postgres_scheme_is_converted():
    assert normalise_database_url("postgres://u:p@host:5432/db") == "postgresql+psycopg2://u:p@host:5432/db"


def test_bare_postgresql_scheme_is_converted():
    assert normalise_database_url("postgresql://u:p@host/db") == "postgresql+psycopg2://u:p@host/db"


def test_explicit_driver_is_left_alone():
    url = "postgresql+psycopg2://u:p@127.0.0.1:5435/mailai"
    assert normalise_database_url(url) == url
