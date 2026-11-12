// Progressive enhancement: every form here also works without this file.

const still = matchMedia('(prefers-reduced-motion: reduce)');
const ease = 'cubic-bezier(0.2, 0, 0, 1)';
// Fade an element out, then drop it. The timer removes it even if the tab is hidden and the animation never ends.
function leave(el) {
  if (still.matches) return el.remove();
  el.animate({ opacity: [1, 0], scale: [1, 0.96] }, { duration: 200, easing: ease, fill: 'forwards' });
  setTimeout(() => el.remove(), 200);
}

// The first page after signing in plays the shell reveal; the sign-in pages leave the mark.
try {
  if (document.querySelector('.auth-page')) sessionStorage.setItem('reveal', '1');
  else if (sessionStorage.getItem('reveal')) {
    sessionStorage.removeItem('reveal');
    document.documentElement.classList.add('app-reveal');
  }
} catch { /* storage blocked: no reveal */ }

const post = (form) =>
  fetch(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)), headers: { 'X-Requested-With': 'fetch' } });

// Toggle buttons (watched, later, list membership) update in place.
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-toggle]');
  if (!form) return;
  e.preventDefault();
  const on = form.elements.on;
  const res = await post(form).catch(() => null);
  if (!res || !res.ok) return location.reload();
  const active = on.value === '1';
  on.value = active ? '0' : '1';
  const button = form.querySelector('button');
  button.setAttribute('aria-pressed', active);
  if (!still.matches) button.querySelector('svg')?.animate({ scale: [1, 1.3, 1] }, { duration: 280, easing: ease });
  const card = form.closest('.card');
  if (card) card.classList.toggle(form.dataset.toggle, active);
  if (card && !active && document.body.classList.contains('page-later') && form.dataset.toggle === 'later') leave(card);
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-confirm]');
  if (el && !confirm(el.dataset.confirm)) e.preventDefault();
});

// Validation: a field is checked when you leave it, not while you type, and
// the message says what to do. The browser's own bubbles are switched off.
const fieldName = (el) =>
  (el.getAttribute('aria-label') || el.closest('label')?.firstChild?.textContent || 'value').trim().replace(/\s+/g, ' ').toLowerCase();
function problem(el) {
  const v = el.validity;
  if (v.valid) return '';
  if (el.type === 'checkbox') return 'Tick this box to continue.';
  if (el.type === 'file') return 'Choose a file first.';
  if (v.valueMissing) return `Enter the ${fieldName(el)}.`;
  if (v.typeMismatch && el.type === 'email') return 'Enter an email address like name@example.com.';
  if (v.typeMismatch && el.type === 'url') return 'Enter a full address that starts with https://.';
  if (v.tooShort) return `Use at least ${el.minLength} characters (${el.value.length} so far).`;
  if (v.rangeUnderflow || v.rangeOverflow || v.stepMismatch || v.badInput) return `Enter a whole number from ${el.min} to ${el.max}.`;
  return el.validationMessage;
}
function validate(el) {
  if (!el.willValidate || el.type === 'hidden') return true;
  const text = problem(el);
  const id = el.dataset.errorId;
  let note = id && document.getElementById(id);
  if (!text) {
    note?.remove();
    el.removeAttribute('aria-invalid');
    el.removeAttribute('aria-describedby');
    return true;
  }
  if (!note) {
    note = document.createElement('span');
    note.className = 'field-error';
    note.id = el.dataset.errorId = 'err-' + Math.random().toString(36).slice(2, 8);
    const label = el.closest('label');
    if (label && !label.classList.contains('check')) label.append(note);
    else (label || el.closest('.row') || el).after(note);
    el.setAttribute('aria-describedby', note.id);
  }
  note.textContent = text;
  el.setAttribute('aria-invalid', 'true');
  return false;
}
for (const form of document.querySelectorAll('form[method="post"]')) form.noValidate = true;
document.addEventListener('focusout', (e) => {
  if (e.target.matches?.('input, select') && e.target.form?.noValidate && (e.target.value || e.target.hasAttribute('aria-invalid'))) validate(e.target);
});
// While typing, only clear an error that is already showing.
document.addEventListener('input', (e) => {
  if (e.target.getAttribute?.('aria-invalid') === 'true') validate(e.target);
});

// A form that navigates shows it is working until the next page arrives.
document.addEventListener('submit', (e) => {
  const form = e.target;
  if (e.defaultPrevented) return;
  if (form.noValidate) {
    const bad = [...form.elements].filter((el) => !validate(el));
    if (bad.length) {
      e.preventDefault();
      bad[0].focus();
      bad[0].classList.remove('shake');
      void bad[0].offsetWidth;
      bad[0].classList.add('shake');
      return;
    }
  }
  if (form.matches('[data-toggle], [role="search"]')) return;
  form.classList.add('busy');
  (e.submitter || form.querySelector('button'))?.setAttribute('aria-busy', 'true');
});
window.addEventListener('pageshow', () =>
  document.querySelectorAll('form.busy').forEach((f) => {
    f.classList.remove('busy');
    f.querySelector('[aria-busy]')?.removeAttribute('aria-busy');
  }));

