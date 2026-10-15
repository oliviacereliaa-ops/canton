/*
 * Fabric Price Checker — scoring engine (no DOM).
 * Shared by index.html and the tests.
 *
 * Pipeline:
 *   sheet table (2D array) -> quote records -> normalised to IDR per kg / sqm / m
 *   new inquiry -> hard filters (category, construction, Import vs Local)
 *               -> similarity (material, finish, GSM) x recency weight
 *               -> weighted percentile of the new price among peers -> verdict
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    rmb: 2680,            // IDR per RMB
    usd: 17800,           // IDR per USD
    halfLifeMonths: 6,    // a quote this old counts half
    staleMonths: 12,      // older than this is flagged as stale
    maxPeers: 8,
    minSim: 0.45,
    includeInquiries: true
  };
  var YARD_M = 0.9144;
  var MS_MONTH = 1000 * 60 * 60 * 24 * 30.44;

  // ---------- helpers ----------
  function num(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = String(v).replace(/[^0-9.\-]/g, '');
    if (!s || s === '-' || s === '.') return null;
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }
  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  function parseDate(v) {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v) ? null : v;
    var s = String(v).trim(), m;
    m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
    if (m) return new Date(+m[1], +m[2] - 1, m[3] ? +m[3] : 15);
    m = s.match(/([A-Za-z]{3})[A-Za-z]*\.?[\s\-\/,]*(\d{4})/);
    if (m && MONTHS[m[1].toLowerCase()] != null) return new Date(+m[2], MONTHS[m[1].toLowerCase()], 15);
    m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/); // dd/mm/yyyy
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
    return null;
  }
  function monthsBetween(a, b) { return (b - a) / MS_MONTH; }

  function parseCSV(text) {
    text = String(text).replace(/^﻿/, '');
    var rows = [], row = [], f = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
      else if (c !== '\r') f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
  }

  // ---------- taxonomy ----------
  function construction(v) {
    var t = norm(v);
    if (/weav|woven/.test(t)) return 'Woven';
    if (/knit/.test(t)) return 'Knitted';
    if (/tuft/.test(t)) return 'Tufted';
    if (/non.?woven/.test(t)) return 'Non-woven';
    return v ? String(v).trim() : '';
  }
  function sourceOf(v) {
    var t = norm(v);
    if (/local/.test(t)) return 'Local';
    if (/import/.test(t)) return 'Import';
    return '';
  }
  function categories(v) {
    return String(v || '').split(/[\/,]/).map(norm).filter(Boolean);
  }
  function families(text) {
    var t = norm(text), f = {};
    if (/polyethylene|cooling/.test(t)) { f.polyethylene = 1; t = t.replace(/polyethylene/g, ''); }
    if (/cotton|cvc/.test(t)) f.cotton = 1;
    if (/tencel|lyocell/.test(t)) f.tencel = 1;
    if (/bamboo/.test(t)) f.bamboo = 1;
    if (/viscose|rayon/.test(t)) f.viscose = 1;
    if (/nylon|\bpa\b/.test(t)) f.nylon = 1;
    if (/spandex|elastane|lycra/.test(t)) f.spandex = 1;
    if (/chenil/.test(t)) f.chenille = 1;
    if (/poly|\bpes\b|microf|microtex/.test(t)) f.polyester = 1;
    return Object.keys(f);
  }
  function finishTags(text) {
    var t = norm(text), ex = [];
    var print = /print/.test(t), emboss = /emboss/.test(t);
    if (/washed/.test(t)) ex.push('washed');
    if (/brushed/.test(t) && !/unbrushed/.test(t)) ex.push('brushed');
    if (/tpu|coat|backing|blackout/.test(t)) ex.push('coated');
    if (/hot ?melt/.test(t) && !/no hot ?melt/.test(t)) ex.push('hotmelt');
    if (/quick ?dry|nanotex|wicking/.test(t)) ex.push('quickdry');
    if (/fire|retard|reterdant/.test(t)) ex.push('fr');
    if (/jacquard|dobby/.test(t)) ex.push('jacquard');
    return { primary: print ? 'print' : emboss ? 'emboss' : 'solid', extras: ex };
  }
  function jaccard(a, b, bothEmpty) {
    if (!a.length && !b.length) return bothEmpty;
    var inter = 0, u = {};
    a.forEach(function (x) { u[x] = 1; });
    b.forEach(function (x) { if (u[x]) inter++; u[x] = 1; });
    return inter / Object.keys(u).length;
  }

  // ---------- normalisation ----------
  function rateFor(cur, s) { return cur === 'RMB' ? s.rmb : cur === 'USD' ? s.usd : 1; }

  // price in original currency & unit -> IDR per m / kg / sqm
  function computeMetrics(rec, s) {
    var gsm = rec.gsm, width = rec.width;
    rec.idrM = rec.idrKg = rec.idrSqm = null;
    if (rec.price == null || !rec.unit) return rec;
    var p = rec.price * rateFor(rec.currency, s);
    var kgPerM = gsm && width ? gsm * width / 100 / 1000 : null;
    var sqmPerM = width ? width / 100 : null;
    var unit = rec.unit;
    if (unit === 'yard') { p = p / YARD_M; unit = 'm'; }
    if (unit === 'm') {
      rec.idrM = p;
      rec.idrKg = kgPerM ? p / kgPerM : null;
      rec.idrSqm = sqmPerM ? p / sqmPerM : null;
    } else if (unit === 'kg') {
      rec.idrKg = p;
      rec.idrM = kgPerM ? p * kgPerM : null;
      rec.idrSqm = gsm ? p * gsm / 1000 : null;
    } else if (unit === 'sqm') {
      rec.idrSqm = p;
      rec.idrM = sqmPerM ? p * sqmPerM : null;
      rec.idrKg = gsm ? p / (gsm / 1000) : null;
    }
    return rec;
  }

  function finishRecord(rec, s) {
    rec.fam = families(rec.materialText);
    rec.finishInfo = finishTags(rec.finishText);
    rec.cats = categories(rec.category);
    rec.date = parseDate(rec.dateText);
    return computeMetrics(rec, s);
  }

  // ---------- sheet parsing ----------
  var HEADER_MAP = [
    ['article', /^article$/],
    ['description', /^article description$|^description$/],
    ['fabricType', /^fabric type$/],
    ['material', /^material$/],
    ['vendor', /^vendor$/],
    ['quoteDate', /^quote date$/],
    ['notes', /^notes$/],
    ['coating', /^type\/coating$/],
    ['tc', /^tc$/],
    ['treatment', /^treatment$/],
    ['category', /^fg category$/],
    ['source', /^source$/],
    ['gsm', /^gsm$/],
    ['width', /^width/],
    ['rmbM', /per meter \(rmb\)/],
    ['idrM', /per meter \(idr\)/],
    ['usdM', /per meter \(usd\)/],
    ['usdKg', /per kg \(usd\)/],
    ['rmbKg', /per kg \(rmb\)/],
    ['idrKg', /per kg \(idr\)/],
    ['rmbSqm', /per sqm \(rmb\)/],
    ['idrSqm', /per sqm \(idr\)/],
    ['moq', /^moq$/]
  ];
  // Which column holds the price as the vendor quoted it (first one filled wins).
  // Per-kg foreign prices come first: when a row has both, the per-kg figure is the quoted one.
  var PRICE_PRIORITY = [
    ['rmbKg', 'RMB', 'kg'], ['usdKg', 'USD', 'kg'],
    ['rmbM', 'RMB', 'm'], ['usdM', 'USD', 'm'],
    ['idrM', 'IDR', 'm'], ['idrKg', 'IDR', 'kg'],
    ['rmbSqm', 'RMB', 'sqm'], ['idrSqm', 'IDR', 'sqm']
  ];

  function parseQuoteTable(rows, s) {
    s = s || DEFAULTS;
    var h = -1;
    for (var i = 0; i < Math.min(rows.length, 20); i++) {
      if (rows[i] && rows[i].some(function (c) { return norm(c) === 'article description'; })) { h = i; break; }
    }
    if (h < 0) throw new Error('Could not find the header row (a column named "Article Description").');
    var idx = {};
    rows[h].forEach(function (cell, c) {
      var n = norm(cell);
      for (var k = 0; k < HEADER_MAP.length; k++) {
        if (HEADER_MAP[k][1].test(n)) {
          var key = HEADER_MAP[k][0];
          if (idx[key] == null) idx[key] = c;
          else if (key === 'notes' && idx.notes2 == null) idx.notes2 = c;
          break;
        }
      }
    });
    var above = [];
    rows.slice(0, h).forEach(function (r) { (r || []).forEach(function (c) { var n = num(c); if (n && n > 100) above.push(n); }); });
    var sheetRates = above.length >= 2 ? { usd: Math.max.apply(null, above), rmb: Math.min.apply(null, above) } : null;

    var quotes = [];
    for (var r = h + 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row) continue;
      var g = function (k) { return idx[k] == null ? '' : row[idx[k]]; };
      var desc = String(g('description') || '').trim();
      if (!desc) continue;
      var price = null, currency = '', unit = '';
      for (var p = 0; p < PRICE_PRIORITY.length; p++) {
        var v = num(g(PRICE_PRIORITY[p][0]));
        if (v != null && v > 0) { price = v; currency = PRICE_PRIORITY[p][1]; unit = PRICE_PRIORITY[p][2]; break; }
      }
      var rec = {
        id: 'row-' + (r + 1), origin: 'sheet', row: r + 1,
        article: String(g('article') || '').trim(),
        description: desc,
        vendor: String(g('vendor') || '').trim(),
        dateText: g('quoteDate'),
        category: String(g('category') || '').trim(),
        construction: construction(g('fabricType')),
        material: String(g('material') || '').trim(),
        materialText: [g('material'), desc].join(' '),
        finishText: [g('treatment'), g('coating'), desc].join(' '),
        source: sourceOf(g('source')),
        gsm: num(g('gsm')), width: num(g('width')),
        price: price, currency: currency, unit: unit,
        moq: String(g('moq') || '').trim(),
        notes: [g('notes'), g('notes2')].filter(Boolean).join(' · ')
      };
      quotes.push(finishRecord(rec, s));
    }
    return { quotes: quotes, sheetRates: sheetRates };
  }

  // inquiry object (from the form or the "Fair Inquiries" tab) -> record
  function inquiryRecord(o, s) {
    var rec = {
      id: o.id, origin: 'inquiry',
      description: String(o.description || '').trim(),
      vendor: String(o.vendor || '').trim(),
      dateText: o.date,
      category: String(o.category || '').trim(),
      construction: construction(o.fabricType),
      material: String(o.material || '').trim(),
      materialText: [o.material, o.description].join(' '),
      finishText: [o.finish, o.description].join(' '),
      source: sourceOf(o.source),
      gsm: num(o.gsm), width: num(o.width),
      price: num(o.price), currency: o.currency || 'RMB', unit: o.unit || 'm',
      moq: String(o.moq || ''), notes: String(o.notes || ''),
      event: o.event || '', raw: o
    };
    return finishRecord(rec, s);
  }

  // ---------- matching ----------
  function hardMatch(a, b) {
    // a known category / construction only matches the same (rows missing them are excluded)
    if (a.cats.length && (!b.cats.length || !a.cats.some(function (c) { return b.cats.indexOf(c) >= 0; }))) return false;
    if (a.construction && b.construction !== a.construction) return false;
    return true;
  }
  function sameSource(a, b) { return !a.source || !b.source || a.source === b.source; }

  function similarity(a, b) {
    var mat = jaccard(a.fam, b.fam, 0.5);
    var fin = (a.finishInfo.primary === b.finishInfo.primary ? 0.7 : 0) + 0.3 * jaccard(a.finishInfo.extras, b.finishInfo.extras, 1);
    var g = 0.5;
    if (a.gsm && b.gsm) {
      var r = Math.abs(Math.log(a.gsm / b.gsm));
      g = Math.exp(-Math.pow(r / 0.18, 2)); // ~ +-20% GSM keeps ~0.4
    }
    var sim = 0.35 * mat + 0.25 * fin + 0.40 * g;
    if (a.fam.length && b.fam.length && mat === 0) sim *= 0.5; // different fibre entirely
    return sim;
  }

  function pickPeers(scored, s) {
    var sorted = scored.slice().sort(function (x, y) { return y.sim - x.sim; });
    var good = sorted.filter(function (x) { return x.sim >= s.minSim; }).slice(0, s.maxPeers);
    if (good.length < 3) good = sorted.filter(function (x) { return x.sim >= 0.25; }).slice(0, 3);
    return good;
  }

  function weigh(list, key, s, now) {
    return list.map(function (x) {
      var age = x.rec.date ? Math.max(0, monthsBetween(x.rec.date, now)) : null;
      var rw = age == null ? 0.35 : Math.pow(0.5, age / s.halfLifeMonths);
      return { rec: x.rec, sim: x.sim, age: age, rw: rw, w: Math.max(1e-6, x.sim * rw), value: x.rec[key] };
    });
  }
  function wQuantile(items, p) {
    var srt = items.slice().sort(function (a, b) { return a.value - b.value; });
    var tot = srt.reduce(function (t, x) { return t + x.w; }, 0), acc = 0;
    for (var i = 0; i < srt.length; i++) { acc += srt[i].w; if (acc / tot >= p) return srt[i].value; }
    return srt[srt.length - 1].value;
  }
  function wPercentile(items, v) {
    var tot = 0, below = 0;
    items.forEach(function (x) {
      tot += x.w;
      if (x.value < v * 0.999) below += x.w;
      else if (x.value <= v * 1.001) below += x.w / 2;
    });
    return tot ? below / tot : null;
  }

  function vendorKey(v) { return norm(v).replace(/co\.?,?|ltd\.?|limited|textile[s]?|pt\.?|cv\.?|[^a-z ]/g, '').trim().split(' ').slice(0, 2).join(' '); }

  function analyze(inq, pool, s, now) {
    s = s || DEFAULTS; now = now || new Date();
    var metrics = ['kg', 'sqm', 'm'].filter(function (m) { return inq['idr' + cap(m)] != null; });
    if (!metrics.length) return { error: 'Enter a price. To compare per kg, also enter GSM and width.' };

    var scored = pool
      .filter(function (p) { return p !== inq && (!inq.id || p.id !== inq.id) && hardMatch(inq, p); })
      .map(function (p) { return { rec: p, sim: similarity(inq, p) }; });

    var chosen = null, sel = null;
    for (var i = 0; i < metrics.length; i++) {
      var key = 'idr' + cap(metrics[i]);
      var cand = scored.filter(function (x) { return x.rec[key] != null && sameSource(inq, x.rec); });
      var picked = pickPeers(cand, s);
      if (!sel || picked.length > sel.length) { chosen = metrics[i]; sel = picked; }
      if (picked.length >= 3) { chosen = metrics[i]; sel = picked; break; }
    }
    var pk = 'idr' + cap(chosen);
    var v = inq[pk];
    var peers = weigh(sel, pk, s, now).sort(function (a, b) { return b.w - a.w; });

    var res = { metric: chosen, value: v, peers: peers, reasons: [] };
    if (chosen !== 'kg') res.reasons.push(inq.idrKg == null
      ? 'No GSM, so it is compared per ' + (chosen === 'sqm' ? 'm²' : 'metre') + '.'
      : 'Not enough per-kg peers, so it is compared per ' + (chosen === 'sqm' ? 'm²' : 'metre') + '.');

    // reference: the other source group (Import vs Local), shown but not scored
    if (inq.source) {
      var other = scored.filter(function (x) { return x.rec[pk] != null && x.rec.source && x.rec.source !== inq.source; });
      var op = weigh(pickPeers(other, s), pk, s, now);
      if (op.length) res.otherSource = { source: inq.source === 'Import' ? 'Local' : 'Import', n: op.length, median: wQuantile(op, 0.5) };
    }

    // same vendor history
    var vk = vendorKey(inq.vendor);
    if (vk) {
      res.vendorHistory = scored
        .filter(function (x) { return x.rec[pk] != null && vendorKey(x.rec.vendor) === vk && x.sim >= 0.75; })
        .map(function (x) { return { rec: x.rec, value: x.rec[pk], sim: x.sim }; })
        .sort(function (a, b) { return (b.rec.date || 0) - (a.rec.date || 0); })
        .slice(0, 5);
    }

    if (!peers.length) {
      res.verdict = { key: 'none', label: 'No comparable quotes yet' };
      res.confidence = 'None';
      res.reasons.push('Nothing in the list matches this category + construction' + (inq.source ? ' + ' + inq.source : '') + '. It will be the first reference once saved.');
      return res;
    }

    var vals = peers.map(function (x) { return x.value; });
    res.min = Math.min.apply(null, vals); res.max = Math.max.apply(null, vals);
    res.p25 = wQuantile(peers, 0.25); res.median = wQuantile(peers, 0.5); res.p75 = wQuantile(peers, 0.75);
    res.pct = wPercentile(peers, v);
    res.deltaPct = (v - res.median) / res.median;

    if (v > res.max * 1.02) res.verdict = { key: 'way', label: 'Way above market' };
    else if (v < res.min * 0.98) res.verdict = { key: 'low', label: 'Cheaper than all quotes' };
    else if (res.pct > 0.75) res.verdict = { key: 'high', label: 'Expensive' };
    else if (res.pct < 0.25) res.verdict = { key: 'low', label: 'Cheap' };
    else res.verdict = { key: 'fair', label: 'Fair price' };

    // confidence
    var n = peers.length;
    var avgSim = peers.reduce(function (t, x) { return t + x.sim; }, 0) / n;
    var stale = peers.filter(function (x) { return x.age == null || x.age > s.staleMonths; }).length;
    var lvl = n >= 5 && avgSim >= 0.6 ? 2 : n >= 3 && avgSim >= 0.5 ? 1 : 0;
    if (stale > n / 2) { lvl = Math.max(0, lvl - 1); res.reasons.push('Most matching quotes are older than ' + s.staleMonths + ' months or undated.'); }
    if (avgSim < 0.6) res.reasons.push('Matches are loose (different material, finish or GSM).');
    if (n < 3) res.reasons.push('Only ' + n + ' comparable quote' + (n === 1 ? '' : 's') + '.');
    res.confidence = ['Low', 'Medium', 'High'][lvl];

    // target to ask, in the inquiry's own currency & unit
    var ratio = inq.price / v;
    res.target = { median: res.median * ratio, p25: res.p25 * ratio, currency: inq.currency, unit: inq.unit };
    return res;
  }

  var api = {
    DEFAULTS: DEFAULTS, num: num, parseDate: parseDate, parseCSV: parseCSV,
    parseQuoteTable: parseQuoteTable, inquiryRecord: inquiryRecord, computeMetrics: computeMetrics,
    finishRecord: finishRecord, analyze: analyze, similarity: similarity, construction: construction
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FabricEngine = api;
})(this);
