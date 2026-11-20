/**
 * ==============================================================================
 * BOCHFLIX — FRONTEND LOADER MODULE (frontend_loader.js)
 * ==============================================================================
 * 
 * Назначение:
 * 1. Асинхронно запрашивает данные с FastAPI бэкенда (баннеры, плитки каталога, фильмы).
 * 2. Рендерит адаптивный промо-слайдер баннеров (<section class="main__slider">).
 * 3. Рендерит плитки категорий каталога (<section class="main__catalog">)
 *    строго между баннерами и блоком "Новое и популярное".
 *    ИСКЛЮЧЕНИЕ: Категории "Новое" и "Популярное" в плитки НЕ выводятся.
 * 4. Заполняет блок "Новое и популярное" (<section class="main__new-popular">) фильмами.
 * 5. Динамически создает блоки <article class="main__other-article main__standart-card">
 *    внутри <section class="main__other"> для каждой пользовательской категории
 *    с их фильмами (Many-to-Many).
 * 6. Реализует плавную подгрузку порциями по 10 категорий (Lazy Loading / Infinite Scroll)
 *    через IntersectionObserver.
 */

// ==============================================================================
// 1. КОНФИГУРАЦИОННЫЕ КОНСТАНТЫ И СЕЛЕКТОРЫ КЛАССОВ
// ==============================================================================

const SELECTORS = {
    // Слайдер баннеров
    SLIDER_CONTAINER: '.main__slider',
    SLIDER_TRACK: '.main__slider-track',
    SLIDER_ITEM: '.main__slider-item',

    // Плитки каталога (между баннерами и Новым/Популярным)
    CATALOG_TRACK: '.main__catalog-track',

    // Блок "Новое и популярное"
    POPULAR_TRACK: '.main__new-popular .main__standart-card--track',

    // Секция пользовательских категорий
    OTHER_SECTION: '.main__other',

    // Базовые классы элементов
    CLASS_SLIDER_ITEM: 'main__slider-item',
    CLASS_CARD_ITEM: 'main__standart-card--item',
};

const API_CONFIG = {
    BASE_URL: 'http://127.0.0.1:8000',
    BANNERS_ENDPOINT: '/api/banners',
    CATALOG_CATEGORIES_ENDPOINT: '/api/catalog/categories',
    CATEGORIES_PAGINATED_ENDPOINT: '/api/categories',
    MOVIES_ENDPOINT: '/api/movies',
    POPULAR_ENDPOINT: '/api/movies?is_popular=true',
    REQUEST_TIMEOUT: 10000,
    CATEGORIES_BATCH_SIZE: 10,
    DEFAULT_CATEGORY_ICON: '../IMAGES/icons/bochflix_mini_icon.svg',
    DEFAULT_POSTER: '../IMAGES/error_items/error_items-img/bochflix-test-img-2.jpg',
    DEFAULT_BANNER: '../IMAGES/error_items/error_items-img/bochflix-test-img.png',
};

// ==============================================================================
// 2. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==============================================================================

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
 * Проверяет, является ли категория системной («Новое», «Популярное», «Новое и популярное»).
 */
function isPopularCategory(nameOrSlug) {
    if (!nameOrSlug) return false;
    const s = String(nameOrSlug).toLowerCase().trim();
    const banned = [
        'новое',
        'популярное',
        'новое и популярное',
        'новое & популярное',
        'new',
        'popular',
        'new-popular',
        'novoe',
        'populyarnoe'
    ];
    return banned.includes(s);
}

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
    return API_CONFIG.BASE_URL;
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

