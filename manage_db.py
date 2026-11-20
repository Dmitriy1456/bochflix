#!/usr/bin/env python3
"""
CLI-утилита для интерактивного наполнения и управления базой данных кинохостинга Bochflix.
Реализует пошаговый мастер добавления фильмов:
1. Генерация PNR (цифры 0-9 и латинские согласные);
2. Запрос пути к исходному видеофайлу;
3. Автоматический парсинг метаданных видео (длительность 'X ч Y мин', качество 'FHD' и т.д.);
4. Перемещение и переименование видеофайла в media/video/<PNR>.mp4;
5. Ручной ввод названия, описания, баннеров, выбор категории и флага is_hero_banner;
6. Предпоказ карточки и подтверждение сохранения в БД.
"""

import sys
import shutil
import argparse
from pathlib import Path
from typing import Optional, List, Tuple

from backend.config import BASE_DIR, settings
from backend.database import SessionLocal, init_db
from backend.models import Movie, Category, resolve_icon_url
from backend.utils.pnr import generate_pnr, is_valid_pnr, PNR_ALPHABET, PNR_LENGTH
from backend.utils.video_meta import (
    extract_video_metadata,
    format_duration,
    map_resolution_to_label,
    normalize_duration_str,
    normalize_quality_str,
)

try:
    from remux_to_monolithic import is_fragmented_mp4, remux_file_to_monolithic
except ImportError:
    sys.path.insert(0, str(BASE_DIR))
    from remux_to_monolithic import is_fragmented_mp4, remux_file_to_monolithic


def check_and_remux_video(video_path: Path) -> bool:
    """
    Проверяет структуру видеофайла перед сохранением фильма в БД:
    1. Если фильм уже монолитный и с faststart (moov в начале) — пропускает без изменений.
    2. Если фильм фрагментарный (fMP4 с атомами moof/mdat) — запускает автоматическую 
       stream-copy перепаковку (склейку) в монолитный MP4 с атомом moov в начале файла.
    3. Если фильм монолитный, но атом moov расположен в конце — оптимизирует faststart.
    Возвращает True в случае успеха (или если файл уже валиден), False при сбое склейки.
    """
    video_path = Path(video_path).resolve()
    if not video_path.is_file():
        print(f"  [X] Ошибка: видеофайл не найден: {video_path}")
        return False

    print(f"\n[*] Проверка структуры видеофайла: {video_path.name}...")
    is_frag, has_faststart = is_fragmented_mp4(video_path)

    if is_frag:
        print(f"  [!] Обнаружен фрагментированный MP4 файл (fMP4 с фрагментами moof).")
        print(f"  [*] Запуск автоматической перепаковки (склейки) в монолитный faststart MP4...")
        success = remux_file_to_monolithic(video_path, in_place=True)
        if not success:
            print(f"  [X] ОШИБКА: Не удалось склеить фрагментированное видео в монолитный файл!")
            return False
        print(f"  [+] Видео успешно склеено и преобразовано в монолитный MP4!")
        return True
    elif not has_faststart:
        print(f"  [!] Видео монолитное, но атом moov расположен в конце файла.")
        print(f"  [*] Оптимизация moov в начало файла (faststart) для мгновенного старта воспроизведения...")
        success = remux_file_to_monolithic(video_path, in_place=True)
        if not success:
            print(f"  [!] Предупреждение: не удалось переместить moov, сохраняем как есть.")
        else:
            print(f"  [+] Faststart успешно применен!")
        return True
    else:
        print(f"  [+] Видеофайл уже является монолитным MP4 с faststart (проверка пройдена).")
        return True

VIDEO_STORAGE_DIR = BASE_DIR / "media" / "video"
POSTER_STORAGE_DIR = BASE_DIR / "media" / "posters"
BANNER_STORAGE_DIR = BASE_DIR / "media" / "banners"
LOGO_STORAGE_DIR = BASE_DIR / "media" / "logos"
TRAILER_STORAGE_DIR = BASE_DIR / "media" / "trailers"

for _dir in (VIDEO_STORAGE_DIR, POSTER_STORAGE_DIR, BANNER_STORAGE_DIR, LOGO_STORAGE_DIR, TRAILER_STORAGE_DIR):
    _dir.mkdir(parents=True, exist_ok=True)


def print_banner():
    print("""
====================================================================
          BOCHFLIX — УТИЛИТА НАПОЛНЕНИЯ И УПРАВЛЕНИЯ БД
====================================================================
""")


def clean_input_path(raw_path: str) -> str:
    """Очищает путь от кавычек и экранированных пробелов при перетаскивании из Finder (drag-and-drop)."""
    val = raw_path.strip().strip("'\"")
    # Убираем экранирование обратными слэшами на macOS/Linux (e.g. My\ Video.mp4)
    val = val.replace("\\ ", " ").replace("\\(", "(").replace("\\)", ")")
    return val


