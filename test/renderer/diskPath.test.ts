import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toDiskPath } from '../../src/lib/diskPath.ts'

test('Windows drive paths in every spelling', () => {
  assert.equal(toDiskPath('C:\\Users\\Aswin\\shot.png'), 'C:\\Users\\Aswin\\shot.png')
  assert.equal(toDiskPath('C:/Users/Aswin/shot.png'), 'C:/Users/Aswin/shot.png')
  assert.equal(toDiskPath('file:///C:/Users/Aswin/My%20Pictures/a.png'), 'C:/Users/Aswin/My Pictures/a.png')
  assert.equal(toDiskPath('d:\\renders\\x.jpg'), 'd:\\renders\\x.jpg')
})

test('POSIX roots still count', () => {
  assert.equal(toDiskPath('/Users/you/shot.png'), '/Users/you/shot.png')
  assert.equal(toDiskPath('file:///tmp/x.png'), '/tmp/x.png')
})

test('app assets, URLs and network shares are not disk paths', () => {
  for (const s of ['/vite.svg', '/assets/x.png', 'https://example.com/a.png', 'data:image/png;base64,AA', '', '\\\\server\\share\\a.png', '//server/share/a.png', 'file://server/share/a.png']) {
    assert.equal(toDiskPath(s), null, s)
  }
})
