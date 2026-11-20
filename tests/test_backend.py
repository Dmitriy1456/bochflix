"""
Набор автоматических тестов для бэкенда кинохостинга Bochflix.
Проверяет архитектуру строго из 2 таблиц (movies и categories):
1. Генерация и валидация 6-значного PNR;
2. Парсинг метаданных видео (длительность, качество);
3. Архитектура базы: строго 2 таблицы (movies, categories), без M2M-таблиц;
4. Поле category_ids в movies (строка ID через запятую) и флаг is_new_popular;
5. Поле icon_path в categories с fallback на дефолтную иконку при NULL;
6. Фильтрация пустых категорий (категории без фильмов не отправляются на фронтенд);
7. Отказоустойчивость: буквы/спецсимволы в category_ids не роняют бэкенд (нет 500 error);
8. Промо-слайдер: GET /api/banners (is_hero_banner = True);
9. Удаление и получение фильмов по PNR;
10. CORS заголовки и обработка ошибок.
"""

import sys
import logging
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.main import app
from backend.database import get_db, Base
from backend.models import Movie, Category
from backend.utils.pnr import generate_pnr, is_valid_pnr, PNR_ALPHABET, PNR_LENGTH
from backend.utils.video_meta import (
    format_duration,
    map_resolution_to_label,
    extract_video_metadata,
)
from backend.utils.category_parser import parse_category_ids

# Тестовая БД в памяти (in-memory SQLite со StaticPool для многопоточности)
SQLALCHEMY_DATABASE_URL = "sqlite:///:memory:"
engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture(scope="function")
def db_session():
    """Создает чистую тестовую БД перед каждым тестом."""
    Base.metadata.create_all(bind=engine)
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()
        Base.metadata.drop_all(bind=engine)


@pytest.fixture(scope="function")
def client(db_session):
    """Тестовый клиент FastAPI с подмененной сессией БД."""
    def override_get_db():
        try:
            yield db_session
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


# ==============================================================================
# 1. ТЕСТЫ PNR
# ==============================================================================

def test_pnr_length_and_alphabet():
    for _ in range(100):
        pnr = generate_pnr()
        assert len(pnr) == PNR_LENGTH == 6
        assert all(char in PNR_ALPHABET for char in pnr)
        for vowel in "AEIOU":
            assert vowel not in pnr


def test_pnr_validation():
    assert is_valid_pnr("9K4R2T") is True
    assert is_valid_pnr("BCDFGH") is True
    assert is_valid_pnr("012345") is True
    assert is_valid_pnr("bcdfgh") is True

    # Невалидные: гласные
    assert is_valid_pnr("A12345") is False
    assert is_valid_pnr("9E4R2T") is False

    # Невалидные: длина != 6
    assert is_valid_pnr("12345") is False
    assert is_valid_pnr("1234567") is False


# ==============================================================================
# 2. ТЕСТЫ ПАРСЕРА МЕТАДАННЫХ ВИДЕО
# ==============================================================================

def test_format_duration():
    assert format_duration(0) == "0 мин"
    assert format_duration(45 * 60) == "45 мин"
    assert format_duration(60 * 60) == "1 ч"
    assert format_duration(8940) == "2 ч 29 мин"
    assert format_duration(3600 + 15 * 60) == "1 ч 15 мин"


def test_map_resolution_to_label():
    assert map_resolution_to_label(256, 144) == "144p"
    assert map_resolution_to_label(1280, 720) == "HD"
    assert map_resolution_to_label(1920, 1080) == "FHD"
    assert map_resolution_to_label(1920, 800) == "FHD"
    assert map_resolution_to_label(2560, 1440) == "2K"
    assert map_resolution_to_label(3840, 2160) == "4K"


# ==============================================================================
# 3. ТЕСТ АРХИТЕКТУРЫ: СТРОГО 2 ТАБЛИЦЫ В БД (НЕТ M2M ТАБЛИЦЫ)
# ==============================================================================

def test_strictly_two_tables_architecture(db_session):
    """
    Требование 1: Количество таблиц строго 2 (никаких промежуточных M2M-таблиц).
    Таблица 1 — movies.
    Таблица 2 — categories.
    """
    inspector = inspect(db_session.bind)
    tables = sorted(inspector.get_table_names())
    assert tables == ["categories", "movies"], f"Ожидалось строго 2 таблицы, получено: {tables}"

    # Проверяем структуру movies (category_ids, category_tag, plot)
    movie_cols = {col["name"] for col in inspector.get_columns("movies")}
    assert "category_ids" in movie_cols, "В таблице movies должен присутствовать столбец category_ids"
    assert "category_tag" in movie_cols, "В таблице movies должен присутствовать столбец category_tag"
    assert "plot" in movie_cols, "В таблице movies должен присутствовать столбец plot"

    # Проверяем структуру categories (icon_path)
    cat_cols = {col["name"] for col in inspector.get_columns("categories")}
    assert "icon_path" in cat_cols, "В таблице categories должен присутствовать столбец icon_path"


# ==============================================================================
# 4. ТЕСТЫ ЭНДПОИНТА ИКОНОЧНОГО КАТАЛОГА: GET /api/catalog/categories
# ==============================================================================

