// aide / header ---------------------------------------------
const arrowAside = document.querySelector('.aside__top-arrow');
const wrapper = document.querySelector('.wrapper');
const headerMenuBtn = document.querySelector('.header__left-button');
const ASIDE_COLLAPSED_KEY = 'bochflix_aside_collapsed';

// Восстановление сохранённого состояния бокового меню из localStorage
try {
    const isAsideCollapsed = localStorage.getItem(ASIDE_COLLAPSED_KEY) === 'true';
    if (isAsideCollapsed && wrapper && !wrapper.classList.contains('wrapper--aside-collapsed')) {
        wrapper.classList.add('wrapper--aside-collapsed');
    }
} catch (e) {
    console.warn('Не удалось прочитать состояние бокового меню из localStorage:', e);
}

if (arrowAside && wrapper) {
    arrowAside.addEventListener('click', (e) => {
        e.preventDefault();
        wrapper.classList.add('wrapper--aside-collapsed');
        try {
            localStorage.setItem(ASIDE_COLLAPSED_KEY, 'true');
        } catch (err) {
            console.warn('Не удалось сохранить состояние бокового меню в localStorage:', err);
        }
    });
}

if (headerMenuBtn && wrapper) {
    headerMenuBtn.addEventListener('click', (e) => {
        e.preventDefault();
        wrapper.classList.remove('wrapper--aside-collapsed');
        try {
            localStorage.setItem(ASIDE_COLLAPSED_KEY, 'false');
        } catch (err) {
            console.warn('Не удалось сохранить состояние бокового меню в localStorage:', err);
        }
    });
}

// header: прячем при скролле вниз, показываем при любом скролле вверх (все устройства)
(() => {
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
        header.style.transitionDelay = '0s';      // без задержки из состояния "aside свёрнут"
        header.classList.toggle('header--hidden', hide);
    };

    header.addEventListener('transitionend', () => {
        header.style.transitionDelay = '';        // возвращаем задержку для анимации сворачивания aside
    });

    window.addEventListener('scroll', () => {
        const y = getY();
        
        if (y <= HEADER_H) setHidden(false);
        else if (y > lastY) setHidden(true);
        else if (y < lastY) setHidden(false);
        
        lastY = y;
    }, { passive: true, capture: true });
})();

// main__slider -----------------------------------------------