async function apiFetch(endpoint) {
    const url = `${getApiBaseUrl()}${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_CONFIG.REQUEST_TIMEOUT);

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: controller.signal,
        });
        clearTimeout(timer);

        if (response.status >= 400 && response.status < 500) {
            // Запасной fallback на /api/v1/..., если /api/... недоступен
            if (response.status === 404 && endpoint.startsWith('/api/') && !endpoint.startsWith('/api/v1/')) {
                const fallbackEndpoint = endpoint.replace('/api/', '/api/v1/');
                return await apiFetch(fallbackEndpoint);
            }
            const err = new Error(`HTTP_${response.status}`);
            err.is4xx = true;
            err.status = response.status;
            throw err;
        }

        if (!response.ok) {
            const err = new Error(`HTTP Error ${response.status}: ${response.statusText}`);
            err.status = response.status;
            throw err;
        }
        return await response.json();
    } catch (err) {
        clearTimeout(timer);
        console.warn(`[Bochflix Loader] Запрос к ${url} завершился с ошибкой:`, err.message);
        throw err;
    }
}

/**
 * Подключает плавный drag-скроллинг мышью и клавишами для динамически созданных треков.
 */
function enableTrackDrag(track) {
    if (!track || track.dataset.dragEnabled) return;
    track.dataset.dragEnabled = "true";
    track.setAttribute('tabindex', '0');

    let isDown = false;
    let startX = 0;
    let scrollLeft = 0;

    const setCardsDragging = (isDragging) => {
        const cards = track.querySelectorAll('.main__standart-card--item');
        cards.forEach((card) => {
            card.classList.toggle('is-dragging', isDragging);
        });
    };

    track.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        isDown = true;
        track.classList.add('active');
        startX = e.pageX - track.offsetLeft;
        scrollLeft = track.scrollLeft;
    });

    track.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        e.preventDefault();
        setCardsDragging(true);
        const x = e.pageX - track.offsetLeft;
        const walk = (x - startX) * 1.5;
        track.scrollLeft = scrollLeft - walk;
    });

    const stopDragging = () => {
        if (!isDown) return;
        isDown = false;
        track.classList.remove('active');
        setCardsDragging(false);
    };

    track.addEventListener('mouseup', stopDragging);
    track.addEventListener('mouseleave', stopDragging);

    track.addEventListener('keydown', (e) => {
        const step = 220;
        if (e.key === 'ArrowRight') {
            e.preventDefault();
            track.scrollBy({ left: step, behavior: 'smooth' });
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            track.scrollBy({ left: -step, behavior: 'smooth' });
        }
    });
}

function injectLoaderStyles() {
    if (document.getElementById('bochflix-loader-styles')) return;

    const style = document.createElement('style');
    style.id = 'bochflix-loader-styles';
    style.textContent = `
                /* Карточки слайдера */
        .bochflix-slider-card {
            position: relative;
            display: block !important;
            overflow: hidden;
            text-decoration: none;
            border-radius: 15px;
            user-select: none;
            -webkit-user-drag: none;
            background: #000 !important;
            /* Включаем отслеживание размеров карточки для точного расчета пропорций iframe */
            container-type: size;
        }

        .bochflix-slider-card picture,
        .bochflix-slider-card picture img,
        .bochflix-slider-img {
            display: block !important;
            width: 100% !important;
            height: 100% !important;
            object-fit: cover !important;
            border-radius: inherit;
            pointer-events: none;
            user-select: none;
            -webkit-user-drag: none;
        }

        /* Для обычного тега <video> */
        .bochflix-slider-card video,
        .bochflix-slider-card video.poster-video {
            position: absolute !important;
            top: 0 !important;
            left: 0 !important;
            width: 100% !important;
            height: 100% !important;
            object-fit: cover !important;
            object-position: center center !important;
            display: block !important;
            margin: 0 !important;
            padding: 0 !important;
            border: none !important;
            outline: none !important;
            border-radius: inherit !important;
            pointer-events: none !important;
            z-index: 1 !important;
            transition: opacity 0.4s ease, transform 0.3s ease !important;
        }

        /* Для <iframe> (YouTube, RuTube, VK и др.) */
        .bochflix-slider-card iframe,
        .bochflix-slider-card iframe.poster-video {
            position: absolute !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) !important;
            /* Жестко занимает 100% высоты (длины) карточки */
            height: 100% !important;
            min-height: 100% !important;
            /* Ширина рассчитывается строго как 16:9 от высоты самой карточки */
            width: calc(100cqh * (16 / 9)) !important;
            min-width: 100% !important;
            display: block !important;
            margin: 0 !important;
            padding: 0 !important;
            border: none !important;
            outline: none !important;
            pointer-events: none !important;
            z-index: 1 !important;
            transition: opacity 0.4s ease, transform 0.3s ease !important;
        }

    `;
    document.head.appendChild(style);
}

// ==============================================================================
// 3. ПРОМО-СЛАЙДЕР БАННЕРОВ (<section class="main__slider">)
// ==============================================================================

function createSliderElement(banner) {
    const desktopUrl = resolveUrl(banner.banner_desktop_url || banner.banner);
    const mobileUrl = resolveUrl(banner.banner_mobile_url || banner.mobile_poster || desktopUrl);
    // Прямой редирект на воспроизведение видеофайла фильма
    const movieUrl = banner.movie_page_url || `/movie/video/${banner.pnr}.mp4`;
    const infoUrl = `information.html?id=${encodeURIComponent(banner.id || banner.pnr)}`;
    const videoUrl = banner.trailer ? resolveUrl(banner.trailer) : '';
    
    // Строгая проверка логотипа из БД: если есть - выводим картинку, если нет - аккуратное текстовое название
    const hasLogo = banner.logo_url && typeof banner.logo_url === 'string' && banner.logo_url.trim() !== '' && banner.logo_url !== 'null';
    const logoUrl = hasLogo ? resolveUrl(banner.logo_url.trim()) : null;

    const rating = banner.rating ? Number(banner.rating).toFixed(1) : '7.5';
    const duration = banner.duration || '2 ч';
    const quality = banner.quality || 'FHD';
    const year = banner.year || '2024';
    const genres = Array.isArray(banner.category_names) && banner.category_names.length > 0
        ? banner.category_names.slice(0, 3)
        : ['Фильмы'];

    const genresHtml = genres.map(g => `<div class="poster-genre__item">${escapeHtml(g)}</div>`).join('');

    const logoHtml = logoUrl
        ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(banner.title)}" class="main__item-poster-logo" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='block';"><div class="main__item-poster-logo main__item-poster-logo--text" style="display: none;">${escapeHtml(banner.title)}</div>`
        : `<div class="main__item-poster-logo main__item-poster-logo--text">${escapeHtml(banner.title)}</div>`;

    const card = document.createElement('div');
    card.className = `${SELECTORS.CLASS_SLIDER_ITEM} main__item-poster bochflix-slider-card`;
    card.setAttribute('data-id', banner.id || '');
    card.setAttribute('data-pnr', banner.pnr || '');
    card.setAttribute('data-movie-url', movieUrl);
    card.setAttribute('data-page-url', infoUrl);
    card.setAttribute('data-info-url', infoUrl);
    if (videoUrl) {
        card.setAttribute('data-video', videoUrl);
    }
    // card.setAttribute('title', banner.title);

    card.innerHTML = `
        <picture class="main__item-poster-picture">
            <source media="(max-width: 767px)" srcset="${escapeHtml(mobileUrl)}">
            <img class="main__item-poster-bg bochflix-slider-img" 
                 src="${escapeHtml(desktopUrl)}" 
                 alt="${escapeHtml(banner.title)}" 
                 loading="eager"
                 onerror="this.onerror=null; this.src='${API_CONFIG.DEFAULT_BANNER}';">
        </picture>
        <div class="main__item-poster-overlay"></div>
        <div class="item-poster__wrapper">
            <div class="main__item-poster-brand">
                ${logoHtml}
                <div class="poster-info__item poster-info__item--rating mobile-rating" id="quality">${escapeHtml(rating)}</div>
            </div>
            <div class="main__item-poster-info">
                <div class="poster-info__item poster-info__item--rating desktop-rating" id="quality">${escapeHtml(rating)}</div>
                <div class="poster-info__item poster-info__item--year">${escapeHtml(year)}</div>
                <div class="poster-info__item poster-info__item--duration">${escapeHtml(duration)}</div>
                <div class="poster-info__item poster-info__item--quality">${escapeHtml(quality)}</div>
            </div>
            <div class="main__item-poster-buttons">
                <button class="poster-button__action" type="button" id="btn-act" data-movie-url="${escapeHtml(movieUrl)}" title="Смотреть фильм">
                    <div class="poster-button__icon">
                        <img src="../IMAGES/icons/play_icon.svg" alt="Смотреть" id="poster-button-icon">
                    </div>
                    <div class="poster-button__text">Смотреть</div>
                </button>
                <button class="poster-button__info" type="button" id="btn-info" data-info-url="${escapeHtml(infoUrl)}" title="Информация о фильме">
                    <div class="poster-button__icon">
                        <img src="../IMAGES/icons/info_icon.svg" alt="Подробнее" id="poster-button-icon">
                    </div>
                    <div class="poster-button__text">Подробнее</div>
                </button>
            </div>
        </div>
    `;

    // Клик по жанру в промо-баннере -> прямой переход в каталог
    card.querySelectorAll('.poster-genre__item').forEach((item) => {
        item.style.cursor = 'pointer';
        item.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const genreName = item.textContent.trim();
            window.location.href = `catalog.html?genre=${encodeURIComponent(genreName)}`;
        });
    });

    return card;
}