def prompt_non_empty(prompt_text: str, default: Optional[str] = None) -> str:
    """Запрашивает у пользователя непустую строку с возможностью дефолтного значения."""
    suffix = f" [{default}]" if default else ""
    while True:
        try:
            val = input(f"{prompt_text}{suffix}: ").strip()
            if not val and default is not None:
                return default
            if val:
                return val
            print("  [!] Поле не может быть пустым. Пожалуйста, введите значение.")
        except (KeyboardInterrupt, EOFError):
            print("\n  [!] Ввод прерван.")
            sys.exit(0)


def process_media_file(
    user_input: Optional[str],
    media_subdir: str,
    pnr: str,
    suffix: str,
    default_ext: str = ".webp",
) -> Optional[str]:
    """
    Обрабатывает ввод медиафайла:
    1. Если ввод пустой/None -> возвращает None.
    2. Очищает от кавычек и экранированных пробелов (drag-and-drop из Finder).
    3. Если передан существующий локальный файл на диске:
       - Копирует его в целевую папку media/{media_subdir}/ строго по паттерну:
         * logo:     media/logos/<PNR>_logo.<ext>
         * trailer:  media/trailers/<PNR>_trailer.<ext>
         * poster:   media/posters/<PNR>_poster.<ext>
         * desktop:  media/banners/<PNR>_desktop.<ext>
         * mobile:   media/banners/<PNR>_mobile.<ext>
       - Возвращает относительный веб-путь от корня веб-сервера:
         /media/{media_subdir}/<PNR>_<suffix>.<ext>
    4. Если передан внешний абсолютный URL (http://, https://, data:) -> возвращает как есть.
    5. Если путь уже относительный веб-путь (/media/..., /images/...) -> возвращает его.
    """
    if not user_input or not str(user_input).strip():
        return None

    clean_path = clean_input_path(user_input)
    if not clean_path:
        return None

    # Внешние абсолютные URL
    if clean_path.startswith(("http://", "https://", "data:")):
        return clean_path

    # Проверяем локальный файл на диске (включая ~ и относительные пути)
    expanded = Path(clean_path).expanduser().resolve()
    if expanded.is_file():
        ext = expanded.suffix.lower() or default_ext
        dest_filename = f"{pnr}_{suffix}{ext}" if suffix else f"{pnr}{ext}"
        dest_dir = BASE_DIR / "media" / media_subdir
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_file = (dest_dir / dest_filename).resolve()

        if expanded != dest_file:
            shutil.copy2(expanded, dest_file)
            print(f"  [+] Файл перенесен/скопирован в media/{media_subdir}/: \033[1;32m{dest_filename}\033[0m")

        web_url = f"/media/{media_subdir}/{dest_filename}"
        return web_url

    # Если передан уже относительный веб-путь
    if clean_path.startswith("/media/") or clean_path.startswith("/images/"):
        return clean_path

    if clean_path.startswith("/"):
        return clean_path

    return f"/media/{media_subdir}/{clean_path}"


def process_icon_file(user_input: Optional[str], slug: str) -> Optional[str]:
    """
    Обрабатывает путь к иконке (локальный файл, имя файла или веб-URL).
    Если указан локальный файл — копирует в media/icons/<slug>.<ext> и возвращает /media/icons/<slug>.<ext>.
    """
    if not user_input or not str(user_input).strip():
        return None
    clean = clean_input_path(user_input)
    return resolve_icon_url(clean, slug=slug)


def select_categories_interactive(db) -> List[Category]:
    """Интерактивный выбор категорий: принимает номера категорий (например '1, 4')."""
    from backend.utils.category_parser import parse_category_ids

    categories = db.query(Category).order_by(Category.id.asc()).all()
    if not categories:
        init_db()
        categories = db.query(Category).order_by(Category.id.asc()).all()

    cats_dict = {c.id: c for c in categories}
    all_movies = db.query(Movie).all()

    # Считаем количество фильмов в каждой категории
    counts = {}
    for m in all_movies:
        for cid in m.parsed_category_ids:
            counts[cid] = counts.get(cid, 0) + 1

    print("\n--- ВЫБОР КАТЕГОРИЙ (укажите ID через запятую, например '1, 4') ---")
    for cat in categories:
        count = counts.get(cat.id, 0)
        icon_str = f" [иконка: {cat.icon_path}]" if cat.icon_path else ""
        print(f"  {cat.id}) {cat.name} (slug: {cat.slug}) [фильмов: {count}]{icon_str}")
    print("  +) Создать новую категорию")

    while True:
        raw_choice = input("\nВведите ID категорий через запятую (например '1, 4') [1]: ").strip() or "1"
        if raw_choice in ("+", "new", "n", "создать"):
            cat_name = prompt_non_empty("Название новой категории (например, 'Боевики')")
            from backend.routes.movies import get_or_create_category
            from backend.schemas import slugify
            cat_slug = slugify(cat_name)
            icon_in = input("URL/путь иконки (Enter для дефолтной): ").strip() or None
            icon_clean = process_icon_file(icon_in, cat_slug)
            new_cat, created = get_or_create_category(db, cat_name, slug=cat_slug, icon_path=icon_clean)
            if created:
                print(f"  [+] Создана категория: '{new_cat.name}' (ID: {new_cat.id}) [иконка: {new_cat.icon_url}]")
            else:
                print(f"  [!] Категория '{new_cat.name}' уже существовала в базе (ID: {new_cat.id}) [иконка: {new_cat.icon_url}]")
            return [new_cat]

        ids = parse_category_ids(raw_choice)
        selected = [cats_dict[cid] for cid in ids if cid in cats_dict]
        if selected:
            cat_titles = ", ".join(c.name for c in selected)
            print(f"  [OK] Закреплено категорий: {len(selected)} ({cat_titles})")
            return selected

        print("  [!] Не удалось распознать указанные ID. Повторите ввод.")