(() => {
    const AUTOPLAY_MS = 5000;
    const DRAG_START_PX = 6;

    const slider = document.querySelector('.main__slider');
    if (!slider) return;
    const track = slider.querySelector('.main__slider-track');

    let count = 0;            // число настоящих карточек
    let index = 1;            // позиция в дорожке: 1 = первая настоящая
    let ready = false;        // true, когда карточек 2 и больше и слайдер можно листать
    let timerId = null;
    let hovered = false;
    let dragging = false;

    /* ---------- Геометрия ---------- */
    const setSize = () => slider.style.setProperty('--sw', slider.clientWidth + 'px');
    const first = () => track.firstElementChild;
    const cardW = () => (first() ? first().offsetWidth : 0);
    const step = () => cardW() + (parseFloat(getComputedStyle(track).columnGap) || 0);
    const baseX = () => (slider.clientWidth - cardW()) / 2;   // сдвиг, при котором карточка 0 по центру
    const xFor = (i) => baseX() - i * step();
    const currentX = () => new DOMMatrix(getComputedStyle(track).transform).m41;

    function updateActiveCard() {
        if (!track) return;
        const cards = [...track.children];
        cards.forEach((card, i) => {
            const isActive = ready ? (i === index) : true;
            card.classList.toggle('is-active', isActive);
            card.classList.toggle('main__slider-item--active', isActive);
            if (!isActive) {
                const video = card.querySelector('.poster-video');
                if (video) {
                    video.classList.remove('is-visible');
                    if (video.tagName && video.tagName.toLowerCase() === 'video') {
                        video.pause();
                        video.currentTime = 0;
                    }
                }
            }
        });
    }

    function render(animate) {
        if (!first()) return;
        track.style.transition = animate ? '' : 'none';
        track.style.transform = `translate3d(${xFor(index)}px, 0, 0)`;
        if (!animate) void track.offsetWidth;
        updateActiveCard();
    }

    // Если стоим на клоне, мгновенно переходим на настоящую карточку
    function normalize() {
        if (index > count) index = 1;
        else if (index < 1) index = count;
        else return;
        render(false);
    }

    function go(delta) {
        if (!ready) return;
        normalize();
        index += delta;
        render(true);
    }

    track.addEventListener('transitionend', (e) => {
        if (!ready || e.target !== track || e.propertyName !== 'transform') return;
        if (index > count || index < 1) {
            normalize();
            track.style.transition = '';
        }
    });

    /* ---------- Клоны: пересборка при любом изменении карточек ---------- */
    const realCards = () => [...track.children].filter(el => !el.hasAttribute('data-clone'));

    function makeClone(card) {
        const c = card.cloneNode(true);
        c.setAttribute('data-clone', '');
        c.setAttribute('aria-hidden', 'true');
        c.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));        // id должны быть уникальными
        c.querySelectorAll('a, button, input, [tabindex]').forEach(el => { el.tabIndex = -1; });
        if (c.matches('a, button')) c.tabIndex = -1;                               // клон не должен ловить фокус
        return c;
    }

    function rebuild() {
        observer.disconnect();                       // свои правки DOM не должны запускать наблюдатель
        stop();
        ready = false;
        pressed = false;

        track.querySelectorAll(':scope > [data-clone]').forEach(el => el.remove());

        const cards = realCards();
        count = cards.length;

        if (count >= 2) {
            // Дорожка: [клон последней] [1 … N] [клон первой]
            track.prepend(makeClone(cards[count - 1]));
            track.append(makeClone(cards[0]));
            index = 1;
            ready = true;
        } else {
            index = 0;                               // 0 или 1 карточка: без клонов, одна просто стоит по центру
        }

        setSize();
        render(false);
        slider.classList.toggle('is-single', count < 2);
        observe();
        restart();
    }

    // Несколько вставок подряд (например, 20 карточек append'ами) дадут одну пересборку
    let rebuildQueued = false;
    const scheduleRebuild = () => {
        if (rebuildQueued) return;
        rebuildQueued = true;
        requestAnimationFrame(() => {
            rebuildQueued = false;
            rebuild();
        });
    };

    const observer = new MutationObserver(scheduleRebuild);
    const observe = () => observer.observe(track, { childList: true });

    /* ---------- Автоплей ---------- */
    const start = () => {
        if (!timerId && ready && !dragging) timerId = setInterval(() => go(1), AUTOPLAY_MS);
    };
    const stop = () => { clearInterval(timerId); timerId = null; };
    const restart = () => {            // после ручного действия отсчёт начинается заново
        stop();
        if (ready && !hovered && !document.hidden) start();
    };
    const userGo = (delta) => { go(delta); restart(); };

    slider.addEventListener('mouseenter', () => { hovered = true; stop(); });
    slider.addEventListener('mouseleave', () => { hovered = false; start(); });
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : restart()));

    /* ---------- Кнопки и клавиатура ---------- */
    slider.querySelector('.main__slider-btn--prev').addEventListener('click', () => userGo(-1));
    slider.querySelector('.main__slider-btn--next').addEventListener('click', () => userGo(1));

    slider.tabIndex = 0;
    slider.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') userGo(-1);
        if (e.key === 'ArrowRight') userGo(1);
    });

    /* ---------- Горизонтальный скролл тачпадом ---------- */
    let wheelLock = false;
    slider.addEventListener('wheel', (e) => {
        if (!ready) return;
        if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || Math.abs(e.deltaX) < 10) return;
        e.preventDefault();
        if (wheelLock) return;
        wheelLock = true;
        userGo(e.deltaX > 0 ? 1 : -1);
        setTimeout(() => { wheelLock = false; }, 600);
    }, { passive: false });

    /* ---------- Перетаскивание мышью / пальцем ---------- */
    let pressed = false;
    let moved = false;
    let startPointerX = 0;
    let startTrackX = 0;
    let pointerId = null;
    let suppressClick = false;

    slider.addEventListener('pointerdown', (e) => {
        if (!ready) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (e.target.closest('.main__slider-btn')) return;
        normalize();
        pressed = true;
        moved = false;
        startPointerX = e.clientX;
        pointerId = e.pointerId;
    });

    slider.addEventListener('pointermove', (e) => {
        if (!pressed) return;
        let dx = e.clientX - startPointerX;

        if (!moved) {
            if (Math.abs(dx) < DRAG_START_PX) return;
            moved = true;
            dragging = true;
            stop();
            slider.setPointerCapture(pointerId);
            slider.classList.add('is-dragging');
            track.style.transition = 'none';
            startTrackX = currentX();       // забираем позицию, даже если шла анимация
            startPointerX = e.clientX;
            dx = 0;
        }
        track.style.transform = `translate3d(${startTrackX + dx}px, 0, 0)`;
    });

    function endDrag(e) {
        if (!pressed) return;
        pressed = false;
        if (!moved) return;

        const dx = e.clientX - startPointerX;
        dragging = false;
        slider.classList.remove('is-dragging');
        try { slider.releasePointerCapture(pointerId); } catch (_) { }

        // Какой по счёту карточке соответствует текущая позиция дорожки
        let target = Math.round((baseX() - (startTrackX + dx)) / step());
        // Небольшого свайпа (больше 12% ширины карточки) достаточно для переключения
        if (target === index && Math.abs(dx) > cardW() * 0.12) target += dx < 0 ? 1 : -1;

        index = Math.min(Math.max(target, 0), count + 1);
        render(true);
        restart();

        suppressClick = true;             // чтобы после свайпа не сработал клик по карточке-ссылке
        setTimeout(() => { suppressClick = false; }, 0);
    }

    slider.addEventListener('pointerup', endDrag);
    slider.addEventListener('pointercancel', endDrag);

    /* ---------- Навигация при клике на баннер / кнопки ---------- */
    slider.addEventListener('click', (e) => {
        if (suppressClick || slider.classList.contains('is-dragging')) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        const actionBtn = e.target.closest('.poster-button__action');
        const infoBtn = e.target.closest('.poster-button__info');
        const poster = e.target.closest('.main__item-poster');
        if (!poster && !actionBtn && !infoBtn) return;

        const targetPoster = poster || (actionBtn || infoBtn).closest('.main__item-poster');

        // Кнопка 1: «Смотреть» — прямой переход на воспроизведение фильма
        if (actionBtn) {
            e.preventDefault();
            e.stopPropagation();
            const movieUrl = actionBtn.dataset.movieUrl || (targetPoster ? (targetPoster.dataset.movieUrl || targetPoster.dataset.video) : null);
            if (movieUrl) {
                window.location.href = movieUrl;
            }
            return;
        }

        // Кнопка 2: «Подробнее» — переход на страницу информации о фильме
        if (infoBtn) {
            e.preventDefault();
            e.stopPropagation();
            const infoUrl = infoBtn.dataset.infoUrl || (targetPoster ? (targetPoster.dataset.infoUrl || `information.html?id=${targetPoster.dataset.id || targetPoster.dataset.pnr}`) : null);
            if (infoUrl) {
                window.location.href = infoUrl;
            }
            return;
        }

        // Клик по карточке баннера (вне кнопок) — переход на страницу информации о фильме
        if (targetPoster) {
            e.preventDefault();
            e.stopPropagation();
            const infoUrl = targetPoster.dataset.infoUrl || `information.html?id=${targetPoster.dataset.id || targetPoster.dataset.pnr}`;
            if (infoUrl) {
                window.location.href = infoUrl;
            }
        }
    }, true);

    /* ---------- Видео-тизер при наведении на активный баннер (только мышь / pointer: fine) ---------- */
    const HOVER_DELAY = 1800;
    let hoverTimer = null;
    let hoveredPoster = null;

    /**
     * Автоматическое устранение зашитых черных полос (letterbox/pillarbox) у любых MP4/видео.
     * Анализирует кадры воспроизводимого видео и динамически подбирает масштаб, 
     * чтобы полезный видеоряд занимал ровно 100% контейнера баннера без черных полос и без сплющивания.
     */
    function eliminateVideoBlackBars(video, onReady) {
        if (!video || video.tagName.toLowerCase() !== 'video') {
            if (onReady) onReady();
            return;
        }

        let readyNotified = false;
        const notifyReady = () => {
            if (!readyNotified) {
                readyNotified = true;
                if (onReady) onReady();
            }
        };

        if (video._blackBarsAttached) {
            notifyReady();
            return;
        }
        video._blackBarsAttached = true;

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const W = 64;
        const H = 36;
        canvas.width = W;
        canvas.height = H;

        let detected = false;
        const checkFrame = () => {
            if (detected || video.paused || video.ended || video.videoWidth === 0) return;

            try {
                ctx.drawImage(video, 0, 0, W, H);
                const data = ctx.getImageData(0, 0, W, H).data;

                // Проверяем среднюю яркость центра кадра
                let centerSum = 0;
                let centerCount = 0;
                for (let y = Math.floor(H * 0.35); y <= Math.ceil(H * 0.65); y++) {
                    for (let x = Math.floor(W * 0.25); x <= Math.ceil(W * 0.75); x++) {
                        const i = (y * W + x) * 4;
                        centerSum += (data[i] + data[i + 1] + data[i + 2]) / 3;
                        centerCount++;
                    }
                }
                const centerBrightness = centerSum / (centerCount || 1);
                // Если кадр полностью темный в самом начале, подождем первый информативный кадр (до 0.25 сек)
                if (centerBrightness < 16 && video.currentTime < 0.25) return;

                // 1. Поиск черных полос сверху и снизу (Letterbox)
                let topBlack = 0;
                for (let y = 0; y < Math.floor(H * 0.4); y++) {
                    let rowSum = 0;
                    for (let x = 0; x < W; x++) {
                        const i = (y * W + x) * 4;
                        rowSum += (data[i] + data[i + 1] + data[i + 2]) / 3;
                    }
                    if (rowSum / W < 15) topBlack++;
                    else break;
                }

                let botBlack = 0;
                for (let y = H - 1; y >= Math.ceil(H * 0.6); y--) {
                    let rowSum = 0;
                    for (let x = 0; x < W; x++) {
                        const i = (y * W + x) * 4;
                        rowSum += (data[i] + data[i + 1] + data[i + 2]) / 3;
                    }
                    if (rowSum / W < 15) botBlack++;
                    else break;
                }

                // 2. Поиск черных полос по бокам (Pillarbox)
                let leftBlack = 0;
                for (let x = 0; x < Math.floor(W * 0.4); x++) {
                    let colSum = 0;
                    for (let y = 0; y < H; y++) {
                        const i = (y * W + x) * 4;
                        colSum += (data[i] + data[i + 1] + data[i + 2]) / 3;
                    }
                    if (colSum / H < 15) leftBlack++;
                    else break;
                }

                let rightBlack = 0;
                for (let x = W - 1; x >= Math.ceil(W * 0.6); x--) {
                    let colSum = 0;
                    for (let y = 0; y < H; y++) {
                        const i = (y * W + x) * 4;
                        colSum += (data[i] + data[i + 1] + data[i + 2]) / 3;
                    }
                    if (colSum / H < 15) rightBlack++;
                    else break;
                }

                const vertBlackRatio = (topBlack + botBlack) / H;
                const horizBlackRatio = (leftBlack + rightBlack) / W;

                if (vertBlackRatio >= 0.06 && vertBlackRatio <= 0.42) {
                    const scale = (1 / (1 - vertBlackRatio + 0.015)).toFixed(3);
                    video.style.transform = `translate(-50%, -50%) scale(${scale})`;
                    video.style.setProperty('transform', `translate(-50%, -50%) scale(${scale})`, 'important');
                    detected = true;
                } else if (horizBlackRatio >= 0.06 && horizBlackRatio <= 0.42) {
                    const scale = (1 / (1 - horizBlackRatio + 0.015)).toFixed(3);
                    video.style.transform = `translate(-50%, -50%) scale(${scale})`;
                    video.style.setProperty('transform', `translate(-50%, -50%) scale(${scale})`, 'important');
                    detected = true;
                } else {
                    video.style.transform = 'translate(-50%, -50%) scale(1)';
                    video.style.setProperty('transform', 'translate(-50%, -50%) scale(1)', 'important');
                    detected = true;
                }
            } catch (err) {
                // Если canvas ограничен (например, CORS), оставляем базовое центрирование cover
                video.style.transform = 'translate(-50%, -50%)';
                video.style.setProperty('transform', 'translate(-50%, -50%)', 'important');
                detected = true;
            }

            notifyReady();

            if (detected) {
                video.removeEventListener('timeupdate', checkFrame);
            }
        };

        video.addEventListener('timeupdate', checkFrame);
        video.addEventListener('playing', checkFrame);
        video.addEventListener('loadeddata', checkFrame);

        // Страховочный таймаут: не задерживать появление видео более 150 мс
        setTimeout(notifyReady, 150);
    }

    /**
     * Адаптирует размеры и масштаб iframe (YouTube/Vimeo) под пропорции баннера,
     * чтобы плеер заполнял 100% пространства без черных полос и искажения пропорций 16:9.
     */
    function adjustIframeCover(iframe, poster) {
        if (!iframe || !poster) return;
        const pw = poster.clientWidth;
        const ph = poster.clientHeight;
        if (!pw || !ph) return;

        const containerRatio = pw / ph;
        const videoRatio = 16 / 9;
        const scaleFactor = 1.15; // 15% запас для среза черных полей плеера

        if (containerRatio > videoRatio) {
            const w = pw * scaleFactor;
            const h = (pw / videoRatio) * scaleFactor;
            iframe.style.setProperty('width', `${Math.round(w)}px`, 'important');
            iframe.style.setProperty('height', `${Math.round(h)}px`, 'important');
        } else {
            const h = ph * scaleFactor;
            const w = (ph * videoRatio) * scaleFactor;
            iframe.style.setProperty('width', `${Math.round(w)}px`, 'important');
            iframe.style.setProperty('height', `${Math.round(h)}px`, 'important');
        }
        iframe.style.setProperty('top', '50%', 'important');
        iframe.style.setProperty('left', '50%', 'important');
        iframe.style.setProperty('transform', 'translate(-50%, -50%)', 'important');
    }

    slider.addEventListener('mouseover', (e) => {
        // Запуск трейлера разрешен строго на устройствах с аппаратной поддержкой мыши
        const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
        if (!canHover) return;

        const poster = e.target.closest('.main__item-poster');
        // Трейлер запускается исключительно на активном (центральном) баннере
        if (!poster || poster === hoveredPoster || !poster.classList.contains('is-active')) return;

        clearTimeout(hoverTimer);
        hoveredPoster = poster;

        const videoSrc = poster.dataset.video;
        if (!videoSrc) return;

        hoverTimer = setTimeout(() => {
            if (hoveredPoster !== poster || dragging || slider.classList.contains('is-dragging')) return;
            if (!poster.classList.contains('is-active')) return;

            let video = poster.querySelector('.poster-video');
            const isEmbed = /youtube\.com|youtu\.be|vimeo\.com|embed|\.html/i.test(videoSrc);

            const showTrailer = () => {
                if (hoveredPoster === poster && poster.classList.contains('is-active')) {
                    video.classList.add('is-visible');
                }
            };

            if (!video) {
                if (isEmbed) {
                    video = document.createElement('iframe');
                    video.className = 'poster-video';
                    const sep = videoSrc.includes('?') ? '&' : '?';
                    video.src = `${videoSrc}${sep}autoplay=1&mute=1&controls=0&loop=1`;
                    video.allow = 'autoplay; encrypted-media; picture-in-picture';
                    video.setAttribute('tabindex', '-1');
                    video.setAttribute('aria-hidden', 'true');
                    poster.prepend(video);
                    adjustIframeCover(video, poster);
                    showTrailer();
                } else {
                    video = document.createElement('video');
                    video.className = 'poster-video';
                    video.crossOrigin = 'anonymous';
                    video.src = videoSrc;
                    video.muted = true;
                    video.loop = true;
                    video.playsInline = true;
                    video.preload = 'auto';
                    eliminateVideoBlackBars(video, showTrailer);
                    poster.prepend(video);
                    video.play().catch(() => {});
                }
            } else {
                if (isEmbed) {
                    adjustIframeCover(video, poster);
                    showTrailer();
                } else {
                    eliminateVideoBlackBars(video, showTrailer);
                    video.play().catch(() => {});
                }
            }
        }, HOVER_DELAY);
    });

    slider.addEventListener('mouseout', (e) => {
        const poster = e.target.closest('.main__item-poster');
        if (!poster || !poster.contains(e.relatedTarget)) {
            clearTimeout(hoverTimer);
            if (poster) {
                const video = poster.querySelector('.poster-video');
                if (video) {
                    video.classList.remove('is-visible');
                    if (video.tagName && video.tagName.toLowerCase() === 'video') {
                        video.pause();
                        video.currentTime = 0;
                    }
                }
            }
            if (hoveredPoster === poster) {
                hoveredPoster = null;
            }
        }
    });

    /* ---------- Старт ---------- */
    let lastW = 0;
    new ResizeObserver((entries) => {
        const w = Math.round(entries[0].contentRect.width);
        if (w === lastW) return;          // высота нас не интересует, только ширина
        lastW = w;
        requestAnimationFrame(() => {     // правим DOM уже в следующем кадре
            if (dragging || !first()) return;
            setSize();
            render(false);
        });
    }).observe(slider);

    rebuild();   // если карточки уже есть в HTML, соберёт клоны сразу; если нет, дождётся их через observer
})();