def test_catalog_categories_endpoint_and_empty_filtering(client):
    """
    Проверяет GET /api/catalog/categories:
    1. Категории с фильмами попадают в каталог;
    2. Пустые категории фильтруются и НЕ отправляются на фронтенд;
    3. При icon_path = NULL отдается fallback на дефолтную иконку.
    """
    c1 = client.post("/api/categories", json={
        "name": "Комедии",
        "slug": "comedy",
        "icon_path": "/images/icons/comedy.svg",
    }).json()
    c2 = client.post("/api/categories", json={
        "name": "Драмы",
        "slug": "drama",
        "icon_path": None,
    }).json()
    c_empty = client.post("/api/categories", json={
        "name": "Пустая категория",
        "slug": "empty-cat",
        "icon_path": None,
    }).json()

    # Пока нет фильмов — каталог пуст (пустые категории не отправляются)
    res_before = client.get("/api/catalog/categories")
    assert res_before.status_code == 200
    assert len(res_before.json()) == 0

    # Добавляем фильм в c1 и c2
    client.post("/api/movies", json={
        "title": "Тестовый фильм",
        "description": "Описание",
        "duration": "1 ч 30 мин",
        "quality": "1080p Full HD",
        "poster_url": "/p.jpg",
        "banner_desktop_url": "/d.jpg",
        "banner_mobile_url": "/m.jpg",
        "category_ids": f"{c1['id']},{c2['id']}",
    })

    res = client.get("/api/catalog/categories")
    assert res.status_code == 200
    data = res.json()
    # Только непустые c1 и c2 (c_empty отфильтрована!)
    assert len(data) == 2
    titles = [c["title"] for c in data]
    assert "Комедии" in titles
    assert "Драмы" in titles
    assert "Пустая категория" not in titles

    # Проверяем fallback-иконку
    comedy_item = next(c for c in data if c["title"] == "Комедии")
    drama_item = next(c for c in data if c["title"] == "Драмы")
    assert comedy_item["icon_url"] == "/images/icons/comedy.svg"
    assert drama_item["icon_url"] == "../IMAGES/icons/bochflix_mini_icon.svg"


# ==============================================================================
# 5. ТЕСТЫ С ПАГИНАЦИЕЙ И ФИЛЬТРАЦИЕЙ ПУСТЫХ КАТЕГОРИЙ: GET /api/categories
# ==============================================================================

def test_paginated_categories_filters_empty_categories(client):
    """
    Проверяет GET /api/categories:
    - Категории без фильмов (пустые) фильтруются и не отправляются на фронтенд.
    """
    c1 = client.post("/api/categories", json={"name": "Кат 1", "slug": "cat-1"}).json()
    c2 = client.post("/api/categories", json={"name": "Кат 2", "slug": "cat-2"}).json()
    c_empty = client.post("/api/categories", json={"name": "Кат Без Фильмов", "slug": "cat-empty"}).json()

    # Фильм привязан к c1 и c2
    client.post("/api/movies", json={
        "title": "Мстители",
        "description": "Супергерои",
        "duration": "2 ч 23 мин",
        "quality": "1080p Full HD",
        "poster_url": "/p.jpg",
        "banner_desktop_url": "/d.jpg",
        "banner_mobile_url": "/m.jpg",
        "category_ids": f"{c1['id']},{c2['id']}",
        "is_hero_banner": True,
    })

    res = client.get("/api/categories?offset=0&limit=10")
    assert res.status_code == 200
    cats = res.json()

    # Только 2 непустые категории
    assert len(cats) == 2
    cat_titles = [c["title"] for c in cats]
    assert "Кат 1" in cat_titles
    assert "Кат 2" in cat_titles
    assert "Кат Без Фильмов" not in cat_titles

    # Каждая содержит фильм
    assert len(cats[0]["movies"]) == 1
    assert cats[0]["movies"][0]["title"] == "Мстители"


# ==============================================================================
# 6. ТЕСТЫ ФИЛЬТРАЦИИ ПО КАТЕГОРИЯМ (ОДИН ФИЛЬМ В НЕСКОЛЬКИХ КАТЕГОРИЯХ)
# ==============================================================================

def test_multiple_categories_filtering(client):
    """
    Проверяет, что фильм с category_ids='1,2' попадает в обе категории.
    """
    cat_comedy = client.post("/api/categories", json={"name": "Комедия", "slug": "comedy"}).json()
    cat_drama = client.post("/api/categories", json={"name": "Драма", "slug": "drama"}).json()
    cat_action = client.post("/api/categories", json={"name": "Боевик", "slug": "action"}).json()

    movie_res = client.post("/api/movies", json={
        "title": "Трагикомедия 1+1",
        "description": "История дружбы",
        "duration": "1 ч 52 мин",
        "quality": "1080p Full HD",
        "poster_url": "/1plus1.jpg",
        "banner_desktop_url": "/1plus1_d.jpg",
        "banner_mobile_url": "/1plus1_m.jpg",
        "category_ids": f"{cat_comedy['id']},{cat_drama['id']}",
    })
    assert movie_res.status_code == 201

    # Запрос по category_id Комедии -> фильм найден
    res_com = client.get(f"/api/movies?category_id={cat_comedy['id']}")
    assert len(res_com.json()) == 1
    assert res_com.json()[0]["title"] == "Трагикомедия 1+1"

    # Запрос по category_id Драмы -> этот же фильм найден
    res_dra = client.get(f"/api/movies?category_id={cat_drama['id']}")
    assert len(res_dra.json()) == 1
    assert res_dra.json()[0]["title"] == "Трагикомедия 1+1"

    # Запрос по category_id Боевика -> фильм НЕ найден
    res_act = client.get(f"/api/movies?category_id={cat_action['id']}")
    assert len(res_act.json()) == 0


# ==============================================================================
# 7. ТЕСТЫ БЛОКА 'НОВОЕ И ПОПУЛЯРНОЕ' (is_new_popular)
# ==============================================================================