async function loadAndRenderBanners() {
    const sliderTrack = document.querySelector(SELECTORS.SLIDER_TRACK);
    if (!sliderTrack) return;

    try {
        const banners = await apiFetch(API_CONFIG.BANNERS_ENDPOINT);
        if (!Array.isArray(banners) || banners.length === 0) return;

        const newElements = banners.map(createSliderElement);
        sliderTrack.replaceChildren(...newElements);
        window.dispatchEvent(new Event('resize'));
        console.log(`[Bochflix Loader] Отрисовано баннеров в слайдере: ${newElements.length}`);
    } catch (err) {
        console.error('[Bochflix Loader] Ошибка при загрузке баннеров:', err);
        throw err;
    }
}

// ==============================================================================
// 4. ПЛИТКИ КАТАЛОГА КАТЕГОРИЙ (<section class="main__catalog">)
// ==============================================================================

/**
 * Создает DOM-элемент плитки категории:
 * <a href="#category-${cat.id}" class="main__catalog-item" data-id="${cat.id}">
 *   <img src="${cat.icon_url || '../IMAGES/icons/test-icon.svg'}" alt="${cat.title}" class="main__catalog-item--icon">
 *   <div class="catalog-item--text">${cat.title}</div>
 * </a>
 */
function createCatalogTileElement(cat) {
    const iconUrl = cat.icon_url ? resolveUrl(cat.icon_url) : API_CONFIG.DEFAULT_CATEGORY_ICON;
    const catTitle = cat.title || cat.name || 'Категория';
    const slugOrId = cat.slug || cat.id;
    const targetUrl = `catalog.html?genre=${encodeURIComponent(slugOrId)}`;

    const link = document.createElement('a');
    link.href = targetUrl;
    link.className = 'main__catalog-item';
    link.setAttribute('data-id', cat.id);
    if (cat.slug) link.setAttribute('data-slug', cat.slug);

    // Прямой переход сразу на страницу выбранного жанра в каталоге
    link.addEventListener('click', (e) => {
        e.preventDefault();
        window.location.href = targetUrl;
    });

    link.innerHTML = `
        <img src="${escapeHtml(iconUrl)}" 
             alt="${escapeHtml(catTitle)}" 
             class="main__catalog-item--icon"
             onerror="this.onerror=null; this.src='${API_CONFIG.DEFAULT_CATEGORY_ICON}';">
        <div class="catalog-item--text">${escapeHtml(catTitle)}</div>
    `;

    return link;
}