// main__standart-card --------------------------------

// Находим все треки на странице
const tracks = document.querySelectorAll('.main__standart-card--track');

tracks.forEach((track) => {
    // Делаем каждый контейнер доступным для фокуса с клавиатуры
    track.setAttribute('tabindex', '0');

    let isDown = false;
    let startX;
    let scrollLeft;

    // Вспомогательная функция для переключения класса is-dragging на карточках внутри этого трека
    const setCardsDragging = (isDragging) => {
        const cards = track.querySelectorAll('.main__standart-card--item');
        cards.forEach((card) => {
            card.classList.toggle('is-dragging', isDragging);
        });
    };

    // 1. Захват мыши
    track.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return; // Реагируем только на левую кнопку мыши
        if (e.target.closest('.main__card-btn--fav, .main__card-btn--watch')) return;
        isDown = true;
        track.classList.add('active');
        startX = e.pageX - track.offsetLeft;
        scrollLeft = track.scrollLeft;
    });

    // 2. Движение мыши и перетаскивание
    track.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        e.preventDefault();

        // Добавляем класс is-dragging на карточки во время движения
        setCardsDragging(true);

        const x = e.pageX - track.offsetLeft;
        const walk = (x - startX) * 1.5; // Скорость прокрутки
        track.scrollLeft = scrollLeft - walk;
    });

    // 3. Отпускание или уход мыши
    const stopDragging = () => {
        if (!isDown) return;
        isDown = false;
        track.classList.remove('active');
        setCardsDragging(false);
    };

    track.addEventListener('mouseup', stopDragging);
    track.addEventListener('mouseleave', stopDragging);

    // 4. Управление стрелками с клавиатуры
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
});