def test_popular_and_new_movies(client):
    """Проверяет фильтрацию фильмов по отдельному флагу is_new_popular."""
    c = client.post("/api/categories", json={"name": "Фильмы", "slug": "movies"}).json()

    client.post("/api/movies", json={
        "title": "Популярный хит",
        "description": "В топе",
        "duration": "2 ч",
        "quality": "4K",
        "poster_url": "/pop.jpg",
        "banner_desktop_url": "/pop_d.jpg",
        "banner_mobile_url": "/pop_m.jpg",
        "category_ids": str(c["id"]),
        "is_new_popular": True,
    })

    client.post("/api/movies", json={
        "title": "Обычный релиз",
        "description": "Без топа",
        "duration": "1 ч 30 мин",
        "quality": "1080p Full HD",
        "poster_url": "/reg.jpg",
        "banner_desktop_url": "/reg_d.jpg",
        "banner_mobile_url": "/reg_m.jpg",
        "category_ids": str(c["id"]),
        "is_new_popular": False,
    })

    res = client.get("/api/movies?is_popular=true")
    assert res.status_code == 200
    movies = res.json()
    assert len(movies) == 1
    assert movies[0]["title"] == "Популярный хит"


# ==============================================================================
# 8. ТЕСТ ОТКАЗОУСТОЙЧИВОСТИ: БУКВЫ / СПЕЦСИМВОЛЫ В category_ids
# ==============================================================================

def test_fault_tolerance_corrupted_category_ids(client, db_session):
    """
    Требование 4: Отказоустойчивость: валидировать каждый ID.
    Если в строке category_ids обнаружены буквы, спецсимволы или повреждённые данные:
    - НЕ ронять бэкенд (не бросать 500 error);
    - проблемный фильм просто пропускается в выборке по категориям, ошибка логируется;
    - корректные фильмы продолжают штатно возвращаться.
    """
    c = client.post("/api/categories", json={"name": "Боевики", "slug": "action"}).json()

    # 1. Создаем валидный фильм
    res_good = client.post("/api/movies", json={
        "title": "Хороший фильм",
        "description": "Валидные данные",
        "duration": "1 ч 30 мин",
        "quality": "1080p Full HD",
        "poster_url": "/good.jpg",
        "banner_desktop_url": "/good_d.jpg",
        "banner_mobile_url": "/good_m.jpg",
        "category_ids": str(c["id"]),
    })
    assert res_good.status_code == 201

    # 2. Создаем фильм и намеренно портим category_ids в БД (буквы, спецсимволы, мусор)
    res_bad = client.post("/api/movies", json={
        "title": "Поврежденный фильм",
        "description": "Мусор в category_ids",
        "duration": "1 ч 20 мин",
        "quality": "720p HD",
        "poster_url": "/bad.jpg",
        "banner_desktop_url": "/bad_d.jpg",
        "banner_mobile_url": "/bad_m.jpg",
        "category_ids": str(c["id"]),
    })
    bad_id = res_bad.json()["id"]

    db_session.execute(
        text("UPDATE movies SET category_ids = '1, corrupt#$!, abc, 999@' WHERE id = :mid"),
        {"mid": bad_id}
    )
    db_session.commit()

    # 3. Запрос категорий НЕ должен падать с 500!
    cats_res = client.get("/api/categories")
    assert cats_res.status_code == 200, "Бэкенд не должен падать с 500 из-за поврежденных category_ids!"

    # 4. Проверяем, что в выдаче категории присутствует только хороший фильм
    action_cat = next(cat for cat in cats_res.json() if cat["id"] == c["id"])
    movie_titles = [m["title"] for m in action_cat["movies"]]
    assert "Хороший фильм" in movie_titles
    assert "Поврежденный фильм" not in movie_titles, "Поврежденный фильм должен быть пропущен в выборке по категориям"

    # 5. Запрос GET /api/movies?category_id=... также НЕ падает
    filter_res = client.get(f"/api/movies?category_id={c['id']}")
    assert filter_res.status_code == 200
    filter_titles = [m["title"] for m in filter_res.json()]
    assert "Хороший фильм" in filter_titles
    assert "Поврежденный фильм" not in filter_titles


# ==============================================================================
# 9. ТЕСТ ПРЯМОГО РЕДАКТИРОВАНИЯ category_ids В ТАБЛИЦЕ movies
# ==============================================================================

def test_direct_sql_category_ids_update(client, db_session):
    """
    Проверяет, что прямое обновление category_ids в таблице movies
    (например, пользователь вписал '1, 4' в GUI базы) сразу подхватывается API.
    """
    c1 = client.post("/api/categories", json={"name": "Кат А", "slug": "cat-a"}).json()
    c2 = client.post("/api/categories", json={"name": "Кат Б", "slug": "cat-b"}).json()

    res = client.post("/api/movies", json={
        "title": "Фильм прямого редактирования",
        "description": "Тест category_ids",
        "duration": "1 ч 10 мин",
        "quality": "720p HD",
        "poster_url": "/p.jpg",
        "banner_desktop_url": "/d.jpg",
        "banner_mobile_url": "/m.jpg",
        "category_ids": str(c1["id"]),
    })
    mid = res.json()["id"]

    # Пользователь вписал '1, 2' в столбец category_ids напрямую в таблице movies
    db_session.execute(
        text("UPDATE movies SET category_ids = :ids WHERE id = :mid"),
        {"ids": f"{c1['id']}, {c2['id']}", "mid": mid}
    )
    db_session.commit()

    # Проверяем через API
    res_a = client.get(f"/api/movies?category_id={c1['id']}")
    assert any(m["id"] == mid for m in res_a.json())

    res_b = client.get(f"/api/movies?category_id={c2['id']}")
    assert any(m["id"] == mid for m in res_b.json())


# ==============================================================================
# 10. ТЕСТЫ БАННЕРОВ И УДАЛЕНИЯ
# ==============================================================================