def interactive_add_movie():
    """Пошаговый мастер добавления фильма."""
    init_db()
    db = SessionLocal()
    try:
        print("\n" + "=" * 70)
        print("         МАСТЕР ДОБАВЛЕНИЯ НОВОГО ФИЛЬМА В КИНОХОСТИНГ")
        print("=" * 70)

        # ----------------------------------------------------------------------
        # ШАГ 1. Генерация PNR
        # ----------------------------------------------------------------------
        print("\n[Шаг 1/6] ГЕНЕРАЦИЯ УНИКАЛЬНОГО PNR")
        for _ in range(100):
            auto_pnr = generate_pnr(PNR_LENGTH)
            if not db.query(Movie.id).filter(Movie.pnr == auto_pnr).first():
                break

        print(f"Сгенерирован уникальный PNR: \033[1;32m{auto_pnr}\033[0m")
        pnr_choice = input(
            f"Использовать этот PNR? (Enter для '{auto_pnr}' или введите свой): "
        ).strip().upper()

        if not pnr_choice:
            pnr = auto_pnr
        else:
            if not is_valid_pnr(pnr_choice):
                print(f"  [X] Ошибка: PNR должен состоять ровно из 6 символов ({PNR_ALPHABET})")
                return
            if db.query(Movie.id).filter(Movie.pnr == pnr_choice).first():
                print(f"  [X] Ошибка: фильм с PNR '{pnr_choice}' уже существует в БД!")
                return
            pnr = pnr_choice

        print(f"  [OK] Закреплен PNR: \033[1;32m{pnr}\033[0m")

        # ----------------------------------------------------------------------
        # ШАГ 2. Выбор исходного видеофайла
        # ----------------------------------------------------------------------
        print("\n[Шаг 2/6] ВЫБОР ИСХОДНОГО ВИДЕОФАЙЛА")
        while True:
            raw_video_path = input("Укажите путь к видеофайлу (или перетащите файл сюда): ").strip()
            clean_vpath = clean_input_path(raw_video_path)
            source_video = Path(clean_vpath).expanduser().resolve()

            if not clean_vpath:
                print("  [!] Путь не может быть пустым.")
                continue
            if not source_video.is_file():
                print(f"  [X] Файл не найден: {source_video}")
                retry = input("  Попробовать снова? (y/n) [y]: ").strip().lower()
                if retry in ("n", "no", "н", "нет"):
                    print("  Отмена добавления фильма.")
                    return
                continue
            break

        # ----------------------------------------------------------------------
        # ШАГ 3. Автоматический парсинг метаданных видео
        # ----------------------------------------------------------------------
        print("\n[Шаг 3/6] АВТОМАТИЧЕСКИЙ ПАРСИНГ МЕТАДАННЫХ ВИДЕО")
        try:
            meta = extract_video_metadata(source_video)
            print(f"  [+] Видео успешно распознано (движок: {meta['backend']}):")
            print(f"      - Разрешение кадра: {meta['width']}x{meta['height']}")
            print(f"      - Качество:         \033[1;33m{meta['quality_label']}\033[0m")
            print(f"      - Длительность:     \033[1;32m{meta['duration_formatted']}\033[0m ({meta['duration_seconds']} сек)")
            print(f"      - Размер файла:     {meta['file_size_bytes'] / (1024*1024):.1f} МБ")
            duration = meta["duration_formatted"]
            quality = meta["quality_label"]
        except Exception as e:
            print(f"  [!] Предупреждение парсера: {e}")
            print("  Ввод параметров вручную:")
            duration = prompt_non_empty("Длительность (например, '2 ч 15 мин' или '45 мин')", default="120 мин")
            quality = prompt_non_empty("Качество (например, 'FHD', '720p HD', '4K')", default="FHD")

        duration = normalize_duration_str(duration)
        quality = normalize_quality_str(quality)

        # ----------------------------------------------------------------------
        # ШАГ 4. Перемещение и переименование видеофайла в media/video/<PNR>.mp4
        # ----------------------------------------------------------------------
        print(f"\n[Шаг 4/6] ПЕРЕМЕЩЕНИЕ ВИДЕОФАЙЛА В <PNR>.mp4")
        VIDEO_STORAGE_DIR.mkdir(parents=True, exist_ok=True)
        dest_video = VIDEO_STORAGE_DIR / f"{pnr}.mp4"

        if source_video.resolve() != dest_video.resolve():
            print(f"  Перемещение: {source_video.name} -> media/video/{pnr}.mp4 ...")
            try:
                shutil.move(str(source_video), str(dest_video))
                print(f"  [OK] Файл успешно перемещен в: {dest_video}")
            except Exception as e:
                print(f"  [!] Ошибка перемещения ({e}). Выполняем копирование...")
                shutil.copy2(str(source_video), str(dest_video))
                print(f"  [OK] Файл успешно скопирован в: {dest_video}")
        else:
            print(f"  [OK] Файл уже находится в целевой директории: {dest_video}")

        movie_page_url = f"/movie/video/{pnr}.mp4"

        # ----------------------------------------------------------------------
        # ШАГ 5. Ручной ввод оставшихся данных (название, описание, баннеры, категория, слайдер)
        # ----------------------------------------------------------------------
        print("\n[Шаг 5/6] РУЧНОЙ ВВОД ОСТАВШИХСЯ ДАННЫХ")
        # Предлагаем имя файла без расширения как подсказку для названия
        default_title = source_video.stem.replace(".", " ").replace("_", " ").title()
        title = prompt_non_empty("Название фильма (title)", default=default_title)
        description = prompt_non_empty("Описание фильма (description)")
        plot_input = input("Сюжет фильма (plot) [Enter для пропуска или если совпадает с описанием]: ").strip()
        plot = plot_input if plot_input else None

        print("\nМедиафайлы оформления (постер, промо-баннеры, логотип, трейлер):")
        raw_poster = prompt_non_empty(
            "Путь/файл постера (~2:3, верт.)",
            default="/images/error_items/error_items-img/bochflix-test-img-2.jpg",
        )
        poster_url = process_media_file(raw_poster, "posters", pnr, "poster", default_ext=".webp")

        raw_desktop = prompt_non_empty(
            "Путь/файл баннера для Desktop 16:9",
            default="/images/error_items/error_items-img/bochflix-test-img.png",
        )
        banner_desktop_url = process_media_file(raw_desktop, "banners", pnr, "desktop", default_ext=".webp")

        raw_mobile = prompt_non_empty(
            "Путь/файл баннера для Mobile 1.2:1 (~6:5)",
            default="/images/error_items/error_items-img/bochflix-test-img-3.jpg",
        )
        banner_mobile_url = process_media_file(raw_mobile, "banners", pnr, "mobile", default_ext=".webp")

        # Логотип фильма (паттерн <PNR>_logo.<ext> в media/logos/)
        raw_logo = input("Путь к файлу логотипа фильма (или перетащите файл) [Enter для пропуска]: ").strip()
        logo_url = process_media_file(raw_logo, "logos", pnr, "logo", default_ext=".webp")

        # Трейлер фильма (паттерн <PNR>_trailer.<ext> в media/trailers/)
        raw_trailer = input("Путь к видеофайлу трейлера (или перетащите файл) [Enter для пропуска]: ").strip()
        trailer_url = process_media_file(raw_trailer, "trailers", pnr, "trailer", default_ext=".mp4")

        # Выбор категорий (Many-to-Many)
        selected_categories = select_categories_interactive(db)
        category_ids = [c.id for c in selected_categories]
        category_names = ", ".join(c.name for c in selected_categories)
        primary_cat_id = category_ids[0] if category_ids else None

        # Флаг показа в главном промо-слайдере
        hero_choice = input("\nПоказывать в главном промо-слайдере (is_hero_banner)? (y/n) [n]: ").strip().lower()
        is_hero_banner = hero_choice in ("y", "yes", "д", "да", "1", "+")

        # Единая категория / статус фильма (category_tag)
        has_new_pop = any(c.slug == "new-popular" for c in selected_categories)
        tag_default = "4" if has_new_pop else "1"
        print("\n--- СТАТУС / КАТЕГОРИЯ ФИЛЬМА (category_tag) ---")
        print("  1) Обычный фильм (none)")
        print("  2) Новинка (new)")
        print("  3) Популярное (popular)")
        print("  4) Новое и популярное (new_popular)")
        tag_choice = input(f"Выберите статус (1-4) [{tag_default}]: ").strip() or tag_default
        tag_map = {
            "1": "none",
            "2": "new",
            "3": "popular",
            "4": "new_popular",
            "none": "none",
            "обычный": "none",
            "new": "new",
            "новинка": "new",
            "новая": "new",
            "popular": "popular",
            "популярное": "popular",
            "популярная": "popular",
            "new_popular": "new_popular",
            "обе": "new_popular",
            "новое и популярное": "new_popular",
        }
        category_tag = tag_map.get(tag_choice.lower(), "none")

        # Опциональные поля
        rating_input = input("\nРейтинг фильма (например, 8.5) [Enter для пропуска]: ").strip()
        rating = float(rating_input) if rating_input else None

        # ----------------------------------------------------------------------
        # ШАГ 6. Предпоказ и сохранение в БД
        # ----------------------------------------------------------------------
        print("\n" + "=" * 74)
        print("                  ПРЕДПРОСМОТР КАРТОЧКИ ФИЛЬМА")
        print("=" * 74)
        print(f" PNR:                     \033[1;32m{pnr}\033[0m")
        print(f" Название:                \033[1m{title}\033[0m")
        print(f" Категории (Many-to-Many): \033[1;34m{category_names}\033[0m (IDs: {category_ids})")
        print(f" В промо-слайдере:        \033[1m{'ДА (is_hero_banner = True)' if is_hero_banner else 'НЕТ'}\033[0m")
        print(f" Статус (category_tag):   \033[1;33m{category_tag}\033[0m")
        print(f" Длительность:            \033[1;32m{duration}\033[0m")
        print(f" Качество/Разрешение:     \033[1;33m{quality}\033[0m")
        print(f" Описание:                {description}")
        print(f" Сюжет:                   {plot or '— не указан —'}")
        print("-" * 74)
        print(f" Видеофайл (Nginx):       {movie_page_url}  (media/video/{pnr}.mp4)")
        print(f" Постер (2:3):            {poster_url}")
        print(f" Баннер Desktop (16:9):   {banner_desktop_url}")
        print(f" Баннер Mobile (1.2:1):   {banner_mobile_url}")
        print(f" Логотип фильма:          {logo_url or '— не указан (будет текстовый заголовок) —'}")
        print(f" Трейлер фильма:          {trailer_url or '— не указан —'}")
        print("-" * 74)
        print(f" Рейтинг:                 {rating if rating is not None else 'NULL'}")
        print("=" * 74)

        confirm = input("\nСохранить фильм в БД? (y/n) [y]: ").strip().lower()
        if confirm in ("y", "yes", "д", "да", ""):
            # ------------------------------------------------------------------
            # Автоматическая проверка и склейка (переформирование) видео перед БД
            # ------------------------------------------------------------------
            video_ready = check_and_remux_video(dest_video)
            if not video_ready:
                print("\n\033[1;31m[-] ОШИБКА: Запись фильма в базу данных отменена из-за сбоя обработки видеофайла!\033[0m\n")
                return

            # Проверяем локальный трейлер при наличии
            if trailer_url and trailer_url.startswith("/media/trailers/"):
                local_trailer = BASE_DIR / trailer_url.lstrip("/")
                if local_trailer.is_file() and local_trailer.suffix.lower() == ".mp4":
                    check_and_remux_video(local_trailer)

            category_ids_str = ",".join(str(c.id) for c in selected_categories)
            new_movie = Movie(
                pnr=pnr,
                title=title,
                description=description,
                plot=plot,
                duration=duration,
                quality=quality,
                poster_url=poster_url,
                banner=banner_desktop_url,
                mobile_poster=banner_mobile_url,
                banner_desktop_url=banner_desktop_url,
                banner_mobile_url=banner_mobile_url,
                movie_page_url=movie_page_url,
                category_ids=category_ids_str,
                is_hero_banner=is_hero_banner,
                category_tag=category_tag,
                rating=rating,
                logo_url=logo_url,
                trailer=trailer_url,
                trailer_url=trailer_url,
            )
            db.add(new_movie)
            db.commit()
            db.refresh(new_movie)
            print(f"\n\033[1;32m[+] УСПЕШНО!\033[0m Фильм '{title}' сохранен в базу с PNR: \033[1;32m{new_movie.pnr}\033[0m!\n")
        else:
            print("\n[-] Сохранение отменено. Запись НЕ была добавлена в базу данных.\n")

    finally:
        db.close()


