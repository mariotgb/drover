import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './_bundle.mjs'

const m = await load()
const opts = { cwd: '/Users/me/shop', home: '/Users/me' }
const to = (s) => m.previewTarget(s, opts)

test('the preview opens dev servers, URLs and local HTML files', () => {
  assert.equal(to('localhost:5173'), 'http://localhost:5173/')
  assert.equal(to('3000'), 'http://localhost:3000/')
  assert.equal(to('https://example.com/a'), 'https://example.com/a')
  assert.equal(to('/Users/me/site/my page.html'), 'file:///Users/me/site/my%20page.html')
  assert.equal(to('"/Users/me/site/index.html"'), 'file:///Users/me/site/index.html')
  assert.equal(to('~/Desktop/demo.html'), 'file:///Users/me/Desktop/demo.html')
  assert.equal(to('index.html'), 'file:///Users/me/shop/index.html')
  assert.equal(to('dist/index.html'), 'file:///Users/me/shop/dist/index.html')
  assert.equal(to('./public/../docs/a.htm'), 'file:///Users/me/shop/docs/a.htm')
  assert.equal(to('example.com/index.html'), 'http://example.com/index.html')
  assert.equal(to('file:///tmp/x.html'), 'file:///tmp/x.html')
  assert.equal(to('javascript:alert(1)'), null)
  assert.equal(to('ftp://host/x'), null)
  assert.equal(to('   '), null)
  assert.equal(m.previewTarget('~/x.html', {}), null)
})

test('only local pages open on their own, files show as paths', () => {
  for (const u of ['http://localhost:5173/', 'http://127.0.0.1:8080/x', 'http://[::1]:3000/', 'http://app.localhost/', 'file:///tmp/x.html']) {
    assert.equal(m.isLocalTarget(u), true, u)
  }
  for (const u of ['https://claude.ai/code/artifact/abc', 'https://example.com/', 'not a url']) assert.equal(m.isLocalTarget(u), false, u)
  assert.equal(m.displayTarget('file:///Users/me/my%20page.html'), '/Users/me/my page.html')
  assert.equal(m.displayTarget('http://localhost:5173/'), 'http://localhost:5173/')
})