/**
 * Загружает категории и надежно рендерит их в 2 горизонтальных ряда (.main__catalog-row),
 * гарантируя соблюдение оригинальной верстки и стилей.
 * ИСКЛЮЧЕНИЕ: Категории 'Новое' и 'Популярное' исключаются, пустые категории отфильтровываются!
 */
async function loadAndRenderCatalogTiles() {
    const catalogTrack = document.querySelector(SELECTORS.CATALOG_TRACK);
    if (!catalogTrack) return;

    try {
        const categories = await apiFetch(API_CONFIG.CATALOG_CATEGORIES_ENDPOINT);
        if (!Array.isArray(categories) || categories.length === 0) {
            console.info('[Bochflix Loader] Категории для каталога не найдены.');
            return;
        }

        // ВАЖНОЕ ИСКЛЮЧЕНИЕ: исключаем 'Новое', 'Популярное' и категории с 0 фильмов
        const filtered = categories.filter(c => {
            const name = c.title || c.name || '';
            const slug = c.slug || '';
            if (isPopularCategory(name) || isPopularCategory(slug)) return false;
            if (c.movies_count !== undefined && c.movies_count <= 0) return false;
            return true;
        });

        if (filtered.length === 0) return;

        // Создаем элементы плиток
        const tileElements = filtered.map(createCatalogTileElement);

        // Раскладываем в 2 ряда (.main__catalog-row) согласно стилям style.css
        const row1 = document.createElement('div');
        row1.className = 'main__catalog-row';
        const row2 = document.createElement('div');
        row2.className = 'main__catalog-row';

        const half = Math.ceil(tileElements.length / 2);
        tileElements.forEach((el, index) => {
            if (index < half) {
                row1.appendChild(el);
            } else {
                row2.appendChild(el);
            }
        });

        catalogTrack.replaceChildren(row1, row2);
        console.log(`[Bochflix Loader] Успешно отрисовано ${tileElements.length} плиток каталога в 2 ряда.`);
    } catch (err) {
        console.error('[Bochflix Loader] Ошибка при загрузке плиток каталога:', err);
        throw err;
    }
}

