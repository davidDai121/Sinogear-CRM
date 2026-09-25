/** 拆条发送：正文按空行拆成几条，只对 Miles V3 模板打开。离线，不碰客户、数据库、浏览器。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

async function load(path) {
  const built = await build({
    entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
}

const { splitReplyParts } = await load('../src/lib/reply-parts.ts');
const { splitsCustomerMessages } = await load('../src/lib/gpt-template-routing.ts');

const skillTemplate = (skillId) => ({
  id: 't', name: 't', is_default: false, gpt_url: 'https://chatgpt.com/',
  description: 'SGC_GPT_TEMPLATE_CONFIG\n' + JSON.stringify({
    schema: 'sinogear.gpt-template', version: 2, description: '', approvedKnowledge: '',
    updatedAt: '2026-09-25T00:00:00.000Z', skill: { id: skillId, name: 'x' },
  }),
});

test('空行分条，条内单换行保留，首尾空白和多余空行去掉', () => {
  const text = '\nSjors, quick one.\n\nUsed iCar 03T ~USD 15,000\nVW ID. ERA 9X ~55,000\n \n\n\nHow many units per order?\n';
  assert.deepEqual(splitReplyParts(text), [
    'Sjors, quick one.',
    'Used iCar 03T ~USD 15,000\nVW ID. ERA 9X ~55,000',
    'How many units per order?',
  ]);
});

test('没有空行就是一条；空文本没有条', () => {
  assert.deepEqual(splitReplyParts('Only one line\nsecond line'), ['Only one line\nsecond line']);
  assert.deepEqual(splitReplyParts('   \n\n  '), []);
});

test('Miles V3（Yang / Menglong 两个账号）拆条', () => {
  // 模板里的技能 ID 被 validateGptSkill 限定为小写 plugin_<hex>
  assert.equal(splitsCustomerMessages(skillTemplate('plugin_97e03b69e63481918e6471104dfaea98')), true);
  assert.equal(splitsCustomerMessages(skillTemplate('plugin_ce56f4d023848191aab8d1b9e79d19f7')), true);
});

test('V2、R08、自建 GPT、没有信封的模板都不拆条', () => {
  // V2 · Sophia、R08 · Yang 的插件 ID
  assert.equal(splitsCustomerMessages(skillTemplate('plugin_bd1c07b5bea881918f10f1dbfb43d9e1')), false);
  assert.equal(splitsCustomerMessages(skillTemplate('plugin_be083c80ae4c81919339c7e557170738')), false);
  assert.equal(splitsCustomerMessages({ description: '普通说明，没有信封' }), false);
  assert.equal(splitsCustomerMessages({ description: null }), false);
  assert.equal(splitsCustomerMessages({ description: 'SGC_GPT_TEMPLATE_CONFIG\n{坏掉的 json' }), false);
});