def list_movies():
    """Выводит список всех фильмов из базы данных с категориями, статусом промо-слайдера, логотипом и трейлером."""
    init_db()
    db = SessionLocal()
    try:
        movies = db.query(Movie).order_by(Movie.id.asc()).all()
        if not movies:
            print("\n[!] База данных пуста. Фильмы еще не добавлены.")
            return

        cats_lookup = {c.id: c.name for c in db.query(Category).all()}

        print(f"\nВсего фильмов в БД: {len(movies)}")
        print("-" * 140)
        print(f"{'ID':<4} | {'PNR':<8} | {'КАТЕГОРИИ':<20} | {'СЛАЙДЕР':<8} | {'СТАТУС':<12} | {'КАЧЕСТВО':<14} | {'ЛОГО':<6} | {'ТРЕЙЛЕР':<8} | {'НАЗВАНИЕ'}")
        print("-" * 140)
        for m in movies:
            cat_ids = m.parsed_category_ids
            cats = ", ".join(cats_lookup[cid] for cid in cat_ids if cid in cats_lookup) if cat_ids else "— БЕЗ КАТ. —"
            hero = "ДА" if m.is_hero_banner else "нет"
            status_tag = m.category_tag or "none"
            has_logo = "ДА" if m.logo_url else "нет"
            has_trailer = "ДА" if m.trailer else "нет"
            print(f"{m.id:<4} | {m.pnr:<8} | {cats[:18]:<20} | {hero:<8} | {status_tag:<12} | {m.quality[:12]:<14} | {has_logo:<6} | {has_trailer:<8} | {m.title}")
        print("-" * 140 + "\n")
    finally:
        db.close()


