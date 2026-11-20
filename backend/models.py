"""
Модели данных SQLAlchemy для кинохостинга Bochflix.
Архитектура строго из 2 таблиц:
1. movies (Фильмы) с целевыми полями:
   id, pnr, title, description, duration, quality, poster_url,
   banner, mobile_poster, movie_page_url, logo_url, trailer,
   is_hero_banner, is_new_and_popular, category_ids.
2. categories (Категории) с полями:
   id, name, slug, icon_path (с fallback на дефолтную иконку).
Никаких промежуточных M2M-таблиц.
"""

from typing import Optional, List, Dict, Any
from pathlib import Path
import shutil
from sqlalchemy import Column, Integer, String, Float, Text, Boolean
from sqlalchemy.orm import declarative_base
from sqlalchemy.ext.hybrid import hybrid_property

from backend.utils.category_parser import parse_category_ids

Base = declarative_base()
BASE_DIR = Path(__file__).resolve().parent.parent


def resolve_icon_url(icon_path: Optional[str], slug: Optional[str] = "category") -> str:
    """
    Преобразует icon_path в корректный веб-URL:
    - Если icon_path пустой/None -> возвращает дефолтный fallback '../IMAGES/icons/bochflix_mini_icon.svg';
    - Если передан локальный путь файловой системы (например /Users/... или перетащенный файл) ->
      копирует его в media/icons/<slug>.<ext> и возвращает /media/icons/<slug>.<ext>;
    - Если передан путь front-end/IMAGES/... или имя файла из стандартных иконок ->
      преобразует в публичный /images/icons/<name>;
    - Если уже веб-URL (/media/..., /images/..., http://...) -> возвращает как есть.
    """
    if not icon_path or not str(icon_path).strip():
        return "../IMAGES/icons/bochflix_mini_icon.svg"

    s = str(icon_path).strip().strip("'\"")
    if not s:
        return "../IMAGES/icons/bochflix_mini_icon.svg"

    # Веб-URL, data-url или относительный путь дефолтной иконки
    if s.startswith(("http://", "https://", "data:", "../")):
        return s

    # Публичный веб-путь
    if s.startswith("/media/") or s.startswith("/images/"):
        return s

    # Путь внутри front-end/IMAGES/
    if "front-end/IMAGES/" in s or "front-end/images/" in s:
        part = s.split("front-end/IMAGES/", 1)[-1] if "front-end/IMAGES/" in s else s.split("front-end/images/", 1)[-1]
        return f"/images/{part.lstrip('/')}"

    if s.startswith("IMAGES/") or s.startswith("images/"):
        part = s.split("IMAGES/", 1)[-1] if "IMAGES/" in s else s.split("images/", 1)[-1]
        return f"/images/{part.lstrip('/')}"

    # Имя файла из стандартных иконок фронтенда
    fe_icon = BASE_DIR / "front-end" / "IMAGES" / "icons" / Path(s).name
    if fe_icon.is_file():
        return f"/images/icons/{fe_icon.name}"

    # Локальный существующий файл на диске
    p = Path(s).expanduser().resolve()
    if p.is_file():
        ext = p.suffix.lower() or ".svg"
        dest_dir = BASE_DIR / "media" / "icons"
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_name = f"{(slug or 'category')}{ext}"
        dest_file = dest_dir / dest_name
        if p != dest_file:
            try:
                shutil.copy2(p, dest_file)
            except Exception:
                pass
        return f"/media/icons/{dest_name}"

    return s if s.startswith("/") else f"/{s}"


class Category(Base):
    """
    Таблица 2: Категории (categories)
    - id: Числовой идентификатор категории
    - name: Название категории (например, 'Фильмы', 'Боевики', 'Драмы')
    - slug: Системный идентификатор (латиница)
    - icon_path: Путь к иконке (nullable). Если NULL/пусто -> отдается fallback-иконка.
    """

    __tablename__ = "categories"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    name = Column(String(100), nullable=False)
    slug = Column(String(100), unique=True, index=True, nullable=True)
    icon_path = Column(String(500), nullable=True, default=None)

    @property
    def title(self) -> str:
        """Синоним названия категории для фронтенда."""
        return self.name

    @title.setter
    def title(self, value: str) -> None:
        self.name = value

    @property
    def icon_url(self) -> str:
        """
        Путь к иконке с автоматической нормализацией и fallback:
        - Если icon_path NULL или пуст — возвращает дефолтную тестовую иконку;
        - Если указан локальный путь на диске или путь фронтенда — нормализует в доступный веб-URL.
        """
        return resolve_icon_url(self.icon_path, slug=self.slug)

    def __repr__(self) -> str:
        return f"<Category(id={self.id}, name='{self.name}', slug='{self.slug}', icon_path='{self.icon_path}')>"

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.name,
            "name": self.name,
            "slug": self.slug or "",
            "icon_path": self.icon_path,
            "icon_url": self.icon_url,
        }


