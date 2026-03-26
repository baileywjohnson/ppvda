(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const loginView = $('#login-view');
  const appView = $('#app-view');
  const loginForm = $('#login-form');
  const loginError = $('#login-error');
  const submitForm = $('#submit-form');
  const jobsList = $('#jobs-list');
  const logoutBtn = $('#logout-btn');

  let token = localStorage.getItem('ppvda_token');
  let eventSource = null;
  const jobs = new Map(); // id -> job data

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
    token = null;
    localStorage.removeItem('ppvda_token');
    if (eventSource) { eventSource.close(); eventSource = null; }
    jobs.clear();
    showLogin();
  });

  // --- Submit ---
  submitForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const urlInput = $('#video-url');
    const btn = submitForm.querySelector('button');
    const url = urlInput.value.trim();
    if (!url) return;

    btn.disabled = true;
    try {
      const res = await api('/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      if (res.ok) {
        urlInput.value = '';
      } else {
        const data = await res.json().catch(() => ({}));
        if (data.error === 'Unauthorized') { logout(); return; }
        alert(data.error || 'Failed to create job');
      }
    } catch {
      alert('Connection failed');
    } finally {
      btn.disabled = false;
    }
  });

  // --- SSE ---
  function connectSSE() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource('/jobs/events?token=' + encodeURIComponent(token));

    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        // Could be a full job (from initial state) or an event
        const id = data.id || data.jobId;
        if (!id) return;

        const existing = jobs.get(id) || {};
        jobs.set(id, { ...existing, ...data, id });
        renderJobs();
      } catch { /* ignore bad messages */ }
    };

    eventSource.onerror = () => {
      // EventSource auto-reconnects by default; only close on persistent failure
      console.warn('SSE connection error');
    };
  }

  // --- Render ---
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
    return parts.join(' · ');
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

  function showLogin() {
    loginView.hidden = false;
    appView.hidden = true;
  }

  function showApp() {
    loginView.hidden = true;
    appView.hidden = false;
    renderJobs();
    try { connectSSE(); } catch (err) { console.error('SSE connect error:', err); }
  }

  function logout() {
    token = null;
    localStorage.removeItem('ppvda_token');
    if (eventSource) { eventSource.close(); eventSource = null; }
    jobs.clear();
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