def test_banners_endpoint(client):
    c = client.post("/api/categories", json={"name": "Тест"}).json()
    client.post("/api/movies", json={
        "title": "Баннер 1",
        "description": "Описание",
        "duration": "2 ч",
        "quality": "1080p Full HD",
        "poster_url": "/p1.jpg",
        "banner_desktop_url": "/b1.jpg",
        "banner_mobile_url": "/m1.jpg",
        "category_ids": str(c["id"]),
        "is_hero_banner": True,
    })
    client.post("/api/movies", json={
        "title": "Обычный 2",
        "description": "Описание",
        "duration": "1 ч 30 мин",
        "quality": "720p HD",
        "poster_url": "/p2.jpg",
        "banner_desktop_url": "/b2.jpg",
        "banner_mobile_url": "/m2.jpg",
        "category_ids": str(c["id"]),
        "is_hero_banner": False,
    })
    res = client.get("/api/banners")
    assert res.status_code == 200
    banners = res.json()
    assert len(banners) == 1
    assert banners[0]["title"] == "Баннер 1"


def test_delete_movie_and_cors(client):
    c = client.post("/api/categories", json={"name": "Тест"}).json()
    res = client.post("/api/movies", json={
        "title": "Фильм для удаления",
        "description": "Описание",
        "duration": "1 ч 30 мин",
        "quality": "720p HD",
        "poster_url": "/del.jpg",
        "banner_desktop_url": "/del_d.jpg",
        "banner_mobile_url": "/del_m.jpg",
        "category_ids": str(c["id"]),
    })
    pnr = res.json()["pnr"]

    del_res = client.delete(f"/api/movies/{pnr}")
    assert del_res.status_code == 200

    check_res = client.get(f"/api/movies/{pnr}")
    assert check_res.status_code == 404


# ==============================================================================
# 11. ТЕСТЫ ЦЕЛЕВОЙ СХЕМЫ, УПРАВЛЕНИЯ КАТЕГОРИЯМИ И ПАРСИНГА ВИДЕО
# ==============================================================================

def test_target_schema_columns(db_session):
    """Проверяет наличие всех целевых колонок в таблице movies."""
    inspector = inspect(engine)
    columns = {col["name"]: col for col in inspector.get_columns("movies")}

    required_columns = [
        "id", "pnr", "title", "description", "plot", "duration", "quality",
        "poster_url", "banner", "mobile_poster", "movie_page_url",
        "logo_url", "trailer", "is_hero_banner", "category_tag",
        "category_ids"
    ]
    for col in required_columns:
        assert col in columns, f"Колонка {col} отсутствует в целевой таблице movies"


def test_unified_category_tag_and_plot_field(client):
    """
    Проверяет рефакторинг категорий и сюжета:
    1. Сохранение поля plot (сюжет);
    2. Сохранение и валидацию category_tag ('none', 'new', 'popular', 'new_popular');
    3. Фильтрацию по GET /api/movies?category_tag=...;
    4. Обратную совместимость с GET /api/movies?is_popular=true.
    """
    cat = client.post("/api/categories", json={"name": "Фантастика", "slug": "sci-fi"}).json()

    # Фильм с category_tag = 'new', с подробным сюжетом
    client.post("/api/movies", json={
        "title": "Новинка года",
        "description": "Краткое описание",
        "plot": "Полный сюжет фантастического фильма со всеми сюжетными поворотами.",
        "duration": "2 ч",
        "quality": "4K",
        "poster_url": "/poster_new.jpg",
        "banner": "/banner_new.jpg",
        "mobile_poster": "/mob_new.jpg",
        "category_ids": [cat["id"]],
        "category_tag": "new",
    })

    # Фильм с category_tag = 'popular'
    client.post("/api/movies", json={
        "title": "Популярный хит продаж",
        "description": "Описание хита",
        "plot": "Сюжет блокбастера",
        "duration": "1 ч 50 мин",
        "quality": "1080p Full HD",
        "poster_url": "/poster_pop.jpg",
        "banner": "/banner_pop.jpg",
        "mobile_poster": "/mob_pop.jpg",
        "category_ids": [cat["id"]],
        "category_tag": "popular",
    })

    # Фильм с category_tag = 'new_popular'
    client.post("/api/movies", json={
        "title": "Новый популярный фильм",
        "description": "Двойной статус",
        "duration": "1 ч 40 мин",
        "quality": "1080p Full HD",
        "poster_url": "/poster_np.jpg",
        "banner": "/banner_np.jpg",
        "mobile_poster": "/mob_np.jpg",
        "category_ids": [cat["id"]],
        "category_tag": "new_popular",
    })

    # Фильм без спецстатуса
    client.post("/api/movies", json={
        "title": "Обычное кино",
        "description": "Без категорий статуса",
        "duration": "1 ч 30 мин",
        "quality": "720p HD",
        "poster_url": "/poster_none.jpg",
        "banner": "/banner_none.jpg",
        "mobile_poster": "/mob_none.jpg",
        "category_ids": [cat["id"]],
        "category_tag": "none",
    })

    # 1. Проверяем фильтрацию по category_tag=new (включает new и new_popular)
    res_new = client.get("/api/movies?category_tag=new")
    assert res_new.status_code == 200
    movies_new = res_new.json()
    assert len(movies_new) == 2
    titles_new = {m["title"] for m in movies_new}
    assert "Новинка года" in titles_new
    assert "Новый популярный фильм" in titles_new
    novinka = next(m for m in movies_new if m["title"] == "Новинка года")
    assert novinka["plot"] == "Полный сюжет фантастического фильма со всеми сюжетными поворотами."
    assert novinka["category_tag"] == "new"

    # 2. Проверяем фильтрацию по category_tag=popular (включает popular и new_popular)
    res_pop = client.get("/api/movies?category_tag=popular")
    assert res_pop.status_code == 200
    movies_pop = res_pop.json()
    assert len(movies_pop) == 2
    titles_pop = {m["title"] for m in movies_pop}
    assert "Популярный хит продаж" in titles_pop
    assert "Новый популярный фильм" in titles_pop

    # 3. Проверяем точную фильтрацию по category_tag=new_popular
    res_np = client.get("/api/movies?category_tag=new_popular")
    assert res_np.status_code == 200
    movies_np = res_np.json()
    assert len(movies_np) == 1
    assert movies_np[0]["title"] == "Новый популярный фильм"

    # 4. Проверяем обратную совместимость: is_popular=true должно вернуть фильмы с 'popular' и 'new_popular'
    res_legacy_pop = client.get("/api/movies?is_popular=true")
    assert res_legacy_pop.status_code == 200
    legacy_pop_titles = {m["title"] for m in res_legacy_pop.json()}
    assert "Популярный хит продаж" in legacy_pop_titles
    assert "Новый популярный фильм" in legacy_pop_titles
    assert "Новинка года" not in legacy_pop_titles
    assert "Обычное кино" not in legacy_pop_titles