// ==============================================================================
// 5. КАРТОЧКИ ФИЛЬМОВ ДЛЯ ГОРИЗОНТАЛЬНЫХ ТРЕКОВ
// ==============================================================================

function createMovieCardElement(movie, parentTrack) {
    const posterUrl = resolveUrl(movie.poster_url);
    const videoUrl = (movie.movie_page_url && movie.movie_page_url.endsWith('.mp4')) 
        ? movie.movie_page_url 
        : `/movie/video/${movie.pnr}.mp4`;
    const infoUrl = `information.html?id=${encodeURIComponent(movie.id || movie.pnr)}`;

    const link = document.createElement('a');
    link.href = infoUrl;
    link.className = `${SELECTORS.CLASS_CARD_ITEM} bochflix-card-item`;
    link.setAttribute('data-id', movie.id || '');
    link.setAttribute('data-pnr', movie.pnr);
    link.setAttribute('data-movie-url', videoUrl);
    link.setAttribute('data-info-url', infoUrl);
    // link.setAttribute('title', movie.title);

    link.addEventListener('click', (e) => {
        if (link.classList.contains('is-dragging') || (parentTrack && parentTrack.classList.contains('active'))) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        // Если внутри карточки нажата кнопка "Смотреть"
        const watchBtn = e.target.closest('.card-btn--watch, [data-action="watch"], .poster-button__action');
        if (watchBtn) {
            e.preventDefault();
            e.stopPropagation();
            window.location.href = videoUrl;
            return;
        }

        // Обычный клик по карточке — переход на страницу информации о фильме
        e.preventDefault();
        window.location.href = infoUrl;
    });

    link.innerHTML = `
        <img class="bochflix-card-poster" 
             src="${escapeHtml(posterUrl)}" 
             alt="${escapeHtml(movie.title)}" 
             loading="lazy"
             onerror="this.onerror=null; this.src='${API_CONFIG.DEFAULT_POSTER}';">
    `;

    return link;
}

// ==============================================================================
// 6. СЕКЦИЯ "НОВОЕ И ПОПУЛЯРНОЕ" (<section class="main__new-popular">)
// ==============================================================================

async function loadAndRenderPopularMovies() {
    const popularTrack = document.querySelector(SELECTORS.POPULAR_TRACK);
    if (!popularTrack) return;

    try {
        let movies = [];
        try {
            movies = await apiFetch(API_CONFIG.POPULAR_ENDPOINT);
        } catch (e) {
            movies = [];
        }

        // Если с флагом is_popular фильмов пока нет, берем свежие из общего каталога
        if (!Array.isArray(movies) || movies.length === 0) {
            movies = await apiFetch(`${API_CONFIG.MOVIES_ENDPOINT}?limit=12`);
        }

        if (Array.isArray(movies) && movies.length > 0) {
            const cardElements = movies.map(movie => createMovieCardElement(movie, popularTrack));
            popularTrack.replaceChildren(...cardElements);
            enableTrackDrag(popularTrack);
            console.log(`[Bochflix Loader] Отрисовано фильмов в 'Новое и популярное': ${cardElements.length}`);
        }
    } catch (err) {
        console.error('[Bochflix Loader] Ошибка при загрузке секции Новое и популярное:', err);
        throw err;
    }
}

// ==============================================================================
// 7. ДИНАМИЧЕСКИЕ БЛОКИ КАТЕГОРИЙ (<section class="main__other">) + LAZY LOADING
// ==============================================================================

/**
 * Создает блок категории, в точности повторяющий оригинальную разметку тестовых категорий:
 * <article class="main__other-article main__standart-card category-block" data-category-id="${cat.id}">
 *   <div class="main__standart-card--title">${cat.title}</div>
 *   <div class="main__standart-card--track" tabindex="0">
 *     <!-- Карточки фильмов данной категории -->
 *   </div>
 * </article>
 */
