(function () {
  const VERSION_RE = /\/(v\d[^/]*)\//;

  function siteRoot() {
    const path = location.pathname;
    const versioned = path.match(/^(.*?\/)v\d[^/]*\//);
    if (versioned) return versioned[1];
    if (path.endsWith('/')) return path;
    const slash = path.lastIndexOf('/');
    return slash >= 0 ? path.slice(0, slash + 1) : '/';
  }

  function currentPage() {
    const parts = location.pathname.split('/').filter(Boolean);
    const last = parts.pop() || 'index.html';
    if (last.endsWith('.html')) return last;
    if (/^v\d/.test(last)) return 'index.html';
    return 'index.html';
  }

  function currentVersion(latest) {
    const match = location.pathname.match(VERSION_RE);
    return match ? match[1] : latest;
  }

  function urlFor(root, version, latest, page) {
    if (version === latest) return root + page;
    return root + version + '/' + page;
  }

  function versionsFromSelect(select) {
    const versions = Array.from(select.options).map(function (opt) {
      return { id: opt.value, label: opt.textContent || opt.value };
    }).filter(function (v) {
      return Boolean(v.id);
    });
    return {
      latest: versions[0] ? versions[0].id : '',
      versions: versions,
    };
  }

  function fillSelect(select, data, current) {
    select.innerHTML = '';
    data.versions.forEach(function (entry) {
      const opt = document.createElement('option');
      opt.value = entry.id;
      opt.textContent = entry.id === data.latest
        ? entry.id + ' (latest)'
        : (entry.label || entry.id);
      if (entry.id === current) opt.selected = true;
      select.appendChild(opt);
    });
  }

  function ensureSelect(header) {
    let select = header.querySelector('select.version-select');
    if (select) return select;
    const label = document.createElement('label');
    label.className = 'version-wrap';
    select = document.createElement('select');
    select.className = 'version-select';
    select.setAttribute('aria-label', 'Documentation version');
    label.appendChild(select);
    header.appendChild(label);
    return select;
  }

  async function loadVersions(root) {
    const res = await fetch(root + 'versions.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('versions.json ' + res.status);
    return res.json();
  }

  async function init() {
    const header = document.querySelector('header .wrap') || document.querySelector('header');
    if (!header) return;
    const select = ensureSelect(header);
    const root = siteRoot();
    let data = versionsFromSelect(select);
    try {
      const remote = await loadVersions(root);
      if (remote && Array.isArray(remote.versions) && remote.versions.length) {
        data = remote;
      }
    } catch (err) {
      /* keep markup fallback */
    }
    if (!data.latest && data.versions[0]) data.latest = data.versions[0].id;
    if (!data.versions.length) return;

    const current = currentVersion(data.latest);
    fillSelect(select, data, current);
    const page = currentPage();

    select.addEventListener('change', function () {
      const dest = urlFor(root, select.value, data.latest, page);
      const here = location.pathname.endsWith('/')
        ? location.pathname + 'index.html'
        : location.pathname;
      const there = dest.endsWith('/') ? dest + 'index.html' : dest;
      if (there !== here) location.href = dest;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
