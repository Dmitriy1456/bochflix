/**
 * ==============================================================================
 * BOCHFLIX — CATALOG SCRIPT (catalog.js)
 * ==============================================================================
 * 
 * Логика страницы каталога:
 * 1. Два режима работы:
 *    - Режим 1: Общий каталог жанров (сетка плиток категорий со Spotlight-эффектом).
 *    - Режим 2: Конкретный жанр (адаптивная сетка фильмов выбранной категории без скроллов).
 * 2. Обработка иконок-заглушек:
 *    - Если иконка указана — подгружается она.
 *    - Если icon_path/icon_url равен null, пуст или дает сбой — подставляется bochflix_mini_icon.svg.
 * 3. Навигация:
 *    - Поддержка истории браузера (popstate, pushState) и кнопки «Назад».
 *    - Переход между режимами без лишней перезагрузки страницы.
 * 4. Интерактивные возможности:
 *    - Добавление фильмов в избранное (синхронизация с localStorage).
 *    - Мгновенный переход к просмотру видео или подробной странице фильма.
 *    - Spotlight-подсветка карточек категорий, следующая за курсором мыши.
 *    - Плавное скрытие шапки при вертикальном скролле.
 */

(function () {
    'use strict';

    // ==========================================================================
    // 1. КОНФИГУРАЦИЯ И СЕТЕВЫЕ ПУТИ
    // ==========================================================================

    const CONFIG = {
        DEFAULT_GENRE_ICON: '../IMAGES/icons/bochflix_mini_icon.svg',
        DEFAULT_CATALOG_ICON: '../IMAGES/icons/catalog_line.svg',
        DEFAULT_POSTER: '../IMAGES/error_items/error_items-img/bochflix-test-img-2.jpg',
        FAVORITES_STORAGE_KEY: 'bochflix_favorites',
    };

    function getApiBaseUrl() {
        if (window.BOCHFLIX_API_URL) {
            return window.BOCHFLIX_API_URL.replace(/\/+$/, '');
        }
        if (window.location.protocol.startsWith('http')) {
            if (['8080', '80', '443', ''].includes(window.location.port)) {
                return '';
            }
            const hostname = window.location.hostname || '127.0.0.1';
            return `http://${hostname}:8000`;
        }
        return 'http://127.0.0.1:8000';
    }

    function resolveUrl(url) {
        if (!url) return '';
        if (/^(https?:)?\/\//i.test(url) || url.startsWith('data:') || url.startsWith('..')) {
            return url;
        }
        const cleanPath = url.startsWith('/') ? url : `/${url}`;
        const base = getApiBaseUrl();
        if (!base) {
            return cleanPath;
        }
        return `${base}${cleanPath}`;
    }

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Обработка и нормализация иконки жанра.
     * Если путь равен null, пуст, "null", "undefined" — возвращает дефолтную иконку-заглушку.
     */
    function resolveCategoryIcon(iconUrlOrPath) {
        if (!iconUrlOrPath) return CONFIG.DEFAULT_GENRE_ICON;
        const s = String(iconUrlOrPath).trim();
        if (!s || s === 'null' || s === 'undefined' || s === 'None') {
            return CONFIG.DEFAULT_GENRE_ICON;
        }
        if (s.startsWith('NULL')) {
            const cleaned = s.replace(/^NULL/, '');
            if (cleaned.includes('/icons/')) {
                const iconName = cleaned.split('/icons/').pop();
                return resolveUrl(`/images/icons/${iconName}`);
            }
        }
        return resolveUrl(s);
    }

    // ==========================================================================
    // 2. ИЗБРАННОЕ (LOCALSTORAGE)
    // ==========================================================================

    function getFavorites() {
        try {
            return JSON.parse(localStorage.getItem(CONFIG.FAVORITES_STORAGE_KEY) || '[]');
        } catch (_) {
            return [];
        }
    }

    function setFavorites(arr) {
        try {
            localStorage.setItem(CONFIG.FAVORITES_STORAGE_KEY, JSON.stringify(arr));
        } catch (_) {}
    }

    function isMovieInFavorites(pnr) {
        if (!pnr) return false;
        return getFavorites().includes(pnr);
    }

    function toggleFavorite(pnr, buttonEl) {
        if (!pnr) return;
        const favs = getFavorites();
        const idx = favs.indexOf(pnr);
        let isNowFav = false;
        if (idx >= 0) {
            favs.splice(idx, 1);
            isNowFav = false;
        } else {
            favs.push(pnr);
            isNowFav = true;
        }
        setFavorites(favs);

        if (buttonEl) {
            buttonEl.classList.toggle('is-favorite', isNowFav);
        }
        // Синхронизируем все карточки с этим же фильмом на странице
        document.querySelectorAll(`.bochflix-card-item[data-pnr="${pnr}"] .main__card-btn--fav`).forEach(btn => {
            btn.classList.toggle('is-favorite', isNowFav);
        });
    }

    // ==========================================================================
    // 3. СОСТОЯНИЕ И ДАННЫЕ СТРАНИЦЫ
    // ==========================================================================

    let state = {
        categories: [],
        currentMode: 'catalog', // 'catalog' | 'genre'
        currentGenre: null,
    };

    async function fetchCategories() {
        if (state.categories.length > 0) return state.categories;
        const baseUrl = getApiBaseUrl();
        try {
            const res = await fetch(`${baseUrl}/api/catalog/categories?include_empty=false`, {
                headers: { 'Accept': 'application/json' }
            });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) {
                    // Строгая фильтрация: исключаем любые категории без фильмов (movies_count <= 0)
                    const nonEmpties = data.filter(c => {
                        if (c.movies_count !== undefined && c.movies_count <= 0) return false;
                        return true;
                    });
                    if (nonEmpties.length > 0) {
                        state.categories = nonEmpties;
                        return nonEmpties;
                    }
                }
            }
        } catch (e) {
            console.warn('[Catalog] Ошибка загрузки категорий из API:', e);
        }

        // // Запасной локальный список непустых категорий при отсутствии связи с API
        // state.categories = [
        //     { id: 1, name: 'Фильмы', title: 'Фильмы', slug: 'movies', icon_url: '/images/icons/popular_line.svg', movies_count: 4 },
        //     { id: 3, name: 'Мультфильмы', title: 'Мультфильмы', slug: 'cartoons', icon_url: '../IMAGES/icons/bochflix_mini_icon.svg', movies_count: 1 },
        //     { id: 5, name: 'Фантастика', title: 'Фантастика', slug: 'sci-fi', icon_url: '/images/icons/shorts_line.svg', movies_count: 3 },
        //     { id: 6, name: 'Драмы', title: 'Драмы', slug: 'drama', icon_url: '/images/icons/watch-laler_line.svg', movies_count: 3 },
        //     { id: 8, name: 'Приключения', title: 'Приключения', slug: 'priklyucheniya', icon_url: '/images/icons/home.svg', movies_count: 3 },
        // ];
        // return state.categories;
    }

    function findCategory(cats, param) {
        if (!param) return null;
        const p = String(param).trim().toLowerCase();
        return cats.find(c => 
            String(c.id) === p || 
            (c.slug && c.slug.toLowerCase() === p) ||
            (c.title && c.title.toLowerCase() === p) ||
            (c.name && c.name.toLowerCase() === p)
        ) || null;
    }

    async function fetchMoviesByGenre(category) {
        const baseUrl = getApiBaseUrl();
        const query = category.slug 
            ? `category_slug=${encodeURIComponent(category.slug)}` 
            : `category_id=${encodeURIComponent(category.id)}`;

        const res = await fetch(`${baseUrl}/api/movies?${query}&limit=200`, {
            headers: { 'Accept': 'application/json' }
        });
        if (!res.ok) {
            throw new Error(`HTTP_${res.status}`);
        }
        return await res.json();
    }

    // ==========================================================================
    // 4. ОБНОВЛЕНИЕ ШАПКИ СТРАНИЦЫ
    // ==========================================================================

    function updateHeader(title, iconSrc) {
        // Обновляем заголовки (для десктопной и мобильной версий)
        document.querySelectorAll('.category-title, #category-title').forEach(el => {
            el.textContent = title;
        });

        // Обновляем иконки в шапке
        document.querySelectorAll('.header__left--icon, .header__left--icon-mobile').forEach(img => {
            img.src = iconSrc;
            img.onerror = () => {
                img.onerror = null;
                img.src = CONFIG.DEFAULT_GENRE_ICON;
            };
        });
    }

    // ==========================================================================
    // 5. РЕЖИМ 1: ОБЩИЙ КАТАЛОГ ЖАНРОВ
    // ==========================================================================

    function createCategoryTile(cat) {
        const iconUrl = resolveCategoryIcon(cat.icon_url || cat.icon_path);
        const title = cat.title || cat.name || 'Категория';
        const slugOrId = cat.slug || cat.id;

        const tile = document.createElement('a');
        tile.href = `catalog.html?genre=${encodeURIComponent(slugOrId)}`;
        tile.className = 'main__track--item';
        tile.setAttribute('data-genre-id', cat.id);
        tile.setAttribute('data-genre-slug', cat.slug || '');

        tile.innerHTML = `
            <img src="${escapeHtml(iconUrl)}" 
                 alt="${escapeHtml(title)}" 
                 class="main__track--item-img"
                 onerror="this.onerror=null; this.src='${CONFIG.DEFAULT_GENRE_ICON}';">
            <div class="main__track--item-title">${escapeHtml(title)}</div>
        `;

        tile.addEventListener('click', (e) => {
            e.preventDefault();
            navigateToGenre(cat, true);
        });

        return tile;
    }

    async function renderCatalogMode(pushHistory = false) {
        state.currentMode = 'catalog';
        state.currentGenre = null;

        if (pushHistory) {
            history.pushState({ mode: 'catalog' }, '', 'catalog.html');
        }

        document.title = 'Каталог — BOCHFLIX';
        updateHeader('Каталог', CONFIG.DEFAULT_CATALOG_ICON);

        const catView = document.getElementById('categories-view');
        const genreView = document.getElementById('genre-view');
        const track = document.getElementById('categories-track');

        if (catView) catView.style.display = 'flex';
        if (genreView) genreView.style.display = 'none';

        if (track && track.children.length === 0) {
            track.innerHTML = '<div class="main__loader"><div class="main__spinner"></div></div>';
            const categories = await fetchCategories();
            track.innerHTML = '';

            categories.forEach(cat => {
                track.appendChild(createCategoryTile(cat));
            });
        }
    }

    // ==========================================================================
    // 6. РЕЖИМ 2: КОНКРЕТНЫЙ ЖАНР (СЕТКА ФИЛЬМОВ)
    // ==========================================================================

    function createMovieCard(movie) {
        const posterUrl = resolveUrl(movie.poster_url || movie.banner || '');
        const videoUrl = (movie.movie_page_url && movie.movie_page_url.endsWith('.mp4'))
            ? resolveUrl(movie.movie_page_url)
            : resolveUrl(`/movie/video/${movie.pnr}.mp4`);
        const infoUrl = `information.html?id=${encodeURIComponent(movie.id || movie.pnr)}`;

        const isFav = isMovieInFavorites(movie.pnr);
        const favClass = isFav ? ' is-favorite' : '';

        // Список категорий/жанров фильма для вывода внутри карточки (1 в 1 как на главной странице)
        const categoryList = Array.isArray(movie.categories) && movie.categories.length > 0
            ? movie.categories
            : (Array.isArray(movie.category_names) ? movie.category_names.map(name => ({ name, title: name, slug: name })) : []);

        let genresHtml = '';
        if (categoryList.length > 0) {
            const genreItems = categoryList.map(catItem => {
                const name = typeof catItem === 'string' ? catItem : (catItem.title || catItem.name);
                const slugOrId = typeof catItem === 'string' ? catItem : (catItem.slug || catItem.id || name);
                // return `<div class="poster-genre__item" data-genre="${escapeHtml(String(slugOrId))}">${escapeHtml(name)}</div>`;
            }).join('');
            // genresHtml = `<div class="main__item-poster-genre">${genreItems}</div>`;
        } else if (movie.categories_str) {
            const rawItems = movie.categories_str.split(',').map(s => s.trim()).filter(Boolean).map(g => {
                return `<div class="poster-genre__item" data-genre="${escapeHtml(g)}">${escapeHtml(g)}</div>`;
            }).join('');
            if (rawItems.length > 0) {
                // genresHtml = `<div class="main__item-poster-genre">${rawItems}</div>`;
            }
        }

        const card = document.createElement('a');
        card.href = infoUrl;
        card.className = 'main__standart-card--item bochflix-card-item';
        card.setAttribute('data-id', movie.id || '');
        card.setAttribute('data-pnr', movie.pnr);

        card.innerHTML = `
            <img class="bochflix-card-poster" 
                 src="${escapeHtml(posterUrl)}" 
                 alt="${escapeHtml(movie.title)}" 
                 loading="lazy"
                 onerror="this.onerror=null; this.src='${CONFIG.DEFAULT_POSTER}';">
            <button class="main__card-btn--fav${favClass}" type="button" aria-label="Добавить в избранное" data-action="favorite" title="Добавить в избранное">
                <img src="../IMAGES/icons/favorites_line.svg" alt="" class="main__card-btn--fav-icon">
            </button>
            ${genresHtml}
            <button class="main__card-btn--watch" type="button" data-action="watch">Смотреть</button>
        `;

        card.addEventListener('click', (e) => {
            // Клик по конкретному жанру внутри карточки -> переход в этот жанр в каталоге
            const genreItem = e.target.closest('.poster-genre__item');
            if (genreItem) {
                e.preventDefault();
                e.stopPropagation();
                const targetGenre = genreItem.getAttribute('data-genre') || genreItem.textContent.trim();
                if (targetGenre) {
                    navigateToGenre({ slug: targetGenre, title: genreItem.textContent.trim() }, true);
                }
                return;
            }

            const favBtn = e.target.closest('.main__card-btn--fav, [data-action="favorite"]');
            if (favBtn) {
                e.preventDefault();
                e.stopPropagation();
                toggleFavorite(movie.pnr, favBtn);
                return;
            }

            const watchBtn = e.target.closest('.main__card-btn--watch, [data-action="watch"]');
            if (watchBtn) {
                e.preventDefault();
                e.stopPropagation();
                window.location.href = videoUrl;
                return;
            }

            e.preventDefault();
            window.location.href = infoUrl;
        });

        return card;
    }

    async function renderGenreMode(genreParam, pushHistory = false) {
        state.currentMode = 'genre';

        const categories = await fetchCategories();
        let category = findCategory(categories, genreParam);

        if (!category) {
            category = {
                id: null,
                slug: genreParam,
                title: genreParam,
                name: genreParam,
                icon_url: CONFIG.DEFAULT_GENRE_ICON
            };
        }

        state.currentGenre = category;

        const genreTitle = category.title || category.name || 'Жанр';
        const genreIcon = resolveCategoryIcon(category.icon_url || category.icon_path);

        if (pushHistory) {
            const slugOrId = category.slug || category.id || genreParam;
            history.pushState({ mode: 'genre', genre: slugOrId }, '', `catalog.html?genre=${encodeURIComponent(slugOrId)}`);
        }

        document.title = `${genreTitle} — BOCHFLIX`;
        updateHeader(genreTitle, genreIcon);

        const catView = document.getElementById('categories-view');
        const genreView = document.getElementById('genre-view');
        const grid = document.getElementById('genre-movies-grid');

        if (catView) catView.style.display = 'none';
        if (genreView) genreView.style.display = 'flex';

        if (grid) {
            grid.innerHTML = '<div class="main__loader"><div class="main__spinner"></div></div>';
            try {
                const movies = await fetchMoviesByGenre(category);
                grid.innerHTML = '';

                if (!Array.isArray(movies) || movies.length === 0) {
                    grid.innerHTML = `
                        <div class="main__empty-state">
                            <div class="main__empty-icon-wrap">
                                <img src="../IMAGES/icons/info_icon.svg" alt="Пусто" class="main__empty-icon">
                            </div>
                            <div class="main__empty-title">В этой категории пока нет фильмов</div>
                            <div class="main__empty-desc">Фильмы для жанра «${escapeHtml(genreTitle)}» скоро появятся</div>
                            <button type="button" class="main__empty-btn">Вернуться в каталог</button>
                        </div>
                    `;
                    const returnBtn = grid.querySelector('.main__empty-btn');
                    if (returnBtn) {
                        returnBtn.addEventListener('click', () => navigateToCatalog(true));
                    }
                    return;
                }

                movies.forEach(movie => {
                    grid.appendChild(createMovieCard(movie));
                });
            } catch (err) {
                console.warn('[Catalog] Ошибка загрузки фильмов для жанра:', err);
                grid.innerHTML = `
                    <div class="main__empty-state">
                        <div class="main__empty-icon-wrap">
                            <img src="../IMAGES/icons/info_icon.svg" alt="Ошибка" class="main__empty-icon">
                        </div>
                        <div class="main__empty-title">Не удалось загрузить фильмы</div>
                        <div class="main__empty-desc">Проверьте соединение с сервером и повторите попытку</div>
                        <button type="button" class="main__empty-btn">Вернуться в каталог</button>
                    </div>
                `;
                const returnBtn = grid.querySelector('.main__empty-btn');
                if (returnBtn) {
                    returnBtn.addEventListener('click', () => navigateToCatalog(true));
                }
            }
        }
    }

    function navigateToGenre(cat, pushHistory = true) {
        const param = cat.slug || cat.id || cat.title;
        renderGenreMode(param, pushHistory);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function navigateToCatalog(pushHistory = true) {
        renderCatalogMode(pushHistory);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // ==========================================================================
    // 7. МАРШРУТИЗАЦИЯ И ОБРАБОТКА URL (POPSTATE)
    // ==========================================================================

    function checkRoute() {
        const params = new URLSearchParams(window.location.search);
        const genreParam = params.get('genre') || params.get('category') || params.get('id');

        if (genreParam) {
            renderGenreMode(genreParam, false);
        } else {
            renderCatalogMode(false);
        }
    }

    window.addEventListener('popstate', (e) => {
        checkRoute();
    });

    // ==========================================================================
    // 8. НАВИГАЦИЯ (КНОПКА «НАЗАД» И МЕНЮ)
    // ==========================================================================

    function setupNavigation() {
        // Кнопка возврата (стрелка влево): линейный возврат строго на 1 шаг назад по истории переходов
        const backButtons = document.querySelectorAll('.header__left-button, .header__button--mobile');
        backButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                if (window.history.length > 1) {
                    window.history.back();
                } else {
                    window.location.href = 'index.html';
                }
            });
        });

        // Мобильное меню: кнопка «Главная»
        const homeButtons = document.querySelectorAll('.aside__main--mobile');
        homeButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                window.location.href = 'index.html';
            });
        });

        // Мобильное меню: кнопка «Каталог»
        const catalogNavButtons = document.querySelectorAll('.aside__catalog--mobile');
        catalogNavButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                if (state.currentMode === 'genre') {
                    navigateToCatalog(true);
                } else {
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                }
            });
        });
    }

    // ==========================================================================
    // 9. ИНТЕРАКТИВНЫЕ ЭФФЕКТЫ (SPOTLIGHT И СКРОЛЛ ШАПКИ)
    // ==========================================================================

    function setupCardSpotlight() {
        if (!window.matchMedia('(hover: hover)').matches) return;

        const updateCursor = (e, card) => {
            const rect = card.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            card.style.setProperty('--mouse-x', `${x}px`);
            card.style.setProperty('--mouse-y', `${y}px`);
        };

        document.addEventListener('mousemove', (e) => {
            const card = e.target.closest('.main__track--item');
            if (card) {
                updateCursor(e, card);
            }
        }, { passive: true });
    }

    function setupHeaderScroll() {
        const header = document.querySelector('.header');
        if (!header) return;

        const HEADER_H = 80;
        let lastY = 0;

        const getY = () => Math.max(
            window.scrollY,
            document.scrollingElement ? document.scrollingElement.scrollTop : 0,
            document.body.scrollTop,
            0
        );

        const setHidden = (hide) => {
            if (header.classList.contains('header--hidden') === hide) return;
            header.style.transitionDelay = '0s';
            header.classList.toggle('header--hidden', hide);
        };

        header.addEventListener('transitionend', () => {
            header.style.transitionDelay = '';
        });

        window.addEventListener('scroll', () => {
            const y = getY();

            if (y <= HEADER_H) setHidden(false);
            else if (y > lastY) setHidden(true);
            else if (y < lastY) setHidden(false);

            lastY = y;
        }, { passive: true, capture: true });
    }

    // ==========================================================================
    // 10. ИНИЦИАЛИЗАЦИЯ
    // ==========================================================================

    function init() {
        setupNavigation();
        setupCardSpotlight();
        setupHeaderScroll();
        checkRoute();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