class Movie(Base):
    """
    Таблица 1: Фильмы (movies)
    Целевая структура колонок по спецификации:
    - id: уникальный идентификатор (PK)
    - pnr: идентификатор/номер записи (6 символов)
    - title: название
    - description: описание
    - duration: длительность
    - quality: разрешение/качество видео
    - poster_url: ссылка на постер
    - banner: ссылка на баннер (десктоп)
    - mobile_poster: ссылка на мобильный постер
    - movie_page_url: URL страницы фильма
    - logo_url: ссылка на логотип (nullable)
    - trailer: ссылка на трейлер (nullable)
    - is_hero_banner: флаг показа в главном баннере (boolean)
    - is_new_and_popular: флаг 'новое и популярное' (boolean)
    - category_ids: привязка к категориям через ID ("1", "1,4,6")
    """

    __tablename__ = "movies"

    # Основные целевые поля
    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    pnr = Column(String(6), unique=True, index=True, nullable=False)
    title = Column(String(255), nullable=False)
    description = Column(Text, nullable=False)
    plot = Column(Text, nullable=True, default=None)
    duration = Column(String(50), nullable=False)
    quality = Column(String(50), nullable=False)
    poster_url = Column(String(500), nullable=False)

    banner = Column(String(500), nullable=False)
    mobile_poster = Column(String(500), nullable=False)
    movie_page_url = Column(String(500), nullable=False)
    logo_url = Column(String(500), nullable=True, default=None)
    trailer = Column(String(500), nullable=True, default=None)

    is_hero_banner = Column(Boolean, nullable=False, default=False)
    category_tag = Column(String(50), nullable=False, default="none")
    category_ids = Column(String(255), nullable=True, default="")

    # Поля для полной обратной совместимости с существующим кодом и фронтендом
    banner_desktop_url = Column(String(500), nullable=True)
    banner_mobile_url = Column(String(500), nullable=True)
    trailer_url = Column(String(500), nullable=True)
    rating = Column(Float, nullable=True, default=None)

    # Гибридные свойства для обратной совместимости с кодом, использующим флаги популярности
    @hybrid_property
    def is_new_and_popular(self) -> bool:
        return self.category_tag in ("new_popular", "popular")

    @is_new_and_popular.setter
    def is_new_and_popular(self, value: bool):
        if value:
            self.category_tag = "new_popular"
        elif self.category_tag in ("new_popular", "popular"):
            self.category_tag = "none"

    @is_new_and_popular.expression
    def is_new_and_popular(cls):
        return cls.category_tag.in_(["new_popular", "popular"])

    @hybrid_property
    def is_popular(self) -> bool:
        return self.category_tag in ("new_popular", "popular")

    @is_popular.setter
    def is_popular(self, value: bool):
        if value:
            if self.category_tag == "new":
                self.category_tag = "new_popular"
            else:
                self.category_tag = "popular"
        else:
            if self.category_tag == "new_popular":
                self.category_tag = "new"
            elif self.category_tag == "popular":
                self.category_tag = "none"

    @is_popular.expression
    def is_popular(cls):
        return cls.category_tag.in_(["new_popular", "popular"])

    @hybrid_property
    def is_new_popular(self) -> bool:
        return self.category_tag in ("new_popular", "popular")

    @is_new_popular.setter
    def is_new_popular(self, value: bool):
        self.is_new_and_popular = value

    @is_new_popular.expression
    def is_new_popular(cls):
        return cls.category_tag.in_(["new_popular", "popular"])

    @hybrid_property
    def is_new(self) -> bool:
        return self.category_tag in ("new_popular", "new")

    @is_new.setter
    def is_new(self, value: bool):
        if value:
            if self.category_tag == "popular":
                self.category_tag = "new_popular"
            else:
                self.category_tag = "new"
        else:
            if self.category_tag == "new_popular":
                self.category_tag = "popular"
            elif self.category_tag == "new":
                self.category_tag = "none"

    @is_new.expression
    def is_new(cls):
        return cls.category_tag.in_(["new_popular", "new"])

    def __init__(self, **kwargs):
        # Синхронизация синонимов названий полей
        if "banner_desktop_url" in kwargs and "banner" not in kwargs:
            kwargs["banner"] = kwargs["banner_desktop_url"]
        elif "banner" in kwargs and "banner_desktop_url" not in kwargs:
            kwargs["banner_desktop_url"] = kwargs["banner"]

        if "banner_mobile_url" in kwargs and "mobile_poster" not in kwargs:
            kwargs["mobile_poster"] = kwargs["banner_mobile_url"]
        elif "mobile_poster" in kwargs and "banner_mobile_url" not in kwargs:
            kwargs["banner_mobile_url"] = kwargs["mobile_poster"]

        if "trailer_url" in kwargs and "trailer" not in kwargs:
            kwargs["trailer"] = kwargs["trailer_url"]
        elif "trailer" in kwargs and "trailer_url" not in kwargs:
            kwargs["trailer_url"] = kwargs["trailer"]

        # Если передана единая колонка category_tag
        category_tag = kwargs.get("category_tag")
        if not category_tag:
            is_pop = (
                kwargs.get("is_new_and_popular")
                or kwargs.get("is_new_popular")
                or kwargs.get("is_popular")
                or False
            )
            is_new = kwargs.get("is_new") or False
            if is_pop and is_new:
                category_tag = "new_popular"
            elif is_pop:
                category_tag = "popular"
            elif is_new:
                category_tag = "new"
            else:
                category_tag = "none"
        kwargs["category_tag"] = category_tag

        # Очищаем устаревшие имена полей из kwargs перед вызовом ORM конструктора
        kwargs.pop("is_new_and_popular", None)
        kwargs.pop("is_new_popular", None)
        kwargs.pop("is_popular", None)
        kwargs.pop("is_new", None)

        super().__init__(**kwargs)

    @property
    def parsed_category_ids(self) -> List[int]:
        """
        Отказоустойчивый парсинг category_ids.
        При обнаружении некорректных данных логирует ошибку и пропускает некорректные ID.
        """
        return parse_category_ids(self.category_ids, movie_info=f"id={self.id} pnr='{self.pnr}'")

    @property
    def category_id(self) -> Optional[int]:
        """Первичный ID категории для обратной совместимости."""
        cids = self.parsed_category_ids
        return cids[0] if cids else None

    def __repr__(self) -> str:
        return f"<Movie(pnr='{self.pnr}', title='{self.title}', category_ids='{self.category_ids}', category_tag='{self.category_tag}')>"

    def to_dict(self, categories_lookup: Optional[Dict[int, Category]] = None) -> dict:
        """
        Сериализация модели в словарь со всеми полями — как новыми целевыми, так и синонимами.
        """
        cids = self.parsed_category_ids
        primary_id = cids[0] if cids else None

        cat_names: List[str] = []
        cat_objs: List[dict] = []
        first_cat_name = None
        first_cat_slug = None

        if categories_lookup:
            for cid in cids:
                if cid in categories_lookup:
                    c = categories_lookup[cid]
                    cat_names.append(c.name)
                    cat_objs.append(c.to_dict())
            if primary_id and primary_id in categories_lookup:
                first_cat_name = categories_lookup[primary_id].name
                first_cat_slug = categories_lookup[primary_id].slug

        effective_banner = self.banner or self.banner_desktop_url or ""
        effective_mobile = self.mobile_poster or self.banner_mobile_url or ""
        effective_trailer = self.trailer or self.trailer_url
        effective_popular = bool(self.is_new_and_popular or self.is_new_popular or self.is_popular)

        return {
            "id": self.id,
            "pnr": self.pnr,
            "title": self.title,
            "description": self.description,
            "plot": self.plot,
            "duration": self.duration,
            "quality": self.quality,
            "poster_url": self.poster_url,
            # Целевые поля спецификации
            "banner": effective_banner,
            "mobile_poster": effective_mobile,
            "movie_page_url": self.movie_page_url,
            "logo_url": self.logo_url,
            "trailer": effective_trailer,
            "is_hero_banner": bool(self.is_hero_banner),
            "category_tag": self.category_tag,
            "is_new_and_popular": effective_popular,
            "category_ids": cids,
            # Поля совместимости со старым кодом и фронтендом
            "banner_desktop_url": effective_banner,
            "banner_mobile_url": effective_mobile,
            "trailer_url": effective_trailer,
            "is_new_popular": effective_popular,
            "is_popular": effective_popular,
            "is_new": bool(self.is_new),
            "rating": self.rating,
            "category_id": primary_id,
            "category_name": first_cat_name,
            "category_slug": first_cat_slug,
            "category_names": cat_names,
            "categories": cat_objs,
            "categories_str": ",".join(str(cid) for cid in cids),
        }