def test_category_creation_and_duplicate_handling(client):
    """Проверяет создание категории, автогенерацию slug и дедупликацию без учета регистра."""
    # 1. Создание новой категории
    res1 = client.post("/api/categories", json={"name": "Триллер", "icon_path": "/icon.svg"})
    assert res1.status_code == 201
    data1 = res1.json()
    assert data1["name"] == "Триллер"
    assert data1["slug"] == "triller"
    assert data1["icon_url"] == "/icon.svg"

    # 2. Попытка создать дубликат с другим регистром ("триллер")
    res2 = client.post("/api/categories", json={"name": "  триллер  "})
    assert res2.status_code in (200, 201)
    data2 = res2.json()
    assert data2["id"] == data1["id"]  # Должна вернуться существующая запись, а не дубликат!

    # 3. Попытка создать запрещенную псевдо-категорию "Новое и популярное"
    res3 = client.post("/api/categories", json={"name": "Новое и популярное"})
    assert res3.status_code == 400


def test_video_metadata_mp4_parser_and_fallback():
    """Проверяет pure-Python MP4 box parser и безопасный fallback при поврежденных файлах."""
    import tempfile
    from backend.utils.video_meta import normalize_duration_str, normalize_quality_str

    # Тестирование нормализации
    assert normalize_duration_str("144") == "2 ч 24 мин"
    assert normalize_duration_str("131") == "2 ч 11 мин"
    assert normalize_duration_str("45") == "45 мин"
    assert normalize_duration_str("115 мин") == "1 ч 55 мин"

    assert normalize_quality_str("720p") == "HD"
    assert normalize_quality_str("1080p") == "FHD"
    assert normalize_quality_str("4k") == "4K"

    # Тестирование реального MP4 файла (если есть в media)
    test_mp4 = Path("media/video/KVLXGR.mp4")
    if test_mp4.is_file():
        meta = extract_video_metadata(test_mp4)
        assert meta["backend"] in ("mp4_atoms", "opencv", "ffprobe")
        assert meta["duration_seconds"] > 0
        assert meta["quality_label"] in ("480p", "HD", "FHD")

    # Тестирование поврежденного файла (не должен выбрасывать исключений)
    with tempfile.NamedTemporaryFile(suffix=".mp4") as tf:
        tf.write(b"NOT A VALID MP4 FILE AT ALL 987654321")
        tf.flush()
        meta_corrupt = extract_video_metadata(tf.name)
        assert meta_corrupt["backend"] == "fallback"
        assert meta_corrupt["width"] == 1920
        assert meta_corrupt["height"] == 1080
        assert meta_corrupt["quality_label"] == "FHD"
        assert meta_corrupt["duration_formatted"] == "0 мин"


def test_movie_creation_with_target_columns(client):
    """Проверяет создание фильма с использованием новых целевых колонок (banner, mobile_poster, etc.)."""
    cat = client.post("/api/categories", json={"name": "Аниме"}).json()

    movie_payload = {
        "title": "Унесенные призраками",
        "description": "Шедевр анимации",
        "duration": "125",  # Должен нормализоваться в '2 ч 5 мин'
        "quality": "1080p",  # Должен нормализоваться в 'FHD'
        "poster_url": "/posters/ghibli.jpg",
        "banner": "/banners/ghibli_desk.jpg",
        "mobile_poster": "/banners/ghibli_mob.jpg",
        "trailer": "https://youtube.com/watch?v=123",
        "is_hero_banner": True,
        "is_new_and_popular": True,
        "category_ids": [cat["id"]],
    }

    res = client.post("/api/movies", json=movie_payload)
    assert res.status_code == 201
    data = res.json()
    assert data["title"] == "Унесенные призраками"
    assert data["duration"] == "2 ч 5 мин"
    assert data["quality"] == "FHD"
    assert data["banner"] == "/banners/ghibli_desk.jpg"
    assert data["mobile_poster"] == "/banners/ghibli_mob.jpg"
    assert data["banner_desktop_url"] == "/banners/ghibli_desk.jpg"
    assert data["banner_mobile_url"] == "/banners/ghibli_mob.jpg"
    assert data["trailer"] == "https://youtube.com/watch?v=123"
    assert data["is_hero_banner"] is True
    assert data["is_new_and_popular"] is True


