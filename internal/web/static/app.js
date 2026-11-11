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
    document.getElementById('search')?.focus();
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
