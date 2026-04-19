(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const loginView = $('#login-view');
  const appView = $('#app-view');
  const authContainer = $('#auth-container');
  const loginForm = $('#login-form');
  const registerForm = $('#register-form');
  const recoverForm = $('#recover-form');
  const authError = $('#auth-error');
  const registerTab = $('#register-tab');
  const submitSection = $('#submit-section');
  const submitForm = $('#submit-form');
  const extractError = $('#extract-error');
  const resultsSection = $('#results-section');
  const resultsList = $('#results-list');
  const resultsTitle = $('#results-title');
  const backBtn = $('#back-btn');
  const logoutBtn = $('#logout-btn');
  const imagesSection = $('#images-section');
  const imagesList = $('#images-list');
  const imagesCount = $('#images-count');
  const filteredSection = $('#filtered-section');
  const filteredList = $('#filtered-list');
  const filteredCount = $('#filtered-count');
  const settingsBtn = $('#settings-btn');
  const settingsSection = $('#settings-section');
  const settingsBackBtn = $('#settings-back-btn');
  const adminBtn = $('#admin-btn');
  const adminSection = $('#admin-section');
  const adminBackBtn = $('#admin-back-btn');

  // Recovery code overlay
  const recoveryOverlay = $('#recovery-overlay');
  const recoveryCodeDisplay = $('#recovery-code-display');
  const recoveryDismiss = $('#recovery-dismiss');

  let loggedIn = false;

  // Feature flags
  let enableThumbnails = false;
  let darkreelConfigured = false;
  let isAdmin = false;
  let currentUserId = null;
  let vpnAvailable = false;
  let vpnLocation = null;
  let vpnDefault = 'on';
  let vpnCanToggle = false;
  let registrationEnabled = false;

  // Extraction results (in-memory only)
  let extractionResult = null;
  let extractAbort = null;

  function btnLoading(btn) {
    btn.disabled = true;
    btn.dataset.origText = btn.textContent;
    btn.innerHTML = '<div class="btn-spinner"></div>';
  }

  function btnReset(btn) {
    btn.textContent = btn.dataset.origText || '';
    btn.disabled = false;
  }

  // --- Init ---
  checkRegistrationStatus();
  tryEnterApp();

  // --- Recovery code overlay ---
  function showRecoveryCode(code) {
    recoveryCodeDisplay.textContent = code;
    recoveryOverlay.hidden = false;
  }

  recoveryDismiss.addEventListener('click', () => {
    recoveryOverlay.hidden = true;
    recoveryCodeDisplay.textContent = '';
  });

  // --- Auth tabs ---
  function showAuthForm(tab) {
    authError.hidden = true;
    loginForm.hidden = tab !== 'login';
    registerForm.hidden = tab !== 'register';
    recoverForm.hidden = tab !== 'recover';

    // Update tab styles
    for (const t of authContainer.querySelectorAll('.auth-tab')) {
      t.classList.toggle('active', t.dataset.tab === tab);
    }
  }

  for (const tab of authContainer.querySelectorAll('.auth-tab')) {
    tab.addEventListener('click', () => showAuthForm(tab.dataset.tab));
  }

  $('#recover-link').addEventListener('click', (e) => {
    e.preventDefault();
    showAuthForm('recover');
  });

  $('#back-to-login').addEventListener('click', (e) => {
    e.preventDefault();
    showAuthForm('login');
  });

  // --- Registration status ---
  async function checkRegistrationStatus() {
    try {
      const res = await fetch('/auth/registration');
      if (res.ok) {
        const data = await res.json();
        registrationEnabled = data.enabled;
        registerTab.hidden = !registrationEnabled;
        // Hide entire tab bar when only one tab is visible (registration disabled)
        $('.auth-tabs').hidden = !registrationEnabled;
      }
    } catch {}
  }

  // --- Login ---
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.hidden = true;
    const btn = loginForm.querySelector('button');
    btnLoading(btn);

    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: $('#username').value,
          password: $('#password').value,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        authError.textContent = data.error || 'Login failed';
        authError.hidden = false;
        return;
      }

      loggedIn = true;
      showApp();
    } catch (err) {
      console.error('Login error:', err);
      authError.textContent = 'Connection failed';
      authError.hidden = false;
    } finally {
      btnReset(btn);
    }
  });

  // --- Register ---
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.hidden = true;

    const pw = $('#reg-password').value;
    const pwConfirm = $('#reg-password-confirm').value;
    if (pw !== pwConfirm) {
      authError.textContent = 'Passwords do not match';
      authError.hidden = false;
      return;
    }

    const btn = registerForm.querySelector('button');
    btnLoading(btn);

    try {
      const res = await fetch('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: $('#reg-username').value,
          password: pw,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        authError.textContent = data.error || 'Registration failed';
        authError.hidden = false;
        return;
      }

      // Show recovery code
      showRecoveryCode(data.data.recovery_code);

      // Clear form and switch to login
      $('#reg-username').value = '';
      $('#reg-password').value = '';
      $('#reg-password-confirm').value = '';
      showAuthForm('login');
    } catch (err) {
      console.error('Register error:', err);
      authError.textContent = 'Connection failed';
      authError.hidden = false;
    } finally {
      btnReset(btn);
    }
  });

  // --- Recovery ---
  recoverForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.hidden = true;

    const pw = $('#rec-password').value;
    const pwConfirm = $('#rec-password-confirm').value;
    if (pw !== pwConfirm) {
      authError.textContent = 'Passwords do not match';
      authError.hidden = false;
      return;
    }

    const btn = recoverForm.querySelector('button');
    btnLoading(btn);

    try {
      const res = await fetch('/auth/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: $('#rec-username').value,
          recoveryCode: $('#rec-code').value.trim(),
          newPassword: pw,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        authError.textContent = data.error || 'Recovery failed';
        authError.hidden = false;
        return;
      }

      // Show new recovery code
      showRecoveryCode(data.data.recovery_code);

      // Clear form and switch to login
      $('#rec-username').value = '';
      $('#rec-code').value = '';
      $('#rec-password').value = '';
      $('#rec-password-confirm').value = '';
      showAuthForm('login');
    } catch (err) {
      console.error('Recovery error:', err);
      authError.textContent = 'Connection failed';
      authError.hidden = false;
    } finally {
      btnReset(btn);
    }
  });

  // --- Logout ---
  logoutBtn.addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' }).catch(() => {});
    logout();
  });

  // --- Extract ---
  submitForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const urlInput = $('#video-url');
    const btn = submitForm.querySelector('button');
    const url = urlInput.value.trim();
    if (!url) return;

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Extracting...';
    extractError.hidden = true;

    // Check if URL is a direct link to a media file
    const directMatch = isDirectMediaUrl(url);
    if (directMatch) {
      extractionResult = { videos: [directMatch], pageTitle: '' };
      urlInput.value = '';
      showResultsStreaming();
      removeLoadingIndicator();
      addVideoCard(directMatch, 0);
      const card = resultsList.querySelector('[data-vid-idx="0"]');
      if (card) card.querySelectorAll('.btn-download, .btn-upload').forEach(b => { b.disabled = false; });
      const spinner = resultsList.querySelector('[data-probe-spinner="0"]');
      if (spinner) spinner.remove();
      updateResultsTitle();
      btn.disabled = false;
      btn.textContent = 'Extract';
      return;
    }

    if (extractAbort) extractAbort.abort();
    extractAbort = new AbortController();

    extractionResult = { videos: [], pageTitle: '' };
    urlInput.value = '';
    showResultsStreaming();

    try {
      const useVpn = (vpnAvailable && vpnCanToggle) ? $('#use-vpn').checked : undefined;
      const includeImages = $('#include-images')?.checked || false;
      const res = await api('/extract/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, useVpn, includeImages }),
        signal: extractAbort.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.error === 'Unauthorized') { logout(); return; }
        extractError.textContent = data.error || 'Extraction failed';
        extractError.hidden = false;
        hideResults();
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parsed = parseSSEEvents(buffer);
        buffer = parsed.remainder;

        for (const evt of parsed.events) {
          if (evt.event === 'video') {
            const video = JSON.parse(evt.data);
            extractionResult.videos.push(video);
            addVideoCard(video, video._idx ?? extractionResult.videos.length - 1);
          } else if (evt.event === 'metadata') {
            const meta = JSON.parse(evt.data);
            updateVideoMeta(meta._idx, meta);
          } else if (evt.event === 'done') {
            const info = JSON.parse(evt.data);
            extractionResult.pageTitle = info.pageTitle || '';
            removeLoadingIndicator();
            updateResultsTitle();
          } else if (evt.event === 'error') {
            const info = JSON.parse(evt.data);
            if (extractionResult.videos.length === 0) {
              extractError.textContent = info.error || 'Extraction failed';
              extractError.hidden = false;
              hideResults();
            }
          }
        }
      }

      if (extractionResult.videos.length === 0) {
        resultsList.innerHTML = '<p class="empty">No videos found on this page</p>';
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (extractionResult && extractionResult.videos.length === 0) {
        extractError.textContent = 'Connection failed';
        extractError.hidden = false;
        hideResults();
      }
    } finally {
      extractAbort = null;
      removeLoadingIndicator();
      btn.disabled = false;
      btn.textContent = 'Extract';
    }
  });

  // --- Back button ---
  backBtn.addEventListener('click', () => {
    if (extractAbort) {
      extractAbort.abort();
      extractAbort = null;
    }
    extractionResult = null;
    hideResults();
    const btn = submitForm.querySelector('button');
    btn.disabled = false;
    btn.textContent = 'Extract';
  });

  // --- Results rendering ---
  function showResultsStreaming() {
    submitSection.hidden = true;
    resultsSection.hidden = false;
    const searchLabel = $('#include-images')?.checked ? 'Searching for videos and images...' : 'Searching for videos...';
    resultsList.innerHTML = '<div class="results-loading"><span class="spinner"></span> ' + searchLabel + '</div>';
    updateResultsTitle();
  }

  function updateResultsTitle() {
    const videoCount = resultsList.querySelectorAll('.video-card').length;
    const imageCount = imagesList.querySelectorAll('.video-card').length;
    const total = videoCount + imageCount;
    if (total > 0) {
      const parts = [];
      if (videoCount > 0) parts.push(`${videoCount} video${videoCount !== 1 ? 's' : ''}`);
      if (imageCount > 0) parts.push(`${imageCount} image${imageCount !== 1 ? 's' : ''}`);
      resultsTitle.textContent = parts.join(', ') + ' found';
    } else if (extractionResult) {
      resultsTitle.textContent = 'Extracting...';
    }
  }

  function addVideoCard(v, idx) {
    const placeholder = resultsList.querySelector('.empty');
    if (placeholder) placeholder.remove();

    let domain = '';
    try { domain = new URL(v.url).hostname; } catch {}

    let thumbHtml = '';
    if (v.mediaKind === 'image' || enableThumbnails) {
      thumbHtml = `<div class="thumb-wrapper"><span class="spinner-mini thumb-spinner"></span><img class="video-thumb" loading="lazy" src="/thumbnail?videoUrl=${encodeURIComponent(v.url)}" alt="" width="160" height="90"></div>`;
    }

    const qualityBadge = v.quality
      ? `<span class="quality-badge">${esc(v.quality)}</span>`
      : '';

    const uploadBtn = darkreelConfigured
      ? `<button class="btn-upload" data-idx="${idx}">Upload to Darkreel</button>`
      : '';

    const card = document.createElement('div');
    card.className = 'video-card';
    card.dataset.vidIdx = String(idx);
    card.innerHTML = `
      ${thumbHtml}
      <div class="video-info">
        <div class="video-tags" data-tags-idx="${idx}">
          <span class="type-badge badge-${esc(v.type)}">${esc(v.type)}</span>
          ${qualityBadge}
          ${v.fileExtension ? `<span class="quality-badge">${esc(v.fileExtension)}</span>` : ''}
          <span class="spinner-mini" data-probe-spinner="${idx}"></span>
        </div>
        <div class="video-domain">${esc(domain)}</div>
        <div class="video-actions">
          <button class="btn-download" data-idx="${idx}" disabled>Download</button>
          ${uploadBtn.replace('class="btn-upload"', 'class="btn-upload" disabled')}
        </div>
      </div>
    `;

    card.querySelector('.btn-download')?.addEventListener('click', (e) => handleDownload(e.target));
    card.querySelector('.btn-upload')?.addEventListener('click', (e) => handleUpload(e.target));
    const thumb = card.querySelector('.video-thumb');
    const thumbSpinner = card.querySelector('.thumb-spinner');
    if (thumb) {
      thumb.addEventListener('load', () => { if (thumbSpinner) thumbSpinner.style.display = 'none'; });
      thumb.addEventListener('error', () => { const w = card.querySelector('.thumb-wrapper'); if (w) w.style.display = 'none'; });
    }

    if (v.mediaKind === 'image') {
      imagesList.appendChild(card);
      imagesSection.hidden = false;
      imagesCount.textContent = imagesList.children.length;
    } else {
      const loader = resultsList.querySelector('.results-loading');
      if (loader) {
        resultsList.insertBefore(card, loader);
      } else {
        resultsList.appendChild(card);
      }
    }
    updateResultsTitle();
  }

  function removeLoadingIndicator() {
    const loader = resultsList.querySelector('.results-loading');
    if (loader) loader.remove();
  }

  function updateVideoMeta(idx, meta) {
    const card = resultsList.querySelector(`[data-vid-idx="${idx}"]`)
              || imagesList.querySelector(`[data-vid-idx="${idx}"]`)
              || filteredList.querySelector(`[data-vid-idx="${idx}"]`);
    if (!card) return;

    const tagsRow = card.querySelector(`[data-tags-idx="${idx}"]`);
    if (!tagsRow) return;

    const spinner = tagsRow.querySelector(`[data-probe-spinner="${idx}"]`);
    if (spinner) spinner.remove();
    card.querySelectorAll('.btn-download, .btn-upload').forEach((btn) => { btn.disabled = false; });

    if (meta.quality && !tagsRow.querySelector('.quality-badge')) {
      const span = document.createElement('span');
      span.className = 'quality-badge';
      span.textContent = meta.quality;
      tagsRow.appendChild(span);
    }

    if (meta.durationSec) {
      const span = document.createElement('span');
      span.className = 'meta-tag';
      span.textContent = formatDuration(meta.durationSec);
      tagsRow.appendChild(span);
    }

    if (meta.fileSize) {
      const span = document.createElement('span');
      span.className = 'meta-tag';
      span.textContent = formatSize(meta.fileSize);
      tagsRow.appendChild(span);
    }

    const isTiny = meta.fileSize && meta.fileSize < 5120;
    const isFlash = meta.durationSec && meta.durationSec <= 2;
    if (isTiny || isFlash) {
      moveToFiltered(card);
    }
  }

  function moveToFiltered(card) {
    if (!resultsList.contains(card) && !imagesList.contains(card)) return;
    const wasImage = imagesList.contains(card);
    card.remove();
    filteredList.appendChild(card);
    filteredSection.hidden = false;
    filteredCount.textContent = filteredList.children.length;
    if (wasImage) {
      imagesCount.textContent = imagesList.children.length;
      if (imagesList.children.length === 0) imagesSection.hidden = true;
    }
    updateResultsTitle();
  }

  function hideResults() {
    resultsSection.hidden = true;
    submitSection.hidden = false;
    resultsList.innerHTML = '';
    imagesList.innerHTML = '';
    imagesSection.hidden = true;
    imagesCount.textContent = '0';
    filteredList.innerHTML = '';
    filteredSection.hidden = true;
    filteredCount.textContent = '0';
  }

  // --- Download to browser ---
  async function handleDownload(btn) {
    const idx = parseInt(btn.dataset.idx, 10);
    const video = extractionResult?.videos?.[idx];
    if (!video) return;

    btn.disabled = true;
    btn.className = 'btn-downloading';
    btn.textContent = 'Downloading...';

    try {
      const useVpn = (vpnAvailable && vpnCanToggle) ? $('#use-vpn').checked : undefined;
      const isImage = video.mediaKind === 'image';
      const ext = video.fileExtension || (isImage ? '.jpg' : '.mp4');
      const defaultName = (isImage ? 'image' : 'video') + ext;

      const res = await api('/stream-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl: video.url, useVpn }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Download failed');
        return;
      }

      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = defaultName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);

      btn.textContent = 'Downloaded';
    } catch {
      alert('Download failed');
    } finally {
      btn.disabled = false;
      btn.className = 'btn-download';
      setTimeout(() => { btn.textContent = 'Download'; }, 3000);
    }
  }

  // --- Upload to Darkreel ---
  async function handleUpload(btn) {
    const idx = parseInt(btn.dataset.idx, 10);
    const video = extractionResult?.videos?.[idx];
    if (!video) return;

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-mini"></span> Sending...';

    try {
      const useVpn = (vpnAvailable && vpnCanToggle) ? $('#use-vpn').checked : undefined;
      const res = await api('/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl: video.url, useVpn }),
      });

      if (res.ok) {
        btn.textContent = 'Sent';
      } else {
        const data = await res.json().catch(() => ({}));
        if (data.error === 'Unauthorized') { logout(); return; }
        btn.textContent = 'Failed';
        btn.disabled = false;
      }
    } catch {
      btn.textContent = 'Failed';
      btn.disabled = false;
      btn.textContent = 'Upload to Darkreel';
    }
  }

  // --- Helpers ---
  async function tryEnterApp() {
    try {
      const res = await api('/config');
      if (res.ok) {
        showApp();
      } else {
        logout();
      }
    } catch {
      logout();
    }
  }

  async function fetchConfig() {
    try {
      const res = await api('/config');
      if (res.ok) {
        const data = await res.json();
        enableThumbnails = data.enableThumbnails ?? false;
        darkreelConfigured = data.darkreelConfigured ?? false;
        registrationEnabled = data.registrationEnabled ?? false;
        isAdmin = data.isAdmin ?? false;
        currentUserId = data.userId ?? null;
        vpnAvailable = data.vpn?.available ?? false;
        vpnLocation = data.vpn?.location ?? null;
        vpnDefault = data.vpn?.default ?? 'on';
        vpnCanToggle = data.vpn?.canToggle ?? false;
        adminBtn.hidden = !isAdmin;
        const vpnToggle = $('#vpn-toggle');
        vpnToggle.hidden = !vpnAvailable || !vpnCanToggle;
        if (vpnAvailable) {
          $('#use-vpn').checked = vpnDefault === 'on';
        }
      }
    } catch {}
  }

  function showLogin() {
    appView.hidden = true;
    loginView.hidden = false;
    showAuthForm('login');
    checkRegistrationStatus();
  }

  async function showApp() {
    loginView.hidden = true;
    appView.hidden = false;
    await fetchConfig();

    const savedView = sessionStorage.getItem('ppvda_view');
    if (savedView === 'settings') {
      submitSection.hidden = true;
      settingsSection.hidden = false;
    } else if (savedView === 'admin' && isAdmin) {
      submitSection.hidden = true;
      adminSection.hidden = false;
      loadUsers();
    }
  }

  function logout() {
    loggedIn = false;
    extractionResult = null;
    sessionStorage.removeItem('ppvda_view');
    hideResults();
    settingsSection.hidden = true;
    adminSection.hidden = true;
    submitSection.hidden = false;
    $('#username').value = '';
    $('#password').value = '';
    showLogin();
  }

  function api(path, opts = {}) {
    const headers = { ...opts.headers };
    return fetch(path, { ...opts, headers, credentials: 'same-origin' });
  }

  const DIRECT_VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.avi', '.flv', '.mkv', '.m3u8', '.mpd'];
  const DIRECT_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp'];

  function isDirectMediaUrl(url) {
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      const dot = pathname.lastIndexOf('.');
      if (dot === -1) return null;
      const ext = pathname.substring(dot);

      if (DIRECT_VIDEO_EXTS.includes(ext)) {
        return { url, type: 'direct', mediaKind: 'video', fileExtension: ext, discoveredVia: 'direct' };
      }
      if (DIRECT_IMAGE_EXTS.includes(ext)) {
        return { url, type: 'image', mediaKind: 'image', fileExtension: ext, discoveredVia: 'direct' };
      }
    } catch {}
    return null;
  }

  function esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  function formatDuration(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function parseSSEEvents(buffer) {
    const events = [];
    const blocks = buffer.split('\n\n');
    const remainder = blocks.pop() || '';

    for (const block of blocks) {
      if (!block.trim()) continue;
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) {
          event = line.slice(7);
        } else if (line.startsWith('data: ')) {
          data = line.slice(6);
        }
      }
      if (data) events.push({ event, data });
    }
    return { events, remainder };
  }

  // --- Settings ---
  function showMainView() {
    submitSection.hidden = false;
    settingsSection.hidden = true;
    adminSection.hidden = true;
    sessionStorage.setItem('ppvda_view', 'main');
  }

  settingsBtn.addEventListener('click', async () => {
    submitSection.hidden = true;
    resultsSection.hidden = true;
    adminSection.hidden = true;
    settingsSection.hidden = false;
    sessionStorage.setItem('ppvda_view', 'settings');
    await refreshDarkreelStatus();
  });

  settingsBackBtn.addEventListener('click', () => {
    settingsSection.hidden = true;
    showMainView();
  });

  // --- Darkreel Connect flow (Shape 2) ---

  // Fills the "client URL" hint in the Authorize instructions with whatever
  // origin the user is on. PPVDA self-hosters see their actual URL, which is
  // the value they'll type into Darkreel's "Authorize an App" form.
  const ppvdaClientUrlEl = $('#dr-client-url');
  if (ppvdaClientUrlEl) ppvdaClientUrlEl.textContent = window.location.origin;

  async function refreshDarkreelStatus() {
    const status = $('#dr-status');
    status.hidden = true;
    try {
      const res = await api('/settings/darkreel');
      if (!res.ok) return;
      const { data } = await res.json();
      setDarkreelConnectedState(!!data.configured, data);
      darkreelConfigured = !!data.configured;
    } catch {
      // Fall through — keep whatever state is shown; user can retry.
    }
  }

  function setDarkreelConnectedState(connected, data) {
    $('#dr-disconnected').hidden = connected;
    $('#dr-connected').hidden = !connected;
    if (connected && data) {
      $('#dr-connected-server').textContent = data.server_url ?? '';
      $('#dr-connected-uid').textContent = (data.darkreel_user_id ?? '').slice(0, 8) + '…';
      $('#dr-connected-at').textContent = data.connected_at ?? 'recently';
    }
  }

  // Show the "go generate a code" hint once the user has typed a plausible URL.
  const drServerInput = $('#dr-server');
  const drAuthHint = $('#dr-auth-hint');
  drServerInput.addEventListener('input', () => {
    const val = drServerInput.value.trim();
    drAuthHint.hidden = !(val.startsWith('http://') || val.startsWith('https://'));
  });

  // Connect form submission: exchange code + public key, server persists
  // the encrypted refresh token.
  $('#darkreel-connect-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = $('#dr-status');
    status.hidden = true;
    const btn = e.target.querySelector('button');
    btnLoading(btn);

    const server = drServerInput.value.trim();
    const code = $('#dr-auth-code').value.trim();
    if (!server || !code) {
      status.textContent = 'Enter both the server URL and the authorization code.';
      status.className = 'settings-status error';
      status.hidden = false;
      btnReset(btn);
      return;
    }

    try {
      const res = await api('/settings/darkreel/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_url: server, authorization_code: code }),
      });

      if (res.ok) {
        status.textContent = 'Connected to Darkreel';
        status.className = 'settings-status success';
        status.hidden = false;
        darkreelConfigured = true;
        $('#dr-auth-code').value = '';
        // Re-fetch status to populate the connected panel with the server's
        // authoritative values rather than trusting the POST response.
        await refreshDarkreelStatus();
      } else {
        const data = await res.json().catch(() => ({}));
        status.textContent = data.error || 'Failed to connect';
        status.className = 'settings-status error';
        status.hidden = false;
      }
    } catch {
      status.textContent = 'Connection failed';
      status.className = 'settings-status error';
      status.hidden = false;
    } finally {
      btnReset(btn);
    }
  });

  // Disconnect: drop the local delegation row. Does NOT revoke server-side;
  // user revokes from Darkreel's "Connected Apps" if they want server-side
  // invalidation too.
  $('#dr-disconnect-btn').addEventListener('click', async () => {
    const status = $('#dr-status');
    status.hidden = true;
    const btn = $('#dr-disconnect-btn');
    btnLoading(btn);
    try {
      const res = await api('/settings/darkreel', { method: 'DELETE' });
      if (res.ok) {
        status.textContent = 'Disconnected. Revoke at Darkreel Settings → Connected Apps for full server-side revocation.';
        status.className = 'settings-status success';
        status.hidden = false;
        darkreelConfigured = false;
        setDarkreelConnectedState(false);
      }
    } catch {
      status.textContent = 'Failed to disconnect';
      status.className = 'settings-status error';
      status.hidden = false;
    } finally {
      btnReset(btn);
    }
  });

  // Change password form
  $('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = $('#pw-status');
    status.hidden = true;

    const newPw = $('#new-password').value;
    const confirmPw = $('#confirm-new-password').value;
    if (newPw !== confirmPw) {
      status.textContent = 'Passwords do not match';
      status.className = 'settings-status error';
      status.hidden = false;
      return;
    }

    const btn = e.target.querySelector('button');
    btnLoading(btn);

    try {
      const res = await api('/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oldPassword: $('#old-password').value,
          newPassword: newPw,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        status.textContent = 'Password changed';
        status.className = 'settings-status success';
        $('#old-password').value = '';
        $('#new-password').value = '';
        $('#confirm-new-password').value = '';

        // Show new recovery code
        if (data.data?.recovery_code) {
          showRecoveryCode(data.data.recovery_code);
        }
      } else {
        status.textContent = data.error || 'Failed';
        status.className = 'settings-status error';
      }
      status.hidden = false;
    } catch {
      status.textContent = 'Connection failed';
      status.className = 'settings-status error';
      status.hidden = false;
    } finally {
      btnReset(btn);
    }
  });

  // Delete account
  $('#delete-account-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = $('#delete-account-status');
    status.hidden = true;

    if (!confirm('Are you sure you want to delete your account? This cannot be undone.')) return;

    const btn = e.target.querySelector('button');
    btnLoading(btn);

    try {
      const res = await api('/auth/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('#delete-account-pw').value }),
      });

      if (res.ok) {
        sessionStorage.removeItem('ppvda_view');
        logout();
      } else {
        const data = await res.json().catch(() => ({}));
        status.textContent = data.error || 'Failed to delete account';
        status.className = 'settings-status error';
        status.hidden = false;
      }
    } catch {
      status.textContent = 'Connection failed';
      status.className = 'settings-status error';
      status.hidden = false;
    } finally {
      btnReset(btn);
    }
  });

  // --- Admin ---
  adminBtn.addEventListener('click', async () => {
    submitSection.hidden = true;
    resultsSection.hidden = true;
    settingsSection.hidden = true;
    adminSection.hidden = false;
    sessionStorage.setItem('ppvda_view', 'admin');
    if (vpnAvailable) {
      $('#vpn-perms-section').hidden = false;
      $('#vpn-admin-section').hidden = false;
    }
    const tasks = [loadUsers(), loadRegistrationStatus()];
    if (vpnAvailable) {
      tasks.push(loadVpnRelays(), loadVpnPermissions());
    }
    await Promise.all(tasks);
  });

  adminBackBtn.addEventListener('click', () => {
    adminSection.hidden = true;
    showMainView();
  });

  async function loadUsers() {
    const list = $('#user-list');
    try {
      const res = await api('/admin/users');
      if (!res.ok) return;
      const data = await res.json();
      const users = data.data || [];

      if (users.length === 0) {
        list.innerHTML = '<p class="empty">No users</p>';
        return;
      }

      list.innerHTML = users.map((u) => `
        <div class="user-card">
          <div class="user-card-info">
            ${esc(u.username)}
            ${u.is_admin ? '<span class="admin-badge">Admin</span>' : ''}
          </div>
          ${u.id === currentUserId ? '<span style="font-size:0.75rem;color:var(--text-muted)">You</span>' : '<button class="btn-danger" data-delete-user="' + esc(u.id) + '">Delete</button>'}
        </div>
      `).join('');

      list.querySelectorAll('[data-delete-user]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this user?')) return;
          btnLoading(btn);
          const userId = btn.dataset.deleteUser;
          try {
            const res = await api(`/admin/users/${userId}`, { method: 'DELETE' });
            if (res.ok) { await loadUsers(); if (vpnAvailable) await loadVpnPermissions(); }
          } finally {
            btnReset(btn);
          }
        });
      });
    } catch {}
  }

  // --- Registration toggle ---
  async function loadRegistrationStatus() {
    try {
      const res = await api('/auth/registration');
      if (res.ok) {
        const data = await res.json();
        $('#registration-select').value = data.enabled ? 'true' : 'false';
      }
    } catch {}
  }

  $('#registration-save-btn').addEventListener('click', async () => {
    const status = $('#registration-status');
    const btn = $('#registration-save-btn');
    const enabled = $('#registration-select').value === 'true';
    btnLoading(btn);
    try {
      const res = await api('/admin/registration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) {
        registrationEnabled = enabled;
        registerTab.hidden = !registrationEnabled;
        $('.auth-tabs').hidden = !registrationEnabled;
        status.textContent = `Registration ${enabled ? 'enabled' : 'disabled'}`;
        status.className = 'settings-status success';
      } else {
        status.textContent = 'Failed to save';
        status.className = 'settings-status error';
      }
      status.hidden = false;
    } catch {
      status.textContent = 'Connection failed';
      status.className = 'settings-status error';
      status.hidden = false;
    } finally {
      btnReset(btn);
    }
  });

  // Create user form
  $('#create-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = $('#create-user-status');
    status.hidden = true;

    const btn = e.target.querySelector('button');
    btnLoading(btn);

    try {
      const res = await api('/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: $('#new-user-name').value,
          password: $('#new-user-pass').value,
          isAdmin: $('#new-user-admin').checked,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        status.textContent = `User "${data.data?.username}" created`;
        status.className = 'settings-status success';
        $('#new-user-name').value = '';
        $('#new-user-pass').value = '';
        $('#new-user-admin').checked = false;
        await loadUsers();
        if (vpnAvailable) await loadVpnPermissions();

        // Show recovery code for the new user
        if (data.data?.recovery_code) {
          showRecoveryCode(data.data.recovery_code);
        }
      } else {
        status.textContent = data.error || 'Failed';
        status.className = 'settings-status error';
      }
      status.hidden = false;
    } catch {
      status.textContent = 'Connection failed';
      status.className = 'settings-status error';
      status.hidden = false;
    } finally {
      btnReset(btn);
    }
  });

  // --- Admin VPN Permissions ---
  async function loadVpnPermissions() {
    const section = $('#vpn-perms-section');
    try {
      const [permsRes, usersRes] = await Promise.all([
        api('/admin/vpn/permissions'),
        api('/admin/users'),
      ]);
      if (!permsRes.ok || !usersRes.ok) { section.hidden = true; return; }

      const permsData = await permsRes.json();
      const usersData = await usersRes.json();
      const toggleIds = new Set(permsData.data?.toggleUserIds ?? []);
      const users = usersData.data ?? [];

      $('#vpn-default-select').value = permsData.data?.vpnDefault ?? 'on';

      const list = $('#vpn-user-toggle-list');
      if (users.length === 0) {
        list.innerHTML = '<p class="empty">No users</p>';
      } else {
        list.innerHTML = users.map((u) => {
          const checked = u.is_admin || toggleIds.has(u.id);
          const disabled = u.is_admin;
          return `<div class="user-card">
            <div class="user-card-info">
              ${esc(u.username)}
              ${u.is_admin ? '<span class="admin-badge">Admin</span>' : ''}
            </div>
            <label class="checkbox-label">
              <input type="checkbox" data-vpn-user="${esc(u.id)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}> Can toggle VPN
            </label>
          </div>`;
        }).join('');

        list.querySelectorAll('[data-vpn-user]').forEach((cb) => {
          if (cb.disabled) return;
          cb.addEventListener('change', async () => {
            await api('/admin/vpn/user-toggle', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId: cb.dataset.vpnUser, allowed: cb.checked }),
            });
          });
        });
      }

      section.hidden = false;
    } catch {
      section.hidden = true;
    }
  }

  $('#vpn-default-save-btn').addEventListener('click', async () => {
    const status = $('#vpn-default-status');
    const btn = $('#vpn-default-save-btn');
    const value = $('#vpn-default-select').value;
    btnLoading(btn);
    try {
      const res = await api('/admin/vpn/default', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vpnDefault: value }),
      });
      if (res.ok) {
        vpnDefault = value;
        status.textContent = `Default set to VPN ${value.toUpperCase()}`;
        status.className = 'settings-status success';
      } else {
        status.textContent = 'Failed to save';
        status.className = 'settings-status error';
      }
      status.hidden = false;
    } catch {
      status.textContent = 'Connection failed';
      status.className = 'settings-status error';
      status.hidden = false;
    } finally {
      btnReset(btn);
    }
  });

  // --- Admin VPN Country ---
  async function loadVpnRelays() {
    const section = $('#vpn-admin-section');
    const select = $('#vpn-country-select');

    try {
      const res = await api('/admin/vpn/relays');
      if (!res.ok) { section.hidden = true; return; }
      const data = await res.json();
      const relays = data.data?.relays ?? [];
      const current = data.data?.currentLocation ?? '';

      select.innerHTML = '';
      for (const country of relays) {
        if (country.cities.length === 1) {
          const opt = document.createElement('option');
          opt.value = `${country.code}-${country.cities[0].code}`;
          opt.textContent = `${country.name} — ${country.cities[0].name}`;
          if (opt.value === current || country.code === current) opt.selected = true;
          select.appendChild(opt);
        } else {
          for (const city of country.cities) {
            const opt = document.createElement('option');
            opt.value = `${country.code}-${city.code}`;
            opt.textContent = `${country.name} — ${city.name}`;
            if (opt.value === current) opt.selected = true;
            select.appendChild(opt);
          }
        }
      }
      section.hidden = false;
    } catch {
      section.hidden = true;
    }
  }

  $('#vpn-switch-btn').addEventListener('click', async () => {
    const select = $('#vpn-country-select');
    const status = $('#vpn-switch-status');
    const btn = $('#vpn-switch-btn');
    const location = select.value;
    if (!location) return;

    btnLoading(btn);
    status.hidden = true;

    try {
      const res = await api('/admin/vpn/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location }),
      });

      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        vpnLocation = location;
        status.textContent = `Switched to ${data.data?.country} — ${data.data?.city}`;
        status.className = 'settings-status success';
      } else {
        status.textContent = data.error || 'Switch failed';
        status.className = 'settings-status error';
      }
      status.hidden = false;
    } catch {
      status.textContent = 'Connection failed';
      status.className = 'settings-status error';
      status.hidden = false;
    } finally {
      btnReset(btn);
    }
  });
})();