def list_categories():
    """Выводит список всех категорий и число фильмов в них."""
    init_db()
    db = SessionLocal()
    try:
        categories = db.query(Category).order_by(Category.id.asc()).all()
        movies = db.query(Movie).all()

        counts = {}
        for m in movies:
            for cid in m.parsed_category_ids:
                counts[cid] = counts.get(cid, 0) + 1

        print(f"\nВсего категорий: {len(categories)}")
        print("-" * 55)
        print(f"{'ID':<4} | {'НАЗВАНИЕ':<20} | {'SLUG':<16} | {'ФИЛЬМОВ'}")
        print("-" * 55)
        for c in categories:
            cnt = counts.get(c.id, 0)
            print(f"{c.id:<4} | {c.name[:18]:<20} | {(c.slug or '')[:14]:<16} | {cnt}")
        print("-" * 55 + "\n")
    finally:
        db.close()


def show_movie(pnr: str):
    """Показывает подробные данные одного фильма по PNR, включая Nginx-пути к медиафайлам."""
    init_db()
    db = SessionLocal()
    try:
        clean_pnr = pnr.strip().upper()
        movie = db.query(Movie).filter(Movie.pnr == clean_pnr).first()
        if not movie:
            print(f"\n[X] Фильм с PNR '{clean_pnr}' не найден в БД.\n")
            return

        cats_lookup = {c.id: c for c in db.query(Category).all()}
        data = movie.to_dict(cats_lookup)

        print("\n" + "=" * 74)
        print(f" ДЕТАЛИ ФИЛЬМА [{movie.pnr}] — \033[1m{movie.title}\033[0m")
        print("=" * 74)
        print(f" ID:                     {movie.id}")
        print(f" PNR:                    \033[1;32m{movie.pnr}\033[0m")
        print(f" Название:               {movie.title}")
        print(f" Длительность:           {movie.duration}")
        print(f" Качество/Разрешение:    {movie.quality}")
        print(f" Рейтинг:                {movie.rating if movie.rating is not None else 'NULL'}")
        print(f" Статус (category_tag):  \033[1;33m{movie.category_tag}\033[0m")
        print(f" В промо-слайдере:       {'ДА (is_hero_banner = True)' if movie.is_hero_banner else 'нет'}")
        print(f" Категории:              {', '.join(data.get('category_names') or [])} (IDs: {movie.parsed_category_ids})")
        print("-" * 74)
        print(f" Описание:               {movie.description}")
        print(f" Сюжет (plot):           {movie.plot or '— совпадает с описанием / не указан —'}")
        print("-" * 74)
        print(" Медиафайлы (Nginx веб-пути):")
        print(f"  Видеофайл:             {movie.movie_page_url}")
        print(f"  Постер (2:3):          {movie.poster_url}")
        print(f"  Баннер Desktop:        {movie.banner}")
        print(f"  Баннер Mobile:         {movie.mobile_poster}")
        print(f"  Логотип:               {movie.logo_url or '— не указан —'}")
        print(f"  Трейлер:               {movie.trailer or '— не указан —'}")
        print("=" * 74 + "\n")
    finally:
        db.close()


