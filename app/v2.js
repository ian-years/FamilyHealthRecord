/* ==========================================================================
   V2 · 关系型数据前端模块
   ==========================================================================
   重构后数据不再是「一大坨 JSON」，而是 成员 → 档案 → 指标 → 观测值。
   指标目录、趋势连线、费用统计都搬到后端算好了，这里只负责取数和画。

   接入方式：app.js 是 IIFE，本模块看不到它内部的函数，所以由 app.js
   在启动时通过 V2.init(ctx) 把需要的东西递进来。后端没有 V2 表时
   （比如还没跑迁移）本模块安静地什么都不做，页面保持原样，不会白屏。
   ========================================================================== */

var V2 = (function () {
  'use strict';

  var C = null;                 // app.js 注入的上下文
  var enabled = false;          // 后端关系表是否就位
  var indicators = [];          // 可关注的全部指标
  var watched = [];             // 当前成员关注的指标
  var fees = null;
  var cats = [];
  var busy = false;
  /* 时间范围自己存一份，默认「全部」。
     不复用 app 的 S.range —— 那边默认近 12 个月，而体检常常一年一次，
     按 12 个月过滤后多数指标只剩一个点，趋势就永远画不出来。 */
  var v2Range = 'all';

  function init(ctx) { C = ctx || null; }

  /* ------------------------------------------------------------ 取数 */

  function get(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.json(); });
  }
  function post(url, body) {
    return fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  }
  function notify(text, isErr) {
    if (C && C.notify) C.notify(text, isErr);
    else if (typeof alert === 'function') alert(text);
  }

  /** 当前视图对应的成员 id；「全部」返回 null（后端据此不过滤人）。 */
  function curPerson() {
    if (!C || !C.S) return null;
    var S = C.S;
    if (C.L && typeof C.L.isAllView === 'function' && C.L.isAllView(S.personView)) return null;
    var n = Number(S.personView);
    return isFinite(n) && n > 0 ? n : null;
  }

  function money(cents) {
    if (cents === null || cents === undefined) return '—';
    var v = Math.abs(cents) / 100;
    var s = v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (cents < 0 ? '-¥' : '¥') + s;
  }

  /* ------------------------------------------------------------ 概览接入 */

  /** 问一次后端：关系表在不在。startApp 会先 await 它，好让旧逻辑决定要不要让路。 */
  function probe() {
    if (!C) return Promise.resolve(false);
    return get('/api/v2/status').then(function (d) {
      enabled = !!(d && d.ok && d.v2);
      return enabled;
    })['catch'](function () { enabled = false; return false; });
  }

  function mountOverview() {
    if (!C || busy) return Promise.resolve();
    busy = true;
    if (enabled) return refresh();
    return probe().then(function (ok) {
      if (!ok) { busy = false; return; }   // 没迁移就保持原样
      return refresh();
    });
  }

  function refresh() {
    if (!C) return Promise.resolve();
    busy = true;
    var pid = curPerson();
    var qs = pid ? ('?person=' + pid) : '';
    return Promise.all([
      get('/api/indicators/categories'),
      get('/api/watched' + qs),
      get('/api/fees/summary' + qs)
    ]).then(function (arr) {
      cats = (arr[0] && arr[0].categories) || [];
      watched = (arr[1] && arr[1].watched) || [];
      fees = (arr[2] && arr[2].fees) || null;
      renderFollowCard();
      renderFeesCards();
      busy = false;
    })['catch'](function () { busy = false; });
  }

  /* ------------------------------------------------------------ 关注指标卡 */

  function renderFollowCard() {
    var card = document.getElementById('cardFollow');
    if (!card || !C) return;
    var esc = C.esc, attr = C.attr;
    var pid = curPerson();
    var isAll = pid === null;

    var head = '<div class="card-h"><h3>关注指标 <span class="sub">最新结果与趋势概览</span></h3>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
      '<button class="btn sm" id="v2BtnFollow">添加关注</button>' +
      '<button class="btn sm" id="v2BtnManage">指标目录</button>' +
      '</div></div>';

    var body = '<div class="card-b">';
    body += '<div class="note" style="margin:0 0 11px">可关注的指标来自已归档报告里的全部检验项' +
      '（已归一化：合并同一指标的不同写法、修正识别错误）。' +
      (isAll ? '当前是「全部成员」视图，切到具体成员才能看到各人的数值与趋势。' : '') +
      '</div>';

    if (!watched.length) {
      body += '<div class="empty">还没有关注任何指标。点「添加关注」，从已识别的指标里挑选。</div>';
    } else {
      body += '<div class="tbl-scroll"><table class="tbl"><thead><tr>' +
        '<th>指标名</th><th>分类</th><th>最新结果</th><th>最新日期</th>' +
        '<th class="r">点数</th><th>小趋势</th><th></th></tr></thead><tbody>';
      watched.forEach(function (w) {
        var has = w.last_value !== null && w.last_value !== undefined && w.last_value !== '';
        var spark = (w.spark && w.spark.length >= 2)
          ? C.sparkline(w.spark.map(function (p) { return { value: p.value }; }))
          : '<span class="muted" style="font-size:11px">不足 2 点</span>';
        body += '<tr>' +
          '<td><b>' + esc(w.name) + '</b>' +
          (w.is_text ? ' <span class="tag gray">文本</span>' : '') + '</td>' +
          '<td class="muted" style="font-size:12px">' + esc(w.category || '其他') + '</td>' +
          '<td>' + (has
            ? '<b class="num">' + esc(w.last_value) + '</b> <span class="muted">' + esc(w.last_unit || '') + '</span>'
            : '<span class="muted">—</span>') +
          (w.last_flag ? ' <span class="flag">' + esc(w.last_flag) + '</span>' : '') + '</td>' +
          '<td class="num" style="font-size:12px">' +
          (w.last_date ? esc(C.L.fmtCN(w.last_date)) : '<span class="muted">—</span>') + '</td>' +
          '<td class="r num">' + (w.date_count || 0) + '</td>' +
          '<td>' + spark + '</td>' +
          '<td class="r" style="white-space:nowrap">' +
          '<button class="btn sm" data-v2-ind="' + attr(w.id) + '">详情</button> ' +
          '<button class="btn sm ghost" data-v2-unwatch="' + attr(w.id) + '">取消关注</button>' +
          '</td></tr>';
      });
      body += '</tbody></table></div>';
    }
    body += '</div>';

    card.innerHTML = head + body;

    var b1 = document.getElementById('v2BtnFollow');
    if (b1) b1.onclick = openFollowDrawerV2;
    var b2 = document.getElementById('v2BtnManage');
    if (b2) b2.onclick = openCatalogManager;

    C.qsa('#cardFollow [data-v2-ind]').forEach(function (b) {
      b.onclick = function () { openIndicatorById(b.getAttribute('data-v2-ind')); };
    });
    C.qsa('#cardFollow [data-v2-unwatch]').forEach(function (b) {
      b.onclick = function () {
        /* 「全部」视图的列表是去重后的并集，没有单一归属人，
           person_id 传 'all' 表示把所有成员对它的关注一起取消。 */
        post('/api/watched/remove', {
          person_id: curPerson() || 'all',
          indicator_id: Number(b.getAttribute('data-v2-unwatch'))
        }).then(function () { refresh(); });
      };
    });
  }

  /* ------------------------------------------------------------ 费用卡 */

  function renderFeesCards() {
    var card = document.getElementById('cardFees');
    var yearCard = document.getElementById('cardFeesYear');
    if (!fees || !C) return;
    var esc = C.esc, attr = C.attr;

    if (card) {
      var h = '<div class="card-h"><h3>已记录医疗费用</h3></div><div class="card-b">';
      h += '<div class="kv" style="grid-template-columns:118px minmax(0,1fr)">' +
        '<dt>已录入总额</dt><dd><b class="num" style="font-size:16px">' + money(fees.total_cents) + '</b>' +
        '<div class="muted" style="font-size:11.5px">来自 ' + fees.count + ' 份已录入金额的档案</div></dd>' +
        '<dt>金额未知</dt><dd>' + fees.unknown_count + ' 份 ' +
        '<span class="muted" style="font-size:11.5px">（档案里没有金额，未计入合计）</span></dd>' +
        '</div>';
      if (!fees.count) {
        h += '<div class="note">还没有档案录入金额。体检报告通常不含费用信息；' +
          '在档案详情里补填金额，或归档医疗发票 / 收费单后，这里就会统计。</div>';
      }
      h += '<div class="note">统计口径：只要档案填了金额或含有收费明细就计入，' +
        '不再限定「医疗发票」类型。</div>';
      h += '</div>';
      card.innerHTML = h;
    }

    if (yearCard) {
      var y = '<div class="card-h"><h3>年度费用</h3><span class="sub">按档案日期汇总</span></div><div class="card-b">';
      if (!fees.by_year.length) {
        y += '<div class="empty">暂无可用于年度统计的金额记录。</div>';
      } else {
        var maxc = Math.max.apply(null, fees.by_year.map(function (v) { return v.amount_cents; })) || 1;
        y += '<div class="bars">' + fees.by_year.map(function (v) {
          var hh = Math.max(3, Math.round(v.amount_cents / maxc * 100));
          return '<div class="bar" title="' + attr(v.year + ' 年 · ' + money(v.amount_cents)) + '">' +
            '<span class="amt">' + money(v.amount_cents) + '</span>' +
            '<span class="fill" style="height:' + hh + 'px"></span>' +
            '<span class="lab">' + esc(v.year) + '</span></div>';
        }).join('') + '</div>';
      }
      y += '</div>';
      yearCard.innerHTML = y;
    }
  }

  /* ------------------------------------------------------------ 添加关注抽屉 */

  function openFollowDrawerV2() {
    var box = document.getElementById('followBody');
    if (!box || !C) return;
    var esc = C.esc, attr = C.attr;
    var isAll = curPerson() === null;
    var persons = (C.S && C.S.persons) || [];
    /* 「全部成员」视图下关注没有唯一归属，让用户先选人再勾；
       具体成员视图直接用当前成员。 */
    var pickedPid = isAll
      ? (persons.length ? Number(persons[0].id) : null)
      : curPerson();
    if (pickedPid === null) { notify('还没有家庭成员，先到「成员」页添加。', true); return; }

    box.innerHTML = '<div class="note">正在载入指标目录…</div>';
    if (C.openDrawer) C.openDrawer('drawer-follow');

    function pickerHtml() {
      if (!isAll) return '';
      return '<div class="field"><label>关注到哪位成员</label><select id="v2PickPerson">' +
        persons.map(function (p) {
          return '<option value="' + attr(p.id) + '">' + esc(p.name) + '</option>';
        }).join('') + '</select><div class="hint">关注是按成员保存的：先选人，再勾指标；换人会重新加载这位成员的关注状态。</div></div>';
    }

    function load() {
      var qs = '?person=' + pickedPid;
      return Promise.all([get('/api/indicators' + qs), get('/api/watched' + qs)]).then(function (arr) {
        indicators = (arr[0] && arr[0].indicators) || [];
        var cur = (arr[1] && arr[1].watched) || [];
        var onMap = {};
        cur.forEach(function (w) { onMap[w.id] = true; });

        box.innerHTML = pickerHtml() +
          '<div class="field"><label>搜索指标</label>' +
          '<input type="text" id="v2Search" placeholder="输入名称，如 血糖 / 胆固醇 / CA19-9">' +
          '<div class="hint" id="v2FollowStat"></div></div>' +
          '<div class="field"><label>只看分类</label><select id="v2Cat">' +
          '<option value="">全部分类</option>' +
          cats.map(function (c) {
            return '<option value="' + attr(c.category) + '">' + esc(c.category) + '（' + c.count + '）</option>';
          }).join('') + '</select></div>' +
          '<div id="v2PickList" class="pick-list"></div>' +
          '<div class="df" style="border:0;padding:13px 0 0;justify-content:flex-start">' +
          '<button class="btn primary" id="v2FollowSave">保存改动</button>' +
          '<button class="btn" id="v2FollowAll">关注全部有数据的指标</button></div>';

        function statLine(shown) {
          // 当前选中成员的性别（「全部」视图下抽屉里也有选人下拉）
          var pinfo = null;
          persons.forEach(function (p) { if (Number(p.id) === Number(pickedPid)) pinfo = p; });
          var g = pinfo && pinfo.gender;
          var base = '共 ' + indicators.length + ' 个指标，已合并不同写法；当前已关注 ' +
            Object.keys(onMap).length + ' 项';
          if (g) base += '；已按「' + esc(pinfo.name) + '（' + esc(g) + '）」过滤异性专属指标' +
            '，到「成员管理」改性别可调整';
          else if (pinfo) base += '；该成员未设性别，暂不按性别过滤';
          // 统计「已关注、但这一屏没显示出来」的项：搜索过滤或 300 条截断都会造成
          var shownIds = {};
          shown.forEach(function (i) { shownIds[i.id] = true; });
          var hiddenWatched = 0;
          Object.keys(onMap).forEach(function (id) { if (!shownIds[id]) hiddenWatched++; });
          if (hiddenWatched > 0) {
            base += '；有 ' + hiddenWatched + ' 项已关注指标未显示，保存时<b>原样保留</b>，不会被取消';
          }
          return base + '。';
        }

        function draw() {
          var kw = (document.getElementById('v2Search').value || '').trim().toLowerCase();
          var cat = document.getElementById('v2Cat').value;
          var list = indicators.filter(function (i) {
            if (cat && (i.category || '') !== cat) return false;
            if (!kw) return true;
            return (i.name || '').toLowerCase().indexOf(kw) >= 0
              || (i.key || '').toLowerCase().indexOf(kw) >= 0;
          });
          // 有数据的排前面：没数据的也能关注，但用户多半是想看趋势
          list.sort(function (a, b) { return (b.obs_count || 0) - (a.obs_count || 0); });
          var shown = list.slice(0, 300);
          document.getElementById('v2PickList').innerHTML = (shown.length
            ? shown.map(function (i) {
              return '<div class="pi"><input type="checkbox" data-v2-pick="' + attr(i.id) + '"' +
                (onMap[i.id] ? ' checked' : '') + '>' +
                '<span class="info"><span class="n">' + esc(i.name) + '</span>' +
                '<span class="m">' + esc(i.category || '其他') + '　已有 ' + (i.obs_count || 0) + ' 条结果' +
                (i.date_count ? ' / ' + i.date_count + ' 个日期' : '') + '</span></span></div>';
            }).join('')
            : '<div class="empty">没有匹配的指标。</div>') +
            (list.length > shown.length ? '<div class="note">仅显示前 300 个，用搜索缩小范围。</div>' : '');
          document.getElementById('v2FollowStat').innerHTML = statLine(shown);
        }
        draw();
        document.getElementById('v2Search').oninput = draw;
        document.getElementById('v2Cat').onchange = draw;

        var pickPerson = document.getElementById('v2PickPerson');
        if (pickPerson) pickPerson.onchange = function () {
          pickedPid = Number(pickPerson.value);
          box.innerHTML = '<div class="note">正在切换成员…</div>';
          load();
        };

        /* 保存 = 只对「看得见并且勾选状态变了」的项做增/删。
           搜索框、300 条截断没显示出来的指标一概不碰 ——
           以前这里会把隐藏的已关注项整批取消，表现为"新加的关注把旧的覆盖了"。 */
        document.getElementById('v2FollowSave').onclick = function () {
          var jobs = [];
          C.qsa('#v2PickList input[data-v2-pick]').forEach(function (b) {
            var id = Number(b.getAttribute('data-v2-pick'));
            var checked = b.checked;
            if (checked === !!onMap[id]) return;
            jobs.push(post(checked ? '/api/watched/add' : '/api/watched/remove',
              { person_id: pickedPid, indicator_id: id }));
          });
          if (!jobs.length) { if (C.closeDrawers) C.closeDrawers(); return refresh(); }
          Promise.all(jobs).then(function () {
            if (C.closeDrawers) C.closeDrawers();
            refresh();
          });
        };

        document.getElementById('v2FollowAll').onclick = function () {
          var jobs = indicators.filter(function (i) { return (i.obs_count || 0) > 0; })
            .map(function (i) { return post('/api/watched/add', { person_id: pickedPid, indicator_id: i.id }); });
          Promise.all(jobs).then(function () {
            if (C.closeDrawers) C.closeDrawers();
            refresh();
          });
        };
      });
    }
    load();
  }

  /* ------------------------------------------------------------ 指标详情 */

  function openIndicatorById(id, fromLabel) {
    if (!C) return;
    var pid = curPerson();
    var qs = '?person=' + (pid === null ? '' : pid) + '&indicator=' + id +
      '&range=' + (v2Range || 'all');
    get('/api/trend' + qs).then(function (d) {
      if (!d || !d.ok) { notify('读取趋势失败', true); return; }
      renderIndicatorV2(d.trend, fromLabel || '数据概览');
    });
  }

  function renderIndicatorV2(tr, fromLabel) {
    var esc = C.esc, attr = C.attr, msg = C.msg;
    var ind = tr.indicator || {};
    C.S.indCtx = { key: ind.key, from: fromLabel };
    var back = document.getElementById('indBackLabel');
    if (back) back.textContent = '返回' + fromLabel;
    var ttl = document.getElementById('indTitle');
    if (ttl) ttl.textContent = ind.name || '指标';

    var h = '';
    h += '<div class="card" style="margin-bottom:14px"><div class="card-b" style="display:flex;' +
      'gap:16px;flex-wrap:wrap;align-items:center;justify-content:space-between">' +
      '<dl class="kv" style="grid-template-columns:auto minmax(0,1fr);gap:4px 10px;margin:0">' +
      '<dt>分类</dt><dd>' + esc(ind.category || '其他') + '</dd>' +
      '<dt>单位</dt><dd>' + (ind.unit ? esc(ind.unit) : '<span class="muted">未提供</span>') + '</dd>' +
      '<dt>点数</dt><dd>' + (tr.history ? tr.history.length : 0) + ' 条观测</dd>' +
      '</dl><div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<div class="range-tabs" id="v2IndRange">' +
      ['12', 'all'].map(function (r) {
        return '<button data-range="' + r + '" class="' + (v2Range === r ? 'on' : '') + '">' +
          (r === '12' ? '近 12 个月' : '全部') + '</button>';
      }).join('') + '</div></div></div></div>';

    /* 趋势：按单位分组，每组一条线 */
    var drawable = (tr.series || []).filter(function (s) { return s.can_draw; });
    if (!drawable.length) {
      h += '<div class="card" style="margin-bottom:14px"><div class="card-b">' +
        msg('可连线的有效日期点不足 2 个，未绘制趋势线。已有记录仍列在下方历史记录里。') +
        '</div></div>';
    } else {
      h += '<div class="card" style="margin-bottom:14px"><div class="card-h"><h3>趋势</h3></div><div class="card-b">';
      var palette = ['#2d77c9', '#c9562d', '#2d9c6b', '#8a5cc9', '#c9902d'];
      drawable.forEach(function (s, si) {
        // 全部成员视图下每人一条线，颜色区分
        var label = ind.name + (s.person_name ? ' · ' + s.person_name : '') +
          (s.unit ? '（' + s.unit + '）' : '');
        h += '<div class="sec-t">' + esc(label) +
          '　<span class="muted" style="font-weight:400">连线 ' + s.line.length + ' 点；' +
          '有效日期 ' + s.stats.dates + ' 个</span></div>';
        h += '<div class="chart-wrap" style="margin-bottom:14px">' + C.lineChart({
          ordinal: s.ordinal, yLabels: s.ylabels,
          series: [{
            name: label,
            color: palette[si % palette.length],
            points: s.line.map(function (p) {
              var ex = [];
              if (s.ordinal && p.label) ex.push('结果：' + p.label);
              if (p.pending) ex.push('日期待确认');
              return { date: p.date, value: p.value, unit: s.ordinal ? '' : s.unit,
                extra: ex.join(' · ') };
            })
          }], decimals: s.ordinal ? 0 : 2
        }) + '</div>';
      });
      var pend = 0;
      tr.series.forEach(function (s) {
        s.line.forEach(function (p) { if (p.pending) pend++; });
      });
      if (pend) {
        h += '<div class="note">其中有 ' + pend + ' 个点的档案日期仍是「待确认」（已画在图上并打了标记）。' +
          '对照原件核对无误后，到历史记录里点开对应档案，在详情页点「日期无误，确认」即可。</div>';
      }
      h += '</div></div>';
    }

    /* 历史记录：每条都能点「来源」回到原始档案 */
    h += '<div class="card"><div class="card-h"><h3>历史记录</h3>' +
      '<span class="sub">共 ' + (tr.history || []).length + ' 条</span></div><div class="card-b">';
    if (!(tr.history || []).length) {
      h += msg('暂无历史记录。');
    } else {
      h += '<div class="point-list">' + tr.history.slice().reverse().map(function (p) {
        return '<div class="pr">' +
          '<span class="dt">' + (p.date ? esc(C.L.fmtCN(p.date)) : '<span class="muted">无日期</span>') +
          (p.pending ? ' <span class="tag">待确认</span>' : '') + '</span>' +
          (p.person_name ? '<span class="nm">' + esc(p.person_name) + '</span>' : '') +
          '<span class="va"><b>' + esc(p.value || '—') + '</b>' +
          (p.unit ? ' <span class="muted">' + esc(p.unit) + '</span>' : '') + '</span>' +
          '<span class="src-chip' + (p.source === 'report' ? ' report' : '') + '">' +
          esc(p.source === 'report' ? '报告提取' : '手动录入') + '</span>' +
          (p.reference ? '<span class="muted" style="font-size:11.5px">参考 ' + esc(p.reference) + '</span>' : '') +
          (p.flag ? '<span class="flag">' + esc(p.flag) + '</span>' : '') +
          (p.document_id
            ? '<button class="btn sm ghost" data-src-doc="' + attr(p.document_id) + '">来源</button>'
            : '<span class="muted" style="font-size:11.5px">手动录入，无来源档案</span>') +
          '</div>';
      }).join('') + '</div>';
    }
    h += '</div></div>';

    document.getElementById('indBody').innerHTML = h;

    C.qsa('#v2IndRange button').forEach(function (b) {
      b.onclick = function () {
        v2Range = b.getAttribute('data-range');
        openIndicatorById(ind.id, fromLabel);
      };
    });
    C.qsa('#indBody [data-src-doc]').forEach(function (b) {
      b.onclick = function () { C.openDoc(b.getAttribute('data-src-doc'), '指标详情'); };
    });

    C.liftLayerOnTop('indLayer');
    var layer = document.getElementById('indLayer');
    if (!layer.classList.contains('on')) {
      C.openLayer('indLayer');
      C.pushHistory('indLayer');
    }
  }

  /* ------------------------------------------------------------ 指标目录管理
     归一化不可能一次全对。这里给用户兜底：改名、合并分错家的项、
     把误判成指标的「主诉/小结」标记回文本类。 */

  var catalogAll = [];

  function openCatalogManager() {
    var body = document.getElementById('catBody');
    if (!body || !C) return;
    body.innerHTML = '<div class="note">正在载入指标目录…</div>';
    C.liftLayerOnTop('catLayer');
    C.openLayer('catLayer');
    C.pushHistory('catLayer');

    var pid = curPerson();
    // 注意：pid 为空时不能拼出「/api/indicators&include_text=1」—— 少了 ? 会 404
    // gender=all：目录是管理视图，要能看到全部指标（含异性专属），
    // 否则改性别前标过的男/女专属项会「凭空消失」。
    get('/api/indicators?person=' + (pid === null ? '' : pid) + '&include_text=1&gender=all').then(function (d) {
      catalogAll = (d && d.indicators) || [];
      drawCatalog();
      var back = document.getElementById('catBack');
      if (back) back.onclick = function () { C.closeLayer(); };
    });
  }

  function drawCatalog() {
    var esc = C.esc, attr = C.attr;
    var body = document.getElementById('catBody');
    var cnt = document.getElementById('catCount');
    if (cnt) cnt.textContent = '共 ' + catalogAll.length + ' 项';

    body.innerHTML = '<div class="card"><div class="card-b">' +
      '<div class="note" style="margin:0 0 12px">这些指标是从已归档报告的检验项里自动识别并归一化出来的。' +
      '若某个指标被拆成了好几条（写法不同没合并成功），勾选后合并到先勾的那一条即可；' +
      '若某项其实是医生的文字描述（主诉、小结），标成「文本类」就不会出现在关注列表里。</div>' +
      '<div class="field"><label>搜索</label><input type="text" id="catSearch" ' +
      'placeholder="按名称或分类搜索"></div>' +
      '<div class="field"><label>筛选</label><select id="catFilter">' +
      '<option value="">全部</option><option value="text">仅文本类</option>' +
      '<option value="num">仅数值类</option></select></div>' +
      '<div id="catList"></div>' +
      '<div class="df" style="border:0;padding:13px 0 0;justify-content:flex-start">' +
      '<button class="btn primary" id="catMerge">合并所选到先勾的一项</button>' +
      '<button class="btn" id="catToText">所选标记为文本类</button>' +
      '<button class="btn" id="catToNum">所选标记为数值类</button></div>' +
      '</div></div>';

    function draw() {
      var kw = (document.getElementById('catSearch').value || '').trim().toLowerCase();
      var f = document.getElementById('catFilter').value;
      var list = catalogAll.filter(function (i) {
        if (f === 'text' && !i.is_text) return false;
        if (f === 'num' && i.is_text) return false;
        if (!kw) return true;
        return (i.name || '').toLowerCase().indexOf(kw) >= 0
          || (i.category || '').toLowerCase().indexOf(kw) >= 0;
      });
      list.sort(function (a, b) { return (b.obs_count || 0) - (a.obs_count || 0); });
      var shown = list.slice(0, 200);
      document.getElementById('catList').innerHTML =
        '<div class="pick-list">' + (shown.length ? shown.map(function (i) {
          return '<div class="pi"><input type="checkbox" data-cat-pick="' + attr(i.id) + '">' +
            '<span class="info"><span class="n">' + esc(i.name) +
            (i.is_text ? ' <span class="tag gray">文本</span>' : '') +
            (i.sex === 'male' ? ' <span class="tag gray">男</span>' : '') +
            (i.sex === 'female' ? ' <span class="tag gray">女</span>' : '') + '</span>' +
            '<span class="m">' + esc(i.category || '其他') + '　' + (i.obs_count || 0) + ' 条结果' +
            '　<span class="muted">' + esc(i.key) + '</span></span></span>' +
            '<button class="btn sm ghost" data-cat-view="' + attr(i.id) + '">详情</button></div>';
        }).join('') : '<div class="empty">没有匹配的指标。</div>') + '</div>' +
        (list.length > shown.length ? '<div class="note">仅显示前 200 项。</div>' : '');

      C.qsa('#catList [data-cat-view]').forEach(function (b) {
        b.onclick = function () { viewIndicator(b.getAttribute('data-cat-view')); };
      });
    }
    draw();
    document.getElementById('catSearch').oninput = draw;
    document.getElementById('catFilter').onchange = draw;

    function picked() {
      return C.qsa('#catList input[data-cat-pick]').filter(function (b) { return b.checked; })
        .map(function (b) { return Number(b.getAttribute('data-cat-pick')); });
    }

    document.getElementById('catMerge').onclick = function () {
      var ids = picked();
      if (ids.length < 2) { notify('请至少勾选 2 项，合并到先勾的那一项'); return; }
      var keep = catalogAll.filter(function (i) { return i.id === ids[0]; })[0] || {};
      if (!confirm('把后 ' + (ids.length - 1) + ' 项合并到「' + keep.name +
        '」？观测值与别名会一起迁过去，被合并的项会删除。')) return;
      post('/api/indicators/merge', { keep_id: ids[0], merge_ids: ids.slice(1) })
        .then(function (r) {
          notify(r && r.ok ? '已合并' : ('合并失败：' + ((r && r.reason) || '未知')), !(r && r.ok));
          openCatalogManager(); refresh();
        });
    };
    document.getElementById('catToText').onclick = function () {
      var ids = picked();
      if (!ids.length) { notify('请先勾选指标'); return; }
      Promise.all(ids.map(function (id) {
        return post('/api/indicators/text', { id: id, is_text: true });
      })).then(function () { notify('已标记为文本类'); openCatalogManager(); refresh(); });
    };
    document.getElementById('catToNum').onclick = function () {
      var ids = picked();
      if (!ids.length) { notify('请先勾选指标'); return; }
      Promise.all(ids.map(function (id) {
        return post('/api/indicators/text', { id: id, is_text: false });
      })).then(function () { notify('已标记为数值类'); openCatalogManager(); refresh(); });
    };
  }

  function viewIndicator(id) {
    var esc = C.esc, attr = C.attr;
    get('/api/indicators/get?id=' + id).then(function (d) {
      if (!d || !d.ok) { notify('读取指标失败', true); return; }
      var i = d.indicator;
      document.getElementById('catBody').innerHTML =
        '<div class="card"><div class="card-b">' +
        '<div class="field"><label>规范名称</label>' +
        '<input type="text" id="indRenameName" value="' + attr(i.name) + '"></div>' +
        '<div class="field"><label>别名（报告里的原始写法）</label>' +
        '<div class="note" style="margin:0">' +
        (i.aliases && i.aliases.length ? i.aliases.map(esc).join('、') : '（无）') + '</div></div>' +
        '<div class="field"><label>添加别名</label>' +
        '<input type="text" id="indAlias" placeholder="报告里还可能写成什么">' +
        '<div class="hint">添加后，下次解析报告遇到这个写法就会归到本指标。</div></div>' +
        '<div class="df" style="border:0;padding:13px 0 0;justify-content:flex-start">' +
        '<button class="btn primary" id="indSaveName">保存名称</button>' +
        '<button class="btn" id="indSaveAlias">添加别名</button>' +
        '<button class="btn" id="indViewTrend">查看趋势</button></div>' +
        '</div></div>' +
        '<div class="df"><button class="btn" id="indBack2">返回目录</button></div>';

      document.getElementById('indSaveName').onclick = function () {
        var v = document.getElementById('indRenameName').value.trim();
        if (!v) { notify('名称不能为空'); return; }
        post('/api/indicators/rename', { id: i.id, name: v })
          .then(function () { notify('已保存'); openCatalogManager(); });
      };
      document.getElementById('indSaveAlias').onclick = function () {
        var v = document.getElementById('indAlias').value.trim();
        if (!v) { notify('请填写别名'); return; }
        post('/api/indicators/alias', { id: i.id, alias: v }).then(function (r) {
          if (r && r.ok) { notify('已添加'); viewIndicator(i.id); }
          else notify((r && r.reason) || '添加失败', true);
        });
      };
      document.getElementById('indViewTrend').onclick = function () {
        openIndicatorById(i.id, '指标目录');
      };
      document.getElementById('indBack2').onclick = openCatalogManager;
    });
  }

  return {
    init: init,
    probe: probe,
    mountOverview: mountOverview,
    refresh: refresh,
    openIndicatorById: openIndicatorById,
    openCatalogManager: openCatalogManager,
    isEnabled: function () { return enabled; }
  };
})();
