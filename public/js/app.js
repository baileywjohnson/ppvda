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
  const jobsList = $('#jobs-list');
  const logoutBtn = $('#logout-btn');
  const filteredSection = $('#filtered-section');
  const filteredList = $('#filtered-list');
  const filteredCount = $('#filtered-count');

  let token = localStorage.getItem('ppvda_token');
  let eventSource = null;
  const jobs = new Map();

  // Feature flags (fetched from server)
  let enableThumbnails = false;
  let darkreelEnabled = false;

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

    const uploadBtn = darkreelEnabled
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

  // --- SSE ---
  function connectSSE() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource('/jobs/events?token=' + encodeURIComponent(token));

    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        const id = data.id || data.jobId;
        if (!id) return;

        const existing = jobs.get(id) || {};
        jobs.set(id, { ...existing, ...data, id });
        renderJobs();
      } catch { /* ignore bad messages */ }
    };

    eventSource.onerror = () => {
      console.warn('SSE connection error');
    };
  }

  // --- Jobs rendering ---
  function renderJobs() {
    const sorted = [...jobs.values()].sort(
      (a, b) => new Date(b.createdAt || b.updatedAt || 0).getTime() -
                new Date(a.createdAt || a.updatedAt || 0).getTime()
    );

    if (sorted.length === 0) {
      jobsList.innerHTML = '<p class="empty">No jobs yet</p>';
      return;
    }

    jobsList.innerHTML = sorted.map((job) => {
      const id = job.id || job.jobId;
      const status = job.status;
      const meta = buildMeta(job);
      const errorHtml = job.error ? `<div class="job-error">${esc(job.error)}</div>` : '';

      return `
        <div class="job-card">
          <div>
            <div class="job-id">${esc(id)}</div>
            ${meta ? `<div class="job-meta">${meta}</div>` : ''}
            ${errorHtml}
          </div>
          <span class="job-badge badge-${esc(status)}">${esc(status)}</span>
        </div>
      `;
    }).join('');
  }

  function buildMeta(job) {
    const parts = [];
    if (job.format) parts.push(job.format.toUpperCase());
    if (job.fileSize) parts.push(formatSize(job.fileSize));
    if (job.durationSec) parts.push(formatDuration(job.durationSec));
    return parts.join(' \u00b7 ');
  }

  // --- Helpers ---
  async function tryEnterApp() {
    try {
      const res = await api('/jobs');
      if (res.ok) {
        const data = await res.json();
        if (data.data) {
          for (const job of data.data) {
            jobs.set(job.id, job);
          }
        }
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
        darkreelEnabled = data.darkreelEnabled ?? false;
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
    renderJobs();
    try { connectSSE(); } catch (err) { console.error('SSE connect error:', err); }
  }

  function logout() {
    token = null;
    extractionResult = null;
    localStorage.removeItem('ppvda_token');
    if (eventSource) { eventSource.close(); eventSource = null; }
    jobs.clear();
    hideResults();
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
})();