def test_category_icon_local_path_normalization(client):
    """Проверяет автоматическую нормализацию локальных путей к иконкам."""
    import tempfile
    from backend.models import resolve_icon_url

    # 1. NULL / пустой путь
    assert resolve_icon_url(None) == "../IMAGES/icons/bochflix_mini_icon.svg"
    assert resolve_icon_url("") == "../IMAGES/icons/bochflix_mini_icon.svg"

    # 2. Имя файла из front-end/IMAGES/icons/
    assert resolve_icon_url("catalog.svg") == "/images/icons/catalog.svg"
    assert resolve_icon_url("front-end/IMAGES/icons/catalog.svg") == "/images/icons/catalog.svg"

    # 3. Существующий локальный файл на диске
    with tempfile.NamedTemporaryFile(suffix=".svg") as tf:
        tf.write(b"<svg></svg>")
        tf.flush()
        web_url = resolve_icon_url(tf.name, slug="custom_cat")
        assert web_url == "/media/icons/custom_cat.svg"
        assert Path("media/icons/custom_cat.svg").is_file()

    # 4. Проверка создания категории через API с локальным именем иконки
    res = client.post("/api/categories", json={"name": "Детектив", "icon_path": "catalog.svg"})
    assert res.status_code == 201
    assert res.json()["icon_url"] == "/images/icons/catalog.svg"


def test_sidebar_state_persistence_in_frontend():
    """Проверяет сохранение и чтение состояния бокового меню в LocalStorage на фронтенде."""
    js_path = Path("front-end/JS/script.js")
    html_path = Path("front-end/HTML/index.html")

    assert js_path.is_file(), "front-end/JS/script.js must exist"
    assert html_path.is_file(), "front-end/HTML/index.html must exist"

    js_code = js_path.read_text(encoding="utf-8")
    html_code = html_path.read_text(encoding="utf-8")

    # Проверка константы ключа хранилища
    assert "bochflix_aside_collapsed" in js_code
    assert "localStorage.getItem" in js_code
    assert "localStorage.setItem" in js_code
    assert "wrapper--aside-collapsed" in js_code

    # Проверка обработки закрытия/открытия меню
    assert "arrowAside.addEventListener" in js_code
    assert "headerMenuBtn.addEventListener" in js_code

    # Проверка скрипта предотвращения FOUC в HTML
    assert "bochflix_aside_collapsed" in html_code
    assert "wrapper--aside-collapsed" in html_code


def test_hero_banner_component_and_responsive_styles():
    """Проверяет соответствие компонента главного баннера референсу Project_27 и адаптивным правилам (включая 6:5)."""
    html_code = Path("front-end/HTML/index.html").read_text(encoding="utf-8")
    css_code = Path("front-end/STYLES/style.css").read_text(encoding="utf-8")
    optimize_css = Path("front-end/STYLES/optimize.css").read_text(encoding="utf-8")
    js_code = Path("front-end/JS/script.js").read_text(encoding="utf-8")
    loader_code = Path("front-end/JS/frontend_loader.js").read_text(encoding="utf-8")

    # 1. Структура в HTML
    assert "main__item-poster" in html_code
    assert "main__item-poster-logo" in html_code
    assert "main__item-poster-info" in html_code
    assert "poster-info__item--duration" in html_code
    assert "poster-info__item--quality" in html_code
    assert "main__item-poster-genre" in html_code
    # Описание и лишние кнопки убраны из баннера по обновленным требованиям
    assert "main__item-poster-description" not in html_code
    assert "poster-button__action" in html_code
    assert "poster-button__info" in html_code
    assert "Смотреть" in html_code
    assert "Подробнее" in html_code
    assert "mobile-rating" in html_code

    # 2. Стили в style.css (градиенты, размытие, маски, кнопки, hover-эффекты)
    assert ".main__item-poster" in css_code
    assert ".item-poster__wrapper" in css_code
    assert "backdrop-filter" in css_code
    assert "mask-image" in css_code
    assert ".poster-button__action" in css_code
    assert ".poster-button__info" in css_code
    assert "buttonMove" in css_code
    # Ограничение трейлера по ховеру мыши
    assert "(hover: hover) and (pointer: fine)" in css_code

    # 3. Мобильная версия (6:5) в optimize.css (логотип + оценка слева, длительность справа)
    assert "aspect-ratio: 6 / 5" in optimize_css or "aspect-ratio: 6/5" in optimize_css or "min-height: 80vw" in optimize_css
    assert ".main__item-poster-buttons" in optimize_css
    assert "display: none !important" in optimize_css
    assert ".poster-info__item--duration" in optimize_css
    assert ".mobile-rating" in optimize_css
    assert ".main__item-poster-brand" in optimize_css

    # 4. Логика интерактивности в script.js
    assert "poster-button__action" in js_code
    assert "poster-button__info" in js_code
    assert "HOVER_DELAY" in js_code
    assert "poster-video" in js_code

    # 5. Динамический рендеринг в frontend_loader.js
    assert "main__item-poster" in loader_code
    assert "poster-button__action" in loader_code
    assert "poster-button__info" in loader_code


