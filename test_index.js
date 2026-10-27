const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const script = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
new vm.Script(script);
const context = vm.createContext({localStorage: {getItem: () => null}, setTimeout, clearTimeout});
vm.runInContext(fs.readFileSync(`${__dirname}/common.js`, 'utf8'), context);
vm.runInContext(script.split('function card(')[0] + `
openGpus.add('host|GPU-test');
globalThis.renderProc = p => gpuRow('host', {uuid: 'GPU-test', index: 0, procs: [p]});
`, context);

for (const [seconds, expected] of [[null, '--'], [undefined, '--'], [-1, '--'],
    [NaN, '--'], [Infinity, '--'], [0, '0秒'], [59, '59秒'], [60, '1分0秒'],
    [3599, '59分59秒'], [3600, '1小时0分'], [86399, '23小时59分'],
    [86400, '1天0小时'], [183600, '2天3小时']]) {
  assert.strictEqual(context.fmtDuration(seconds), expected);
}
const html = context.renderProc({container: 'training-job', name: '/usr/bin/python',
  pid: '101', mem: 1024, elapsed_seconds: 183600});
assert(html.includes('>training-job</span><span title="/usr/bin/python">/usr/bin/python</span>'));
assert(html.includes('#101') && html.includes('1.0 GB') && html.includes('已运行 2天3小时'));
const fallback = context.renderProc({name: 'worker', pid: '102'});
assert(fallback.includes('>worker</span>') && fallback.includes('已运行 --'));
assert(!fallback.includes('class="pcontainer"'));
assert(!context.renderProc({container: '<img src=x>', name: '<script>'}).includes('<img src=x>'));
console.log('页面时长格式、名称显示、回退和日志过滤检查通过');

async function testLogFilter(){   // 日志过滤: 多词 AND、大小写不敏感; 半行留到写完; 改词后整体重画
  for (const [line, q, want] of [['ERROR bad thing', 'error', true], ['ERROR bad thing', 'error warn', false],
      ['plain line', 'PLAIN', true], ['a b c', 'b a', true], ['x', '', true]])
    assert.strictEqual(context.matchFilter(line, context.parseFilter(q)), want);
  const pre = {textContent: '', insertAdjacentHTML(_, html){ this.textContent += html; },
               scrollHeight: 0, scrollTop: 0, clientHeight: 0};
  let onInput;
  const input = {addEventListener(_, fn){ onInput = fn; }, value: ''};
  const cnt = {textContent: ''};
  const lf = context.lineFilter(pre, input, cnt, 1e9);
  lf.emit('ERROR one\nINFO two\n');
  assert(pre.textContent.includes('one') && pre.textContent.includes('two'));   // 无过滤词全显示
  input.value = 'error';
  onInput();
  await new Promise(r => setTimeout(r, 400));                                   // 等防抖
  assert(pre.textContent.includes('ERROR one') && !pre.textContent.includes('INFO two'));
  assert.strictEqual(cnt.textContent, '1/2 行');
  lf.emit('ERROR a\nINFO b\nERROR c\nno newline yet');
  assert(pre.textContent.includes('ERROR a') && !pre.textContent.includes('INFO b') && pre.textContent.includes('ERROR c'));
  assert(!pre.textContent.includes('newline yet'));                             // 半行不显示
  console.log('日志过滤检查通过');
}
testLogFilter().catch(error => { console.error(error); process.exitCode = 1; });

async function testClearButton(){
  let onClick, confirmation, requests = 0, refreshes = 0;
  const alerts = [];
  const button = {dataset: {clearHost: 'test-host'}, disabled: false};
  context.document = {querySelector: selector => selector === '#root'
    ? {addEventListener: (_, callback) => { onClick = callback; }}
    : {dataset: {sort: 'manual'}}};
  context.prompt = () => confirmation;
  context.alert = message => alerts.push(message);
  context.fetch = async (url, options) => {
    requests++;
    assert.strictEqual(url, '/api/hosts/clear');
    assert.strictEqual(options.headers['X-GPUMon-Token'], '__GPUMON_CLEAR_TOKEN__');
    assert.deepStrictEqual(JSON.parse(options.body), {host: 'test-host', confirmation: 'test-host'});
    return {json: async () => ({ok: false, killed: [101], failed: [], remaining: [102]})};
  };
  context.countRefresh = () => refreshes++;
  vm.runInContext(script.slice(script.indexOf('function card('), script.indexOf('function tally(')), context);
  vm.runInContext(`function render(){}; function refresh(){ countRefresh(); }
results.set('test-host', {ok: true, gpus: []});`, context);
  assert(context.card('test-host', '').includes('清空'));
  vm.runInContext(script.slice(script.indexOf("$('#root').addEventListener('click', async e => {"),
    script.indexOf("$('#refreshBtn').addEventListener('click', refresh);")), context);
  const event = {target: {closest: selector => selector === '[data-clear-host]' ? button : null}};
  confirmation = null;
  await onClick(event);
  assert.strictEqual(requests, 0);
  confirmation = 'wrong';
  await onClick(event);
  assert.strictEqual(requests, 0);
  assert(alerts.pop().includes('未执行清空'));
  confirmation = 'test-host';
  const pending = onClick(event);
  await Promise.resolve();   // 弹窗改为 await 后, 状态更新落在下一个微任务
  assert(context.card('test-host', '').includes('清空中…'));
  await onClick(event);
  await pending;
  assert.strictEqual(requests, 1);
  assert.strictEqual(refreshes, 1);
  assert(alerts.pop().includes('仍在占卡：PID 102'));
  assert(context.card('test-host', '').includes('清空'));
  console.log('清空按钮：取消、名字校验、重复点击、结果提示和刷新检查通过');
}
testClearButton().catch(error => { console.error(error); process.exitCode = 1; });
