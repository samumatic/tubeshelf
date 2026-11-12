// Progressive enhancement: every form here also works without this file.

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
  form.querySelector('button').setAttribute('aria-pressed', active);
  const card = form.closest('.card');
  if (card) card.classList.toggle(form.dataset.toggle, active);
  if (card && !active && document.body.classList.contains('page-later') && form.dataset.toggle === 'later') card.remove();
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-confirm]');
  if (el && !confirm(el.dataset.confirm)) e.preventDefault();
});

// A form that navigates shows it is working until the next page arrives.
document.addEventListener('submit', (e) => {
  if (!e.defaultPrevented && !e.target.matches('[data-toggle], [role="search"]')) e.target.classList.add('busy');
});
window.addEventListener('pageshow', () => document.querySelectorAll('form.busy').forEach((f) => f.classList.remove('busy')));

// Command palette (Cmd/Ctrl+K): pages and lists are in the markup, channels load on first open.
const palette = document.getElementById('palette');
if (palette) {
  const input = palette.querySelector('input');
  const list = palette.querySelector('ul');
  let loaded = false;
  const visible = () => [...list.children].filter((li) => !li.hidden);
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
    a.textContent = label;
    small.textContent = kind;
    a.append(small);
    li.append(a);
    li.dataset.k = keywords;
    return li;
  };
  const filter = () => {
    const q = input.value.trim().toLowerCase();
    list.querySelector('[data-search-item]')?.remove();
    for (const li of list.children) li.hidden = q !== '' && !(li.dataset.k + ' ' + li.textContent).toLowerCase().includes(q);
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
    for (const c of channels) list.append(item('/?channel=' + encodeURIComponent(c.channelId), c.title, 'Channel', 'channel'));
    filter();
  };
  input.addEventListener('input', filter);
  palette.addEventListener('click', (e) => { if (e.target === palette) palette.close(); });
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
    [...document.querySelectorAll('[data-search], .phone-bar input')].find((el) => el.offsetParent)?.focus();
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