function createCategoryArticleElement(cat) {
    const catTitle = cat.title || cat.name || 'Категория';

    const article = document.createElement('article');
    article.className = 'main__other-article main__standart-card category-block';
    article.setAttribute('data-category-id', cat.id);
    article.id = `category-${cat.id}`;

    const titleDiv = document.createElement('div');
    titleDiv.className = 'main__standart-card--title';
    titleDiv.textContent = catTitle;
    const catSlugOrId = cat.slug || cat.id;
    titleDiv.addEventListener('click', () => {
        window.location.href = `catalog.html?genre=${encodeURIComponent(catSlugOrId)}`;
    });

    const trackDiv = document.createElement('div');
    trackDiv.className = 'main__standart-card--track';
    trackDiv.setAttribute('tabindex', '0');

    const movies = Array.isArray(cat.movies) ? cat.movies : [];
    if (movies.length > 0) {
        movies.forEach((movie) => {
            const card = createMovieCardElement(movie, trackDiv);
            trackDiv.appendChild(card);
        });
    } else {
        const emptyMsg = document.createElement('div');
        emptyMsg.className = 'main__standart-card--empty';
        emptyMsg.style.cssText = 'color: rgba(255,255,255,0.35); padding: 25px 20px; font-size: 0.95rem; font-style: italic;';
        emptyMsg.textContent = 'В этой категории пока нет добавленных фильмов';
        trackDiv.appendChild(emptyMsg);
    }

    // Подключаем drag-скроллинг мышью и клавиатурой
    enableTrackDrag(trackDiv);

    article.appendChild(titleDiv);
    article.appendChild(trackDiv);
    return article;
}

/**
 * Менеджер Infinite Scroll для динамических секций категорий в main__other.
 */
class InfiniteCategoriesLoader {
    constructor() {
        this.container = document.querySelector(SELECTORS.OTHER_SECTION);
        this.offset = 0;
        this.limit = API_CONFIG.CATEGORIES_BATCH_SIZE;
        this.isLoading = false;
        this.hasMore = true;
        this.sentinel = null;
        this.observer = null;
    }

    init() {
        if (!this.container) return;

        // Создаем невидимый элемент-триггер внизу контейнера
        this.sentinel = document.createElement('div');
        this.sentinel.className = 'main__other-sentinel';
        this.sentinel.textContent = '';
        this.container.appendChild(this.sentinel);

        // Настраиваем IntersectionObserver с упреждающим отступом 250px
        this.observer = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting && !this.isLoading && this.hasMore) {
                    this.loadNextBatch();
                }
            });
        }, {
            root: null,
            rootMargin: '250px 0px',
            threshold: 0.01,
        });

        this.observer.observe(this.sentinel);

        // Загружаем первую порцию (offset=0, limit=10)
        this.loadNextBatch();
    }

    async loadNextBatch() {
        if (this.isLoading || !this.hasMore) return;
        this.isLoading = true;

        try {
            const endpoint = `${API_CONFIG.CATEGORIES_PAGINATED_ENDPOINT}?offset=${this.offset}&limit=${this.limit}&exclude_popular=true`;
            const categories = await apiFetch(endpoint);

            if (!Array.isArray(categories) || categories.length === 0) {
                this.finishLoading();
                return;
            }

            // Фильтруем категории 'Новое' и 'Популярное'
            const validCategories = categories.filter(c => {
                const name = c.title || c.name || '';
                const slug = c.slug || '';
                return !isPopularCategory(name) && !isPopularCategory(slug);
            });

            validCategories.forEach((cat) => {
                const articleEl = createCategoryArticleElement(cat);
                this.container.insertBefore(articleEl, this.sentinel);
            });

            this.offset += categories.length;
            console.log(`[Bochflix Loader] Добавлено ${validCategories.length} категорий в main__other (offset: ${this.offset})`);

            // Если пришло меньше лимита, все категории в БД загружены
            if (categories.length < this.limit) {
                this.finishLoading();
            }
        } catch (err) {
            console.error('[Bochflix Loader] Ошибка Infinite Scroll категорий:', err);
            this.finishLoading();
        } finally {
            this.isLoading = false;
        }
    }

    finishLoading() {
        this.hasMore = false;
        if (this.observer) this.observer.disconnect();
        if (this.sentinel && this.sentinel.parentNode) this.sentinel.remove();
    }
}