def update_movie_media_interactive(pnr: Optional[str] = None):
    """Интерактивное обновление/добавление логотипа, трейлера или постеров для существующего фильма."""
    init_db()
    db = SessionLocal()
    try:
        if not pnr:
            pnr = input("Введите 6-значный PNR фильма для редактирования: ").strip().upper()
        clean_pnr = pnr.strip().upper()
        movie = db.query(Movie).filter(Movie.pnr == clean_pnr).first()
        if not movie:
            print(f"\n[X] Фильм с PNR '{clean_pnr}' не найден в БД.\n")
            return

        print("\n" + "=" * 74)
        print(f" РЕДАКТИРОВАНИЕ МЕДИАФАЙЛОВ ДЛЯ: \033[1m{movie.title}\033[0m [{movie.pnr}]")
        print("=" * 74)
        print(f"  Текущий логотип:  {movie.logo_url or '— отсутствует —'}")
        print(f"  Текущий трейлер:  {movie.trailer or '— отсутствует —'}")
        print(f"  Текущий постер:   {movie.poster_url or '— отсутствует —'}")
        print(f"  Десктоп баннер:   {movie.banner or '— отсутствует —'}")
        print(f"  Мобильный баннер: {movie.mobile_poster or '— отсутствует —'}")
        print("-" * 74)
        print("  (Оставьте поле пустым [Enter], чтобы сохранить текущее значение)")

        new_logo_raw = input("\nНовый файл логотипа (<PNR>_logo) [Enter для пропуска]: ").strip()
        if new_logo_raw:
            movie.logo_url = process_media_file(new_logo_raw, "logos", movie.pnr, "logo", default_ext=".webp")

        new_trailer_raw = input("Новый файл трейлера (<PNR>_trailer) [Enter для пропуска]: ").strip()
        if new_trailer_raw:
            new_tr = process_media_file(new_trailer_raw, "trailers", movie.pnr, "trailer", default_ext=".mp4")
            movie.trailer = new_tr
            movie.trailer_url = new_tr

        new_poster_raw = input("Новый файл постера (<PNR>_poster) [Enter для пропуска]: ").strip()
        if new_poster_raw:
            movie.poster_url = process_media_file(new_poster_raw, "posters", movie.pnr, "poster", default_ext=".webp")

        new_desk_raw = input("Новый баннер Desktop (<PNR>_desktop) [Enter для пропуска]: ").strip()
        if new_desk_raw:
            new_b = process_media_file(new_desk_raw, "banners", movie.pnr, "desktop", default_ext=".webp")
            movie.banner = new_b
            movie.banner_desktop_url = new_b

        new_mob_raw = input("Новый баннер Mobile (<PNR>_mobile) [Enter для пропуска]: ").strip()
        if new_mob_raw:
            new_mb = process_media_file(new_mob_raw, "banners", movie.pnr, "mobile", default_ext=".webp")
            movie.mobile_poster = new_mb
            movie.banner_mobile_url = new_mb

        db.commit()
        db.refresh(movie)
        print(f"\n\033[1;32m[+] УСПЕШНО!\033[0m Медиафайлы фильма [{movie.pnr}] обновлены в БД!\n")
    finally:
        db.close()


