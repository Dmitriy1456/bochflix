"""
Управление подключением к базе данных SQLite через SQLAlchemy.
Архитектура строго из 2 таблиц: movies и categories.
"""

import sys
import logging
from pathlib import Path
from typing import Generator
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker, Session

BASE_DIR_PATH = Path(__file__).resolve().parent.parent
if str(BASE_DIR_PATH) not in sys.path:
    sys.path.insert(0, str(BASE_DIR_PATH))

try:
    from .config import settings
    from .models import Base, Category, Movie
    from .utils.category_parser import parse_category_ids
    from .utils.video_meta import normalize_duration_str, normalize_quality_str
except ImportError:
    from backend.config import settings
    from backend.models import Base, Category, Movie
    from backend.utils.category_parser import parse_category_ids
    from backend.utils.video_meta import normalize_duration_str, normalize_quality_str

logger = logging.getLogger("bochflix.database")

# Настройка движка SQLite
engine = create_engine(
    settings.DATABASE_URL,
    connect_args={"check_same_thread": False} if settings.DATABASE_URL.startswith("sqlite") else {},
    echo=False,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Базовые категории каталога (без 'Новое и популярное', т.к. это отдельный флаг is_new_and_popular)
DEFAULT_CATEGORIES = [
    {"id": 0, "name": "Bochflix", "slug": "error_category", "icon_path": None},
]


def run_migrations() -> None:
    """
    Миграция схемы SQLite строго под 2 таблицы:
    1. Удаляет промежуточную таблицу movie_categories, если она была создана ранее.
    2. Создает/обновляет таблицы movies и categories.
    3. Добавляет целевые колонки в movies: banner, mobile_poster, trailer, is_new_and_popular, category_ids.
    4. Синхронизирует данные между старыми и новыми колонками.
    5. Нормализует категории без дубликатов.
    """
    with engine.connect() as conn:
        # 1. СТРОГО 2 таблицы: удаляем промежуточную M2M таблицу
        conn.execute(text("DROP TABLE IF EXISTS movie_categories"))
        conn.commit()

    # 2. Создаем таблицы models (movies, categories), если их еще нет
    Base.metadata.create_all(bind=engine)

    inspector = inspect(engine)
    existing_tables = inspector.get_table_names()

    with engine.connect() as conn:
        # 3. Обновляем таблицу categories
        if "categories" in existing_tables:
            cat_cols = [col["name"] for col in inspector.get_columns("categories")]
            if "icon_path" not in cat_cols:
                conn.execute(text("ALTER TABLE categories ADD COLUMN icon_path VARCHAR(500)"))
                conn.commit()
            if "icon_url" in cat_cols:
                conn.execute(text("UPDATE categories SET icon_path = icon_url WHERE icon_path IS NULL AND icon_url IS NOT NULL"))
                conn.commit()

            # Удаляем системную псевдо-категорию "Новое и популярное" (она хранится флагом в movies)
            conn.execute(text("DELETE FROM categories WHERE LOWER(name) LIKE '%новое%' OR slug LIKE '%popular%'"))
            conn.commit()

        # 4. Обновляем таблицу movies
        if "movies" in existing_tables:
            mov_cols = [col["name"] for col in inspector.get_columns("movies")]

            # Целевые колонки
            if "plot" not in mov_cols:
                conn.execute(text("ALTER TABLE movies ADD COLUMN plot TEXT DEFAULT NULL"))
                conn.commit()
            if "category_tag" not in mov_cols:
                conn.execute(text("ALTER TABLE movies ADD COLUMN category_tag VARCHAR(50) NOT NULL DEFAULT 'none'"))
                conn.commit()
            if "banner" not in mov_cols:
                conn.execute(text("ALTER TABLE movies ADD COLUMN banner VARCHAR(500)"))
                conn.commit()
            if "mobile_poster" not in mov_cols:
                conn.execute(text("ALTER TABLE movies ADD COLUMN mobile_poster VARCHAR(500)"))
                conn.commit()
            if "trailer" not in mov_cols:
                conn.execute(text("ALTER TABLE movies ADD COLUMN trailer VARCHAR(500)"))
                conn.commit()
            if "category_ids" not in mov_cols:
                conn.execute(text("ALTER TABLE movies ADD COLUMN category_ids VARCHAR(255)"))
                conn.commit()

            # Совместимые колонки
            if "banner_desktop_url" not in mov_cols:
                conn.execute(text("ALTER TABLE movies ADD COLUMN banner_desktop_url VARCHAR(500)"))
                conn.commit()
            if "banner_mobile_url" not in mov_cols:
                conn.execute(text("ALTER TABLE movies ADD COLUMN banner_mobile_url VARCHAR(500)"))
                conn.commit()
            if "trailer_url" not in mov_cols:
                conn.execute(text("ALTER TABLE movies ADD COLUMN trailer_url VARCHAR(500)"))
                conn.commit()
            if "is_hero_banner" not in mov_cols:
                conn.execute(text("ALTER TABLE movies ADD COLUMN is_hero_banner BOOLEAN NOT NULL DEFAULT 0"))
                conn.commit()

            # Миграция данных из старых колонок популярности в единую колонку category_tag
            has_pop = any(col in mov_cols for col in ("is_new_and_popular", "is_new_popular", "is_popular"))
            has_new = "is_new" in mov_cols
            if has_pop or has_new:
                pop_cond = " OR ".join([f"{col} = 1" for col in ("is_new_and_popular", "is_new_popular", "is_popular") if col in mov_cols]) or "0"
                new_cond = "is_new = 1" if has_new else "0"
                conn.execute(text(f"""
                    UPDATE movies SET category_tag = CASE
                        WHEN ({pop_cond}) AND ({new_cond}) THEN 'new_popular'
                        WHEN ({pop_cond}) THEN 'new_popular'
                        WHEN ({new_cond}) THEN 'new'
                        ELSE 'none'
                    END
                    WHERE category_tag IS NULL OR category_tag = '' OR category_tag = 'none'
                """))
                conn.commit()

            # Безопасное удаление устаревших колонок
            for old_col in ("is_new_and_popular", "is_new_popular", "is_popular", "is_new"):
                if old_col in mov_cols:
                    try:
                        conn.execute(text(f"ALTER TABLE movies DROP COLUMN {old_col}"))
                        conn.commit()
                    except Exception:
                        pass

            # Синхронизация данных в обе стороны
            conn.execute(text("""
                UPDATE movies SET 
                    banner = COALESCE(banner, banner_desktop_url),
                    banner_desktop_url = COALESCE(banner_desktop_url, banner),
                    mobile_poster = COALESCE(mobile_poster, banner_mobile_url),
                    banner_mobile_url = COALESCE(banner_mobile_url, mobile_poster),
                    trailer = COALESCE(trailer, trailer_url),
                    trailer_url = COALESCE(trailer_url, trailer)
            """))
            conn.commit()


def seed_default_data() -> None:
    """
    Наполняет БД базовыми категориями (ID 1-7).
    """
    db = SessionLocal()
    try:
        for cat_data in DEFAULT_CATEGORIES:
            exists = db.query(Category).filter(Category.id == cat_data["id"]).first()
            if not exists:
                new_cat = Category(
                    id=cat_data["id"],
                    name=cat_data["name"],
                    slug=cat_data["slug"],
                    icon_path=cat_data["icon_path"],
                )
                db.add(new_cat)
            else:
                exists.name = cat_data["name"]
                exists.slug = cat_data["slug"]
                if cat_data["icon_path"] and not exists.icon_path:
                    exists.icon_path = cat_data["icon_path"]
        db.commit()
    finally:
        db.close()


def init_db() -> None:
    """Полная инициализация БД."""
    run_migrations()
    seed_default_data()


def get_db() -> Generator[Session, None, None]:
    """FastAPI Dependency для получения сессии базы данных."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
