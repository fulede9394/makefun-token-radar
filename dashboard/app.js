/* Token Launch Radar — the page logic.
 *
 * The value model, in one place so a reader can check it: every row's
 * implied value was computed by main.ts from the snapshot's own figures as
 *   implied = TVL x 0.35 x growth x tenure
 * growth from the protocol's 7-day TVL change (clamped -40%..+120%, halved),
 * tenure from the days it has been tracked with no token recorded (up to 4
 * years, up to 1.4x). The board only holds protocols that record no token
 * (gecko_id and symbol both null) and are not a bridge, a centralised
 * exchange, a liquid-staking product or a versioned deployment — the
 * snapshot's watchlist rule, applied to every protocol. Rows that record a
 * token are never mixed into this ranking: the board is the pre-token side.
 *
 * Staged views for screenshots: ?view=board (default), ?view=detail (opens
 * the rank-1 protocol, or ?slug=<slug> for another), ?view=filtered (shows
 * the watchlist only, sorted by implied value).
 */
(function () {
  'use strict';
  var data = window.RADAR || { rows: [] };
  var rows = data.rows || [];
  var state = { q: '', cat: '', wl: false, sort: 'val', dir: -1, selected: null };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function money(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function pct(c) {
    if (c === null || c === undefined) return '<span class="flat">n/a</span>';
    var cls = c > 0 ? 'up' : c < 0 ? 'down' : 'flat';
    var sign = c > 0 ? '+' : '';
    return '<span class="' + cls + '">' + sign + c.toFixed(2) + '%</span>';
  }
  function ageText(days) {
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return days + 'd';
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return rows.filter(function (r) {
      if (state.wl && !r.wl) return false;
      if (state.cat && (r.cat || 'Uncategorised') !== state.cat) return false;
      if (q && (r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0)) return false;
      return true;
    });
  }

  function sorted(list) {
    var key = state.sort;
    var dir = state.dir;
    var val = {
      rank: function (r) { return r.rank; },
      name: function (r) { return r.name.toLowerCase(); },
      cat: function (r) { return (r.cat || 'Uncategorised').toLowerCase(); },
      tvl: function (r) { return r.tvl; },
      chg: function (r) { return r.chg === null ? -Infinity : r.chg; },
      age: function (r) { return r.age; },
      val: function (r) { return r.val; }
    }[key];
    return list.slice().sort(function (a, b) {
      var x = val(a), y = val(b);
      if (x < y) return -1 * dir;
      if (x > y) return 1 * dir;
      return (a.rank - b.rank) * (key === 'rank' ? dir : 1);
    });
  }

  function render() {
    var list = sorted(filtered());
    var body = $('rows');
    body.innerHTML = list.map(function (r) {
      var sel = state.selected === r.slug ? ' class="selected"' : '';
      return '<tr data-slug="' + esc(r.slug) + '"' + sel + '>' +
        '<td class="num">' + r.rank + '</td>' +
        '<td><span class="name">' + esc(r.name) + '</span>' +
        (r.wl ? '<span class="badge">watchlist</span>' : '') +
        '<br><span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.cat || 'Uncategorised') + '</td>' +
        '<td class="num">' + money(r.tvl) + '</td>' +
        '<td class="num">' + pct(r.chg) + '</td>' +
        '<td class="num">' + ageText(r.age) + '</td>' +
        '<td class="num val">' + money(r.val) + '</td></tr>';
    }).join('');
    $('count').textContent = list.length + ' of ' + rows.length + ' protocols';
    var heads = document.querySelectorAll('#board thead th');
    for (var i = 0; i < heads.length; i++) {
      heads[i].classList.toggle('sorted', heads[i].getAttribute('data-sort') === state.sort);
    }
  }

  function renderDetail(r) {
    var el = $('detail');
    if (!r) {
      el.innerHTML = '<p class="empty">Select a protocol to see its full stats and farm plan.</p>';
      return;
    }
    var chains = 'n/a';
    if (r.chains && r.chains.length) {
      var shown = r.chains.slice(0, 4).join(', ');
      chains = r.chains.length > 4 ? shown + ' + ' + (r.chains.length - 4) + ' more' : shown;
    }
    var steps = r.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    el.innerHTML =
      '<h2>' + esc(r.name) + '</h2>' +
      '<p class="meta">Rank #' + r.rank + ' · ' + esc(r.slug) + (r.wl ? ' · watchlist' : '') + ' · records no token</p>' +
      '<dl>' +
      '<div><dt>Implied value</dt><dd class="val">' + money(r.val) + '</dd></div>' +
      '<div><dt>TVL</dt><dd>' + money(r.tvl) + '</dd></div>' +
      '<div><dt>7-day change</dt><dd>' + (r.chg === null ? 'n/a' : (r.chg > 0 ? '+' : '') + r.chg.toFixed(2) + '%') + '</dd></div>' +
      '<div><dt>Tracked, no token</dt><dd>' + ageText(r.age) + '</dd></div>' +
      '<div><dt>Category</dt><dd>' + esc(r.cat || 'Uncategorised') + '</dd></div>' +
      '<div><dt>Chains</dt><dd>' + esc(chains) + '</dd></div>' +
      '</dl>' +
      '<h3>Farm plan — what to do</h3><ol>' + steps + '</ol>' +
      '<p class="note">Amounts are starting sizes. A launch is never promised, and nothing here is financial advice.</p>';
  }

  function select(slug) {
    state.selected = slug;
    var r = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].slug === slug) { r = rows[i]; break; }
    renderDetail(r);
    render();
  }

  // Category dropdown, most common first.
  (function () {
    var counts = {};
    rows.forEach(function (r) { var c = r.cat || 'Uncategorised'; counts[c] = (counts[c] || 0) + 1; });
    var cats = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    var sel = $('cat');
    cats.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c + ' (' + counts[c] + ')';
      sel.appendChild(opt);
    });
  })();

  $('q').addEventListener('input', function (e) { state.q = e.target.value; render(); });
  $('cat').addEventListener('change', function (e) { state.cat = e.target.value; render(); });
  $('wl').addEventListener('change', function (e) { state.wl = e.target.checked; render(); });
  document.querySelectorAll('#board thead th').forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-sort');
      if (state.sort === key) { state.dir = -state.dir; }
      else { state.sort = key; state.dir = key === 'name' || key === 'cat' ? 1 : -1; }
      render();
    });
  });
  $('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr');
    if (tr) select(tr.getAttribute('data-slug'));
  });

  // Staged views, so screenshots are reproducible.
  var params = new URLSearchParams(window.location.search);
  var view = params.get('view') || 'board';
  if (view === 'detail') {
    var slug = params.get('slug');
    var target = slug || (rows.slice().sort(function (a, b) { return a.rank - b.rank; })[0] || {}).slug;
    if (target) select(target);
  } else if (view === 'filtered') {
    state.wl = true;
    $('wl').checked = true;
    state.sort = 'val';
    state.dir = -1;
  }
  render();
})();