// Command palette (Cmd/Ctrl+K): pages and lists are in the markup, channels load on first open.
const palette = document.getElementById('palette');
let openPalette = () => {};
if (palette) {
  const input = palette.querySelector('input');
  const list = palette.querySelector('ul');
  let loaded = false;
  const visible = () => [...list.children].filter((li) => !li.hidden && !li.classList.contains('group'));
  const group = (label) => {
    const li = document.createElement('li');
    li.className = 'group';
    li.role = 'presentation';
    li.textContent = label;
    return li;
  };
  const select = (li) => {
    list.querySelector('[aria-selected="true"]')?.removeAttribute('aria-selected');
    li?.setAttribute('aria-selected', 'true');
    li?.scrollIntoView({ block: 'nearest' });
  };
  const item = (href, label, kind, keywords) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    const small = document.createElement('small');
    a.href = href;
    if (kind === 'Channel') a.append(Object.assign(document.createElement('span'), { className: 'dot' }));
    a.append(label);
    small.textContent = kind;
    a.append(small);
    li.append(a);
    li.dataset.k = keywords;
    return li;
  };
  const filter = () => {
    const q = input.value.trim().toLowerCase();
    list.querySelector('[data-search-item]')?.remove();
    for (const li of list.children) li.hidden = q !== '' && (li.classList.contains('group') || !(li.dataset.k + ' ' + li.textContent).toLowerCase().includes(q));
    if (q) {
      const li = item('/?q=' + encodeURIComponent(input.value.trim()), `Search the feed for “${input.value.trim()}”`, 'Search', '');
      li.dataset.searchItem = '';
      list.append(li);
    }
    select(visible()[0]);
  };
  const open = async () => {
    input.value = '';
    palette.showModal();
    filter();
    if (loaded) return;
    loaded = true;
    const channels = await fetch('/api/subscriptions').then((r) => r.json()).catch(() => []);
    if (channels.length) list.append(group('Channels'));
    for (const c of channels) list.append(item('/?channel=' + encodeURIComponent(c.channelId), c.title, 'Channel', 'channel'));
    filter();
  };
  openPalette = open;
  for (const b of document.querySelectorAll('[data-palette]')) b.addEventListener('click', open);
  input.addEventListener('input', filter);
  palette.addEventListener('click', (e) => { if (e.target === palette || e.target.closest('[data-palette-close]')) palette.close(); });
  palette.addEventListener('keydown', (e) => {
    const rows = visible();
    const i = rows.indexOf(list.querySelector('[aria-selected="true"]'));
    if (e.key === 'ArrowDown') select(rows[Math.min(i + 1, rows.length - 1)]);
    else if (e.key === 'ArrowUp') select(rows[Math.max(i - 1, 0)]);
    else if (e.key === 'Enter') rows[i]?.querySelector('a').click();
    else return;
    e.preventDefault();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      palette.open ? palette.close() : open();
    }
  });
}

// Infinite scroll: swap the "Load more" link for the next page when it nears the viewport.
const feed = document.getElementById('feed');
const pager = new IntersectionObserver(async ([entry]) => {
  if (!entry.isIntersecting) return;
  const link = entry.target;
  pager.unobserve(link);
  const res = await fetch(link.href + '&fragment=1', { headers: { 'X-Requested-With': 'fetch' } }).catch(() => null);
  if (!res || !res.ok) return;
  link.insertAdjacentHTML('afterend', await res.text());
  link.remove();
  watchPager();
}, { rootMargin: '1200px' });
function watchPager() {
  const link = document.getElementById('more');
  if (link) pager.observe(link);
}
watchPager();

// First fetch in progress: reload until videos arrive.
const reload = document.querySelector('[data-reload]');
if (reload) setTimeout(() => location.reload(), Number(reload.dataset.reload) * 1000);

// Keyboard: j/k move, Enter opens, w watched, l later, / search.
let current = null;
function focusCard(card) {
  if (!card) return;
  current?.classList.remove('focus');
  current = card;
  card.classList.add('focus');
  card.scrollIntoView({ block: 'nearest' });
}
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.key === '/') {
    e.preventDefault();
    const field = document.querySelector('[data-search]');
    field ? field.focus() : openPalette();
    return;
  }
  if (!feed || document.getElementById('player')) return;
  const cards = [...feed.querySelectorAll('.card')];
  const i = cards.indexOf(current);
  switch (e.key) {
    case 'j': focusCard(cards[Math.min(i + 1, cards.length - 1)]); break;
    case 'k': focusCard(cards[Math.max(i - 1, 0)]); break;
    case 'Enter': case 'o': current?.querySelector('a.title')?.click(); break;
    case 'w': current?.querySelector('[data-toggle="watched"]')?.requestSubmit(); break;
    case 'l': current?.querySelector('[data-toggle="later"]')?.requestSubmit(); break;
    default: return;
  }
  e.preventDefault();
});