// Глобальная страховка: сброс состояния, если отпустили мышь за пределами окна
window.addEventListener('mouseup', () => {
    document.querySelectorAll('.main__standart-card.is-dragging').forEach((card) => {
        card.classList.remove('is-dragging');
    });
    document.querySelectorAll('.main__standart-card--track.active').forEach((track) => {
        track.classList.remove('active');
    });
});

// catalog расперделение по рядам -----------------------------

function splitCatalogIntoTwoRows() {
    const track = document.querySelector('.main__catalog-track');
    const items = [...track.querySelectorAll('.main__catalog-item')];
    if (!items.length) return;

    const gap = 15;
    const sizes = items.map(el => el.getBoundingClientRect().width);
    const total = sizes.reduce((a, b) => a + b + gap, 0);

    const rows = [0, 1].map(() => {
        const row = document.createElement('div');
        row.className = 'main__catalog-row';
        return row;
    });

    let acc = 0;
    items.forEach((el, i) => {
        // пока верхний ряд короче половины, кладём в него
        const r = acc + (sizes[i] + gap) / 2 <= total / 2 ? 0 : 1;
        rows[r].append(el);
        if (r === 0) acc += sizes[i] + gap;
    });

    track.replaceChildren(...rows);
}

document.fonts.ready.then(splitCatalogIntoTwoRows);