def delete_movie_by_pnr(pnr: str):
    """Удаляет фильм из базы данных по PNR с подтверждением и опциональным удалением связанных медиафайлов."""
    init_db()
    db = SessionLocal()
    try:
        clean_pnr = pnr.strip().upper()
        movie = db.query(Movie).filter(Movie.pnr == clean_pnr).first()
        if not movie:
            print(f"\n[X] Фильм с PNR '{clean_pnr}' не найден в БД.\n")
            return

        confirm = input(f"Удалить фильм '{movie.title}' (PNR: {clean_pnr}) из базы данных? (y/n): ").strip().lower()
        if confirm in ("y", "yes", "д", "да"):
            db.delete(movie)
            db.commit()
            print(f"\n[+] Фильм '{movie.title}' (PNR: {clean_pnr}) успешно удален из базы.")

            del_files = input("Удалить связанные медиафайлы с диска (видео, постер, баннеры, логотип, трейлер)? (y/n) [n]: ").strip().lower()
            if del_files in ("y", "yes", "д", "да"):
                deleted_count = 0
                for subdir in ("video", "posters", "banners", "logos", "trailers"):
                    folder = BASE_DIR / "media" / subdir
                    if folder.is_dir():
                        for f in folder.glob(f"{clean_pnr}*"):
                            try:
                                f.unlink()
                                print(f"  [-] Удален файл: media/{subdir}/{f.name}")
                                deleted_count += 1
                            except Exception as e:
                                print(f"  [!] Не удалось удалить {f}: {e}")
                print(f"  Удалено связанных файлов: {deleted_count}\n")
            else:
                print("  Медиафайлы на диске сохранены.\n")
        else:
            print("\n[-] Удаление отменено.\n")
    finally:
        db.close()


