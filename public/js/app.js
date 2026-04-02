(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const loginView = $('#login-view');
  const appView = $('#app-view');
  const loginForm = $('#login-form');
  const loginError = $('#login-error');
  const submitSection = $('#submit-section');
  const submitForm = $('#submit-form');
  const extractError = $('#extract-error');
  const resultsSection = $('#results-section');
  const resultsList = $('#results-list');
  const resultsTitle = $('#results-title');
  const backBtn = $('#back-btn');
  const logoutBtn = $('#logout-btn');
  const filteredSection = $('#filtered-section');
  const filteredList = $('#filtered-list');
  const filteredCount = $('#filtered-count');
  const settingsBtn = $('#settings-btn');
  const settingsSection = $('#settings-section');
  const settingsBackBtn = $('#settings-back-btn');
  const adminBtn = $('#admin-btn');
  const adminSection = $('#admin-section');
  const adminBackBtn = $('#admin-back-btn');

  let token = localStorage.getItem('ppvda_token');

  // Feature flags (fetched from server)
  let enableThumbnails = false;
  let darkreelConfigured = false;
  let isAdmin = false;

  // Extraction results (in-memory only, never persisted)
  let extractionResult = null;

  // --- Init ---
  if (token) {
    tryEnterApp();
  } else {
    showLogin();
  }

  // --- Auth ---
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.hidden = true;
    const btn = loginForm.querySelector('button');
    btn.disabled = true;

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
        loginError.textContent = data.error || 'Login failed';
        loginError.hidden = false;
        return;
      }

      token = data.token;
      localStorage.setItem('ppvda_token', token);
      showApp();
    } catch (err) {
      console.error('Login error:', err);
      loginError.textContent = 'Connection failed';
      loginError.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

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

    // Switch to results view immediately with empty list
    extractionResult = { videos: [], pageTitle: '' };
    urlInput.value = '';
    showResultsStreaming();

    try {
      const res = await api('/extract/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
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

      // If no videos found at all
      if (extractionResult.videos.length === 0) {
        resultsList.innerHTML = '<p class="empty">No videos found on this page</p>';
      }
    } catch {
      if (extractionResult.videos.length === 0) {
        extractError.textContent = 'Connection failed';
        extractError.hidden = false;
        hideResults();
      }
    } finally {
      removeLoadingIndicator();
      btn.disabled = false;
      btn.textContent = 'Extract';
    }
  });

  // --- Back button ---
  backBtn.addEventListener('click', () => {
    extractionResult = null;
    hideResults();
  });

  // --- Results rendering ---
  function showResultsStreaming() {
    submitSection.hidden = true;
    resultsSection.hidden = false;
    resultsList.innerHTML = '<div class="results-loading"><span class="spinner"></span> Searching for videos...</div>';
    updateResultsTitle();
  }

  function updateResultsTitle() {
    // Count only cards in the main results list (not filtered)
    const mainCount = resultsList.querySelectorAll('.video-card').length;
    const total = extractionResult?.videos?.length ?? 0;
    if (total > 0) {
      resultsTitle.textContent = `${mainCount} video${mainCount !== 1 ? 's' : ''} found`;
    } else {
      resultsTitle.textContent = 'Extracting...';
    }
  }

  function addVideoCard(v, idx) {
    // Remove the "searching" placeholder if it exists
    const placeholder = resultsList.querySelector('.empty');
    if (placeholder) placeholder.remove();

    let domain = '';
    try { domain = new URL(v.url).hostname; } catch {}

    const thumbHtml = enableThumbnails
      ? `<img class="video-thumb" loading="lazy" src="/thumbnail?videoUrl=${encodeURIComponent(v.url)}" alt="" width="160" height="90" onerror="this.style.display='none'">`
      : '';

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

    // Attach handlers to this card's buttons
    card.querySelector('.btn-download')?.addEventListener('click', (e) => handleDownload(e.target));
    card.querySelector('.btn-upload')?.addEventListener('click', (e) => handleUpload(e.target));

    // Insert before the loading indicator (if present), otherwise append
    const loader = resultsList.querySelector('.results-loading');
    if (loader) {
      resultsList.insertBefore(card, loader);
    } else {
      resultsList.appendChild(card);
    }
    updateResultsTitle();
  }

  function removeLoadingIndicator() {
    const loader = resultsList.querySelector('.results-loading');
    if (loader) loader.remove();
  }

  function updateVideoMeta(idx, meta) {
    // Find the card — could be in results or already in filtered
    const card = resultsList.querySelector(`[data-vid-idx="${idx}"]`)
              || filteredList.querySelector(`[data-vid-idx="${idx}"]`);
    if (!card) return;

    const tagsRow = card.querySelector(`[data-tags-idx="${idx}"]`);
    if (!tagsRow) return;

    // Remove the probe spinner and enable action buttons
    const spinner = tagsRow.querySelector(`[data-probe-spinner="${idx}"]`);
    if (spinner) spinner.remove();
    card.querySelectorAll('.btn-download, .btn-upload').forEach((btn) => { btn.disabled = false; });

    // Append quality badge if not already present
    if (meta.quality && !tagsRow.querySelector('.quality-badge')) {
      const span = document.createElement('span');
      span.className = 'quality-badge';
      span.textContent = meta.quality;
      tagsRow.appendChild(span);
    }

    // Append duration
    if (meta.durationSec) {
      const span = document.createElement('span');
      span.className = 'meta-tag';
      span.textContent = formatDuration(meta.durationSec);
      tagsRow.appendChild(span);
    }

    // Append file size
    if (meta.fileSize) {
      const span = document.createElement('span');
      span.className = 'meta-tag';
      span.textContent = formatSize(meta.fileSize);
      tagsRow.appendChild(span);
    }

    // Move tiny files / likely ads to the filtered section
    const isTiny = meta.fileSize && meta.fileSize < 5120;
    const isFlash = meta.durationSec && meta.durationSec <= 2;
    if (isTiny || isFlash) {
      moveToFiltered(card);
    }
  }

  function moveToFiltered(card) {
    // Only move if it's currently in the main results list
    if (!resultsList.contains(card)) return;
    card.remove();
    filteredList.appendChild(card);
    filteredSection.hidden = false;
    filteredCount.textContent = filteredList.children.length;
    updateResultsTitle();
  }

  function hideResults() {
    resultsSection.hidden = true;
    submitSection.hidden = false;
    resultsList.innerHTML = '';
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
      const res = await api('/stream-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl: video.url }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Download failed');
        return;
      }

      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'video.mp4';
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
    btn.textContent = 'Submitting...';

    try {
      const res = await api('/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl: video.url }),
      });

      if (res.ok) {
        btn.textContent = 'Submitted';
      } else {
        const data = await res.json().catch(() => ({}));
        if (data.error === 'Unauthorized') { logout(); return; }
        alert(data.error || 'Failed to create job');
        btn.disabled = false;
        btn.textContent = 'Upload to Darkreel';
      }
    } catch {
      alert('Connection failed');
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
        isAdmin = data.isAdmin ?? false;
        // Show/hide admin button
        adminBtn.hidden = !isAdmin;
      }
    } catch { /* defaults are fine */ }
  }

  function showLogin() {
    loginView.hidden = false;
    appView.hidden = true;
  }

  async function showApp() {
    loginView.hidden = true;
    appView.hidden = false;
    await fetchConfig();
  }

  function logout() {
    token = null;
    extractionResult = null;
    localStorage.removeItem('ppvda_token');
    hideResults();
    // Reset all sections to default state
    settingsSection.hidden = true;
    adminSection.hidden = true;
    submitSection.hidden = false;
    // Clear login form
    $('#username').value = '';
    $('#password').value = '';
    showLogin();
  }

  function api(path, opts = {}) {
    const headers = { ...opts.headers };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetch(path, { ...opts, headers });
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

  // Parse SSE events from a text buffer.
  // Returns { events: [{event, data}], remainder: string }
  function parseSSEEvents(buffer) {
    const events = [];
    const blocks = buffer.split('\n\n');
    // Last element may be incomplete — keep as remainder
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
  }

  settingsBtn.addEventListener('click', async () => {
    submitSection.hidden = true;
    resultsSection.hidden = true;
    adminSection.hidden = true;
    settingsSection.hidden = false;

    // Check if Darkreel creds are configured
    try {
      const res = await api('/settings/darkreel');
      if (res.ok) {
        const data = await res.json();
        const removeBtn = $('#dr-remove-btn');
        removeBtn.hidden = !data.data.configured;
        $('#dr-status').hidden = true;
      }
    } catch {}
  });

  settingsBackBtn.addEventListener('click', () => {
    settingsSection.hidden = true;
    showMainView();
  });

  // Darkreel creds form
  $('#darkreel-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = $('#dr-status');
    status.hidden = true;

    try {
      const res = await api('/settings/darkreel', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          server: $('#dr-server').value,
          username: $('#dr-username').value,
          password: $('#dr-password').value,
        }),
      });

      if (res.ok) {
        status.textContent = 'Credentials saved';
        status.className = 'settings-status success';
        status.hidden = false;
        $('#dr-remove-btn').hidden = false;
        darkreelConfigured = true;
        // Clear the form
        $('#dr-server').value = '';
        $('#dr-username').value = '';
        $('#dr-password').value = '';
      } else {
        const data = await res.json().catch(() => ({}));
        status.textContent = data.error || 'Failed to save';
        status.className = 'settings-status error';
        status.hidden = false;
      }
    } catch {
      status.textContent = 'Connection failed';
      status.className = 'settings-status error';
      status.hidden = false;
    }
  });

  // Remove Darkreel creds
  $('#dr-remove-btn').addEventListener('click', async () => {
    const status = $('#dr-status');
    try {
      const res = await api('/settings/darkreel', { method: 'DELETE' });
      if (res.ok) {
        status.textContent = 'Credentials removed';
        status.className = 'settings-status success';
        status.hidden = false;
        $('#dr-remove-btn').hidden = true;
        darkreelConfigured = false;
      }
    } catch {
      status.textContent = 'Failed to remove';
      status.className = 'settings-status error';
      status.hidden = false;
    }
  });

  // Change password form
  $('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = $('#pw-status');
    status.hidden = true;

    try {
      const res = await api('/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oldPassword: $('#old-password').value,
          newPassword: $('#new-password').value,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        status.textContent = 'Password changed';
        status.className = 'settings-status success';
        $('#old-password').value = '';
        $('#new-password').value = '';
      } else {
        status.textContent = data.error || 'Failed';
        status.className = 'settings-status error';
      }
      status.hidden = false;
    } catch {
      status.textContent = 'Connection failed';
      status.className = 'settings-status error';
      status.hidden = false;
    }
  });

  // --- Admin ---
  adminBtn.addEventListener('click', async () => {
    submitSection.hidden = true;
    resultsSection.hidden = true;
    settingsSection.hidden = true;
    adminSection.hidden = false;
    await loadUsers();
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
          <button class="btn-danger" data-delete-user="${esc(u.id)}" ${u.is_admin ? 'disabled' : ''}>Delete</button>
        </div>
      `).join('');

      list.querySelectorAll('[data-delete-user]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this user?')) return;
          const userId = btn.dataset.deleteUser;
          const res = await api(`/admin/users/${userId}`, { method: 'DELETE' });
          if (res.ok) await loadUsers();
        });
      });
    } catch {}
  }

  // Create user form
  $('#create-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = $('#create-user-status');
    status.hidden = true;

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
      } else {
        status.textContent = data.error || 'Failed';
        status.className = 'settings-status error';
      }
      status.hidden = false;
    } catch {
      status.textContent = 'Connection failed';
      status.className = 'settings-status error';
      status.hidden = false;
    }
  });
})();