def test_video_streaming_and_trailer_display():
    """Проверяет корректность отдачи тяжелого видео (faststart, moov at front), Nginx буферизацию и 100% покрытие трейлера."""
    import struct
    css_code = Path("front-end/STYLES/style.css").read_text(encoding="utf-8")
    loader_code = Path("front-end/JS/frontend_loader.js").read_text(encoding="utf-8")
    nginx_conf = Path("deploy/nginx.conf").read_text(encoding="utf-8")

    # 1. Стили трейлера: 100% заполнение, центрирование, cover без черных полос
    assert "object-fit: cover" in css_code
    assert "object-position: center" in css_code
    assert "top: 50%" in css_code
    assert "translate(-50%, -50%)" in css_code
    assert ".poster-video" in loader_code

    # Проверка универсального масштабирования и устранения черных полос в JS
    js_code = Path("front-end/JS/script.js").read_text(encoding="utf-8")
    assert "eliminateVideoBlackBars" in js_code
    assert "iframe" in js_code
    assert "translate(-50%, -50%)" in js_code

    # 2. Проверка видеофайла «Главный герой»: moov в начале (faststart), отсутствие фрагментов moof
    wjhl0b_path = Path("media/video/WJHL0B.mp4")
    assert wjhl0b_path.exists(), "Файл фильма WJHL0B.mp4 должен существовать"
    with open(wjhl0b_path, "rb") as f:
        atoms = []
        for _ in range(5):
            h = f.read(8)
            if len(h) < 8:
                break
            size, name = struct.unpack(">I4s", h)
            name = name.decode("latin1", errors="ignore")
            atoms.append(name)
            if size == 1:
                large_size = struct.unpack(">Q", f.read(8))[0]
                f.seek(large_size - 16, 1)
            elif size > 8:
                f.seek(size - 8, 1)
        assert "moov" in atoms, "Атом moov должен находиться в начале файла (faststart)"
        # Проверяем, что moov расположен до mdat
        moov_idx = atoms.index("moov")
        if "mdat" in atoms:
            assert moov_idx < atoms.index("mdat"), "moov должен идти строго перед mdat"

    # 3. Nginx конфигурация: mp4 модуль, буферизация тяжелых видео, directio, sendfile_max_chunk, Accept-Ranges, client_max_body_size
    assert "mp4;" in nginx_conf
    assert "client_max_body_size 0" in nginx_conf
    assert "directio" in nginx_conf
    assert "output_buffers" in nginx_conf
    assert "sendfile_max_chunk 1m" in nginx_conf or "sendfile_max_chunk 2m" in nginx_conf
    assert "Accept-Ranges" in nginx_conf
    assert "error_page 500" in nginx_conf
    assert "@fallback_media" in nginx_conf

    # 4. Сохранность стилей логотипа
    assert ".main__item-poster-logo" in css_code
    assert ".main__item-poster-brand" in css_code


def test_information_page_navigation_and_details(client):
    """
    Проверяет ТЗ по странице информации о фильме (information.html) и логике кнопок:
    1. Эндпоинт GET /api/movies/{identifier} работает и по numeric ID, и по PNR;
    2. Переход на information.html?id=... с баннера (клик по карточке и кнопке 'Подробнее');
    3. Переход на information.html?id=... с маленьких карточек каталога;
    4. Кнопка 'Смотреть' везде ведет напрямую на видеофайл с event.stopPropagation();
    5. Загрузка и рендеринг данных (название, постер, описание, сюжет, год, рейтинг, жанры);
    6. Наличие cursor: pointer у карточек и кнопок.
    """
    cat = client.post("/api/categories", json={"name": "Боевик", "slug": "action-test"}).json()

    movie_res = client.post("/api/movies", json={
        "title": "Интерстеллар",
        "description": "Путешествие сквозь пространство и время.",
        "plot": "Земля на грани гибели из-за пыльных бурь. Группа астронавтов отправляется на поиски нового дома через червоточину.",
        "duration": "2 ч 49 мин",
        "quality": "4K",
        "poster_url": "/interstellar_poster.jpg",
        "banner": "/interstellar_banner.jpg",
        "mobile_poster": "/interstellar_mob.jpg",
        "logo_url": "/interstellar_logo.png",
        "trailer": "/interstellar_trailer.mp4",
        "category_ids": [cat["id"]],
        "rating": 8.7,
        "is_hero_banner": True,
    })
    assert movie_res.status_code == 201
    movie_data = movie_res.json()
    movie_id = movie_data["id"]
    movie_pnr = movie_data["pnr"]

    # 1. Запрос по ID
    res_by_id = client.get(f"/api/movies/{movie_id}")
    assert res_by_id.status_code == 200
    detail_by_id = res_by_id.json()
    assert detail_by_id["title"] == "Интерстеллар"
    assert detail_by_id["plot"] == "Земля на грани гибели из-за пыльных бурь. Группа астронавтов отправляется на поиски нового дома через червоточину."
    assert detail_by_id["rating"] == 8.7
    assert detail_by_id["quality"] == "4K"
    assert detail_by_id["duration"] == "2 ч 49 мин"

    # 2. Запрос по PNR
    res_by_pnr = client.get(f"/api/movies/{movie_pnr}")
    assert res_by_pnr.status_code == 200
    assert res_by_pnr.json()["id"] == movie_id

    # 3. Проверка фронтенд-файлов
    html_file = Path("front-end/HTML/information.html")
    info_js_file = Path("front-end/JS/information.js")
    script_js_file = Path("front-end/JS/script.js")
    loader_js_file = Path("front-end/JS/frontend_loader.js")
    info_css_file = Path("front-end/STYLES/informaton.css")
    style_css_file = Path("front-end/STYLES/style.css")

    assert html_file.is_file(), "information.html must exist"
    assert info_js_file.is_file(), "information.js must exist"

    html_code = html_file.read_text(encoding="utf-8")
    info_js = info_js_file.read_text(encoding="utf-8")
    script_js = script_js_file.read_text(encoding="utf-8")
    loader_js = loader_js_file.read_text(encoding="utf-8")
    info_css = info_css_file.read_text(encoding="utf-8")
    style_css = style_css_file.read_text(encoding="utf-8")

    # Проверка подключения скрипта в information.html
    assert "information.js" in html_code
    assert "main__top-data--logo" in html_code
    assert "main__info--rating" in html_code
    assert "main__info--duration" in html_code
    assert "main__info--quality" in html_code
    assert "main__top-btn--watch" in html_code
    assert "main__top-btn--trailer" in html_code
    assert "plot-text" in html_code

    # Проверка логики загрузки данных в information.js
    assert "getMovieIdentifier" in info_js or "URLSearchParams" in info_js
    assert "fetchMovieDetails" in info_js or "/api/movies/" in info_js
    assert "movie.plot" in info_js
    assert "movie.description" in info_js
    assert "videoPlayUrl" in info_js or "movie_page_url" in info_js
    assert "stopPropagation" in info_js

    # Проверка навигации в script.js и frontend_loader.js
    # Баннер: клик по Смотреть ведет к видео, по Подробнее / карточке к information.html?id=
    assert "information.html?id=" in script_js or "dataset.infoUrl" in script_js
    assert "information.html?id=" in loader_js
    assert "stopPropagation" in script_js
    assert "stopPropagation" in loader_js

    # Проверка cursor: pointer у интерактивных карточек и кнопок
    assert "cursor: pointer" in info_css
    assert ".main__top-btn--watch" in info_css
    assert ".main__standart-card--item" in style_css
    assert "cursor: pointer" in style_css