def manage_category_icon():
    """Интерактивное назначение/изменение иконки для категории."""
    init_db()
    db = SessionLocal()
    try:
        categories = db.query(Category).order_by(Category.id.asc()).all()
        if not categories:
            print("\n[!] Категории не найдены в базе данных.")
            return

        print("\n" + "=" * 70)
        print("          НАСТРОЙКА ИКОНОК КАТЕГОРИЙ КАТАЛОГА")
        print("=" * 70)
        for cat in categories:
            icon_status = cat.icon_path if cat.icon_path else f"{cat.icon_url} (дефолт)"
            print(f"  {cat.id:<2}) {cat.name:<18} (slug: {cat.slug:<14}) -> [{icon_status}]")

        print("\nПодсказка:")
        print("  - Можно перетащить файл иконки (.svg, .png) сюда мышкой из Finder")
        print("  - Можно ввести локальный путь к файлу (например /Users/.../icon.svg)")
        print("  - Можно ввести имя стандартной иконки (catalog.svg, popular.svg, favorites.svg и т.д.)")
        print("  - Нажмите Enter или введите 'default' для сброса на дефолтную иконку")

        cat_id_input = input("\nВведите ID категории для изменения иконки (или 'q' для выхода): ").strip()
        if cat_id_input.lower() in ("q", "quit", "exit", ""):
            return
        if not cat_id_input.isdigit():
            print("  [!] Некорректный ID категории.")
            return

        target_cat = db.query(Category).filter(Category.id == int(cat_id_input)).first()
        if not target_cat:
            print(f"  [X] Категория с ID {cat_id_input} не найдена в базе данных.")
            return

        raw_icon = input(f"Путь к иконке для '{target_cat.name}' [Enter для дефолтной]: ").strip()
        if not raw_icon or raw_icon.lower() in ("default", "дефолт", "none", "null"):
            target_cat.icon_path = None
            db.commit()
            print(f"\n  [OK] Для категории '{target_cat.name}' установлена дефолтная иконка ({target_cat.icon_url})\n")
            return

        clean_icon_url = process_icon_file(raw_icon, target_cat.slug)
        target_cat.icon_path = clean_icon_url
        db.commit()
        db.refresh(target_cat)
        print(f"\n  \033[1;32m[+] УСПЕШНО!\033[0m Для категории '{target_cat.name}' закреплена иконка:")
        print(f"      Публичный URL: \033[1;32m{target_cat.icon_url}\033[0m")
        print(f"      Сохранено в БД: {target_cat.icon_path}\n")
    finally:
        db.close()


def main_interactive_menu():
    """Главное интерактивное меню."""
    print_banner()
    while True:
        print("Выберите действие:")
        print("  1) Добавить новый фильм (пошаговый мастер: PNR -> видео -> автопарсинг -> перемещение -> метаданные)")
        print("  2) Показать список всех фильмов в БД")
        print("  3) Показать список категорий")
        print("  4) Просмотреть карточку фильма по PNR")
        print("  5) Обновить медиафайлы фильма (логотип / трейлер / постеры / баннеры) по PNR")
        print("  6) Удалить фильм по PNR (с опцией очистки файлов с диска)")
        print("  7) Настроить / изменить иконку категории")
        print("  8) Инициализировать / проверить таблицы БД и выполнить миграцию")
        print("  0) Выход")

        try:
            choice = input("\nВаш выбор: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nВыход.")
            break

        if choice == "1":
            interactive_add_movie()
        elif choice == "2":
            list_movies()
        elif choice == "3":
            list_categories()
        elif choice == "4":
            pnr = input("Введите 6-значный PNR фильма: ").strip()
            if pnr:
                show_movie(pnr)
        elif choice == "5":
            update_movie_media_interactive()
        elif choice == "6":
            pnr = input("Введите PNR фильма для удаления: ").strip()
            if pnr:
                delete_movie_by_pnr(pnr)
        elif choice == "7":
            manage_category_icon()
        elif choice == "8":
            init_db()
            print("\n[+] Таблицы базы данных и миграции успешно проверены.\n")
        elif choice in ("0", "q", "exit"):
            print("Работа завершена.")
            break
        else:
            print("  [!] Некорректный пункт меню. Повторите ввод.")


def main():
    parser = argparse.ArgumentParser(
        description="CLI-утилита для управления и наполнения базы данных кинохостинга Bochflix"
    )
    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("add", help="Интерактивно добавить фильм (с автопарсингом видео)")
    subparsers.add_parser("list", help="Показать все фильмы в БД")
    subparsers.add_parser("categories", help="Показать все категории")
    subparsers.add_parser("icon", help="Настроить / изменить иконку категории")
    subparsers.add_parser("init", help="Инициализировать таблицы БД и выполнить миграцию")

    show_parser = subparsers.add_parser("show", help="Показать фильм по PNR")
    show_parser.add_argument("pnr", type=str, help="6-значный PNR фильма")

    update_parser = subparsers.add_parser("update", help="Обновить медиаданные фильма (логотип / трейлер / постеры)")
    update_parser.add_argument("pnr", type=str, nargs="?", default=None, help="6-значный PNR фильма")

    delete_parser = subparsers.add_parser("delete", help="Удалить фильм по PNR")
    delete_parser.add_argument("pnr", type=str, help="6-значный PNR фильма")

    args = parser.parse_args()

    if args.command == "add":
        interactive_add_movie()
    elif args.command == "list":
        list_movies()
    elif args.command == "categories":
        list_categories()
    elif args.command == "icon":
        manage_category_icon()
    elif args.command == "init":
        init_db()
        print("[+] База данных успешно инициализирована.")
    elif args.command == "show":
        show_movie(args.pnr)
    elif args.command == "update":
        update_movie_media_interactive(args.pnr)
    elif args.command == "delete":
        delete_movie_by_pnr(args.pnr)
    else:
        main_interactive_menu()


if __name__ == "__main__":
    main()
