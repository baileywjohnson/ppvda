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

    try {
      const res = await api('/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        if (data.error === 'Unauthorized') { logout(); return; }
        extractError.textContent = data.error || 'Extraction failed';
        extractError.hidden = false;
        return;
      }

      extractionResult = data.data;
      urlInput.value = '';
      showResults();
    } catch {
      extractError.textContent = 'Connection failed';
      extractError.hidden = false;
    } finally {
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
  function showResults() {
    submitSection.hidden = true;
    resultsSection.hidden = false;

    const videos = extractionResult?.videos ?? [];
    const title = extractionResult?.pageTitle;
    resultsTitle.textContent = title
      ? `${videos.length} video${videos.length !== 1 ? 's' : ''} found`
      : 'Extracted Videos';

    if (videos.length === 0) {
      resultsList.innerHTML = '<p class="empty">No videos found on this page</p>';
      return;
    }

    resultsList.innerHTML = videos.map((v, i) => {
      let domain = '';
      try { domain = new URL(v.url).hostname; } catch {}

      const thumbHtml = enableThumbnails
        ? `<img class="video-thumb" loading="lazy" src="/thumbnail?videoUrl=${encodeURIComponent(v.url)}" alt="" width="160" height="90" onerror="this.style.display='none'">`
        : '';

      const qualityBadge = v.quality
        ? `<span class="quality-badge">${esc(v.quality)}</span>`
        : '';

      const uploadBtn = darkreelEnabled
        ? `<button class="btn-upload" data-idx="${i}">Upload to Darkreel</button>`
        : '';

      return `
        <div class="video-card">
          ${thumbHtml}
          <div class="video-info">
            <div class="video-badges">
              <span class="type-badge badge-${esc(v.type)}">${esc(v.type)}</span>
              ${qualityBadge}
              ${v.fileExtension ? `<span class="quality-badge">${esc(v.fileExtension)}</span>` : ''}
            </div>
            <div class="video-domain">${esc(domain)}</div>
            <div class="video-actions">
              <button class="btn-download" data-idx="${i}">Download</button>
              ${uploadBtn}
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Attach action handlers
    resultsList.querySelectorAll('.btn-download').forEach((btn) => {
      btn.addEventListener('click', () => handleDownload(btn));
    });
    resultsList.querySelectorAll('.btn-upload').forEach((btn) => {
      btn.addEventListener('click', () => handleUpload(btn));
    });
  }

  function hideResults() {
    resultsSection.hidden = true;
    submitSection.hidden = false;
    resultsList.innerHTML = '';
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
})();