function showError404Screen() {
    if (document.getElementById('bochflix-error-screen')) return;

    if (!document.querySelector('link[href*="error.css"]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '../STYLES/error.css';
        document.head.appendChild(link);
    }

    const screen = document.createElement('main');
    screen.id = 'bochflix-error-screen';
    screen.className = 'bochflix-error-screen';
    screen.setAttribute('role', 'alert');
    screen.setAttribute('aria-live', 'assertive');

    screen.innerHTML = `
        <div class="bochflix-error-content">
            <div class="bochflix-error-image-wrapper">
                <img src="../IMAGES/logos/bochflix_logo_error.webp" alt="404 BOCHFLIX" class="bochflix-error-image">
            </div>
            <p class="bochflix-error-message">Нет подключения к серверу. Повторите попытку позднее</p>
            <button type="button" class="bochflix-error-reload-btn">Обновить страницу</button>
        </div>
    `;

    const reloadBtn = screen.querySelector('.bochflix-error-reload-btn');
    if (reloadBtn) {
        reloadBtn.addEventListener('click', () => {
            try {
                sessionStorage.removeItem('bochflix_show_404');
            } catch (_) {}
            if (window.location.search.includes('error=')) {
                window.location.href = window.location.pathname;
            } else {
                window.location.reload();
            }
        });
    }

    document.body.appendChild(screen);
}

// ==============================================================================
// 8. ИНИЦИАЛИЗАЦИЯ И ЭКСПОРТ
// ==============================================================================

async function initBochflixLoader() {
    injectLoaderStyles();

    // 1. Проверяем, не перенаправлен ли пользователь с ошибкой 404
    const urlParams = new URLSearchParams(window.location.search);
    const hasErrorParam = urlParams.get('error') === '404';
    let hasSessionError = false;
    try {
        hasSessionError = sessionStorage.getItem('bochflix_show_404') === 'true';
        sessionStorage.removeItem('bochflix_show_404');
    } catch (_) {}

    if (hasErrorParam || hasSessionError) {
        console.warn('[Bochflix Loader] Пользователь перенаправлен с ошибкой 404. Отображаем экран ошибки.');
        if (window.history && window.history.replaceState) {
            window.history.replaceState(null, '', window.location.pathname);
        }
        showError404Screen();
        return;
    }

    // 2. Устанавливаем 10-секундный таймаут загрузки контента главной страницы
    let contentLoaded = false;
    const contentTimeout = setTimeout(() => {
        if (!contentLoaded) {
            console.warn('[Bochflix Loader] Контент грузится дольше 10 секунд. Отображаем ошибку 404.');
            showError404Screen();
        }
    }, 10000);

    window.addEventListener('offline', () => {
        clearTimeout(contentTimeout);
        showError404Screen();
    });
    window.addEventListener('online', () => {
        try {
            sessionStorage.removeItem('bochflix_show_404');
        } catch (_) {}
        if (window.location.search.includes('error=')) {
            window.location.href = window.location.pathname;
        } else {
            window.location.reload();
        }
    });

    if (!navigator.onLine) {
        clearTimeout(contentTimeout);
        showError404Screen();
        return;
    }

    // 3. Загружаем баннеры, плитки каталога и популярные фильмы
    try {
        const results = await Promise.allSettled([
            loadAndRenderBanners(),
            loadAndRenderCatalogTiles(),
            loadAndRenderPopularMovies(),
        ]);

        // Проверяем: если любой запрос завершился с ответом 400-й серии (HTTP 4xx):
        const has4xx = results.some(r => r.status === 'rejected' && r.reason && (r.reason.is4xx || (r.reason.status >= 400 && r.reason.status < 500)));

        // Или если все запросы завершились ошибкой:
        const allFailed = results.length > 0 && results.every(r => r.status === 'rejected');

        if (has4xx || allFailed) {
            clearTimeout(contentTimeout);
            showError404Screen();
            return;
        }

        // Контент успешно загружен вовремя
        contentLoaded = true;
        clearTimeout(contentTimeout);

        // Инициализируем Infinite Scroll для динамических секций категорий в main__other
        const infiniteLoader = new InfiniteCategoriesLoader();
        infiniteLoader.init();
        window.BochflixInfiniteCategories = infiniteLoader;
    } catch (err) {
        clearTimeout(contentTimeout);
        showError404Screen();
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBochflixLoader);
} else {
    initBochflixLoader();
}

// Экспорт в глобальный объект window
window.BochflixLoader = {
    init: initBochflixLoader,
    loadBanners: loadAndRenderBanners,
    loadCatalogTiles: loadAndRenderCatalogTiles,
    loadPopularMovies: loadAndRenderPopularMovies,
    CONFIG: API_CONFIG,
    SELECTORS: SELECTORS,
};
