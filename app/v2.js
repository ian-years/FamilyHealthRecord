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
  var indicators = [];          // 可关注的全部指标（「添加关注」抽屉用）
  var watched = [];             // 当前成员关注的指标
  var allWithData = [];         // 全部有数据的指标（概览未关注行用）
  var fees = null;
  var cats = [];
  var busy = false;
  var followSort = 'name';      // 概览关注表排序键：name | points | date
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

  /** 当前视图对应的成员值：
   *  「全部」→ null（后端不过滤人）；「未指定」→ 0（只看无归属的行）；成员 → 正整数。
   *  以前 0 被当成「全部」返回 null，于是「未指定」视图里显示的是全员的数据。 */
  function curPerson() {
    if (!C || !C.S) return null;
    var S = C.S;
    if (C.L && typeof C.L.isAllView === 'function' && C.L.isAllView(S.personView)) return null;
    var n = Number(S.personView);
    return isFinite(n) && n >= 0 ? n : null;
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
    var qs = (pid === null) ? '' : ('?person=' + pid);   // 0 = 未指定，必须显式带上
    return Promise.all([
      get('/api/indicators/categories'),
      get('/api/watched' + qs),
      get('/api/fees/summary' + qs),
      get('/api/indicators' + (qs ? (qs + '&only_data=1') : '?only_data=1'))
    ]).then(function (arr) {
      cats = (arr[0] && arr[0].categories) || [];
      watched = (arr[1] && arr[1].watched) || [];
      fees = (arr[2] && arr[2].fees) || null;
      allWithData = (arr[3] && arr[3].indicators) || [];
      renderFollowCard();
      renderFeesCards();
      busy = false;
    })['catch'](function () { busy = false; });
  }

  /* ------------------------------------------------------------ 关注指标卡 */

  /* 概览关注指标卡：已关注排前面，未关注但有数据的追加在下面（可展开/收起），
     两组都支持按名称/分类、点数、最新日期排序。 */
  function sortFollowRows(list) {
    return list.slice().sort(function (a, b) {
      if (followSort === 'name') {
        return (a.name || '').localeCompare(b.name || '', 'zh');
      }
      if (followSort === 'date') {
        // ISO 日期字符串字典序 == 时间序，空日期排最后
        var da = a.last_date || '', db = b.last_date || '';
        if (da === db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return db.localeCompare(da);   // 降序：最新在前
      }
      // points：点数降序
      return (b.date_count || 0) - (a.date_count || 0);
    });
  }
  function followRowHtml(w, isFollowed) {
    var esc = C.esc, attr = C.attr;
    var has = w.last_value !== null && w.last_value !== undefined && w.last_value !== '';
    var spark = (w.spark && w.spark.length >= 2)
      ? C.sparkline(w.spark.map(function (p) { return { value: p.value }; }))
      : '<span class="muted" style="font-size:11px">不足 2 点</span>';
    return '<tr' + (isFollowed ? '' : ' class="unfollowed"') + '>' +
      '<td><b>' + esc(w.name) + '</b>' +
      (w.is_text ? ' <span class="tag gray">文本</span>' : '') +
      (isFollowed ? '' : ' <span class="muted" style="font-size:11px;font-weight:400">未关注</span>') + '</td>' +
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
      (isFollowed
        ? '<button class="btn sm ghost" data-v2-unwatch="' + attr(w.id) + '">取消关注</button>'
        : '<button class="btn sm" data-v2-watch="' + attr(w.id) + '">关注</button>') +
      '</td></tr>';
  }

  function renderFollowCard() {
    var card = document.getElementById('cardFollow');
    if (!card || !C) return;
    var esc = C.esc, attr = C.attr;
    var pid = curPerson();
    var isAll = pid === null;
    var isUnassigned = pid === 0;   // 「未指定」：档案还没有归属成员

    /* 未关注但有数据 = 全部有数据的指标 - 已关注集合。 */
    var watchedIds = {};
    watched.forEach(function (w) { watchedIds[w.id] = true; });
    var unfollowed = allWithData.filter(function (i) { return !watchedIds[i.id]; });

    var sortOptions = [
      { k: 'name', label: '名称 / 分类' },
      { k: 'points', label: '点数' },
      { k: 'date', label: '最新日期' }
    ];
    var head = '<div class="card-h"><h3>关注指标 <span class="sub">最新结果与趋势概览</span></h3>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
      '<button class="btn sm" id="v2BtnFollow">添加关注</button>' +
      '<button class="btn sm" id="v2BtnManage">指标目录</button>' +
      '<button class="btn sm" id="v2BtnCustom">自定义指标</button>' +
      '<span class="muted" style="font-size:11px">排序</span>' +
      '<select class="sm" id="v2FollowSort" style="width:auto;padding:3px 6px">' +
      sortOptions.map(function (o) {
        return '<option value="' + o.k + '"' + (followSort === o.k ? ' selected' : '') + '>' +
          o.label + '</option>';
      }).join('') + '</select>' +
      '</div></div>';

    var body = '<div class="card-b">';
    body += '<div class="note" style="margin:0 0 11px">已关注的排前面，未关注但有数据的列在下面。' +
      '可关注的指标来自已归档报告里的全部检验项（已归一化）。' +
      (isAll ? '当前是「全部成员」视图，切到具体成员才能看到各人的数值与趋势。'
        : (isUnassigned ? '当前是「未指定」视图（档案还没有归属成员）。关注是按成员保存的，切到具体成员才能看到。' : '')) +
      '</div>';

    var tblHead = '<table class="tbl"><thead><tr>' +
      '<th>指标名</th><th>分类</th><th>最新结果</th><th>最新日期</th>' +
      '<th class="r">点数</th><th>小趋势</th><th></th></tr></thead><tbody>';

    var followedRows = sortFollowRows(watched);
    var unfollowedRows = sortFollowRows(unfollowed);

    if (!followedRows.length && !unfollowedRows.length) {
      body += '<div class="empty">' + (isUnassigned
        ? '「未指定」的档案还没有归属成员，没有属于自己的关注清单。'
        : '还没有任何指标数据。归档资料后这里会列出可关注的指标。') + '</div>';
    } else {
      body += '<div class="tbl-scroll">' + tblHead;

      if (!followedRows.length) {
        body += '<tr><td colspan="7" class="muted">' +
          (isUnassigned ? '未指定视图没有关注清单。' : '还没有关注任何指标，下面只列出未关注但有数据的。') +
          '</td></tr>';
      } else {
        body += followedRows.map(function (w) { return followRowHtml(w, true); }).join('');
      }

      if (unfollowedRows.length) {
        body += '<tr class="sep-row"><td colspan="7">' +
          '<div class="sep-note">— 未关注但有数据（' + unfollowedRows.length + ' 项）—</div></td></tr>';
        body += unfollowedRows.map(function (w) { return followRowHtml(w, false); }).join('');
      }
      body += '</tbody></table></div>';
    }
    body += '</div>';

    card.innerHTML = head + body;

    var b1 = document.getElementById('v2BtnFollow');
    if (b1) b1.onclick = openFollowDrawerV2;
    var b2 = document.getElementById('v2BtnManage');
    if (b2) b2.onclick = openCatalogManager;
    var b3 = document.getElementById('v2BtnCustom');
    if (b3) b3.onclick = function () { if (C.openCustomDrawer) C.openCustomDrawer(); };
    var bs = document.getElementById('v2FollowSort');
    if (bs) bs.onchange = function () { followSort = bs.value; renderFollowCard(); };

    /* 「关注指标」KPI 与这张卡必须同源：卡上是 /api/watched 的清单，
       KPI 却还在数目录行上的 followers 就会出现「卡里 3 项、KPI 写 5 项」。
       卡是唯一真源的渲染点，顺手把 KPI 一起刷新。 */
    var kc = document.getElementById('kpiWatchedCount');
    if (kc) kc.textContent = String(watched.length);

    C.qsa('#cardFollow [data-v2-ind]').forEach(function (b) {
      b.onclick = function () { openIndicatorById(b.getAttribute('data-v2-ind')); };
    });
    C.qsa('#cardFollow [data-v2-unwatch]').forEach(function (b) {
      b.onclick = function () {
        /* 「全部」视图的列表是去重后的并集，没有单一归属人，
           person_id 传 'all' 表示把所有成员对它的关注一起取消；
           具体成员（含「未指定」）则只取消他自己的。 */
        var cur = curPerson();
        post('/api/watched/remove', {
          person_id: (cur === null ? 'all' : cur),
          indicator_id: Number(b.getAttribute('data-v2-unwatch'))
        }).then(function () { refresh(); });
      };
    });
    C.qsa('#cardFollow [data-v2-watch]').forEach(function (b) {
      b.onclick = function () {
        var cur = curPerson();
        if (cur === null || cur === 0) {
          /* 「全部」/「未指定」视图没有可写的主语，提示先去选成员。 */
          notify('关注是按成员保存的：请先切到具体成员，再点「关注」。', true);
          return;
        }
        post('/api/watched/add', {
          person_id: cur,
          indicator_id: Number(b.getAttribute('data-v2-watch'))
        }).then(function () { refresh(); });
      };
    });

    /* 关注指标卡变长后，把「跨年度资料活动」「资料类型分布」挪到右列，
       避免左列过长把这两个卡片挤到很下面。 */
    rebalanceOverview(followedRows.length + unfollowedRows.length);
  }

  /* 概览左右列自适应：关注指标行数多时，把左列末尾的「跨年度资料活动」和
     「资料类型分布」两张卡移到右列（费用卡后面），行数少时移回左列。 */
  var REBALANCE_THRESHOLD = 12;   // 关注指标总行数超过该值时触发右移
  function rebalanceOverview(followRows) {
    var activity = document.getElementById('cardActivity');
    var typeDist = document.getElementById('cardTypeDist');
    if (!activity || !typeDist) return;
    var right = document.getElementById('gridRight');
    var shouldMove = followRows > REBALANCE_THRESHOLD;

    // 判断 activity 当前是否已在右列：它在 gridRight 里还是别处
    var alreadyRight = right && activity.parentNode === right;

    if (shouldMove && !alreadyRight && right) {
      // 移到右列：插到「用药概况」卡（右列最后一张）之后
      right.appendChild(activity);
      right.appendChild(typeDist);
    } else if (!shouldMove && alreadyRight) {
      // 移回左列：插到 cardFollow 之后（恢复原来的顺序）
      var follow = document.getElementById('cardFollow');
      if (follow && follow.parentNode) {
        follow.parentNode.insertBefore(activity, follow.nextSibling);
        follow.parentNode.insertBefore(typeDist, activity.nextSibling);
      }
    }
  }

  /* ------------------------------------------------------------ 票据来源层 */

  /* 费用卡上的「查看全部票据来源」。
     列表直接用费用卡那份 fees.items —— 不再另算一遍：旧实现是卡片按成员过滤、
     抽屉读整表，于是同一次点击前后出现两个总额。 */
  function openReceiptsLayer() {
    if (!C || !fees) return;
    var esc = C.esc, attr = C.attr, msg = C.msg;
    var body = document.getElementById('rcBody');
    if (!body) return;
    var h = '<div class="note" style="margin:0 0 12px">统计范围：<b>' +
      esc(C.personViewLabel()) + '</b>，与概览那张费用卡同源（同一份服务端口径）。</div>';
    h += '<div class="card" style="margin-bottom:14px"><div class="card-b">' +
      '<div class="kv" style="grid-template-columns:118px minmax(0,1fr)">' +
      '<dt>已录入总额</dt><dd><b class="num">' + money(fees.total_cents) + '</b>　' +
      fees.count + ' 张</dd>' +
      '<dt>金额未知</dt><dd>' + fees.unknown_count +
      ' 张 <span class="muted">（不计入合计，也不在本列表中）</span></dd>' +
      '</div><div class="note">金额未知（缺失、空串、不可解析）不参与合计；' +
      '明确零金额是真实的 0 元，照常参与统计。</div></div></div>';
    var items = fees.items || [];
    if (!items.length) {
      h += '<div class="card"><div class="card-b">' +
        msg('这个范围下还没有录入金额的档案。') + '</div></div>';
    } else {
      h += '<div class="card"><div class="card-h"><h3>票据来源</h3><span class="sub">共 ' +
        items.length + ' 条，按日期倒序</span></div><div class="card-b"><div class="point-list">';
      items.forEach(function (it) {
        h += '<div class="pr">' +
          '<span class="dt">' + (it.date ? esc(C.L.fmtCN(it.date))
            : '<span class="muted">无日期</span>') + '</span>' +
          '<span class="va"><b>' + money(it.amount_cents) + '</b></span>' +
          '<span class="muted" style="font-size:11.5px">' + esc(it.document_type || '') + '</span>' +
          esc(it.title || '(无标题)') +
          (it.document_id
            ? '<button class="btn sm ghost" data-src-doc="' + attr(it.document_id) + '">来源</button>'
            : '') +
          '</div>';
      });
      h += '</div></div></div>';
    }
    body.innerHTML = h;
    C.qsa('#rcBody [data-src-doc]').forEach(function (b) {
      b.onclick = function () { C.openDoc(b.getAttribute('data-src-doc'), '费用来源'); };
    });
    C.liftLayerOnTop('rcLayer');
    var layer = document.getElementById('rcLayer');
    if (layer && !layer.classList.contains('on')) {
      C.openLayer('rcLayer');
      C.pushHistory('rcLayer');
    }
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
      h += '<div style="margin-top:12px">' +
        '<button class="btn primary" id="v2BtnReceipts">查看全部票据来源</button></div>';
      h += '</div>';
      card.innerHTML = h;
      var br = document.getElementById('v2BtnReceipts');
      if (br) br.onclick = openReceiptsLayer;

      /* KPI 与卡片必须同源：卡片读 /api/fees/summary，KPI 若还在按前端的
         L.buildFees(recs) 现算，同一次点击就会出现两个总额。 */
      var kn = document.getElementById('kpiFees');
      if (kn) kn.textContent = money(fees.total_cents).replace('¥', '');
      var kd = document.getElementById('kpiFeesDetail');
      if (kd) kd.textContent = '明确金额 ' + fees.count + ' 张；金额未知 ' +
        fees.unknown_count + ' 张未计入';
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
    var cur = curPerson();
    /* 「全部」与「未指定」都没有一个可写的主语（关注是「谁关心某项」），
       让用户先选人再勾；具体成员视图直接用当前成员。 */
    var isAll = (cur === null || cur === 0);
    var persons = (C.S && C.S.persons) || [];
    var pickedPid = isAll
      ? (persons.length ? Number(persons[0].id) : null)
      : cur;
    if (pickedPid === null) { notify('还没有家庭成员，先到「成员」页添加。', true); return; }

    // 抽屉里必须写清正在编辑谁的清单：关注是按成员存的，进错了人却没提示，
    // 用户会以为自己的勾选"丢了"（其实勾在别人名下）。
    function personName(pid) {
      var hit = null;
      persons.forEach(function (p) { if (Number(p.id) === Number(pid)) hit = p.name; });
      return hit || ('#' + pid);
    }

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

        box.innerHTML = '<div class="note" style="margin:0 0 11px">正在编辑 <b>' +
          esc(personName(pickedPid)) + '</b> 的关注清单 —— 关注按成员保存，改这里不会影响别人。</div>' +
          pickerHtml() +
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
          '<button class="btn" id="v2FollowAll">关注全部有数据的指标</button></div>' +
          '<div class="field" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">' +
          '<label>复制关注集</label>' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
          '<select id="v2CopyFrom">' + persons.filter(function (p) {
            return Number(p.id) !== Number(pickedPid);
          }).map(function (p) {
            return '<option value="' + attr(p.id) + '">' + esc(p.name) + '</option>';
          }).join('') + '</select>' +
          '<button class="btn sm" id="v2CopyBtn">复制到「' + esc(personName(pickedPid)) + '」</button>' +
          '</div>' +
          '<div class="hint">把另一位成员的关注清单合并进当前成员：已有关注原样保留，只补当前成员还没有的项。</div></div>';

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
          var btn = document.getElementById('v2FollowAll');
          var ids = indicators.filter(function (i) { return (i.obs_count || 0) > 0; })
            .map(function (i) { return i.id; });
          if (!ids.length) { notify('没有有数据的指标可关注。', true); return; }
          // 一次批量写入，避免几百个指标发几百次请求卡好几秒
          if (btn) { btn.disabled = true; btn.textContent = '正在关注 ' + ids.length + ' 项…'; }
          post('/api/watched/add-batch', { person_id: pickedPid, indicator_ids: ids })
            .then(function (r) {
              if (r && r.ok) {
                notify('已关注 ' + ids.length + ' 项（新增 ' + (r.added || 0) + ' 项）。');
                if (C.closeDrawers) C.closeDrawers();
                refresh();
              } else {
                notify('关注失败：' + ((r && r.reason) || '未知'), true);
                if (btn) { btn.disabled = false; btn.textContent = '关注全部有数据的指标'; }
              }
            })['catch'](function (e) {
              notify('关注失败：' + (e && e.message ? e.message : '未知'), true);
              if (btn) { btn.disabled = false; btn.textContent = '关注全部有数据的指标'; }
            });
        };

        var copySel = document.getElementById('v2CopyFrom');
        var copyBtn = document.getElementById('v2CopyBtn');
        if (copyBtn && copySel) {
          copyBtn.onclick = function () {
            if (!copySel.value) { notify('没有可复制的成员。', true); return; }
            var from = Number(copySel.value);
            if (from === Number(pickedPid)) { notify('不能复制给自己。', true); return; }
            post('/api/watched/copy', { from_person_id: from, to_person_id: pickedPid })
              .then(function (r) {
                if (r && r.ok) {
                  notify('已复制关注集：新增 ' + (r.added || 0) + ' 项关注。');
                  load();
                  refresh();
                } else {
                  notify('复制失败：' + ((r && r.reason) || '未知'), true);
                }
              })['catch'](function (e) {
                notify('复制失败：' + (e && e.message ? e.message : '未知'), true);
              });
          };
        }
      });
    }
    load();
  }

  /* ------------------------------------------------------------ 指标详情 */

  /** 按稳定键打开指标详情。日常录入抽屉手里只有 key（没有 id），
      存完要顺手刷新详情层就靠这条路径 —— 否则它会去调旧实现，
      于是同一个 #indBody 被两套渲染器各写一遍。 */
  function openIndicatorByKey(key, fromLabel) {
    if (!C || !key) return Promise.resolve(false);
    return get('/api/indicators/get?key=' + encodeURIComponent(key)).then(function (d) {
      if (!d || !d.ok || !d.indicator) { notify('找不到这个指标', true); return false; }
      openIndicatorById(d.indicator.id, fromLabel);
      return true;
    })['catch'](function () { return false; });
  }

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
      /* 范围值必须用后端认识的写法（'12m'）—— 早前这里发的是 '12'，
         后端 _range_start 认不出就当成了「全部」，这个按钮实际是空转的。 */
      ['12m', 'all'].map(function (r) {
        return '<button data-range="' + r + '" class="' + (v2Range === r ? 'on' : '') + '">' +
          (r === '12m' ? '近 12 个月' : '全部') + '</button>';
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
    openIndicatorByKey: openIndicatorByKey,
    openCatalogManager: openCatalogManager,
    isEnabled: function () { return enabled; }
  };
})();
