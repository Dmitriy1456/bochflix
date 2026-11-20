/**
 * ==============================================================================
 * BOCHFLIX — INFORMATION PAGE SCRIPT (information.js)
 * ==============================================================================
 * 
 * Логика страницы детальной информации о фильме (information.html):
 * 1. Извлечение ID или PNR фильма из параметров строки запроса (?id=... или ?pnr=...).
 * 2. Асинхронная загрузка данных фильма из базы через API (/api/movies/{id|pnr}).
 * 3. Наполнение DOM: динамический баннер (приоритет 16:9 формата), логотип или
 *    текстовое название акцентным шрифтом, плашки метаданных (рейтинг, год,
 *    длительность, качество), описание, жанры и развернутый сюжет.
 * 4. Плавное скрытие и появление Header при скролле (единый стиль с главной страницей).
 * 5. Прямая работа кнопки «Смотреть» (мгновенный переход к видеофайлу).
 * 6. Воспроизведение трейлера во встроенном модальном окне при нажатии на «Трейлер».
 * 7. Навигация назад (стрелки), логотип (на главную) и сохранение в избранное.
 * 8. Отображение адаптивного экрана ошибки при потере соединения с сервером / интернетом.
 */

(function () {
    'use strict';

    // ==========================================================================
    // 1. КОНФИГУРАЦИЯ И СЕТЕВЫЕ УТИЛИТЫ
    // ==========================================================================

    const CONFIG = {
        DEFAULT_BANNER: '../IMAGES/error_items/error_items-img/bochflix-test-img.webp',
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

    // ==========================================================================
    // 2. ОБРАБОТКА ОШИБОК: ПЕРЕНАПРАВЛЕНИЕ НА ГЛАВНУЮ С ОШИБКОЙ 404
    // ==========================================================================

    function redirectToHome404() {
        try {
            sessionStorage.setItem('bochflix_show_404', 'true');
        } catch (_) {}
        window.location.href = 'index.html?error=404';
    }

    // ==========================================================================
    // 3. ПОВЕДЕНИЕ ШАПКИ (HEADER) ПРИ СКРОЛЛЕ
    // ==========================================================================

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
    // 4. ПОЛУЧЕНИЕ ИДЕНТИФИКАТОРА ФИЛЬМА И ЗАГРУЗКА ДАННЫХ
    // ==========================================================================

    function getMovieIdentifier() {
        const params = new URLSearchParams(window.location.search);
        return params.get('id') || params.get('pnr') || params.get('movie_id') || null;
    }

    async function fetchMovieDetails(identifier) {
        const baseUrl = getApiBaseUrl();

        // 1. Если передан конкретный ID или PNR фильма
        if (identifier) {
            const response = await fetch(`${baseUrl}/api/movies/${encodeURIComponent(identifier)}`, {
                headers: { 'Accept': 'application/json' },
            });

            // Если от сервера приходит ответ 400-й серии (включая 404 Not Found)
            if (response.status >= 400 && response.status < 500) {
                console.warn(`[Information] Ответ сервера 400-й серии: HTTP ${response.status}`);
                const err = new Error(`HTTP_${response.status}`);
                err.status = response.status;
                throw err;
            }

            if (!response.ok) {
                const err = new Error(`HTTP_${response.status}`);
                err.status = response.status;
                throw err;
            }

            return await response.json();
        }

        // 2. Если идентификатор не передан — пробуем загрузить первый фильм из каталога
        const listRes = await fetch(`${baseUrl}/api/movies?limit=1`, {
            headers: { 'Accept': 'application/json' },
        });

        if (listRes.status >= 400 && listRes.status < 500) {
            console.warn(`[Information] Fallback запрос вернул ответ 400-й серии: HTTP ${listRes.status}`);
            const err = new Error(`HTTP_${listRes.status}`);
            err.status = listRes.status;
            throw err;
        }

        if (!listRes.ok) {
            const err = new Error(`HTTP_${listRes.status}`);
            err.status = listRes.status;
            throw err;
        }

        const list = await listRes.json();
        if (Array.isArray(list) && list.length > 0) {
            return list[0];
        }

        // Если список пуст — фиксируем ошибку 404
        const notFoundErr = new Error('HTTP_404');
        notFoundErr.status = 404;
        throw notFoundErr;
    }

    // ==========================================================================
    // 5. РЕНДЕРИНГ ДАННЫХ В DOM
    // ==========================================================================

    function renderMovie(movie) {
        if (!movie) return;

        // 1. Обновляем заголовок вкладки браузера
        document.title = `${movie.title} — BOCHFLIX`;

        // 2. Фоновое изображение главного баннера (.main__top)
        // Только для мобильных устройств (<= 767px) отображаем постер 6:5 (banner_mobile_url, mobile_poster),
        // для экранов больше 767px — постер 16:9 (banner_desktop_url, banner, backdrop)
        const mainTop = document.querySelector('.main__top');
        if (mainTop) {
            // Кадр/баннер формата 6:5 (мобильный)
            const image6x5 = [
                movie.banner_mobile_url,
                movie.mobile_poster
            ].find(url => typeof url === 'string' && url.trim() !== '' && url !== 'null' && url !== 'undefined');

            // Кадр/баннер формата 16:9 (десктопный)
            const image16x9 = [
                movie.banner_desktop_url,
                movie.banner,
                movie.backdrop_16_9,
                movie.backdrop_url,
                movie.backdrop,
                movie.horizontal_poster,
                movie.wide_poster
            ].find(url => typeof url === 'string' && url.trim() !== '' && url !== 'null' && url !== 'undefined');

            // Запасной вариант (fallback) картинок другого формата, привязанных к фильму
            const fallbackOther = [
                movie.poster_url,
                movie.poster,
                movie.image_url,
                movie.image,
                movie.thumbnail,
                movie.thumbnail_url
            ].find(url => typeof url === 'string' && url.trim() !== '' && url !== 'null' && url !== 'undefined');

            const url6x5 = image6x5 ? resolveUrl(image6x5.trim()) : null;
            const url16x9 = image16x9 ? resolveUrl(image16x9.trim()) : null;
            const fallbackUrl = fallbackOther ? resolveUrl(fallbackOther.trim()) : CONFIG.DEFAULT_BANNER;

            // Очищаем предыдущие слушатели при повторном вызове
            if (typeof mainTop._bochflixBannerCleanup === 'function') {
                mainTop._bochflixBannerCleanup();
            }

            const mql = window.matchMedia('(max-width: 767px)');
            let activeUrl = null;

            function applyBanner() {
                const isMobile = window.innerWidth <= 767;
                // На мобильных (<= 767px): приоритет 6:5 -> fallback 16:9 -> fallback любой другой
                // На десктопе (> 767px): приоритет 16:9 -> fallback 6:5 -> fallback любой другой
                const targetUrl = isMobile
                    ? (url6x5 || url16x9 || fallbackUrl)
                    : (url16x9 || url6x5 || fallbackUrl);

                if (targetUrl && targetUrl !== activeUrl) {
                    activeUrl = targetUrl;
                    mainTop.style.backgroundImage = `url("${targetUrl}")`;

                    // Проверяем доступность выбранного изображения, при ошибке переключаемся на альтернативу
                    const testImg = new Image();
                    testImg.onerror = function () {
                        console.warn('[Information] Выбранное фоновое изображение недоступно, переключаемся на fallback:', targetUrl);
                        const altUrl = isMobile
                            ? (url16x9 || fallbackUrl)
                            : (url6x5 || fallbackUrl);
                        if (altUrl && altUrl !== targetUrl) {
                            activeUrl = altUrl;
                            mainTop.style.backgroundImage = `url("${altUrl}")`;
                        }
                    };
                    testImg.src = targetUrl;
                }
            }

            applyBanner();

            const onViewportChange = () => applyBanner();
            if (typeof mql.addEventListener === 'function') {
                mql.addEventListener('change', onViewportChange);
            } else if (typeof mql.addListener === 'function') {
                mql.addListener(onViewportChange);
            }
            window.addEventListener('resize', onViewportChange, { passive: true });

            mainTop._bochflixBannerCleanup = function () {
                if (typeof mql.removeEventListener === 'function') {
                    mql.removeEventListener('change', onViewportChange);
                } else if (typeof mql.removeListener === 'function') {
                    mql.removeListener(onViewportChange);
                }
                window.removeEventListener('resize', onViewportChange);
            };
        }

        // 3. Логотип или заголовок фильма (.main__top-data--logo)
        const logoContainer = document.querySelector('.main__top-data--logo');
        if (logoContainer) {
            const hasLogo = movie.logo_url &&
                typeof movie.logo_url === 'string' &&
                movie.logo_url.trim() !== '' &&
                movie.logo_url.trim() !== 'null' &&
                movie.logo_url.trim() !== 'undefined';

            if (hasLogo) {
                const logoImg = document.createElement('img');
                logoImg.src = resolveUrl(movie.logo_url.trim());
                logoImg.alt = movie.title || 'Логотип фильма';
                logoImg.className = 'main__top-data--logo-img';

                // Если изображение логотипа не загрузилось (битый URL или 404) — fallback на текстовое название
                logoImg.onerror = function () {
                    console.warn('[Information] Не удалось загрузить картинку логотипа. Выводим текст названия.');
                    this.remove();
                    if (!logoContainer.querySelector('.main__top-data--logo-text')) {
                        const textTitle = document.createElement('div');
                        textTitle.className = 'main__top-data--logo-text';
                        textTitle.textContent = movie.title || '';
                        logoContainer.appendChild(textTitle);
                    }
                };

                logoContainer.replaceChildren(logoImg);
            } else {
                // Логотипа нет — выводим текстом название фильма акцентным шрифтом Namu
                const textTitle = document.createElement('div');
                textTitle.className = 'main__top-data--logo-text';
                textTitle.textContent = movie.title || '';
                logoContainer.replaceChildren(textTitle);
            }
        }

        // 4. Метаданные (рейтинг, год, длительность, качество)
        const ratingStr = movie.rating != null ? Number(movie.rating).toFixed(1) : '10.0';
        const yearStr = movie.year ? String(movie.year) : '2024';
        const durationStr = movie.duration || '2 ч';
        const qualityStr = movie.quality || 'FHD';

        // Десктопные плашки
        const dRating = document.querySelector('.main__top-data--info .main__info--rating');
        const dYear = document.querySelector('.main__top-data--info .main__info--year');
        const dDuration = document.querySelector('.main__top-data--info .main__info--duration');
        const dQuality = document.querySelector('.main__top-data--info .main__info--quality');
        if (dRating) dRating.textContent = ratingStr;
        if (dYear) dYear.textContent = yearStr;
        if (dDuration) dDuration.textContent = durationStr;
        if (dQuality) dQuality.textContent = qualityStr;

        // Мобильные плашки
        const mRating = document.querySelector('.main__data--mobile .main__info--rating');
        const mYear = document.querySelector('.main__data--mobile .main__info--year');
        const mDuration = document.querySelector('.main__data--mobile .main__info--duration');
        const mQuality = document.querySelector('.main__data--mobile .main__info--quality');
        if (mRating) mRating.textContent = ratingStr;
        if (mYear) mYear.textContent = yearStr;
        if (mDuration) mDuration.textContent = durationStr;
        if (mQuality) mQuality.textContent = qualityStr;

        // 5. Краткое описание в шапке баннера
        const topDesc = document.querySelector('.main__top-data--description');
        if (topDesc) {
            topDesc.textContent = movie.description || '';
        }

        // 6. Блок подробной информации внизу (.main__description)
        const descItems = document.querySelectorAll('.main__description--item');
        // Описание
        if (descItems[0]) {
            const descText = descItems[0].querySelector('.main__description--text');
            if (descText) descText.textContent = movie.description || 'Описание отсутствует.';
        }
        // Жанры (подчеркнутые и кликабельные ссылки на страницу жанра в каталоге)
        if (descItems[1]) {
            const genresText = descItems[1].querySelector('.main__description--text');
            if (genresText) {
                genresText.innerHTML = '';
                const categoryList = Array.isArray(movie.categories) && movie.categories.length > 0
                    ? movie.categories
                    : (Array.isArray(movie.category_names) ? movie.category_names.map(name => ({ name, title: name, slug: name })) : []);

                if (categoryList.length > 0) {
                    categoryList.forEach((catItem, idx) => {
                        const name = typeof catItem === 'string' ? catItem : (catItem.title || catItem.name);
                        const slugOrId = typeof catItem === 'string' ? catItem : (catItem.slug || catItem.id || name);

                        const a = document.createElement('a');
                        a.href = `catalog.html?genre=${encodeURIComponent(slugOrId)}`;
                        a.className = 'main__description--genre-link';
                        a.textContent = name;
                        a.style.textDecoration = 'underline';
                        a.style.color = 'inherit';
                        a.style.cursor = 'pointer';
                        a.addEventListener('click', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            window.location.href = `catalog.html?genre=${encodeURIComponent(slugOrId)}`;
                        });
                        genresText.appendChild(a);

                        if (idx < categoryList.length - 1) {
                            genresText.appendChild(document.createTextNode(', '));
                        }
                    });
                } else if (movie.categories_str) {
                    const rawList = movie.categories_str.split(',').map(s => s.trim()).filter(Boolean);
                    rawList.forEach((rawItem, idx) => {
                        const a = document.createElement('a');
                        a.href = `catalog.html?genre=${encodeURIComponent(rawItem)}`;
                        a.className = 'main__description--genre-link';
                        a.textContent = rawItem;
                        a.style.textDecoration = 'underline';
                        a.style.color = 'inherit';
                        a.style.cursor = 'pointer';
                        a.addEventListener('click', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            window.location.href = `catalog.html?genre=${encodeURIComponent(rawItem)}`;
                        });
                        genresText.appendChild(a);
                        if (idx < rawList.length - 1) {
                            genresText.appendChild(document.createTextNode(', '));
                        }
                    });
                } else {
                    const a = document.createElement('a');
                    a.href = 'catalog.html';
                    a.className = 'main__description--genre-link';
                    a.textContent = 'Фильмы';
                    a.style.textDecoration = 'underline';
                    a.style.color = 'inherit';
                    a.style.cursor = 'pointer';
                    a.addEventListener('click', (e) => {
                        e.preventDefault();
                        window.location.href = 'catalog.html';
                    });
                    genresText.appendChild(a);
                }
            }
        }
        // Сюжет (#plot-text)
        const plotEl = document.querySelector('#plot-text .main__description--text');
        if (plotEl) {
            plotEl.textContent = movie.plot || movie.description || 'Сюжет фильма скоро будет дополнен.';
        }

        // 7. Настройка кнопок «Смотреть»
        const videoPlayUrl = (movie.movie_page_url && movie.movie_page_url.endsWith('.mp4'))
            ? resolveUrl(movie.movie_page_url)
            : resolveUrl(`/movie/video/${movie.pnr}.mp4`);

        const watchDesktop = document.querySelector('.main__top-btn--watch');
        const watchMobile = document.querySelector('.main__top--mobile-play');

        function onWatchClick(e) {
            e.preventDefault();
            e.stopPropagation();
            window.location.href = videoPlayUrl;
        }

        if (watchDesktop) watchDesktop.addEventListener('click', onWatchClick);
        if (watchMobile) watchMobile.addEventListener('click', onWatchClick);

        // 8. Настройка кнопок «Трейлер»
        const trailerUrl = movie.trailer || movie.trailer_url ? resolveUrl(movie.trailer || movie.trailer_url) : null;
        const trailerDesktop = document.querySelector('.main__top-btn--trailer');
        const trailerMobile = document.querySelector('.main__top--mobile-trailer');

        function onTrailerClick(e) {
            e.preventDefault();
            e.stopPropagation();
            if (trailerUrl) {
                openTrailerModal(trailerUrl, movie.title);
            } else {
                alert('Трейлер для данного фильма пока не загружен.');
            }
        }

        if (trailerDesktop) trailerDesktop.addEventListener('click', onTrailerClick);
        if (trailerMobile) trailerMobile.addEventListener('click', onTrailerClick);

        // 9. Настройка кнопок «Избранное»
        setupFavorites(movie);
    }

    // ==========================================================================
    // 6. МОДАЛЬНОЕ ОКНО ТРЕЙЛЕРА
    // ==========================================================================

    function openTrailerModal(videoSrc, title) {
        let modal = document.getElementById('bochflix-trailer-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'bochflix-trailer-modal';
            modal.innerHTML = `
                <div class="trailer-modal-backdrop"></div>
                <div class="trailer-modal-content">
                    <button type="button" class="trailer-modal-close" aria-label="Закрыть">&times;</button>
                    <video class="trailer-modal-video" controls autoplay playsinline></video>
                </div>
            `;
            document.body.appendChild(modal);

            modal.querySelector('.trailer-modal-close').addEventListener('click', closeTrailerModal);
            modal.querySelector('.trailer-modal-backdrop').addEventListener('click', closeTrailerModal);
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && modal.classList.contains('is-open')) {
                    closeTrailerModal();
                }
            });
        }

        const video = modal.querySelector('.trailer-modal-video');
        video.src = videoSrc;
        video.currentTime = 0;
        modal.classList.add('is-open');
        document.body.style.overflow = 'hidden';
        video.play().catch(() => {});
    }

    function closeTrailerModal() {
        const modal = document.getElementById('bochflix-trailer-modal');
        if (!modal) return;
        const video = modal.querySelector('.trailer-modal-video');
        if (video) {
            video.pause();
            video.removeAttribute('src');
            video.load();
        }
        modal.classList.remove('is-open');
        document.body.style.overflow = '';
    }

    // ==========================================================================
    // 7. ИЗБРАННОЕ И НАВИГАЦИЯ
    // ==========================================================================

    function setupFavorites(movie) {
        const favDesktop = document.querySelector('.main__top-btn--favorites');
        const favMobile = document.querySelector('.main__top--mobile-favorites');
        if (!favDesktop && !favMobile) return;

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

        function updateVisual(isFav) {
            if (favDesktop) {
                favDesktop.style.borderColor = isFav ? '#ff4081' : '';
                favDesktop.style.color = isFav ? '#ff4081' : '';
                const icon = favDesktop.querySelector('img');
                if (icon) icon.style.opacity = isFav ? '1' : '0.6';
            }
            if (favMobile) {
                favMobile.style.borderColor = isFav ? '#ff4081' : '';
                favMobile.style.color = isFav ? '#ff4081' : '';
                const icon = favMobile.querySelector('img');
                if (icon) icon.style.opacity = isFav ? '1' : '0.6';
            }
        }

        const currentFavs = getFavorites();
        updateVisual(currentFavs.includes(movie.pnr));

        function toggle(e) {
            e.preventDefault();
            e.stopPropagation();
            const favs = getFavorites();
            const idx = favs.indexOf(movie.pnr);
            let nowFav = false;
            if (idx >= 0) {
                favs.splice(idx, 1);
            } else {
                favs.push(movie.pnr);
                nowFav = true;
            }
            setFavorites(favs);
            updateVisual(nowFav);
        }

        if (favDesktop) favDesktop.addEventListener('click', toggle);
        if (favMobile) favMobile.addEventListener('click', toggle);
    }

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

        // Логотипы (переход на главную)
        const logoButtons = document.querySelectorAll('.header__left-logo, .header__logo--mobile, .aside__main--mobile');
        logoButtons.forEach(logo => {
            logo.addEventListener('click', (e) => {
                e.preventDefault();
                window.location.href = 'index.html';
            });
        });

        // Пункты Каталога
        const catalogItems = document.querySelectorAll('.header__left-item, .aside__catalog--mobile');
        catalogItems.forEach(item => {
            if (item.textContent.trim().toLowerCase().includes('каталог') || item.classList.contains('aside__catalog--mobile')) {
                item.addEventListener('click', (e) => {
                    e.preventDefault();
                    window.location.href = 'catalog.html';
                });
            }
        });
    }

    // ==========================================================================
    // 8. ИНИЦИАЛИЗАЦИЯ
    // ==========================================================================

    async function init() {
        setupNavigation();
        setupHeaderScroll();

        // 1. Таймаут загрузки контента: если грузится дольше 10 секунд — перенаправляем на главную с ошибкой 404
        let contentLoaded = false;
        const loadTimer = setTimeout(() => {
            if (!contentLoaded) {
                console.warn('[Information] Контент грузится дольше 10 секунд. Перенаправляем на главную с ошибкой 404.');
                redirectToHome404();
            }
        }, 10000);

        // 2. Отслеживание потери интернет-соединения
        window.addEventListener('offline', () => {
            clearTimeout(loadTimer);
            redirectToHome404();
        });

        if (!navigator.onLine) {
            clearTimeout(loadTimer);
            redirectToHome404();
            return;
        }

        // 3. Загрузка данных фильма
        const identifier = getMovieIdentifier();
        try {
            const movie = await fetchMovieDetails(identifier);
            if (movie) {
                contentLoaded = true;
                clearTimeout(loadTimer);
                renderMovie(movie);
                console.log(`[Information] Фильм '${movie.title}' [PNR: ${movie.pnr}] успешно загружен.`);
            } else {
                clearTimeout(loadTimer);
                redirectToHome404();
            }
        } catch (err) {
            console.warn('[Information] Ошибка при загрузке фильма на вкладке Информация (перенаправление на главную):', err.message);
            clearTimeout(loadTimer);
            redirectToHome404();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