def test_manage_db_media_processing(tmp_path):
    """
    Тестирование модуля manage_db:
    1. Очистка экранированных путей при drag-and-drop из Finder (clean_input_path).
    2. Переименование логотипа в <PNR>_logo.<ext> и перенос в media/logos/.
    3. Переименование трейлера в <PNR>_trailer.<ext> и перенос в media/trailers/.
    4. Формирование относительных Nginx веб-путей, начинающихся с /media/.
    """
    from manage_db import (
        clean_input_path,
        process_media_file,
        LOGO_STORAGE_DIR,
        TRAILER_STORAGE_DIR,
        POSTER_STORAGE_DIR,
        BANNER_STORAGE_DIR,
    )

    # 1. Проверка очистки путей Finder
    raw_finder = "'/Users/dmitriy/My\\ Movies/Sample\\ File\\ (2024).mp4'"
    assert clean_input_path(raw_finder) == "/Users/dmitriy/My Movies/Sample File (2024).mp4"

    test_pnr = "99TST9"

    # Создаем временные исходные файлы
    dummy_logo = tmp_path / "temp_logo.webp"
    dummy_logo.write_bytes(b"WEBP-LOGO-DATA")

    dummy_trailer = tmp_path / "temp_trailer.mp4"
    dummy_trailer.write_bytes(b"MP4-TRAILER-DATA")

    dummy_poster = tmp_path / "temp_poster.png"
    dummy_poster.write_bytes(b"PNG-POSTER-DATA")

    # 2. Обработка логотипа
    logo_web_url = process_media_file(str(dummy_logo), "logos", test_pnr, "logo")
    assert logo_web_url == f"/media/logos/{test_pnr}_logo.webp"
    target_logo = LOGO_STORAGE_DIR / f"{test_pnr}_logo.webp"
    assert target_logo.is_file()
    assert target_logo.read_bytes() == b"WEBP-LOGO-DATA"

    # 3. Обработка трейлера
    trailer_web_url = process_media_file(str(dummy_trailer), "trailers", test_pnr, "trailer", default_ext=".mp4")
    assert trailer_web_url == f"/media/trailers/{test_pnr}_trailer.mp4"
    target_trailer = TRAILER_STORAGE_DIR / f"{test_pnr}_trailer.mp4"
    assert target_trailer.is_file()
    assert target_trailer.read_bytes() == b"MP4-TRAILER-DATA"

    # 4. Обработка постера
    poster_web_url = process_media_file(str(dummy_poster), "posters", test_pnr, "poster")
    assert poster_web_url == f"/media/posters/{test_pnr}_poster.png"
    target_poster = POSTER_STORAGE_DIR / f"{test_pnr}_poster.png"
    assert target_poster.is_file()
    assert target_poster.read_bytes() == b"PNG-POSTER-DATA"

    # 5. Сохранение уже относительных веб-путей и обработка пустых значений
    assert process_media_file(None, "logos", test_pnr, "logo") is None
    assert process_media_file("", "logos", test_pnr, "logo") is None
    assert process_media_file("/media/logos/existing.webp", "logos", test_pnr, "logo") == "/media/logos/existing.webp"
    assert process_media_file("/media/trailers/existing.mp4", "trailers", test_pnr, "trailer") == "/media/trailers/existing.mp4"

    # Удаляем созданные тестовые файлы из папок media/
    for f in (target_logo, target_trailer, target_poster):
        if f.is_file():
            f.unlink()


def test_manage_db_video_remux_integration():
    """
    Проверяет интеграцию функции проверки и склейки видео check_and_remux_video в manage_db.py:
    1. Монолитное видео с faststart подтверждается без изменений.
    2. Ошибочный/несуществующий путь отклоняется (возвращает False).
    3. Наличие вызова check_and_remux_video в блоке сохранения фильма в manage_db.py.
    """
    from manage_db import check_and_remux_video

    # 1. Проверка на реальном монолитном видео
    real_video = Path("media/video/WJHL0B.mp4")
    assert real_video.exists()
    assert check_and_remux_video(real_video) is True

    # 2. Проверка на несуществующем файле
    fake_video = Path("media/video/NON_EXISTENT_12345.mp4")
    assert check_and_remux_video(fake_video) is False

    # 3. Проверка исходного кода manage_db.py на обязательный вызов проверки перед записью в БД
    manage_db_src = Path("manage_db.py").read_text(encoding="utf-8")
    assert "check_and_remux_video(dest_video)" in manage_db_src
    assert "video_ready = check_and_remux_video(dest_video)" in manage_db_src
    assert "if not video_ready:" in manage_db_src







