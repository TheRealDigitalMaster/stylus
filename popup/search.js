/* global $ $$ $create $remove showSpinner toggleDataset */// dom.js
/* global $entry tabURL */// popup.js
/* global API */// msg.js
/* global Events */
/* global FIREFOX URLS debounce download isEmptyObj stringAsRegExp tryRegExp tryURL */// toolbox.js
/* global prefs */
/* global t */// localization.js
'use strict';

(() => {
  const RESULT_ID_PREFIX = t.template.searchResult.className + '-';
  const RESULT_SEL = '.' + t.template.searchResult.className;
  const INDEX_URL = URLS.usoArchiveRaw[0] + 'search-index.json';
  const USW_INDEX_URL = URLS.usw + 'api/index/uso-format';
  const USW_ICON = $create('img', {
    src: `${URLS.usw}favicon.ico`,
    title: URLS.usw,
  });
  const STYLUS_CATEGORY = 'chrome-extension';
  const PAGE_LENGTH = 100;
  // update USO style install counter if the style isn't uninstalled immediately
  const PINGBACK_DELAY = 5e3;
  const BUSY_DELAY = .5e3;
  const USO_AUTO_PIC_SUFFIX = '-after.png';
  const BLANK_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  const dom = {};
  /**
   * @typedef IndexEntry
   * @prop {'uso' | 'uso-android'} f - format
   * @prop {Number} i - id, later replaced with string like `uso-123`
   * @prop {string} n - name
   * @prop {string} c - category
   * @prop {Number} u - updatedTime
   * @prop {Number} t - totalInstalls
   * @prop {Number} w - weeklyInstalls
   * @prop {Number} r - rating
   * @prop {Number} ai -  authorId
   * @prop {string} an -  authorName
   * @prop {string} sn -  screenshotName
   * @prop {boolean} sa -  screenshotArchived
   *
   * @prop {number} _styleId - installed style id
   * @prop {boolean} _styleVars - installed style has vars
   * @prop {number} _year
   */
  /** @type IndexEntry[] */
  let results, resultsAllYears;
  /** @type IndexEntry[] */
  let index;
  let category = '';
  /** @type RegExp */
  let rxCategory;
  let searchGlobals = $('#search-globals').checked;
  /** @type {RegExp[]} */
  let query = [];
  let order = prefs.get('popup.findSort');
  let scrollToFirstResult = true;
  let displayedPage = 1;
  let totalPages = 1;
  let ready;
  /** @type {?Promise} */
  let indexing;

  let imgType = '.jpg';
  // detect WebP support
  $create('img', {
    src: 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=',
    onload: () => (imgType = '.webp'),
  });

  /** @returns {{result: IndexEntry, entry: HTMLElement}} */
  const $resultEntry = el => {
    const entry = el.closest(RESULT_SEL);
    return {entry, result: entry && entry._result};
  };
  const rid2id = rid => rid.split('-')[1];
  Events.searchInline = () => {
    calcCategory();
    ready = start();
  };
  Events.searchSite = event => {
    // use a less specific category if the inline search wasn't used yet
    if (!category) calcCategory({retry: 1});
    const add = (prefix, str) => str ? prefix + str : '';
    const where = event.detail;
    const q = encodeURIComponent($('#search-query').value.trim());
    const catQ = category + add('+', q);
    const href =
      where === 'uso' &&
        `${URLS.uso}styles/browse${q ? `?search_terms=${catQ}` : `/${category}`}` ||
      where === 'usoa' &&
        `${URLS.usoArchive}browse/styles?search=%23${catQ}` ||
      where === 'usw' &&
        `${URLS.usw}search?q=${catQ}` ||
      where === 'gf' &&
        'https://greasyfork.org/' + ($.root.lang.split('-')[0] || 'en') +
        `/scripts/by-site/${tryURL(tabURL).hostname.replace(/^www\./, '')}?language=css${add('&q=', q)}`;
    Events.openURLandHide.call({href}, event);
  };
  $('#search-globals').onchange = function () {
    searchGlobals = this.checked;
    ready = ready.then(start);
  };
  $('#search-query').oninput = function () {
    query = [];
    const text = this.value.trim();
    for (let re = /(")(.+?)"|((\/)?(\S+?)(\/\w*)?)(?=\s|$)/g, m; (m = re.exec(text));) {
      const [
        all,
        q, qt,
        t, rx1 = '', rx, rx2 = '',
      ] = m;
      query.push(rx1 && rx2 && tryRegExp(rx, rx2.slice(1)) ||
        stringAsRegExp(q ? qt : t, all === all.toLocaleLowerCase() ? 'i' : ''));
    }
    if (category === STYLUS_CATEGORY) {
      query.push(/\bStylus\b/);
    }
    ready = ready.then(start);
  };
  $('#search-years').onchange = () => {
    ready = ready.then(() => start({keepYears: true}));
  };
  $('#search-order').value = order;
  $('#search-order').onchange = function () {
    order = this.value;
    prefs.set('popup.findSort', order);
    results.sort(comparator);
    render();
  };
  dom.list = $('#search-results-list');
  dom.container = $('#search-results');
  dom.container.dataset.empty = '';
  dom.error = $('#search-results-error');
  dom.nav = {};
  const navOnClick = {prev, next};
  for (const place of ['top', 'bottom']) {
    const nav = $(`.search-results-nav[data-type="${place}"]`);
    nav.appendChild(t.template.searchNav.cloneNode(true));
    dom.nav[place] = nav;
    for (const child of $$('[data-type]', nav)) {
      const type = child.dataset.type;
      child.onclick = navOnClick[type];
      nav['_' + type] = child;
    }
  }

  if (FIREFOX) {
    let lastShift;
    window.on('resize', () => {
      const scrollbarWidth = window.innerWidth - document.scrollingElement.clientWidth;
      const shift = document.body.getBoundingClientRect().left;
      if (!scrollbarWidth || shift === lastShift) return;
      lastShift = shift;
      document.body.style.setProperty('padding',
        `0 ${scrollbarWidth + shift}px 0 ${-shift}px`, 'important');
    }, {passive: true});
  }

  window.on('styleDeleted', ({detail: {style: {id}}}) => {
    restoreScrollPosition();
    const r = results.find(r => r._styleId === id);
    if (r) {
      if (r.f) API.uso.pingback(rid2id(r.i), false);
      delete r._styleId;
      renderActionButtons(r.i);
    }
  });

  window.on('styleAdded', async ({detail: {style}}) => {
    restoreScrollPosition();
    const ri = await API.styles.getRemoteInfo(style.id);
    const r = ri && results.find(r => ri[0] === r.i);
    if (r) {
      r._styleId = style.id;
      r._styleVars = ri[1];
      renderActionButtons(ri[0]);
    }
  });

  function next() {
    displayedPage = Math.min(totalPages, displayedPage + 1);
    scrollToFirstResult = true;
    render();
  }

  function prev() {
    displayedPage = Math.max(1, displayedPage - 1);
    scrollToFirstResult = true;
    render();
  }

  function error(reason) {
    dom.error.textContent = reason;
    dom.error.hidden = false;
    dom.list.hidden = true;
    if (dom.error.getBoundingClientRect().bottom < 0) {
      dom.error.scrollIntoView(true);
    }
  }

  function errorIfNoneFound() {
    if (!results.length && !$('#search-query').value) {
      return indexing ? indexing.then(errorIfNoneFound)
        : Promise.reject(t('searchResultNoneFound'));
    }
  }

  async function start({keepYears} = {}) {
    resetUI.timer = resetUI.timer || setTimeout(resetUI, 500);
    try {
      results = [];
      for (let retry = 0; !results.length && retry <= 2; retry++) {
        results = await search({retry});
      }
      if (results.length) {
        const info = await API.styles.getRemoteInfo();
        for (const r of results) {
          [r._styleId, r._styleVars] = info[r.i] || [];
        }
      }
      if (!keepYears) resultsAllYears = results;
      renderYears();
      render();
      dom.list.hidden = !results.length;
      await errorIfNoneFound();
      resetUI();
    } catch (reason) {
      error(reason);
    }
    clearTimeout(resetUI.timer);
    resetUI.timer = 0;
  }

  function resetUI() {
    $.rootCL.add('search-results-shown');
    dom.container.hidden = false;
    dom.list.hidden = false;
    dom.error.hidden = true;
  }

  function renderYears() {
    const SCALE = 1000;
    const BASE = new Date(0).getFullYear(); // 1970
    const DAYS = 365.2425;
    const DAY = 24 * 3600e3;
    const YEAR = DAYS * DAY / SCALE;
    const SAFETY = 1 / DAYS; // 1 day safety margin: recheck Jan 1 and Dec 31
    const years = [];
    for (const r of resultsAllYears) {
      let y = r._year;
      if (!y) {
        y = r.u / YEAR + BASE;
        r._year = y = Math.abs(y % 1 - 1) <= SAFETY
          ? new Date(r.u * SCALE).getFullYear()
          : y | 0;
      }
      years[y] = (years[y] || 0) + 1;
    }
    const texts = years.reduceRight((res, num, y) => res.push(`${y} (${num})`) && res, []);
    const selects = $$('#search-years select');
    selects.forEach((sel, selNum) => {
      if (texts.length !== sel.length || texts.some((v, i) => v !== sel[i].text)) {
        const {value} = sel;
        sel.textContent = '';
        sel.append(...texts.map(t => $create('option', {value: t.split(' ')[0]}, t)));
        sel.value = value in years ? value : (sel[`${selNum ? 'first' : 'last'}Child`] || {}).value;
      }
    });
    const [y1, y2] = selects.map(el => Number(el.value)).sort();
    results = y1 ? resultsAllYears.filter(r => (r = r._year) >= y1 && r <= y2) : resultsAllYears;
  }

  function render() {
    totalPages = Math.ceil(results.length / PAGE_LENGTH);
    displayedPage = Math.min(displayedPage, totalPages) || 1;
    let start = (displayedPage - 1) * PAGE_LENGTH;
    const end = displayedPage * PAGE_LENGTH;
    let plantAt = 0;
    let slot = dom.list.children[0];
    // keep rendered elements with ids in the range of interest
    while (
      plantAt < PAGE_LENGTH &&
      slot && slot.id === RESULT_ID_PREFIX + (results[start] || {}).i
    ) {
      slot = slot.nextElementSibling;
      plantAt++;
      start++;
    }
    // add new elements
    while (start < Math.min(end, results.length)) {
      const entry = createSearchResultNode(results[start++]);
      if (slot) {
        dom.list.replaceChild(entry, slot);
        slot = entry.nextElementSibling;
      } else {
        dom.list.appendChild(entry);
      }
      plantAt++;
    }
    // remove extraneous elements
    const pageLen = end > results.length &&
      results.length % PAGE_LENGTH ||
      Math.min(results.length, PAGE_LENGTH);
    while (dom.list.children.length > pageLen) {
      dom.list.lastElementChild.remove();
    }
    if (results.length && 'empty' in dom.container.dataset) {
      delete dom.container.dataset.empty;
    }
    if (scrollToFirstResult) {
      debounce(doScrollToFirstResult);
    }
    // navigation
    for (const place in dom.nav) {
      const nav = dom.nav[place];
      nav._prev.disabled = displayedPage <= 1;
      nav._next.disabled = displayedPage >= totalPages;
      nav._page.textContent = displayedPage;
      nav._total.textContent = totalPages;
      nav._num.textContent = results.length;
    }
  }

  function doScrollToFirstResult() {
    if (dom.container.scrollHeight > window.innerHeight * 2) {
      scrollToFirstResult = false;
      dom.container.scrollIntoView(true);
    }
  }

  /**
   * @param {IndexEntry} result
   * @returns {Node}
   */
  function createSearchResultNode(result) {
    const entry = t.template.searchResult.cloneNode(true);
    const {
      i: rid,
      n: name,
      r: rating,
      u: updateTime,
      w: weeklyInstalls,
      t: totalInstalls,
      ai: authorId,
      an: author,
      sa: shotArchived,
      sn: shot,
      f: fmt,
    } = entry._result = result;
    const id = rid2id(rid);
    entry.id = RESULT_ID_PREFIX + rid;
    // title
    Object.assign($('.search-result-title', entry), {
      onclick: Events.openURLandHide,
      href: `${fmt ? URLS.usoArchive : URLS.usw}style/${id}`,
    });
    if (!fmt) $('.search-result-title', entry).prepend(USW_ICON.cloneNode(true));
    $('.search-result-title span', entry).textContent =
      t.breakWord(name.length < 300 ? name : name.slice(0, 300) + '...');
    // screenshot
    const elShot = $('.search-result-screenshot', entry);
    let shotSrc;
    if (!fmt) {
      shotSrc = /^https?:/i.test(shot) && shot.replace(/\.jpg$/, imgType);
    } else {
      elShot._src = URLS.uso + `auto_style_screenshots/${id}${USO_AUTO_PIC_SUFFIX}`;
      shotSrc = shot && !shot.endsWith(USO_AUTO_PIC_SUFFIX)
        ? `${shotArchived ? URLS.usoArchiveRaw[0] : URLS.uso + 'style_'}screenshots/${shot}`
        : elShot._src;
    }
    if (shotSrc) {
      elShot._entry = entry;
      elShot.src = shotSrc;
      elShot.onerror = fixScreenshot;
    } else {
      elShot.src = BLANK_PIXEL;
      entry.dataset.noImage = '';
    }
    // author
    Object.assign($('[data-type="author"] a', entry), {
      textContent: author,
      title: author,
      href: !fmt ? `${URLS.usw}user/${encodeURIComponent(author)}` :
        `${URLS.usoArchive}browse/styles?search=%40${authorId}`,
      onclick: Events.openURLandHide,
    });
    // rating
    $('[data-type="rating"]', entry).dataset.class =
      !rating ? 'none' :
        rating >= 2.5 ? 'good' :
          rating >= 1.5 ? 'okay' :
            'bad';
    $('[data-type="rating"] dd', entry).textContent = rating && rating.toFixed(1) || '';
    // time
    Object.assign($('[data-type="updated"] time', entry), {
      dateTime: updateTime * 1000,
      textContent: t.formatDate(updateTime * 1000),
    });
    // totals
    $('[data-type="weekly"] dd', entry).textContent = formatNumber(weeklyInstalls);
    $('[data-type="total"] dd', entry).textContent = formatNumber(totalInstalls);
    renderActionButtons(entry);
    return entry;
  }

  function formatNumber(num) {
    return (
      num > 1e9 ? (num / 1e9).toFixed(1) + 'B' :
      num > 10e6 ? (num / 1e6).toFixed(0) + 'M' :
      num > 1e6 ? (num / 1e6).toFixed(1) + 'M' :
      num > 10e3 ? (num / 1e3).toFixed(0) + 'k' :
      num > 1e3 ? (num / 1e3).toFixed(1) + 'k' :
      num
    );
  }

  function fixScreenshot() {
    const {_src} = this;
    if (_src && _src !== this.src) {
      this.src = _src;
      delete this._src;
    } else {
      this.onerror = null;
      this.src = BLANK_PIXEL;
      this._entry.dataset.noImage = '';
      renderActionButtons(this._entry);
    }
  }

  function renderActionButtons(entry) {
    if (typeof entry !== 'object') {
      entry = $('#' + RESULT_ID_PREFIX + entry);
    }
    if (!entry) return;
    const result = entry._result;
    const installedId = result._styleId;
    const isInstalled = installedId > 0; // must be boolean for comparisons below
    const status = $('.search-result-status', entry).textContent =
      isInstalled ? t('clickToUninstall') :
        entry.dataset.noImage != null ? t('installButton') :
          '';
    const notMatching = isInstalled && !$entry(installedId);
    if (notMatching !== entry.classList.contains('not-matching')) {
      entry.classList.toggle('not-matching');
      if (notMatching) {
        entry.prepend(t.template.searchResultNotMatching.cloneNode(true));
      } else {
        entry.firstElementChild.remove();
      }
    }
    Object.assign($('.search-result-screenshot', entry), {
      onclick: isInstalled ? uninstall : install,
      title: status ? '' : t('installButton'),
    });
    $('.search-result-uninstall', entry).onclick = uninstall;
    $('.search-result-install', entry).onclick = install;
    Object.assign($('.search-result-customize', entry), {
      onclick: configure,
      disabled: notMatching,
    });
    toggleDataset(entry, 'installed', isInstalled);
    toggleDataset(entry, 'customizable', result._styleVars);
  }

  function renderFullInfo(entry, style) {
    let {description, vars} = style.usercssData;
    // description
    description = (description || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/([^.][.。?!]|[\s,].{50,70})\s+/g, '$1\n')
      .replace(/([\r\n]\s*){3,}/g, '\n\n');
    Object.assign($('.search-result-description', entry), {
      textContent: description,
      title: description,
    });
    vars = !isEmptyObj(vars);
    entry._result._styleVars = vars;
    toggleDataset(entry, 'customizable', vars);
  }

  function configure() {
    const styleEntry = $entry($resultEntry(this).result._styleId);
    Events.configure.call(this, {target: styleEntry});
  }

  async function install() {
    const {entry, result} = $resultEntry(this);
    const {f: fmt} = result;
    const id = rid2id(result.i);
    const installButton = $('.search-result-install', entry);

    showSpinner(entry);
    saveScrollPosition(entry);
    installButton.disabled = true;
    entry.style.setProperty('pointer-events', 'none', 'important');
    delete entry.dataset.error;
    if (fmt) API.uso.pingback(id, PINGBACK_DELAY);

    const updateUrl = fmt ? URLS.makeUsoArchiveCodeUrl(id) : URLS.makeUswCodeUrl(id);

    try {
      const sourceCode = await download(updateUrl);
      const style = await API.usercss.install({sourceCode, updateUrl});
      renderFullInfo(entry, style);
    } catch (reason) {
      entry.dataset.error = `${t('genericError')}: ${reason}`;
      entry.scrollIntoView({behavior: 'smooth', block: 'nearest'});
    }
    $remove('.lds-spinner', entry);
    installButton.disabled = false;
    entry.style.pointerEvents = '';
  }

  function uninstall() {
    const {entry, result} = $resultEntry(this);
    saveScrollPosition(entry);
    API.styles.delete(result._styleId);
  }

  function saveScrollPosition(entry) {
    dom.scrollPos = entry.getBoundingClientRect().top;
    dom.scrollPosElement = entry;
  }

  function restoreScrollPosition() {
    window.scrollBy(0, dom.scrollPosElement.getBoundingClientRect().top - dom.scrollPos);
  }

  /**
   * Resolves the Userstyles.org "category" for a given URL.
   * @returns {boolean} true if the category has actually changed
   */
  function calcCategory({retry} = {}) {
    const u = tryURL(tabURL);
    const old = category;
    if (!u.href) {
      // Invalid URL
      category = '';
    } else if (u.protocol === 'file:') {
      category = 'file:';
    } else if (u.protocol === location.protocol) {
      category = STYLUS_CATEGORY;
    } else {
      const parts = u.hostname.replace(/\.(?:com?|org)(\.\w{2,3})$/, '$1').split('.');
      const [tld, main = u.hostname, third, fourth] = parts.reverse();
      const keepTld = retry !== 1 && !(
        tld === 'com' ||
        tld === 'org' && main !== 'userstyles'
      );
      const keepThird = !retry && (
        fourth ||
        third && third !== 'www' && third !== 'm'
      );
      category = (keepThird && `${third}.` || '') + main + (keepTld || keepThird ? `.${tld}` : '');
    }
    rxCategory = new RegExp(`\\b${stringAsRegExp(category, '', true)}\\b`, 'i');
    return category !== old;
  }

  async function fetchIndex() {
    const timer = setTimeout(showSpinner, BUSY_DELAY, dom.list);
    const jobs = [
      [INDEX_URL, 'uso', json => json.filter(v => v.f === 'uso')],
      [USW_INDEX_URL, 'usw', json => json.data],
    ].map(async ([url, prefix, transform]) => {
      const res = transform(await download(url, {responseType: 'json'}));
      for (const v of res) v.i = `${prefix}-${v.i}`;
      index = index ? index.concat(res) : res;
      if (index !== res) ready = ready.then(start);
    });
    // TODO: use Promise.allSettled when "minimum_chrome_version" >= 76 and "strict_min_version" >= 71
    indexing = Promise.all(jobs.map(j => j.catch(e => e))).then(() => {
      indexing = null;
    });
    await Promise.race(jobs);
    clearTimeout(timer);
    $remove(':scope > .lds-spinner', dom.list);
    return index;
  }

  async function search({retry} = {}) {
    return retry && !query.length && !calcCategory({retry})
      ? []
      : (index || await fetchIndex()).filter(isResultMatching).sort(comparator);
  }

  function isResultMatching(res) {
    const {c} = res;
    return (
      c === category ||
      (category === STYLUS_CATEGORY
        ? c === 'stylus' // USW
        : c === 'global' && searchGlobals &&
          (query.length || rxCategory.test(res.n))
      )
    ) && query.every(isInHaystack, res);
  }

  /**
   * @this {IndexEntry} haystack
   * @param {RegExp} q
   */
  function isInHaystack(q) {
    return q.test(this.n);
  }

  /**
   * @param {IndexEntry} a
   * @param {IndexEntry} b
   */
  function comparator(a, b) {
    return (
      order === 'n'
        ? a.n < b.n ? -1 : a.n > b.n
        : b[order] - a[order]
    ) || b.t - a.t;
  }
})();
