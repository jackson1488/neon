(() => {
  const loading = document.getElementById('loading');
  const loadingText = document.getElementById('loading-text');
  const errorOverlay = document.getElementById('error');
  const errorText = document.getElementById('error-text');
  const canvas = document.getElementById('canvas');

  let readyEmitted = false;
  let manifestRef = null;
  let bootTimeout = null;
  const searchParams = new URLSearchParams(window.location.search || '');
  const assetVersion = `${searchParams.get('t') || ''}`.trim();
  const isNativeWebView = Boolean(window.ReactNativeWebView);
  const touchPreferred =
    Number(navigator.maxTouchPoints || 0) > 0 ||
    window.matchMedia?.('(pointer: coarse)')?.matches;
  const controlState = new Map();
  const controlKeyMap = {
    Escape: 'Escape',
    F2: 'F2',
    F3: 'F3',
    F6: 'F6',
    F7: 'F7',
    F9: 'F9',
    F10: 'F10',
    ArrowLeft: 'ArrowLeft',
    ArrowUp: 'ArrowUp',
    ArrowRight: 'ArrowRight',
    ArrowDown: 'ArrowDown',
    KeyW: 'w',
    KeyA: 'a',
    KeyS: 's',
    KeyD: 'd',
    Space: ' ',
    ControlLeft: 'Control',
    Enter: 'Enter',
    Tab: 'Tab',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    KeyY: 'y',
    KeyN: 'n',
  };
  const controlKeyCodeMap = {
    Escape: 27,
    F2: 113,
    F3: 114,
    F6: 117,
    F7: 118,
    F9: 120,
    F10: 121,
    Tab: 9,
    Enter: 13,
    Space: 32,
    ControlLeft: 17,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Minus: 189,
    Equal: 187,
    BracketLeft: 219,
    BracketRight: 221,
    KeyW: 87,
    KeyA: 65,
    KeyS: 83,
    KeyD: 68,
    KeyY: 89,
    KeyN: 78,
  };
  let controlsRoot = null;
  let joystickBase = null;
  let joystickThumb = null;
  let lookPad = null;
  let touchControlsMounted = false;
  let joystickPointerId = null;
  let lookPointerId = null;
  let nativeTurnKey = null;
  let nativeTurnReleaseTimer = null;
  let lastLookPoint = null;
  let lookOffsetX = 0;
  let lookOffsetY = 0;
  let pendingLookDeltaX = 0;
  let pendingLookDeltaY = 0;
  let lookRafId = null;
  let smoothedLookDeltaX = 0;
  let smoothedLookDeltaY = 0;

  const withVersion = (url) => {
    if (!assetVersion) return url;
    return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(assetVersion)}`;
  };

  const MANIFEST_URL = withVersion('./manifest.json');
  const ENGINE_SCRIPT_URL = withVersion('./engine/index.js');
  const IWAD_BASE_URL = './iwads/';
  const lookSensitivity = (() => {
    const raw = Number(searchParams.get('look'));
    if (Number.isFinite(raw) && raw > 0) {
      return Math.min(Math.max(raw, 1), 12);
    }
    return touchPreferred ? 10.2 : 3.8;
  })();
  const lookSensitivityX = lookSensitivity * (isNativeWebView ? 1.08 : 1.15);
  const lookSensitivityY = lookSensitivity * (isNativeWebView ? 0.7 : 0.85);
  const turnButtonStrength = isNativeWebView ? 18 : 10;

  const emitMessage = (type, payload = {}) => {
    const message = JSON.stringify({ type, ...payload });
    try {
      if (window.ReactNativeWebView?.postMessage) {
        window.ReactNativeWebView.postMessage(message);
      }
    } catch (_error) {
      // noop
    }
    try {
      window.parent?.postMessage({ type, ...payload }, '*');
    } catch (_error) {
      // noop
    }
  };

  const updateStatus = (text) => {
    if (loadingText) {
      loadingText.textContent = text;
    }
  };

  const clearBootTimeout = () => {
    if (bootTimeout) {
      clearTimeout(bootTimeout);
      bootTimeout = null;
    }
  };

  const showError = (text) => {
    clearBootTimeout();
    if (loading) loading.classList.add('hidden');
    if (errorOverlay) errorOverlay.classList.remove('hidden');
    if (errorText) {
      errorText.textContent = text;
    }
    emitMessage('doom-error', { message: text });
  };

  const hideError = () => {
    if (errorOverlay) errorOverlay.classList.add('hidden');
  };

  const hideLoading = () => {
    if (loading) loading.classList.add('hidden');
    hideError();
  };

  const emitReady = () => {
    clearBootTimeout();
    if (readyEmitted) return;
    readyEmitted = true;
    hideLoading();
    if (touchPreferred && window.olyOn) {
      window.olyOn();
    }
    if (canvas) {
      canvas.classList.add('visible');
      canvas.focus();
    }
    emitMessage('doom-ready', {
      title: manifestRef?.title || 'Doom',
      iwad: manifestRef?.iwad || '',
    });
  };

  const normalizeRelativePath = (value) => {
    const path = `${value || ''}`.trim().replace(/^\/+/, '');
    if (!path || path.includes('..')) {
      throw new Error('manifest.json содержит некорректный путь к IWAD.');
    }
    return path;
  };

  const joinUrlPath = (base, relativePath) =>
    withVersion(`${base}${relativePath.split('/').map(encodeURIComponent).join('/')}`);

  const fetchBytes = async (url) => {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Не удалось загрузить ${url}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };

  const ensureFsPath = (fullPath) => {
    const target = `${fullPath || ''}`.trim();
    if (!target.startsWith('/')) return;
    const parts = target.split('/').filter(Boolean);
    let current = '';
    for (const segment of parts.slice(0, -1)) {
      current += `/${segment}`;
      try {
        FS.mkdir(current);
      } catch (_error) {
        // Папка уже существует.
      }
    }
  };

  const dispatchKeyboard = (payload) => {
    const key = `${payload?.key || ''}`.trim();
    const code = `${payload?.code || key || ''}`.trim();
    if (!key && !code) return;
    const resolvedKey = key || controlKeyMap[code] || code;
    const legacyKeyCode = controlKeyCodeMap[code] || 0;

    const type = payload?.pressed ? 'keydown' : 'keyup';
    const event = new KeyboardEvent(type, {
      key: resolvedKey,
      code: code || key,
      bubbles: true,
      cancelable: true,
    });
    try {
      Object.defineProperty(event, 'keyCode', { get: () => legacyKeyCode });
      Object.defineProperty(event, 'which', { get: () => legacyKeyCode });
      Object.defineProperty(event, 'charCode', { get: () => 0 });
    } catch (_error) {
      // noop
    }

    if (canvas) {
      canvas.dispatchEvent(event);
      canvas.focus();
    }
    document.dispatchEvent(event);
    window.dispatchEvent(event);
  };

  const setControlKey = (code, pressed) => {
    if (!code) return;
    if (controlState.get(code) === pressed) return;
    controlState.set(code, pressed);
    dispatchKeyboard({ code, pressed });
  };

  const pulseKey = (code, duration = 72) => {
    if (!code) return;
    setControlKey(code, true);
    window.setTimeout(() => {
      setControlKey(code, false);
    }, duration);
  };

  const pulseWeaponCycle = (direction = 1) => {
    const deltaY = direction > 0 ? 120 : -120;
    const dispatchWheel = (target) => {
      if (!target?.dispatchEvent) return;
      const event = new WheelEvent('wheel', {
        deltaY,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
    };

    if (canvas) {
      dispatchWheel(canvas);
      canvas.focus();
    }
    dispatchWheel(document);
    dispatchWheel(window);

    // Fallback для портов, где смена оружия висит на клавишах `[` и `]`.
    pulseKey(direction > 0 ? 'BracketRight' : 'BracketLeft', 68);
  };

  const releaseMovementKeys = () => {
    ['KeyW', 'KeyA', 'KeyS', 'KeyD'].forEach((code) => setControlKey(code, false));
  };

  const setNativeTurnDirection = (direction) => {
    if (!isNativeWebView) return false;
    const nextKey = direction > 0 ? 'ArrowRight' : direction < 0 ? 'ArrowLeft' : null;
    if (nativeTurnKey === nextKey) return true;
    nativeTurnKey = nextKey;
    setControlKey('ArrowLeft', nextKey === 'ArrowLeft');
    setControlKey('ArrowRight', nextKey === 'ArrowRight');
    return true;
  };

  const releaseNativeTurnKeys = () => {
    if (!isNativeWebView) return;
    if (nativeTurnReleaseTimer) {
      clearTimeout(nativeTurnReleaseTimer);
      nativeTurnReleaseTimer = null;
    }
    nativeTurnKey = null;
    setControlKey('ArrowLeft', false);
    setControlKey('ArrowRight', false);
  };

  const scheduleNativeTurnRelease = () => {
    if (!isNativeWebView) return;
    if (nativeTurnReleaseTimer) {
      clearTimeout(nativeTurnReleaseTimer);
    }
    nativeTurnReleaseTimer = window.setTimeout(() => {
      nativeTurnReleaseTimer = null;
      releaseNativeTurnKeys();
    }, 42);
  };

  const applyLookDelta = (deltaX, deltaY) => {
    if (!canvas) return;
    if (!deltaX && !deltaY) return;
    const rect = canvas.getBoundingClientRect();
    lookOffsetX += deltaX * lookSensitivityX;
    lookOffsetY += deltaY * lookSensitivityY;
    const moveX = lookOffsetX < 0 ? Math.ceil(lookOffsetX - 0.5) : Math.floor(lookOffsetX + 0.5);
    const moveY = lookOffsetY < 0 ? Math.ceil(lookOffsetY - 0.5) : Math.floor(lookOffsetY + 0.5);
    lookOffsetX -= moveX;
    lookOffsetY -= moveY;
    if (!moveX && !moveY) return;

    const baseX = Math.ceil(rect.left + rect.width * 0.5);
    const baseY = Math.ceil(rect.top + rect.height * 0.5);
    const dispatchRelativeMove = (target, type) => {
      const event = new MouseEvent(type, {
        clientX: baseX + moveX,
        clientY: baseY + moveY,
        screenX: baseX + moveX,
        screenY: baseY + moveY,
        bubbles: true,
        cancelable: true,
      });
      try {
        Object.defineProperty(event, 'movementX', { get: () => moveX });
        Object.defineProperty(event, 'movementY', { get: () => moveY });
      } catch (_error) {
        // noop
      }
      target.dispatchEvent(event);
    };

    canvas.dispatchEvent(new MouseEvent('mouseenter', { clientX: baseX, clientY: baseY, bubbles: true }));
    dispatchRelativeMove(canvas, 'mousemove');
    if (!isNativeWebView) {
      dispatchRelativeMove(document, 'mousemove');
      dispatchRelativeMove(window, 'mousemove');
    }
  };

  const flushLookDelta = () => {
    lookRafId = null;
    const deltaX = pendingLookDeltaX;
    const deltaY = pendingLookDeltaY;
    pendingLookDeltaX = 0;
    pendingLookDeltaY = 0;
    applyLookDelta(deltaX, deltaY);
  };

  const queueLookDelta = (deltaX, deltaY) => {
    if (isNativeWebView) {
      if (Math.abs(deltaX) < 0.08) deltaX = 0;
      if (Math.abs(deltaY) < 0.08) deltaY = 0;
    }
    pendingLookDeltaX += deltaX;
    pendingLookDeltaY += deltaY;
    if (lookRafId) return;
    lookRafId = window.requestAnimationFrame(flushLookDelta);
  };

  const findTrackedTouch = (touchList, touchId) => {
    if (!touchList || touchId == null) return null;
    for (let index = 0; index < touchList.length; index += 1) {
      if (touchList[index]?.identifier === touchId) {
        return touchList[index];
      }
    }
    return null;
  };

  const createRepeatingAction = (handler) => {
    let rafId = null;
    let lastTs = 0;
    const tick = (ts) => {
      if (!lastTs) lastTs = ts;
      const delta = Math.min((ts - lastTs) || 16.67, 34);
      lastTs = ts;
      handler(delta / 16.67);
      rafId = window.requestAnimationFrame(tick);
    };
    return {
      start() {
        if (rafId) return;
        lastTs = 0;
        rafId = window.requestAnimationFrame(tick);
      },
      stop() {
        if (rafId) {
          window.cancelAnimationFrame(rafId);
          rafId = null;
        }
        lastTs = 0;
      },
    };
  };

  const parseWarpArgs = () => {
    const warp = `${searchParams.get('warp') || ''}`.trim().toUpperCase();
    if (!warp) return [];
    const episodeMatch = /^E([1-9])M([1-9])$/.exec(warp);
    if (episodeMatch) {
      return ['-warp', episodeMatch[1], episodeMatch[2]];
    }
    const mapMatch = /^MAP(0?[1-9]|[1-2][0-9]|3[0-2])$/.exec(warp);
    if (mapMatch) {
      return ['-warp', `${Number(mapMatch[1])}`];
    }
    const plainMapMatch = /^(0?[1-9]|[1-2][0-9]|3[0-2])$/.exec(warp);
    if (plainMapMatch) {
      return ['-warp', `${Number(plainMapMatch[1])}`];
    }
    return [];
  };

  const parseSkillArgs = () => {
    const raw = Number(searchParams.get('skill'));
    if (!Number.isFinite(raw)) return [];
    const skill = Math.max(1, Math.min(5, Math.floor(raw)));
    return ['-skill', `${skill}`];
  };

  const onMessage = (event) => {
    let payload = event?.data;
    if (!payload) return;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch (_error) {
        return;
      }
    }
    if (payload.type === 'doom-key') {
      dispatchKeyboard(payload);
    }
  };

  window.addEventListener('message', onMessage);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && canvas) {
      canvas.focus();
    }
  });

  const loadManifest = async () => {
    const response = await fetch(MANIFEST_URL, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('Не найден games/doom/manifest.json');
    }

    const manifest = await response.json();
    const iwad = normalizeRelativePath(manifest?.iwad);
    const args = Array.isArray(manifest?.args)
      ? manifest.args.filter((entry) => `${entry || ''}`.trim().length > 0)
      : [];

    return {
      title: `${manifest?.title || 'Doom'}`.trim() || 'Doom',
      iwad,
      args,
    };
  };

  const requestImmersiveMode = async () => {
    if (!touchPreferred) return;
    if (isNativeWebView) return;
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen?.();
      }
    } catch (_error) {
      // Браузер может запретить fullscreen без явного жеста — это ожидаемо.
    }

    try {
      if (screen.orientation?.lock) {
        await screen.orientation.lock('landscape');
      }
    } catch (_error) {
      // Не все браузеры разрешают lock orientation.
    }
  };

  const createTouchButton = ({ label, className, onPressStart, onPressEnd }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `doom-touch-btn ${className || ''}`.trim();
    button.innerHTML = label;
    let active = false;

    const start = (event) => {
      if (active) return;
      active = true;
      event.preventDefault();
      event.stopPropagation();
      onPressStart?.();
    };
    const end = (event) => {
      if (!active) return;
      active = false;
      event?.preventDefault?.();
      event?.stopPropagation?.();
      onPressEnd?.();
    };

    button.addEventListener('touchstart', start, { passive: false });
    button.addEventListener('touchend', end, { passive: false });
    button.addEventListener('touchcancel', end, { passive: false });
    button.addEventListener('mousedown', start);
    button.addEventListener('mouseup', end);
    button.addEventListener('mouseleave', end);
    return button;
  };

  const mountTouchControls = () => {
    if (!touchPreferred || touchControlsMounted || !canvas) return;
    touchControlsMounted = true;

    controlsRoot = document.createElement('div');
    controlsRoot.className = 'doom-touch-ui';

    const leftDock = document.createElement('div');
    leftDock.className = 'doom-touch-left';

    joystickBase = document.createElement('div');
    joystickBase.className = 'doom-joystick-base';
    joystickThumb = document.createElement('div');
    joystickThumb.className = 'doom-joystick-thumb';
    joystickBase.appendChild(joystickThumb);
    leftDock.appendChild(joystickBase);

    const rightDock = document.createElement('div');
    rightDock.className = 'doom-touch-right';

    const utilityRow = document.createElement('div');
    utilityRow.className = 'doom-touch-utility';
    const turnLeftAction = isNativeWebView
      ? {
          start() {
            setNativeTurnDirection(-1);
          },
          stop() {
            releaseNativeTurnKeys();
          },
        }
      : createRepeatingAction((scale = 1) => queueLookDelta(-turnButtonStrength * scale, 0));
    const turnRightAction = isNativeWebView
      ? {
          start() {
            setNativeTurnDirection(1);
          },
          stop() {
            releaseNativeTurnKeys();
          },
        }
      : createRepeatingAction((scale = 1) => queueLookDelta(turnButtonStrength * scale, 0));
    utilityRow.appendChild(
      createTouchButton({
        label: '&#8630;',
        className: 'doom-touch-btn--small',
        onPressStart: () => turnLeftAction.start(),
        onPressEnd: () => turnLeftAction.stop(),
      })
    );
    utilityRow.appendChild(
      createTouchButton({
        label: '&#8631;',
        className: 'doom-touch-btn--small',
        onPressStart: () => turnRightAction.start(),
        onPressEnd: () => turnRightAction.stop(),
      })
    );
    utilityRow.appendChild(
      createTouchButton({
        label: 'Q',
        className: 'doom-touch-btn--small',
        onPressStart: () => pulseKey('Tab'),
        onPressEnd: () => {},
      })
    );
    utilityRow.appendChild(
      createTouchButton({
        label: '↵',
        className: 'doom-touch-btn--small',
        onPressStart: () => pulseKey('Enter'),
        onPressEnd: () => {},
      })
    );
    rightDock.appendChild(utilityRow);

    const actionsRow = document.createElement('div');
    actionsRow.className = 'doom-touch-actions';
    actionsRow.appendChild(
      createTouchButton({
        label: '&#10753;',
        className: 'doom-touch-btn--fire',
        onPressStart: () => setControlKey('ControlLeft', true),
        onPressEnd: () => setControlKey('ControlLeft', false),
      })
    );
    actionsRow.appendChild(
      createTouchButton({
        label: '&#9251;',
        className: 'doom-touch-btn--use',
        onPressStart: () => setControlKey('Space', true),
        onPressEnd: () => setControlKey('Space', false),
      })
    );
    rightDock.appendChild(actionsRow);

    const weaponRow = document.createElement('div');
    weaponRow.className = 'doom-touch-prompts';
    weaponRow.appendChild(
      createTouchButton({
        label: '&#9664;',
        className: 'doom-touch-btn--small',
        onPressStart: () => pulseWeaponCycle(-1),
        onPressEnd: () => {},
      })
    );
    weaponRow.appendChild(
      createTouchButton({
        label: '&#9654;',
        className: 'doom-touch-btn--small',
        onPressStart: () => pulseWeaponCycle(1),
        onPressEnd: () => {},
      })
    );
    rightDock.appendChild(weaponRow);

    lookPad = document.createElement('div');
    lookPad.className = 'doom-look-pad';
    if (isNativeWebView) {
      lookPad.style.width = '64%';
    }

    controlsRoot.appendChild(lookPad);
    controlsRoot.appendChild(leftDock);
    controlsRoot.appendChild(rightDock);
    document.body.appendChild(controlsRoot);

    const joystickRadius = 62;
    const joystickDeadZone = 6;
    const nativeLookClamp = 14;

    const resetJoystick = () => {
      joystickPointerId = null;
      if (joystickThumb) {
        joystickThumb.style.transform = 'translate(-50%, -50%)';
      }
      releaseMovementKeys();
    };

    const updateJoystick = (clientX, clientY) => {
      if (!joystickBase || !joystickThumb) return;
      const rect = joystickBase.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      let dx = clientX - centerX;
      let dy = clientY - centerY;
      const distance = Math.hypot(dx, dy);
      if (distance > joystickRadius) {
        const scale = joystickRadius / distance;
        dx *= scale;
        dy *= scale;
      }

      joystickThumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

      const activeUp = dy < -joystickDeadZone;
      const activeDown = dy > joystickDeadZone;
      const activeLeft = dx < -joystickDeadZone;
      const activeRight = dx > joystickDeadZone;

      setControlKey('KeyW', activeUp);
      setControlKey('KeyS', activeDown);
      setControlKey('KeyA', activeLeft);
      setControlKey('KeyD', activeRight);
    };

    joystickBase.addEventListener(
      'touchstart',
      (event) => {
        if (joystickPointerId != null) return;
        const touch = event.changedTouches?.[0];
        if (!touch) return;
        event.preventDefault();
        joystickPointerId = touch.identifier;
        updateJoystick(touch.clientX, touch.clientY);
      },
      { passive: false }
    );

    joystickBase.addEventListener(
      'touchmove',
      (event) => {
        const touch = findTrackedTouch(event.touches, joystickPointerId);
        if (!touch) return;
        event.preventDefault();
        updateJoystick(touch.clientX, touch.clientY);
      },
      { passive: false }
    );

    ['touchend', 'touchcancel'].forEach((type) => {
      joystickBase.addEventListener(
        type,
        (event) => {
          const touch = findTrackedTouch(event.changedTouches, joystickPointerId);
          if (!touch && joystickPointerId != null) return;
          event.preventDefault();
          resetJoystick();
        },
        { passive: false }
      );
    });

    const endLook = () => {
      lookPointerId = null;
      releaseNativeTurnKeys();
      lastLookPoint = null;
      smoothedLookDeltaX = 0;
      smoothedLookDeltaY = 0;
      pendingLookDeltaX = 0;
      pendingLookDeltaY = 0;
      if (lookRafId) {
        window.cancelAnimationFrame(lookRafId);
        lookRafId = null;
      }
    };

    lookPad.addEventListener(
      'touchstart',
      (event) => {
        if (lookPointerId != null) return;
        const touch = event.changedTouches?.[0];
        if (!touch) return;
        event.preventDefault();
        lookPointerId = touch.identifier;
        lastLookPoint = { x: touch.clientX, y: touch.clientY };
        void requestImmersiveMode();
        canvas.focus();
      },
      { passive: false }
    );

    lookPad.addEventListener(
      'touchmove',
      (event) => {
        const touch = findTrackedTouch(event.touches, lookPointerId);
        if (!touch || !lastLookPoint) return;
        event.preventDefault();
        const deltaX = touch.clientX - lastLookPoint.x;
        const deltaY = touch.clientY - lastLookPoint.y;
        lastLookPoint = { x: touch.clientX, y: touch.clientY };
        if (isNativeWebView) {
          const clampedX = Math.max(-nativeLookClamp, Math.min(nativeLookClamp, deltaX));
          const clampedY = Math.max(-nativeLookClamp, Math.min(nativeLookClamp, deltaY));
          smoothedLookDeltaX = smoothedLookDeltaX * 0.18 + clampedX * 0.82;
          smoothedLookDeltaY = smoothedLookDeltaY * 0.44 + clampedY * 0.56;
          if (Math.abs(smoothedLookDeltaX) >= 1.1) {
            setNativeTurnDirection(smoothedLookDeltaX > 0 ? 1 : -1);
            scheduleNativeTurnRelease();
          } else {
            releaseNativeTurnKeys();
          }
          if (Math.abs(smoothedLookDeltaY) >= 1.2) {
            queueLookDelta(0, smoothedLookDeltaY * 0.35);
          }
          return;
        }
        queueLookDelta(deltaX, deltaY);
      },
      { passive: false }
    );

    ['touchend', 'touchcancel'].forEach((type) => {
      lookPad.addEventListener(
        type,
        (event) => {
          const touch = findTrackedTouch(event.changedTouches, lookPointerId);
          if (!touch && lookPointerId != null) return;
          event.preventDefault();
          endLook();
        },
        { passive: false }
      );
    });

  };

  const start = async () => {
    try {
      mountTouchControls();
      updateStatus('Читаем manifest Doom…');
      manifestRef = await loadManifest();

      updateStatus(`Загружаем ${manifestRef.iwad}…`);
      const iwadBytes = await fetchBytes(joinUrlPath(IWAD_BASE_URL, manifestRef.iwad));
      const virtualIwadPath = `/iwads/${manifestRef.iwad}`;
      const warpArgs = parseWarpArgs();
      const skillArgs = parseSkillArgs();

      window.Module = {
        arguments: ['-iwad', virtualIwadPath, ...warpArgs, ...skillArgs, ...manifestRef.args],
        canvas,
        locateFile(file) {
          return withVersion(`./engine/${file}`);
        },
        preRun: [
          () => {
            ensureFsPath(virtualIwadPath);
            FS.writeFile(virtualIwadPath, iwadBytes);
          },
        ],
        print(text) {
          if (typeof text === 'string' && text.trim()) {
            console.log(text);
          }
        },
        printErr(text) {
          if (typeof text === 'string' && text.trim()) {
            console.error(text);
          }
        },
        setStatus(text) {
          const clean = `${text || ''}`.replace(/<br>/g, ' ');
          if (clean.trim()) {
            updateStatus(clean);
          }
        },
        onRuntimeInitialized() {
          updateStatus('Doom запущен.');
          emitReady();
        },
        hideConsole: emitReady,
        showConsole() {
          if (canvas) {
            canvas.focus();
          }
        },
        captureMouse() {
          if (!canvas) return;
          canvas.focus();
          try {
            if (document.pointerLockElement !== canvas) {
              canvas.requestPointerLock?.();
            }
          } catch (_error) {
            // noop
          }
        },
        winResized() {
          if (canvas) {
            canvas.focus();
          }
        },
      };

      bootTimeout = window.setTimeout(() => {
        showError('Doom загружается дольше обычного. Проверь IWAD и попробуй перезапуск.');
      }, touchPreferred ? 90000 : 45000);

      const script = document.createElement('script');
      script.src = ENGINE_SCRIPT_URL;
      script.async = true;
      script.onerror = () => showError('Не удалось загрузить Doom-движок.');
      document.body.appendChild(script);
    } catch (error) {
      showError(error?.message || 'Не удалось запустить Doom.');
    }
  };

  if (canvas) {
    const handleGameFocus = () => {
      void requestImmersiveMode();
      canvas.focus();
      try {
        if (document.pointerLockElement !== canvas) {
          canvas.requestPointerLock?.();
        }
      } catch (_error) {
        // noop
      }
    };

    canvas.addEventListener('click', () => {
      handleGameFocus();
    });

    canvas.addEventListener(
      'touchstart',
      () => {
        void requestImmersiveMode();
      },
      { passive: true }
    );
  }

  void start();
})();
