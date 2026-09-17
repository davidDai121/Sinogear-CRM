import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/vehicle-media-groups.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
});
const {
  CERTIFICATION_TEMPLATE_PREFIX: prefix,
  isCertificationTemplate,
  groupVehicleMedia,
  displayVehicleMediaCaption,
  updatedVehicleMediaCaption,
} = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const media = (id, media_type, caption = null) => ({ id, media_type, caption });

test('only explicitly marked spec documents become certification references', () => {
  assert.equal(isCertificationTemplate(media('reference', 'spec', prefix + '办证参考')), true);
  for (const row of [
    media('plain', 'spec', 'Certification sample / 认证样本'),
    media('embedded', 'spec', '配置说明 ' + prefix + '示例'),
    media('near-match', 'spec', '[certification-template]'),
    media('null', 'spec'),
    media('photo', 'image', prefix + '拍摄备注'),
    media('video', 'video', prefix + '视频备注'),
  ]) assert.equal(isCertificationTemplate(row), false, row.id);
});

test('the normal spec batch excludes both references and preserves existing item order and identity', () => {
  const rows = [
    media('spec-1', 'spec', 'R08 English specification'),
    media('toyota-reference', 'spec', prefix + 'Toyota bZ3X 空调声明参考样本'),
    media('photo', 'image'),
    media('spec-2', 'spec', 'R08 Spanish specification'),
    media('avatr-reference', 'spec', prefix + 'AVATR06 铭牌参考样本'),
    media('video', 'video'),
  ];
  const original = structuredClone(rows);
  const groups = groupVehicleMedia(rows);
  assert.deepEqual(groups.spec.map((row) => row.id), ['spec-1', 'spec-2']);
  assert.deepEqual(groups.certificationTemplates.map((row) => row.id), ['toyota-reference', 'avatr-reference']);
  assert.deepEqual(groups.image.map((row) => row.id), ['photo']);
  assert.deepEqual(groups.video.map((row) => row.id), ['video']);
  assert.equal(groups.spec[0], rows[0]);
  assert.equal(groups.certificationTemplates[0], rows[1]);
  assert.deepEqual(rows, original);
});

test('reference-only libraries have an empty normal spec batch', () => {
  const groups = groupVehicleMedia([media('sample', 'spec', prefix + '参考')]);
  assert.equal(groups.spec.length, 0);
  assert.equal(groups.certificationTemplates.length, 1);
  assert.deepEqual(groupVehicleMedia([]), { image: [], video: [], spec: [], certificationTemplates: [] });
});

test('editing or clearing a displayed reference note preserves its classification after saving', () => {
  const reference = media('reference', 'spec', prefix + '原备注');
  assert.equal(displayVehicleMediaCaption(reference), '原备注');
  for (const nextNote of ['  新用途说明  ', '', '   ']) {
    const saved = { ...reference, caption: updatedVehicleMediaCaption(reference, nextNote) };
    assert.equal(isCertificationTemplate(saved), true);
    assert.equal(displayVehicleMediaCaption(saved), nextNote.trim());
    assert.equal(groupVehicleMedia([saved]).spec.length, 0);
  }
  assert.equal(updatedVehicleMediaCaption(reference, ''), prefix);
});

test('ordinary media notes keep their existing display and trim/null save behavior', () => {
  const ordinary = media('normal', 'spec', '配置备注');
  assert.equal(displayVehicleMediaCaption(ordinary), '配置备注');
  assert.equal(updatedVehicleMediaCaption(ordinary, '  配置说明  '), '配置说明');
  assert.equal(updatedVehicleMediaCaption(ordinary, '  '), null);
  assert.equal(displayVehicleMediaCaption(media('empty', 'spec')), '');
  const photo = media('photo', 'image', prefix + '图片备注');
  assert.equal(displayVehicleMediaCaption(photo), prefix + '图片备注');
});