// Навигация меню (боковое меню <aside>, мобильное меню и шапка)
(() => {
    // 1. Десктопное меню <aside>: раздел «Каталог»
    document.querySelectorAll('.aside__home-item, .aside-item').forEach((item) => {
        const text = item.querySelector('.aside__item-text');
        if (text && text.textContent.trim().toLowerCase() === 'каталог') {
            item.style.cursor = 'pointer';
            item.addEventListener('click', (e) => {
                e.preventDefault();
                window.location.href = 'catalog.html';
            });
        }
        if (text && text.textContent.trim().toLowerCase() === 'главная') {
            item.style.cursor = 'pointer';
            item.addEventListener('click', (e) => {
                e.preventDefault();
                window.location.href = 'index.html';
            });
        }
    });

    // 2. Мобильное меню: кнопка «Каталог» и «Главная»
    document.querySelectorAll('.aside__catalog--mobile').forEach((btn) => {
        btn.style.cursor = 'pointer';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            window.location.href = 'catalog.html';
        });
    });

    document.querySelectorAll('.aside__main--mobile').forEach((btn) => {
        btn.style.cursor = 'pointer';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            window.location.href = 'index.html';
        });
    });

    // 3. Шапка десктопная: элемент «Каталог»
    document.querySelectorAll('.header__center-item').forEach((item) => {
        if (item.textContent.trim().toLowerCase() === 'каталог') {
            item.style.cursor = 'pointer';
            item.addEventListener('click', (e) => {
                e.preventDefault();
                window.location.href = 'catalog.html';
            });
        }
        if (item.textContent.trim().toLowerCase() === 'главная') {
            item.style.cursor = 'pointer';
            item.addEventListener('click', (e) => {
                e.preventDefault();
                window.location.href = 'index.html';
            });
        }
    });
})();
