/* ============================================================
   在 Node 中运行业务逻辑自检（无需浏览器）
   ------------------------------------------------------------
   用法：
     node app/run-tests.js
   退出码 0 表示全部通过，1 表示有失败用例。
   浏览器里运行同一批用例请打开 app/tests.html。
   ============================================================ */
'use strict';

// 业务逻辑与自检脚本都按「浏览器脚本」写，这里补上 window 桥接，使两者在 Node 中同样可用
globalThis.window = globalThis;
globalThis.TEST_QUIET = true;   // 只打印失败项与汇总，避免命令行刷屏

require('./logic.js');
require('./localdb.js');
require('./tests.js');

globalThis.TEST_DONE.then(function (R) {
  if (R.failed === 0) {
    console.log('全部通过：' + R.total + ' 项');
  } else {
    R.results.filter(function (r) { return !r.ok; }).forEach(function (r) {
      console.error('FAIL  ' + r.name + '\n      ' + r.msg);
    });
    console.error('共 ' + R.total + ' 项，通过 ' + R.passed + ' 项，失败 ' + R.failed + ' 项');
  }
  process.exit(R.failed ? 1 : 0);
}).catch(function (e) {
  console.error('自检未能完成：' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
